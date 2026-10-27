#!/usr/bin/env node
// Claude Team UI: a browser console for several Claude Code agent teams, one cartridge per piece of work.
// Node >= 18 with no dependencies. Needs tmux, git and Claude Code (Pro/Max); gh is optional.
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { run, sleep, statSafe, readJSON, realpath } = require('./lib/util');
const { RUNTIME, Config, MODEL_RE } = require('./lib/config');
const T = require('./lib/tmux');
const GH = require('./lib/github');
const { Claude, detectScreen, lastReply } = require('./lib/claude');
const { Registry, PERMISSION_MODES, TEMPLATE_NAMES, APP_DIR, doneMarker, countDone } = require('./lib/cartridges');

const VERSION = require('./package.json').version;
const config = new Config(RUNTIME.configDir);
for (const p of RUNTIME.projectArgs) {
  if (!fs.existsSync(p)) { console.error(`✗ No such folder: ${p}`); process.exit(1); }
  config.addProject(p);
}
const TOKEN = config.token();
const COOKIE_VAL = crypto.createHmac('sha256', TOKEN).update('claude-team-ui').digest('hex');
const claude = new Claude({ bin: RUNTIME.claudeBin, home: RUNTIME.claudeHome });
const registry = new Registry({
  config, prefix: RUNTIME.sessionPrefix, claudeBin: RUNTIME.claudeBin, usageFile: path.join(RUNTIME.configDir, 'usage.json'),
});

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => new HttpError(400, msg);

// ---------- Watching every cartridge: who needs the user, and how much each one has used ----------
const ATTN = new Map(); // cartridge id -> Map(pane id -> screen kind)
const ACT = new Map();  // cartridge id -> { at, data } from transcripts
const SEEN = new Map(); // pane id -> { text, at }: when its screen last changed, so a moving pane counts as busy
const SAID = new Map(); // cartridge id -> the lead's newest line
const TEAMS = new Map(); // cartridge id -> team config, for agent names on the home list
const WHAT = { trust: 'asks to trust the folder', permission: 'asks for permission', question: 'is waiting for you', exit: 'asks how to exit' };

function leadOf(cart, agents) {
  const here = agents.filter(a => a && a.cwd === cart.dir);
  return here.find(a => a.name === cart.sessionName) || (here.length === 1 ? here[0] : null);
}
async function notify(cart, label, kind) { return push(cart, `${label} ${WHAT[kind] || WHAT.question}.`); }
async function push(cart, text) {
  if (!RUNTIME.ntfy) return;
  try {
    await fetch(RUNTIME.ntfy, {
      method: 'POST', body: `${cart.project.name} · ${cart.title}: ${text}`,
      headers: { Title: 'Claude Team - needs you', Tags: 'robot', Priority: 'high' },
    });
  } catch {}
}

// ---------- Running phases: send the prompt, notice when the lead reports done, keep going until a checkpoint ----------
// Autopilot: hands-off (default) approves the plan checkpoints and sends NEEDS WORK reviews back to the build;
// checkpoints stops at every checkpoint; manual runs nothing by itself. The merge always waits for the user.
const PILOTS = ['hands-off', 'checkpoints', 'manual'];
const pilot = S => (PILOTS.includes(S.pilot) ? S.pilot : S.autopilot === false ? 'manual' : 'hands-off');
const autoGate = ph => ph.kind === 'gate' && !ph.pr && !ph.forward;
const MAX_AUTO_FIXES = 2;
const SENDING = new Set(); // cartridges with a step being sent, so two triggers never send it twice

async function runPhase(cart, ph, text) {
  if (SENDING.has(cart.id)) throw new Error('A step is being sent to the lead already');
  SENDING.add(cart.id);
  try { return await sendPhase(cart, ph, text); } finally { SENDING.delete(cart.id); }
}
async function sendPhase(cart, ph, text) {
  const S = cart.state();
  if (cart.kind === 'review') await cart.refreshReview();
  let modeChanged = false;
  if (S.mode !== ph.mode) { await cart.applyMode(ph.mode); modeChanged = true; }
  const lead = await cart.paneFor(null);
  const marker = doneMarker(ph);
  // Earlier rounds of the same phase may have printed the marker already; only new ones count
  if (marker) S.markers = { ...(S.markers || {}), [ph.id]: countDone(await T.capture(lead, 3000), marker) };
  await T.sendText(lead, String(text || await cart.renderPrompt(ph)));
  S.phases[ph.id] = 'running';
  cart.log('run', ph.id);
  cart.save();
  return { modeChanged, mode: ph.mode };
}
// After a step: the next agent step starts by itself unless autopilot is manual; hands-off also passes plan checkpoints
async function continueAfter(cart, ph) {
  const S = cart.state();
  const next = cart.phases[cart.phases.indexOf(ph) + 1];
  if (!next) return push(cart, `${ph.title} done. All steps are finished.`);
  if (next.kind === 'gate') {
    if (pilot(S) !== 'hands-off' || !autoGate(next) || S.phases[next.id] !== 'ready') return push(cart, `${ph.title} done. ${next.title}.`);
    cart.unlockNext(next.id); cart.log('approve', `${next.id} (hands-off)`); cart.save();
    return continueAfter(cart, next);
  }
  if (pilot(S) === 'manual' || S.phases[next.id] !== 'ready' || !(await cart.running()) || !cart.alive()) return;
  await runPhase(cart, next);
}
// Sends the work back to the build after a review or a refused merge; Simplify and Review run again after it
async function sendBack(cart, ph, fb) {
  const S = cart.state();
  const at = cart.phases.findIndex(p => p.id === ph.id);
  const back = cart.phases.find(p => p.id === ph.rejectTo) || cart.phases[at - 1];
  if (back.mode && S.mode !== back.mode) await cart.applyMode(back.mode);
  if (await cart.running()) {
    const lead = await cart.paneFor(null);
    const marker = doneMarker(back);
    // BUILD DONE from the earlier round must not end this one
    if (marker) S.markers = { ...(S.markers || {}), [back.id]: countDone(await T.capture(lead, 3000), marker) };
    await T.sendText(lead, ph.rejectTo
      ? `${ph.kind === 'gate' ? 'I have NOT approved the merge.' : 'Review + QA found problems.'} Go back to the build: fix only the affected tasks `
        + `listed in plans/review.md${fb ? ' and in my notes below' : ''}, one commit per fix, with tests passing. `
        + `Then start your reply with the line BUILD DONE; Simplify and Review + QA run again after that.${fb ? `\n\n${fb}` : ''}`
      : `I have NOT approved "${back.title}" yet. Revise it using the feedback below, update ${ph.file || 'the relevant files'}, then tell me.\n\n${fb}`);
  }
  S.phases[back.id] = 'running';
  for (const p of cart.phases.slice(cart.phases.indexOf(back) + 1)) S.phases[p.id] = 'locked';
  cart.save();
  return back;
}
// The verdict the lead gave right after its REVIEW DONE line
function needsWork(text, marker) {
  const tail = text.slice(text.lastIndexOf(marker), text.lastIndexOf(marker) + 1500);
  return /NEEDS WORK/i.test(tail) && !/READY TO MERGE/i.test(tail);
}
async function autoAdvance(cart, leadPane, lead) {
  const S = cart.state();
  const ph = cart.phases.find(p => p.kind === 'agent' && S.phases[p.id] === 'running');
  const marker = doneMarker(ph);
  if (!marker || !leadPane) return;
  const text = await T.capture(leadPane, 3000);
  const n = countDone(text, marker);
  const base = (S.markers || {})[ph.id];
  if (base == null) { S.markers = { ...(S.markers || {}), [ph.id]: n }; cart.save(); return; }
  if (n <= base || (lead && lead.status === 'busy')) return; // act once the lead has finished its reply
  if (ph.rejectTo && pilot(S) === 'hands-off' && (S.autoFixes || 0) < MAX_AUTO_FIXES && needsWork(text, marker)) {
    S.autoFixes = (S.autoFixes || 0) + 1;
    cart.log('reject', `${ph.id}: review said NEEDS WORK, fix round ${S.autoFixes} (hands-off)`);
    await sendBack(cart, ph, '');
    return;
  }
  cart.unlockNext(ph.id);
  cart.log('done', `${ph.id} (lead reported ${marker})`);
  cart.save();
  await continueAfter(cart, ph);
}
// After Start: the cartridge folder is a worktree of a project the user added, so its trust question is answered;
// once Claude shows its prompt, the first ready step runs (always with run, otherwise unless autopilot is manual)
async function startAndRun(cart, run = true) {
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    let lead;
    try { lead = await cart.paneFor(null); } catch { return; }
    const text = await T.capture(lead, 40);
    if (detectScreen(text) === 'trust') { await cart.trust(); cart.log('trust', 'answered at start'); continue; }
    if (!detectScreen(text) && /^\s*❯(\s|$)/m.test(text)) { // the input prompt; dialogs are ruled out above
      const S = cart.state();
      const ph = cart.phases.find(p => p.kind === 'agent' && S.phases[p.id] === 'ready');
      if (ph && (run || pilot(S) !== 'manual') && !SENDING.has(cart.id)) await runPhase(cart, ph);
      return;
    }
  }
}
// Autopilot also picks up a step left waiting (after a restart, or a step reopened): it runs once the lead is idle
async function autoRun(cart, leadPane, lead) {
  const S = cart.state();
  if (pilot(S) === 'manual' || SENDING.has(cart.id) || cart.phases.some(p => S.phases[p.id] === 'running')) return;
  const ph = cart.phases.find(p => S.phases[p.id] !== 'done');
  if (!ph || S.phases[ph.id] !== 'ready') return;
  if (ph.kind === 'gate') {
    if (pilot(S) !== 'hands-off' || !autoGate(ph)) return;
    cart.unlockNext(ph.id); cart.log('approve', `${ph.id} (hands-off)`); cart.save();
    return continueAfter(cart, ph);
  }
  if ((lead && lead.status !== 'idle') || busy(leadPane)) return;
  const text = await T.capture(leadPane, 40);
  if (detectScreen(text) || !/^\s*❯(\s|$)/m.test(text)) return;
  await runPhase(cart, ph);
}
async function activity(cart, maxAge) {
  const hit = ACT.get(cart.id);
  if (hit && Date.now() - hit.at < maxAge) return hit.data;
  const data = await claude.activity(cart.dir);
  ACT.set(cart.id, { at: Date.now(), data });
  return data;
}
let tick = 0;
// Reads every pane of a cartridge: what it asks the user for, whether its screen moves, the lead's newest line
async function readScreens(cart, mine, agents) {
  const now = new Map();
  for (const p of mine) {
    const text = await T.capture(p.id, 60);
    const k = detectScreen(text);
    if (k) now.set(p.id, k);
    const seen = SEEN.get(p.id);
    if (!seen || seen.text !== text) SEEN.set(p.id, { text, at: seen ? Date.now() : 0 });
    if (p === mine[0]) SAID.set(cart.id, lastReply(text));
  }
  if (mine.length && !now.has(mine[0].id)) {
    const lead = leadOf(cart, agents);
    if (lead && lead.status === 'waiting') now.set(mine[0].id, 'question');
  }
  const before = ATTN.get(cart.id) || new Map();
  for (const [id, kind] of now) {
    if (!before.has(id)) notify(cart, id === mine[0].id ? 'the lead' : `agent ${(mine.find(p => p.id === id) || {}).title || id}`, kind);
  }
  ATTN.set(cart.id, now);
}
// Right after the user answers a prompt, so the "needs you" state clears without waiting for the next watch tick
async function recheck(cart) {
  const panes = (await T.allPanes()).filter(p => p.sess === cart.session);
  await readScreens(cart, panes, await claude.agents(0));
}
async function watch() {
  tick++;
  try {
    const carts = registry.cartridges();
    if (!carts.length) return;
    const panes = await T.allPanes();
    const agents = await claude.agents();
    for (const cart of carts) {
      const mine = panes.filter(p => p.sess === cart.session);
      await readScreens(cart, mine, agents);
      if (!mine.length) { SAID.delete(cart.id); TEAMS.delete(cart.id); }
      else if (tick % 4 === 1) TEAMS.set(cart.id, await claude.team(cart.dir, (leadOf(cart, agents) || {}).sessionId).catch(() => null));
      if (mine.length && cart.alive()) {
        const lead = leadOf(cart, agents);
        await autoAdvance(cart, mine[0].id, lead).catch(() => {});
        await autoRun(cart, mine[0].id, lead).catch(() => {});
      }
      if (tick % 4 === 0) await activity(cart, mine.length ? 12000 : 300000).catch(() => {});
    }
    const live = new Set(panes.map(p => p.id));
    for (const id of SEEN.keys()) if (!live.has(id)) SEEN.delete(id);
  } catch {}
}
setInterval(watch, 4000).unref();

async function planUsage() {
  const j = await readJSON(registry.usageFile);
  if (!j || !j.rate_limits) return null;
  const f = x => (x ? { pct: typeof x.used_percentage === 'number' ? x.used_percentage : null, resetsAt: x.resets_at ? x.resets_at * 1000 : null } : null);
  return { at: j.at || null, fiveHour: f(j.rate_limits.five_hour), sevenDay: f(j.rate_limits.seven_day) };
}

const busy = id => { const s = SEEN.get(id); return !!s && Date.now() - s.at < 10000; };
async function summaries() {
  const panes = await T.allPanes();
  return Promise.all(registry.cartridges().map(async c => {
    const mine = panes.filter(p => p.sess === c.session);
    const crew = await c.panes(panes, TEAMS.get(c.id));
    const s = c.state();
    const cur = c.currentPhase();
    const attn = ATTN.get(c.id) || new Map();
    const act = ACT.get(c.id);
    return {
      id: c.id, project: c.project.id, projectName: c.project.name, kind: c.kind, flow: c.flow, home: c.home, title: c.title,
      issue: c.rec.issue || null, url: c.rec.url || null, branch: c.rec.branch || null, target: c.rec.target || null, prUrl: c.rec.prUrl || null,
      running: mine.length > 0, alive: mine.length > 0 && c.alive(), agents: mine.length, attention: attn.size ? [...attn.values()][0] : null,
      attnPane: attn.size ? [...attn.keys()][0] : null, attnLead: attn.size ? [...attn.keys()][0] === (mine[0] || {}).id : false,
      phase: cur ? cur.title : 'Done', mode: s.mode, startedAt: s.startedAt || null, createdAt: c.rec.createdAt || null,
      costUSD: act && act.data.sessions ? act.data.costUSD : null,
      crew: crew.map(p => ({ name: p.label, busy: busy(p.id), attention: attn.get(p.id) || null })),
      said: SAID.get(c.id) || null,
      steps: { done: c.phases.filter(p => s.phases[p.id] === 'done').length, total: c.phases.length },
    };
  }));
}

// Git repositories under the configured scan roots that are not projects yet
let suggestCache = { t: 0, list: [] };
async function suggestions() {
  if (Date.now() - suggestCache.t < 60000) return suggestCache.list;
  const known = new Set(config.projects.map(p => p.path));
  const found = [];
  const walk = async (dir, depth) => {
    if (depth > 4 || found.length > 200) return;
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (ents.some(e => e.name === '.git')) {
      const p = realpath(dir);
      if (!known.has(p)) found.push(p);
      if (!ents.some(e => e.name === '.gitmodules')) return; // keep going only into repos that hold submodules
    }
    for (const e of ents) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') await walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const root of config.scanRoots) await walk(root, 0);
  suggestCache = { t: Date.now(), list: found.sort() };
  return suggestCache.list;
}

// ---------- HTTP ----------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}
function authed(req) {
  const c = parseCookies(req).ctu || '';
  return c.length === COOKIE_VAL.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(COOKIE_VAL));
}
function tokenOk(t) { const a = Buffer.from(String(t || '')), b = Buffer.from(TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function setAuthCookie(res) { res.setHeader('Set-Cookie', `ctu=${COOKIE_VAL}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}`); }
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1e6) throw bad('Request body too large'); chunks.push(c); }
  const s = Buffer.concat(chunks).toString('utf8');
  if (!s) return {};
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(s));
  try { return JSON.parse(s); } catch { throw bad('Invalid JSON'); }
}
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
// Served without login: the sign-in page and "add to home screen" need them
const PUBLIC = {
  '/style.css': ['style.css', 'text/css; charset=utf-8'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const KEYS = {
  enter: 'Enter', esc: 'Escape', up: 'Up', down: 'Down', left: 'Left', right: 'Right', tab: 'Tab', 'shift-tab': 'BTab',
  'ctrl-c': 'C-c', 'ctrl-t': 'C-t', 'ctrl-o': 'C-o', '1': '1', '2': '2', '3': '3', '4': '4', x: 'x', y: 'y', n: 'n',
};
let failedLogins = 0;

// Routes that do not need a cartridge
const GLOBAL = {
  async 'GET overview'() {
    const cartridges = await summaries();
    return {
      version: VERSION, projects: registry.projects().map(p => p.summary()), cartridges,
      runningCount: cartridges.filter(c => c.running).length, softLimit: RUNTIME.softLimit, models: config.models,
      permissionModes: PERMISSION_MODES, usage: await planUsage(), platform: process.platform, ntfy: !!RUNTIME.ntfy,
      scanRoots: config.scanRoots, home: os.homedir(),
    };
  },
  async 'GET suggest'() { return { paths: await suggestions() }; },
  async 'POST project-add'({ body }) {
    const p = String(body.path || '').trim().replace(/^~(?=\/|$)/, os.homedir());
    if (!p || !path.isAbsolute(p)) throw bad('Give the full path of a folder');
    const st = await statSafe(p);
    if (!st || !st.isDirectory()) throw bad(`No such folder: ${p}`);
    suggestCache.t = 0;
    return { ok: true, project: config.addProject(p) };
  },
  async 'POST project-remove'({ body }) {
    const p = registry.project(body.project);
    const running = [];
    for (const c of registry.cartridges()) if (c.project.id === p.id && await c.running()) running.push(c.title);
    if (running.length) throw bad(`Power off its cartridges first: ${running.join(', ')}`);
    config.removeProject(p.id);
    suggestCache.t = 0;
    return { ok: true };
  },
  async 'POST project-update'({ body }) { return { ok: true, project: config.updateProject(body.project, { testCommand: body.testCommand, node: body.node }) }; },
  async 'POST settings'({ body }) {
    if (body.models) config.setModels(body.models);
    if (Array.isArray(body.scanRoots)) {
      config.data.scanRoots = body.scanRoots.map(s => String(s).trim().replace(/^~(?=\/|$)/, os.homedir())).filter(s => path.isAbsolute(s)).slice(0, 10);
      config.save();
      suggestCache.t = 0;
    }
    return { ok: true, models: config.models, scanRoots: config.scanRoots };
  },
  // project=<id> or all; mine=1 keeps issues assigned to the gh user; q is GitHub search text
  async 'GET issues'({ q }) {
    const pid = q('project');
    const projects = pid && pid !== 'all' ? [registry.project(pid)] : registry.projects();
    const opts = { mine: q('mine') === '1', query: String(q('q') || '').trim().slice(0, 200) };
    const used = new Map(registry.cartridges().filter(c => c.rec.issue && !c.home).map(c => [`${c.project.id}#${c.rec.issue}`, c.id]));
    const lists = await Promise.all(projects.map(async p => ({ p, r: await GH.listIssues(p.path, opts) })));
    const issues = [], errors = [];
    for (const { p, r } of lists) {
      if (!r.ok) { errors.push(`${p.name}: ${r.error}`); continue; }
      for (const i of r.issues) issues.push({ ...i, project: p.id, projectName: p.name, cart: used.get(`${p.id}#${i.number}`) || null });
    }
    issues.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { ok: !lists.length || errors.length < lists.length, error: errors.join('; '), issues };
  },
  async 'GET branches'({ q }) {
    const p = registry.project(q('project'));
    return { base: await p.defaultBase(), branches: await p.branches() };
  },
  async 'POST cart-add'({ body }) {
    const made = [];
    if (Array.isArray(body.issues) && body.issues.length) {
      // Each pick is "<project>#<number>", or a bare number in body.project
      const picks = body.issues.map(x => {
        const [pid, n] = String(x).includes('#') ? String(x).split('#') : [body.project, x];
        return { p: registry.project(pid), n: Number(n) };
      }).filter(x => Number.isInteger(x.n) && x.n > 0);
      const oneProject = new Set(picks.map(x => x.p.id)).size === 1, fetched = new Set();
      for (const { p, n } of picks) {
        const info = await GH.issueInfo(p.path, n);
        made.push(await registry.addWork(p, {
          issue: n, ...info, branch: picks.length === 1 ? body.branch : '', base: oneProject ? body.base : '',
          fetch: !!body.fetch && !fetched.has(p.id), flow: body.flow,
        }));
        fetched.add(p.id);
      }
    } else {
      const p = registry.project(body.project);
      const title = String(body.title || '').trim().slice(0, 120);
      if (!title) throw bad('Write a name for the task');
      const text = String(body.body || '').slice(0, 20000);
      let issue = null, url = null;
      if (body.createIssue) ({ number: issue, url } = await GH.createIssue(p.path, title, text));
      made.push(await registry.addWork(p, { issue, title, url, body: text, branch: body.branch, base: body.base, fetch: !!body.fetch, flow: body.flow }));
    }
    if (body.start) for (const c of made) c.start({}).then(() => startAndRun(c)).catch(() => {});
    return { ok: true, made: made.map(c => ({ id: c.id, title: c.title })) };
  },
  async 'POST cart-add-home'({ body }) { const c = await registry.addHome(registry.project(body.project), { flow: body.flow }); return { ok: true, made: [{ id: c.id, title: c.title }] }; },
  async 'POST cart-add-review'({ body }) {
    const p = registry.project(body.project);
    const pr = body.pr ? Number(body.pr) : null;
    if (pr != null && !(Number.isInteger(pr) && pr > 0)) throw bad('Not a valid PR number');
    if (!pr && !body.target) throw bad('Pick a cartridge or type a PR number');
    const c = await registry.addReview(p, { target: body.target, pr });
    return { ok: true, made: [{ id: c.id, title: c.title }] };
  },
  async 'POST cart-add-research'({ body }) {
    const c = await registry.addResearch(registry.project(body.project), { question: body.question, title: body.title });
    return { ok: true, made: [{ id: c.id, title: c.title }] };
  },
  async 'POST draft-issue'({ body }) {
    const text = String(body.text || '').trim().slice(0, 8000);
    if (!text) throw bad('Describe the task first');
    return claude.draftIssue(text, config.models.fast);
  },
  async 'POST forward'({ body }) { return { ok: true, ...(await registry.forward(registry.get(body.cart), registry.get(body.to))) }; },
  async 'POST cart-remove'({ body }) {
    const c = registry.get(body.cart);
    const out = await registry.remove(c);
    ATTN.delete(c.id); ACT.delete(c.id);
    return { ok: true, ...out };
  },
};

// Routes for one cartridge (`cart` in the query or the body)
const PER_CART = {
  async 'GET state'({ cart }) {
    const [all, agents] = await Promise.all([T.allPanes(), claude.agents()]);
    const lead = leadOf(cart, agents);
    const team = await claude.team(cart.dir, lead && lead.sessionId);
    const panes = await cart.panes(all, team);
    const attn = ATTN.get(cart.id) || new Map();
    for (const p of panes) p.attention = attn.get(p.id) || null;
    const s = cart.state();
    return {
      cart: {
        id: cart.id, kind: cart.kind, flow: cart.flow, home: cart.home, title: cart.title, project: cart.project.id, projectName: cart.project.name,
        issue: cart.rec.issue || null, url: cart.rec.url || null, branch: cart.rec.branch || null, base: cart.rec.base || null,
        target: cart.rec.target || null, pr: cart.rec.pr || null, prUrl: cart.rec.prUrl || null, dir: cart.dir,
        hasHistory: !!(await claude.projectFolder(cart.dir)),
      },
      running: panes.length > 0, claudeAlive: panes.length > 0 && cart.alive(), panes, lead: lead ? { status: lead.status } : null,
      mode: s.mode, request: s.request, start: s.start, startedAt: s.startedAt || null, autopilot: pilot(s) !== 'manual', pilot: pilot(s),
      phases: cart.phases.map(p => ({ ...p, status: s.phases[p.id] })),
    };
  },
  async 'GET pane'({ cart, q }) {
    let id;
    try { id = await cart.paneFor(q('id')); } catch { return { id: null, text: '' }; }
    const lines = Math.min(3000, Number(q('lines')) || 400);
    if (q('ansi') !== '1') { const text = await T.capture(id, lines); return { id, text, attention: detectScreen(text) }; }
    const ansi = await T.capture(id, lines, { ansi: true });
    const text = T.stripAnsi(ansi);
    return { id, text, ansi, attention: detectScreen(text) };
  },
  async 'POST start'({ cart, body }) {
    await cart.start({ ...(body.opts || {}), resume: !!body.resume });
    startAndRun(cart, !!body.run).catch(() => {});
    return { ok: true };
  },
  async 'POST autopilot'({ cart, body }) {
    const mode = body.mode != null ? String(body.mode) : body.on === false ? 'manual' : 'hands-off';
    if (!PILOTS.includes(mode)) throw bad('Unknown autopilot mode');
    const S = cart.state();
    S.pilot = mode; delete S.autopilot;
    cart.log('autopilot', mode); cart.save();
    return { ok: true, pilot: mode, autopilot: mode !== 'manual' };
  },
  async 'POST stop'({ cart, body }) { await cart.stop(!!body.hard); ATTN.delete(cart.id); return { ok: true }; },
  async 'POST restart'({ cart, body }) { await cart.restart({ resume: !!body.resume }); startAndRun(cart, false).catch(() => {}); return { ok: true }; },
  async 'POST send'({ cart, body }) {
    const text = String(body.text || '').slice(0, 50000);
    if (!text.trim()) throw bad('Nothing to send');
    await T.sendText(await cart.paneFor(body.pane), text, body.submit !== false);
    cart.log('send', `${body.pane || 'lead'}: ${text}`);
    cart.save();
    return { ok: true };
  },
  async 'POST key'({ cart, body }) {
    const k = KEYS[String(body.key)];
    if (!k) throw bad('Unsupported key: ' + body.key);
    await T.sendKeys(await cart.paneFor(body.pane), k);
    await sleep(350);
    await recheck(cart).catch(() => {});
    setTimeout(() => recheck(cart).catch(() => {}), 1500); // slower redraws
    return { ok: true, attention: [...(ATTN.get(cart.id) || new Map()).values()][0] || null };
  },
  async 'POST trust'({ cart }) { await cart.trust(); return { ok: true }; },
  async 'POST flow'({ cart, body }) { cart.setFlow(String(body.flow || '')); return { ok: true, flow: cart.flow }; },
  async 'POST request'({ cart, body }) { cart.state().request = String(body.request || '').slice(0, 20000); cart.save(); return { ok: true }; },
  async 'POST mode'({ cart, body }) {
    if (!['planning', 'code'].includes(body.mode)) throw bad('Unknown mode');
    await cart.applyMode(body.mode);
    cart.log('mode', body.mode);
    cart.save();
    return { ok: true, mode: body.mode };
  },
  async 'GET prompt'({ cart, q }) {
    const ph = cart.phases.find(p => p.id === q('phase') && p.kind === 'agent');
    if (!ph) throw new HttpError(404, 'No such phase');
    return { text: await cart.renderPrompt(ph), mode: ph.mode, template: ph.prompt };
  },
  async 'GET template'({ cart, q }) {
    const name = templateName(cart, q('name'));
    return { name, ...(await cart.template(name)) };
  },
  async 'POST template'({ cart, body }) {
    const name = templateName(cart, body.name);
    await cart.saveTemplate(name, body.text == null ? null : String(body.text));
    return { ok: true, ...(await cart.template(name)) };
  },
  async 'POST phase'({ cart, body }) {
    const S = cart.state();
    const ph = cart.phases.find(p => p.id === body.phase);
    if (!ph) throw new HttpError(404, 'No such phase');
    const action = body.action;
    if (action === 'run' && ph.kind === 'agent') {
      if (S.phases[ph.id] === 'locked') throw new HttpError(409, 'This step is not open yet');
      if (!(await cart.running())) throw new HttpError(409, 'This cartridge is off. Tap Start.');
      return { ok: true, ...(await runPhase(cart, ph, body.text)) };
    }
    if (action === 'done' || (action === 'approve' && ph.kind === 'gate')) {
      cart.unlockNext(ph.id); cart.log(action, ph.id); cart.save();
      if (action === 'approve') await continueAfter(cart, ph).catch(() => {});
      return { ok: true };
    }
    if (action === 'reject' && (ph.kind === 'gate' || ph.rejectTo)) {
      const fb = String(body.feedback || '').trim();
      if (!fb && !ph.rejectTo) throw bad('Write what needs to change');
      const back = await sendBack(cart, ph, fb);
      cart.log('reject', `${ph.id}: ${fb}`); cart.save();
      return { ok: true, back: back.id };
    }
    if (action === 'reopen') {
      const i = cart.phases.findIndex(p => p.id === ph.id);
      S.phases[ph.id] = 'ready';
      for (const p of cart.phases.slice(i + 1)) S.phases[p.id] = 'locked';
      cart.log('reopen', ph.id); cart.save();
      return { ok: true };
    }
    throw bad('Unknown action');
  },
  async 'POST reset'({ cart }) {
    const S = cart.state();
    S.phases = Object.fromEntries(cart.phases.map((p, i) => [p.id, i === 0 ? 'ready' : 'locked']));
    cart.log('reset'); cart.save();
    return { ok: true };
  },
  async 'GET team'({ cart }) {
    const lead = leadOf(cart, await claude.agents());
    const team = await claude.team(cart.dir, lead && lead.sessionId);
    const act = await activity(cart, 0); // fresh: transcript scans are incremental, and a cached read may predate new lines
    return {
      team, tasks: team ? await claude.tasks(team.name) : [], messages: act.messages,
      usage: { costUSD: act.costUSD, sessions: act.sessions, tokens: act.tokens, models: act.models, lastActivity: act.lastActivity },
    };
  },
  async 'GET plans'({ cart }) { return cart.plans(); },
  async 'GET file'({ cart, q }) {
    const abs = cart.fileFor(q('path'));
    if (!abs) throw new HttpError(403, 'Only plans/ and CLAUDE.md can be read here');
    const st = await statSafe(abs);
    if (!st || !st.isFile()) throw new HttpError(404, 'File does not exist yet');
    if (st.size > 2e6) throw new HttpError(413, 'File too large');
    return { path: path.relative(cart.dir, abs), text: await fsp.readFile(abs, 'utf8'), mtime: st.mtimeMs };
  },
  async 'GET git'({ cart }) { return cart.gitInfo(); },
  async 'GET pr-draft'({ cart }) { return cart.prDraft(); },
  async 'POST pr-open'({ cart, body }) { return { ok: true, ...(await cart.openPr(body)) }; },
};
function templateName(cart, name) {
  const n = String(name || '');
  if (TEMPLATE_NAMES.includes(n) || cart.phases.some(p => p.prompt === n)) return n;
  throw bad('Unknown template');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/login' && req.method === 'POST') {
      const b = await readBody(req);
      if (tokenOk(b.token)) { failedLogins = 0; setAuthCookie(res); res.writeHead(303, { Location: '/' }); return res.end(); }
      failedLogins++;
      await sleep(Math.min(5000, 500 * failedLogins));
      res.writeHead(303, { Location: '/?err=1' });
      return res.end();
    }
    if (url.searchParams.has('token') && tokenOk(url.searchParams.get('token'))) { setAuthCookie(res); res.writeHead(303, { Location: '/' }); return res.end(); }
    if (req.method === 'GET' && PUBLIC[url.pathname]) {
      const [f, type] = PUBLIC[url.pathname];
      return send(res, 200, await fsp.readFile(path.join(APP_DIR, 'public', f)), type);
    }
    const font = req.method === 'GET' && url.pathname.match(/^\/fonts\/([\w-]+\.woff2)$/);
    if (font) {
      try {
        const buf = await fsp.readFile(path.join(APP_DIR, 'public', 'fonts', font[1]));
        res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=2592000' });
        return res.end(buf);
      } catch { return send(res, 404, { error: 'No such font' }); }
    }
    if (!authed(req)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'Not logged in' });
      return send(res, 200, await fsp.readFile(path.join(APP_DIR, 'public', 'login.html')), 'text/html; charset=utf-8');
    }
    if (STATIC[url.pathname] && req.method === 'GET') {
      const [f, type] = STATIC[url.pathname];
      return send(res, 200, await fsp.readFile(path.join(APP_DIR, 'public', f)), type);
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (req.method === 'POST' && req.headers['x-ctu'] !== '1') return send(res, 403, { error: 'Missing header' });

    const route = `${req.method} ${url.pathname.slice(5)}`;
    const body = req.method === 'POST' ? await readBody(req) : {};
    const q = k => url.searchParams.get(k);
    if (GLOBAL[route]) return send(res, 200, await GLOBAL[route]({ body, q }));
    if (PER_CART[route]) return send(res, 200, await PER_CART[route]({ body, q, cart: registry.get(q('cart') || body.cart) }));
    return send(res, 404, { error: 'No such API' });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || String(e) });
  }
});

async function checkDeps() {
  const t = await run('tmux', ['-V']);
  if (!t.ok) { console.error('✗ tmux is missing. Install it: brew install tmux'); process.exit(1); }
  const c = await run(RUNTIME.claudeBin, ['--version']);
  if (!c.ok) console.warn('! Could not run "claude". Install it: curl -fsSL https://claude.ai/install.sh | bash');
  else console.log('✓', c.stdout.trim(), '·', t.stdout.trim());
  const g = await run('gh', ['--version']);
  console.log(g.ok ? '✓ GitHub CLI found (issues and PRs)' : '· No GitHub CLI: cartridges still work, but without issues or PRs. Install: brew install gh');
  if (process.env.ANTHROPIC_API_KEY) console.warn('! ANTHROPIC_API_KEY is set. Sessions started by the tool drop it and use your subscription.');
}

if (require.main === module) {
  checkDeps().then(() => server.listen(RUNTIME.port, RUNTIME.host, () => {
    const names = config.projects.map(p => path.basename(p.path)).join(', ') || 'none yet, add one in the console';
    console.log(`\nClaude Team UI ${VERSION} · projects: ${names}`);
    const urls = [`http://localhost:${RUNTIME.port}`];
    if (RUNTIME.host === '0.0.0.0') {
      for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs || []) {
        if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${RUNTIME.port}`);
      }
    }
    for (const u of urls) console.log(`  → ${u}/?token=${TOKEN}`);
    console.log(`\nToken: ${TOKEN}  (saved in ${path.join(RUNTIME.configDir, 'token')})`);
    if (RUNTIME.host === '0.0.0.0') console.log('Listening on the local network. Use it only on a trusted network or over Tailscale.');
  }));
}
module.exports = { server, registry, config };

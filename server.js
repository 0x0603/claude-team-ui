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
const { Tailscale, tailnetAddr } = require('./lib/tailscale');
const { Claude, detectScreen, lastReply, liveView, splitScreen } = require('./lib/claude');
const { Registry, PERMISSION_MODES, TEMPLATE_NAMES, APP_DIR, doneMarker, countDone, sentKey } = require('./lib/cartridges');
const { Assistant, MAX_TEXT: ASSISTANT_MAX_TEXT } = require('./lib/assistant');

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
const assistant = new Assistant({ bin: RUNTIME.claudeBin, dir: path.join(RUNTIME.configDir, 'assistant'), usageFile: registry.usageFile });

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => new HttpError(400, msg);
// Issue and PR filters: a GitHub login or @me, and each enumerated value; anything else is refused before it reaches gh
const LOGIN_RE = /^(@me|[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})$/i;
const filt = (q, name, re) => {
  const v = String(q(name) || '').trim();
  if (v && !re.test(v)) throw bad(`Not a valid ${name} filter`);
  return v;
};

// ---------- Watching every cartridge: who needs the user, and how much each one has used ----------
const ATTN = new Map(); // cartridge id -> Map(pane id -> screen kind)
const ACT = new Map();  // cartridge id -> { at, data } from transcripts
const SEEN = new Map(); // pane id -> { text, at }: when its screen last changed, so a moving pane counts as busy
const SAID = new Map(); // cartridge id -> the lead's newest line
const LIVE = new Map(); // cartridge id -> { status, events } off the lead's screen
const TEAMS = new Map(); // cartridge id -> team config, for agent names on the home list
const WHAT = { trust: 'asks to trust the folder', permission: 'asks for permission', question: 'is waiting for you', exit: 'asks how to exit' };

function leadOf(cart, agents) {
  const here = agents.filter(a => a && a.cwd === cart.dir);
  return here.find(a => a.name === cart.sessionName) || (here.length === 1 ? here[0] : null);
}
// A question or prompt carries what the screen asks, so the phone notification is enough to decide
async function notify(cart, label, kind, detail) { return push(cart, `${label} ${WHAT[kind] || WHAT.question}.${detail ? ' ' + String(detail).slice(0, 300) : ''}`); }
async function push(cart, text) {
  if (!RUNTIME.ntfy) return;
  try {
    await fetch(RUNTIME.ntfy, {
      method: 'POST', body: `${cart.project.name} · ${cart.title}: ${text}`,
      headers: { Title: 'Claude Team - needs you', Tags: 'robot', Priority: 'high' },
    });
  } catch {}
}
// Everything the console itself says to the lead goes through here, so the chat can tell it from the user's own words
async function tell(cart, kind, title, text, pane) {
  cart.noteSent(kind, title, text);
  await T.sendText(pane || await cart.paneFor(null), text);
}
// One line from the last finished step's digest, for pushes and the home list
async function digestLine(cart) {
  const d = await cart.digest().catch(() => null);
  if (!d || !d.verdict) return '';
  const c = d.counts || {};
  const n = [c.critical && `${c.critical} critical`, c.major && `${c.major} major`, c.minor && `${c.minor} minor`].filter(Boolean).join(', ');
  return ` ${d.verdict}${n ? ' · ' + n : ''}.${d.next ? ' Next: ' + d.next : ''}`;
}

// ---------- Running phases: send the prompt, notice when the lead reports done, keep going until a checkpoint ----------
// Autopilot levels. full-auto runs to a draft PR: it settles its own questions, allows its own permission prompts
// (the guard hook still blocks pushes, publishing, GitHub writes, rm -rf and secrets) and retries after errors.
// hands-off approves plan checkpoints without questions and sends NEEDS WORK reviews back to the build, then stops
// before the merge. checkpoints stops at every checkpoint; manual runs nothing by itself. Nothing ever merges.
const PILOTS = ['full-auto', 'hands-off', 'checkpoints', 'manual'];
const pilot = S => (PILOTS.includes(S.pilot) ? S.pilot : S.autopilot === false ? 'manual' : PILOTS.includes(config.data.pilot) ? config.data.pilot : 'hands-off');
const passesGates = S => ['full-auto', 'hands-off'].includes(pilot(S));
const autoGate = ph => ph.kind === 'gate' && !ph.pr && !ph.forward;
const MAX_AUTO_FIXES = 2;
// The open questions a plan or spec asks the user: numbered items under a heading, or a bold label, that mentions questions
function openQuestions(md) {
  const out = [];
  let level = 0, sub = null;
  for (const line of String(md || '').split('\n')) {
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      if (/question/i.test(h[2])) { level = h[1].length; sub = null; } else if (level && h[1].length <= level) level = 0;
      continue;
    }
    if (!level) continue;
    const b = line.match(/^\s*\*\*([^*]+)\*\*:?\s*$/);
    if (b) { sub = /question/i.test(b[1]); continue; }
    if (sub === false) continue;
    const m = line.match(/^\s{0,3}\d+[.)]\s+(.*)/);
    if (m) out.push(m[1].trim());
    else if (out.length && /^\s{2,}\S/.test(line)) out[out.length - 1] += ' ' + line.trim();
  }
  return out.filter(q => !/^\W*(none|no open questions)\b/i.test(q));
}
async function questionsFor(cart, ph) {
  if (!ph || ph.kind !== 'gate' || !ph.file) return [];
  try { return openQuestions(await fsp.readFile(path.join(cart.dir, ph.file), 'utf8')); } catch { return []; }
}
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
  await tell(cart, 'step', ph.title, String(text || await cart.renderPrompt(ph)), lead);
  S.phases[ph.id] = 'running';
  S.stepAt = Date.now();
  if (S.autoDecided) delete S.autoDecided[ph.id]; // a step run again may ask again
  cart.log('run', ph.id);
  cart.save();
  return { modeChanged, mode: ph.mode };
}
// After a step: the next agent step starts by itself unless autopilot is manual; hands-off also passes plan checkpoints
async function continueAfter(cart, ph) {
  const S = cart.state();
  const next = cart.phases[cart.phases.indexOf(ph) + 1];
  if (!next) return push(cart, `${ph.title} done.${await digestLine(cart)} All steps are finished.`);
  if (next.kind === 'gate') {
    if (S.phases[next.id] === 'ready' && pilot(S) === 'full-auto') return fullAutoGate(cart, next);
    // Hands-off still stops when the plan asks the user something
    const qs = await questionsFor(cart, next);
    if (qs.length) return push(cart, `${ph.title} done.${await digestLine(cart)} ${qs.length === 1 ? '1 question' : `${qs.length} questions`} for you.`);
    if (!passesGates(S) || !autoGate(next) || S.phases[next.id] !== 'ready') return push(cart, `${ph.title} done.${await digestLine(cart)} ${next.title}.`);
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
    await tell(cart, 'console', ph.rejectTo ? 'Sent back to Build' : 'Asked for changes', ph.rejectTo
      ? `${ph.kind === 'gate' ? 'I have NOT approved the merge.' : 'Review + QA found problems.'} Go back to the build: fix only the affected tasks `
        + `listed in plans/review.md${fb ? ' and in my notes below' : ''}, then fold the fixes into the existing commit with `
        + `git commit --amend --no-edit (a new commit only if a pull request already exists). Run the tests for what you change. `
        + `Then start your reply with the line BUILD DONE; Simplify and Review + QA run again after that.${fb ? `\n\n${fb}` : ''}`
      : `I have NOT approved "${back.title}" yet. Revise it using the feedback below and update ${ph.file || 'the relevant files'}. `
        + `When it is done, start your reply with the line "${doneMarker(back) || 'DONE'}".\n\n${fb}`, lead);
  }
  S.phases[back.id] = 'running';
  S.stepAt = Date.now();
  if (S.autoDecided) delete S.autoDecided[back.id];
  for (const p of cart.phases.slice(cart.phases.indexOf(back) + 1)) S.phases[p.id] = 'locked';
  cart.save();
  return back;
}
// The verdict the lead gave right after its REVIEW DONE line
function needsWork(text, marker) {
  const tail = text.slice(text.lastIndexOf(marker), text.lastIndexOf(marker) + 1500);
  return /NEEDS WORK/i.test(tail) && !/READY TO MERGE/i.test(tail);
}
// The lead's replies since the step started, from its transcript (screen scrollback can be cleared when the pane resizes)
async function repliesSince(cart, lead, since) {
  const data = await activity(cart, 3000).catch(() => null);
  const files = ((data && data.agents) || []).filter(a => (lead && lead.sessionId ? a.session === lead.sessionId : true));
  return files.flatMap(a => a.replies || []).filter(r => r.t > since).sort((a, b) => a.t - b.t);
}
// The marker opens the reply or one of its first lines ("Done. \nBUILD DONE" counts; "will say BUILD DONE" does not)
const opensWith = (head, marker) => String(head).split('\n').some(l => l.replace(/^[\s*"'`#>-]+/, '').startsWith(marker));
async function autoAdvance(cart, leadPane, lead) {
  const S = cart.state();
  const ph = cart.phases.find(p => p.kind === 'agent' && S.phases[p.id] === 'running');
  const marker = doneMarker(ph);
  if (!marker || !leadPane) return;
  const text = await T.capture(leadPane, 3000);
  const n = countDone(text, marker);
  const base = (S.markers || {})[ph.id];
  if (base == null) { S.markers = { ...(S.markers || {}), [ph.id]: n }; cart.save(); return; }
  // A transcript reply is complete once written, so it counts at once. Claude Code reports the lead "busy" for as long as
  // a background agent lives, so that status is only used for the screen fallback, where a reply may still be streaming.
  const reply = S.stepAt ? (await repliesSince(cart, lead, S.stepAt)).reverse().find(r => opensWith(r.head, marker)) : null;
  if (!reply && (n <= base || (LIVE.get(cart.id) || {}).status)) return; // on screen, wait while the spinner shows
  if (ph.rejectTo) S.reviewedSha = await cart.headSha(); // the next review round diffs from here ({{SINCE}})
  if (ph.rejectTo && passesGates(S) && (S.autoFixes || 0) < MAX_AUTO_FIXES && (reply ? /NEEDS WORK/i.test(reply.head) && !/READY TO MERGE/i.test(reply.head) : needsWork(text, marker))) {
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
async function waitReady(cart, secs = 90) {
  for (let i = 0; i < secs; i++) {
    await sleep(1000);
    let lead;
    try { lead = await cart.paneFor(null); } catch { return false; }
    const text = await T.capture(lead, 40);
    if (detectScreen(text) === 'trust') { await cart.trust(); cart.log('trust', 'answered at start'); continue; }
    if (!detectScreen(text) && /^\s*❯(\s|$)/m.test(text)) return true; // the input prompt; dialogs are ruled out above
  }
  return false;
}
async function startAndRun(cart, run = true) {
  if (!(await waitReady(cart))) return;
  await cart.setupPending(); // a fresh worktree may still be installing; the first step waits for it
  const S = cart.state();
  if (S.setup && S.setup.status === 'failed') { push(cart, `Setup failed: ${S.setup.line}. Fix it, then run the first step.`); return; }
  const ph = cart.phases.find(p => p.kind === 'agent' && S.phases[p.id] === 'ready');
  if (ph && (run || pilot(S) !== 'manual') && !SENDING.has(cart.id)) await runPhase(cart, ph);
}
// After the PR is open: reviewers' comments go to the team as a new build round; simplify, review and the merge
// checkpoint follow as usual, and the fixes go up as new commits
async function addressPr(cart, fb) {
  const S = cart.state();
  const gate = cart.phases.find(p => p.pr);
  const build = gate && cart.phases.find(p => p.id === gate.rejectTo);
  if (!build) throw bad('This flow has no build step to take PR comments');
  const lines = [`# Review comments on PR #${fb.number}`, '', `Review decision: ${fb.decision ? fb.decision.toLowerCase().replace(/_/g, ' ') : 'none yet'}`, ''];
  let n = 0;
  if (fb.threads.length) {
    lines.push('## Open review threads', '');
    for (const t of fb.threads) lines.push(`${++n}. ${t.path}${t.line ? `:${t.line}` : ''}${t.outdated ? ' (outdated)' : ''}, @${t.author}: ${t.body.trim()}`,
      ...(t.replies.length ? [`   Replies: ${t.replies.join(' | ')}`] : []), `   ${t.url}`, '');
  }
  if (fb.reviews.length) { lines.push('## Reviews', ''); for (const v of fb.reviews) lines.push(`${++n}. @${v.author} (${v.state.toLowerCase().replace(/_/g, ' ')}): ${v.body.trim()}`, ''); }
  if (fb.comments.length) { lines.push('## Conversation', ''); for (const c of fb.comments) lines.push(`${++n}. @${c.author}: ${c.body.trim()}`, ''); }
  await fsp.mkdir(path.join(cart.dir, 'plans'), { recursive: true });
  await fsp.writeFile(path.join(cart.dir, 'plans', 'pr-comments.md'), lines.join('\n'));
  if (!(await cart.running())) { // pick the conversation up again when there is one
    await cart.start({ resume: !!(await claude.projectFolder(cart.dir)) });
    if (!(await waitReady(cart))) throw bad('Claude did not get ready; open the Terminal tab to see why');
  }
  if (build.mode && S.mode !== build.mode) await cart.applyMode(build.mode);
  const lead = await cart.paneFor(null);
  const marker = doneMarker(build);
  S.markers = { ...(S.markers || {}), [build.id]: countDone(await T.capture(lead, 3000), marker) };
  await tell(cart, 'console', 'PR comments to address', `Reviewers left ${n} comment${n === 1 ? '' : 's'} on the pull request (PR #${fb.number}), numbered in plans/pr-comments.md. `
    + 'Address each one: fix it in the code, or, when you disagree or it is out of scope, say why. Write plans/pr-replies.md with one short '
    + 'reply per comment number: what changed and in which commit, or why not. The branch is already pushed, so add a new commit (do not amend). '
    + `Run the tests for what you change. Then start your reply with the line "${marker}".`, lead);
  S.phases[build.id] = 'running';
  S.stepAt = Date.now();
  for (const p of cart.phases.slice(cart.phases.indexOf(build) + 1)) S.phases[p.id] = 'locked';
  S.autoFixes = 0;
  S.pr = { ...(S.pr || {}), new: 0, seen: prIds(fb), checkedAt: Date.now(), decision: fb.decision || '' }; // all of these are now in the team's hands
  cart.log('pr-comments', `${build.id}: ${n} comments from PR #${fb.number}`);
  cart.save();
  return n;
}
// PR comments are read when the user asks (Check PR comments), never on a timer. "New" means not yet sent to the team.
const prIds = fb => [...fb.threads.map(t => `t:${t.url || `${t.path}:${t.line}:${t.body.slice(0, 80)}`}`),
  ...fb.reviews.map(v => `r:${v.author}:${v.state}:${v.body.slice(0, 80)}`), ...fb.comments.map(c => `c:${c.author}:${c.body.slice(0, 80)}`)];
async function checkPr(cart) {
  if (!cart.rec.prUrl) throw bad('This cartridge has no pull request yet');
  const S = cart.state();
  const fb = await GH.prFeedback(cart.dir, cart.rec.prUrl);
  const seen = new Set((S.pr || {}).seen || []);
  const fresh = prIds(fb).filter(i => !seen.has(i)).length;
  S.pr = { ...(S.pr || {}), new: fresh, total: prIds(fb).length, checkedAt: Date.now(), decision: fb.decision || '' };
  cart.log('pr-check', `${fresh} new of ${prIds(fb).length}`); cart.save();
  return { fb, fresh };
}
// Full auto, at the merge with an open PR and after each push: new comments go to the team as a build round
async function autoAddressPr(cart) {
  if (pilot(cart.state()) !== 'full-auto' || !cart.rec.prUrl) return false;
  let r;
  try { r = await checkPr(cart); } catch (e) { cart.log('pr-check', `failed: ${e.message}`); return false; }
  if (!r.fresh) return false;
  await addressPr(cart, r.fb);
  push(cart, `${r.fresh} new PR comment${r.fresh === 1 ? '' : 's'} sent to the team.`);
  return true;
}
// Away mode: a lead that waits on the user in the middle of a step, for longer than the timeout, is told to decide by
// itself, once per step. Checkpoints are not touched; hands-off still stops at the merge.
const AWAY_TEXT = 'I am away. Decide this yourself: pick the safest reasonable option, write it under \'Decided for you\' in plans/summary.md, '
  + 'and carry on. Anything that needs money, secrets, accounts or a public API change: take the option that avoids it and list it under Questions.';
const questionTimeoutMs = S => (Number(S.questionTimeoutMin != null ? S.questionTimeoutMin : config.data.questionTimeoutMin) || 0) * 60000;
async function autoDecide(cart, mine, lead) {
  const S = cart.state();
  const ph = cart.phases.find(p => p.kind === 'agent' && S.phases[p.id] === 'running');
  const ms = questionTimeoutMs(S);
  const attn = ATTN.get(cart.id) || new Map();
  const waiting = ph && ms && passesGates(S) && mine.length && (attn.get(mine[0].id) === 'question' || (lead && lead.status === 'waiting'));
  if (!waiting) { delete S.waitSince; return; }
  if (!S.waitSince || S.waitStep !== ph.id) { S.waitSince = Date.now(); S.waitStep = ph.id; return; }
  if (Date.now() - S.waitSince < ms || (S.autoDecided || {})[ph.id]) return;
  S.autoDecided = { ...(S.autoDecided || {}), [ph.id]: Date.now() };
  cart.log('auto-decide', ph.id); cart.save();
  await tell(cart, 'console', 'Asked the lead to decide', AWAY_TEXT, mine[0].id);
}
// Autopilot also picks up a step left waiting (after a restart, or a step reopened): it runs once the lead is idle
async function autoRun(cart, leadPane, lead) {
  const S = cart.state();
  if (pilot(S) === 'manual' || SENDING.has(cart.id) || cart.phases.some(p => S.phases[p.id] === 'running')) return;
  if (S.setup && S.setup.status === 'running') return; // install or build still running in the worktree
  const ph = cart.phases.find(p => S.phases[p.id] !== 'done');
  if (!ph || S.phases[ph.id] !== 'ready') return;
  if (ph.kind === 'gate') {
    if (pilot(S) === 'full-auto') return fullAutoGate(cart, ph);
    if (!passesGates(S) || !autoGate(ph) || (await questionsFor(cart, ph)).length) return;
    cart.unlockNext(ph.id); cart.log('approve', `${ph.id} (hands-off)`); cart.save();
    return continueAfter(cart, ph);
  }
  if (busy(leadPane) || (LIVE.get(cart.id) || {}).status) return; // the lead's screen is still and no spinner shows
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
let tick = 0, watching = false; // a slow tick (opening a PR, a long capture) must not overlap the next one
// Reads every pane of a cartridge: what it asks the user for, whether its screen moves, the lead's newest line
async function readScreens(cart, mine, agents) {
  const now = new Map(), asks = new Map();
  for (const p of mine) {
    const text = await T.capture(p.id, 60);
    const k = detectScreen(text);
    if (k) { now.set(p.id, k); asks.set(p.id, splitScreen(text).above.filter(l => l.trim()).slice(-6).join(' ').replace(/\s+/g, ' ')); }
    const shown = splitScreen(text).above.join('\n'); // below the prompt, the agents panel's clocks tick even when all are idle
    const seen = SEEN.get(p.id);
    if (!seen || seen.text !== shown) SEEN.set(p.id, { text: shown, at: seen ? Date.now() : 0 });
    if (p === mine[0]) { SAID.set(cart.id, lastReply(text)); LIVE.set(cart.id, liveView(text)); }
  }
  if (mine.length && !now.has(mine[0].id)) {
    const lead = leadOf(cart, agents);
    if (lead && lead.status === 'waiting') now.set(mine[0].id, 'question');
  }
  const before = ATTN.get(cart.id) || new Map();
  for (const [id, kind] of now) {
    if (!before.has(id)) notify(cart, id === mine[0].id ? 'the lead' : `agent ${(mine.find(p => p.id === id) || {}).title || id}`, kind, asks.get(id) || (id === mine[0].id ? SAID.get(cart.id) : ''));
  }
  ATTN.set(cart.id, now);
}
// Right after the user answers a prompt, so the "needs you" state clears without waiting for the next watch tick
async function recheck(cart) {
  const panes = (await T.allPanes()).filter(p => p.sess === cart.session);
  await readScreens(cart, panes, await claude.agents(0));
}
async function watch() {
  if (watching) return;
  watching = true;
  tick++;
  try {
    const carts = registry.cartridges();
    if (!carts.length) return;
    const panes = await T.allPanes();
    const agents = await claude.agents();
    for (const cart of carts) {
      const mine = panes.filter(p => p.sess === cart.session);
      await readScreens(cart, mine, agents);
      if (!mine.length) { SAID.delete(cart.id); LIVE.delete(cart.id); TEAMS.delete(cart.id); }
      else if (!cart.alive() && pilot(cart.state()) === 'full-auto' && Date.now() - (cart.state().autoRestartAt || 0) > 30 * 60000) {
        const S = cart.state(); S.autoRestartAt = Date.now(); cart.log('auto-restart', 'claude was not running'); cart.save();
        cart.restart({ resume: true }).then(() => startAndRun(cart, false)).catch(() => {});
      }
      else if (tick % 4 === 1) TEAMS.set(cart.id, await claude.team(cart.dir, (leadOf(cart, agents) || {}).sessionId).catch(() => null));
      if (mine.length && cart.alive()) {
        const lead = leadOf(cart, agents);
        await autoAdvance(cart, mine[0].id, lead).catch(() => {});
        await autoRun(cart, mine[0].id, lead).catch(() => {});
        await autoNudge(cart, mine).catch(() => {});
        await autoDecide(cart, mine, lead).catch(() => {});
        await autoAnswer(cart, mine).catch(() => {});
      }
      if (tick % 2 === 0) await activity(cart, mine.length ? 7000 : 300000).catch(() => {});
    }
    const live = new Set(panes.map(p => p.id));
    for (const id of SEEN.keys()) if (!live.has(id)) SEEN.delete(id);
  } catch {} finally { watching = false; }
}
setInterval(watch, 4000).unref();

async function planUsage() {
  const j = await readJSON(registry.usageFile);
  if (!j || !j.rate_limits) return null;
  const f = x => (x ? { pct: typeof x.used_percentage === 'number' ? x.used_percentage : null, resetsAt: x.resets_at ? x.resets_at * 1000 : null } : null);
  return { at: j.at || null, fiveHour: f(j.rate_limits.five_hour), sevenDay: f(j.rate_limits.seven_day) };
}

const busy = id => { const s = SEEN.get(id); return !!s && Date.now() - s.at < 10000; };
// Is the cartridge healthy? Claude gone, an error on screen, or no pane changing for a while while a step runs
const STALL_MS = 6 * 60000;
// Transcripts tell who is working: background agents have no pane, and their panel glyph looks the same busy or idle
const RECENT_MS = 45000;
const transcripts = c => ((ACT.get(c.id) || {}).data || {}).agents || [];
const recentlyWrote = (c, name) => transcripts(c).some(t => t.name === name && Date.now() - t.mtime < RECENT_MS);
function quietFor(c, mine) {
  const at = Math.max(...mine.map(p => (SEEN.get(p.id) || {}).at || 0), ...transcripts(c).map(t => t.mtime));
  return at ? Date.now() - at : 0; // 0 right after a server restart: unknown
}
function healthOf(c, mine, attn) {
  if (!mine.length) return null;
  if (!c.alive()) return { kind: 'exited', text: 'Claude is no longer running in this cartridge. Restart continues the conversation.' };
  const live = LIVE.get(c.id) || {};
  if (live.error) return { kind: /limit/i.test(live.error) ? 'limit' : 'error', text: live.error };
  const S = c.state();
  const quiet = quietFor(c, mine);
  if (!attn.size && c.phases.some(p => S.phases[p.id] === 'running') && quiet > STALL_MS) {
    return { kind: 'stalled', text: `Nothing has moved for ${Math.round(quiet / 60000)} min, and the lead has not reported the step done.` };
  }
  return null;
}
// One line for "what is it doing": the lead's last step while it works, otherwise a busy background agent's task
// When the current step started; steps started before stepAt existed fall back to the history
const stepStart = (c, s) => s.stepAt || ((s.history || []).find(h => h.action === 'run' || h.action === 'reject') || {}).t || null;
function doingOf(c) {
  const live = LIVE.get(c.id);
  if (!live) return null;
  const agent = live.agents.find(a => recentlyWrote(c, a.name));
  if (!live.status && agent) return `${agent.name}: ${agent.task || 'working'}`;
  return live.events[live.events.length - 1] || null;
}
async function nudge(cart) {
  const S = cart.state();
  const ph = cart.phases.find(p => S.phases[p.id] === 'running');
  const marker = ph && doneMarker(ph);
  await tell(cart, 'console', 'Asked where it stands', `Where are you on "${ph ? ph.title : 'this step'}"? If it is finished, start your reply with the line "${marker || 'DONE'}". If you are blocked, say what you need.`);
  S.nudged = { ...(S.nudged || {}), [ph ? ph.id : '-']: Date.now() };
  cart.log('nudge', ph ? ph.id : ''); cart.save();
}
// Hands-off asks a quiet lead once per step before showing the user that the step is stuck; full-auto keeps asking
async function autoNudge(cart, mine) {
  const S = cart.state();
  const ph = cart.phases.find(p => S.phases[p.id] === 'running');
  if (!ph || !passesGates(S) || (ATTN.get(cart.id) || new Map()).size || quietFor(cart, mine) <= STALL_MS) return;
  const last = (S.nudged || {})[ph.id];
  if (last && (pilot(S) !== 'full-auto' || Date.now() - last < STALL_MS)) return;
  await nudge(cart);
}
// Full auto at a checkpoint: the lead settles its own questions; at the merge, a draft PR is opened instead of merging
const FULL_AUTO_ANSWER = file => `The open questions in ${file} are yours to settle now; I will not answer them. For each, pick the safest `
  + `reasonable choice, write it next to the question, and carry on. Anything that needs money, secrets, accounts or a decision only `
  + `I can make: take the option that avoids it and list it under "Follow-ups for the user" in ${file}.`;
const PR_TEXT_ASK = 'Write plans/pr.md, the pull request text: line 1 is "# " and the title in the repo\'s commit convention; '
  + 'then the body, filling every section of the repo\'s PR template (.github/pull_request_template.md, if any) with real content: '
  + 'what changed and why, evidence with the exact commands run and their results, risk, docs, the checklist ticked only where true, '
  + 'and follow-ups. Keep "Closes #<issue>" when there is an issue. Plain short sentences, the template\'s HTML comments removed, '
  + 'no tool or AI attribution. Tell me when it is written.';
const GATING = new Set(); // cartridges with a checkpoint being settled; opening a PR takes seconds
async function fullAutoGate(cart, ph) {
  if (GATING.has(cart.id)) return;
  GATING.add(cart.id);
  try { await settleGate(cart, ph); } finally { GATING.delete(cart.id); }
}
async function settleGate(cart, ph) {
  const S = cart.state();
  if (S.phases[ph.id] !== 'ready' || SENDING.has(cart.id)) return;
  if (ph.pr && cart.rec.prUrl) {
    try { await cart.pushPr(); push(cart, `Fixes pushed to ${cart.rec.prUrl}`); }
    catch (e) { cart.log('push', `full auto could not push: ${e.message}`); push(cart, `Could not push to the pull request: ${e.message}`); return; }
    if (await autoAddressPr(cart)) return; // reviewers commented meanwhile: their comments are the next build round
  } else if (ph.pr) {
    if (cart.rec.branch && !cart.home && !cart.rec.prUrl) {
      const d = await cart.prDraft();
      if (!d.ahead) { push(cart, `${ph.title}: no commits to open a pull request with.`); return; }
      if (!d.written) { // never open a PR with the bare template: the lead writes the text first
        if (Date.now() - (S.prAskedAt || 0) > 10 * 60000 && await cart.running()) {
          S.prAskedAt = Date.now(); cart.save();
          await tell(cart, 'console', 'Asked for the PR text', PR_TEXT_ASK);
        }
        return;
      }
      try {
        await cart.openPr({ title: d.title, body: d.body, base: d.base, draft: true });
        push(cart, `Draft pull request opened: ${cart.rec.prUrl || d.title}`);
      } catch (e) { cart.log('pr', `full auto could not open the PR: ${e.message}`); push(cart, `Could not open the pull request: ${e.message}`); return; }
    }
  } else {
    const qs = await questionsFor(cart, ph);
    if (qs.length && await cart.running()) {
      await tell(cart, 'console', 'Questions left to the lead', FULL_AUTO_ANSWER(ph.file || 'the plan'));
      cart.log('answers', `full auto: the lead settles ${qs.length} questions`);
    }
  }
  cart.unlockNext(ph.id); cart.log('approve', `${ph.id} (full auto)`); cart.save();
  await continueAfter(cart, ph);
}
// Full auto answers what a pane asks once it has shown for a moment: permission prompts get Yes (the guard hook has
// already refused anything it blocks), the trust question gets Yes, and errors get a "continue" now and then
const ASKED_AT = new Map(); // pane id -> when its current question appeared
async function autoAnswer(cart, mine) {
  const S = cart.state();
  if (pilot(S) !== 'full-auto') return;
  const attn = ATTN.get(cart.id) || new Map();
  for (const id of ASKED_AT.keys()) if (!attn.has(id) && mine.some(p => p.id === id)) ASKED_AT.delete(id);
  for (const [id, kind] of attn) {
    if (!ASKED_AT.has(id)) { ASKED_AT.set(id, Date.now()); continue; }
    if (Date.now() - ASKED_AT.get(id) < 2500) continue;
    ASKED_AT.set(id, Date.now() + 5000); // one answer, then give the screen time to change
    if (kind === 'trust') await cart.trust();
    else if (kind === 'permission' || kind === 'question') await T.sendKeys(id, 'Enter');
    else continue;
    cart.log('auto-answer', `${kind} in ${id === mine[0].id ? 'the lead' : id}`);
  }
  const h = healthOf(cart, mine, attn);
  if (h && (h.kind === 'error' || h.kind === 'limit') && Date.now() - (S.autoContinueAt || 0) > 10 * 60000) {
    S.autoContinueAt = Date.now(); cart.log('auto-continue', h.text); cart.save();
    await T.sendText(mine[0].id, 'continue');
  }
}
// The story of a cartridge since its flow was last set: each run of a step in order, with its outcome, the agents
// that took part (several at once when they worked in parallel) and the messages they sent, read from actions.log
async function timeline(cart) {
  let text = '';
  try { text = await fsp.readFile(cart.logFile, 'utf8'); } catch {}
  let log = text.split('\n').map(l => l.match(/^(\S+) \[[^\]]*\] (\S+) ?(.*)$/)).filter(Boolean).map(m => ({ t: Date.parse(m[1]), action: m[2], detail: m[3] }));
  const since = Math.max(log.map(e => e.action).lastIndexOf('flow'), log.map(e => e.action).lastIndexOf('reset'));
  log = log.slice(since + 1);
  const byId = id => cart.phases.find(p => p.id === id);
  const runs = [];
  let cur = null, answered = false;
  const open = (ph, t, title) => { cur = { id: ph.id, title: title || ph.title, kind: 'agent', start: t, end: null, status: 'running', outcome: '', notes: [] }; runs.push(cur); };
  for (const e of log) {
    const ph = byId((e.detail.match(/^[\w-]+/) || [])[0]);
    if (e.action === 'answers') { answered = true; continue; }
    if (!ph) continue;
    if (e.action === 'run' && ph.kind === 'agent') {
      if (cur && cur.status === 'running' && cur.id === ph.id) continue; // the same prompt sent again
      if (cur && cur.status === 'running') { cur.end = e.t; cur.status = 'stopped'; }
      open(ph, e.t);
    } else if (e.action === 'done' && cur && cur.id === ph.id) {
      cur.end = e.t; cur.status = 'done'; cur.outcome = (e.detail.match(/lead reported ([A-Z]+ DONE)/) || [])[1] || 'Marked done'; cur = null;
    } else if (e.action === 'approve' && ph.kind === 'gate') {
      runs.push({ id: ph.id, title: ph.title, kind: 'gate', start: e.t, end: e.t, status: 'approved', notes: [],
        outcome: /hands-off|full auto/.test(e.detail) ? 'Passed by autopilot' : answered ? 'You approved, with answers' : 'You approved' });
      answered = false;
    } else if (e.action === 'reject') {
      const auto = /review said NEEDS WORK/.test(e.detail);
      if (cur && cur.id === ph.id) { cur.end = e.t; cur.status = 'changes'; cur.outcome = auto ? 'Needs work' : 'Sent back'; }
      else runs.push({ id: ph.id, title: ph.title, kind: ph.kind, start: e.t, end: e.t, status: 'changes', notes: [], outcome: ph.kind === 'gate' ? 'You asked for changes' : 'Sent back' });
      const back = byId(ph.rejectTo) || cart.phases[cart.phases.indexOf(ph) - 1];
      if (back) open(back, e.t, `${back.title}, ${auto ? (e.detail.match(/fix round \d+/) || ['fixes'])[0] : 'changes'}`);
    } else if (e.action === 'pr-comments') {
      if (cur && cur.status === 'running') { cur.end = e.t; cur.status = 'stopped'; }
      open(ph, e.t, `${ph.title}, PR comments`);
      cur.notes.push({ t: e.t, who: 'console', text: e.detail.replace(/^[\w-]+:\s*/, '') });
    } else if (e.action === 'nudge' && cur) cur.notes.push({ t: e.t, who: 'console', text: 'asked the lead where it stands' });
  }
  // Agents and their messages inside each run's time window
  const msgs = (((await activity(cart, 5000).catch(() => null)) || {}).messages || []).map(m => ({ ...m, t: Date.parse(m.time) })).filter(m => m.t);
  for (const r of runs) {
    const inRun = msgs.filter(m => m.t >= r.start && m.t <= (r.end || Date.now())).sort((a, b) => a.t - b.t);
    r.agents = [...new Set(inRun.flatMap(m => [m.from, m.to]))].filter(n => n && n !== 'team-lead' && n !== '?' && !/^#\d/.test(n));
    r.events = [...r.notes, ...inRun.map(m => ({ t: m.t, who: m.from, to: m.to, text: m.summary || String(m.text).split('\n')[0].slice(0, 160) }))].sort((a, b) => a.t - b.t);
    r.eventCount = r.events.length;
    r.events = r.events.slice(-4);
    delete r.notes;
  }
  return runs;
}
// Everyone on the team: agents with a pane, background agents listed under the lead's prompt (with their task),
// and teammates from the team config that show in neither
function crewOf(c, panes, attn, running) {
  const out = panes.map(p => ({ name: p.label, busy: busy(p.id), attention: attn.get(p.id) || null, task: '', time: '' }));
  if (!running) return out;
  const live = LIVE.get(c.id);
  if (live && out[0] && live.events.length) out[0].task = live.events[live.events.length - 1];
  const known = transcripts(c).some(t => t.name);
  const working = name => (known ? recentlyWrote(c, name) : true);
  for (const a of (live && live.agents) || []) if (!out.some(x => x.name === a.name)) out.push({ name: a.name, busy: !a.done && working(a.name), attention: null, task: a.task, time: a.time });
  for (const m of (TEAMS.get(c.id) || {}).members || []) {
    if (m.type !== 'team-lead' && !m.paneId && !out.some(x => x.name === m.name)) out.push({ name: m.name, busy: !!m.active && working(m.name), attention: null, task: '', time: '' });
  }
  return out;
}
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
      crew: crewOf(c, crew, attn, mine.length > 0),
      said: doingOf(c) || SAID.get(c.id) || null, health: healthOf(c, mine, attn), stepAt: stepStart(c, s), setup: s.setup || null,
      questions: (await questionsFor(c, c.phases.find(p => p.kind === 'gate' && s.phases[p.id] === 'ready'))).length,
      steps: { done: c.phases.filter(p => s.phases[p.id] === 'done').length, total: c.phases.length },
      digest: smallDigest(await c.digest().catch(() => null)), pr: s.pr ? { new: s.pr.new || 0, checkedAt: s.pr.checkedAt || null } : null,
    };
  }));
}
const smallDigest = d => (d && d.verdict ? { verdict: d.verdict, counts: d.counts, step: d.forTitle } : null);

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
// Renewed on every visit, so a device that signed in once stays signed in while it is used
function setAuthCookie(res) { res.setHeader('Set-Cookie', `ctu=${COOKIE_VAL}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 400}`); }
// The Mac itself needs no token: a loopback address and a localhost Host header (a DNS-rebinding page sends its own host)
const loopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
function local(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return loopback(req) && ['localhost', '127.0.0.1', '::1'].includes(host);
}
const tailscale = new Tailscale();
// Links for other devices; only the Mac may ask for them. Over Tailscale the owner's devices need no token.
function deviceUrls() {
  if (RUNTIME.tailscale) return tailscale.self ? [tailscale.self.name, ...tailscale.self.ips.filter(ip => ip.includes('.'))].filter(Boolean).map(h => `http://${h}:${RUNTIME.port}/`) : [];
  const out = [];
  if (RUNTIME.host === '0.0.0.0') for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs || []) {
    if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${RUNTIME.port}/?token=${TOKEN}`);
  }
  return out;
}
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
      scanRoots: config.scanRoots, home: os.homedir(), prFooter: config.prFooter, pilot: PILOTS.includes(config.data.pilot) ? config.data.pilot : 'hands-off',
      questionTimeoutMin: Number(config.data.questionTimeoutMin) || 0,
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
  async 'POST project-update'({ body }) { return { ok: true, project: config.updateProject(body.project, { testCommand: body.testCommand, node: body.node, setupCommand: body.setupCommand }) }; },
  async 'POST settings'({ body }) {
    if (body.models) config.setModels(body.models);
    if (body.prFooter != null) { config.data.prFooter = String(body.prFooter).trim().slice(0, 300); config.save(); }
    if (body.pilot != null) {
      if (!PILOTS.includes(body.pilot)) throw bad('Unknown autopilot level');
      config.data.pilot = body.pilot; config.save();
    }
    if (body.questionTimeoutMin != null) { config.data.questionTimeoutMin = timeoutMin(body.questionTimeoutMin); config.save(); }
    if (Array.isArray(body.scanRoots)) {
      config.data.scanRoots = body.scanRoots.map(s => String(s).trim().replace(/^~(?=\/|$)/, os.homedir())).filter(s => path.isAbsolute(s)).slice(0, 10);
      config.save();
      suggestCache.t = 0;
    }
    return { ok: true, models: config.models, scanRoots: config.scanRoots, pilot: config.data.pilot || 'hands-off', prFooter: config.prFooter, questionTimeoutMin: config.data.questionTimeoutMin };
  },
  // project=<id> or all; mine=1 keeps issues assigned to the gh user; q is GitHub search text
  // Filters are validated here and become gh flags or search qualifiers (lib/github.js). mine=1 is the old "assigned to me".
  async 'GET issues'({ q }) {
    const pid = q('project');
    const projects = pid && pid !== 'all' ? [registry.project(pid)] : registry.projects();
    const opts = {
      assignee: filt(q, 'assignee', LOGIN_RE) || (q('mine') === '1' ? '@me' : ''), author: filt(q, 'author', LOGIN_RE),
      label: filt(q, 'label', /^[^\x00-\x1f"]{1,50}$/), state: filt(q, 'state', /^(open|closed|all)$/) || 'open',
      query: String(q('q') || '').trim().slice(0, 200),
    };
    const sortKey = filt(q, 'sort', /^(updated|created)$/) === 'created' ? 'createdAt' : 'updatedAt';
    const used = new Map(registry.cartridges().filter(c => c.rec.issue && !c.home).map(c => [`${c.project.id}#${c.rec.issue}`, c.id]));
    const lists = await Promise.all(projects.map(async p => ({ p, r: await GH.listIssues(p.path, opts) })));
    const issues = [], errors = [];
    for (const { p, r } of lists) {
      if (!r.ok) { errors.push(`${p.name}: ${r.error}`); continue; }
      for (const i of r.issues) issues.push({ ...i, project: p.id, projectName: p.name, cart: used.get(`${p.id}#${i.number}`) || null });
    }
    issues.sort((a, b) => String(b[sortKey] || b.updatedAt).localeCompare(String(a[sortKey] || a.updatedAt)));
    return { ok: !lists.length || errors.length < lists.length, error: errors.join('; '), issues };
  },
  // Open pull requests to review, across projects like issues
  async 'GET prs'({ q }) {
    const pid = q('project');
    const projects = pid && pid !== 'all' ? [registry.project(pid)] : registry.projects();
    const opts = {
      mine: q('mine') === '1', author: filt(q, 'author', LOGIN_RE), review: filt(q, 'review', /^me$/), draft: filt(q, 'draft', /^(ready|draft)$/),
      decision: filt(q, 'decision', /^(approved|changes_requested|required|none)$/), query: String(q('q') || '').trim().slice(0, 200),
    };
    const used = new Map(registry.cartridges().filter(c => c.kind === 'review' && c.rec.pr).map(c => [`${c.project.id}#${c.rec.pr}`, c.id]));
    const lists = await Promise.all(projects.map(async p => ({ p, r: await GH.listPrs(p.path, opts) })));
    const prs = [], errors = [];
    for (const { p, r } of lists) {
      if (!r.ok) { errors.push(`${p.name}: ${r.error}`); continue; }
      for (const x of r.prs) prs.push({ ...x, project: p.id, projectName: p.name, cart: used.get(`${p.id}#${x.number}`) || null });
    }
    prs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { ok: !lists.length || errors.length < lists.length, error: errors.join('; '), prs };
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
    if (PILOTS.includes(body.pilot)) for (const c of made) { c.state().pilot = body.pilot; c.save(); }
    if (body.start) for (const c of made) c.start({}).then(() => startAndRun(c)).catch(() => {});
    return { ok: true, made: made.map(c => ({ id: c.id, title: c.title })) };
  },
  async 'POST cart-add-home'({ body }) {
    const c = await registry.addHome(registry.project(body.project), { flow: body.flow });
    if (PILOTS.includes(body.pilot)) { c.state().pilot = body.pilot; c.save(); }
    return { ok: true, made: [{ id: c.id, title: c.title }] };
  },
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
  // The assistant's chats; sending a message is the streaming route handled before this table
  async 'GET assistant/list'() { return { conversations: await assistant.list() }; },
  async 'GET assistant/get'({ q }) { return assistant.get(assistantId(q('id'))); },
  async 'POST assistant/delete'({ body }) { await assistant.delete(assistantId(body.id)); return { ok: true }; },
  async 'POST assistant/clear'() { await assistant.clear(); return { ok: true }; },
  // A card the user tapped: the console does it through the same code as the buttons, then tells the chat
  async 'POST assistant/act'({ body }) {
    const conv = await assistant.get(assistantId(body.conversation));
    const mi = Number(body.message), ai = Number(body.index);
    const m = conv.messages[mi];
    const a = m && m.actions && m.actions[ai];
    if (!a) throw bad('No such action');
    if (a.done) throw bad('This card was already used');
    let note = null, result = {};
    if (a.type === 'create-issue') {
      const p = registry.project(a.project);
      result = await GH.createIssue(p.path, a.title, a.body);
      note = `Created issue #${result.number} in ${p.name}: ${result.url}`;
    } else if (a.type === 'start-work') {
      result = await GLOBAL['POST cart-add']({ body: a.issue ? { issues: [`${a.project}#${a.issue}`], flow: a.flow }
        : { project: a.project, title: a.title, body: a.body, createIssue: a.createIssue, flow: a.flow } });
      note = `Added the cartridge "${result.made[0].title}" (${result.made[0].id}, ${a.flow} flow); it is not started yet`;
    } else if (a.type === 'review-pr') {
      result = await GLOBAL['POST cart-add-review']({ body: { project: a.project, pr: a.pr } });
      note = `Added the review cartridge "${result.made[0].title}" (${result.made[0].id}); it is not started yet`;
    } else if (a.type === 'research') {
      result = await GLOBAL['POST cart-add-research']({ body: { project: a.project, question: a.question, title: a.title } });
      note = `Added the research cartridge "${result.made[0].title}" (${result.made[0].id}); it is not started yet`;
    } else if (a.type === 'send') {
      const cart = registry.get(a.cart);
      await PER_CART['POST send']({ cart, body: { text: a.text } });
      note = `Sent to the lead of "${cart.title}": ${a.text}`;
    }
    await assistant.noteAction(conv, mi, ai, note);
    return { ok: true, note, ...result };
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
      mode: s.mode, request: s.request, start: s.start, startedAt: s.startedAt || null, autopilot: pilot(s) !== 'manual', pilot: pilot(s), live: panes.length ? LIVE.get(cart.id) || null : null,
      crew: crewOf(cart, panes.map(p => ({ id: p.id, label: p.label })), attn, panes.length > 0),
      health: healthOf(cart, panes, attn), doing: panes.length ? doingOf(cart) : null, stepAt: stepStart(cart, s), setup: s.setup || null,
      questions: await questionsFor(cart, cart.phases.find(p => p.kind === 'gate' && s.phases[p.id] === 'ready')),
      // A build sent back by a review: which fix round it is
      fixRound: cart.phases.some(p => p.rejectTo && s.phases[p.rejectTo] === 'running') ? s.autoFixes || 0 : 0, maxFixes: MAX_AUTO_FIXES,
      digest: await cart.digest().catch(() => null), pr: s.pr ? { new: s.pr.new || 0, total: s.pr.total || 0, checkedAt: s.pr.checkedAt || null, decision: s.pr.decision || '' } : null,
      questionTimeoutMin: s.questionTimeoutMin == null ? null : s.questionTimeoutMin, questionTimeoutDefault: Number(config.data.questionTimeoutMin) || 0,
      timeline: await timeline(cart),
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
    // Handing over at a checkpoint: the team settles it now instead of on the next watch tick
    const gate = cart.phases.find(p => p.kind === 'gate' && S.phases[p.id] === 'ready');
    if (mode === 'full-auto' && gate) await fullAutoGate(cart, gate).catch(e => cart.log('approve', `full auto: ${e.message}`));
    return { ok: true, pilot: mode, autopilot: mode !== 'manual' };
  },
  async 'POST stop'({ cart, body }) { await cart.stop(!!body.hard); ATTN.delete(cart.id); return { ok: true }; },
  async 'POST nudge'({ cart }) { await nudge(cart); return { ok: true }; },
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
  // Runs the project's setup command again in this cartridge (after a failure, or once a command is set)
  async 'POST setup'({ cart }) {
    if (!cart.project.setupCommand) throw bad('This project has no setup command. Set one under Projects and settings.');
    if (cart.home || cart.kind === 'research') throw bad('Setup runs only in worktrees');
    cart.runSetup().catch(() => {});
    return { ok: true, setup: cart.state().setup };
  },
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
      const answers = String(body.answers || '').trim().slice(0, 20000);
      if (action === 'approve' && answers && await cart.running()) {
        await tell(cart, 'console', 'Your answers', `My answers to the open questions in ${ph.file || 'the plan'}:\n\n${answers}\n\nRecord them in ${ph.file || 'the plan'} next to the questions, and follow them from here on.`);
        cart.log('answers', answers);
      }
      if (action === 'done' && ph.rejectTo) S.reviewedSha = await cart.headSha();
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
    delete S.reviewedSha;
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
  async 'POST pr-push'({ cart }) {
    const r = await cart.pushPr();
    const addressed = await autoAddressPr(cart).catch(() => false);
    return { ok: true, ...r, addressed };
  },
  async 'POST address-pr'({ cart }) {
    if (!cart.rec.prUrl) throw bad('This cartridge has no pull request yet');
    const fb = await GH.prFeedback(cart.dir, cart.rec.prUrl);
    const count = fb.threads.length + fb.reviews.length + fb.comments.length;
    return { ok: true, count: count ? await addressPr(cart, fb) : 0 };
  },
  async 'POST pr-check'({ cart }) { const r = await checkPr(cart); return { ok: true, new: r.fresh, total: cart.state().pr.total, decision: r.fb.decision || '', checkedAt: cart.state().pr.checkedAt }; },
  // Away mode for this cartridge: minutes a mid-step question waits for the user before the lead decides; null = the global setting
  async 'POST question-timeout'({ cart, body }) {
    const S = cart.state();
    if (body.min == null || body.min === '') delete S.questionTimeoutMin; else S.questionTimeoutMin = timeoutMin(body.min);
    cart.log('question-timeout', S.questionTimeoutMin == null ? 'default' : String(S.questionTimeoutMin)); cart.save();
    return { ok: true, questionTimeoutMin: S.questionTimeoutMin == null ? null : S.questionTimeoutMin };
  },
  // The lead's conversation as turns, from a byte offset of its transcript (file + since from the previous answer)
  async 'GET chat'({ cart, q }) {
    const lead = leadOf(cart, await claude.agents());
    const file = await claude.leadTranscript(cart.dir, cart.sessionName, lead && lead.sessionId);
    if (!file) return { file: null, cursor: 0, turns: [], reset: !!q('file') };
    const name = path.basename(file, '.jsonl');
    const same = q('file') === name;
    const r = await claude.chatTurns(file, same ? q('since') : 0);
    const sent = cart.state().sent || [];
    for (const t of r.turns) {
      if (t.role !== 'user') continue;
      const hit = sent.find(e => e.key === sentKey(t.text));
      if (hit) { t.role = hit.kind === 'step' ? 'step' : 'console'; t.title = hit.title; }
    }
    return { file: name, cursor: r.cursor, turns: same ? r.turns : r.turns.slice(-300), reset: !same && !!q('file') };
  },
  // ±20 lines around a finding's file:line, from HEAD of the cartridge; tracked files only
  async 'GET excerpt'({ cart, q }) {
    const x = await cart.excerpt(q('file'), q('line'));
    if (!x) throw new HttpError(404, 'Not a tracked file of this cartridge');
    return x;
  },
};
function timeoutMin(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1440) throw bad('The timeout is minutes, 0 to 1440 (0 turns it off)');
  return Math.round(n * 100) / 100;
}
function templateName(cart, name) {
  const n = String(name || '');
  if (TEMPLATE_NAMES.includes(n) || cart.phases.some(p => p.prompt === n)) return n;
  throw bad('Unknown template');
}

// ---------- Assistant: a chat that reads the workspace and proposes cards ----------
function assistantId(id) {
  if (!Assistant.validId(id)) throw bad('Invalid conversation id');
  return String(id);
}
// Where the assistant reads from: a configured folder, else the first scan root (the workspace), else the folder
// above the first project, else home. Its session keeps that folder, so a chat resumes in the same place.
function assistantCwd() {
  const a = config.data.assistant || {};
  const first = config.projects[0];
  for (const c of [a.cwd, ...config.scanRoots, first && path.dirname(first.path)]) {
    if (!c) continue;
    const p = path.resolve(os.homedir(), String(c));
    try { if (fs.statSync(p).isDirectory()) return realpath(p); } catch {}
  }
  return os.homedir();
}
// What the console knows right now, in a few lines; the cartridge the chat was opened from gets more
async function assistantSnapshot(cart) {
  const lines = ['Projects: ' + (registry.projects().map(p => `${p.name} (id ${p.id}, ${p.path})`).join('; ') || 'none')];
  const carts = await summaries();
  lines.push(carts.length ? 'Cartridges:' : 'Cartridges: none');
  for (const c of carts) {
    const bits = [c.projectName, c.kind === 'team' ? `${c.flow} flow` : c.kind, c.running ? `running, step: ${c.phase}` : `off, next step: ${c.phase}`];
    if (c.attention) bits.push(`WAITING FOR THE USER (${c.attention})`);
    if (c.questions) bits.push(`${c.questions} question(s) for the user`);
    if (c.health) bits.push(c.health.text);
    if (c.url) bits.push(c.url);
    if (c.prUrl) bits.push(`PR ${c.prUrl}`);
    if (c.said) bits.push(`last: ${c.said}`);
    lines.push(`- [${c.id}] ${c.title}: ${bits.join(' · ')}`);
  }
  if (cart) {
    const s = cart.state();
    lines.push(`\nThe chat was opened from cartridge [${cart.id}] ${cart.title}, folder ${cart.dir}.`);
    lines.push('Its task: ' + String(s.request || '').slice(0, 600).replace(/\s+/g, ' '));
    lines.push('Its steps: ' + cart.phases.map(p => `${p.title} (${s.phases[p.id]})`).join(', '));
    const files = (await cart.plans()).map(f => f.path);
    if (files.length) lines.push(`Its notebook (plans/): ${files.slice(0, 30).join(', ')}`);
  }
  return lines.join('\n').slice(0, 6000);
}
async function assistantSystem(cart) {
  const strip = t => t.replace(/^<!--[\s\S]*?-->\s*/, '').trim();
  let text = null;
  if (cart) try { text = await fsp.readFile(cart.templateFile('90-assistant.md'), 'utf8'); } catch {}
  if (text == null) text = await fsp.readFile(path.join(APP_DIR, 'prompts', '90-assistant.md'), 'utf8');
  const snap = await assistantSnapshot(cart);
  text = strip(text);
  return text.includes('{{SNAPSHOT}}') ? text.replace('{{SNAPSHOT}}', snap) : `${text}\n\nConsole snapshot, taken now:\n${snap}`;
}
// Server-sent events: text as it streams, status lines for tool calls, then the saved message
async function assistantSend(res, body) {
  const text = String(body.text || '').trim().slice(0, ASSISTANT_MAX_TEXT);
  if (!text) throw bad('Write a message first');
  const cart = body.cart ? registry.get(body.cart) : null;
  const conv = body.conversation ? await assistant.get(assistantId(body.conversation)) : await assistant.create(assistantCwd());
  if (conv.busy) throw bad('The assistant is still answering; wait for it');
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive' });
  const emit = (type, data) => { if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  emit('open', { conversation: conv.id });
  try {
    const model = (config.data.assistant || {}).model || config.models.fast;
    const addDirs = registry.projects().map(p => p.path);
    const msg = await assistant.send(conv, text, { system: await assistantSystem(cart), model, addDirs }, e => emit(e.type, { text: e.text }));
    emit('done', { conversation: conv.id, message: msg, index: conv.messages.length - 1, costUSD: conv.costUSD });
  } catch (e) { emit('error', { error: e.message || String(e) }); }
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // With --tailscale, nothing outside this Mac and the tailnet gets an answer, not even the sign-in page
    if (RUNTIME.tailscale && !loopback(req) && !tailnetAddr(req.socket.remoteAddress)) return send(res, 403, 'Use Tailscale to reach this console.', 'text/plain; charset=utf-8');
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
    const signedIn = authed(req);
    if (!signedIn && !local(req) && !(RUNTIME.tailscale && await tailscale.owner(req.socket.remoteAddress))) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'Not logged in' });
      return send(res, 200, await fsp.readFile(path.join(APP_DIR, 'public', 'login.html')), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/' && signedIn) setAuthCookie(res);
    if (url.pathname === '/api/phone-link') return local(req) ? send(res, 200, { urls: deviceUrls(), tailscale: RUNTIME.tailscale }) : send(res, 403, { error: 'Only from the Mac itself' });
    if (STATIC[url.pathname] && req.method === 'GET') {
      const [f, type] = STATIC[url.pathname];
      return send(res, 200, await fsp.readFile(path.join(APP_DIR, 'public', f)), type);
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (req.method === 'POST' && req.headers['x-ctu'] !== '1') return send(res, 403, { error: 'Missing header' });

    const route = `${req.method} ${url.pathname.slice(5)}`;
    const body = req.method === 'POST' ? await readBody(req) : {};
    const q = k => url.searchParams.get(k);
    if (route === 'POST assistant/send') return await assistantSend(res, body); // awaited, so a refusal before the stream opens is a normal error
    if (GLOBAL[route]) return send(res, 200, await GLOBAL[route]({ body, q }));
    if (PER_CART[route]) return send(res, 200, await PER_CART[route]({ body, q, cart: registry.get(q('cart') || body.cart) }));
    return send(res, 404, { error: 'No such API' });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || String(e) });
  }
});

async function checkDeps() {
  if (RUNTIME.tailscale) {
    try { const me = await tailscale.status(); console.log(`✓ Tailscale: ${me.name} (${me.login})`); }
    catch (e) { console.error(`✗ --tailscale, but Tailscale is not running here (${e.message}). Install it from tailscale.com/download and sign in.`); process.exit(1); }
  }
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
    console.log(`  → http://localhost:${RUNTIME.port}  (this Mac, no token needed)`);
    for (const u of deviceUrls()) console.log(`  → ${u}  ${RUNTIME.tailscale ? `(your devices on Tailscale, as ${tailscale.self.login}: no token needed)` : '(phone: open once, it stays signed in)'}`);
    console.log(`\nToken: ${TOKEN}  (saved in ${path.join(RUNTIME.configDir, 'token')})`);
    if (RUNTIME.tailscale) console.log('Tailscale only: other networks get no answer.');
    else if (RUNTIME.host === '0.0.0.0') console.log('Listening on the local network. Use it only on a trusted network, or use --tailscale.');
  }));
}
module.exports = { server, registry, config };

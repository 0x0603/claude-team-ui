'use strict';
// Projects (git repositories) and cartridges. A cartridge is one piece of work with its own folder
// (a git worktree, the main checkout, or a research folder), tmux session, workflow state and notebook (plans/).
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { run, firstLine, sleep, readJSONSync, writeJSONSync, statSafe, shq, slugify, realpath, inside, API_VARS, SESSION_VARS, CLEAN_ENV, folderSize, fmtBytes } = require('./util');
const T = require('./tmux');
const GH = require('./github');
const { detectScreen } = require('./claude');
const { MODEL_RE } = require('./config');
const { Lane } = require('./lane');

const APP_DIR = path.join(__dirname, '..');
const GUARD = path.join(APP_DIR, 'hooks', 'guard.mjs');
const STATUSLINE = path.join(APP_DIR, 'hooks', 'statusline.mjs');
const SHIMS = path.join(APP_DIR, 'bin', 'shims'); // pnpm, npm, npx and yarn through the build lane (D63)
const PERMISSION_MODES = ['auto', 'manual', 'acceptEdits', 'plan', 'dontAsk'];
const EXCLUDES = ['/.claude/worktrees/', '/.claude/research/', '/.claude/team-ui/', '/.claude/settings.local.json', '/plans/'];
const TEMPLATE_NAMES = ['_rules.md', '_checks.md', '_summary.md', '_standards.md', '_pr.md'];

// Work cartridges run the quick, standard or full flow; review and research cartridges have their own.
// Every work flow ends the same way: Standards fixes the diff, Review reports, the lead makes the one commit (the only
// time the pre-commit hook runs, D66), the user merges, Retro updates the standards.
const STANDARDS = { kind: 'agent', title: 'Standards', mode: 'code', prompt: '04-standards.md', desc: 'A fresh agent fixes the diff to the coding standards and checks the tests can fail' };
const COMMIT = { kind: 'agent', title: 'Commit', mode: 'code', prompt: '07-commit.md', commit: true, desc: 'The lead makes the one commit: the pre-commit hook runs once, on the whole change' };
const RETRO = { kind: 'agent', title: 'Retro', mode: 'planning', prompt: '06-retro.md', desc: 'Turns what the reviews found into checks and coding standards' };
const ADOPT = { kind: 'gate', title: 'You approve the standards change', file: 'plans/retro.md', standards: true };
const PHASES = {
  quick: [
    { id: 'q-plan', kind: 'agent', title: 'Spec + plan', mode: 'planning', prompt: '30-quick-plan.md', desc: 'The lead alone writes a one-page plan → plans/plan.md' },
    { id: 'q-gate-plan', kind: 'gate', title: 'You review the plan', file: 'plans/plan.md' },
    { id: 'q-build', kind: 'agent', title: 'Build', mode: 'code', prompt: '31-quick-build.md', desc: 'The lead builds it alone, tests passing; staged, not committed' },
    { id: 'q-standards', ...STANDARDS },
    { id: 'q-review', kind: 'agent', title: 'Review', mode: 'code', prompt: '32-quick-review.md', desc: 'One read-only reviewer → plans/review.md', rejectTo: 'q-build' },
    { id: 'q-commit', ...COMMIT },
    { id: 'q-gate-merge', kind: 'gate', title: 'You approve the merge', file: 'plans/review.md', pr: true, danger: true, rejectTo: 'q-build' },
    { id: 'q-retro', ...RETRO },
    { id: 'q-gate-standards', ...ADOPT },
  ],
  standard: [
    { id: 's-plan', kind: 'agent', title: 'Spec + plan', mode: 'planning', prompt: '40-standard-plan.md', desc: 'A planner writes, a critic challenges once → plans/plan.md' },
    { id: 's-gate-plan', kind: 'gate', title: 'You review the plan', file: 'plans/plan.md' },
    { id: 's-build', kind: 'agent', title: 'Build', mode: 'code', prompt: '41-standard-build.md', desc: 'Up to two developers: code, tests, docs and skills' },
    { id: 's-standards', ...STANDARDS },
    { id: 's-review', kind: 'agent', title: 'Review', mode: 'code', prompt: '42-standard-review.md', desc: 'Two reviewers cover logic, security, tests, docs, skills → plans/review.md', rejectTo: 's-build' },
    { id: 's-commit', ...COMMIT },
    { id: 's-gate-merge', kind: 'gate', title: 'You approve the merge', file: 'plans/review.md', pr: true, danger: true, rejectTo: 's-build' },
    { id: 's-retro', ...RETRO },
    { id: 's-gate-standards', ...ADOPT },
  ],
  full: [
    { id: 'spec', kind: 'agent', title: 'Spec', mode: 'planning', prompt: '00-spec.md', desc: 'What and why, with acceptance criteria → plans/00-spec.md' },
    { id: 'gate-spec', kind: 'gate', title: 'You review the spec', file: 'plans/00-spec.md' },
    { id: 'planning', kind: 'agent', title: 'Plan', mode: 'planning', prompt: '01-planning.md', desc: 'Scout, two planners, critic and simplifier, cross-review → plans/final-plan.md' },
    { id: 'gate-plan', kind: 'gate', title: 'You review the plan', file: 'plans/final-plan.md' },
    { id: 'split', kind: 'agent', title: 'Split into tasks', mode: 'planning', prompt: '02-split-tasks.md', desc: 'Self-contained task files → plans/tasks/' },
    { id: 'code', kind: 'agent', title: 'Build', mode: 'code', prompt: '03-code.md', desc: 'One task at a time: fresh context, tests pass, staged for the one commit' },
    { id: 'standards', ...STANDARDS },
    { id: 'review', kind: 'agent', title: 'Review + QA', mode: 'code', prompt: '05-review-qa.md', desc: 'Reviewers report, nobody fixes → plans/review.md', rejectTo: 'code' },
    { id: 'commit', ...COMMIT },
    { id: 'gate-merge', kind: 'gate', title: 'You approve the merge', file: 'plans/review.md', pr: true, danger: true, rejectTo: 'code' },
    { id: 'retro', ...RETRO },
    { id: 'gate-standards', ...ADOPT },
  ],
  review: [
    { id: 'review-run', kind: 'agent', title: 'Review', mode: 'planning', prompt: '10-review.md', desc: 'Read-only review with cross-checking → plans/review-report.md' },
    { id: 'gate-review', kind: 'gate', title: 'You read the review', file: 'plans/review-report.md', forward: true, danger: true },
  ],
  research: [
    { id: 'research-run', kind: 'agent', title: 'Research', mode: 'planning', prompt: '20-research.md', desc: 'Several angles, sources checked → plans/report.md' },
    { id: 'gate-research', kind: 'gate', title: 'You read the report', file: 'plans/report.md', forward: true },
  ],
};
// The line each phase prompt asks the lead to start its final reply with; seeing it ends the phase
const DONE_MARKERS = {
  '00-spec.md': 'SPEC DONE', '01-planning.md': 'PLAN DONE', '02-split-tasks.md': 'TASKS DONE', '03-code.md': 'BUILD DONE',
  '04-standards.md': 'STANDARDS DONE', '05-review-qa.md': 'REVIEW DONE', '06-retro.md': 'RETRO DONE', '07-commit.md': 'COMMIT DONE', '10-review.md': 'REVIEW DONE',
  '20-research.md': 'RESEARCH DONE', '30-quick-plan.md': 'PLAN DONE', '31-quick-build.md': 'BUILD DONE', '32-quick-review.md': 'REVIEW DONE',
  '40-standard-plan.md': 'PLAN DONE', '41-standard-build.md': 'BUILD DONE', '42-standard-review.md': 'REVIEW DONE',
};
const sha256 = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const doneMarker = phase => (phase && phase.kind === 'agent' ? DONE_MARKERS[phase.prompt] || null : null);
// The first words of a text the console sent, enough to recognise it again in the lead's transcript
const sentKey = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 80);

// ---------- Step digests: the section the lead appends to plans/summary.md ({{SUMMARY}}), else the report's head ----------
const DIGEST_KEYS = ['verdict', 'findings', 'acceptance', 'tests', 'changed', 'top', 'questions', 'decided for you', 'next'];
const VERDICT_RE = /\b(READY TO MERGE|NEEDS WORK|DO NOT MERGE|BLOCKED|DONE)\b/i;
function parseCounts(s) {
  const n = k => { const m = String(s).match(new RegExp(`(\\d+)\\s*${k}`, 'i')); return m ? Number(m[1]) : 0; };
  return { critical: n('critical'), major: n('major'), minor: n('minor') };
}
// "- src/a.js:12 — one line" → file, line and the line; anything else is just text
function parseItem(s) {
  const t = String(s).replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim();
  const m = t.match(/^`?([\w@./+-]+?)(?::(\d+))?`?\s*(?:[—–-]+|:)\s+(.+)$/);
  return m && /[./]/.test(m[1]) ? { file: m[1], line: m[2] ? Number(m[2]) : null, text: m[3].trim() } : { file: null, line: null, text: t };
}
const listOf = (d, key) => (key === 'top' ? d.top : key === 'questions' ? d.questions : d.decided);
// The last "## <step> — <when>" section of summary.md
function parseSummary(md) {
  const lines = String(md || '').split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^##\s+/.test(lines[i])) { start = i; break; }
  if (start < 0) return null;
  const [step, at] = lines[start].replace(/^##\s+/, '').trim().split(/\s+[—–-]{1,2}\s+/);
  const d = { source: 'summary', step: step.trim().slice(0, 80), at: (at || '').trim().slice(0, 40), verdict: '', counts: null, acceptance: '', tests: '', changed: '', top: [], questions: [], decided: [], next: '' };
  let cur = null;
  for (const line of lines.slice(start + 1)) {
    const km = line.match(/^\s*(?:[-*]\s+)?\**([A-Za-z ]+?)\**\s*:\s*(.*)$/);
    const key = km && DIGEST_KEYS.find(k => k === km[1].trim().toLowerCase());
    if (key) {
      cur = key;
      const v = km[2].trim();
      if (key === 'verdict') { const vm = v.match(VERDICT_RE); d.verdict = vm ? vm[1].toUpperCase() : v.slice(0, 40); }
      else if (key === 'findings') d.counts = parseCounts(v);
      else if (['acceptance', 'tests', 'changed', 'next'].includes(key)) d[key] = v.slice(0, 200);
      else if (v && !/^none\b/i.test(v)) listOf(d, key).push(parseItem(v));
      continue;
    }
    const im = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)/);
    if (im && ['top', 'questions', 'decided for you'].includes(cur) && !/^none\b/i.test(im[1])) listOf(d, cur).push(parseItem(im[1]));
  }
  for (const k of ['top', 'questions', 'decided']) d[k] = d[k].slice(0, 8);
  return d;
}
// A report's own summary: the section under "## Summary", "## 1. Summary", "## TL;DR" or the like, up to the next
// heading of the same or a higher level
const SUMMARY_HEAD = /^(#{1,4})\s+(?:\d+[.)]\s*)?(summary|tl;?dr|verdict|overview|conclusions?)\b/i;
function summarySection(lines) {
  const i = lines.findIndex(l => SUMMARY_HEAD.test(l));
  if (i < 0) return null;
  const level = lines[i].match(/^#+/)[0].length;
  const end = lines.findIndex((l, k) => k > i && /^#{1,6}\s/.test(l) && l.match(/^#+/)[0].length <= level);
  const body = lines.slice(i + 1, end < 0 ? undefined : end);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return body.length ? { title: lines[i].replace(/^#+\s+/, '').trim().slice(0, 60), lines: body.slice(0, 80) } : null;
}
// Without plans/summary.md: the report's summary section, else its head. The verdict comes from a "Verdict:" line,
// else the last verdict word written in capitals ("done" in a sentence is not one)
function digestFromReport(text) {
  const all = String(text || '');
  const sec = summarySection(all.split('\n'));
  const said = all.match(new RegExp(`verdict\\W{0,4}\\s*${VERDICT_RE.source}`, 'i'));
  let verdict = said ? said[1].toUpperCase() : '', m;
  const re = new RegExp(VERDICT_RE.source, 'g');
  if (!verdict) while ((m = re.exec(all))) verdict = m[1];
  return { source: 'fallback', verdict, counts: null, section: sec ? sec.title : null,
    lines: sec ? sec.lines : all.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 12), top: [], questions: [], decided: [], next: '' };
}
// Counts the marker in the lead's replies only: lines of a "⏺" block, never the echoed "❯" prompt
function countDone(text, marker) {
  let inReply = false, n = 0;
  const re = new RegExp(`^\\s*(?:⏺\\s*)?[*"'\`]*${marker}\\b`);
  for (const line of String(text).split('\n')) {
    if (/^\s*⏺/.test(line)) inReply = true;
    else if (/^\s*❯/.test(line) || /^\s*⎿/.test(line) || /^─{8,}/.test(line)) inReply = false;
    if (inReply && re.test(line)) n++;
  }
  return n;
}
const KINDS = ['team', 'review', 'research'];
const FLOWS = ['quick', 'standard', 'full'];
const phaseSet = (kind, flow) => PHASES[kind === 'team' ? (FLOWS.includes(flow) ? flow : 'full') : kind];
const freshPhases = list => Object.fromEntries(list.map((p, i) => [p.id, i === 0 ? 'ready' : 'locked']));
const BASH_TIMEOUTS = { BASH_DEFAULT_TIMEOUT_MS: String(10 * 60000), BASH_MAX_TIMEOUT_MS: String(60 * 60000) };
const DEFAULT_START = { teammateMode: 'tmux', permissionMode: 'auto', model: '', remoteControl: true, rcName: '', caffeinate: true };

const isOurs = cmd => typeof cmd === 'string' && /ctu-guard|ctu-status|\.claude\/hooks\/task-completed\.sh/.test(cmd);
const cleanTitle = t => String(t || '').replace(/^[^\p{L}\p{N}]+/u, '').trim().replace(/^.*\.local$|^localhost$/i, '');

// Bin folder of an nvm-installed Node matching `want` ("24", "22.12"), newest first
function nvmBin(want) {
  const w = String(want).replace(/^v/, '').split('.').map(Number);
  const root = path.join(process.env.NVM_DIR || path.join(os.homedir(), '.nvm'), 'versions', 'node');
  let names = [];
  try { names = fs.readdirSync(root); } catch {}
  const ver = n => n.replace(/^v/, '').split('.').map(Number);
  const hit = names.filter(n => w.every((x, i) => ver(n)[i] === x))
    .sort((a, b) => { const x = ver(a), y = ver(b); return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]); })[0];
  return hit ? path.join(root, hit, 'bin') : null;
}

class Project {
  constructor(rec) {
    this.id = rec.id;
    this.path = rec.path;
    this.testCommand = rec.testCommand || '';
    this.setupCommand = rec.setupCommand || '';
    this.cleanCommand = rec.cleanCommand || '';
    this.commitCheck = rec.commitCheck || '';
    this.env = rec.env && typeof rec.env === 'object' ? rec.env : {}; // extra variables for sessions, setup and clean-up
    this.node = rec.node || '';
    this.name = path.basename(rec.path);
    this.uiDir = path.join(rec.path, '.claude', 'team-ui');
    this.slotsFile = path.join(this.uiDir, 'slots.json');
  }
  git(...a) { return run('git', ['-C', this.path, ...a], { timeout: 120000 }); }
  records() { const l = readJSONSync(this.slotsFile); return Array.isArray(l) ? l.filter(r => r && r.id && r.dir) : []; }
  saveRecords(list) { writeJSONSync(this.slotsFile, list); }
  async isRepo() { return (await this.git('rev-parse', '--is-inside-work-tree')).ok; }

  // Keeps the tool's files out of `git status` and out of commits. Local only: .git/info/exclude is never committed.
  async excludeLocal() {
    const r = await this.git('rev-parse', '--git-common-dir');
    if (!r.ok) return;
    const f = path.join(path.resolve(this.path, r.stdout.trim()), 'info', 'exclude');
    let cur = '';
    try { cur = await fsp.readFile(f, 'utf8'); } catch {}
    const have = new Set(cur.split('\n'));
    const need = EXCLUDES.filter(l => !have.has(l));
    if (!need.length) return;
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.appendFile(f, (cur && !cur.endsWith('\n') ? '\n' : '') + '# Claude Team UI\n' + need.join('\n') + '\n');
  }
  async defaultBase() {
    const s = await this.git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
    if (s.ok && s.stdout.trim()) return s.stdout.trim();
    for (const b of ['origin/main', 'origin/master', 'origin/development', 'origin/develop']) {
      if ((await this.git('rev-parse', '--verify', '--quiet', b)).ok) return b;
    }
    const h = await this.git('rev-parse', '--abbrev-ref', 'HEAD');
    return h.ok && h.stdout.trim() !== 'HEAD' ? h.stdout.trim() : 'HEAD';
  }
  async branches() {
    const r = await this.git('for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads', 'refs/remotes/origin');
    return r.ok ? r.stdout.split('\n').filter(b => b && !/^origin(\/HEAD)?$/.test(b)).slice(0, 80) : [];
  }
  // Node for this project's teams: the setting, else the repo's .nvmrc when that version is installed
  nodeBin() {
    if (this.node) {
      const bin = nvmBin(this.node);
      if (!bin) throw new Error(`Node ${this.node} is not installed. Install it with: nvm install ${this.node}`);
      return bin;
    }
    let rc = '';
    try { rc = fs.readFileSync(path.join(this.path, '.nvmrc'), 'utf8').trim(); } catch {}
    return /^v?\d+(\.\d+){0,2}$/.test(rc) ? nvmBin(rc) : null;
  }
  summary() { return { id: this.id, name: this.name, path: this.path, testCommand: this.testCommand, setupCommand: this.setupCommand, cleanCommand: this.cleanCommand, commitCheck: this.commitCheck, env: this.env, node: this.node }; }
  // The environment for the project's setup and clean-up commands: no API key, the console's build variables
  // (TURBO_CONCURRENCY), the project's own variables over them, its Node first
  shellEnv(build = {}) {
    const nodeBin = this.nodeBin();
    return { ...CLEAN_ENV, ...build, ...this.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', ...(nodeBin ? { PATH: `${nodeBin}:${process.env.PATH || ''}` } : {}) };
  }
}

// What hibernating removes when the project has no clean command: installed packages and build output (node_modules,
// .turbo, dist, .next) down to depth 3, never anything tracked by git
const CLEAN_NAMES = new Set(['node_modules', '.turbo', 'dist', '.next']);
const CLEAN_SKIP = new Set(['.git', '.claude', 'plans']);
async function cleanTargets(dir) {
  const out = [];
  const tracked = async rel => (await run('git', ['-C', dir, 'ls-files', '--', rel])).stdout.trim() !== '';
  const walk = async (d, depth) => {
    if (depth > 3) return;
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const rel = path.relative(dir, path.join(d, e.name));
      if (CLEAN_NAMES.has(e.name)) { if (!(await tracked(rel))) out.push(rel); }
      else if (!CLEAN_SKIP.has(e.name)) await walk(path.join(d, e.name), depth + 1);
    }
  };
  await walk(dir, 0);
  return out;
}
async function defaultClean(dir) {
  const removed = await cleanTargets(dir);
  for (const rel of removed) await fsp.rm(path.join(dir, rel), { recursive: true, force: true });
  return removed;
}

// Setup commands running right now (install, build in a fresh worktree): cartridge id → { promise, child }
const SETUPS = new Map();
const SETUP_TIMEOUT_MS = 20 * 60000;
const COMMIT_CHECK_TIMEOUT_MS = 30 * 60000;
const COMMITS = new Set(); // cartridges whose commit check is running
const WAIT_LINE = 'Waiting for a free build slot';
// Runs a command in its own process group with its output appended to `out`; past `ms` the whole group is killed, so no
// test worker or install outlives it. Resolves with the exit code ('timeout' past ms) and the last line of output.
function spawnLogged(file, args, opts, out, ms, onChild) {
  return new Promise(resolve => {
    let tail = '', timedOut = false;
    const child = spawn(file, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    BUILDS.add(child);
    child.on('close', () => BUILDS.delete(child));
    if (onChild) onChild(child);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, ms);
    const keep = d => { tail = (tail + d).slice(-2000); out.write(d); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', e => { clearTimeout(timer); resolve({ code: 1, last: e.message }); });
    child.on('close', c => { clearTimeout(timer); resolve({ code: timedOut ? 'timeout' : c, last: tail.split('\n').map(l => l.trim()).filter(Boolean).pop() || '' }); });
  });
}
function killTree(child) { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
// Setups and commit checks run in their own process groups, so the console going down takes them along explicitly
const BUILDS = new Set();
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(sig, () => { for (const c of BUILDS) killTree(c); process.exit(code); });

class Cartridge {
  constructor(reg, project, rec) {
    this.reg = reg;
    this.project = project;
    this.rec = rec;
    this.id = rec.id;
    this.kind = KINDS.includes(rec.kind) ? rec.kind : 'team';
    this.flow = this.kind === 'team' ? (FLOWS.includes(rec.flow) ? rec.flow : 'full') : null;
    this.home = !!rec.home;
    this.dir = rec.dir;
    this.title = rec.title || rec.id;
    this.uiDir = path.join(this.dir, '.claude', 'team-ui');
    this.stateFile = path.join(this.uiDir, 'state.json');
    this.logFile = path.join(this.uiDir, 'actions.log');
    this.exitMark = path.join(this.uiDir, 'claude-exited');
    this.settingsFile = path.join(this.dir, '.claude', 'settings.local.json');
    this.session = `${reg.prefix}-${rec.id}`.slice(0, 80);
    this.sessionName = this.title.slice(0, 60);
  }
  get phases() { return phaseSet(this.kind, this.flow); }

  // ---------- State: <dir>/.claude/team-ui/state.json (hooks/guard.mjs reads mode and projectDir from it) ----------
  state() {
    const cache = this.reg.states;
    if (!cache.has(this.id)) {
      const raw = readJSONSync(this.stateFile) || {};
      const s = { request: '', mode: 'planning', history: [], ...raw };
      const had = raw.phases || {};
      s.phases = { ...freshPhases(this.phases), ...had };
      // A step added to the flow later (the Commit step, D66) is done where the cartridge is already past it
      this.phases.forEach((p, i) => {
        if (!(p.id in had) && this.phases.slice(i + 1).some(q => had[q.id] && had[q.id] !== 'locked')) s.phases[p.id] = 'done';
      });
      const ids = new Set(this.phases.map(p => p.id));
      for (const k of Object.keys(s.phases)) if (!ids.has(k)) delete s.phases[k];
      s.start = { ...DEFAULT_START, ...(raw.start || {}) };
      cache.set(this.id, s);
    }
    return cache.get(this.id);
  }
  save() {
    const s = this.state();
    Object.assign(s, { cartId: this.id, kind: this.kind, projectDir: this.project.path });
    writeJSONSync(this.stateFile, s);
  }
  log(action, detail = '') {
    const line = `${new Date().toISOString()} [${this.id}] ${action} ${String(detail).replace(/\s+/g, ' ').slice(0, 300)}\n`;
    try { fs.mkdirSync(this.uiDir, { recursive: true }); fs.appendFileSync(this.logFile, line); } catch {}
    const s = this.state();
    s.history = [{ t: Date.now(), action, detail: String(detail).slice(0, 200) }, ...(s.history || [])].slice(0, 50);
  }
  // Switching between quick and full restarts the phases; the notebook stays
  setFlow(flow) {
    if (this.kind !== 'team') throw new Error('Only work cartridges have a quick or full flow');
    if (!FLOWS.includes(flow)) throw new Error('Unknown flow');
    this.reg.updateRecord(this, { flow });
    this.flow = flow;
    this.state().phases = freshPhases(this.phases);
    delete this.state().reviewedSha;
    this.log('flow', flow);
    this.save();
  }
  currentPhase() {
    const s = this.state();
    return this.phases.find(p => s.phases[p.id] === 'running') || this.phases.find(p => s.phases[p.id] === 'ready') || null;
  }
  unlockNext(id) {
    const s = this.state();
    const i = this.phases.findIndex(p => p.id === id);
    s.phases[id] = 'done';
    const next = this.phases[i + 1];
    if (next && s.phases[next.id] === 'locked') s.phases[next.id] = 'ready';
  }

  // ---------- Settings: agent teams on, the guard hook, the usage status line. Whatever the user added stays. ----------
  async applyMode(mode) {
    const s = this.state();
    let cur = {};
    try { cur = JSON.parse(await fsp.readFile(this.settingsFile, 'utf8')); } catch {}
    // A command may wait for the build lane and a commit's hook may run a whole test suite, past Claude Code's 2 min
    // default and 10 min cap for the Bash tool. The user's own values stay.
    cur.env = { ...BASH_TIMEOUTS, ...(cur.env || {}), CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' };
    // Deny rules written by older versions; the guard hook replaces them
    if (cur.permissions && Array.isArray(cur.permissions.deny) && Array.isArray(s.managedDeny)) {
      const old = new Set(s.managedDeny);
      cur.permissions.deny = cur.permissions.deny.filter(d => !old.has(d));
      if (!cur.permissions.deny.length) delete cur.permissions.deny;
      if (!Object.keys(cur.permissions).length) delete cur.permissions;
    }
    delete s.managedDeny;
    const hooks = cur.hooks && typeof cur.hooks === 'object' ? cur.hooks : {};
    for (const ev of Object.keys(hooks)) {
      hooks[ev] = (Array.isArray(hooks[ev]) ? hooks[ev] : []).filter(g => !((g && g.hooks) || []).some(h => isOurs(h.command)));
      if (!hooks[ev].length) delete hooks[ev];
    }
    hooks.PreToolUse = [...(hooks.PreToolUse || []), {
      matcher: 'Edit|Write|MultiEdit|NotebookEdit|Read|Bash',
      hooks: [{ type: 'command', command: `node ${shq(GUARD)} ctu-guard`, timeout: 15 }],
    }];
    cur.hooks = hooks;
    if (!cur.statusLine || isOurs(cur.statusLine.command)) {
      cur.statusLine = { type: 'command', command: `node ${shq(STATUSLINE)} ${shq(this.reg.usageFile)} ctu-status` };
    }
    if (this.kind === 'research') {
      cur.permissions = cur.permissions || {};
      cur.permissions.allow = [...new Set([...(cur.permissions.allow || []), 'WebSearch', 'WebFetch'])];
    }
    await fsp.mkdir(path.dirname(this.settingsFile), { recursive: true });
    await fsp.writeFile(this.settingsFile, JSON.stringify(cur, null, 2) + '\n');
    s.mode = mode;
    this.save();
  }
  async prepare() {
    await fsp.mkdir(path.join(this.dir, 'plans'), { recursive: true });
    await this.project.excludeLocal();
    await this.applyMode(this.state().mode);
  }

  // ---------- Setup: the project's install/build command, once per new worktree ----------
  // Runs in the background with the project's Node first on PATH. Output goes to .claude/team-ui/setup.log and the
  // status to the state, so the UI can show it and the first step that changes code waits for it (D33, server.js).
  get setupLog() { return path.join(this.uiDir, 'setup.log'); }
  setupPending() { const x = SETUPS.get(this.id); return x ? x.promise : Promise.resolve(); }
  runSetup() {
    const cmd = this.project.setupCommand;
    if (!cmd || SETUPS.has(this.id)) return this.setupPending();
    const s = this.state();
    s.setup = { status: 'running', cmd, startedAt: Date.now(), line: '' };
    this.log('setup', cmd);
    this.save();
    const entry = { promise: null, child: null };
    SETUPS.set(this.id, entry);
    const gone = () => SETUPS.get(this.id) !== entry; // ejected meanwhile: the folder is gone, write nothing
    const finish = (status, line) => {
      if (gone()) return;
      SETUPS.delete(this.id);
      s.setup = { ...s.setup, status, line: String(line || '').slice(0, 300), endedAt: Date.now() };
      if (status === 'ok') delete s.setupRetried;
      this.log(`setup-${status}`, line);
      this.save();
    };
    entry.promise = (async () => {
      let release = null;
      try {
        const env = this.project.shellEnv(this.reg.buildEnv());
        // Installs and builds take turns with every other cartridge's (D63)
        release = await this.reg.lane.acquire({ cart: this.id, cmd: `setup: ${cmd}` }, {
          until: gone, onWait: () => { if (s.setup.line !== WAIT_LINE) { s.setup.line = WAIT_LINE; this.save(); } },
        });
        if (!release) return;
        if (s.setup.line === WAIT_LINE) { s.setup.line = ''; this.save(); }
        fs.mkdirSync(this.uiDir, { recursive: true });
        const out = fs.createWriteStream(this.setupLog, { flags: 'a' });
        out.on('error', () => {});
        out.write(`$ ${cmd}\n`);
        const r = await spawnLogged('sh', ['-c', cmd], { cwd: this.dir, env }, out, SETUP_TIMEOUT_MS, child => { entry.child = child; });
        out.end();
        finish(r.code === 0 ? 'ok' : 'failed', r.code === 'timeout' ? 'Timed out after 20 min' : r.code === 0 ? r.last : `exit ${r.code}${r.last ? ': ' + r.last : ''}`);
      } catch (e) { finish('failed', e.message); } finally { if (release) release(); }
    })();
    return entry.promise;
  }
  killSetup() {
    const x = SETUPS.get(this.id);
    if (!x) return;
    SETUPS.delete(this.id);
    if (x.child) killTree(x.child);
  }

  // ---------- Commit check: a commit whose hook failed on load, run again alone (D62, D65) ----------
  // Holds every build-lane slot, so nothing else builds meanwhile, and runs turbo with TURBO_CONCURRENCY=1. Without a
  // project commit check it commits with the repo's own hook; with one, it runs that check and, only if it passes,
  // commits with --no-verify. It amends the cartridge's own commit while the branch is unpushed, else makes a new commit
  // with the message the lead left in plans/commit-msg.txt. Agents still cannot skip hooks.
  get commitLog() { return path.join(this.uiDir, 'commit-check.log'); }
  get commitMsgFile() { return path.join(this.dir, 'plans', 'commit-msg.txt'); }
  // Whether the next commit of this work folds into its own commit: there is one on the branch, unpushed, and no pull
  // request. Otherwise a new commit. The Commit step ({{COMMIT}}) and the commit check ask the same question.
  async commitAmends() {
    if (!this.rec.base || this.rec.prUrl) return false;
    const g = (...a) => run('git', ['-C', this.dir, ...a]);
    const ahead = Number((await g('rev-list', '--count', `${this.rec.base}..HEAD`)).stdout.trim()) || 0;
    return ahead > 0 && !(await g('branch', '-r', '--contains', 'HEAD')).stdout.trim();
  }
  async commitPlan() {
    const g = (...a) => run('git', ['-C', this.dir, ...a]);
    const names = async (...a) => (await g(...a)).stdout.split('\n').filter(Boolean);
    const staged = await names('diff', '--cached', '--name-only');
    const unstaged = await names('diff', '--name-only');
    const amend = await this.commitAmends();
    const message = amend ? '' : (await fsp.readFile(this.commitMsgFile, 'utf8').catch(() => '')).trim();
    return { cmd: this.project.commitCheck, staged, unstaged, amend, message, head: (await g('log', '-1', '--format=%h %s')).stdout.trim() };
  }
  commitChecking() { return COMMITS.has(this.id); }
  async runCommitCheck(plan) {
    if (COMMITS.has(this.id)) throw new Error('The commit check is running already');
    COMMITS.add(this.id);
    const s = this.state();
    const label = plan.cmd || 'git commit with the repo\'s hook';
    s.commitCheck = { status: 'running', cmd: label, hook: !plan.cmd, amend: plan.amend, startedAt: Date.now(), line: '' };
    this.log('commit-check', label);
    this.save();
    const finish = (status, line, sha = '') => {
      COMMITS.delete(this.id);
      s.commitCheck = { ...s.commitCheck, status, line: String(line || '').slice(0, 300), sha, endedAt: Date.now() };
      this.log(`commit-check-${status}`, line);
      this.save();
      return { ok: status === 'ok', line: s.commitCheck.line, sha, amend: plan.amend, hook: !plan.cmd, cmd: plan.cmd };
    };
    let release = null;
    try {
      const env = { ...this.project.shellEnv(this.reg.buildEnv()), TURBO_CONCURRENCY: '1' };
      release = await this.reg.lane.acquire({ cart: this.id, cmd: `commit check: ${label}` }, {
        exclusive: true, onWait: () => { if (s.commitCheck.line !== WAIT_LINE) { s.commitCheck.line = WAIT_LINE; this.save(); } },
      });
      if (s.commitCheck.line === WAIT_LINE) { s.commitCheck.line = ''; this.save(); }
      fs.mkdirSync(this.uiDir, { recursive: true });
      const out = fs.createWriteStream(this.commitLog);
      out.on('error', () => {});
      const step = (file, args, shown) => { out.write(`$ ${shown}\n`); return spawnLogged(file, args, { cwd: this.dir, env }, out, COMMIT_CHECK_TIMEOUT_MS); };
      const failed = (r, what) => { out.end(); return finish('failed', r.code === 'timeout' ? 'Timed out after 30 min' : `${what}exit ${r.code}${r.last ? ': ' + r.last : ''}`); };
      if (plan.cmd) {
        const r = await step('sh', ['-c', plan.cmd], plan.cmd);
        if (r.code !== 0) return failed(r, '');
      }
      // The checks or the hook may format and restage files (lint-staged); commit only what is staged now
      if ((await run('git', ['-C', this.dir, 'diff', '--cached', '--quiet'])).ok) {
        out.end();
        return finish('failed', plan.cmd ? 'The checks passed, but nothing is staged any more' : 'Nothing is staged');
      }
      const args = [...(plan.cmd ? ['--no-verify'] : []), ...(plan.amend ? ['--amend', '--no-edit'] : ['-F', this.commitMsgFile])];
      const c = await step('git', ['-C', this.dir, 'commit', ...args], `git commit ${args.join(' ').replace(this.commitMsgFile, 'plans/commit-msg.txt')}`);
      if (c.code !== 0) return failed(c, 'git commit: ');
      out.end();
      if (!plan.amend) await fsp.unlink(this.commitMsgFile).catch(() => {}); // used once; a later commit needs its own
      const sha = await this.headSha();
      return finish('ok', `${plan.amend ? 'Amended' : 'Committed'} ${sha}`, sha);
    } catch (e) { return finish('failed', e.message); } finally { if (release) release(); }
  }
  async headSha() {
    const r = await run('git', ['-C', this.dir, 'rev-parse', '--short', 'HEAD']);
    return r.ok ? r.stdout.trim() : '';
  }
  // The worktree as a review saw it, so the next round diffs from there ({{SINCE}}, D34): nothing is committed until the
  // Commit step. git stash create only writes a commit object: no stash entry, no file or index change. HEAD when clean.
  async snapshot() {
    const r = await run('git', ['-C', this.dir, 'stash', 'create', 'team-ui: worktree a review covered']);
    return (r.ok && r.stdout.trim().slice(0, 12)) || this.headSha();
  }
  // Hibernate: drop what the setup command can put back (installed packages, build output) and keep the worktree,
  // its branch and the notebook. Start installs again first.
  async hibernate() {
    if (this.home || this.kind === 'research') throw new Error('Only worktrees hibernate');
    if (await this.running()) throw new Error('Power the cartridge off first');
    const before = await folderSize(this.dir);
    const cmd = this.project.cleanCommand;
    let removed;
    if (cmd) {
      const r = await run('sh', ['-c', cmd], { cwd: this.dir, env: this.project.shellEnv(this.reg.buildEnv()), timeout: 10 * 60000 });
      if (!r.ok) throw new Error(`Clean command failed: ${firstLine(r.stderr || r.stdout)}`);
      removed = [cmd];
    } else removed = await defaultClean(this.dir);
    const after = await folderSize(this.dir);
    const s = this.state();
    s.hibernated = { at: Date.now(), before, after, removed: removed.slice(0, 20) };
    this.log('hibernate', `${fmtBytes(before)} → ${fmtBytes(after)}: ${removed.join(', ')}`);
    this.save();
    return { before, after, removed };
  }

  // ---------- tmux session ----------
  running() { return T.hasSession(this.session); }
  alive() { return !fs.existsSync(this.exitMark); }
  async panes(all, team) {
    all = all || await T.allPanes();
    const members = new Map(((team && team.members) || []).filter(m => m.paneId).map(m => [m.paneId, m]));
    return all.filter(p => p.sess === this.session).map((p, i) => {
      const m = members.get(p.id);
      return {
        id: p.id, isLead: i === 0, title: p.title, cmd: p.cmd, model: m ? m.model : '',
        label: i === 0 ? 'lead' : m ? m.name : cleanTitle(p.title) || `agent ${i}`,
      };
    });
  }
  // Panes must belong to this cartridge's session, so input never reaches another cartridge
  async paneFor(id) {
    const panes = await this.panes();
    if (!panes.length) throw new Error('This cartridge is off. Press Start.');
    if (!id) return panes[0].id;
    if (!/^%\d+$/.test(String(id)) || !panes.some(p => p.id === id)) throw new Error('That agent is not part of this cartridge');
    return id;
  }

  async start(opts = {}) {
    if (await this.running()) throw new Error('This cartridge is already running');
    if (!(await statSafe(this.dir))) throw new Error('The cartridge folder is gone: ' + this.dir);
    const s = this.state();
    const o = { ...DEFAULT_START, ...s.start };
    for (const k of Object.keys(DEFAULT_START)) if (opts[k] !== undefined) o[k] = typeof DEFAULT_START[k] === 'boolean' ? !!opts[k] : String(opts[k]);
    s.start = o;
    if (s.hibernated) { delete s.hibernated; this.log('wake', 'setup runs again'); this.runSetup().catch(() => {}); } // packages were dropped
    delete s.autoOff; // powered off while idle: the start route continues the conversation (server.js)
    await this.applyMode(s.mode);
    const args = [this.reg.claudeBin, '--teammate-mode', o.teammateMode === 'in-process' ? 'in-process' : 'tmux', '--name', this.sessionName];
    if (PERMISSION_MODES.includes(o.permissionMode)) args.push('--permission-mode', o.permissionMode);
    if (o.model && MODEL_RE.test(o.model)) args.push('--model', o.model);
    if (opts.resume) args.push('--continue');
    if (o.remoteControl) args.push('--remote-control', (o.rcName || `${this.project.name}: ${this.title}`).slice(0, 60));
    let cmd = args.map(shq).join(' ');
    if (o.caffeinate && process.platform === 'darwin') cmd = 'caffeinate -i ' + cmd;
    try { fs.unlinkSync(this.exitMark); } catch {}
    fs.mkdirSync(this.uiDir, { recursive: true });
    const build = { ...this.reg.buildEnv(), ...this.project.env, CTU_LANE_DIR: this.reg.lane.dir };
    const env = { ...build, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', CTU_CART: this.id };
    for (const k of ['CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'LANG']) if (process.env[k]) env[k] = process.env[k];
    // tmux gives a pane the client's PATH and ignores -e PATH, so the lane's shims and the project's Node go first inside
    // the shell; teammate panes split from the lead inherit it. The project's variables are exported too, for the same reason.
    const nodeBin = this.project.nodeBin();
    const nodePath = `export PATH=${[SHIMS, nodeBin].filter(Boolean).map(shq).join(':')}:"$PATH"${nodeBin ? ' COREPACK_ENABLE_DOWNLOAD_PROMPT=0' : ''}; `;
    const projEnv = Object.entries(build).map(([k, v]) => `export ${k}=${shq(v)}; `).join('');
    const shell = `unset ${[...API_VARS, ...SESSION_VARS].join(' ')}; ${projEnv}export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 CTU_CART=${shq(this.id)}; ${nodePath}${cmd}; `
      + `date > ${shq(this.exitMark)}; echo; echo '[claude exited. Press Start to power the cartridge off]'; exec sleep 86400`;
    await T.newSession({ name: this.session, cwd: this.dir, command: shell, env });
    s.startedAt = Date.now();
    this.log('start', JSON.stringify({ ...o, resume: !!opts.resume }));
    this.save();
  }
  // Soft stop sends /exit and confirms the "Exit and stop tasks" menu Claude shows while teammates are alive.
  async stop(hard) {
    if (!(await this.running())) return;
    if (!hard && this.alive()) {
      try {
        const lead = await this.paneFor(null);
        await T.sendText(lead, '/exit');
        let confirmed = false;
        for (let i = 0; i < 24 && this.alive(); i++) {
          await sleep(500);
          if (!confirmed && detectScreen(await T.capture(lead, 40)) === 'exit') { await T.sendKeys(lead, 'Enter'); confirmed = true; }
        }
      } catch {}
    }
    await T.killSession(this.session);
    this.state().startedAt = null;
    this.log(hard ? 'kill' : 'stop');
    this.save();
  }
  async restart(opts = {}) { await this.stop(false); await sleep(500); await this.start(opts); }
  // The trust dialog defaults to "No, exit", so a plain Enter would quit Claude
  async trust() {
    const lead = await this.paneFor(null);
    const text = await T.capture(lead, 30);
    if (detectScreen(text) !== 'trust') throw new Error('Claude is not asking about folder trust right now');
    if (!/❯\s*Yes, I trust/.test(text)) { await T.sendKeys(lead, 'Down'); await sleep(150); }
    await T.sendKeys(lead, 'Enter');
    this.log('trust');
  }

  // ---------- Prompts ----------
  templateFile(name) { return path.join(this.project.uiDir, 'prompts', name); }
  async template(name) {
    try { return { text: await fsp.readFile(this.templateFile(name), 'utf8'), custom: true }; } catch {}
    return { text: await fsp.readFile(path.join(APP_DIR, 'prompts', name), 'utf8'), custom: false };
  }
  async saveTemplate(name, text) {
    const f = this.templateFile(name);
    if (text == null) { try { await fsp.unlink(f); } catch {} return; }
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, String(text).slice(0, 50000));
  }
  async renderPrompt(phase) { return this.render(phase.prompt, phase.title); }
  async render(name, step = '') {
    const strip = t => t.replace(/^<!--[\s\S]*?-->\s*/, '').trim();
    const m = this.reg.config.models;
    const vars = {
      REQUEST: this.state().request || '(no task written yet)', PROJECT: this.project.name,
      BRANCH: this.rec.branch || 'the current branch', TARGET: this.rec.target || '', BASE: this.rec.base || 'main',
      PR: this.rec.pr ? String(this.rec.pr) : '', STRONG: m.strong, FAST: m.fast,
      TEST: this.project.testCommand ? `\`${this.project.testCommand}\`` : 'the test command documented in CLAUDE.md or the README',
      // A snapshot of the worktree the previous review covered, so a fix round reviews only what changed since
      SINCE: this.state().reviewedSha || 'the previous review',
      STEP: step,
    };
    const base = this.rec.base || 'main';
    vars.SCOPE = this.rec.pr
      ? `\`gh pr diff ${this.rec.pr}\` (the local clone may be shallow; \`git diff ${base}...HEAD\` also works when the history allows).`
      : `\`git diff ${base}...HEAD\`, and \`git log ${base}..HEAD\` for the individual commits.`;
    const fill = t => t.replace(/\{\{(\w+)\}\}/g, (all, k) => (vars[k] != null ? vars[k] : all));
    vars.RULES = fill(strip((await this.template('_rules.md')).text));
    vars.CHECKS = fill(strip((await this.template('_checks.md')).text));
    vars.SUMMARY = fill(strip((await this.template('_summary.md')).text));
    vars.PRTEXT = fill(strip((await this.template('_pr.md')).text));
    const text = strip((await this.template(name)).text);
    if (text.includes('{{COMMIT}}')) vars.COMMIT = await this.commitHow();
    return fill(text);
  }
  // How the Commit step commits: a new commit, or folded into this work's own unpushed commit; never an amend once pushed
  async commitHow() {
    if (this.rec.prUrl) return 'The branch is already in a pull request, so add a new commit on top: git commit -F plans/commit-msg.txt. Never amend or force-push.';
    if (await this.commitAmends()) return 'This work already has its own commit, not pushed: fold the change into it with git commit --amend --no-edit (no new message needed).';
    return 'Commit with git commit -F plans/commit-msg.txt.';
  }
  // The project's coding standards as a file every step can read; the retro edits this copy (D59, D60)
  get standardsCopy() { return path.join(this.dir, 'plans', 'coding-standards.md'); }
  async writeStandards() {
    const text = (await this.template('_standards.md')).text;
    await fsp.mkdir(path.dirname(this.standardsCopy), { recursive: true });
    await fsp.writeFile(this.standardsCopy, text);
    this.state().standardsBase = sha256(text); // an adopt must still find this, so it never drops a newer change
  }
  // The retro's proposal, read once: its text and the exact diff the user approves. Null when nothing changed.
  async standardsProposal() {
    const st = await fsp.lstat(this.standardsCopy).catch(() => null);
    if (!st || !st.isFile()) return null; // a symlink could show one text and adopt another
    const text = await fsp.readFile(this.standardsCopy, 'utf8');
    const now = (await this.template('_standards.md')).text;
    if (!text.trim() || text === now || text.length > 50000) return null;
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ctu-standards-'));
    try {
      await fsp.writeFile(path.join(tmp, 'current.md'), now);
      await fsp.writeFile(path.join(tmp, 'proposed.md'), text);
      const d = await run('git', ['diff', '--no-index', '--no-color', '-U2', 'current.md', 'proposed.md'], { cwd: tmp });
      return { text, diff: d.stdout.slice(Math.max(0, d.stdout.indexOf('@@'))).trimEnd() };
    } finally { await fsp.rm(tmp, { recursive: true, force: true }); }
  }
  async adoptStandards(proposal) {
    if (sha256((await this.template('_standards.md')).text) !== this.state().standardsBase) {
      throw new Error('The coding standards changed since this retro started (another cartridge or an edit). Run the retro again.');
    }
    await this.saveTemplate('_standards.md', proposal.text);
  }
  // "Merge danger: one-way door" near the top of the review a gate shows
  async mergeDanger(gate) {
    if (!gate || !gate.danger) return null;
    try {
      const head = (await fsp.readFile(path.join(this.dir, gate.file), 'utf8')).slice(0, 3000);
      const m = head.match(/merge danger\W{0,6}(one|two)-way/i);
      return m ? `${m[1].toLowerCase()}-way` : null;
    } catch { return null; }
  }
  // What the console itself sent to the lead, so the chat shows it as a step or a console line, not as the user's words
  noteSent(kind, title, text) {
    const s = this.state();
    s.sent = [...(s.sent || []), { kind, title, key: sentKey(text), t: Date.now() }].slice(-40);
  }
  // The digest of the last finished agent step (the one before an open checkpoint, or before the running step):
  // the section the lead appended to plans/summary.md, else the head of the step's report
  async digest() {
    const s = this.state();
    const cur = this.currentPhase();
    const before = cur ? this.phases.slice(0, this.phases.indexOf(cur)) : this.phases;
    // The Commit step writes no summary: the merge checkpoint shows the review's
    const done = [...before].reverse().find(p => p.kind === 'agent' && !p.commit && s.phases[p.id] === 'done');
    if (!done) return null;
    let d = null;
    try { d = parseSummary(await fsp.readFile(path.join(this.dir, 'plans', 'summary.md'), 'utf8')); } catch {}
    const gate = this.phases.slice(this.phases.indexOf(done) + 1).find(p => !p.commit);
    const file = gate && gate.kind === 'gate' ? gate.file : null;
    if (!d && file) {
      try { d = { ...digestFromReport(await fsp.readFile(path.join(this.dir, file), 'utf8')), file }; } catch {}
    }
    return d && { ...d, forStep: done.id, forTitle: done.title, gate: gate && gate.kind === 'gate' ? gate.id : null };
  }
  // ±20 lines of a tracked file at HEAD, for a finding's file:line. Nothing outside the cartridge, no symlink escape.
  async excerpt(rel, line) {
    const r = String(rel || '');
    if (!r || r.includes('\0') || path.isAbsolute(r) || r.split(/[\\/]/).includes('..')) return null;
    const abs = path.resolve(this.dir, r);
    if (!inside(this.dir, abs) || !inside(realpath(this.dir), realpath(abs))) return null;
    if (!(await run('git', ['-C', this.dir, 'ls-files', '--error-unmatch', '--', r])).ok) return null;
    const show = await run('git', ['-C', this.dir, 'show', `HEAD:${r}`], { maxBuffer: 4 * 1024 * 1024 });
    if (!show.ok) return null;
    const all = show.stdout.replace(/\n$/, '').split('\n');
    const n = Math.max(1, Math.min(all.length, Number(line) || 1));
    const from = Math.max(1, n - 20), to = Math.min(all.length, n + 20);
    return { file: r, line: n, from, to, text: all.slice(from - 1, to).join('\n') };
  }

  // Review cartridges re-check the target before every run: PRs are fetched again, local branches are shared refs.
  async refreshReview({ fetch = true } = {}) {
    if (this.kind !== 'review') return;
    if (this.rec.pr && fetch) {
      const shallow = (await this.project.git('rev-parse', '--is-shallow-repository')).stdout.trim() === 'true';
      const f = await this.project.git('fetch', ...(shallow ? ['--depth=200'] : []), 'origin', `+pull/${this.rec.pr}/head:refs/remotes/origin/pr/${this.rec.pr}`);
      if (!f.ok) throw new Error('git fetch failed: ' + firstLine(f.stderr));
    }
    const c = await run('git', ['-C', this.dir, 'checkout', '--quiet', '--detach', this.rec.target]);
    if (!c.ok) throw new Error('Could not update the review checkout: ' + firstLine(c.stderr));
    const target = this.rec.targetCart && this.reg.find(this.rec.targetCart);
    if (target) {
      for (const f of ['00-spec.md', 'final-plan.md']) {
        const src = path.join(target.dir, 'plans', f);
        if (await statSafe(src)) {
          await fsp.mkdir(path.join(this.dir, 'plans', 'context'), { recursive: true });
          await fsp.copyFile(src, path.join(this.dir, 'plans', 'context', f));
        }
      }
    }
  }

  // ---------- Notebook, git, PR ----------
  async plans() {
    const out = [];
    const walk = async (dir, depth) => {
      if (depth > 4) return;
      let ents = [];
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p, depth + 1);
        else if (/\.(md|txt|json)$/i.test(e.name)) { const st = await statSafe(p); out.push({ path: path.relative(this.dir, p), mtime: st ? st.mtimeMs : 0 }); }
      }
    };
    await walk(path.join(this.dir, 'plans'), 0);
    const cm = await statSafe(path.join(this.dir, 'CLAUDE.md'));
    if (cm) out.push({ path: 'CLAUDE.md', mtime: cm.mtimeMs });
    return out.sort((a, b) => b.mtime - a.mtime);
  }
  // Only plans/ and CLAUDE.md are readable from the UI; symlinks may not lead elsewhere
  fileFor(rel) {
    const abs = path.resolve(this.dir, String(rel || ''));
    if (abs === path.join(this.dir, 'CLAUDE.md') || abs === this.setupLog || abs === this.commitLog) return abs;
    const plans = path.join(this.dir, 'plans');
    if (!inside(plans, abs) || abs === plans) return null;
    return inside(realpath(plans), realpath(abs)) ? abs : null;
  }
  async gitInfo() {
    const g = (...a) => run('git', ['-C', this.dir, ...a]);
    const s = await g('status', '--short', '--branch');
    if (!s.ok) return { repo: false, error: firstLine(s.stderr) };
    const range = this.kind === 'team' && !this.home && this.rec.base ? `${this.rec.base}..HEAD` : null;
    const [log, diff, ahead] = await Promise.all([
      g('log', '--oneline', '--decorate', '-20', ...(range ? [range] : [])), g('diff', '--stat'),
      range ? g('rev-list', '--count', range) : Promise.resolve(null),
    ]);
    return {
      repo: true, status: s.stdout, log: log.stdout, diff: diff.stdout, branch: this.rec.branch || null,
      base: range ? this.rec.base : null, ahead: ahead && ahead.ok ? Number(ahead.stdout.trim()) : null,
    };
  }
  async prDraft() {
    // The lead writes plans/pr.md at review time: "# title", then the filled-in body
    let written = '';
    try { written = (await fsp.readFile(path.join(this.dir, 'plans', 'pr.md'), 'utf8')).trim(); } catch {}
    const head = written.match(/^#\s+(.+)\n+([\s\S]*)$/);
    let template = '';
    for (const f of ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md']) {
      try { template = await fsp.readFile(path.join(this.dir, f), 'utf8'); break; } catch {}
    }
    const info = await this.gitInfo();
    return {
      branch: this.rec.branch, base: String(this.rec.base || 'main').replace(/^origin\//, ''), ahead: info.ahead,
      dirty: !!(info.status || '').split('\n').slice(1).some(l => l && !l.startsWith('??')),
      title: (head ? head[1].trim() : this.rec.issue ? this.title.replace(/^#\d+\s+/, '') : this.title).slice(0, 120),
      body: [head ? head[2].trim() : [this.rec.issue ? `Closes #${this.rec.issue}` : '', template.trim()].filter(Boolean).join('\n\n'), this.reg.config.prFooter]
        .filter(Boolean).join('\n\n'),
      written: !!head,
      prUrl: this.rec.prUrl || null,
    };
  }
  // Only committed work goes up: a commit has been through the repo's pre-commit checks, loose changes have not
  async mustBeCommitted() {
    const loose = ((await this.gitInfo()).status || '').split('\n').slice(1).filter(Boolean);
    if (loose.length) throw new Error(`Not committed yet, so not through the pre-commit checks: ${loose.slice(0, 5).map(l => l.slice(3)).join(', ')}${loose.length > 5 ? '…' : ''}. Commit or remove them first.`);
  }
  // New commits for a PR that is already open (after addressing review comments)
  async pushPr() {
    if (!this.rec.prUrl) throw new Error('This cartridge has no pull request yet');
    await this.mustBeCommitted();
    await GH.pushBranch(this.dir, this.rec.branch);
    this.log('push', this.rec.branch);
    this.save();
    return { url: this.rec.prUrl };
  }
  // A review of a PR whose lead fixed things on the PR's own branch: what a push would send, for the confirm sheet.
  // Only to that branch in this repository, never forced.
  async reviewPush() {
    if (this.kind !== 'review' || !this.rec.pr) throw new Error('Only the review of a pull request pushes this way');
    const pr = await GH.prHead(this.dir, this.rec.pr);
    if (pr.fork) throw new Error('The pull request comes from a fork; push from a clone of the fork');
    if (pr.state && pr.state !== 'OPEN') throw new Error(`The pull request is ${pr.state.toLowerCase()}`);
    const g = (...a) => run('git', ['-C', this.dir, ...a], { timeout: 60000 });
    const on = (await g('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
    if (!pr.branch || on !== pr.branch) {
      throw new Error(`The worktree is on ${on === 'HEAD' || !on ? 'a detached checkout' : on}, not the PR branch ${pr.branch}, so the lead has no commits there to push`);
    }
    // Against the branch as GitHub has it now; when it is not there, against everything any remote has
    const f = await g('fetch', '-q', 'origin', pr.branch);
    const theirs = f.ok ? ['FETCH_HEAD..HEAD'] : ['HEAD', '--not', '--remotes'];
    const [ahead, behind, log] = await Promise.all([g('rev-list', '--count', ...theirs), f.ok ? g('rev-list', '--count', 'HEAD..FETCH_HEAD') : null,
      g('log', '--oneline', '-10', ...theirs)]);
    return { url: pr.url, branch: pr.branch, author: pr.author, ahead: Number(ahead.stdout.trim()) || 0, behind: behind ? Number(behind.stdout.trim()) || 0 : 0,
      commits: log.stdout.trim().split('\n').filter(Boolean) };
  }
  async pushReview() {
    const p = await this.reviewPush();
    if (!p.ahead) throw new Error('Nothing to push: the PR branch already has every commit');
    if (p.behind) throw new Error(`The PR branch has ${p.behind} commit${p.behind === 1 ? '' : 's'} this worktree lacks; ask the lead to merge origin/${p.branch} first`);
    await this.mustBeCommitted();
    const r = await run('git', ['-C', this.dir, 'push', 'origin', `HEAD:refs/heads/${p.branch}`], { timeout: 120000 }); // hooks run: no --no-verify
    if (!r.ok) throw new Error('git push failed: ' + firstLine(r.stderr));
    this.log('push', `${p.branch} (${p.ahead})`);
    this.save();
    return { url: p.url, branch: p.branch, pushed: p.ahead };
  }
  async openPr({ title, body, base, draft }) {
    if (this.kind !== 'team' || this.home || !this.rec.branch) throw new Error('Only work cartridges with their own branch can open a PR');
    if (!String(title || '').trim()) throw new Error('Write a PR title');
    await this.mustBeCommitted();
    const out = await GH.openPr(this.dir, { branch: this.rec.branch, base: String(base || '').trim(), title: String(title).trim(), body: String(body || ''), draft: !!draft });
    this.reg.updateRecord(this, { prUrl: out.url });
    this.log('pr', out.url);
    this.save();
    return out;
  }
  async archivePlans() {
    const src = path.join(this.dir, 'plans');
    let files = [];
    try { files = await fsp.readdir(src); } catch {}
    if (!files.length) return null;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const dest = path.join(this.project.uiDir, 'archive', `${this.reg.localName(this.project, this.id)}-${stamp}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.cp(src, dest, { recursive: true });
    return dest;
  }
}

class Registry {
  constructor({ config, prefix, claudeBin, usageFile, laneDir }) {
    this.config = config;
    this.prefix = prefix;
    this.claudeBin = claudeBin;
    this.usageFile = usageFile;
    this.lane = new Lane(laneDir || path.join(os.tmpdir(), 'claude-team-ui-lane'));
    this.states = new Map();
  }
  // What every heavy command of a cartridge runs with (D63): turbo at buildConcurrency tasks (0 leaves turbo's default)
  buildEnv() {
    const n = Number(this.config.data.buildConcurrency);
    return n > 0 ? { TURBO_CONCURRENCY: String(Math.floor(n)) } : {};
  }
  projects() { return this.config.projects.map(p => new Project(p)); }
  project(id) {
    const p = this.projects().find(x => x.id === id);
    if (!p) throw new Error('Unknown project. Add it under Projects first.');
    return p;
  }
  cartridges() {
    const out = [];
    for (const p of this.projects()) for (const r of p.records()) out.push(new Cartridge(this, p, r));
    return out;
  }
  find(id) { return this.cartridges().find(c => c.id === id) || null; }
  get(id) {
    const sid = String(id || '');
    if (!/^[a-z0-9-]{1,64}$/.test(sid)) throw new Error('Invalid cartridge id');
    const c = this.find(sid);
    if (!c) throw new Error('No such cartridge');
    return c;
  }
  uniqueId(base) {
    const used = new Set(this.cartridges().map(c => c.id));
    let id = base.slice(0, 60).replace(/-+$/, '') || 'cart';
    while (used.has(id)) id = `${id.slice(0, 55)}-${crypto.randomBytes(2).toString('hex')}`;
    return id;
  }
  localName(project, id) { return id.startsWith(project.id + '-') ? id.slice(project.id.length + 1) : id; }
  addRecord(project, rec) {
    project.saveRecords([...project.records(), rec]);
    return new Cartridge(this, project, rec);
  }
  updateRecord(cart, patch) {
    const list = cart.project.records();
    const r = list.find(x => x.id === cart.id);
    if (r) { Object.assign(r, patch); cart.project.saveRecords(list); Object.assign(cart.rec, patch); }
  }

  async addWork(project, { issue = null, title, body = '', url = null, branch = '', base = '', fetch = false, flow = 'full' }) {
    if (!(await project.isRepo())) throw new Error(`${project.path} is not a git repository.`);
    title = String(title || '').trim().slice(0, 120);
    if (!title) throw new Error('Write a name for the task');
    if (issue && this.cartridges().some(c => c.project.id === project.id && c.rec.issue === issue && c.kind === 'team' && !c.home)) {
      throw new Error(`Issue #${issue} already has a cartridge`);
    }
    branch = String(branch || '').trim() || `issue/${issue ? issue + '-' : ''}${slugify(title)}`;
    if (!(await run('git', ['check-ref-format', '--branch', branch])).ok) throw new Error(`Not a valid branch name: ${branch}`);
    base = String(base || '').trim() || await project.defaultBase();
    if (fetch && base.startsWith('origin/')) {
      const f = await project.git('fetch', 'origin', base.slice(7));
      if (!f.ok) throw new Error('git fetch failed: ' + firstLine(f.stderr));
    }
    const id = this.uniqueId(`${project.id}-${issue ? issue + '-' : ''}${slugify(title, 32)}`);
    const dir = path.join(project.path, '.claude', 'worktrees', this.localName(project, id));
    await project.excludeLocal();
    const exists = (await project.git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)).ok;
    const r = exists ? await project.git('worktree', 'add', dir, branch) : await project.git('worktree', 'add', '-b', branch, dir, base);
    if (!r.ok) throw new Error('git worktree add failed: ' + firstLine(r.stderr));
    const cart = this.addRecord(project, {
      id, kind: 'team', flow: FLOWS.includes(flow) ? flow : 'full', title: issue ? `#${issue} ${title}` : title, issue, url, branch, base,
      dir: realpath(dir), createdAt: Date.now(),
    });
    cart.state().request = [issue ? `Issue #${issue}: ${title}` : title, url || '', body ? '\n' + String(body).trim() : ''].filter(Boolean).join('\n').slice(0, 20000);
    await cart.prepare();
    cart.log('add', cart.title);
    cart.save();
    cart.runSetup().catch(() => {}); // a fresh worktree has no node_modules or build output
    return cart;
  }
  // Work directly in the main checkout, on whatever branch it has checked out
  async addHome(project, { flow = 'full' } = {}) {
    if (this.cartridges().some(c => c.project.id === project.id && c.home)) throw new Error('This project already has a main-checkout cartridge');
    const cart = this.addRecord(project, {
      id: this.uniqueId(project.id), kind: 'team', flow: FLOWS.includes(flow) ? flow : 'full', home: true,
      title: `${project.name} (main checkout)`, dir: project.path, createdAt: Date.now(),
    });
    await cart.prepare();
    cart.log('add', cart.title);
    cart.save();
    return cart;
  }
  // Review in a detached worktree, so the team working on the branch is never touched
  async addReview(project, { target, pr }) {
    if (!(await project.isRepo())) throw new Error(`${project.path} is not a git repository.`);
    let rec;
    if (pr) {
      const j = await GH.prView(project.path, pr);
      const ref = `refs/remotes/origin/pr/${pr}`;
      const shallow = (await project.git('rev-parse', '--is-shallow-repository')).stdout.trim() === 'true';
      const f = await project.git('fetch', ...(shallow ? ['--depth=200'] : []), 'origin', `+pull/${pr}/head:${ref}`);
      if (!f.ok) throw new Error('git fetch failed: ' + firstLine(f.stderr));
      rec = { title: `Review PR #${pr} ${j.title}`, target: `origin/pr/${pr}`, base: `origin/${j.baseRefName || 'main'}`, pr, url: j.url, slug: `pr-${pr}` };
    } else {
      const t = this.get(target);
      if (t.project.id !== project.id || !t.rec.branch) throw new Error('Pick a cartridge with its own branch in this project');
      rec = { title: `Review ${t.title}`, target: t.rec.branch, base: t.rec.base || await project.defaultBase(), targetCart: t.id, slug: this.localName(project, t.id) };
    }
    const id = this.uniqueId(`${project.id}-review-${slugify(rec.slug, 40)}`);
    const dir = path.join(project.path, '.claude', 'worktrees', this.localName(project, id));
    await project.excludeLocal();
    const r = await project.git('worktree', 'add', '--detach', dir, rec.target);
    if (!r.ok) throw new Error('git worktree add failed: ' + firstLine(r.stderr));
    const cart = this.addRecord(project, {
      id, kind: 'review', title: rec.title, target: rec.target, base: rec.base, pr: rec.pr || null, url: rec.url || null,
      targetCart: rec.targetCart || null, branch: null, dir: realpath(dir), createdAt: Date.now(),
    });
    cart.state().request = `${rec.title}\nBranch to review: ${rec.target}\nCompared with: ${rec.base}${rec.url ? '\n' + rec.url : ''}`;
    await cart.prepare();
    await cart.refreshReview({ fetch: false }).catch(() => {});
    cart.log('add', cart.title);
    cart.save();
    cart.runSetup().catch(() => {});
    return cart;
  }
  // Research runs in a plain folder outside git; only plans/ is writable
  async addResearch(project, { question, title }) {
    const q = String(question || '').trim();
    if (!q) throw new Error('Write the research question');
    const name = String(title || '').trim() || q.split('\n')[0].slice(0, 60);
    const id = this.uniqueId(`${project.id}-research-${slugify(name, 36)}`);
    const dir = path.join(project.path, '.claude', 'research', this.localName(project, id));
    await fsp.mkdir(path.join(dir, 'plans'), { recursive: true });
    await fsp.copyFile(path.join(APP_DIR, 'templates', 'CLAUDE-research.md'), path.join(dir, 'CLAUDE.md'));
    const cart = this.addRecord(project, { id, kind: 'research', title: `Research: ${name}`, branch: null, dir: realpath(dir), createdAt: Date.now() });
    cart.state().request = q.slice(0, 20000);
    await cart.prepare();
    cart.log('add', cart.title);
    cart.save();
    return cart;
  }

  // Ejecting never deletes branches, research reports or the notebook (it is archived first). What went is noted in
  // the project's ejected.json, so Tidy up can offer the branch once its pull request is merged.
  async remove(cart) {
    let archived = null, bytes = 0;
    if (!cart.home && cart.kind !== 'research') {
      const dirty = await run('git', ['-C', cart.dir, 'status', '--porcelain', '--untracked-files=no']);
      if (dirty.ok && dirty.stdout.trim()) {
        throw new Error(`The cartridge has uncommitted changes. Ask the lead to commit them, or handle them in ${cart.dir}`);
      }
      bytes = await folderSize(cart.dir); // what the eject frees, for Tidy up
    }
    if (await cart.running()) await cart.stop(true);
    cart.killSetup();
    if (!cart.home && cart.kind !== 'research') {
      archived = await cart.archivePlans();
      const r = await cart.project.git('worktree', 'remove', '--force', cart.dir); // --force only drops untracked files (plans/, .claude/)
      if (!r.ok && (await statSafe(cart.dir))) throw new Error('Could not remove the worktree: ' + firstLine(r.stderr));
    }
    cart.project.saveRecords(cart.project.records().filter(r => r.id !== cart.id));
    this.states.delete(cart.id);
    if (!cart.home) {
      const f = path.join(cart.project.uiDir, 'ejected.json');
      const list = (readJSONSync(f) || []).filter(e => e && e.id);
      list.unshift({ id: cart.id, title: cart.title, kind: cart.kind, branch: cart.rec.branch || null, base: cart.rec.base || null, pr: cart.rec.pr || null, prUrl: cart.rec.prUrl || null, ejectedAt: Date.now(), archive: archived });
      writeJSONSync(f, list.slice(0, 200));
    }
    return { branch: cart.rec.branch || null, base: cart.rec.base || null, kept: cart.home || cart.kind === 'research' ? cart.dir : null, archived, freed: bytes };
  }

  // Copies a review/research report into another cartridge's notebook and tells its lead if it is running
  async forward(from, to) {
    if (from.id === to.id) throw new Error('Pick another cartridge');
    const gate = from.phases.find(p => p.kind === 'gate' && p.forward);
    if (!gate) throw new Error('This cartridge has no report to send');
    const src = path.join(from.dir, gate.file);
    if (!(await statSafe(src))) throw new Error(`${gate.file} does not exist yet`);
    const rel = `plans/from-${from.id}.md`;
    await fsp.mkdir(path.join(to.dir, 'plans'), { recursive: true });
    await fsp.copyFile(src, path.join(to.dir, rel));
    let sent = false;
    if (await to.running()) {
      const text = `There is a new report from "${from.title}" at ${rel}. Read it and weigh it for the current work. `
        + 'If it means changing the plan, propose the change to me first instead of changing it yourself.';
      to.noteSent('console', 'Report received', text);
      await T.sendText(await to.paneFor(null), text);
      sent = true;
    }
    to.log('receive', `${rel} from ${from.id}`);
    to.save();
    return { path: rel, sent };
  }
}

module.exports = { doneMarker, countDone, sentKey, parseSummary, PHASES, FLOWS, PERMISSION_MODES, TEMPLATE_NAMES, Project, Cartridge, Registry, APP_DIR, cleanTargets };

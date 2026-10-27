'use strict';
// Projects (git repositories) and cartridges. A cartridge is one piece of work with its own folder
// (a git worktree, the main checkout, or a research folder), tmux session, workflow state and notebook (plans/).
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { run, firstLine, sleep, readJSONSync, writeJSONSync, statSafe, shq, slugify, realpath, inside, API_VARS, SESSION_VARS } = require('./util');
const T = require('./tmux');
const GH = require('./github');
const { detectScreen } = require('./claude');
const { MODEL_RE } = require('./config');

const APP_DIR = path.join(__dirname, '..');
const GUARD = path.join(APP_DIR, 'hooks', 'guard.mjs');
const STATUSLINE = path.join(APP_DIR, 'hooks', 'statusline.mjs');
const PERMISSION_MODES = ['auto', 'manual', 'acceptEdits', 'plan', 'dontAsk'];
const EXCLUDES = ['/.claude/worktrees/', '/.claude/research/', '/.claude/team-ui/', '/.claude/settings.local.json', '/plans/'];
const TEMPLATE_NAMES = ['_rules.md', '_checks.md'];

// Work cartridges run the quick or the full flow; review and research cartridges have their own
const PHASES = {
  quick: [
    { id: 'q-plan', kind: 'agent', title: 'Spec + plan', mode: 'planning', prompt: '30-quick-plan.md', desc: 'The lead alone writes a one-page plan → plans/plan.md' },
    { id: 'q-gate-plan', kind: 'gate', title: 'You review the plan', file: 'plans/plan.md' },
    { id: 'q-build', kind: 'agent', title: 'Build', mode: 'code', prompt: '31-quick-build.md', desc: 'One developer, tests pass before each commit' },
    { id: 'q-review', kind: 'agent', title: 'Review', mode: 'code', prompt: '32-quick-review.md', desc: 'One read-only reviewer → plans/review.md', rejectTo: 'q-build' },
    { id: 'q-gate-merge', kind: 'gate', title: 'You approve the merge', file: 'plans/review.md', pr: true, rejectTo: 'q-build' },
  ],
  standard: [
    { id: 's-plan', kind: 'agent', title: 'Spec + plan', mode: 'planning', prompt: '40-standard-plan.md', desc: 'A planner writes, a critic challenges once → plans/plan.md' },
    { id: 's-gate-plan', kind: 'gate', title: 'You review the plan', file: 'plans/plan.md' },
    { id: 's-build', kind: 'agent', title: 'Build', mode: 'code', prompt: '41-standard-build.md', desc: 'Up to two developers: code, tests, docs and skills' },
    { id: 's-simplify', kind: 'agent', title: 'Simplify', mode: 'code', prompt: '04-simplify.md', desc: 'Clean up the diff without changing behaviour' },
    { id: 's-review', kind: 'agent', title: 'Review', mode: 'code', prompt: '42-standard-review.md', desc: 'Two reviewers cover logic, security, tests, docs, skills → plans/review.md', rejectTo: 's-build' },
    { id: 's-gate-merge', kind: 'gate', title: 'You approve the merge', file: 'plans/review.md', pr: true, rejectTo: 's-build' },
  ],
  full: [
    { id: 'spec', kind: 'agent', title: 'Spec', mode: 'planning', prompt: '00-spec.md', desc: 'What and why, with acceptance criteria → plans/00-spec.md' },
    { id: 'gate-spec', kind: 'gate', title: 'You review the spec', file: 'plans/00-spec.md' },
    { id: 'planning', kind: 'agent', title: 'Plan', mode: 'planning', prompt: '01-planning.md', desc: 'Scout, two planners, critic and simplifier, cross-review → plans/final-plan.md' },
    { id: 'gate-plan', kind: 'gate', title: 'You review the plan', file: 'plans/final-plan.md' },
    { id: 'split', kind: 'agent', title: 'Split into tasks', mode: 'planning', prompt: '02-split-tasks.md', desc: 'Self-contained task files → plans/tasks/' },
    { id: 'code', kind: 'agent', title: 'Build', mode: 'code', prompt: '03-code.md', desc: 'One task at a time: fresh context, tests pass, one commit' },
    { id: 'simplify', kind: 'agent', title: 'Simplify', mode: 'code', prompt: '04-simplify.md', desc: 'Clean up the diff without changing behaviour' },
    { id: 'review', kind: 'agent', title: 'Review + QA', mode: 'code', prompt: '05-review-qa.md', desc: 'Reviewers report, nobody fixes → plans/review.md', rejectTo: 'code' },
    { id: 'gate-merge', kind: 'gate', title: 'You approve the merge', file: 'plans/review.md', pr: true, rejectTo: 'code' },
    { id: 'retro', kind: 'agent', title: 'Retro', mode: 'planning', prompt: '06-retro.md', desc: 'Lessons, CLAUDE.md suggestions, archive the notebook' },
  ],
  review: [
    { id: 'review-run', kind: 'agent', title: 'Review', mode: 'planning', prompt: '10-review.md', desc: 'Read-only review with cross-checking → plans/review-report.md' },
    { id: 'gate-review', kind: 'gate', title: 'You read the review', file: 'plans/review-report.md', forward: true },
  ],
  research: [
    { id: 'research-run', kind: 'agent', title: 'Research', mode: 'planning', prompt: '20-research.md', desc: 'Several angles, sources checked → plans/report.md' },
    { id: 'gate-research', kind: 'gate', title: 'You read the report', file: 'plans/report.md', forward: true },
  ],
};
// The line each phase prompt asks the lead to start its final reply with; seeing it ends the phase
const DONE_MARKERS = {
  '00-spec.md': 'SPEC DONE', '01-planning.md': 'PLAN DONE', '02-split-tasks.md': 'TASKS DONE', '03-code.md': 'BUILD DONE',
  '04-simplify.md': 'SIMPLIFY DONE', '05-review-qa.md': 'REVIEW DONE', '06-retro.md': 'RETRO DONE', '10-review.md': 'REVIEW DONE',
  '20-research.md': 'RESEARCH DONE', '30-quick-plan.md': 'PLAN DONE', '31-quick-build.md': 'BUILD DONE', '32-quick-review.md': 'REVIEW DONE',
  '40-standard-plan.md': 'PLAN DONE', '41-standard-build.md': 'BUILD DONE', '42-standard-review.md': 'REVIEW DONE',
};
const doneMarker = phase => (phase && phase.kind === 'agent' ? DONE_MARKERS[phase.prompt] || null : null);
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
  summary() { return { id: this.id, name: this.name, path: this.path, testCommand: this.testCommand, node: this.node }; }
}

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
      s.phases = { ...freshPhases(this.phases), ...(raw.phases || {}) };
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
    cur.env = { ...(cur.env || {}), CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' };
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
    const env = { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', CTU_CART: this.id };
    for (const k of ['CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'LANG']) if (process.env[k]) env[k] = process.env[k];
    // tmux gives a pane the client's PATH and ignores -e PATH, so the project's Node goes first inside the shell;
    // teammate panes split from the lead inherit it
    const nodeBin = this.project.nodeBin();
    const nodePath = nodeBin ? `export PATH=${shq(nodeBin)}:"$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0; ` : '';
    const shell = `unset ${[...API_VARS, ...SESSION_VARS].join(' ')}; export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 CTU_CART=${shq(this.id)}; ${nodePath}${cmd}; `
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
  async renderPrompt(phase) {
    const strip = t => t.replace(/^<!--[\s\S]*?-->\s*/, '').trim();
    const m = this.reg.config.models;
    const vars = {
      REQUEST: this.state().request || '(no task written yet)', PROJECT: this.project.name,
      BRANCH: this.rec.branch || 'the current branch', TARGET: this.rec.target || '', BASE: this.rec.base || 'main',
      PR: this.rec.pr ? String(this.rec.pr) : '', STRONG: m.strong, FAST: m.fast,
      TEST: this.project.testCommand ? `\`${this.project.testCommand}\`` : 'the test command documented in CLAUDE.md or the README',
    };
    const base = this.rec.base || 'main';
    vars.SCOPE = this.rec.pr
      ? `\`gh pr diff ${this.rec.pr}\` (the local clone may be shallow; \`git diff ${base}...HEAD\` also works when the history allows).`
      : `\`git diff ${base}...HEAD\`, and \`git log ${base}..HEAD\` for the individual commits.`;
    const fill = t => t.replace(/\{\{(\w+)\}\}/g, (all, k) => (vars[k] != null ? vars[k] : all));
    vars.RULES = fill(strip((await this.template('_rules.md')).text));
    vars.CHECKS = fill(strip((await this.template('_checks.md')).text));
    return fill(strip((await this.template(phase.prompt)).text));
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
    if (abs === path.join(this.dir, 'CLAUDE.md')) return abs;
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
    let template = '';
    for (const f of ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md']) {
      try { template = await fsp.readFile(path.join(this.dir, f), 'utf8'); break; } catch {}
    }
    const info = await this.gitInfo();
    return {
      branch: this.rec.branch, base: String(this.rec.base || 'main').replace(/^origin\//, ''), ahead: info.ahead,
      dirty: !!(info.status || '').split('\n').slice(1).some(l => l && !l.startsWith('??')),
      title: (this.rec.issue ? this.title.replace(/^#\d+\s+/, '') : this.title).slice(0, 120),
      body: [this.rec.issue ? `Closes #${this.rec.issue}` : '', template.trim()].filter(Boolean).join('\n\n'),
      prUrl: this.rec.prUrl || null,
    };
  }
  async openPr({ title, body, base, draft }) {
    if (this.kind !== 'team' || this.home || !this.rec.branch) throw new Error('Only work cartridges with their own branch can open a PR');
    if (!String(title || '').trim()) throw new Error('Write a PR title');
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
  constructor({ config, prefix, claudeBin, usageFile }) {
    this.config = config;
    this.prefix = prefix;
    this.claudeBin = claudeBin;
    this.usageFile = usageFile;
    this.states = new Map();
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

  // Ejecting never deletes branches, research reports or the notebook (it is archived first).
  async remove(cart) {
    let archived = null;
    if (!cart.home && cart.kind !== 'research') {
      const dirty = await run('git', ['-C', cart.dir, 'status', '--porcelain', '--untracked-files=no']);
      if (dirty.ok && dirty.stdout.trim()) {
        throw new Error(`The cartridge has uncommitted changes. Ask the lead to commit them, or handle them in ${cart.dir}`);
      }
    }
    if (await cart.running()) await cart.stop(true);
    if (!cart.home && cart.kind !== 'research') {
      archived = await cart.archivePlans();
      const r = await cart.project.git('worktree', 'remove', '--force', cart.dir); // --force only drops untracked files (plans/, .claude/)
      if (!r.ok && (await statSafe(cart.dir))) throw new Error('Could not remove the worktree: ' + firstLine(r.stderr));
    }
    cart.project.saveRecords(cart.project.records().filter(r => r.id !== cart.id));
    this.states.delete(cart.id);
    return { branch: cart.rec.branch || null, kept: cart.home || cart.kind === 'research' ? cart.dir : null, archived };
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
      await T.sendText(await to.paneFor(null), `There is a new report from "${from.title}" at ${rel}. Read it and weigh it for the current work. `
        + 'If it means changing the plan, propose the change to me first instead of changing it yourself.');
      sent = true;
    }
    to.log('receive', `${rel} from ${from.id}`);
    to.save();
    return { path: rel, sent };
  }
}

module.exports = { doneMarker, countDone, PHASES, FLOWS, PERMISSION_MODES, TEMPLATE_NAMES, Project, Cartridge, Registry, APP_DIR };

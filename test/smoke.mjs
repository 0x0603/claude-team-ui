#!/usr/bin/env node
// End-to-end test with fake claude/gh (test/fakes). Calls no model and needs no network.
// Needs node >= 18, tmux and git. Run: npm test
// Only creates and removes tmux sessions with this run's own prefix.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctu-smoke-')));
const REMOTE = path.join(TMP, 'remote.git');
const PROJ = path.join(TMP, 'app');
const PROJ2 = path.join(TMP, 'tool');
const HOME_CLAUDE = path.join(TMP, 'claude-home');
const CONFIG = path.join(TMP, 'config');
const GH_LOG = path.join(TMP, 'gh.log');
const GUARD = path.join(ROOT, 'hooks', 'guard.mjs');
const SESSION = `ctu-smoke-${process.pid}`;
const PORT = 7900 + (process.pid % 90);
const TOKEN = 'smoke-token-123';
const B = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GIT = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
const git = (cwd, ...a) => execFileSync('git', [...GIT, ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const readJSON = f => JSON.parse(fs.readFileSync(f, 'utf8'));

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, typeof extra === 'string' ? extra : JSON.stringify(extra)); }
}

// ---- Two projects: "app" has an origin with a fork-style PR ref, "tool" has no remote ----
fs.mkdirSync(HOME_CLAUDE, { recursive: true });
git(TMP, 'init', '-q', '--bare', REMOTE);
fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true });
fs.mkdirSync(path.join(PROJ, 'tests'), { recursive: true });
fs.writeFileSync(path.join(PROJ, 'package.json'), '{"scripts":{"test":"echo ok"}}\n');
fs.writeFileSync(path.join(PROJ, 'src/a.js'), 'console.log(1)\n');
fs.writeFileSync(path.join(PROJ, 'tests/t.js'), 'x\n');
fs.mkdirSync(path.join(PROJ, '.github'));
fs.writeFileSync(path.join(PROJ, '.github/pull_request_template.md'), '## Summary\n\n## Testing\n');
git(PROJ, 'init', '-q');
git(PROJ, 'add', '-A');
git(PROJ, 'commit', '-qm', 'init');
git(PROJ, 'remote', 'add', 'origin', REMOTE);
git(PROJ, 'push', '-q', '-u', 'origin', 'main');
git(PROJ, 'checkout', '-q', '-b', 'feature-x');
fs.writeFileSync(path.join(PROJ, 'src/x.js'), 'export const x = 1;\n');
git(PROJ, 'add', '-A');
git(PROJ, 'commit', '-qm', 'feature x');
const PR_SHA = git(PROJ, 'rev-parse', 'HEAD');
git(PROJ, 'push', '-q', 'origin', 'feature-x');
git(REMOTE, 'update-ref', 'refs/pull/7/head', PR_SHA);
git(REMOTE, 'branch', '-q', '-D', 'feature-x'); // the head branch lives in a fork: only refs/pull/7/head exists
git(PROJ, 'checkout', '-q', 'main');
git(PROJ, 'branch', '-q', '-D', 'feature-x');
git(PROJ, 'fetch', '-q', '--prune', 'origin');
fs.mkdirSync(PROJ2);
fs.writeFileSync(path.join(PROJ2, 'README.md'), '# tool\n');
git(PROJ2, 'init', '-q');
git(PROJ2, 'add', '-A');
git(PROJ2, 'commit', '-qm', 'init');
fs.mkdirSync(path.join(TMP, 'scan', 'extra-repo'), { recursive: true });
git(path.join(TMP, 'scan', 'extra-repo'), 'init', '-q');
const NVM = path.join(TMP, 'nvm');
fs.mkdirSync(path.join(NVM, 'versions/node/v24.9.9/bin'), { recursive: true });
fs.writeFileSync(path.join(NVM, 'versions/node/v24.9.9/bin/node'), '#!/bin/sh\necho v24.9.9\n', { mode: 0o755 });

const env = {
  ...process.env, PATH: `${path.join(ROOT, 'test/fakes')}:${process.env.PATH}`, CLAUDE_HOME: HOME_CLAUDE, TEAM_UI_TOKEN: TOKEN,
  TEAM_UI_SESSION: SESSION, TEAM_UI_CONFIG_DIR: CONFIG, FAKE_GH_LOG: GH_LOG, ANTHROPIC_API_KEY: 'sk-must-be-dropped', NVM_DIR: NVM,
};
delete env.NTFY_URL;
const srv = spawn('node', [path.join(ROOT, 'server.js'), '--project', PROJ, '--project', PROJ2, '--port', String(PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvOut = '';
srv.stdout.on('data', d => (srvOut += d));
srv.stderr.on('data', d => (srvOut += d));

let cookie = '';
async function api(p, body) {
  const opt = body === undefined ? { headers: { cookie } }
    : { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', 'X-CTU': '1' }, body: JSON.stringify(body) };
  const r = await fetch(B + '/api/' + p, opt);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function waitFor(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(300); } return false; }
const cartOf = async id => (await api('overview')).body.cartridges.find(c => c.id === id);
const state = async id => (await api(`state?cart=${id}`)).body;
const paneText = async (id, pane = '') => (await api(`pane?cart=${id}&id=${encodeURIComponent(pane)}`)).body.text || '';
function guard(cartDir, input, extraEnv = { CTU_CART: 'x' }) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: cartDir, ...extraEnv };
  if (!extraEnv.CTU_CART) delete e.CTU_CART;
  return spawnSync('node', [GUARD], { input: JSON.stringify({ cwd: cartDir, ...input }), env: e, encoding: 'utf8' }).status;
}

async function main() {
  ok(await waitFor(async () => { try { await fetch(B); return true; } catch { return false; } }), 'server starts', srvOut);

  console.log('Security');
  ok((await api('overview')).status === 401, 'not logged in → 401');
  const login = await fetch(`${B}/?token=${TOKEN}`, { redirect: 'manual' });
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  ok(cookie.startsWith('ctu='), 'token login sets the cookie');
  const csrf = await fetch(B + '/api/settings', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
  ok(csrf.status === 403, 'POST without the X-CTU header → 403');

  console.log('Projects');
  let ov = (await api('overview')).body;
  ok(ov.projects.length === 2 && ov.projects[0].id === 'app' && ov.projects[1].id === 'tool', 'both --project folders registered', ov.projects);
  ok((await api('project-add', { path: 'relative/dir' })).status === 400, 'project path must be absolute');
  ok((await api('project-add', { path: path.join(TMP, 'missing') })).status === 400, 'project folder must exist');
  await api('settings', { scanRoots: [TMP] });
  const sug = (await api('suggest')).body.paths;
  ok(sug.includes(path.join(TMP, 'scan', 'extra-repo')) && !sug.includes(PROJ), 'suggests unregistered repos under scan roots', sug);

  console.log('Cartridges');
  const iss = (await api('issues?project=app')).body;
  ok(iss.ok && iss.issues.length === 3, 'issues come from gh');
  const add = await api('cart-add', { project: 'app', issues: [12, 15] });
  const [A, Bc] = (add.body.made || []).map(m => m.id);
  ok(A === 'app-12-google-sign-in-for-the-admin' && Bc, 'two cartridges from issues, ids carry the project', add.body);
  const sA = await state(A);
  ok(sA.cart.branch === 'issue/12-google-sign-in-for-the-admin-page' && sA.cart.base === 'origin/main', 'branch from the issue, base is origin/main', sA.cart);
  ok(sA.request.startsWith('Issue #12') && sA.request.includes('Details of issue 12'), 'task text comes from the issue');
  ok(!sA.running, 'adding a cartridge does not start it');
  ok((await api('cart-add', { project: 'app', issues: [12] })).status === 500, 'the same issue cannot get two cartridges');
  const draft = (await api('draft-issue', { text: 'report page is slow' })).body;
  ok(draft.ok && draft.title === 'Speed up the report page and add CSV export', 'issue draft read from structured_output', draft);
  const created = (await api('cart-add', { project: 'app', title: 'Speed up reports', body: 'x', createIssue: true })).body;
  ok(created.made && created.made[0].id.startsWith('app-21-'), 'creates the GitHub issue, then the cartridge', created);
  const custom = (await api('cart-add', { project: 'tool', title: 'Clean logs', branch: 'feat/clean-logs' })).body;
  const M = custom.made && custom.made[0].id;
  ok(M && (await state(M)).cart.branch === 'feat/clean-logs', 'new task with a custom branch name', custom);
  ok((await api('cart-add', { project: 'tool', title: 'Bad', branch: 'no..dots' })).status === 500, 'invalid branch names are refused');
  const qk = (await api('cart-add', { project: 'tool', title: 'Fix a typo', flow: 'quick' })).body.made[0].id;
  let qs = await state(qk);
  ok(qs.cart.flow === 'quick' && qs.phases.map(p => p.id).join() === 'q-plan,q-gate-plan,q-build,q-review,q-gate-merge', 'quick flow: plan, review, build, review, merge', qs.phases.map(p => p.id));
  ok((await api(`prompt?cart=${qk}&phase=q-plan`)).body.text.includes('QUICK PLAN'), 'quick plan prompt for the lead alone');
  for (const [phase, action] of [['q-plan', 'done'], ['q-gate-plan', 'approve'], ['q-build', 'done'], ['q-review', 'done']]) await api('phase', { cart: qk, phase, action });
  await api('phase', { cart: qk, phase: 'q-review', action: 'reject' });
  qs = await state(qk);
  ok(qs.phases.find(p => p.id === 'q-build').status === 'running' && qs.phases.find(p => p.id === 'q-gate-merge').status === 'locked', 'quick review sends bugs back to Build');
  await api('flow', { cart: qk, flow: 'full' });
  qs = await state(qk);
  ok(qs.cart.flow === 'full' && qs.phases[0].id === 'spec' && qs.phases[0].status === 'ready', 'switching to the full flow restarts the phases');
  ok((await api('flow', { cart: qk, flow: 'huge' })).status === 500, 'unknown flows are refused');
  const st = (await api('cart-add', { project: 'tool', title: 'Medium change', flow: 'standard' })).body.made[0].id;
  let ss = await state(st);
  ok(ss.phases.map(p => p.id).join() === 's-plan,s-gate-plan,s-build,s-simplify,s-review,s-gate-merge', 'standard flow has a simplify step', ss.phases.map(p => p.id));
  const checks = async (cart, phase) => (await api(`prompt?cart=${cart}&phase=${phase}`)).body.text;
  const all5 = t => ['Logic', 'Security', 'Tests', 'Docs', 'Skills'].every(w => t.includes(w));
  ok(all5(await checks(st, 's-review')) && all5(await checks(st, 's-build')) && all5(await checks(qk, 'review')), 'standard and full prompts carry the five quality checks');
  await api('flow', { cart: qk, flow: 'quick' });
  ok(all5(await checks(qk, 'q-review')) && all5(await checks(qk, 'q-plan')), 'quick prompts carry the five quality checks too');
  for (const [phase, action] of [['s-plan', 'done'], ['s-gate-plan', 'approve'], ['s-build', 'done'], ['s-simplify', 'done'], ['s-review', 'done']]) await api('phase', { cart: st, phase, action });
  await api('phase', { cart: st, phase: 's-review', action: 'reject' });
  ss = await state(st);
  ok(ss.phases.find(p => p.id === 's-build').status === 'running' && ss.phases.find(p => p.id === 's-simplify').status === 'locked', 'standard review sends bugs back to Build, then Simplify runs again');
  const homeAdd = (await api('cart-add-home', { project: 'tool' })).body;
  const H = homeAdd.made && homeAdd.made[0].id;
  ok(H === 'tool' && (await state(H)).cart.dir === PROJ2, 'main-checkout cartridge works in the project folder', homeAdd);
  const exclude = fs.readFileSync(path.join(PROJ, '.git/info/exclude'), 'utf8');
  ok(exclude.includes('/plans/') && exclude.includes('/.claude/worktrees/'), 'notebook and worktrees kept out of git (.git/info/exclude)');

  console.log('Settings and guard hook');
  const dirA = sA.cart.dir;
  const set = readJSON(path.join(dirA, '.claude/settings.local.json'));
  const guardHook = (set.hooks.PreToolUse || []).flatMap(g => g.hooks).find(h => h.command.includes('ctu-guard'));
  ok(guardHook && set.statusLine.command.includes('ctu-status') && set.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1', 'settings: guard hook, usage status line, agent teams');
  ok(!JSON.stringify(set).includes('Write('), 'no Write(...) deny rules (Claude Code never matches them)');
  const w = (dir, file) => ({ tool_name: 'Write', tool_input: { file_path: path.join(dir, file), content: 'x' } });
  ok(guard(dirA, w(dirA, 'src/t.js')) === 2, 'planning: writing src/ is blocked');
  ok(guard(dirA, w(dirA, 'plans/t.md')) === 0, 'planning: writing plans/ is allowed');
  ok(guard(dirA, w(dirA, 'src/t.js'), {}) === 0, 'sessions not started by the tool are untouched');
  ok(guard(dirA, w(PROJ, 'src/a.js')) === 2, 'a worktree team cannot write in the main checkout');
  const dirB = (await state(Bc)).cart.dir;
  ok(guard(dirA, w(dirB, 'plans/x.md')) === 2, 'a team cannot write in another cartridge');
  ok(guard(dirA, w(dirA, '.claude/settings.local.json')) === 2, 'the cartridge settings file is protected');
  ok(guard(dirA, w(os.tmpdir(), 'ctu-elsewhere.txt')) === 0, 'writes outside the project are left to Claude Code');
  ok(guard(dirA, { tool_name: 'Read', tool_input: { file_path: path.join(dirA, '.env') } }) === 2
    && guard(dirA, { tool_name: 'Read', tool_input: { file_path: path.join(dirA, '.env.example') } }) === 0, '.env is unreadable, .env.example is fine');
  const bash = cmd => guard(dirA, { tool_name: 'Bash', tool_input: { command: cmd } });
  ok(bash('git -C . push origin main') === 2 && bash('cd x && git push') === 2 && bash('git log --grep push') === 0, 'git push is blocked, other git commands are not');
  ok(bash('rm -rf build') === 2 && bash('rm -r -f build') === 2 && bash('rm -r build') === 0, 'rm -rf is blocked');

  console.log('Running in parallel, isolated');
  await api('start', { cart: A, opts: { teammateMode: 'tmux', remoteControl: false, permissionMode: 'auto' } });
  await api('start', { cart: Bc, opts: { teammateMode: 'tmux', remoteControl: false } });
  ok(await waitFor(async () => (await state(A)).panes.length === 2), 'cartridge A has a lead and a teammate');
  ok(await waitFor(async () => ((await state(A)).panes[1] || {}).label === 'planner-a'), 'teammate pane labelled from the team config');
  const pB = (await state(Bc)).panes;
  await api('send', { cart: A, text: 'only-for-A' });
  ok((await api('send', { cart: A, pane: pB[0] && pB[0].id, text: 'stray' })).status === 500, 'cannot send to an agent of another cartridge');
  await sleep(700);
  const tA = await paneText(A), tB = await paneText(Bc);
  ok(tA.includes('got: only-for-A') && !tB.includes('only-for-A'), 'messages reach only their cartridge');
  ok(tA.includes('API_KEY=<unset>') && tA.includes('AGENT_TEAMS=1') && tA.includes(`CTU_CART=${A}`), 'lead: no API key, agent teams on, CTU_CART set');
  ok(tA.includes('--permission-mode auto') && tA.includes('--teammate-mode tmux') && tA.includes('--name'), 'lead flags: permission mode, teammate mode, name');
  const tm = await paneText(A, (await state(A)).panes[1].id);
  ok(tm.includes('API_KEY=<unset>') && tm.includes(`CTU_CART=${A}`), 'teammate pane: no API key, CTU_CART from the session env');
  await api('send', { cart: Bc, pane: pB[1].id, text: 'perm' });
  ok(await waitFor(async () => (await cartOf(Bc)).attention === 'permission', 9000), 'permission prompt detected on the right cartridge');
  ok(!(await cartOf(A)).attention, 'other cartridges are not flagged');

  console.log('Main checkout, Node version, trust, waiting status');
  ok((await api('project-update', { project: 'tool', node: 'latest' })).status === 500, 'node version must look like a version');
  await api('project-update', { project: 'tool', node: '24' });
  await api('start', { cart: H, opts: { remoteControl: false, caffeinate: false } });
  ok(await waitFor(async () => (await paneText(H)).includes('NODE=')), 'main-checkout cartridge starts');
  { const ht = await paneText(H); ok(ht.includes('NODE=v24.9.9'), 'the project Node version from nvm comes first on PATH', ht.split('\n').filter(l => /NODE=/.test(l)).join(' / ')); }
  await api('project-update', { project: 'app', node: '99' });
  const noNode = await api('start', { cart: created.made[0].id, opts: { remoteControl: false } });
  ok(noNode.status === 500 && /Node 99 is not installed/.test(noNode.body.error), 'a missing Node version stops the start with a clear message', noNode.body);
  await api('project-update', { project: 'app', node: '' });
  const hDir = (await state(H)).cart.dir;
  fs.writeFileSync(path.join(HOME_CLAUDE, 'fake-agents.json'), JSON.stringify([{ pid: 1, cwd: hDir, name: 'x', status: 'waiting', sessionId: 'abc' }]));
  ok(await waitFor(async () => (await cartOf(H)).attention === 'question', 9000), '"waiting" from claude agents --json flags the cartridge');
  fs.rmSync(path.join(HOME_CLAUDE, 'fake-agents.json'));
  await api('send', { cart: H, text: 'trust' });
  ok(await waitFor(async () => (await api(`pane?cart=${H}`)).body.attention === 'trust'), 'trust dialog recognised');
  await api('trust', { cart: H });
  ok(await waitFor(async () => (await paneText(H)).includes('TRUSTED')), 'Trust picks "Yes" instead of the default "No, exit"');

  console.log('Workflow and modes');
  await api('phase', { cart: A, phase: 'spec', action: 'run' });
  await api('phase', { cart: A, phase: 'spec', action: 'done' });
  await api('phase', { cart: A, phase: 'gate-spec', action: 'reject', feedback: 'add criteria' });
  const ph = Object.fromEntries((await state(A)).phases.map(p => [p.id, p.status]));
  ok(ph.spec === 'running' && ph['gate-spec'] === 'locked', 'asking for changes reopens the previous phase');
  ok((await api('phase', { cart: A, phase: 'code', action: 'run' })).status === 409, 'locked phases cannot run');
  for (const [phase, action] of [['spec', 'done'], ['gate-spec', 'approve'], ['planning', 'done'], ['gate-plan', 'approve'],
    ['split', 'done'], ['code', 'done'], ['simplify', 'done'], ['review', 'done']]) await api('phase', { cart: A, phase, action });
  const back = (await api('phase', { cart: A, phase: 'gate-merge', action: 'reject', feedback: 'T03 breaks the export' })).body;
  const ph2 = Object.fromEntries((await state(A)).phases.map(p => [p.id, p.status]));
  ok(back.back === 'code' && ph2.code === 'running' && ph2.simplify === 'locked' && ph2.review === 'locked' && ph2['gate-merge'] === 'locked' && ph2.split === 'done',
    'changes at the merge gate go back to Build; Simplify and Review + QA run again', ph2);
  await api('phase', { cart: A, phase: 'code', action: 'done' });
  ok((await state(A)).phases.find(p => p.id === 'simplify').status === 'ready', 'after the fix, Simplify opens again');
  await api('phase', { cart: A, phase: 'simplify', action: 'done' });
  await api('phase', { cart: A, phase: 'review', action: 'done' });
  await api('phase', { cart: A, phase: 'review', action: 'reject' });
  const ph3 = Object.fromEntries((await state(A)).phases.map(p => [p.id, p.status]));
  ok(ph3.code === 'running' && ph3.review === 'locked' && ph3['gate-merge'] === 'locked', 'bugs found in Review + QA go straight back to Build', ph3);
  await api('mode', { cart: A, mode: 'code' });
  ok(readJSON(path.join(dirA, '.claude/team-ui/state.json')).mode === 'code' && guard(dirA, w(dirA, 'src/t.js')) === 0, 'code mode: the guard lets src/ through');
  let pr = (await api(`prompt?cart=${A}&phase=spec`)).body.text;
  ok(pr.includes('SPEC phase') && pr.includes('Issue #12') && pr.includes('Team rules') && pr.includes('model opus'), 'prompt has the task, the team rules and the model');
  await api('settings', { models: { strong: 'fable' } });
  ok((await api(`prompt?cart=${A}&phase=spec`)).body.text.includes('model fable'), 'model setting flows into prompts');
  await api('template', { cart: A, name: '00-spec.md', text: 'Custom {{PROJECT}} :: {{REQUEST}}' });
  await api('template', { cart: A, name: '_rules.md', text: 'RULES-X' });
  pr = (await api(`prompt?cart=${A}&phase=spec`)).body.text;
  ok(pr.startsWith('Custom app :: Issue #12'), 'project template replaces the default prompt');
  await api('template', { cart: A, name: '00-spec.md', text: null });
  ok((await api(`prompt?cart=${A}&phase=spec`)).body.text.includes('RULES-X'), 'reset template; custom team rules still apply');
  await api('template', { cart: A, name: '_rules.md', text: null });
  ok((await api('template', { cart: A, name: '../server.js', text: 'x' })).status === 400, 'only known templates can be saved');

  console.log('Team, messages, usage');
  const tdir = path.join(HOME_CLAUDE, 'projects', dirA.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, 's1.jsonl'), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Another Claude session sent a message:\n<teammate-message teammate_id="planner-a" color="blue" summary="Plan A ready">\nplans/02-plan-a.md is ready\n</teammate-message>' }, timestamp: '2026-10-27T02:52:39.692Z' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '<teammate-message teammate_id="planner-a" color="blue">\n{"type":"idle_notification","from":"planner-a"}\n</teammate-message>' }, timestamp: '2026-10-27T02:53:00.000Z' }),
    JSON.stringify({ type: 'cost-state', sessionId: 's1', totalCostUSD: 0.26, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 500, outputTokens: 2800, cacheReadInputTokens: 1000, cacheCreationInputTokens: 200, costUSD: 0.26 } } }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(tdir, 's2.jsonl'), [
    JSON.stringify({ type: 'user', agentName: 'planner-a', message: { role: 'user', content: '<teammate-message teammate_id="team-lead">\nYou are teammate planner-a.\n</teammate-message>' }, timestamp: '2026-10-27T02:52:31.201Z' }),
    JSON.stringify({ type: 'cost-state', sessionId: 's2', totalCostUSD: 0.22, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 600, costUSD: 0.22 } } }),
  ].join('\n') + '\n{"type":"cost-st'); // a partial last line is ignored until it is complete
  const team = (await api(`team?cart=${A}`)).body;
  ok(team.team && team.team.members.some(m => m.name === 'planner-a' && m.model === 'sonnet'), 'team members from the team config');
  ok(team.messages.length === 2 && team.messages[0].from === 'planner-a' && team.messages[0].to === 'team-lead' && team.messages[1].to === 'planner-a', 'agent messages read from transcripts, idle notices dropped', team.messages);
  ok(team.usage.costUSD === 0.48 && team.usage.sessions === 2, 'usage sums the cost of every session', team.usage);
  fs.writeFileSync(path.join(CONFIG, 'usage.json'), JSON.stringify({ at: Date.now(), rate_limits: { five_hour: { used_percentage: 42, resets_at: 1793080000 }, seven_day: { used_percentage: 18 } } }));
  ov = (await api('overview')).body;
  ok(ov.usage && ov.usage.fiveHour.pct === 42 && ov.usage.sevenDay.pct === 18, 'plan usage (5h / 7d) shown from the status line data');
  const statusOut = spawnSync('node', [path.join(ROOT, 'hooks/statusline.mjs'), path.join(TMP, 'u.json')],
    { input: JSON.stringify({ model: { display_name: 'Sonnet' }, rate_limits: { five_hour: { used_percentage: 7.4 } } }), encoding: 'utf8' });
  ok(statusOut.stdout.includes('5h 7%') && readJSON(path.join(TMP, 'u.json')).rate_limits.five_hour.used_percentage === 7.4, 'status line records rate limits');

  console.log('Review and research');
  fs.writeFileSync(path.join(dirA, 'src/google.js'), 'export const g = 1;\n');
  fs.writeFileSync(path.join(dirA, 'plans/00-spec.md'), '# Spec\n');
  git(dirA, 'add', 'src/google.js');
  git(dirA, 'commit', '-qm', 'T01: google');
  const rv = (await api('cart-add-review', { project: 'app', target: A })).body;
  const RV = rv.made && rv.made[0].id;
  const rvDir = RV && (await state(RV)).cart.dir;
  ok(RV && git(rvDir, 'log', '--oneline', '-1').includes('T01'), 'review checkout sits on the newest commit of the branch', rv);
  ok(fs.existsSync(path.join(rvDir, 'plans/context/00-spec.md')), 'review gets the spec of the work it reviews');
  ok((await state(RV)).phases.length === 2, 'review has a 2-step flow');
  const rpr = (await api('cart-add-review', { project: 'app', pr: 7 })).body;
  const RP = rpr.made && rpr.made[0].id;
  ok(RP && git((await state(RP)).cart.dir, 'rev-parse', 'HEAD') === PR_SHA, 'PR review fetches pull/7/head (head branch only in a fork)', rpr);
  ok((await api(`prompt?cart=${RP}&phase=review-run`)).body.text.includes('gh pr diff 7'), 'PR review scope uses gh pr diff');
  const rs = (await api('cart-add-research', { project: 'app', question: 'Which PDF library?', title: 'PDF' })).body;
  const RS = rs.made && rs.made[0].id;
  const rsDir = RS && (await state(RS)).cart.dir;
  ok(RS && readJSON(path.join(rsDir, '.claude/settings.local.json')).permissions.allow.includes('WebSearch') && fs.existsSync(path.join(rsDir, 'CLAUDE.md')), 'research cartridge may search the web');
  ok((await api('forward', { cart: RS, to: A })).status === 500, 'no report yet, nothing to send');
  fs.writeFileSync(path.join(rsDir, 'plans/report.md'), '# Report\n');
  const fw = (await api('forward', { cart: RS, to: A })).body;
  ok(fw.ok && fw.sent && fs.existsSync(path.join(dirA, fw.path)), 'report copied to cartridge A and its lead told');
  ok((await api(`file?cart=${A}&path=../../etc/passwd`)).status === 403 && (await api(`file?cart=${A}&path=plans/00-spec.md`)).status === 200, 'only plans/ and CLAUDE.md are readable');

  console.log('Pull request');
  const pd = (await api(`pr-draft?cart=${A}`)).body;
  ok(pd.base === 'main' && pd.title === 'Google sign-in for the admin page' && pd.body.startsWith('Closes #12') && pd.body.includes('## Testing') && pd.ahead === 1, 'PR draft: base, title, Closes #12, repo template, commits ahead', pd);
  const po = (await api('pr-open', { cart: A, title: pd.title, body: pd.body, base: 'main', draft: true })).body;
  const remoteHasBranch = execFileSync('git', ['ls-remote', REMOTE, `refs/heads/${sA.cart.branch}`], { encoding: 'utf8' }).trim() !== '';
  const ghLog = fs.readFileSync(GH_LOG, 'utf8');
  const ghCall = ghLog.slice(Math.max(0, ghLog.indexOf('pr create')));
  ok(po.ok && po.url === 'https://github.com/acme/app/pull/8' && remoteHasBranch, 'Open PR pushes the branch and opens the PR', po);
  ok(ghCall.includes(`--head ${sA.cart.branch}`) && ghCall.includes('--base main') && ghCall.includes('--draft'), 'gh pr create gets head, base and draft', ghCall);
  ok((await cartOf(A)).prUrl === po.url, 'cartridge remembers its PR');

  console.log('Stopping and ejecting');
  await api('stop', { cart: A });
  ok(!(await state(A)).running, 'soft stop confirms the exit menu and closes the session');
  ok(!fs.readdirSync(path.join(HOME_CLAUDE, 'teams')).some(n => readJSON(path.join(HOME_CLAUDE, 'teams', n, 'config.json')).members[0].cwd === dirA), 'the lead exited cleanly (team config removed)');
  ok((await api('project-remove', { project: 'app' })).status === 400, 'a project with a running cartridge cannot be removed');
  fs.appendFileSync(path.join(dirA, 'src/a.js'), 'change\n');
  ok((await api('cart-remove', { cart: A })).status === 500, 'eject refuses while tracked changes are uncommitted');
  git(dirA, 'checkout', '--', 'src/a.js');
  const rm = (await api('cart-remove', { cart: A })).body;
  ok(rm.ok && !fs.existsSync(dirA) && git(PROJ, 'branch').includes(sA.cart.branch), 'eject removes the worktree and keeps the branch', rm);
  ok(rm.archived && fs.existsSync(path.join(rm.archived, '00-spec.md')), 'the notebook is archived before the worktree goes');
  const rmRs = (await api('cart-remove', { cart: RS })).body;
  ok(rmRs.ok && fs.existsSync(path.join(rsDir, 'plans/report.md')), 'ejecting research keeps the report');
  const rmH = (await api('cart-remove', { cart: H })).body;
  ok(rmH.ok && fs.existsSync(path.join(PROJ2, 'README.md')) && !(await cartOf(H)), 'ejecting the main checkout only takes it off the rack');
}

function cleanup() {
  try { srv.kill(); } catch {}
  try {
    const ls = execFileSync('tmux', ['ls', '-F', '#{session_name}'], { encoding: 'utf8' });
    for (const s of ls.split('\n')) if (s.startsWith(SESSION)) execFileSync('tmux', ['kill-session', '-t', `=${s}`]);
  } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch(e => { fail++; console.error('Error:', e); }).finally(() => {
  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

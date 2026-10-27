#!/usr/bin/env node
// End-to-end test with fake claude/gh (test/fakes). Calls no model and needs no network.
// Needs node >= 18, tmux and git. Run: npm test
// Only creates and removes tmux sessions with this run's own prefix.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createRequire } from 'node:module';

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
  TEAM_UI_SESSION: SESSION, TEAM_UI_CONFIG_DIR: CONFIG, FAKE_GH_LOG: GH_LOG, ANTHROPIC_API_KEY: 'sk-must-be-dropped', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'outer', NVM_DIR: NVM,
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
// A GET with a chosen Host header, as a DNS-rebinding page on another host name would send
function rawGet(url, host) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { host } }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
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
  ok((await rawGet(`${B}/api/overview`, `rebind.example:${PORT}`)) === 401, 'without a cookie, a page on another host name gets 401 (DNS rebinding)');
  ok((await api('overview')).status === 200, 'this Mac itself needs no token');
  const login = await fetch(`${B}/?token=${TOKEN}`, { redirect: 'manual' });
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  ok(cookie.startsWith('ctu='), 'token login sets the cookie');
  const csrf = await fetch(B + '/api/settings', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
  ok(csrf.status === 403, 'POST without the X-CTU header → 403');

  console.log('Tailscale');
  const { Tailscale, tailnetAddr } = createRequire(import.meta.url)(path.join(ROOT, 'lib/tailscale.js'));
  ok(tailnetAddr('100.101.1.2') && tailnetAddr('::ffff:100.64.0.1') && tailnetAddr('fd7a:115c:a1e0::1') && !tailnetAddr('100.128.0.1') && !tailnetAddr('192.168.1.5'), 'tailnet addresses are told apart from the LAN');
  const ts = new Tailscale(path.join(ROOT, 'test/fakes/tailscale'));
  ok((await ts.status()).login === 'me@example.com', 'the Mac\'s Tailscale account is read from tailscale status');
  ok(await ts.owner('100.101.1.2') && !(await ts.owner('100.101.1.3')) && !(await ts.owner('192.168.1.2')), 'only devices of the same account are trusted without a token');
  const TPORT = PORT + 1;
  const tsrv = spawn('node', [path.join(ROOT, 'server.js'), '--tailscale', '--port', String(TPORT)], { env: { ...env, TAILSCALE_BIN: path.join(ROOT, 'test/fakes/tailscale'), TEAM_UI_CONFIG_DIR: path.join(TMP, 'ts-config') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let tsOut = ''; tsrv.stdout.on('data', d => (tsOut += d)); tsrv.stderr.on('data', d => (tsOut += d));
  ok(await waitFor(async () => /Tailscale only/.test(tsOut)), '--tailscale starts and says so', tsOut);
  const links = await (await fetch(`http://127.0.0.1:${TPORT}/api/phone-link`)).json();
  ok(links.tailscale && links.urls[0] === `http://mac.tail1.ts.net:${TPORT}/` && !links.urls.some(u => u.includes('token')), 'phone link over Tailscale: MagicDNS name, no token', links);
  ok((await rawGet(`http://127.0.0.1:${TPORT}/api/overview`, `rebind.example:${TPORT}`)) === 401, '--tailscale: a non-local host name still needs sign-in');
  tsrv.kill();

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
  ok(iss.ok && iss.issues.length === 3 && iss.issues[0].project === 'app', 'issues come from gh, tagged with the project');
  const issAll = (await api('issues?project=all')).body;
  ok(issAll.ok && issAll.issues.length === 6 && new Set(issAll.issues.map(i => i.project)).size === 2, 'issues from every project at once', issAll.issues.length);
  ok((await api('issues?project=all&mine=1')).body.issues.map(i => i.number).join() === '15,15', 'mine keeps issues assigned to me');
  ok((await api('issues?project=app&q=csv')).body.issues.map(i => i.number).join() === '15', 'search text goes to gh');
  const prs = (await api('prs?project=all')).body;
  ok(prs.ok && prs.prs.length === 4 && prs.prs[0].number === 7 && prs.prs[0].project && (await api('prs?project=app&mine=1')).body.prs.map(p => p.number).join() === '7', 'open pull requests to review, across projects; mine = opened by me or waiting for my review', prs);
  ok(JSON.stringify(iss.issues.find(i => i.number === 18).prs) === '[{"number":7,"url":"https://github.com/acme/app/pull/7"}]' && !iss.issues.find(i => i.number === 12).prs.length, 'issues know their pull requests in the same repository');
  const nums = async p => (await api(p)).body.issues.map(i => i.number).join();
  ok(await nums('issues?project=app&assignee=@me') === '15' && await nums('issues?project=app&author=alice') === '12', 'assignee and author filters become gh flags');
  ok(await nums('issues?project=app&label=feature') === '12,15' && await nums('issues?project=app&sort=created') === '15,18,12', 'label filter, and sorting by creation');
  await api('issues?project=app&state=all');
  ok(/issue list --state all/.test(fs.readFileSync(GH_LOG, 'utf8')), 'the state filter becomes --state');
  ok((await api('issues?project=app&assignee=bad%20login')).status === 400 && (await api('prs?project=app&decision=yes')).status === 400, 'filters are validated before gh sees them');
  const prNums = async p => (await api(p)).body.prs.map(x => x.number).join();
  ok(await prNums('prs?project=app&author=bot') === '8' && await prNums('prs?project=app&draft=draft') === '8' && await prNums('prs?project=app&review=me') === '' && await prNums('prs?project=app&decision=required') === '7', 'pull request filters: author, draft, review requested, decision');
  ok(iss.issues.find(i => i.number === 12).author === 'alice', 'issues carry their author, for the picker');
  const add = await api('cart-add', { project: 'app', issues: [12, 15] });
  const [A, Bc] = (add.body.made || []).map(m => m.id);
  ok(A === 'app-12-google-sign-in-for-the-admin' && Bc, 'two cartridges from issues, ids carry the project', add.body);
  const sA = await state(A);
  ok(sA.cart.branch === 'issue/12-google-sign-in-for-the-admin-page' && sA.cart.base === 'origin/main', 'branch from the issue, base is origin/main', sA.cart);
  ok(sA.request.startsWith('Issue #12') && sA.request.includes('Details of issue 12'), 'task text comes from the issue');
  ok(!sA.running, 'adding a cartridge does not start it');
  ok((await api('cart-add', { project: 'app', issues: [12] })).status === 500, 'the same issue cannot get two cartridges');
  const cross = (await api('cart-add', { issues: ['tool#18'] })).body;
  const X = cross.made && cross.made[0].id;
  ok(X === 'tool-18-fix-timeout-on-large-uploads', 'an issue picked from the all-projects list lands in its own project', cross);
  ok((await api('issues?project=all')).body.issues.find(i => i.project === 'tool' && i.number === 18).cart === X, 'the list marks issues that already have a cartridge');
  await api('cart-remove', { cart: X });
  const draft = (await api('draft-issue', { text: 'report page is slow' })).body;
  ok(draft.ok && draft.title === 'Speed up the report page and add CSV export', 'issue draft read from structured_output', draft);
  const created = (await api('cart-add', { project: 'app', title: 'Speed up reports', body: 'x', createIssue: true })).body;
  ok(created.made && created.made[0].id.startsWith('app-21-'), 'creates the GitHub issue, then the cartridge', created);
  const custom = (await api('cart-add', { project: 'tool', title: 'Clean logs', branch: 'feat/clean-logs' })).body;
  const M = custom.made && custom.made[0].id;
  ok(M && (await state(M)).cart.branch === 'feat/clean-logs', 'new task with a custom branch name', custom);
  ok((await api('cart-add', { project: 'tool', title: 'Bad', branch: 'no..dots' })).status === 500, 'invalid branch names are refused');
  const qk = (await api('cart-add', { project: 'tool', title: 'Fix a typo', flow: 'quick' })).body.made[0].id;
  const fa = (await api('cart-add', { project: 'tool', title: 'Hands free', flow: 'quick', pilot: 'full-auto' })).body.made[0].id;
  ok((await state(fa)).pilot === 'full-auto', 'a cartridge can be added in full auto');
  await api('cart-remove', { cart: fa });
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
  ok(!/teammate "dev"/.test(await checks(qk, 'q-build')) && /Build it yourself, no teammates/.test(await checks(qk, 'q-build')), 'quick build: the lead codes alone');
  ok((await checks(qk, 'q-review')).includes('since the previous review'), 'before any review, {{SINCE}} reads as the previous review');
  // Risks are not questions: hands-off must pass a plan that lists risks and says "None" under open questions
  const qkDir = (await state(qk)).cart.dir;
  fs.writeFileSync(path.join(qkDir, 'plans/plan.md'), '# Plan\n\n## 6. Risks\n1. The cache may go stale\n2. Slow on big tables\n\n## 7. Open questions for me\nNone\n');
  await api('phase', { cart: qk, phase: 'q-plan', action: 'done' });
  ok((await state(qk)).questions.length === 0 && (await cartOf(qk)).questions === 0, 'a plan with numbered risks and "None" under open questions asks nothing', (await state(qk)).questions);
  fs.writeFileSync(path.join(qkDir, 'plans/plan.md'), '# Plan\n\n## 6. Risks\n1. The cache may go stale\n\n## 7. Open questions for me\n1. Keep the old endpoint?\n2. Which bucket?\n');
  ok((await state(qk)).questions.length === 2, 'real open questions are counted', (await state(qk)).questions);
  await api('reset', { cart: qk });
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
  ok(bash('gh pr merge 7 --squash') === 2 && bash('cd x && gh issue comment 5 -b hi') === 2 && bash('gh pr create --fill') === 2, 'no GitHub writes: merge, comment, create');
  ok(bash('gh api -X POST repos/a/b/issues') === 2 && bash('gh api repos/a/b/labels -f name=x') === 2, 'the GitHub API is read-only');
  ok(bash('gh pr view 7 --json title && gh api repos/a/b/pulls && gh issue list') === 0, 'reading GitHub stays allowed');
  ok(bash('pnpm publish --access public') === 2 && bash('sudo ls') === 2 && bash('pnpm test') === 0, 'no publishing, no sudo');
  ok(bash('git commit --no-verify -m x') === 2 && bash('git commit -n -m x') === 2 && bash('HUSKY=0 git commit -m x') === 2
    && bash('git -c core.hooksPath=/dev/null commit -m x') === 2 && bash('git commit --amend --no-edit') === 0 && bash('git commit -m "no new"') === 0, 'hooks cannot be skipped');

  console.log('Running in parallel, isolated');
  ok((await state(A)).pilot === 'hands-off' && (await state(A)).autopilot === true, 'new cartridges run hands-off');
  for (const c of [A, Bc, H]) await api('autopilot', { cart: c, mode: 'manual' }); // these tests drive the steps by hand
  ok((await api('autopilot', { cart: A, mode: 'reckless' })).status === 400, 'unknown autopilot modes are refused');
  await api('start', { cart: A, opts: { teammateMode: 'tmux', remoteControl: false, permissionMode: 'auto' } });
  await api('start', { cart: Bc, opts: { teammateMode: 'tmux', remoteControl: false } });
  ok(await waitFor(async () => (await state(A)).panes.length === 2), 'cartridge A has a lead and a teammate');
  ok(await waitFor(async () => ((await state(A)).panes[1] || {}).label === 'planner-a'), 'teammate pane labelled from the team config');
  ok(await waitFor(async () => (await state(Bc)).panes.length === 2), 'cartridge B has a lead and a teammate');
  const pB = (await state(Bc)).panes;
  await api('send', { cart: A, text: 'only-for-A' });
  ok((await api('send', { cart: A, pane: pB[0] && pB[0].id, text: 'stray' })).status === 500, 'cannot send to an agent of another cartridge');
  await sleep(700);
  const tA = await paneText(A), tB = await paneText(Bc);
  ok(tA.includes('got: only-for-A') && !tB.includes('only-for-A'), 'messages reach only their cartridge');
  ok(tA.includes('API_KEY=<unset>') && tA.includes('AGENT_TEAMS=1') && tA.includes(`CTU_CART=${A}`), 'lead: no API key, agent teams on, CTU_CART set');
  ok(tA.includes('NESTED=<unset>'), 'lead: nothing from an outer Claude Code session (console started inside one)');
  ok(tA.includes('--permission-mode auto') && tA.includes('--teammate-mode tmux') && tA.includes('--name'), 'lead flags: permission mode, teammate mode, name');
  const tm = await paneText(A, (await state(A)).panes[1].id);
  ok(tm.includes('API_KEY=<unset>') && tm.includes(`CTU_CART=${A}`) && tm.includes('NESTED=<unset>'), 'teammate pane: no API key or outer-session vars, CTU_CART from the session env');
  await api('send', { cart: Bc, pane: pB[1].id, text: 'perm' });
  ok(await waitFor(async () => (await cartOf(Bc)).attention === 'permission', 9000), 'permission prompt detected on the right cartridge');
  ok(!(await cartOf(A)).attention, 'other cartridges are not flagged');
  const allow = (await api('key', { cart: Bc, pane: pB[1].id, key: 'enter' })).body;
  ok(allow.ok && allow.attention === null && !(await cartOf(Bc)).attention, 'answering clears "needs you" at once, without waiting for the watcher', allow);

  console.log('Setup command');
  await api('project-update', { project: 'tool', setupCommand: 'echo SETUP-START; sleep 1; echo SETUP-OK' });
  ok((await api('overview')).body.projects.find(p => p.id === 'tool').setupCommand === 'echo SETUP-START; sleep 1; echo SETUP-OK', 'the setup command is a project setting');
  const su = (await api('cart-add', { project: 'tool', title: 'Needs install', flow: 'quick' })).body.made[0].id;
  ok(((await state(su)).setup || {}).status === 'running', 'a new worktree starts its setup in the background', (await state(su)).setup);
  ok(await waitFor(async () => ((await state(su)).setup || {}).status === 'ok', 9000), 'setup finishes with ok', (await state(su)).setup);
  ok(/SETUP-OK/.test((await api(`file?cart=${su}&path=.claude/team-ui/setup.log`)).body.text), 'the setup log can be read');
  ok((await cartOf(su)).setup.status === 'ok' && (await state(su)).setup.line === 'SETUP-OK', 'the ticket carries the setup status and its last line');
  const rs0 = (await api('cart-add-research', { project: 'tool', question: 'No setup here', title: 'nosetup' })).body.made[0].id;
  ok(!(await state(rs0)).setup, 'research cartridges never run the setup command');
  await api('cart-remove', { cart: rs0 });
  await api('project-update', { project: 'tool', setupCommand: 'echo starting; echo broken >&2; exit 3' });
  ok((await api('setup', { cart: su })).body.ok && await waitFor(async () => ((await state(su)).setup || {}).status === 'failed', 9000), 'setup can be run again and reports a failure');
  ok(/exit 3: broken/.test((await state(su)).setup.line), 'the failure keeps the exit code and the last line', (await state(su)).setup);
  // Add and start: Claude starts at once, the first step waits for the setup
  await api('project-update', { project: 'tool', setupCommand: 'sleep 2; echo SETUP-OK' });
  const sw = (await api('cart-add', { project: 'tool', title: 'Waits for install', flow: 'quick', start: true })).body.made[0].id;
  ok(await waitFor(async () => (await state(sw)).running, 9000), 'the cartridge starts while its setup runs');
  ok(await waitFor(async () => (await state(sw)).phases[0].status === 'running', 15000), 'the first step runs once the setup is done');
  { const s = await state(sw); ok(s.setup.status === 'ok' && s.setup.endedAt <= s.stepAt, 'the step was sent after the setup ended', { setup: s.setup, stepAt: s.stepAt }); }
  await api('stop', { cart: sw, hard: true });
  await api('project-update', { project: 'tool', setupCommand: '' });

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

  console.log('Fewer taps: done markers, autopilot, start and run');
  await api('flow', { cart: H, flow: 'quick' });
  await api('phase', { cart: H, phase: 'q-plan', action: 'run' });
  fs.mkdirSync(path.join(hDir, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(hDir, 'plans/plan.md'), '# Plan\n\n## 6. Risks and open questions for me (numbered)\n\n**Risks**\n- none big\n\n**Open questions**\n1. **Wallet.** Who provides it?\n2. **Changeset:** skip or add?\n');
  await api('autopilot', { cart: H, mode: 'hands-off' }); // questions in the plan must stop even hands-off
  await sleep(4500);
  ok((await state(H)).phases[0].status === 'running', 'the marker inside the prompt itself does not end the step');
  await api('send', { cart: H, text: 'say PLAN DONE' });
  ok(await waitFor(async () => (await state(H)).phases.find(p => p.id === 'q-gate-plan').status === 'ready', 9000), 'the lead\'s "PLAN DONE" ends the step and opens the checkpoint');
  ok((await state(H)).questions.length === 2 && (await cartOf(H)).questions === 2, 'the plan\'s open questions reach the step card and the home list');
  await sleep(4500);
  ok((await state(H)).phases.find(p => p.id === 'q-gate-plan').status === 'ready', 'hands-off does not pass a checkpoint that asks the user something');
  await api('phase', { cart: H, phase: 'q-gate-plan', action: 'approve', answers: '1. I will. 2. Skip it.' });
  ok(await waitFor(async () => (await paneText(H)).includes('My answers to the open questions')), 'answers go to the lead with the approval');
  await api('autopilot', { cart: H, mode: 'checkpoints' });
  ok((await state(H)).phases.find(p => p.id === 'q-build').status === 'running', 'approving runs the next step (autopilot)');
  await api('send', { cart: H, text: 'say BUILD DONE, two commits' });
  ok(await waitFor(async () => (await state(H)).phases.find(p => p.id === 'q-review').status === 'running', 9000), 'a finished step starts the next one until a checkpoint');
  await api('send', { cart: H, text: 'say Write(plans/review.md)' });
  ok(await waitFor(async () => (await cartOf(H)).said === 'Writing plans/review.md', 9000), 'the home list shows the lead\'s newest line, tool calls in words');
  const hs = await cartOf(H);
  ok(hs.crew.length === 2 && hs.crew[0].name === 'lead' && hs.crew[0].busy && hs.steps.done === 3 && hs.steps.total === 5, 'the home list shows the crew, who is busy, and steps done', hs);
  await api('autopilot', { cart: H, mode: 'hands-off' });
  const hph = async id => (await state(H)).phases.find(p => p.id === id).status;
  await api('send', { cart: H, text: 'say REVIEW DONE - NEEDS WORK: the CSV header is wrong' });
  ok(await waitFor(async () => await hph('q-build') === 'running' && await hph('q-review') === 'locked', 9000), 'hands-off: a NEEDS WORK review goes back to Build by itself');
  const hSha = git(PROJ2, 'rev-parse', '--short', 'HEAD');
  ok((await api(`prompt?cart=${H}&phase=q-review`)).body.text.includes(`git diff ${hSha}...HEAD`), 'the next review prompt diffs since the commit the review covered ({{SINCE}})', hSha);
  await sleep(4500);
  ok(await hph('q-build') === 'running', 'the BUILD DONE of the earlier round does not end the fix round');
  await api('send', { cart: H, text: 'say BUILD DONE, header fixed' });
  ok(await waitFor(async () => await hph('q-review') === 'running', 9000), 'after the fix, Review runs again');
  await api('send', { cart: H, text: 'say REVIEW DONE - READY TO MERGE' });
  ok(await waitFor(async () => await hph('q-gate-merge') === 'ready', 9000), 'a clean review stops at the merge, even hands-off');
  await sleep(4500);
  ok(await hph('q-gate-merge') === 'ready', 'the merge checkpoint is never approved by itself');
  await api('send', { cart: H, text: 'say API Error: 529 overloaded_error' });
  ok(await waitFor(async () => ((await cartOf(H)).health || {}).kind === 'error', 9000), 'an API error on the lead\'s screen marks the cartridge as failing');
  await api('send', { cart: H, text: 'say Back at it.' });
  ok(await waitFor(async () => !(await cartOf(H)).health, 9000), 'the error clears once the lead carries on');
  const tl = (await state(H)).timeline;
  ok(tl.some(r => r.id === 'q-gate-plan' && r.status === 'approved' && r.outcome === 'You approved, with answers')
    && tl.some(r => r.id === 'q-review' && r.status === 'changes' && r.outcome === 'Needs work')
    && tl.some(r => r.title === 'Build, fix round 1' && r.status === 'done' && r.outcome === 'BUILD DONE'), 'the timeline tells each run of a step in order, with how it ended', tl.map(r => `${r.title}:${r.status}`));
  await api('autopilot', { cart: H, mode: 'full-auto' });
  ok((await state(H)).phases.find(p => p.id === 'q-gate-merge').status === 'done', 'handing a waiting checkpoint to the team settles it at once');
  const hst = await state(H);
  ok(hst.crew[0].name === 'lead' && hst.doing === 'Back at it.' && typeof hst.stepAt === 'number', 'state says who is on it, what is happening, and since when', { crew: hst.crew, doing: hst.doing });
  await api('autopilot', { cart: H, on: false });
  ok((await state(H)).autopilot === false, 'autopilot can be turned off');
  const startRun = await api('start', { cart: M, run: true, opts: { remoteControl: false, caffeinate: false } });
  ok(startRun.status === 200 && await waitFor(async () => (await state(M)).phases[0].status === 'running', 12000), 'Start and run: the first step runs once Claude is ready');
  // Claude Code reports the lead busy while a background agent lives; a finished reply in the transcript still ends the step
  const mDir = (await state(M)).cart.dir, mFirst = (await state(M)).phases[0];
  fs.writeFileSync(path.join(HOME_CLAUDE, 'fake-agents.json'), JSON.stringify([{ pid: 2, cwd: mDir, name: 'm', status: 'busy', sessionId: 'sess-m' }]));
  const mProj = path.join(HOME_CLAUDE, 'projects', mDir.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(mProj, { recursive: true });
  fs.writeFileSync(path.join(mProj, 'sess-m.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Spec written.\nSPEC DONE\n\nNo questions.' }] } }) + '\n');
  ok(await waitFor(async () => (await state(M)).phases.find(p => p.id === mFirst.id).status === 'done', 12000), 'a done reply in the transcript ends the step even while the lead is reported busy');
  fs.rmSync(path.join(HOME_CLAUDE, 'fake-agents.json'));

  console.log('Full flow end to end, hands-off');
  const mph = async id => (await state(M)).phases.find(p => p.id === id).status;
  const mstep = async (say, id, status, label) => { await api('send', { cart: M, text: `say ${say}` }); ok(await waitFor(async () => await mph(id) === status, 12000), label); };
  ok(await waitFor(async () => await mph('planning') === 'running', 9000), 'the spec checkpoint passes (no questions) and Plan runs');
  await mstep('PLAN DONE', 'split', 'running', 'Plan done: the plan checkpoint passes, Split runs');
  await mstep('TASKS DONE', 'code', 'running', 'Split done: Build runs');
  await mstep('BUILD DONE', 'simplify', 'running', 'Build done: Simplify runs');
  await mstep('SIMPLIFY DONE', 'review', 'running', 'Simplify done: Review runs');
  await mstep('REVIEW DONE - NEEDS WORK: logs keep a token', 'code', 'running', 'NEEDS WORK goes back to Build by itself');
  await mstep('BUILD DONE, token removed', 'simplify', 'running', 'after the fix, Simplify runs again');
  await mstep('SIMPLIFY DONE', 'review', 'running', 'and Review again');
  await mstep('REVIEW DONE - READY TO MERGE', 'gate-merge', 'ready', 'a clean review stops at the merge');
  git(mDir, 'commit', '-q', '--allow-empty', '-m', 'clean logs');
  await api('autopilot', { cart: M, mode: 'full-auto' }); // this repo has no remote, so the draft PR cannot be pushed
  ok(await mph('gate-merge') === 'ready' && await mph('retro') === 'locked', 'full auto never skips the PR: when it cannot open one, the merge checkpoint waits');

  console.log('Standard flow end to end, hands-off');
  await api('flow', { cart: st, flow: 'quick' }); await api('flow', { cart: st, flow: 'standard' });
  await api('autopilot', { cart: st, mode: 'hands-off' });
  await api('start', { cart: st, run: true, opts: { remoteControl: false, caffeinate: false } });
  const sph = async id => (await state(st)).phases.find(p => p.id === id).status;
  const sstep = async (say, id, status, label) => { await api('send', { cart: st, text: `say ${say}` }); ok(await waitFor(async () => await sph(id) === status, 12000), label); };
  ok(await waitFor(async () => await sph('s-plan') === 'running', 12000), 'Start and run starts the plan');
  await sstep('PLAN DONE', 's-build', 'running', 'Plan done: the checkpoint passes, Build runs');
  await sstep('BUILD DONE', 's-simplify', 'running', 'Build done: Simplify runs');
  await sstep('SIMPLIFY DONE', 's-review', 'running', 'Simplify done: Review runs');
  await sstep('REVIEW DONE - READY TO MERGE', 's-gate-merge', 'ready', 'a clean review stops at the merge');

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
  // Project prompts travel between machines with the config manifest
  const SYNC = path.join(TMP, 'sync'), cfgTool = path.join(ROOT, 'bin/team-ui-config.js'), appPrompts = path.join(PROJ, '.claude/team-ui/prompts');
  fs.mkdirSync(SYNC);
  await api('project-update', { project: 'app', setupCommand: 'npm ci' });
  execFileSync('node', [cfgTool, 'export', path.join(SYNC, 'projects.json'), '--root', TMP], { env, encoding: 'utf8' });
  const manifest = JSON.parse(fs.readFileSync(path.join(SYNC, 'projects.json'), 'utf8'));
  ok(manifest.projects.find(p => p.path === 'app').prompts === 'prompts/app' && fs.readFileSync(path.join(SYNC, 'prompts/app/_rules.md'), 'utf8') === 'RULES-X', 'export carries the project\'s prompts', manifest);
  ok(manifest.projects.find(p => p.path === 'app').setupCommand === 'npm ci' && !('setupCommand' in manifest.projects.find(p => p.path === 'tool')), 'export carries the setup command only where one is set', manifest);
  fs.rmSync(appPrompts, { recursive: true });
  execFileSync('node', [cfgTool, 'import', path.join(SYNC, 'projects.json'), '--root', TMP], { env: { ...env, TEAM_UI_CONFIG_DIR: path.join(TMP, 'config-b') }, encoding: 'utf8' });
  ok(fs.readFileSync(path.join(appPrompts, '_rules.md'), 'utf8') === 'RULES-X' && !git(PROJ, 'status', '--porcelain').includes('team-ui'), 'import puts the prompts back, kept out of git');
  ok(readJSON(path.join(TMP, 'config-b', 'config.json')).projects.find(p => p.id === 'app').setupCommand === 'npm ci', 'import sets the setup command');
  await api('project-update', { project: 'app', setupCommand: '' });
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
  await api('settings', { prFooter: 'Opened by my assistant. Review before merging.' });
  const pd = (await api(`pr-draft?cart=${A}`)).body;
  ok(pd.body.endsWith('\n\nOpened by my assistant. Review before merging.'), 'the PR footer from settings closes the PR text');
  ok(pd.base === 'main' && pd.title === 'Google sign-in for the admin page' && pd.body.startsWith('Closes #12') && pd.body.includes('## Testing') && pd.ahead === 1, 'PR draft: base, title, Closes #12, repo template, commits ahead', pd);
  const po = (await api('pr-open', { cart: A, title: pd.title, body: pd.body, base: 'main', draft: true })).body;
  const remoteHasBranch = execFileSync('git', ['ls-remote', REMOTE, `refs/heads/${sA.cart.branch}`], { encoding: 'utf8' }).trim() !== '';
  const ghLog = fs.readFileSync(GH_LOG, 'utf8');
  const ghCall = ghLog.slice(Math.max(0, ghLog.indexOf('pr create')));
  ok(po.ok && po.url === 'https://github.com/acme/app/pull/8' && remoteHasBranch, 'Open PR pushes the branch and opens the PR', po);
  ok(ghCall.includes(`--head ${sA.cart.branch}`) && ghCall.includes('--base main') && ghCall.includes('--draft'), 'gh pr create gets head, base and draft', ghCall);
  ok((await cartOf(A)).prUrl === po.url, 'cartridge remembers its PR');
  const ad = (await api('address-pr', { cart: A })).body;
  const prc = fs.readFileSync(path.join(dirA, 'plans/pr-comments.md'), 'utf8');
  ok(ad.ok && ad.count === 2 && prc.includes('src/a.js:3, @alice: Handle the empty case') && prc.includes('@alice (changes requested): Please add a test') && !prc.includes('done already') && !prc.includes('coverage'),
    'PR comments: open threads and reviews are numbered for the team; resolved threads and bots are left out', prc);
  const sAd = await state(A);
  ok(sAd.phases.find(p => p.id === 'code').status === 'running' && sAd.phases.find(p => p.id === 'gate-merge').status === 'locked' && (await paneText(A)).includes('plans/pr-comments.md'),
    'the comments reopen Build; the lead gets them with how to reply');
  ok(sAd.timeline.some(r => r.title === 'Build, PR comments' && r.status === 'running'), 'the timeline shows the PR comments round');

  console.log('Assistant');
  // The answer comes as server-sent events; the whole stream is read, then split into events
  async function sse(body) {
    const r = await fetch(B + '/api/assistant/send', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', 'X-CTU': '1' }, body: JSON.stringify(body) });
    if (!String(r.headers.get('content-type')).includes('text/event-stream')) return { status: r.status, body: await r.json().catch(() => ({})), events: [] };
    const events = (await r.text()).split('\n\n').filter(Boolean).map(b => {
      const ev = {};
      for (const l of b.split('\n')) { if (l.startsWith('event:')) ev.type = l.slice(6).trim(); else if (l.startsWith('data:')) ev.data = JSON.parse(l.slice(5)); }
      return ev;
    });
    return { status: r.status, events };
  }
  ok((await sse({ text: '  ' })).status === 400, 'an empty message is refused before the stream opens');
  const s1 = await sse({ text: 'Can we file an issue for CSV export?', cart: A });
  const d1 = s1.events.find(e => e.type === 'done');
  const t1 = s1.events.filter(e => e.type === 'text').map(e => e.data.text).join('');
  ok(s1.status === 200 && s1.events[0].type === 'open' && t1.startsWith('Looking at ') && d1, 'send streams text events and ends with done', s1.events.map(e => e.type));
  ok(s1.events.some(e => e.type === 'status' && e.data.text === 'Searching report'), 'a tool call becomes a status line');
  const C1 = d1 && d1.data.conversation;
  ok(C1 && fs.existsSync(path.join(CONFIG, 'assistant', `${C1}.json`)), 'the chat is saved under the config folder');
  const m1 = d1 && d1.data.message;
  ok(m1 && m1.text.startsWith('Looking at \n\nEcho: Can we file an issue') && !m1.text.includes('```action') && m1.text.includes('```reply') && m1.costUSD === 0.0123,
    'the reply keeps the reply draft, drops the card block, and carries its cost', m1);
  ok(m1 && m1.actions.length === 1 && m1.actions[0].type === 'create-issue' && m1.actions[0].project === 'app' && m1.actions[0].labels[0] === 'feature' && m1.actions[0].label === 'Create issue in app',
    'the card is parsed and checked', m1 && m1.actions);
  const callLog = fs.readFileSync(path.join(HOME_CLAUDE, 'fake-assistant-call'), 'utf8');
  ok(callLog.includes('--session-id ') && !callLog.includes('--resume') && callLog.includes('--setting-sources project') && callLog.includes('--allowedTools Read Grep Glob Bash(gh issue view:*)')
    && callLog.includes(`--add-dir ${PROJ} --add-dir ${PROJ2}`) && callLog.includes('--max-turns 8') && callLog.includes('--include-partial-messages'),
    'the first turn starts a session with read-only tools, project settings only, and the projects as extra folders', callLog.split('\n')[0]);
  ok(callLog.includes('API_KEY=<unset> NESTED=<unset>'), 'the assistant runs without the API key and outside the parent session');
  ok(callLog.includes('Console snapshot, taken now:') && callLog.includes(`[${A}] #12 Google sign-in`) && callLog.includes('This chat is about cartridge') && /Its notebook \(plans\/\): .*00-spec\.md/.test(callLog),
    'the system prompt carries the console snapshot and the open cartridge', callLog.slice(callLog.indexOf('system:'), callLog.indexOf('system:') + 300));
  ok([path.join(TMP, 'scan'), TMP].some(d => callLog.includes(`cwd: ${d}\n`)), 'it reads from the scan root, or the folder above the projects', callLog.split('\n')[1]);
  const act1 = (await api('assistant/act', { conversation: C1, message: 1, index: 0 })).body;
  ok(act1.ok && act1.url === 'https://github.com/acme/app/issues/21' && act1.note.includes('#21') && /issue create --title Export reports as CSV/.test(fs.readFileSync(GH_LOG, 'utf8')),
    'tapping the card creates the issue through gh', act1);
  ok((await api('assistant/act', { conversation: C1, message: 1, index: 0 })).status === 400, 'a used card cannot run twice');
  const s2 = await sse({ conversation: C1, text: 'start it' });
  const d2 = s2.events.find(e => e.type === 'done');
  ok(d2 && d2.data.message.text.includes('Echo: start it (turn 2), earlier: Can we file an issue'), 'the second message resumes the same session', d2 && d2.data.message.text);
  const callLog2 = fs.readFileSync(path.join(HOME_CLAUDE, 'fake-assistant-call'), 'utf8');
  ok(callLog2.includes('--resume ') && callLog2.includes('prompt: Console: Created issue #21 in app: https://github.com/acme/app/issues/21\n\nstart it'),
    'the second turn resumes and tells the assistant what the card did', callLog2.split('\n').slice(0, 1).concat(callLog2.slice(callLog2.indexOf('prompt:'), callLog2.indexOf('prompt:') + 120)));
  const conv = (await api(`assistant/get?id=${C1}`)).body;
  ok(conv.messages.map(m => m.role).join(',') === 'user,assistant,note,user,assistant' && conv.title === 'Can we file an issue for CSV export?' && conv.costUSD === 0.0246,
    'the chat keeps messages, replies and notes, with its total cost', { roles: conv.messages.map(m => m.role), title: conv.title, cost: conv.costUSD });
  const act2 = (await api('assistant/act', { conversation: C1, message: 4, index: 0 })).body;
  const c15 = act2.made && await cartOf(act2.made[0].id);
  ok(act2.ok && c15 && c15.title === 'Nightly CSV export' && c15.flow === 'quick' && !c15.running && act2.note.includes('not started yet'), 'a start-work card adds a quick-flow cartridge without starting it', act2);
  ok(readJSON(path.join(CONFIG, 'usage.json')).rate_limits.seven_day.used_percentage === 42, 'rate limit events update the plan usage');
  ok((await api('assistant/get?id=../x')).status === 400 && (await api('assistant/get?id=0123456789ab')).status === 500, 'chat ids are validated');
  ok((await sse({ text: 'broken card' })).events.find(e => e.type === 'done').data.message.actions.length === 0, 'a card without the fields it needs is dropped');
  const list = (await api('assistant/list')).body.conversations;
  ok(list.length === 2 && list[0].title === 'broken card' && list[1].id === C1, 'the chat list, newest first', list);
  fs.rmSync(path.join(HOME_CLAUDE, 'fake-sessions'), { recursive: true, force: true }); // Claude lost the sessions
  const lost = (await sse({ conversation: C1, text: 'still there?' })).events.find(e => e.type === 'error');
  ok(lost && lost.data.error.includes('No conversation found') && (await api(`assistant/get?id=${C1}`)).body.messages.length === 6, 'a lost session is reported, and the unanswered question is not kept', lost);
  const failed = (await sse({ text: 'fail on purpose' })).events;
  const gone = failed.find(e => e.type === 'open').data.conversation;
  ok(failed.find(e => e.type === 'error').data.error.includes('API Error: 500 boom') && (await api(`assistant/get?id=${gone}`)).status === 500 && (await api('assistant/list')).body.conversations.length === 2,
    'a new chat whose first answer failed shows the error and is removed', failed.map(e => e.type));
  ok((await api('assistant/delete', { id: list[0].id })).body.ok && (await api('assistant/list')).body.conversations.length === 1, 'delete removes a chat');
  ok((await api('assistant/clear', {})).body.ok && (await api('assistant/list')).body.conversations.length === 0, 'clear removes them all');
  const page = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  ok(page.includes('id="fab-asst"') && page.includes('<dialog id="asst"') && page.includes('id="asst-form"'), 'the page has the assistant button and sheet');

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

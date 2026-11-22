#!/usr/bin/env node
// PreToolUse hook installed by Claude Team UI in each cartridge's .claude/settings.local.json.
// Acts only inside sessions the tool started (CTU_CART is set); the user's own sessions are untouched.
// Exit 2 blocks the tool call and shows stderr to the agent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.CTU_CART) process.exit(0);

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const tool = String(input.tool_name || '');
const ti = input.tool_input || {};
const cartDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
let state = {};
try { state = JSON.parse(fs.readFileSync(path.join(cartDir, '.claude', 'team-ui', 'state.json'), 'utf8')); } catch {}
const projectDir = state.projectDir || cartDir;

const inside = (dir, p) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const block = msg => { process.stderr.write(msg + '\n'); process.exit(2); };
const secretEnv = p => { const b = path.basename(p); return /^\.env(\..+)?$/.test(b) && !/^\.env\.(example|sample|template|dist)$/.test(b); };
// The other projects this team may read and never write (D68)
const otherProjects = Array.isArray(state.otherProjects) ? state.otherProjects.map(String) : [];
// Each team writes only in its own cartridge: not elsewhere in its project (the main checkout), not in other cartridges,
// not in the other projects. A fenced folder that holds the cartridge (the project, the worktrees folder) is fenced
// only outside it; one inside the cartridge (a home cartridge's worktrees, a nested project) is fenced everywhere.
const fenced = [projectDir, path.join(projectDir, '.claude', 'worktrees'), path.join(projectDir, '.claude', 'research'), ...otherProjects];
const fencedOff = p => fenced.some(d => inside(d, p) && !(inside(d, cartDir) && inside(cartDir, p)));

if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
  const target = ti.file_path || ti.notebook_path;
  if (!target) process.exit(0);
  const abs = path.resolve(input.cwd || cartDir, String(target));
  const ui = path.join(cartDir, '.claude');
  if (abs === path.join(ui, 'settings.local.json') || inside(path.join(ui, 'team-ui'), abs)) {
    block('Blocked by Claude Team UI: this file controls the cartridge and only the user changes it.');
  }
  if (fencedOff(abs)) block(`Blocked by Claude Team UI: this team may only write inside its own folder ${cartDir}.`);
  if (state.mode === 'planning' && inside(cartDir, abs) && !inside(path.join(cartDir, 'plans'), abs)) {
    block('Blocked by Claude Team UI: the cartridge is in planning mode, so only plans/ is writable. '
      + 'Write your output under plans/, or ask the user to switch the cartridge to code mode.');
  }
}

if (tool === 'Read' && ti.file_path) {
  const abs = path.resolve(input.cwd || cartDir, String(ti.file_path));
  if (secretEnv(abs)) block('Blocked by Claude Team UI: .env files hold secrets and are not readable by agents.');
  if (inside(path.join(os.homedir(), '.config', 'claude-team-ui'), abs)) block('Blocked by Claude Team UI: tool credentials.');
}

// gh subcommands that change something on GitHub; reading (view, list, diff, status, checks) stays allowed
const GH_WRITES = {
  pr: ['create', 'merge', 'close', 'comment', 'edit', 'review', 'ready', 'reopen', 'lock', 'unlock'],
  issue: ['create', 'close', 'comment', 'edit', 'delete', 'reopen', 'transfer', 'lock', 'unlock', 'pin', 'unpin', 'develop'],
  release: ['create', 'delete', 'edit', 'upload'], repo: ['create', 'delete', 'edit', 'fork', 'rename', 'archive', 'sync'],
  workflow: ['run', 'enable', 'disable'], run: ['cancel', 'rerun', 'delete'], secret: ['set', 'delete'], variable: ['set', 'delete'],
  label: ['create', 'edit', 'delete', 'clone'], gist: ['create', 'edit', 'delete'],
};
// A command that names a path in another project, or runs there after a cd, must only read (D68). Best effort: it
// follows cd between segments, not a subshell or a script that changes folder.
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'ls', 'tree',
  'wc', 'diff', 'cmp', 'file', 'stat', 'du', 'jq', 'yq', 'sed', 'awk', 'sort', 'uniq', 'cut', 'tr', 'nl', 'column', 'od',
  'xxd', 'realpath', 'readlink', 'basename', 'dirname', 'echo', 'printf', 'test', '[', 'cd', 'pwd', 'shasum']);
const GIT_READS = new Set(['show', 'log', 'diff', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'blame',
  'cat-file', 'describe', 'status', 'shortlog', 'for-each-ref', 'merge-base', 'name-rev']);
const FIND_WRITES = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls']);
const REDIRECT = /^(\d?>>?|&>>?)/;
const word = t => t.replace(/^['"]|['"]$/g, '').replace(REDIRECT, '').replace(/^<|^-[^=]*=/, '').replace(/^['"]|['"]$/g, '');
const resolveIn = (here, t) => (t.startsWith('~') ? path.join(os.homedir(), t.slice(1)) : path.resolve(here, t));
const isOther = p => otherProjects.some(d => inside(d, p));
const gitSub = a => { let i = 1; while (i < a.length && a[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(a[i]) ? 2 : 1; return a[i]; };
function writesOther(tok, here) {
  const words = tok.map(word);
  const there = isOther(here); // inside another project, a bare name is a path there too
  const inOther = t => !!t && !t.startsWith('-') && (there || /^[~./]/.test(t)) && isOther(resolveIn(here, t));
  if (!there && !words.some(inOther)) return false;
  const redirected = tok.some((t, i) => REDIRECT.test(t) && inOther(word(t.replace(REDIRECT, '') || tok[i + 1] || '')));
  const args = words.slice(Math.max(0, words.findIndex(t => !/^[A-Za-z_]\w*=/.test(t))));
  const name = path.basename(args[0] || '');
  if (redirected) return true;
  if (name === 'git') return !GIT_READS.has(gitSub(args));
  if (name === 'sed') return args.some(t => /^-[a-zA-Z]*i|^--in-place/.test(t));
  if (name === 'find') return args.some(t => FIND_WRITES.has(t));
  if (['cp', 'rsync', 'ln'].includes(name)) return inOther(args[args.length - 1]); // copying from another project is a read
  return !READERS.has(name);
}

// Codex runs only as `codex exec --sandbox read-only` writing its answer under plans/ (D71). The guard sees Claude's tool
// calls, not what Codex does, and full auto allows permission prompts, so a writable Codex could push or edit unseen.
const CODEX_VALUE_FLAGS = new Set(['-s', '--sandbox', '-c', '--config', '-m', '--model', '-o', '--output-last-message', '-C',
  '--cd', '-i', '--image', '--output-schema', '--color', '--base', '--commit', '--title']);
const CODEX_ALLOWED = new Set([...CODEX_VALUE_FLAGS, '--ephemeral', '--skip-git-repo-check', '--json', '--uncommitted', '--strict-config', '-h', '--help']);
const CODEX_CONFIG_KEYS = new Set(['forced_login_method', 'model', 'model_reasoning_effort']);
// The command as a shell splits it: quotes keep a prompt one word, and ; & | newline ( ) ` end a command only outside them
function shellSegments(cmd) {
  const segs = [[]];
  let cur = '', q = null, has = false;
  const end = () => { if (cur || has) segs[segs.length - 1].push(cur); cur = ''; has = false; };
  for (const ch of String(cmd)) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; } else if (/[;&|\n()`]/.test(ch)) { end(); segs.push([]); } else if (/\s/.test(ch)) end(); else cur += ch;
  }
  end();
  return segs.filter(w => w.length);
}
// Launchers that would run codex out of the guard's sight; codex must be the command word itself
const CODEX_LAUNCHERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'timeout', 'gtimeout', 'nice', 'stdbuf', 'xargs', 'sudo', 'sh', 'bash', 'zsh', 'npx', 'bunx']);
const namesCodex = t => path.basename(t) === 'codex' || /@openai\/codex/.test(t) || /(^|[\s/])codex(\s|$)/.test(t);
function codexCheck(cmd) {
  let here = input.cwd || cartDir;
  for (const w of shellSegments(cmd)) {
    const at = w.findIndex(t => !/^[A-Za-z_]\w*=/.test(t)); // past VAR=value
    const name = at < 0 ? '' : path.basename(w[at]);
    if (name === 'cd') { if (w[at + 1] && w[at + 1] !== '-') here = resolveIn(here, w[at + 1]); continue; }
    if (name === 'codex') { const p = at > 0 ? 'a variable set before codex' : codexProblem(w, here); if (p) return p; continue; }
    const viaPm = ['pnpm', 'yarn', 'npm', 'bun'].includes(name) && ['dlx', 'exec', 'x'].includes(w[at + 1]);
    const lookup = name === 'command' && /^-[vV]$/.test(w[at + 1] || '');
    if (!lookup && (CODEX_LAUNCHERS.has(name) || viaPm) && w.slice(at + 1).some(namesCodex)) return `codex through ${name}`;
  }
  return '';
}
function codexProblem(a, here) {
  const sub = a[1];
  if (['--version', '-V', '--help', '-h'].includes(sub) || (sub === 'login' && a[2] === 'status')) return '';
  if (sub !== 'exec') return `codex ${sub || ''}`.trim();
  let sandbox = null, out = null, words = 0;
  for (let i = 2; i < a.length; i++) {
    const [flag, inline] = a[i].startsWith('--') && a[i].includes('=') ? [a[i].slice(0, a[i].indexOf('=')), a[i].slice(a[i].indexOf('=') + 1)] : [a[i], null];
    if (!flag.startsWith('-') || flag === '-') { // the subcommand, or the prompt
      if (words++ === 0 && ['resume', 'fork'].includes(flag)) return `codex exec ${flag}`;
      continue;
    }
    if (!CODEX_ALLOWED.has(flag)) return flag;
    const value = CODEX_VALUE_FLAGS.has(flag) ? (inline ?? a[++i] ?? '') : '';
    if (flag === '-s' || flag === '--sandbox') { if (sandbox !== null) return 'a second --sandbox'; sandbox = value; }
    if (flag === '-o' || flag === '--output-last-message') { if (out !== null) return 'a second -o'; out = value; }
    if ((flag === '-c' || flag === '--config') && !CODEX_CONFIG_KEYS.has(value.split('=')[0])) return `-c ${value.split('=')[0]}`;
  }
  if (sandbox !== 'read-only') return 'a sandbox other than read-only';
  if (out !== null && !inside(path.join(cartDir, 'plans'), resolveIn(here, out))) return '-o outside plans/';
  return '';
}

if (tool === 'Bash' && ti.command) {
  const codex = codexCheck(ti.command);
  if (codex) block(`Blocked by Claude Team UI: agents run Codex only directly, as codex exec --sandbox read-only with -o under plans/ (not ${codex}).`);
  let here = input.cwd || cartDir;
  for (const seg of String(ti.command).split(/[;&|\n()`]+/)) {
    const tok = seg.trim().split(/\s+/).filter(Boolean);
    const cmd = tok[0] ? path.basename(tok[0]) : '';
    if (tok.map(word).some(secretEnv)) block('Blocked by Claude Team UI: .env files hold secrets and are not readable by agents.');
    if (writesOther(tok, here)) block('Blocked by Claude Team UI: the other projects are read only for this team. Read them; change files only inside your own folder.');
    if (cmd === 'cd' && tok[1] && tok[1] !== '-') here = resolveIn(here, word(tok[1]));
    if (cmd === 'sudo') block('Blocked by Claude Team UI: no sudo.');
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) && tok.includes('publish')) block('Blocked by Claude Team UI: agents never publish packages.');
    if (cmd === 'gh') {
      const [sub, act] = [tok[1], tok[2]];
      if ((GH_WRITES[sub] || []).includes(act)) block(`Blocked by Claude Team UI: agents do not change GitHub (gh ${sub} ${act}). Write what you would post into plans/ instead.`);
      if (sub === 'api') {
        const m = tok.findIndex(t => t === '-X' || t === '--method');
        const method = (m > -1 ? tok[m + 1] : (tok.find(t => /^--method=/.test(t)) || '').split('=')[1] || '').toUpperCase();
        if ((method && method !== 'GET') || tok.some(t => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(t))) block('Blocked by Claude Team UI: agents only read from the GitHub API.');
      }
    }
    const at = tok.findIndex(t => path.basename(t) === 'git');
    // Repo hooks (pre-commit checks, secret scans) always run: no --no-verify, -n, HUSKY=0 or another hooks path
    if (at > -1 && (tok.includes('--no-verify') || /core\.hookspath/i.test(seg) || tok.slice(0, at).some(t => /^HUSKY=0$/.test(t))
      || (tok.includes('commit') && tok.some(t => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(t))))) { // git commit -n is --no-verify
      block('Blocked by Claude Team UI: the repo\'s hooks must run. Fix what they report instead of skipping them.');
    }
    if (at > -1) {
      let i = at + 1;
      while (i < tok.length && tok[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(tok[i]) ? 2 : 1;
      if (tok[i] === 'push') block('Blocked by Claude Team UI: agents never push. Commit, then tell the user to push from the console: Open a pull request, Push to the pull request, or Push fixes to the PR in a review.');
    }
    if (tok[0] && path.basename(tok[0]) === 'rm') {
      const flags = tok.filter(t => t.startsWith('-')).join(' ');
      const recursive = /(^|\s)-[a-zA-Z]*[rR]|--recursive/.test(flags);
      const force = /(^|\s)-[a-zA-Z]*f|--force/.test(flags);
      if (recursive && force) block('Blocked by Claude Team UI: rm -rf is not allowed. Delete specific files instead.');
    }
  }
}

process.exit(0);

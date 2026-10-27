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

if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
  const target = ti.file_path || ti.notebook_path;
  if (!target) process.exit(0);
  const abs = path.resolve(input.cwd || cartDir, String(target));
  const ui = path.join(cartDir, '.claude');
  if (abs === path.join(ui, 'settings.local.json') || inside(path.join(ui, 'team-ui'), abs)) {
    block('Blocked by Claude Team UI: this file controls the cartridge and only the user changes it.');
  }
  // Each team writes only in its own cartridge: not in the main checkout, not in other cartridges.
  const others = [path.join(projectDir, '.claude', 'worktrees'), path.join(projectDir, '.claude', 'research')];
  if (!inside(cartDir, abs) && (inside(projectDir, abs) || others.some(d => inside(d, abs)))) {
    block(`Blocked by Claude Team UI: this team may only write inside its own folder ${cartDir}.`);
  }
  if (state.mode === 'planning' && inside(cartDir, abs) && !inside(path.join(cartDir, 'plans'), abs)) {
    block('Blocked by Claude Team UI: the cartridge is in planning mode, so only plans/ is writable. '
      + 'Write your output under plans/, or ask the user to switch the cartridge to code mode.');
  }
}

if (tool === 'Read' && ti.file_path) {
  const abs = path.resolve(input.cwd || cartDir, String(ti.file_path));
  const base = path.basename(abs);
  if (/^\.env(\..+)?$/.test(base) && !/^\.env\.(example|sample|template|dist)$/.test(base)) {
    block('Blocked by Claude Team UI: .env files hold secrets and are not readable by agents.');
  }
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
if (tool === 'Bash' && ti.command) {
  for (const seg of String(ti.command).split(/[;&|\n()`]+/)) {
    const tok = seg.trim().split(/\s+/).filter(Boolean);
    const cmd = tok[0] ? path.basename(tok[0]) : '';
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
      if (tok[i] === 'push') block('Blocked by Claude Team UI: agents never push. The user opens the PR from the console.');
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

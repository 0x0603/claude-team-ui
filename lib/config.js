'use strict';
// Runtime settings (argv/env) and the persisted config file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readJSONSync, writeJSONSync, realpath, slugify } = require('./util');

function argVal(name, def) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function argAll(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === name && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}

const LAN = process.argv.includes('--lan') || process.env.TEAM_UI_LAN === '1';
// --tailscale: reachable from the tailnet only (plus this Mac); the owner's own devices need no token
const TAILSCALE = process.argv.includes('--tailscale') || process.env.TEAM_UI_TAILSCALE === '1';
const RUNTIME = {
  port: Number(argVal('--port', process.env.TEAM_UI_PORT || 7700)),
  host: argVal('--host', LAN || TAILSCALE ? '0.0.0.0' : '127.0.0.1'),
  tailscale: TAILSCALE,
  sessionPrefix: process.env.TEAM_UI_SESSION || 'ctu',
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  claudeHome: process.env.CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  ntfy: process.env.NTFY_URL || '',
  softLimit: Number(process.env.TEAM_UI_SOFT_LIMIT || 3),
  configDir: process.env.TEAM_UI_CONFIG_DIR || path.join(os.homedir(), '.config', 'claude-team-ui'),
  projectArgs: argAll('--project'),
};

// questionTimeoutMin: minutes a lead's mid-step question waits for the user before it is told to decide (0 = never)
// idlePowerOffMin: minutes a cartridge may sit waiting for the user before it is powered off (0 = never)
// hibernateDays: days a powered-off cartridge may sit untouched before Tidy up offers to drop its build output
// ramWarnPct: share of the Mac's memory taken by Claude processes that turns the home line red
// defaultBudgetUSD: cost at which autopilot pauses a cartridge before its next step (0 = no budget); quotaPausePct: plan usage that pauses every cartridge
const DEFAULTS = {
  projects: [], models: { strong: 'opus', fast: 'sonnet' }, scanRoots: [], prFooter: '', questionTimeoutMin: 15,
  idlePowerOffMin: 120, hibernateDays: 7, ramWarnPct: 70, defaultBudgetUSD: 0, quotaPausePct: 90,
};
const MODEL_RE = /^[a-z0-9.\-[\]]{1,60}$/i;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
// Variables a project adds to its sessions, setup and clean-up: never the API key, nothing of Claude Code's own, not the
// cartridge id the guard hook relies on. Text is "KEY=VALUE" per line (# starts a comment); an object comes from an import.
function envMap(input) {
  const obj = typeof input === 'string'
    ? Object.fromEntries(input.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => { const i = l.indexOf('='); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1)] : [l, '']; }))
    : input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!ENV_KEY_RE.test(k) || /^(ANTHROPIC_|CLAUDE|CTU_)/.test(k)) throw new Error(`Not allowed as a variable name: ${k}`);
    if (Object.keys(out).length >= 20) throw new Error('At most 20 variables per project');
    out[k] = String(v == null ? '' : v).replace(/[\0\r\n]/g, '').slice(0, 300);
  }
  return out;
}

class Config {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    const raw = readJSONSync(this.file) || {};
    this.data = { ...DEFAULTS, ...raw, models: { ...DEFAULTS.models, ...(raw.models || {}) } };
  }
  save() { writeJSONSync(this.file, this.data); }
  get projects() { return this.data.projects; }
  get models() { return this.data.models; }
  get scanRoots() { return this.data.scanRoots; }
  get prFooter() { return String(this.data.prFooter || ''); } // a last line for every pull request the console opens

  addProject(dir) {
    const p = realpath(dir);
    const found = this.projects.find(x => x.path === p);
    if (found) return found;
    let id = slugify(path.basename(p), 24);
    for (let n = 2; this.projects.some(x => x.id === id); n++) id = `${slugify(path.basename(p), 21)}-${n}`;
    const rec = { id, path: p, testCommand: '', setupCommand: '', cleanCommand: '', env: {} };
    this.projects.push(rec);
    this.save();
    return rec;
  }
  removeProject(id) {
    this.data.projects = this.projects.filter(x => x.id !== id);
    this.save();
  }
  updateProject(id, patch) {
    const p = this.projects.find(x => x.id === id);
    if (!p) throw new Error('Unknown project');
    if (patch.testCommand != null) p.testCommand = String(patch.testCommand).slice(0, 300);
    // Runs once in every new worktree (install, build), before the first step
    if (patch.setupCommand != null) p.setupCommand = String(patch.setupCommand).trim().slice(0, 500);
    // What Tidy up runs to hibernate a worktree; empty means node_modules, .turbo, dist and .next go
    if (patch.cleanCommand != null) p.cleanCommand = String(patch.cleanCommand).trim().slice(0, 500);
    if (patch.env != null) p.env = envMap(patch.env);
    if (patch.node != null) {
      const v = String(patch.node).trim();
      if (v && !/^v?\d+(\.\d+){0,2}$/.test(v)) throw new Error('Node version looks like 24, 22.12 or v24.1.0');
      p.node = v;
    }
    this.save();
    return p;
  }
  setModels(m) {
    for (const k of ['strong', 'fast']) {
      if (m[k] != null) {
        if (!MODEL_RE.test(m[k])) throw new Error(`Invalid model name: ${m[k]}`);
        this.data.models[k] = m[k];
      }
    }
    this.save();
  }

  // Login token: env, or generated once and kept with mode 600
  token() {
    if (process.env.TEAM_UI_TOKEN) return process.env.TEAM_UI_TOKEN;
    const f = path.join(this.dir, 'token');
    try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
    const t = crypto.randomBytes(18).toString('base64url');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(f, t, { mode: 0o600 });
    return t;
  }
}

module.exports = { RUNTIME, Config, MODEL_RE, envMap };

'use strict';
// The build lane (D63): installs, builds and tests from every cartridge on this Mac take turns, so several teams never
// run their heavy commands at once. A slot is a folder made with mkdir, which is atomic across processes; its
// owner.json names the holder. A holder whose process is gone, or that held its slot past MAX_HOLD_MS, counts as dead.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const GIB = 1024 ** 3;
const MAX_HOLD_MS = 60 * 60000;
const POLL_MS = Number(process.env.CTU_LANE_POLL_MS) || 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// One slot per 16 GB of memory unless the user set a number
const autoSlots = () => Math.max(1, Math.floor(os.totalmem() / (16 * GIB)));

// Package-manager commands that only read or print stay out of the lane, and so do servers and watchers, which would
// hold a slot for as long as they live. Everything else a package manager runs (install, scripts, test runners) waits.
const LIGHT_SUBS = new Set(['help', 'why', 'ls', 'list', 'll', 'la', 'outdated', 'view', 'info', 'show', 'v', 'config', 'c', 'get',
  'set', 'bin', 'root', 'prefix', 'store', 'licenses', 'audit', 'whoami', 'ping', 'search', 'home', 'docs', 'repo', 'bugs',
  'explain', 'env', 'completion', 'doctor', 'cache']);
const LIGHT_TOOLS = new Set(['biome', 'prettier', 'lint-staged', 'changeset', 'commitlint', 'git', 'which']);
const LONG_LIVED = /^(dev|start|serve|watch|preview|storybook)(:|$)/;
const VALUE_FLAGS = new Set(['-C', '--dir', '--filter', '-F', '--prefix', '--cwd', '--workspace', '--reporter', '--loglevel']);
function heavyCommand(tool, args) {
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith('-')) words.push(a);
  }
  if (!words.length) return tool === 'yarn' && !args.some(a => /^(-v|--version|-h|--help)$/.test(a)); // bare yarn installs
  let [sub, next] = words;
  if (tool === 'npx') [sub, next] = ['exec', sub];
  if (LIGHT_SUBS.has(sub)) return false;
  if (['exec', 'dlx', 'x'].includes(sub)) return !LIGHT_TOOLS.has(path.basename(next || ''));
  return !LONG_LIVED.test((sub === 'run' || sub === 'run-script' ? next : sub) || '');
}

class Lane {
  constructor(dir) { this.dir = dir; }
  get configFile() { return path.join(this.dir, 'config.json'); }
  // The console writes the slot count (buildSlots, 0 = one per 16 GB); every holder reads it, so a change applies at once
  configure(slots) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.configFile, JSON.stringify({ slots: Number(slots) >= 1 ? Math.floor(slots) : autoSlots() }) + '\n');
  }
  slots() {
    try { const n = Number(JSON.parse(fs.readFileSync(this.configFile, 'utf8')).slots); if (n >= 1) return Math.min(16, Math.floor(n)); } catch {}
    return autoSlots();
  }
  slotDir(i) { return path.join(this.dir, `slot-${i}`); }
  owner(i) { try { return JSON.parse(fs.readFileSync(path.join(this.slotDir(i), 'owner.json'), 'utf8')); } catch { return null; } }
  // Nobody really holds it: the process is gone, it is past the limit, or it never got an owner (a crash right after mkdir)
  dead(i) {
    const o = this.owner(i);
    if (o) return !pidAlive(o.pid) || Date.now() - o.at > MAX_HOLD_MS;
    try { return Date.now() - fs.statSync(this.slotDir(i)).mtimeMs > 10000; } catch { return false; }
  }
  take(i, base) {
    const d = this.slotDir(i);
    try { fs.mkdirSync(d); } catch (e) {
      if (e.code !== 'EEXIST' || !this.dead(i)) return false;
      // A dead slot is renamed away first: only one waiter wins the rename, so two never both take it over
      try { fs.renameSync(d, `${d}.dead-${base.token}`); } catch { return false; }
      fs.rmSync(`${d}.dead-${base.token}`, { recursive: true, force: true });
      try { fs.mkdirSync(d); } catch { return false; }
    }
    fs.writeFileSync(path.join(d, 'owner.json'), JSON.stringify({ ...base, at: Date.now() }));
    return true;
  }
  give(i, token) {
    const o = this.owner(i);
    if (o && o.token === token) fs.rmSync(this.slotDir(i), { recursive: true, force: true });
  }
  // Live holders, oldest first, for the home screen and the waiting message
  holders() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter(n => /^slot-\d+$/.test(n)); } catch {}
    return names.map(n => Number(n.slice(5))).filter(i => !this.dead(i)).map(i => this.owner(i)).filter(Boolean)
      .map(o => ({ cart: o.cart, cmd: o.cmd, at: o.at, token: o.token })).sort((a, b) => a.at - b.at);
  }
  static describe(holders) {
    const age = h => { const m = Math.round((Date.now() - h.at) / 60000); return m < 1 ? 'under a minute' : `${m} min`; };
    return holders.map(h => `${h.cart || 'another job'} runs "${h.cmd}" (${age(h)})`).join('; ') || 'a slot is being freed';
  }
  // Waits for a slot (every slot when exclusive) and returns the function that gives it back. `onWait` hears the
  // holders on each poll; `until` returning true stops the wait, and acquire then resolves to null.
  async acquire(who, { exclusive = false, onWait, until } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    const base = { pid: who.pid || process.pid, cart: who.cart || '', cmd: String(who.cmd || '').slice(0, 120), token: crypto.randomBytes(6).toString('hex') };
    const held = [];
    const release = () => { for (const i of held.splice(0)) this.give(i, base.token); };
    for (;;) {
      const n = this.slots();
      for (let i = 0; i < n && (exclusive || !held.length); i++) if (!held.includes(i) && this.take(i, base)) held.push(i);
      if (held.length && (!exclusive || held.length >= n)) return release;
      if (until && until()) { release(); return null; }
      if (onWait) onWait(this.holders().filter(h => h.token !== base.token));
      await sleep(POLL_MS);
    }
  }
}

module.exports = { Lane, heavyCommand };

'use strict';
// Tidy up: what cartridges, archives and leftovers take on disk, what can go, and the actions that free it.
// Sizes come from du in the background and are cached; nothing here deletes without a tidy action the user ticked.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { run, firstLine, statSafe, readJSONSync, folderSize, realpath, inside } = require('./util');
const GH = require('./github');
const { cleanTargets } = require('./cartridges');

const CACHE_MS = 10 * 60000;
const ARCHIVE_DAYS = 180;
const DAY_MS = 86400000;
const BRANCH_RE = /^[\w./-]{1,120}$/;

const sizeOf = async (dir, rels) => { let n = 0; for (const r of rels) n += await folderSize(path.join(dir, r)); return n; };
const ls = async d => { try { return await fsp.readdir(d); } catch { return []; } };
const isRealDir = async p => { try { return (await fsp.lstat(p)).isDirectory(); } catch { return false; } }; // a symlink is never one

class Tidy {
  constructor({ registry, config, claudeHome }) {
    this.registry = registry;
    this.config = config;
    this.claudeHome = claudeHome;
    this.cache = null;
    this.running = null;
    this.pnpm = null;
  }
  cached() { return this.cache; }
  forget() { this.cache = null; }
  // The report, cached for ten minutes; a stale one is returned while a new one is computed, unless fresh is asked
  async report({ fresh = false } = {}) {
    if (!fresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache;
    if (fresh && this.running) await this.running.catch(() => {}); // a pass already under way may predate what changed
    if (!this.running) this.running = this.compute().then(r => { this.cache = r; return r; }).finally(() => { this.running = null; });
    return fresh || !this.cache ? this.running : this.cache;
  }

  async compute() {
    const days = Number(this.config.data.hibernateDays) || 0;
    const now = Date.now();
    if (this.pnpm == null) this.pnpm = (await run('pnpm', ['--version'])).ok;
    const carts = [], projects = [];
    for (const p of this.registry.projects()) {
      const mine = this.registry.cartridges().filter(c => c.project.id === p.id);
      const known = new Set(mine.map(c => realpath(c.dir)));
      for (const c of mine) {
        const s = c.state();
        const running = await c.running();
        const bytes = c.home ? 0 : await folderSize(c.dir);
        const idleMs = now - lastActivity(c, s);
        const done = c.phases.every(ph => s.phases[ph.id] === 'done');
        let finished = null;
        if (!c.home && !running) {
          // Its own pull request, or for a review the pull request it reviews
          const pr = c.rec.prUrl || (c.kind === 'review' && /^https:\/\/[^\s]+\/pull\/\d+$/.test(c.rec.url || '') ? c.rec.url : null);
          if (pr) { try { const st = await GH.prState(p.path, pr); if (st.state !== 'OPEN') finished = `PR ${st.state.toLowerCase()}`; } catch {} }
          if (!finished && done && c.kind === 'team' && !c.rec.prUrl && c.rec.branch && await this.pushed(p, c.rec.branch)) finished = 'done, branch pushed';
          if (!finished && done && c.kind !== 'team') finished = 'done';
        }
        const hibernate = !c.home && c.kind !== 'research' && !running && !s.hibernated && days > 0 && idleMs >= days * DAY_MS;
        // What each action would free: an eject the whole worktree (research folders stay), hibernating its packages and build output
        const cleanBytes = hibernate && !finished ? await sizeOf(c.dir, await cleanTargets(c.dir)) : 0;
        carts.push({
          id: c.id, title: c.title, project: p.id, projectName: p.name, kind: c.kind, home: c.home, bytes, running, idleMs, finished, hibernate,
          hibernated: s.hibernated || null, cleanBytes, freeBytes: finished ? (c.kind === 'research' ? 0 : bytes) : hibernate ? cleanBytes : 0,
        });
      }
      // Folders no cartridge owns: a worktree left behind (clean ones only are offered ticked), a research folder kept by an eject
      const orphans = [];
      for (const kind of ['worktrees', 'research']) {
        const base = path.join(p.path, '.claude', kind);
        for (const n of await ls(base)) {
          const d = path.join(base, n);
          if (!(await isRealDir(d)) || known.has(realpath(d))) continue;
          orphans.push({ path: d, kind, bytes: await folderSize(d), dirty: kind === 'worktrees' ? await dirtyWorktree(d) : false });
        }
      }
      // The main checkout's setup log stays in the project's tool folder after that cartridge is ejected
      const logs = [];
      if (!mine.some(c => c.home)) {
        const f = path.join(p.uiDir, 'setup.log');
        const st = await statSafe(f);
        if (st && st.isFile()) logs.push({ path: f, bytes: st.size });
      }
      const archives = [];
      const arch = path.join(p.uiDir, 'archive');
      for (const n of await ls(arch)) {
        const d = path.join(arch, n);
        const st = await statSafe(d);
        if (st && st.isDirectory() && now - st.mtimeMs > ARCHIVE_DAYS * DAY_MS) archives.push({ path: d, bytes: await folderSize(d), mtime: st.mtimeMs });
      }
      const archiveBytes = await folderSize(arch);
      const wl = await p.git('worktree', 'list', '--porcelain');
      const prunable = wl.ok ? (wl.stdout.match(/^prunable\b/gm) || []).length : 0;
      const branches = [], seen = new Set();
      for (const e of this.ejected(p).slice(0, 50)) {
        if (!e.branch || seen.has(e.branch) || !(await this.localBranch(p, e.branch))) continue;
        seen.add(e.branch);
        const m = await this.branchInfo(p, e);
        if (m.merged) branches.push({ branch: e.branch, title: e.title, why: m.why, prMerged: m.prMerged, remoteExists: m.remoteExists, prUrl: e.prUrl || null });
      }
      projects.push({ id: p.id, name: p.name, orphans, logs, archives, archiveBytes, prunable, branches, pnpm: !!this.pnpm });
    }
    let claudeBytes = 0;
    try { claudeBytes = await folderSize(path.join(this.claudeHome, 'projects')); } catch {}
    const sum = l => l.reduce((n, x) => n + (x.bytes || 0), 0);
    const totals = {
      cartridges: sum(carts), archives: projects.reduce((n, p) => n + p.archiveBytes, 0), claudeProjects: claudeBytes,
      // What the actions ticked by default free: finished cartridges, hibernation, clean orphan worktrees, old setup logs
      freeable: carts.reduce((n, c) => n + c.freeBytes, 0) + sum(projects.flatMap(p => [...p.orphans.filter(o => o.kind === 'worktrees' && !o.dirty), ...p.logs])),
    };
    return { at: now, carts, projects, totals, hibernateDays: days };
  }

  ejected(p) { const l = readJSONSync(path.join(p.uiDir, 'ejected.json')); return Array.isArray(l) ? l.filter(e => e && e.id) : []; }
  async localBranch(p, b) { return (await p.git('rev-parse', '--verify', '--quiet', `refs/heads/${b}`)).ok; }
  async remoteBranch(p, b) { return (await p.git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`)).ok; }
  async pushed(p, b) {
    if (!(await this.remoteBranch(p, b))) return false;
    const r = await p.git('rev-list', '--count', `origin/${b}..${b}`);
    return r.ok && r.stdout.trim() === '0';
  }
  // Is the branch merged: the pull request says so, or the base contains its tip
  async branchInfo(p, { branch, base, prUrl }) {
    const out = { branch, merged: false, prMerged: false, why: '', remoteExists: await this.remoteBranch(p, branch) };
    if (prUrl) {
      try { const st = await GH.prState(p.path, prUrl); out.merged = out.prMerged = st.state === 'MERGED'; out.why = st.state === 'MERGED' ? 'the pull request is merged' : `the pull request is ${st.state.toLowerCase()}`; }
      catch (e) { out.why = e.message; }
      if (out.merged) return out;
    }
    if (base) {
      const r = await p.git('branch', '--merged', base, '--list', branch);
      if (r.ok && r.stdout.trim()) { out.merged = true; out.why = `${base} contains it`; return out; }
    }
    if (!out.why) out.why = `not merged into ${base || 'the base'}`;
    return out;
  }

  // The actions the user ticked, each on its own; a failure never stops the rest
  async apply(list, { eject }) {
    const results = [];
    for (const a of (Array.isArray(list) ? list : []).slice(0, 200)) {
      const item = { type: String(a.type || ''), cart: a.cart, project: a.project, path: a.path, branch: a.branch, remote: !!a.remote };
      try { results.push({ ...item, ok: true, ...(await this.one(a, { eject })) }); }
      catch (e) { results.push({ ...item, ok: false, error: e.message }); }
    }
    this.cache = null;
    return { results, freed: results.reduce((n, r) => n + (r.freed || 0), 0) };
  }
  async one(a, { eject }) {
    const type = String(a.type || '');
    if (type === 'eject') {
      const c = this.registry.get(a.cart);
      if (await c.running()) throw new Error('Power it off first');
      const out = await eject(c); // refuses uncommitted changes, keeps the branch
      this.plog(c.project, 'eject', `${c.id} ${c.rec.branch || ''}`);
      return { freed: out.freed || 0 };
    }
    if (type === 'hibernate') {
      const c = this.registry.get(a.cart);
      const r = await c.hibernate();
      this.plog(c.project, 'hibernate', `${c.id} ${r.before} -> ${r.after} bytes`);
      return { freed: Math.max(0, r.before - r.after) };
    }
    const p = this.registry.project(a.project);
    if (type === 'prune') {
      const r = await p.git('worktree', 'prune');
      if (!r.ok) throw new Error(firstLine(r.stderr));
      this.plog(p, 'prune');
      return {};
    }
    if (type === 'orphan') {
      const d = this.under(p, a.path, ['worktrees', 'research'].map(k => path.join(p.path, '.claude', k)));
      if (this.registry.cartridges().some(c => realpath(c.dir) === realpath(d))) throw new Error('That folder belongs to a cartridge');
      if (await dirtyWorktree(d)) throw new Error('That worktree has uncommitted changes');
      const bytes = await folderSize(d);
      const wt = await p.git('worktree', 'remove', '--force', d);
      if (!wt.ok && await statSafe(d)) await fsp.rm(d, { recursive: true, force: true });
      this.plog(p, 'orphan', d);
      return { freed: bytes };
    }
    if (type === 'setup-log') {
      const f = path.join(p.uiDir, 'setup.log');
      if (this.registry.cartridges().some(c => c.project.id === p.id && c.home)) throw new Error('The main checkout cartridge still uses it');
      const st = await statSafe(f);
      await fsp.rm(f, { force: true });
      this.plog(p, 'setup-log');
      return { freed: st ? st.size : 0 };
    }
    if (type === 'archive') {
      const d = this.under(p, a.path, [path.join(p.uiDir, 'archive')]);
      const bytes = await folderSize(d);
      await fsp.rm(d, { recursive: true, force: true });
      this.plog(p, 'archive', d);
      return { freed: bytes };
    }
    if (type === 'branch') {
      const b = String(a.branch || '');
      if (!BRANCH_RE.test(b)) throw new Error('Not a branch name');
      const e = this.ejected(p).find(x => x.branch === b);
      if (!e) throw new Error('Only branches of ejected cartridges are deleted here');
      if (this.registry.cartridges().some(c => c.project.id === p.id && c.rec.branch === b)) throw new Error(`A cartridge works on ${b} again`);
      const m = await this.branchInfo(p, e);
      if (!m.merged) throw new Error(`${b} is not merged: ${m.why}`);
      if (a.remote) {
        if (!m.prMerged) throw new Error(`The remote ${b} goes only once its pull request is merged`);
        if (!m.remoteExists) throw new Error(`origin has no ${b}`);
        await GH.deleteRemoteBranch(p.path, b);
        this.plog(p, 'branch-remote', b);
      } else {
        // A squash-merged branch is not "merged" to git, so the pull request's word is the one that counts
        const r = await p.git('branch', /pull request/.test(m.why) ? '-D' : '-d', b);
        if (!r.ok) throw new Error(firstLine(r.stderr));
        this.plog(p, 'branch', b);
      }
      return {};
    }
    if (type === 'gc') {
      const r = await p.git('gc', '--auto');
      if (!r.ok) throw new Error(firstLine(r.stderr));
      this.plog(p, 'gc');
      return {};
    }
    if (type === 'store-prune') {
      const r = await run('pnpm', ['store', 'prune'], { cwd: p.path, timeout: 600000 });
      if (!r.ok) throw new Error(firstLine(r.stderr) || 'pnpm store prune failed');
      this.plog(p, 'store-prune');
      return {};
    }
    throw new Error('Unknown tidy action');
  }
  // A folder the action may touch: inside one of the given parents of this project, no symlink escape
  under(p, rel, parents) {
    const abs = path.resolve(p.path, String(rel || ''));
    const okay = parents.some(par => inside(par, abs) && abs !== par && inside(realpath(par), realpath(abs)));
    if (!okay) throw new Error('That folder is not one the console manages');
    return abs;
  }
  plog(p, action, detail = '') {
    const line = `${new Date().toISOString()} [${p.id}] tidy-${action} ${String(detail).slice(0, 300)}\n`;
    try { fs.mkdirSync(p.uiDir, { recursive: true }); fs.appendFileSync(path.join(p.uiDir, 'actions.log'), line); } catch {}
  }
}

// A worktree with changes git would lose: tracked edits or untracked files (the tool's own files are excluded in
// .git/info/exclude, so they do not count). A folder without .git is a leftover and counts as clean; a worktree git
// cannot read counts as dirty, so nothing unknown is offered.
async function dirtyWorktree(d) {
  if (!(await statSafe(path.join(d, '.git')))) return false;
  const r = await run('git', ['-C', d, 'status', '--porcelain']);
  return !r.ok || r.stdout.trim() !== '';
}

// When the cartridge was last touched: started, a step sent, its state written
function lastActivity(c, s) {
  let t = Math.max(s.startedAt || 0, s.stepAt || 0, ((s.history || [])[0] || {}).t || 0, c.rec.createdAt || 0);
  try { t = Math.max(t, fs.statSync(c.stateFile).mtimeMs); } catch {}
  return t;
}

module.exports = { Tidy, lastActivity };

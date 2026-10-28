'use strict';
// Plan usage, the figures Claude Code's /usage shows. The status line hook and the assistant record what they see
// while Claude runs; when nothing runs, refresh() asks claude.ai with the login Claude Code saved on this machine.
// That is a plain HTTPS request, no model call and no tokens. The login is read, never renewed or written back.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, readJSON, writeJSONSync } = require('./util');

class PlanUsage {
  // url: '' turns refresh off. gapMs: the least time between two requests, four times that after a failure
  constructor({ file, url, claudeHome, gapMs = 15000 }) {
    this.file = file;
    this.url = url;
    this.claudeHome = claudeHome;
    this.gapMs = gapMs;
    this.pending = null;
    this.tried = 0;
    this.error = null;
  }

  // { at, fiveHour, sevenDay, error }, each window { pct, resetsAt } with times in ms. A window past its reset time
  // is left out: its old share no longer holds.
  async read() {
    const j = await readJSON(this.file);
    const w = x => {
      if (!x) return null;
      const resetsAt = x.resets_at ? x.resets_at * 1000 : null;
      if (resetsAt && resetsAt < Date.now()) return null;
      return { pct: typeof x.used_percentage === 'number' ? x.used_percentage : null, resetsAt };
    };
    const rl = (j && j.rate_limits) || {};
    if (!j && !this.error) return null;
    return { at: (j && j.at) || null, fiveHour: w(rl.five_hour), sevenDay: w(rl.seven_day), error: this.error };
  }

  // Fetch fresh figures unless the saved ones are younger than maxAge. One request at a time, none within the gap of
  // the last write or try. True when new figures were saved.
  refresh({ maxAge = 0 } = {}) {
    if (!this.url) return Promise.resolve(false);
    if (!this.pending) this.pending = this.tryPull(maxAge).finally(() => { this.pending = null; });
    return this.pending;
  }

  async tryPull(maxAge) {
    const j = await readJSON(this.file);
    if (j && j.at && Date.now() - j.at < Math.max(maxAge, this.gapMs)) return false;
    if (Date.now() - this.tried < (this.error ? 4 : 1) * this.gapMs) return false;
    this.tried = Date.now();
    try { writeJSONSync(this.file, { at: Date.now(), rate_limits: await this.pull() }); this.error = null; return true; }
    catch (e) { this.error = e.message; return false; }
  }

  // The OAuth login Claude Code keeps: the macOS keychain, else <claude home>/.credentials.json
  async token() {
    let raw = null;
    if (process.platform === 'darwin') {
      const r = await run('security', ['find-generic-password', '-a', os.userInfo().username, '-w', '-s', 'Claude Code-credentials'], { timeout: 5000 });
      if (r.ok) raw = r.stdout;
    }
    if (!raw) try { raw = fs.readFileSync(path.join(this.claudeHome, '.credentials.json'), 'utf8'); } catch {}
    let o = null;
    try { o = JSON.parse(raw).claudeAiOauth; } catch {}
    if (!o || !o.accessToken) throw new Error('No Claude login on this machine');
    if (o.expiresAt && o.expiresAt < Date.now()) throw new Error('The Claude login expired; it renews the next time Claude runs here');
    return o.accessToken;
  }

  // The figures in the status line's shape: used_percentage, resets_at in seconds
  async pull() {
    const res = await fetch(this.url, {
      headers: { Authorization: `Bearer ${await this.token()}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) throw new Error('claude.ai refused the login; it renews the next time Claude runs here');
    if (!res.ok) throw new Error(`claude.ai answered ${res.status}`);
    const j = await res.json();
    const w = x => (x && typeof x.utilization === 'number'
      ? { used_percentage: x.utilization, resets_at: x.resets_at ? Math.round(Date.parse(x.resets_at) / 1000) || null : null } : null);
    const rl = { five_hour: w(j.five_hour), seven_day: w(j.seven_day) };
    if (!rl.five_hour && !rl.seven_day) throw new Error('claude.ai sent no usage figures');
    return rl;
  }
}

module.exports = { PlanUsage };

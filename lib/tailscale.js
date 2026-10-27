'use strict';
// Tailscale: who is on the other end of a connection. With --tailscale the console answers only this Mac and the
// tailnet, and devices signed in to the same Tailscale account as this Mac need no token.
const fs = require('fs');
const { run, firstLine } = require('./util');

const APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'; // the Mac app ships its CLI here
const TAILNET_V4 = /^(?:::ffff:)?100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/; // 100.64.0.0/10
const tailnetAddr = a => TAILNET_V4.test(String(a || '')) || /^fd7a:115c:a1e0:/i.test(String(a || ''));

class Tailscale {
  constructor(bin) {
    this.bin = bin || process.env.TAILSCALE_BIN || (fs.existsSync(APP_CLI) ? APP_CLI : 'tailscale');
    this.self = null;
    this.logins = new Map(); // address -> { at, login }
  }
  // This Mac on the tailnet: its account, MagicDNS name and addresses
  async status() {
    const r = await run(this.bin, ['status', '--json'], { timeout: 8000 });
    if (!r.ok) throw new Error(firstLine(r.stderr) || 'tailscale status failed');
    const j = JSON.parse(r.stdout);
    const s = j.Self || {};
    this.self = { login: ((j.User || {})[String(s.UserID)] || {}).LoginName || null, name: String(s.DNSName || '').replace(/\.$/, ''), ips: s.TailscaleIPs || [] };
    return this.self;
  }
  // The account behind a tailnet address, cached for a few minutes
  async loginOf(addr) {
    const a = String(addr).replace(/^::ffff:/, '');
    const hit = this.logins.get(a);
    if (hit && Date.now() - hit.at < 5 * 60000) return hit.login;
    const r = await run(this.bin, ['whois', '--json', a], { timeout: 5000 });
    let login = null;
    try { login = JSON.parse(r.stdout).UserProfile.LoginName || null; } catch {}
    this.logins.set(a, { at: Date.now(), login });
    return login;
  }
  // A device of the same account as this Mac (tagged devices and shared nodes are not)
  async owner(addr) {
    return !!(this.self && this.self.login) && tailnetAddr(addr) && (await this.loginOf(addr)) === this.self.login;
  }
}

module.exports = { Tailscale, tailnetAddr };

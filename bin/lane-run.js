#!/usr/bin/env node
'use strict';
// Runs a package manager through the build lane (D63). A cartridge's session puts bin/shims first on PATH and each
// shim calls this with its own name: a heavy command waits for a slot, holds it while it runs and gives it back.
// Nested calls (a script that calls pnpm again) run straight through, and so does everything outside a cartridge.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Lane, heavyCommand } = require('../lib/lane');

const SHIMS = path.join(__dirname, 'shims');
const [tool, ...args] = process.argv.slice(2);

// The real tool: the first one on PATH that is not a shim
function realBin(name) {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d || path.resolve(d) === SHIMS) continue;
    const f = path.join(d, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}
function runReal(bin, env) {
  return new Promise(resolve => {
    const child = spawn(bin, args, { stdio: 'inherit', env });
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { try { child.kill(s); } catch {} });
    child.on('error', e => { process.stderr.write(`${tool}: ${e.message}\n`); resolve(127); });
    child.on('exit', (code, sig) => resolve(code != null ? code : 128 + (os.constants.signals[sig] || 1)));
  });
}

(async () => {
  const bin = tool && realBin(tool);
  if (!bin) { process.stderr.write(`${tool}: command not found\n`); process.exit(127); }
  const dir = process.env.CTU_LANE_DIR;
  if (!dir || process.env.CTU_LANE_HELD || !heavyCommand(tool, args)) process.exit(await runReal(bin, process.env));
  const lane = new Lane(dir);
  let told = 0;
  const release = await lane.acquire({ cart: process.env.CTU_CART || '', cmd: [tool, ...args].join(' ') }, {
    onWait: holders => {
      if (Date.now() - told < 60000) return;
      told = Date.now();
      process.stderr.write(`[build lane] waiting for a free slot: ${Lane.describe(holders)}. Let it wait; do not kill and retry.\n`);
    },
  });
  let code = 1;
  try { code = await runReal(bin, { ...process.env, CTU_LANE_HELD: '1' }); } finally { release(); }
  process.exit(code);
})();

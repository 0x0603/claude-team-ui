'use strict';
// Small helpers shared by the backend modules. Node built-ins only.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

// Sessions started by the tool must use the Pro/Max subscription, never an API key.
const API_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
// Set by a Claude Code session for its own shell. If the console was started from inside one, they must not reach
// the sessions it starts, or Claude Code treats them as nested.
const SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT'];
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !API_VARS.includes(k) && !SESSION_VARS.includes(k)));

function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    const child = execFile(cmd, args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => resolve({
        ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout),
        stderr: String(stderr || (err && err.message) || ''),
      }));
    if (opts.input != null) child.stdin.end(opts.input);
  });
}
const firstLine = s => String(s || '').trim().split('\n').pop();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readJSON(f) { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return null; } }
function readJSONSync(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
async function statSafe(f) { try { return await fsp.stat(f); } catch { return null; } }
function writeJSONSync(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, f);
}

// Single-quote for sh -c
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function slugify(s, max = 40) {
  let out = String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (out.length > max) {
    const cut = out.lastIndexOf('-', max); // prefer a word boundary
    out = out.slice(0, cut > max / 2 ? cut : max);
  }
  return out.replace(/-+$/, '') || 'task';
}

// macOS: /tmp is a symlink to /private/tmp, and Claude Code records the real path.
function realpath(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

// Is `p` equal to or inside `dir`? Both absolute.
function inside(dir, p) {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Bytes under a folder as du counts them; 0 when it is gone
async function folderSize(dir) {
  const r = await run('du', ['-sk', dir], { timeout: 180000 });
  const n = parseInt(r.stdout, 10);
  return Number.isFinite(n) ? n * 1024 : 0;
}
const fmtBytes = b => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} kB` : `${Math.round(b || 0)} B`);

module.exports = {
  API_VARS, SESSION_VARS, CLEAN_ENV, run, firstLine, sleep, readJSON, readJSONSync, statSafe, writeJSONSync, shq, slugify, realpath, inside,
  folderSize, fmtBytes,
};

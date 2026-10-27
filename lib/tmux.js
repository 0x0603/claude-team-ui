'use strict';
// tmux access. Every call runs with the API-key-free environment.
const crypto = require('crypto');
const { run, CLEAN_ENV, API_VARS, SESSION_VARS, sleep } = require('./util');

const tmux = (...a) => run('tmux', a, { env: CLEAN_ENV });
const SEP = '<<|>>'; // tmux replaces control characters with "_", so use a printable separator

async function hasSession(name) { return (await tmux('has-session', '-t', `=${name}`)).ok; }

async function allPanes() {
  const fmt = ['#{pane_id}', '#{window_index}.#{pane_index}', '#{pane_title}', '#{pane_current_command}',
    '#{pane_dead}', '#{session_name}'].join(SEP);
  const r = await tmux('list-panes', '-a', '-F', fmt);
  if (!r.ok) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map(line => {
    const [id, pos, title, cmd, dead, sess] = line.split(SEP);
    return { id, pos, title, cmd, dead: dead === '1', sess };
  });
}

// Claude pads lines to the pane width. With ansi, colour codes stay in (capture-pane -e), but the padding still goes.
const SGR_TAIL = /(?:\x1b\[[0-9;:]*m|[ \t])+$/gm;
async function capture(id, lines = 400, { ansi = false } = {}) {
  const r = await tmux('capture-pane', '-p', '-J', ...(ansi ? ['-e'] : []), '-t', id, '-S', `-${lines}`);
  if (!r.ok) return '';
  const out = ansi ? r.stdout.replace(SGR_TAIL, m => m.replace(/[ \t]+/g, '')) : r.stdout.replace(/[ \t]+$/gm, '');
  return out.replace(/\s+$/, '');
}
const stripAnsi = s => String(s).replace(/\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

// One line: literal keys. Several lines: bracketed paste, so the agent receives a single message.
async function sendText(target, text, submit = true) {
  if (text.includes('\n')) {
    const buf = 'ctu' + crypto.randomBytes(3).toString('hex');
    let r = await run('tmux', ['load-buffer', '-b', buf, '-'], { input: text, env: CLEAN_ENV });
    if (!r.ok) throw new Error(r.stderr);
    r = await tmux('paste-buffer', '-p', '-d', '-b', buf, '-t', target);
    if (!r.ok) throw new Error(r.stderr);
  } else {
    const r = await tmux('send-keys', '-t', target, '-l', '--', text);
    if (!r.ok) throw new Error(r.stderr);
  }
  if (submit) { await sleep(400); await tmux('send-keys', '-t', target, 'Enter'); }
}

async function sendKeys(target, ...keys) {
  for (const k of keys) {
    const r = await tmux('send-keys', '-t', target, k);
    if (!r.ok) throw new Error(r.stderr);
  }
}

// The session environment (-e) reaches the lead and every teammate pane; without it, panes would get the
// environment of whoever started the tmux server. PATH is the exception: tmux uses the client's PATH.
async function newSession({ name, cwd, command, env = {} }) {
  const e = Object.entries(env).filter(([, v]) => v != null).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const r = await tmux('new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', cwd, ...e, 'sh', '-c', command);
  if (!r.ok) throw new Error(r.stderr || 'Could not create the tmux session');
  await tmux('set-option', '-t', name, 'history-limit', '20000');
  // Teammate panes start from the session environment: no API key, nothing from an outer Claude Code session
  for (const v of [...API_VARS, ...SESSION_VARS]) await tmux('set-environment', '-t', name, '-r', v);
}

const killSession = name => tmux('kill-session', '-t', `=${name}`);

module.exports = { tmux, hasSession, allPanes, capture, stripAnsi, sendText, sendKeys, newSession, killSession };

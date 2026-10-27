'use strict';
// The assistant: a chat with Claude Code in print mode, one Claude session per conversation. It only reads (the
// workspace, the projects, GitHub through gh) and answers with a pasteable reply; what it proposes comes back as
// action cards that the console runs only when the user taps them. Runs on the subscription, never an API key.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const { CLEAN_ENV, readJSON, readJSONSync, writeJSONSync, firstLine } = require('./util');

// Read-only tools; anything else would ask for permission, which print mode refuses. The gh and git prefixes name the
// subcommand, so gh issue create, gh pr merge and the like are never allowed.
const TOOLS = ['Read', 'Grep', 'Glob', 'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh pr view:*)', 'Bash(gh pr list:*)', 'Bash(gh pr diff:*)',
  'Bash(gh pr checks:*)', 'Bash(gh search:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(rg:*)'];
const FLOWS = ['quick', 'standard', 'full'];
const ID_RE = /^[a-f0-9]{12}$/;
const MAX_CONVERSATIONS = 60;
const MAX_TEXT = 8000;
const MAX_TURNS = 8;
const TIMEOUT_MS = 10 * 60000;
const TOOL_VERB = { Read: 'Reading', Grep: 'Searching', Glob: 'Listing', Bash: 'Running' };

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const num = v => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
// One action card: the JSON the assistant wrote, checked field by field; unknown or broken cards are dropped
function parseAction(raw) {
  let j = null;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const project = str(j.project, 64);
  switch (j.type) {
    case 'create-issue': {
      const title = str(j.title, 120);
      if (!project || !title) return null;
      const labels = Array.isArray(j.labels) ? j.labels.map(l => str(l, 50)).filter(Boolean).slice(0, 10) : [];
      return { type: 'create-issue', project, title, body: str(j.body, 20000), labels, label: `Create issue in ${project}`, sub: title };
    }
    case 'start-work': {
      const issue = num(j.issue), title = str(j.title, 120);
      const flow = FLOWS.includes(j.flow) ? j.flow : 'quick';
      if (!project || (!issue && !title)) return null;
      return { type: 'start-work', project, issue, title, body: str(j.body, 20000), createIssue: !issue && !!j.createIssue, flow,
        label: `Add a ${flow} flow cartridge in ${project}`, sub: issue ? `Issue #${issue}` : title + (j.createIssue ? ' (also creates the issue)' : '') };
    }
    case 'review-pr': {
      const pr = num(j.pr);
      if (!project || !pr) return null;
      return { type: 'review-pr', project, pr, label: `Review PR #${pr} in ${project}`, sub: 'A read-only review cartridge' };
    }
    case 'research': {
      const question = str(j.question, 4000);
      if (!project || !question) return null;
      return { type: 'research', project, question, title: str(j.title, 60), label: `Research in ${project}`, sub: question.split('\n')[0] };
    }
    case 'send': {
      const cart = str(j.cart, 64), text = str(j.text, 4000);
      if (!/^[a-z0-9-]{1,64}$/.test(cart) || !text) return null;
      return { type: 'send', cart, text, label: `Message the lead of ${cart}`, sub: text.split('\n')[0] };
    }
    case 'open': {
      const url = str(j.url, 500);
      if (!/^https?:\/\//i.test(url)) return null;
      return { type: 'open', url, label: 'Open link', sub: url };
    }
    default: return null;
  }
}
// Action cards are fenced blocks; they leave the text and come back as buttons
function splitActions(text) {
  const actions = [];
  const rest = String(text || '').replace(/```action[^\n]*\n([\s\S]*?)```/g, (all, body) => {
    const a = parseAction(body.trim());
    if (a) actions.push(a);
    return '';
  });
  return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), actions };
}
// What a tool call is doing, for the status line while the assistant works
function describeTool(name, input = {}) {
  const verb = TOOL_VERB[name] || name;
  const what = input.command || input.pattern || input.file_path || input.path || input.query || input.description || '';
  return `${verb} ${String(what).slice(0, 80)}`.trim();
}

class Assistant {
  constructor({ bin, dir, usageFile }) {
    this.bin = bin;
    this.dir = dir;
    this.usageFile = usageFile;
    this.busy = new Set();
  }
  static validId(id) { return ID_RE.test(String(id || '')); }
  file(id) {
    if (!Assistant.validId(id)) throw new Error('Invalid conversation id');
    return path.join(this.dir, `${id}.json`);
  }
  summary(c) {
    return { id: c.id, title: c.title || 'New chat', createdAt: c.createdAt, updatedAt: c.updatedAt, costUSD: c.costUSD || 0,
      messages: c.messages.length, busy: this.busy.has(c.id) };
  }
  async list() {
    let names = [];
    try { names = await fsp.readdir(this.dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      const m = n.match(/^([a-f0-9]{12})\.json$/);
      const c = m && await readJSON(path.join(this.dir, n));
      if (c && c.id === m[1]) out.push(this.summary(c));
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  async get(id) {
    const c = await readJSON(this.file(id));
    if (!c) throw new Error('No such conversation');
    return { ...c, busy: this.busy.has(c.id) };
  }
  // A chat keeps the scope it was opened with: a cartridge (id and title), or the workspace when cart is null
  async create(cwd, cart = null) {
    const c = { id: crypto.randomBytes(6).toString('hex'), sessionId: crypto.randomUUID(), started: false, cwd, title: '',
      cart: cart ? cart.id : null, cartTitle: cart ? cart.title : null, createdAt: Date.now(), updatedAt: Date.now(), costUSD: 0, messages: [] };
    this.save(c);
    await this.prune();
    return c;
  }
  save(c) {
    const { busy, ...rec } = c;
    rec.updatedAt = Date.now();
    writeJSONSync(this.file(c.id), rec);
  }
  async delete(id) {
    if (this.busy.has(id)) throw new Error('The assistant is still answering in this chat');
    try { await fsp.unlink(this.file(id)); } catch {}
  }
  async clear() { for (const c of await this.list()) await this.delete(c.id); }
  async prune() { for (const c of (await this.list()).slice(MAX_CONVERSATIONS)) await this.delete(c.id); }

  // One message: spawn claude -p on the conversation's session, stream what it says, keep the reply and its cards.
  // onEvent gets {type: 'text'|'status', text} while it runs. Resolves with the assistant message.
  async send(conv, text, { system, model, addDirs = [] }, onEvent = () => {}) {
    text = String(text || '').trim().slice(0, MAX_TEXT);
    if (!text) throw new Error('Write a message first');
    if (this.busy.has(conv.id)) throw new Error('The assistant is still answering; wait for it');
    this.busy.add(conv.id);
    try {
      // Results of cards the user tapped since the last reply, so the assistant knows what happened
      const last = conv.messages.map(m => m.role).lastIndexOf('assistant');
      const notes = conv.messages.slice(last + 1).filter(m => m.role === 'note').map(m => m.text);
      const prompt = (notes.length ? `Console: ${notes.join('\nConsole: ')}\n\n` : '') + text;
      const asked = { role: 'user', text, at: Date.now() };
      conv.messages.push(asked);
      if (!conv.title) conv.title = text.split('\n')[0].slice(0, 60);
      this.save(conv);
      let r;
      try { r = await this.run(conv, prompt, { system, model, addDirs }, onEvent); }
      catch (e) { // the question is not kept without its answer; a chat that never got one goes
        conv.messages = conv.messages.filter(m => m !== asked);
        if (conv.messages.length) this.save(conv); else { this.busy.delete(conv.id); await this.delete(conv.id); }
        throw e;
      }
      const { text: reply, actions } = splitActions(r.text);
      const msg = { role: 'assistant', text: reply, actions, at: Date.now(), costUSD: r.costUSD, model: model || null };
      conv.started = true;
      if (r.sessionId) conv.sessionId = r.sessionId;
      conv.costUSD = Number(((conv.costUSD || 0) + (r.costUSD || 0)).toFixed(4));
      conv.messages.push(msg);
      this.save(conv);
      return msg;
    } finally { this.busy.delete(conv.id); }
  }
  run(conv, prompt, { system, model, addDirs }, onEvent) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--max-turns', String(MAX_TURNS),
      '--setting-sources', 'project', '--append-system-prompt', system];
    if (model) args.push('--model', model);
    args.push(conv.started ? '--resume' : '--session-id', conv.sessionId);
    for (const d of addDirs) args.push('--add-dir', d);
    args.push('--allowedTools', ...TOOLS); // takes every following argument, so it goes last
    return new Promise((resolve, reject) => {
      let text = '', fallback = '', result = null, stderr = '', settled = false;
      const child = spawn(this.bin, args, { cwd: conv.cwd, env: CLEAN_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
      const finish = (err, val) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(val); };
      const timer = setTimeout(() => { child.kill(); finish(new Error('The assistant took too long and was stopped')); }, TIMEOUT_MS);
      child.on('error', e => finish(new Error(`Could not run ${this.bin}: ${e.message}`)));
      child.stderr.on('data', d => { stderr += d; });
      readline.createInterface({ input: child.stdout }).on('line', line => {
        let j = null;
        try { j = JSON.parse(line); } catch { return; }
        if (!j || typeof j !== 'object') return;
        if (j.type === 'stream_event' && j.event) {
          const ev = j.event;
          if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'text' && text && !text.endsWith('\n')) {
            text += '\n\n'; onEvent({ type: 'text', text: '\n\n' });
          } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) {
            text += ev.delta.text; onEvent({ type: 'text', text: ev.delta.text });
          }
        } else if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
          for (const c of j.message.content) {
            if (c.type === 'tool_use') onEvent({ type: 'status', text: describeTool(c.name, c.input) });
            else if (c.type === 'text' && c.text) fallback += (fallback ? '\n\n' : '') + c.text;
          }
        } else if (j.type === 'rate_limit_event' && j.rate_limit_info) {
          this.recordUsage(j.rate_limit_info);
        } else if (j.type === 'result') {
          result = j;
        }
      });
      child.on('close', code => {
        if (result && !result.is_error) {
          return finish(null, { text: text || fallback || String(result.result || ''), sessionId: result.session_id || null, costUSD: Number(result.total_cost_usd) || 0 });
        }
        const why = result && result.is_error ? String(result.result || result.subtype || 'error') : firstLine(stderr) || `claude exited with code ${code}`;
        finish(new Error('Claude did not answer: ' + why.slice(0, 300)));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }
  // Plan usage, as the status line hook records it, so the rings on the home screen follow the assistant too
  recordUsage(info) {
    const key = { five_hour: 'five_hour', seven_day: 'seven_day' }[info.rateLimitType];
    if (!key || typeof info.utilization !== 'number' || !this.usageFile) return;
    try {
      const cur = readJSONSync(this.usageFile) || {};
      const rl = { ...(cur.rate_limits || {}) };
      rl[key] = { ...(rl[key] || {}), used_percentage: Math.round(info.utilization * 100), resets_at: info.resetsAt || (rl[key] || {}).resets_at || null };
      writeJSONSync(this.usageFile, { at: Date.now(), rate_limits: rl });
    } catch {}
  }
  // The user tapped a card: remember what the console did, for the user and for the next turn
  async noteAction(conv, messageIndex, actionIndex, note) {
    const m = conv.messages[messageIndex];
    const a = m && m.actions && m.actions[actionIndex];
    if (!a) throw new Error('No such action');
    a.done = { at: Date.now(), note };
    if (note) conv.messages.push({ role: 'note', text: note, at: Date.now() });
    this.save(conv);
  }
}

module.exports = { Assistant, parseAction, splitActions, describeTool, TOOLS, MAX_TEXT };

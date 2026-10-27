'use strict';
// Read-only view of Claude Code state: running sessions, team config, transcripts, and what a pane is asking for.
// Formats verified against Claude Code 2.1.311 (docs/verify.md). Every reader tolerates missing or changed files.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { run, CLEAN_ENV, readJSON, statSafe, firstLine } = require('./util');

// What the bottom of a pane is waiting for. Order matters: the first match wins.
const SCREENS = [
  { kind: 'trust', re: /Yes, I trust this folder|Is this a project you created or one you trust/i },
  { kind: 'exit', re: /Exit and stop tasks/ },
  { kind: 'permission', re: /Do you want to proceed\?|Do you want to (?:make this edit|create|allow)|requires approval/i },
  { kind: 'question', re: /Enter to confirm|Esc to cancel|\(y\/n\)|Would you like to|\b1\.\s*Yes\b/i },
];
function detectScreen(text) {
  const tail = String(text || '').split('\n').slice(-30).join('\n');
  for (const s of SCREENS) if (s.re.test(tail)) return s.kind;
  return null;
}

// The newest thing a pane's agent said or did (its last ⏺ line), shortened for the home list
const TOOL_VERB = { Read: 'Reading', Write: 'Writing', Edit: 'Editing', Update: 'Editing', MultiEdit: 'Editing', Bash: 'Running',
  Grep: 'Searching', Glob: 'Searching', Search: 'Searching', WebSearch: 'Searching the web for', WebFetch: 'Reading', Agent: 'Starting', Task: 'Starting', SendMessage: 'Messaging' };
const inWords = line => {
  const s = line.replace(/\s+/g, ' ').trim();
  const t = s.match(/^(\w+)\((.*?)\)?$/);
  return (t && TOOL_VERB[t[1]] ? `${TOOL_VERB[t[1]]} ${t[2]}` : s).slice(0, 140);
};
// The screen splits at the input prompt: the conversation above, the status line and background agents below
function splitScreen(text) {
  const lines = String(text || '').split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*❯/.test(lines[i])) { at = i; break; }
  return at < 0 ? { above: lines, below: [] } : { above: lines.slice(0, at), below: lines.slice(at + 1) };
}
// ⏺ lines and Claude's tool summaries ("Ran 2 shell commands"); a reply wrapped over several lines is joined back
const SUMMARY_RE = /^\s{2}((?:Ran|Read|Listed|Searched|Edited|Wrote|Updated|Fetched|Found)\b.+)$/;
function events(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*⏺\s+(.+)/);
    if (m) {
      let s = m[1];
      for (let j = i + 1; j < lines.length && s.length < 160 && /^ {2}(?![⎿├└│ ])\S/.test(lines[j]) && !SUMMARY_RE.test(lines[j]); j++) s += ' ' + lines[j].trim();
      out.push(inWords(s));
      continue;
    }
    const sm = lines[i].match(SUMMARY_RE);
    if (sm) out.push(inWords(sm[1]));
  }
  return out;
}
function lastReply(text) {
  const ev = events(splitScreen(text).above);
  return ev.length ? ev[ev.length - 1] : null;
}
// What the lead is doing, read off its screen: the spinner while it works ("Churning… (42s · ↓ 3.0k tokens)"),
// its last few steps, and the background agents panel under the prompt ("◯ planner  Draft plan for #570  30s")
const SPIN_RE = /^\s*[^\w\s❯⏺⎿│─]\s+([A-Z][\w-]*…)\s*(?:\(([^)]*)\))?/;
// Errors Claude prints in the conversation; a later ⏺ line means the lead carried on, so the error is over
const ERROR_RE = /(API Error.*|.*usage limit reached.*|.*\blimit reached\b.*resets.*|Request timed out.*|.*overloaded_error.*)/i;
const AGENT_RE = /^\s{1,4}([⏺◯●○◉◐◑◒◓✓✔✗✘])\s+@?([\w.-]+)(?:\s{2,}(.*?))?(?:\s{2,}(\d+[smh](?: ?\d+[smh])?))?\s*$/;
function liveView(text) {
  const { above, below } = splitScreen(text);
  let status = null;
  for (const l of above.slice(-12)) { const s = l.match(SPIN_RE); if (s) status = s[2] ? `${s[1]} ${s[2]}` : s[1]; } // sits just above the prompt
  const agents = [];
  for (const l of below) {
    const a = l.match(AGENT_RE);
    if (a && a[2] !== 'main') agents.push({ name: a[2], task: (a[3] || '').trim(), time: a[4] || '', done: /[✓✔]/.test(a[1]) });
  }
  let error = null;
  for (const l of above) {
    const e = l.match(ERROR_RE);
    if (e) error = e[1].replace(/^\s*[⏺⎿]\s*/, '').trim().slice(0, 160);
    else if (/^\s*⏺/.test(l)) error = null;
  }
  return { status, events: events(above).slice(-4), agents, error };
}

const MSG_RE = /<teammate-message\s+([^>]*)>([\s\S]*?)<\/teammate-message>/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;
const CHUNK = 4 * 1024 * 1024;

// Tool calls between two things the lead said, folded into one line ("read 4 files, ran 2 commands")
const TOOL_WORDS = { Read: ['read', 'file'], Grep: ['searched', 'time'], Glob: ['searched', 'time'], Bash: ['ran', 'command'], Edit: ['changed', 'file'],
  MultiEdit: ['changed', 'file'], Write: ['wrote', 'file'], NotebookEdit: ['changed', 'file'], Agent: ['started', 'agent'], Task: ['started', 'agent'],
  SendMessage: ['sent', 'message'], WebSearch: ['searched the web', 'time'], WebFetch: ['fetched', 'page'] };
function toolLine(tools) {
  const groups = {};
  for (const [name, n] of Object.entries(tools.by)) { const k = (TOOL_WORDS[name] || ['used', 'other tool']).join('|'); groups[k] = (groups[k] || 0) + n; }
  const parts = Object.entries(groups).map(([k, n]) => { const [verb, noun] = k.split('|'); return `${verb} ${n} ${noun}${n === 1 ? '' : 's'}`; });
  return parts.join(', ') + (tools.err ? ` (${tools.err} failed)` : '');
}
// Text the console pasted into the lead's prompt arrives wrapped as pasted content
const unwrapPaste = t => String(t || '').replace(/<pasted_content[^>]*>\n?/g, '').replace(/<\/pasted_content>/g, '');
async function readHead(file, bytes) {
  const fh = await fsp.open(file, 'r');
  try { const buf = Buffer.alloc(bytes); const { bytesRead } = await fh.read(buf, 0, bytes, 0); return buf.toString('utf8', 0, bytesRead); } finally { await fh.close(); }
}

class Claude {
  constructor({ bin, home }) {
    this.bin = bin;
    this.home = home;
    this.agentCache = { t: 0, list: [] };
    this.files = new Map(); // transcript path -> incremental scan state
  }

  // `claude agents --json` lists interactive sessions with cwd, sessionId and status (busy | idle | waiting).
  async agents(maxAge = 3000) {
    if (Date.now() - this.agentCache.t < maxAge) return this.agentCache.list;
    if (!this.agentPending) {
      this.agentPending = run(this.bin, ['agents', '--json'], { env: CLEAN_ENV, timeout: 10000 }).then(r => {
        let list = [];
        try { list = r.ok ? JSON.parse(r.stdout) : []; } catch {}
        this.agentCache = { t: Date.now(), list: Array.isArray(list) ? list : [] };
        this.agentPending = null;
        return this.agentCache.list;
      });
    }
    return this.agentPending;
  }
  async leadSession(dir) {
    const mine = (await this.agents()).filter(a => a && a.cwd === dir);
    return mine.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] || null;
  }

  // The team of a cartridge: the one led by its lead session if known, else the newest team led from its folder.
  // The config is deleted when the lead exits.
  async team(dir, leadSessionId) {
    const root = path.join(this.home, 'teams');
    let names = [];
    try { names = await fsp.readdir(root); } catch {}
    let best = null;
    for (const name of names) {
      if (!/^[\w-][\w.-]*$/.test(name)) continue;
      const cfg = await readJSON(path.join(root, name, 'config.json'));
      if (!cfg || !Array.isArray(cfg.members)) continue;
      const lead = cfg.members.find(m => m && m.agentType === 'team-lead') || cfg.members[0];
      if (!lead || lead.cwd !== dir) continue;
      if (leadSessionId && cfg.leadSessionId === leadSessionId) { best = cfg; break; }
      if (!best || (cfg.createdAt || 0) > (best.createdAt || 0)) best = cfg;
    }
    if (!best) return null;
    return {
      name: best.name, createdAt: best.createdAt || null, leadSessionId: best.leadSessionId || null,
      members: best.members.filter(Boolean).map(m => ({
        name: String(m.name || '?'), type: String(m.agentType || ''), model: String(m.model || ''),
        paneId: /^%\d+$/.test(m.tmuxPaneId || '') ? m.tmuxPaneId : null,
        active: m.agentType === 'team-lead' ? true : m.isActive !== false, color: m.color || null,
        task: typeof m.prompt === 'string' ? m.prompt.slice(0, 600) : '',
      })),
    };
  }

  // Shared task list, when the session has one (~/.claude/tasks/<team>/*.json). Often empty.
  async tasks(teamName) {
    if (!teamName || !/^[\w-][\w.-]*$/.test(teamName)) return [];
    const dir = path.join(this.home, 'tasks', teamName);
    const out = [];
    let files = [];
    try { files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json')); } catch { return out; }
    for (const f of files) {
      const t = await readJSON(path.join(dir, f));
      for (const x of (Array.isArray(t) ? t : Array.isArray(t && t.tasks) ? t.tasks : t ? [t] : [])) {
        if (!x || typeof x !== 'object') continue;
        out.push({
          id: String(x.id ?? x.taskId ?? f.replace(/\.json$/, '')), subject: String(x.subject || x.title || x.content || '(untitled)'),
          status: String(x.status || 'pending'), owner: String(x.owner || x.assignee || ''),
          blockedBy: Array.isArray(x.blockedBy) ? x.blockedBy.map(String) : [],
        });
      }
    }
    return out.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0) || a.id.localeCompare(b.id));
  }

  // ---------- Transcripts: ~/.claude/projects/<cwd with every non-alphanumeric char as "-">/*.jsonl ----------
  async projectFolder(dir) {
    const root = path.join(this.home, 'projects');
    const key = dir.replace(/[^a-zA-Z0-9]/g, '-');
    if (await statSafe(path.join(root, key))) return path.join(root, key);
    if (key.length < 180) return null;
    // Very long names may be shortened by Claude Code; fall back to a prefix match.
    try {
      const hit = (await fsp.readdir(root)).find(n => n.startsWith(key.slice(0, 180)));
      return hit ? path.join(root, hit) : null;
    } catch { return null; }
  }
  async transcriptFiles(folder) {
    const out = [];
    let ents = [];
    try { ents = await fsp.readdir(folder, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
      const p = path.join(folder, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
      else if (e.isDirectory()) {
        try { for (const f of await fsp.readdir(path.join(p, 'subagents'))) if (f.endsWith('.jsonl')) out.push(path.join(p, 'subagents', f)); } catch {}
      }
    }
    return out;
  }

  // Messages between agents and the cost Claude Code reports for every session run in `dir`.
  async activity(dir) {
    const out = { sessions: 0, costUSD: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, models: {}, messages: [], lastActivity: 0, agents: [] };
    const folder = await this.projectFolder(dir);
    if (!folder) return out;
    for (const f of await this.transcriptFiles(folder)) {
      const s = await this.scan(f);
      out.lastActivity = Math.max(out.lastActivity, s.mtime);
      out.agents.push({ name: s.agent || null, mtime: s.mtime, session: path.basename(f, '.jsonl'), replies: s.replies || [] }); // recent writes mean that agent is working
      out.messages.push(...s.messages);
      if (!s.cost) continue;
      out.sessions++;
      out.costUSD += Number(s.cost.totalCostUSD) || 0;
      for (const [model, u] of Object.entries(s.cost.modelUsage || {})) {
        const m = out.models[model] || (out.models[model] = { input: 0, output: 0, costUSD: 0 });
        m.input += (u.inputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0);
        m.output += u.outputTokens || 0;
        m.costUSD += Number(u.costUSD) || 0;
        out.tokens.input += u.inputTokens || 0;
        out.tokens.output += u.outputTokens || 0;
        out.tokens.cacheRead += u.cacheReadInputTokens || 0;
        out.tokens.cacheWrite += u.cacheCreationInputTokens || 0;
      }
    }
    out.messages.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
    out.messages = out.messages.slice(0, 200);
    out.costUSD = Math.round(out.costUSD * 100) / 100;
    return out;
  }

  // Reads only the bytes appended since the last call, up to the last complete line.
  async scan(file) {
    const st = await statSafe(file);
    let s = this.files.get(file);
    if (!s || !st || st.size < s.offset) s = { offset: 0, cost: null, messages: [], mtime: 0 };
    if (st && st.size > s.offset) {
      const fh = await fsp.open(file, 'r');
      try {
        while (s.offset < st.size) {
          const buf = Buffer.alloc(Math.min(CHUNK, st.size - s.offset));
          const { bytesRead } = await fh.read(buf, 0, buf.length, s.offset);
          const end = buf.lastIndexOf(0x0a, bytesRead - 1);
          if (end < 0) {
            if (bytesRead < CHUNK) break; // partial last line: wait for more
            s.offset += bytesRead; continue; // a single line longer than CHUNK: skip it
          }
          for (const line of buf.toString('utf8', 0, end).split('\n')) this.parseLine(line, s);
          s.offset += end + 1;
        }
      } finally { await fh.close(); }
      s.mtime = st.mtimeMs;
      if (s.messages.length > 300) s.messages = s.messages.slice(-300);
    }
    this.files.set(file, s);
    return s;
  }
  parseLine(line, s) {
    if (!s.agent && line.includes('"agentName"')) { const m = line.match(/"agentName"\s*:\s*"([^"]+)"/); if (m) s.agent = m[1]; } // whose transcript this is
    // The start of each reply, with its time: a step is done when the lead's reply opens with the step's marker
    if (line.includes('"type":"assistant"') && line.includes('"type":"text"')) {
      const t = line.match(/"timestamp"\s*:\s*"([^"]+)"/);
      const m = line.match(/"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.){0,400})/);
      if (t && m) {
        let head = m[1];
        try { head = JSON.parse(`"${m[1].replace(/\\$/, '')}"`); } catch {}
        s.replies = [...(s.replies || []), { t: Date.parse(t[1]), head }].slice(-20);
      }
    }
    const isCost = line.includes('cost-state') && /"type"\s*:\s*"cost-state"/.test(line);
    if (!isCost && !line.includes('teammate-message')) return; // skip the large request records cheaply
    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (o.type === 'cost-state') { s.cost = o; return; }
    if (o.type !== 'user' || !o.message) return;
    const c = o.message.content;
    const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => String(b.text)) : [];
    for (const t of texts) {
      for (const m of t.matchAll(MSG_RE)) {
        const attrs = Object.fromEntries([...m[1].matchAll(ATTR_RE)].map(a => [a[1], a[2]]));
        let text = m[2].trim();
        // Protocol messages arrive as JSON; idle notices are noise, the rest becomes a short label
        if (text.startsWith('{')) {
          let j = null;
          try { j = JSON.parse(text); } catch {}
          if (j && j.type === 'idle_notification') continue;
          if (j && typeof j.type === 'string') text = `(${j.type.replace(/_/g, ' ')})${j.reason ? ': ' + j.reason : ''}`;
        }
        s.messages.push({
          from: attrs.teammate_id || '?', to: o.agentName || 'team-lead', summary: attrs.summary || '',
          text: text.slice(0, 4000), time: o.timestamp || null,
        });
      }
    }
  }

  // ---------- The lead's conversation, for the chat tab (read only) ----------
  // The lead's own transcript: <sessionId>.jsonl when the session is known, else the top-level file that carries the
  // name the console started the lead with (teammates carry their own names), else the newest one
  async leadTranscript(dir, sessionName, sessionId) {
    const folder = await this.projectFolder(dir);
    if (!folder) return null;
    if (sessionId && await statSafe(path.join(folder, `${sessionId}.jsonl`))) return path.join(folder, `${sessionId}.jsonl`);
    let ents = [];
    try { ents = await fsp.readdir(folder, { withFileTypes: true }); } catch { return null; }
    const files = [];
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const st = await statSafe(path.join(folder, e.name));
      files.push({ p: path.join(folder, e.name), mtime: st ? st.mtimeMs : 0 });
    }
    files.sort((a, b) => b.mtime - a.mtime);
    for (const f of files) {
      const m = (await readHead(f.p, 65536).catch(() => '')).match(/"agentName"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m && m[1] === sessionName) return f.p;
    }
    return files[0] ? files[0].p : null;
  }
  // Turns since a byte offset: what the user (or the console) sent, what the lead said, its tool activity folded into
  // one line per stretch, and messages from teammates. Request blobs and snapshots are skipped without parsing.
  async chatTurns(file, since) {
    const st = await statSafe(file);
    if (!st) return { cursor: 0, turns: [] };
    let offset = Math.max(0, Number(since) || 0);
    if (offset > st.size) offset = 0;
    const s = { turns: [], tools: null };
    const fh = await fsp.open(file, 'r');
    try {
      while (offset < st.size) {
        const buf = Buffer.alloc(Math.min(CHUNK, st.size - offset));
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
        const end = buf.lastIndexOf(0x0a, bytesRead - 1);
        if (end < 0) { if (bytesRead < CHUNK) break; offset += bytesRead; continue; }
        for (const line of buf.toString('utf8', 0, end).split('\n')) this.chatLine(line, s);
        offset += end + 1;
      }
    } finally { await fh.close(); }
    this.chatFlush(s);
    return { cursor: offset, turns: s.turns };
  }
  chatFlush(s) {
    if (s.tools && s.tools.n) s.turns.push({ role: 'tools', text: toolLine(s.tools), t: s.tools.t });
    s.tools = null;
  }
  chatLine(line, s) {
    if (!line.startsWith('{"parentUuid"') && !/^\{"type":"(user|assistant)"/.test(line)) return; // only conversation records carry parentUuid first
    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (!o || o.isSidechain || !o.message) return;
    const t = o.timestamp ? Date.parse(o.timestamp) : 0;
    const c = o.message.content;
    if (o.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (!b) continue;
        if (b.type === 'text' && String(b.text || '').trim()) { this.chatFlush(s); s.turns.push({ role: 'assistant', text: String(b.text).slice(0, 20000), t, id: o.uuid || null }); }
        else if (b.type === 'tool_use') { s.tools = s.tools || { t, n: 0, by: {}, err: 0 }; s.tools.n++; s.tools.by[b.name] = (s.tools.by[b.name] || 0) + 1; }
      }
      return;
    }
    if (o.type !== 'user' || o.isMeta || o.isCompactSummary) return;
    let text;
    if (Array.isArray(c)) {
      if (s.tools) s.tools.err += c.filter(b => b && b.type === 'tool_result' && b.is_error).length;
      const texts = c.filter(b => b && b.type === 'text').map(b => String(b.text));
      if (!texts.length) return;
      text = texts.join('\n');
    } else text = String(c || '');
    text = unwrapPaste(text).trim();
    if (!text || /^<(command-name|command-message|command-args|local-command)/.test(text)) return; // slash commands and their output
    if (text.includes('<teammate-message')) {
      for (const m of text.matchAll(MSG_RE)) {
        const attrs = Object.fromEntries([...m[1].matchAll(ATTR_RE)].map(a => [a[1], a[2]]));
        const body = m[2].trim();
        if (body.startsWith('{') && /"idle_notification"/.test(body)) continue;
        this.chatFlush(s);
        s.turns.push({ role: 'teammate', from: attrs.teammate_id || '?', summary: attrs.summary || '', text: body.slice(0, 4000), t, id: o.uuid || null });
      }
      return;
    }
    this.chatFlush(s);
    s.turns.push({ role: 'user', text: text.slice(0, 20000), t, id: o.uuid || null });
  }

  // One-shot `claude -p` (counts against the subscription) to turn a rough request into an issue.
  async draftIssue(text, model) {
    const prompt = [
      'Rewrite the request below as a GitHub issue in English.',
      'Title: one line, under 80 characters.',
      'Body: Markdown with the sections "## Context", "## Goal", "## Acceptance criteria" (checkable bullet points)',
      'and "## Open questions" for anything unclear. Plain, short sentences. No bold text, no emoji.',
      'Do not invent technical details that are not in the request.',
      '', 'Request:', text,
    ].join('\n');
    const schema = JSON.stringify({ type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] });
    const args = ['-p', prompt, '--output-format', 'json', '--json-schema', schema, '--no-session-persistence'];
    if (model) args.push('--model', model);
    const r = await run(this.bin, args, { cwd: os.tmpdir(), env: CLEAN_ENV, timeout: 180000 });
    if (!r.ok) return { ok: false, error: 'Claude did not answer: ' + firstLine(r.stderr || r.stdout) };
    return { ok: true, ...parseDraft(r.stdout, text) };
  }
}

function parseDraft(stdout, fallbackText) {
  const tryJSON = s => { try { return JSON.parse(s); } catch { return null; } };
  const outer = tryJSON(stdout);
  const candidates = [];
  if (outer && typeof outer === 'object') {
    candidates.push(outer.structured_output, outer.structuredOutput);
    if (typeof outer.result === 'string') candidates.push(tryJSON(outer.result), tryJSON((outer.result.match(/\{[\s\S]*\}/) || [])[0]));
    candidates.push(outer);
  } else {
    candidates.push(tryJSON((String(stdout).match(/\{[\s\S]*\}/) || [])[0]));
  }
  const hit = candidates.find(c => c && typeof c === 'object' && typeof c.title === 'string' && c.title.trim());
  if (hit) return { title: hit.title.trim().slice(0, 120), body: String(hit.body || '') };
  const raw = outer && typeof outer.result === 'string' ? outer.result : String(stdout);
  return { title: fallbackText.split('\n')[0].slice(0, 80), body: raw.trim() };
}

module.exports = { Claude, detectScreen, lastReply, liveView, splitScreen, parseDraft };

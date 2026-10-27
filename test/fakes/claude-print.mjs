#!/usr/bin/env node
// Fake "claude -p --output-format stream-json" for the tests (the assistant). Calls no model.
// Mimics Claude Code 2.1.311 (docs/verify.md V11): the prompt comes on stdin; --session-id starts a session and
// --resume continues one (an unknown id fails like the real thing); the stream has text deltas, an assistant message
// with a tool call, a rate_limit_event and a result with session_id and total_cost_usd.
// Sessions live in $CLAUDE_HOME/fake-sessions/<id> (one line per prompt: its last line, the user's words); the last
// call's arguments and environment go to $CLAUDE_HOME/fake-assistant-call for the test to check.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const after = flag => { const i = args.indexOf(flag); return i > -1 ? args[i + 1] : null; };
const sid = after('--session-id') || after('--resume') || 'no-session';
const resume = args.includes('--resume');
const home = process.env.CLAUDE_HOME || path.join(process.env.HOME, '.claude');
const dir = path.join(home, 'fake-sessions');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, sid);
if (resume && !fs.existsSync(file)) { process.stderr.write(`No conversation found with session ID: ${sid}\n`); process.exit(1); }

const prompt = fs.readFileSync(0, 'utf8');
const lines = prompt.split('\n').filter(l => l.trim());
const ask = lines[lines.length - 1] || '';
if (/^fail/i.test(ask)) { process.stderr.write('API Error: 500 boom\n'); process.exit(1); }
const earlier = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
fs.appendFileSync(file, ask + '\n');
const turn = earlier.length + 1;
fs.writeFileSync(path.join(home, 'fake-assistant-call'), [
  `args: ${args.join(' ')}`, `cwd: ${process.cwd()}`,
  `API_KEY=${process.env.ANTHROPIC_API_KEY || '<unset>'} NESTED=${process.env.CLAUDECODE || '<unset>'}`,
  `prompt: ${prompt}`, `system: ${after('--append-system-prompt') || ''}`,
].join('\n'));

let text = `Echo: ${ask} (turn ${turn})${earlier.length ? `, earlier: ${earlier[0]}` : ''}.\n\n`
  + 'Evidence: src/a.js:1 (verified).\n\n```reply\nYes: the report page exports CSV since PR 7.\n```\n';
if (/issue/i.test(ask)) text += '\n```action\n{"type":"create-issue","project":"app","title":"Export reports as CSV","body":"## Goal\\nCSV export.","labels":["feature"]}\n```\n';
if (/^start/i.test(ask)) text += '\n```action\n{"type":"start-work","project":"app","title":"Nightly CSV export","body":"## Goal\\nCSV export at night.","flow":"quick"}\n```\n';
if (/^review/i.test(ask)) text += '\n```action\n{"type":"review-pr","project":"app","pr":7}\n```\n';
if (/^broken/i.test(ask)) text += '\n```action\n{"type":"create-issue","project":"app"}\n```\n'; // no title: dropped

const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const delta = t => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, session_id: sid });
out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sid, tools: ['Read', 'Grep', 'Bash'] });
out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, session_id: sid });
delta('Looking at ');
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Grep', input: { pattern: 'report', path: 'src' } }] }, session_id: sid });
out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, session_id: sid });
delta(text);
out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: sid });
out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1800000000, rateLimitType: 'seven_day', utilization: 0.42 } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'Looking at \n\n' + text, session_id: sid, total_cost_usd: 0.0123, num_turns: 2 });

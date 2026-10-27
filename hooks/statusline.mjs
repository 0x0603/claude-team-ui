#!/usr/bin/env node
// statusLine command set by Claude Team UI for cartridge sessions.
// Saves the plan usage Claude Code reports (rate_limits) for the console, and prints a short status line.
// Usage: node statusline.mjs <usage.json path>
import fs from 'node:fs';
import path from 'node:path';

let d = {};
try { d = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
const rl = d.rate_limits;
const out = process.argv[2];
if (out && rl && (rl.five_hour || rl.seven_day)) {
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), rate_limits: rl }));
    fs.renameSync(tmp, out);
  } catch {}
}
const pct = v => (typeof v === 'number' ? `${Math.round(v)}%` : null);
const parts = [
  d.model && d.model.display_name,
  d.context_window && pct(d.context_window.used_percentage) && `context ${pct(d.context_window.used_percentage)}`,
  rl && rl.five_hour && pct(rl.five_hour.used_percentage) && `5h ${pct(rl.five_hour.used_percentage)}`,
  rl && rl.seven_day && pct(rl.seven_day.used_percentage) && `7d ${pct(rl.seven_day.used_percentage)}`,
].filter(Boolean);
process.stdout.write(parts.join(' · '));

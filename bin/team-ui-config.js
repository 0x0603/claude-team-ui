#!/usr/bin/env node
// Moves the console's projects and settings between machines through a manifest with paths relative to a root folder.
//   node bin/team-ui-config.js export <manifest.json> --root <dir>   current config → manifest
//   node bin/team-ui-config.js import <manifest.json> --root <dir>   manifest → current config (adds, never removes)
// The login token and plan usage stay per machine.
'use strict';
const fs = require('fs');
const path = require('path');
const { RUNTIME, Config } = require('../lib/config');
const { inside } = require('../lib/util');

const [cmd, file] = process.argv.slice(2);
const ri = process.argv.indexOf('--root');
const root = ri > -1 ? path.resolve(process.argv[ri + 1]) : null;
if (!['import', 'export'].includes(cmd) || !file || !root) {
  console.error('Usage: team-ui-config.js import|export <manifest.json> --root <dir>');
  process.exit(1);
}
const config = new Config(RUNTIME.configDir);

if (cmd === 'export') {
  const projects = [];
  for (const p of config.projects) {
    if (!inside(root, p.path)) { console.log(`skip  ${p.path} (outside ${root})`); continue; }
    projects.push({ path: path.relative(root, p.path), ...(p.node ? { node: p.node } : {}), ...(p.testCommand ? { testCommand: p.testCommand } : {}) });
  }
  const scanRoots = config.scanRoots.filter(s => inside(root, s)).map(s => path.relative(root, s) || '.');
  fs.writeFileSync(file, JSON.stringify({ projects, models: config.models, scanRoots }, null, 2) + '\n');
  console.log(`wrote ${projects.length} projects to ${file}`);
} else {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const e of m.projects || []) {
    const abs = path.resolve(root, e.path);
    if (!fs.existsSync(abs)) { console.log(`skip  ${e.path} (not on this machine)`); continue; }
    const p = config.addProject(abs);
    config.updateProject(p.id, { node: e.node || '', testCommand: e.testCommand || '' });
    console.log(`ok    ${p.id}${e.node ? ` (Node ${e.node})` : ''}`);
  }
  if (m.models) config.setModels(m.models);
  if (Array.isArray(m.scanRoots)) { config.data.scanRoots = m.scanRoots.map(s => path.resolve(root, s)); config.save(); }
  console.log(`config: ${config.file}`);
}

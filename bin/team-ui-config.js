#!/usr/bin/env node
// Moves the console's projects and settings between machines through a manifest with paths relative to a root folder.
// Each project's own prompts (.claude/team-ui/prompts: rules, checks, phase prompts) travel in prompts/<name>/ next to it.
//   node bin/team-ui-config.js export <manifest.json> --root <dir>   current config → manifest
//   node bin/team-ui-config.js import <manifest.json> --root <dir>   manifest → current config (adds, never removes projects)
// The login token and plan usage stay per machine.
'use strict';
const fs = require('fs');
const path = require('path');
const { RUNTIME, Config } = require('../lib/config');
const { inside } = require('../lib/util');
const { Project } = require('../lib/cartridges');

const promptDir = projectPath => path.join(projectPath, '.claude', 'team-ui', 'prompts');
const promptFiles = dir => { try { return fs.readdirSync(dir).filter(f => /^[\w.-]+\.md$/.test(f)); } catch { return []; } };

const [cmd, file] = process.argv.slice(2);
const ri = process.argv.indexOf('--root');
const root = ri > -1 ? path.resolve(process.argv[ri + 1]) : null;
if (!['import', 'export'].includes(cmd) || !file || !root) {
  console.error('Usage: team-ui-config.js import|export <manifest.json> --root <dir>');
  process.exit(1);
}
const config = new Config(RUNTIME.configDir);

if (cmd === 'export') {
  const projects = [], names = new Set();
  const out = path.join(path.dirname(path.resolve(file)), 'prompts');
  fs.rmSync(out, { recursive: true, force: true }); // the export mirrors this machine
  for (const p of config.projects) {
    if (!inside(root, p.path)) { console.log(`skip  ${p.path} (outside ${root})`); continue; }
    const entry = { path: path.relative(root, p.path), ...(p.node ? { node: p.node } : {}), ...(p.testCommand ? { testCommand: p.testCommand } : {}) };
    const files = promptFiles(promptDir(p.path));
    if (files.length) {
      let name = path.basename(p.path);
      for (let i = 2; names.has(name); i++) name = `${path.basename(p.path)}-${i}`;
      names.add(name);
      fs.mkdirSync(path.join(out, name), { recursive: true });
      for (const f of files) fs.copyFileSync(path.join(promptDir(p.path), f), path.join(out, name, f));
      entry.prompts = `prompts/${name}`;
      console.log(`prompts ${name}: ${files.join(', ')}`);
    }
    projects.push(entry);
  }
  const scanRoots = config.scanRoots.filter(s => inside(root, s)).map(s => path.relative(root, s) || '.');
  fs.writeFileSync(file, JSON.stringify({ projects, models: config.models, scanRoots }, null, 2) + '\n');
  console.log(`wrote ${projects.length} projects to ${file}`);
} else {
  (async () => {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const base = path.dirname(path.resolve(file));
    for (const e of m.projects || []) {
      const abs = path.resolve(root, e.path);
      if (!fs.existsSync(abs)) { console.log(`skip  ${e.path} (not on this machine)`); continue; }
      const p = config.addProject(abs);
      config.updateProject(p.id, { node: e.node || '', testCommand: e.testCommand || '' });
      console.log(`ok    ${p.id}${e.node ? ` (Node ${e.node})` : ''}`);
      const src = e.prompts ? path.resolve(base, e.prompts) : null;
      if (src && inside(base, src)) {
        const files = promptFiles(src);
        fs.mkdirSync(promptDir(abs), { recursive: true });
        for (const f of files) fs.copyFileSync(path.join(src, f), path.join(promptDir(abs), f)); // the manifest's copy wins
        await new Project({ id: p.id, path: abs }).excludeLocal(); // the prompts stay out of that repo's commits
        if (files.length) console.log(`      prompts: ${files.join(', ')}`);
      }
    }
    if (m.models) config.setModels(m.models);
    if (Array.isArray(m.scanRoots)) { config.data.scanRoots = m.scanRoots.map(s => path.resolve(root, s)); config.save(); }
    console.log(`config: ${config.file}`);
  })().catch(e => { console.error(e.message); process.exit(1); });
}

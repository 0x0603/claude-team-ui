'use strict';
// Save to context: a cartridge's notebook goes into the user's notes repository, laid out as
// projects/<repo>/issues/<folder>/ with a brief.md router, so another machine has it after a git pull. The repository
// is the user's own: the console writes only the files it saves and the brief.md rows that point at them, and when
// asked commits only those paths, never ones that already had changes of their own.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { run, firstLine, statSafe, slugify } = require('./util');

const CORE = ['brief.md', 'issue.md', 'plan.md', 'process.md', 'outcome.md']; // the dossier's own files, never replaced
const FOLDER_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const day = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
const bad = msg => Object.assign(new Error(msg), { status: 400 });
const git = (root, ...a) => run('git', ['-C', root, ...a], { timeout: 60000 });

// What the cartridge is about, for matching a folder: its issue, the issues its PR closes, its PR
function refs(cart, closing) {
  return { issues: [...new Set([cart.rec.issue, ...(closing || [])].filter(Boolean).map(Number))], pr: cart.rec.pr ? Number(cart.rec.pr) : null };
}
const localOf = cart => cart.reg.localName(cart.project, cart.id);
const kindWord = cart => ({ review: 'Review', research: 'Research' }[cart.kind] || 'Team');
const cleanTitle = t => String(t || '').replace(/^(Review PR #\d+|Review|Research:)\s*/i, '').replace(/^#\d+\s+/, '').trim();

function issuesDir(root, cart) {
  if (!root) throw bad('Set the context repository in Projects and settings first');
  return path.join(root, 'projects', cart.project.name, 'issues');
}

// Fast-forward the repository first, so a folder made and pushed on the other machine is found instead of made twice
async function pull(root) {
  if (!(await git(root, 'rev-parse', '--abbrev-ref', '@{u}')).ok) return null;
  const r = await git(root, 'pull', '--ff-only', '--quiet');
  return r.ok ? null : `Could not update the context repository first (${firstLine(r.stderr)}); an existing folder made elsewhere may be missing`;
}

// The folder to save into (an existing one for the same issue or PR, else a new name), and the notebook files with the
// summaries and reports ticked
async function preview(root, cart, closing) {
  const dir = issuesDir(root, cart);
  if (!(await statSafe(dir))) throw bad(`No projects/${cart.project.name}/issues in ${root}`);
  const note = await pull(root);
  const folders = (await fsp.readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory() && FOLDER_RE.test(e.name)).map(e => e.name).sort();
  const { issues, pr } = refs(cart, closing);
  const hit = issues.map(n => folders.find(f => f.startsWith(`gh-${n}-`))).find(Boolean) || (pr ? folders.find(f => f.startsWith(`task-pr-${pr}-`)) : null);
  const slug = slugify(cleanTitle(cart.title), 40);
  const fresh = issues.length ? `gh-${issues[0]}-${slug}` : pr ? `task-pr-${pr}-${slug}` : `task-${slug}`;
  const files = [];
  for (const f of await cart.plans()) {
    if (!f.path.startsWith('plans/')) continue;
    const st = await statSafe(path.join(cart.dir, f.path));
    const base = path.basename(f.path);
    files.push({ path: f.path, size: st ? st.size : 0, on: !f.path.startsWith('plans/context/') && /summary|report|plan|outcome|verdict|decision/i.test(base) && !/findings|tasks/i.test(base) });
  }
  return { root, repo: cart.project.name, folders, folder: hit || fresh, existing: !!hit, files, note };
}

// Its own frontmatter, so `rg "^github: <n>"` finds the file with the rest of the dossier
function withFrontmatter(text, meta) {
  const keys = Object.entries(meta).filter(([, v]) => v != null && v !== '');
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return `---\n${keys.map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${text}`;
  const have = new Set(m[1].split('\n').map(l => l.split(':')[0].trim()));
  return `---\n${[m[1], ...keys.filter(([k]) => !have.has(k)).map(([k, v]) => `${k}: ${v}`)].join('\n')}\n---\n${text.slice(m[0].length)}`;
}

// One row per saved file in "Which file answers what"; a new folder gets a short brief of its own
async function updateBrief(dir, rows, info) {
  const f = path.join(dir, 'brief.md');
  const row = r => `| ${r.label} | \`${r.name}\` | ${r.tok} |`;
  let text = null;
  try { text = await fsp.readFile(f, 'utf8'); } catch {}
  if (text == null) {
    await fsp.writeFile(f, `---\ntype: brief\nrepo: ${info.repo}\ngithub: ${info.github}\nstatus: Active\nnext:\nupdated: ${day()}\n---\n\n`
      + `# ${info.title} · brief\n\n**The entry point. Read this, then open exactly one row from the map below.**\n\n`
      + `## State in five lines\n\n- Saved from the Claude Team UI cartridge \`${info.local}\` on ${day()}${info.verdict ? `; verdict ${info.verdict}` : ''}.\n\n`
      + `## Which file answers what\n\n| Question | File | ~tok |\n| -------- | ---- | ---: |\n${rows.map(row).join('\n')}\n`);
    return true;
  }
  const lines = text.split('\n');
  const add = rows.filter(r => !text.includes(`\`${r.name}\``));
  if (add.length) {
    const h = lines.findIndex(l => /^##\s+Which file answers what/i.test(l));
    let k = h + 1;
    while (h >= 0 && k < lines.length && !lines[k].startsWith('|') && !/^##\s/.test(lines[k])) k++;
    if (h < 0) lines.push('', '## Which file answers what', '', '| Question | File | ~tok |', '| -------- | ---- | ---: |', ...add.map(row));
    else if (k >= lines.length || !lines[k].startsWith('|')) lines.splice(h + 1, 0, '', '| Question | File | ~tok |', '| -------- | ---- | ---: |', ...add.map(row));
    else { while (k < lines.length && lines[k].startsWith('|')) k++; lines.splice(k, 0, ...add.map(row)); }
  }
  const out = lines.join('\n').replace(/^(---\n[\s\S]*?\nupdated:)[^\n]*/, `$1 ${day()}`);
  if (out === text) return false;
  await fsp.writeFile(f, out);
  return true;
}

async function save(root, cart, { folder, files, push, closing, verdict }) {
  folder = String(folder || '');
  if (!FOLDER_RE.test(folder)) throw bad('A folder name is lowercase letters, digits and dashes');
  const base = issuesDir(root, cart);
  if (!(await statSafe(base))) throw bad(`No projects/${cart.project.name}/issues in ${root}`);
  const known = new Set((await cart.plans()).map(f => f.path));
  const picked = [...new Set(Array.isArray(files) ? files : [])].filter(f => known.has(f) && f.startsWith('plans/'));
  if (!picked.length) throw bad('Tick at least one notebook file');
  const note = push ? await pull(root) : null;
  const dir = path.join(base, folder);
  await fsp.mkdir(dir, { recursive: true });
  const local = localOf(cart);
  const { issues, pr } = refs(cart, closing);
  const rel = n => path.relative(root, path.join(dir, n));
  // A file this cartridge saved before is replaced; anyone else's keeps its name and ours takes the cartridge's
  const ours = async (n, src) => { try { return (await fsp.readFile(path.join(dir, n), 'utf8')).includes(`\nsource: ${src}\n`); } catch { return null; } };
  const plan = [];
  for (const p of picked) {
    const src = `Claude Team UI cartridge ${local}, ${p}`;
    let name = p.replace(/^plans\//, '').replace(/\//g, '-');
    if (CORE.includes(name) || (await ours(name, src)) === false) name = `${local}-${name}`;
    if ((await ours(name, src)) === false) throw bad(`${folder}/${name} already exists and is not from this cartridge`);
    plan.push({ p, name, src });
  }
  const targets = [...plan.map(x => rel(x.name)), rel('brief.md')];
  // A brief.md with edits of its own is not committed with ours
  const dirty = push ? (await git(root, 'status', '--porcelain', '--', rel('brief.md'))).stdout.split('\n').filter(l => l.trim() && !l.startsWith('??')).join('\n') : '';
  const rows = [];
  for (const { p, name, src } of plan) {
    const text = withFrontmatter(await fsp.readFile(path.join(cart.dir, p), 'utf8'),
      { type: 'notebook', repo: cart.project.name, github: issues[0] || '', pr: pr || '', source: src, updated: day() });
    await fsp.writeFile(path.join(dir, name), text);
    const stem = path.basename(p).replace(/\.md$/, '').replace(/[-_]+/g, ' ');
    rows.push({ name, tok: `${(Buffer.byteLength(text) / 3800).toFixed(1)}k`, label: `${kindWord(cart)} notebook: ${stem}${verdict && /report|summary/.test(name) ? ` (${verdict})` : ''}` });
  }
  await updateBrief(dir, rows, { repo: cart.project.name, github: issues[0] || '', title: cleanTitle(cart.title) || local, local, verdict });
  const out = { folder, dir: path.relative(root, dir), written: plan.map(x => x.name), committed: null, pushed: false, note };
  if (!push) return out;
  if (dirty) return { ...out, note: 'Saved, not committed: brief.md already had edits of its own. Commit it at the Mac.' };
  const changed = (await git(root, 'status', '--porcelain', '-uall', '--', ...targets)).stdout.trim();
  if (!changed) return { ...out, note: 'Nothing changed since the last save' };
  const add = await git(root, 'add', '--', ...targets);
  if (!add.ok) return { ...out, note: 'git add failed: ' + firstLine(add.stderr) };
  const c = await git(root, 'commit', '-q', '-m', `${cart.project.name}: save ${folder} notes from the console`, '--', ...targets);
  if (!c.ok) return { ...out, note: 'git commit failed: ' + firstLine(c.stderr || c.stdout) };
  out.committed = (await git(root, 'rev-parse', '--short', 'HEAD')).stdout.trim();
  const ps = await git(root, 'push', '-q');
  if (!ps.ok) return { ...out, note: `Committed ${out.committed}, but the push failed (${firstLine(ps.stderr)}); push from the Mac` };
  return { ...out, pushed: true };
}

module.exports = { preview, save };

'use strict';
// GitHub through the gh CLI. Nothing here runs unless the user clicked for it.
const { run, firstLine } = require('./util');

const gh = (cwd, ...args) => run('gh', args, { cwd, timeout: 60000 });

function ghError(stderr) {
  if (/not found|ENOENT/i.test(stderr)) return 'GitHub CLI is not installed (brew install gh).';
  if (/auth login|not logged|authentication/i.test(stderr)) return 'GitHub CLI is not logged in. Run: gh auth login';
  return firstLine(stderr);
}

async function listIssues(cwd) {
  const r = await gh(cwd, 'issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,labels,url,updatedAt,assignees');
  if (!r.ok) return { ok: false, error: ghError(r.stderr), issues: [] };
  let issues = [];
  try { issues = JSON.parse(r.stdout); } catch {}
  return {
    ok: true, issues: issues.map(i => ({
      number: i.number, title: i.title, url: i.url, updatedAt: i.updatedAt,
      labels: (i.labels || []).map(l => l.name), assignees: (i.assignees || []).map(a => a.login),
    })),
  };
}

async function issueBody(cwd, n) {
  const r = await gh(cwd, 'issue', 'view', String(n), '--json', 'body');
  try { return JSON.parse(r.stdout).body || ''; } catch { return ''; }
}

async function createIssue(cwd, title, body) {
  const r = await gh(cwd, 'issue', 'create', '--title', title, '--body', body || title);
  if (!r.ok) throw new Error('Could not create the issue: ' + ghError(r.stderr));
  const url = (r.stdout.match(/https?:\/\/\S+\/issues\/\d+/) || [])[0] || null;
  return { url, number: url ? Number(url.split('/').pop()) : null };
}

async function prView(cwd, n) {
  const r = await gh(cwd, 'pr', 'view', String(n), '--json', 'headRefName,baseRefName,title,url');
  if (!r.ok) throw new Error(`Could not read PR #${n}: ` + ghError(r.stderr));
  return JSON.parse(r.stdout);
}

// Pushes the cartridge branch, then opens the PR. Agents are blocked from pushing; only this user action pushes.
async function openPr(cwd, { branch, base, title, body, draft }) {
  const push = await run('git', ['-C', cwd, 'push', '-u', 'origin', branch], { timeout: 120000 });
  if (!push.ok) throw new Error('git push failed: ' + firstLine(push.stderr));
  const args = ['pr', 'create', '--head', branch, '--title', title, '--body', body || ''];
  if (base) args.push('--base', base);
  if (draft) args.push('--draft');
  const r = await gh(cwd, ...args);
  if (!r.ok) throw new Error('Could not open the PR: ' + ghError(r.stderr));
  return { url: (r.stdout.match(/https?:\/\/\S+\/pull\/\d+/) || [])[0] || r.stdout.trim() };
}

module.exports = { listIssues, issueBody, createIssue, prView, openPr };

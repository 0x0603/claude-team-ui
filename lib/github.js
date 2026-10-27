'use strict';
// GitHub through the gh CLI. Nothing here runs unless the user clicked for it.
const { run, firstLine } = require('./util');

const gh = (cwd, ...args) => run('gh', args, { cwd, timeout: 60000 });

function ghError(stderr) {
  if (/not found|ENOENT/i.test(stderr)) return 'GitHub CLI is not installed (brew install gh).';
  if (/auth login|not logged|authentication/i.test(stderr)) return 'GitHub CLI is not logged in. Run: gh auth login';
  return firstLine(stderr);
}

// Open issues of one repo. mine: assigned to the signed-in gh user; query: GitHub search text.
async function listIssues(cwd, { mine = false, query = '' } = {}) {
  const args = ['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,labels,url,updatedAt,assignees,closedByPullRequestsReferences'];
  if (mine) args.push('--assignee', '@me');
  if (query) args.push('--search', query);
  const r = await gh(cwd, ...args);
  if (!r.ok) return { ok: false, error: ghError(r.stderr), issues: [] };
  let issues = [];
  try { issues = JSON.parse(r.stdout); } catch {}
  return {
    ok: true, issues: issues.map(i => ({
      number: i.number, title: i.title, url: i.url, updatedAt: i.updatedAt,
      labels: (i.labels || []).map(l => l.name), assignees: (i.assignees || []).map(a => a.login),
      // PRs in the same repository that will close this issue
      prs: (i.closedByPullRequestsReferences || []).filter(p => p.url && i.url && p.url.split('/pull/')[0] === i.url.split('/issues/')[0])
        .map(p => ({ number: p.number, url: p.url })),
    })),
  };
}

// Open pull requests of one repo. mine: opened by the gh user or waiting for their review; query: GitHub search text.
async function listPrs(cwd, { mine = false, query = '' } = {}) {
  const base = ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,url,headRefName,author,isDraft,updatedAt,reviewDecision'];
  const out = new Map();
  for (const s of mine ? [`author:@me ${query}`, `review-requested:@me ${query}`] : [query]) {
    const r = await gh(cwd, ...base, ...(s.trim() ? ['--search', s.trim()] : []));
    if (!r.ok) return { ok: false, error: ghError(r.stderr), prs: [] };
    let list = [];
    try { list = JSON.parse(r.stdout); } catch {}
    for (const p of list) {
      out.set(p.number, { number: p.number, title: p.title, url: p.url, branch: p.headRefName, author: (p.author || {}).login || '', draft: !!p.isDraft, updatedAt: p.updatedAt, review: p.reviewDecision || '' });
    }
  }
  return { ok: true, prs: [...out.values()] };
}

async function issueInfo(cwd, n) {
  const r = await gh(cwd, 'issue', 'view', String(n), '--json', 'title,url,body');
  if (!r.ok) throw new Error(`Could not read issue #${n}: ` + ghError(r.stderr));
  const j = JSON.parse(r.stdout);
  return { title: j.title || `Issue ${n}`, url: j.url || null, body: j.body || '' };
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

module.exports = { listIssues, listPrs, issueInfo, createIssue, prView, openPr };

'use strict';
// GitHub through the gh CLI. Nothing here runs unless the user clicked for it.
const { run, firstLine } = require('./util');

const gh = (cwd, ...args) => run('gh', args, { cwd, timeout: 60000 });

function ghError(stderr) {
  if (/not found|ENOENT/i.test(stderr)) return 'GitHub CLI is not installed (brew install gh).';
  if (/auth login|not logged|authentication/i.test(stderr)) return 'GitHub CLI is not logged in. Run: gh auth login';
  return firstLine(stderr);
}

// Issues of one repo. assignee/author: a login or @me; label; state: open, closed or all; query: GitHub search text.
async function listIssues(cwd, { assignee = '', author = '', label = '', state = 'open', query = '' } = {}) {
  const args = ['issue', 'list', '--state', state, '--limit', '100', '--json', 'number,title,labels,url,updatedAt,createdAt,assignees,author,closedByPullRequestsReferences'];
  if (assignee) args.push('--assignee', assignee);
  if (author) args.push('--author', author);
  if (label) args.push('--label', label);
  if (query) args.push('--search', query);
  const r = await gh(cwd, ...args);
  if (!r.ok) return { ok: false, error: ghError(r.stderr), issues: [] };
  let issues = [];
  try { issues = JSON.parse(r.stdout); } catch {}
  return {
    ok: true, issues: issues.map(i => ({
      number: i.number, title: i.title, url: i.url, updatedAt: i.updatedAt, createdAt: i.createdAt || i.updatedAt,
      labels: (i.labels || []).map(l => l.name), assignees: (i.assignees || []).map(a => a.login), author: (i.author || {}).login || '',
      // PRs in the same repository that will close this issue
      prs: (i.closedByPullRequestsReferences || []).filter(p => p.url && i.url && p.url.split('/pull/')[0] === i.url.split('/issues/')[0])
        .map(p => ({ number: p.number, url: p.url })),
    })),
  };
}

// Open pull requests of one repo. mine: opened by the gh user or waiting for their review (unless an author or review
// filter is set); author: a login or @me; review "me": waiting for my review; draft: ready or draft; decision: a GitHub
// review qualifier (approved, changes_requested, required, none); query: GitHub search text.
async function listPrs(cwd, { mine = false, author = '', review = '', draft = '', decision = '', query = '' } = {}) {
  const base = ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,url,headRefName,author,isDraft,updatedAt,reviewDecision'];
  if (author) base.push('--author', author);
  const qual = [query, review === 'me' ? 'review-requested:@me' : '', draft === 'draft' ? 'draft:true' : draft === 'ready' ? 'draft:false' : '',
    decision ? `review:${decision}` : ''].filter(Boolean).join(' ');
  const out = new Map();
  for (const s of mine && !author && !review ? [`author:@me ${qual}`, `review-requested:@me ${qual}`] : [qual]) {
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

// What reviewers said on a PR: unresolved review threads, reviews with a body, and conversation comments; bots left out
const FEEDBACK_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewDecision
  reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:20){nodes{author{login} body url}}}}
  reviews(last:30){nodes{author{login} state body}} comments(last:50){nodes{author{login} body}}}}}`;
async function prFeedback(cwd, url) {
  const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error('Not a GitHub pull request link');
  const r = await gh(cwd, 'api', 'graphql', '-f', `query=${FEEDBACK_QUERY}`, '-F', `o=${m[1]}`, '-F', `r=${m[2]}`, '-F', `n=${m[3]}`);
  if (!r.ok) throw new Error('Could not read the PR reviews: ' + ghError(r.stderr));
  const pr = ((JSON.parse(r.stdout).data || {}).repository || {}).pullRequest;
  if (!pr) throw new Error('Pull request not found');
  const human = a => !!(a && a.login && !/\[bot\]$|^github-actions$/.test(a.login));
  const threads = (pr.reviewThreads.nodes || []).filter(t => !t.isResolved && (t.comments.nodes || []).length).map(t => {
    const [first, ...rest] = t.comments.nodes;
    return { path: t.path, line: t.line, outdated: !!t.isOutdated, author: (first.author || {}).login || '?', body: first.body || '', url: first.url || '',
      replies: rest.map(c => `${(c.author || {}).login || '?'}: ${c.body}`) };
  });
  const reviews = (pr.reviews.nodes || []).filter(v => human(v.author) && String(v.body || '').trim() && v.state !== 'DISMISSED')
    .map(v => ({ author: v.author.login, state: v.state, body: v.body }));
  const comments = (pr.comments.nodes || []).filter(c => human(c.author) && String(c.body || '').trim()).map(c => ({ author: c.author.login, body: c.body }));
  return { number: Number(m[3]), decision: pr.reviewDecision || '', threads, reviews, comments };
}

async function pushBranch(cwd, branch) {
  const push = await run('git', ['-C', cwd, 'push', '-u', 'origin', branch], { timeout: 120000 }); // hooks run: no --no-verify
  if (!push.ok) throw new Error('git push failed: ' + firstLine(push.stderr));
}

// Pushes the cartridge branch, then opens the PR. Agents are blocked from pushing; only this user action pushes.
async function openPr(cwd, { branch, base, title, body, draft }) {
  await pushBranch(cwd, branch);
  const args = ['pr', 'create', '--head', branch, '--title', title, '--body', body || ''];
  if (base) args.push('--base', base);
  if (draft) args.push('--draft');
  const r = await gh(cwd, ...args);
  const url = (`${r.stdout}\n${r.stderr}`.match(/https?:\/\/\S+\/pull\/\d+/) || [])[0];
  if (!r.ok && !(url && /already exists/i.test(r.stderr))) throw new Error('Could not open the PR: ' + ghError(r.stderr));
  return { url: url || r.stdout.trim() }; // a PR that already exists for the branch counts as opened
}

// Whether a pull request is still open, for tidying up: OPEN, MERGED or CLOSED
async function prState(cwd, url) {
  const r = await gh(cwd, 'pr', 'view', String(url), '--json', 'state,mergedAt');
  if (!r.ok) throw new Error('Could not read the PR: ' + ghError(r.stderr));
  const j = JSON.parse(r.stdout);
  return { state: String(j.state || 'OPEN').toUpperCase(), mergedAt: j.mergedAt || null };
}
// Only Tidy up calls this, for a merged branch of an ejected cartridge the user ticked
async function deleteRemoteBranch(cwd, branch) {
  const r = await run('git', ['-C', cwd, 'push', 'origin', '--delete', branch], { timeout: 120000 });
  if (!r.ok) throw new Error('Could not delete the remote branch: ' + firstLine(r.stderr));
}

module.exports = { listIssues, listPrs, prFeedback, pushBranch, issueInfo, createIssue, prView, openPr, prState, deleteRemoteBranch };

'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => (/^https?:\/\//i.test(String(u || '')) ? String(u) : null);
const isMobile = () => matchMedia('(max-width: 820px)').matches;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

let OV = null;                          // overview from the server
let S = null;                           // state of the selected cartridge
let cur = store.get('ctu-cart', '') || null; // selected cartridge, null = overview
let selPane = null;
let sideTab = 'team';
let mobileSec = 'flow';
let planOpen = null;

const ATTN_LABEL = { permission: 'permission', trust: 'trust folder', question: 'answer', exit: 'exit menu' };
const MODE_LABEL = { planning: 'plan only', code: 'can code' };
const PERMISSION_LABEL = {
  auto: 'Auto (default): Claude decides',
  manual: 'Manual: ask me each time',
  acceptEdits: 'Accept edits: commands ask',
  plan: 'Plan: read only',
  dontAsk: "Don't ask: refuse the rest",
};
const tilde = p => (OV && OV.home && String(p).startsWith(OV.home + '/') ? '~' + String(p).slice(OV.home.length) : String(p || ''));
// The cartridge folder, shown relative to its project when it lives inside it
function cartWhere(c) {
  const p = OV && OV.projects.find(x => x.id === c.project);
  if (!p || !c.dir.startsWith(p.path)) return tilde(c.dir);
  const rel = c.dir.slice(p.path.length + 1);
  return rel ? `${p.name}/${rel}` : p.name;
}

// ---------- Server calls ----------
async function call(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CTU': '1' }, body: JSON.stringify(body) };
  const r = await fetch('/api/' + path, opt);
  if (r.status === 401) { location.reload(); throw new Error('Session expired'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
// Calls for the selected cartridge
const api = (path, body) => call(path + (path.includes('?') ? '&' : '?') + 'cart=' + encodeURIComponent(cur || ''),
  body === undefined ? undefined : { cart: cur, ...body });

function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 5500 : 2600);
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); await refreshAll(); return r; }
  catch (e) { toast(e.message, true); return null; }
}
const ago = t => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + 's'; if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h'; return new Date(t).toLocaleDateString();
};
const dur = ms => { const m = Math.floor(ms / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const money = v => (v == null ? '–' : '$' + Number(v).toFixed(2));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const kTokens = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0));

// ---------- Minimal markdown (escaped first) ----------
function md(src) {
  const lines = esc(src).split('\n');
  let out = '', inCode = false, list = null, table = false;
  const inline = s => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
  const close = () => { if (list) { out += `</${list}>`; list = null; } if (table) { out += '</table>'; table = false; } };
  for (const l of lines) {
    if (l.startsWith('```')) { close(); out += inCode ? '</pre>' : '<pre>'; inCode = !inCode; continue; }
    if (inCode) { out += l + '\n'; continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { close(); out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      if (/^\s*\|[\s:\-|]+\|\s*$/.test(l)) continue;
      if (list) { out += `</${list}>`; list = null; }
      if (!table) { out += '<table>'; table = true; }
      out += '<tr>' + l.trim().slice(1, -1).split('|').map(c => `<td>${inline(c.trim())}</td>`).join('') + '</tr>';
      continue;
    }
    if ((m = l.match(/^\s*[-*]\s+(.*)/)) || (m = l.match(/^\s*\d+[.)]\s+(.*)/))) {
      const type = /^\s*\d/.test(l) ? 'ol' : 'ul';
      if (table) { out += '</table>'; table = false; }
      if (list !== type) { if (list) out += `</${list}>`; out += `<${type}>`; list = type; }
      out += `<li>${inline(m[1])}</li>`;
      continue;
    }
    close();
    if ((m = l.match(/^&gt;\s?(.*)/))) { out += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    if (l.trim()) out += `<p>${inline(l)}</p>`;
  }
  close(); if (inCode) out += '</pre>';
  return `<div class="md">${out}</div>`;
}

// ---------- Dialog ----------
function dialog(title, bodyHTML, actions) {
  return new Promise(resolve => {
    const d = $('#dlg');
    $('#dlg-title').textContent = title;
    $('#dlg-body').innerHTML = bodyHTML;
    const box = $('#dlg-actions');
    box.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'pbtn ' + (a.cls || '');
      b.textContent = a.label;
      b.value = a.value;
      b.type = a.value === 'cancel' ? 'submit' : 'button';
      b.onclick = () => {
        if (a.value === 'cancel') return;
        const data = Object.fromEntries($$('#dlg-body [name]').map(el => [el.name, el.type === 'checkbox' ? el.checked : el.value]));
        if (a.validate && !a.validate(data)) return;
        d.onclose = null;
        d.close();
        resolve({ action: a.value, data });
      };
      box.appendChild(b);
    }
    d.onclose = () => resolve({ action: 'cancel', data: {} });
    if (d.open) d.close();
    d.showModal();
  });
}
const CANCEL = { label: 'Cancel', value: 'cancel', cls: 'ghost' };
const kindTag = (c, cls = 'kind') => {
  const k = c.home ? 'Main checkout' : c.kind === 'review' ? 'Review' : c.kind === 'research' ? 'Research' : '';
  return k ? `<em class="${cls}">${k}</em>` : '';
};
const FLOW_NAME = { quick: 'Quick', standard: 'Standard', full: 'Full' };
const flowTag = c => (c.kind === 'team' && c.flow ? `<em class="kind">${FLOW_NAME[c.flow]}</em>` : '');
const FLOW_HELP = {
  quick: 'Small task. The lead writes a one-page plan, one developer builds, one reviewer checks all five areas.',
  standard: 'Medium task. A planner and a critic, up to two developers, simplify, two reviewers.',
  full: 'Big or risky work. Spec, planning with five agents, task files, simplify, five reviewers, retro.',
};
const CHECKS_NOTE = 'Every flow builds and reviews logic, security, tests, docs and skills.';
const shortTitle = c => (c.home ? `${c.projectName} (main)` : c.title.replace(/^(Review |Research: )/, ''));

// ---------- Overview, rack, usage, status ----------
async function refreshOverview() {
  try { OV = await call('overview'); } catch { return; }
  if (cur && !OV.cartridges.some(c => c.id === cur)) setCart(null);
  renderRack(); renderUsage(); renderStatus(); renderView();
  if (!cur) renderOverview();
}
function renderRack() {
  const many = OV.projects.length > 1;
  const chips = [];
  $('#btn-all').classList.toggle('active', !cur);
  for (const c of OV.cartridges) {
    chips.push(`<button class="cart-chip ${c.id === cur ? 'active' : ''}" data-cart="${esc(c.id)}"
      title="${esc(`${c.projectName}${c.branch ? ' · ' + c.branch : ''} · ${c.phase}`)}">
      <i class="dot ${c.attention ? 'attn' : c.running ? 'run' : ''}"></i>${many && !c.home ? `<em class="kind proj">${esc(c.projectName)}</em>` : ''}${kindTag(c)}<span>${esc(shortTitle(c))}</span></button>`);
  }
  $('#rack').innerHTML = chips.join('');
  $('#rack-count').textContent = OV.runningCount ? `${OV.runningCount} running` : '';
  if (renderRack.last !== cur) {
    renderRack.last = cur;
    const a = $('.cart-chip.active');
    if (a) a.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
}
function renderUsage() {
  const u = OV.usage, el = $('#usage');
  const pill = (label, x) => (x && x.pct != null
    ? `<span class="u ${x.pct >= 80 ? 'hot' : ''}" title="${label} window${x.resetsAt ? ', resets at ' + clock(x.resetsAt) : ''}">${label} ${Math.round(x.pct)}%</span>` : '');
  const html = u ? pill('5h', u.fiveHour) + pill('7d', u.sevenDay) : '';
  el.hidden = !html;
  if (!html) return;
  el.innerHTML = html;
  const stale = Date.now() - (u.at || 0) > 30 * 60000;
  el.classList.toggle('stale', stale);
  el.title = `Plan usage reported by Claude Code${stale ? `, last seen ${ago(u.at)} ago` : ''}`;
}
function renderStatus() {
  const run = $('#st-run'), led = $('#led');
  const anyAttn = !!(OV && OV.cartridges.some(c => c.attention));
  $('#console').classList.toggle('attn', anyAttn);
  if (!cur || !S) {
    run.textContent = OV ? `${OV.runningCount} running · ${plural(OV.cartridges.length, 'cartridge')}` : '…';
    led.className = 'led' + (anyAttn ? ' attn' : OV && OV.runningCount ? ' on' : '');
    return;
  }
  const attn = S.panes.some(p => p.attention);
  run.textContent = !S.running ? 'Off' : !S.claudeAlive ? 'claude exited · press Start' : `Running · ${plural(S.panes.length, 'agent')}`;
  led.className = 'led' + (attn ? ' attn' : S.running && S.claudeAlive ? ' on' : '');
}
function renderView() {
  const overview = !cur;
  $('#overview').hidden = !overview;
  $('#hud').hidden = overview;
  $('#screen').classList.toggle('ov-mode', overview);
  $('#st-mode').disabled = overview;
  $('#nav-title').textContent = overview ? 'Overview' : '';
}
const rank = (a, b) => (!!b.attention - !!a.attention) || (b.running - a.running) || ((b.createdAt || 0) - (a.createdAt || 0));
function cardHTML(c) {
  const status = c.attention ? `<span class="st attn">Needs you: ${ATTN_LABEL[c.attention] || 'answer'}</span>`
    : c.running ? (c.alive ? `<span class="st run">Running · ${plural(c.agents, 'agent')}${c.startedAt ? ' · ' + dur(Date.now() - c.startedAt) : ''}</span>` : '<span class="st">claude exited</span>')
      : '<span class="st off">Off</span>';
  return `<button class="ccard ${c.attention ? 'attn' : c.running ? 'run' : ''}" data-cart="${esc(c.id)}">
    <span class="cc-top"><span class="ptag">${esc(c.projectName)}</span>${kindTag(c)}${flowTag(c)}</span>
    <span class="cc-title">${esc(c.title)}</span>
    ${status}
    <span class="cc-meta">${esc(c.phase)} · ${MODE_LABEL[c.mode] || ''}${c.branch ? ` · <code>${esc(c.branch)}</code>` : ''}</span>
    <span class="cc-meta">${c.costUSD != null ? money(c.costUSD) + ' used' : ''}${c.prUrl ? (c.costUSD != null ? ' · ' : '') + 'PR open' : ''}</span>
  </button>`;
}
function renderOverview() {
  const box = $('#overview');
  if (!OV.projects.length) {
    box.innerHTML = `<div class="empty-cta">
      <h2 class="pane-title">Add your first project</h2>
      <p>A project is a git repository the teams work in. Each cartridge gets its own worktree and branch inside it, so nothing touches your main checkout.</p>
      <button class="pbtn inv" data-act="projects">Add a project</button></div>`;
    return;
  }
  const carts = [...OV.cartridges].sort(rank);
  box.innerHTML = `<div class="ov-head"><h2 class="pane-title">Cartridges</h2>
      <div class="ov-actions"><button class="pbtn ghost" data-act="projects">Projects and settings</button><button class="pbtn inv ov-add" data-act="add">+ Cartridge</button></div></div>
    ${carts.length ? `<div class="cards">${carts.map(cardHTML).join('')}</div>` : `<div class="empty-cta">
      <p>No cartridges yet. A cartridge is one piece of work (an issue, a new task, a review or a research question) with its own worktree, branch and agent team.</p>
      <button class="pbtn inv" data-act="add">Add the first cartridge</button></div>`}
    <p class="dim ov-foot">${plural(OV.projects.length, 'project')}: ${OV.projects.map(p => esc(p.name)).join(', ')} · v${esc(OV.version)}</p>`;
}

// ---------- Selected cartridge ----------
async function refreshState() {
  if (!cur) { S = null; return; }
  try { S = await api('state'); }
  catch (e) { if (/No such cartridge|Invalid cartridge/.test(e.message)) setCart(null); return; }
  document.title = `${S.cart.title} · Claude Team`;
  renderStatus(); renderHead(); renderPhases(); renderPaneTabs();
  $('#st-mode').classList.toggle('code', S.mode === 'code');
  $('#st-mode').setAttribute('aria-label', `Mode: ${MODE_LABEL[S.mode]}`);
  if (document.activeElement !== $('#request') && !$('#request').dataset.dirty) $('#request').value = S.request || '';
  $('#nav-attn').hidden = !S.panes.some(p => p.attention);
}
async function refreshAll() { await refreshOverview(); await refreshState(); }

function renderHead() {
  const c = S.cart;
  const links = [
    safeUrl(c.url) ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${c.issue ? '#' + c.issue : c.pr ? 'PR #' + c.pr : 'link'}</a>` : '',
    safeUrl(c.prUrl) ? `<a href="${esc(c.prUrl)}" target="_blank" rel="noopener">pull request</a>` : '',
  ].filter(Boolean).join(' · ');
  const where = c.branch ? `Branch <code>${esc(c.branch)}</code>${c.base ? ` from <code>${esc(c.base)}</code>` : ''}`
    : c.target ? `Reviewing <code>${esc(c.target)}</code>` : c.home ? 'Main checkout, current branch' : 'Research folder';
  const flowBtn = c.kind === 'team' ? '<button class="pbtn ghost small" data-act="flow">Change flow</button>' : '';
  $('#cart-head').innerHTML = `<div class="ch-top"><span class="ptag">${esc(c.projectName)}</span>${kindTag(c)}${flowTag(c)}${flowBtn}</div>
    <h2 class="pane-title">${esc(c.title)}</h2><div class="dim">${where}${links ? ' · ' + links : ''}</div>`;
}
function renderPhases() {
  const label = { locked: 'locked', ready: 'ready', running: 'in progress', done: 'done' };
  const lastDone = S.phases.map(p => p.status).lastIndexOf('done');
  const b = (text, what, id, cls = '') => `<button class="pbtn ${cls}" data-ph="${esc(id)}" data-do="${what}">${text}</button>`;
  $('#phases').innerHTML = S.phases.map((p, i) => {
    const tag = p.kind === 'agent' ? MODE_LABEL[p.mode] : 'checkpoint';
    let acts = '';
    if (p.kind === 'agent') {
      if (p.status === 'ready' || p.status === 'running') acts += b(p.status === 'running' ? 'Send again' : 'Run', 'run', p.id, 'inv');
      if (p.status === 'running') acts += b('Mark done', 'done', p.id);
      if (p.rejectTo && (p.status === 'running' || p.status === 'done')) acts += b('Bugs → back to Build', 'back', p.id);
    } else if (p.status === 'ready') acts += b('Review and approve', 'review', p.id, 'inv');
    if (p.pr && S.cart.branch && !S.cart.home && (p.status === 'ready' || p.status === 'done')) {
      acts += safeUrl(S.cart.prUrl) ? `<a class="pbtn" href="${esc(S.cart.prUrl)}" target="_blank" rel="noopener">View PR</a>` : b('Open PR…', 'pr', p.id);
    }
    if (p.status === 'done' && i === lastDone) acts += b('Redo', 'reopen', p.id, 'ghost');
    return `<li class="lv ${p.kind} ${p.status}"><span class="mk" aria-hidden="true"></span><div>
      <div class="lv-name"><span class="lv-no">${String(i + 1).padStart(2, '0')}</span>${esc(p.title)}</div>
      <div class="lv-desc">${esc(p.desc || (p.file ? 'Read ' + p.file : ''))}</div>
      <div class="lv-meta">${tag} · <span class="lv-state">${label[p.status] || p.status}</span></div>
      ${acts ? `<div class="lv-act">${acts}</div>` : ''}</div></li>`;
  }).join('');
}
function renderPaneTabs() {
  const box = $('#pane-tabs');
  if (!S.running) { box.innerHTML = ''; selPane = null; return; }
  if (!S.panes.find(p => p.id === selPane)) selPane = S.panes[0] && S.panes[0].id;
  box.innerHTML = S.panes.map(p => `<button class="ptab ${p.id === selPane ? 'active' : ''} ${p.attention ? 'attn' : ''}"
    data-pane="${esc(p.id)}" title="${esc([p.title, p.model].filter(Boolean).join(' · '))}">${esc(p.label)}</button>`).join('');
}
function setCart(id) {
  cur = id || null;
  store.set('ctu-cart', cur);
  S = null; selPane = null; planOpen = null;
  delete $('#request').dataset.dirty;
  $('#req-saved').textContent = '';
  $('#term').textContent = '…';
  $('#attention').hidden = true;
  document.title = 'Claude Team';
}
async function switchCart(id) {
  if ((id || null) === cur) return;
  setCart(id);
  renderView(); renderRack(); renderStatus();
  if (!cur) renderOverview();
  await refreshState();
  if (cur) { if (isMobile()) go('flow'); refreshTerm(); loadSide(true); }
  bootFx();
}

// ---------- Terminal ----------
const BANNER = {
  permission: ['An agent asks for permission.', [['Yes', 'enter', 'inv'], ['No', 'esc']]],
  question: ['An agent is waiting for your answer.', [['Enter', 'enter', 'inv'], ['Esc', 'esc']]],
  trust: ['Claude asks whether you trust this folder. Trust it only if you trust its code; for a PR from a fork, check .claude/ and .mcp.json first.', [['Trust folder', 'trust', 'inv'], ['Exit', 'enter']]],
  exit: ['Claude asks how to exit while teammates are running.', [['Exit and stop tasks', 'enter', 'inv'], ['Stay', 'esc']]],
};
function renderBanner(kind) {
  const el = $('#attention');
  const b = BANNER[kind];
  el.hidden = !b;
  if (!b) return;
  el.innerHTML = `<span>${esc(b[0])}</span><span class="alert-keys">${b[1].map(([t, k, cls]) =>
    k === 'trust' ? `<button class="pbtn ${cls || ''}" data-act="trust">${t}</button>` : `<button class="pbtn ${cls || ''}" data-key="${k}">${t}</button>`).join('')}</span>`;
}
let termBusy = false;
async function refreshTerm() {
  if (!cur || !S) return;
  if (!S.running) { $('#term').textContent = 'This cartridge is off. Press Start.'; renderBanner(null); return; }
  if (termBusy || (isMobile() && mobileSec !== 'term')) return;
  termBusy = true;
  try {
    const r = await api('pane?id=' + encodeURIComponent(selPane || '') + '&lines=500');
    const t = $('#term');
    const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 40;
    // Phones wrap lines, so full-width rules would turn into blocks of dashes
    const text = isMobile() ? (r.text || '').replace(/^(\s*[─━═╌]{12})[─━═╌]+\s*$/gm, '$1') : r.text;
    if (t.textContent !== text) { t.textContent = text || '(empty)'; if (atBottom) t.scrollTop = t.scrollHeight; }
    renderBanner(r.attention);
  } catch {} finally { termBusy = false; }
}
async function sendMsg(text) {
  if (!text.trim()) return;
  if (!cur) return toast('Pick a cartridge first', true);
  await act(() => api('send', { pane: selPane, text }), 'Sent');
  setTimeout(refreshTerm, 500);
}
async function sendKey(key) {
  if (!cur || !S || !S.running) return toast(cur ? 'This cartridge is off. Press Start.' : 'Pick a cartridge first', true);
  try { await api('key', { pane: selPane, key }); setTimeout(refreshTerm, 250); } catch (e) { toast(e.message, true); }
}

// ---------- Side tabs: team, messages, notebook, git ----------
function showSideTab(tab) {
  sideTab = tab;
  $$('.side-tab').forEach(b => b.classList.toggle('active', b.dataset.go === tab));
  for (const t of ['team', 'inbox', 'plans', 'git']) $('#tab-' + t).hidden = !(t === tab || (isMobile() && tab === 'team' && t === 'inbox'));
  loadSide(true);
}
let sideBusy = false;
async function loadSide(force) {
  if (!cur || sideBusy || (isMobile() && (mobileSec === 'flow' || mobileSec === 'term'))) return;
  sideBusy = true;
  try {
    if (sideTab === 'team' || sideTab === 'inbox') await loadTeam();
    else if (sideTab === 'plans' && force) await loadPlans();
    else if (sideTab === 'git' && force) await loadGit();
  } finally { sideBusy = false; }
}
async function loadTeam() {
  const t = await api('team').catch(() => null);
  if (!t) return;
  const u = t.usage;
  const models = Object.entries(u.models || {});
  const usage = `<div class="usage-card"><div><b>${money(u.costUSD)}</b> <span class="dim">across ${plural(u.sessions, 'session')}${u.lastActivity ? ', last activity ' + ago(u.lastActivity) + ' ago' : ''}</span></div>
    ${models.length ? `<table class="mini">${models.map(([m, x]) => `<tr><td>${esc(m.replace(/^claude-/, ''))}</td><td>${kTokens(x.input)} in</td><td>${kTokens(x.output)} out</td><td>${money(x.costUSD)}</td></tr>`).join('')}</table>` : ''}
    <p class="dim">API-equivalent cost reported by Claude Code. On a subscription it shows how much quota this cartridge used, not a bill.</p></div>`;
  const team = t.team;
  const party = team ? `<ul class="party">${team.members.map(m => `<li title="${esc(m.task)}"><span class="lamp ${m.active ? '' : 'off'}"></span><span>${esc(m.name)}</span>
      <small>${[m.type === 'team-lead' ? 'lead' : m.type, m.model].filter(Boolean).map(esc).join(' · ')}</small></li>`).join('')}</ul>`
    : `<p class="empty">${S && S.running ? 'No team yet. Run a phase and the lead spawns its teammates.' : 'The team shows here while the cartridge runs.'}</p>`;
  const cols = [['in_progress', 'In progress'], ['pending', 'Waiting'], ['completed', 'Done']];
  const tasks = t.tasks.length ? `<h3 class="lbl">Tasks</h3>${cols.map(([k, label]) => {
    const list = t.tasks.filter(x => x.status === k || (k === 'pending' && !cols.some(c => c[0] === x.status)));
    return `<div class="quest-col"><h4>${label} (${list.length})</h4>${list.map(x => `<div class="quest ${esc(x.status)}"><div class="q-name">#${esc(x.id)} ${esc(x.subject)}</div>
      <div class="meta">${x.owner ? '@' + esc(x.owner) : 'unassigned'}${x.blockedBy.length ? ' · waits for #' + x.blockedBy.map(esc).join(', #') : ''}</div></div>`).join('')}</div>`;
  }).join('')}` : '';
  $('#tab-team').innerHTML = `<h3 class="lbl">Team</h3>${party}${tasks}<h3 class="lbl">Usage</h3>${usage}`;
  const msgs = t.messages.length ? t.messages.map(m => `<div class="msg"><div class="who">${esc(m.from)} <span>→ ${esc(m.to)}${m.time ? ' · ' + esc(clock(m.time)) : ''}</span></div>
      ${m.summary ? `<div class="sum">${esc(m.summary)}</div>` : ''}<div class="body">${esc(m.text)}</div></div>`).join('')
    : '<p class="empty">No messages between agents yet.</p>';
  $('#tab-inbox').innerHTML = (isMobile() ? '<h3 class="lbl">Messages</h3>' : '') + msgs;
}
async function loadPlans() {
  const files = await api('plans').catch(() => []);
  const list = files.length ? `<ul class="files">${files.map(f => `<li data-file="${esc(f.path)}" class="${f.path === planOpen ? 'active' : ''}">
      <span>${esc(f.path)}</span><span>${ago(f.mtime)}</span></li>`).join('')}</ul>`
    : '<p class="empty">The notebook is empty. Run the first phase and the team writes its files to plans/.</p>';
  let view = '';
  if (planOpen) {
    try { const f = await api('file?path=' + encodeURIComponent(planOpen)); view = `<div class="doc">${md(f.text)}</div>`; }
    catch (e) { view = `<p class="empty">${esc(e.message)}</p>`; }
  }
  $('#tab-plans').innerHTML = `<div class="row"><button class="pbtn" id="plans-refresh">Reload</button></div>${list}${view}`;
}
async function loadGit() {
  const g = await api('git').catch(e => ({ repo: false, error: e.message }));
  const html = !g.repo ? `<p class="empty">Not a git folder. ${esc(g.error || '')}</p>` : `
    ${g.branch ? `<p class="dim">Branch <code>${esc(g.branch)}</code>${g.base ? ` · ${plural(g.ahead || 0, 'commit')} ahead of <code>${esc(g.base)}</code>` : ''}</p>` : ''}
    <h3 class="lbl">Status</h3><pre class="pre">${esc(g.status || '(clean)')}</pre>
    <h3 class="lbl">Uncommitted changes</h3><pre class="pre">${esc(g.diff || '(none)')}</pre>
    <h3 class="lbl">Commits${g.base ? ' on this branch' : ''}</h3><pre class="pre">${esc(g.log || '(none yet)')}</pre>`;
  $('#tab-git').innerHTML = `<div class="row"><button class="pbtn" id="git-refresh">Reload</button></div>${html}`;
}

// ---------- Phases ----------
async function phaseAction(id, what) {
  const p = S.phases.find(x => x.id === id);
  if (what === 'run') {
    if (!S.running) return toast('This cartridge is off. Press Start.', true);
    const r = await api('prompt?phase=' + id).catch(e => (toast(e.message, true), null));
    if (!r) return;
    const modeNote = S.mode !== p.mode
      ? `<div class="note warn">This phase needs <b>${MODE_LABEL[p.mode]}</b> mode. The console switches it before sending; the lead and its teammates get it right away.</div>` : '';
    const res = await dialog(p.title, `${modeNote}
      <label class="lbl" for="dlg-text">Prompt for the lead (edit it before sending if you like)</label>
      <textarea id="dlg-text" name="text" rows="16">${esc(r.text)}</textarea>
      <div class="row left"><button type="button" class="pbtn ghost" data-act="tpl" data-name="${esc(r.template)}">Edit this project's template</button>
        <button type="button" class="pbtn ghost" data-act="tpl" data-name="_rules.md">Edit team rules</button>
        <button type="button" class="pbtn ghost" data-act="tpl" data-name="_checks.md">Edit quality checks</button></div>`,
    [CANCEL, { label: 'Send to the lead', value: 'send', cls: 'inv' }]);
    if (res.action === 'send') {
      const out = await act(() => api('phase', { phase: id, action: 'run', text: res.data.text }), 'Sent to the lead');
      if (out && out.modeChanged) toast(`Switched to ${MODE_LABEL[out.mode]} mode and sent the prompt`);
      if (isMobile()) go('term');
    }
  } else if (what === 'done') {
    const res = await dialog('Mark this phase done?', `<p><b>${esc(p.title)}</b> is finished and the next phase opens.</p>`, [CANCEL, { label: 'Mark done', value: 'ok', cls: 'inv' }]);
    if (res.action === 'ok') act(() => api('phase', { phase: id, action: 'done' }), 'Next phase is open');
  } else if (what === 'reopen') {
    const res = await dialog('Redo this phase?', `<p>Redoing <b>${esc(p.title)}</b> locks the phases after it.</p>`, [CANCEL, { label: 'Redo', value: 'ok', cls: 'inv' }]);
    if (res.action === 'ok') act(() => api('phase', { phase: id, action: 'reopen' }), 'Phase reopened');
  } else if (what === 'back') {
    const res = await dialog('Back to Build?', `<p>The lead sends the developers back to fix the tasks listed in <code>plans/review.md</code>.
      Simplify and Review + QA run again afterwards.</p>
      <label class="lbl" for="dlg-fb">Notes for the lead (optional)</label>
      <textarea id="dlg-fb" name="feedback" rows="3" placeholder="For example: fix the two critical findings first, skip the minor ones."></textarea>`,
    [CANCEL, { label: 'Back to Build', value: 'ok', cls: 'inv' }]);
    if (res.action === 'ok') act(() => api('phase', { phase: id, action: 'reject', feedback: res.data.feedback }), 'Sent back to Build');
  } else if (what === 'review') {
    await gateDialog(p);
  } else if (what === 'pr') {
    await prDialog();
  }
}
async function gateDialog(p) {
  let content = '<p class="empty">Nothing to review yet.</p>';
  if (p.file) {
    try { const f = await api('file?path=' + encodeURIComponent(p.file)); content = `<div class="doc">${md(f.text)}</div>`; }
    catch { content = `<div class="note warn"><code>${esc(p.file)}</code> does not exist yet. Wait for the lead to report the previous phase done, then open this again.</div>`; }
  }
  const targets = p.forward ? OV.cartridges.filter(x => x.kind === 'team' && x.id !== cur && x.project === S.cart.project) : [];
  const res = await dialog(p.title, `${content}
    ${targets.length ? `<label class="lbl" for="dlg-to">Send the report to a cartridge (optional)</label>
    <select id="dlg-to" name="to"><option value="">Do not send</option>${targets.map(x =>
    `<option value="${esc(x.id)}" ${S.cart.target && x.branch === S.cart.target ? 'selected' : ''}>${esc(shortTitle(x))}${x.running ? '' : ' (off)'}</option>`).join('')}</select>` : ''}
    <label class="lbl" for="dlg-fb">Feedback (needed when you ask for changes)</label>
    <textarea id="dlg-fb" name="feedback" rows="3" placeholder="For example: drop the cache layer for now. Add a migration step with a rollback."></textarea>`,
  [CANCEL, ...(p.pr && S.cart.branch && !S.cart.home ? [{ label: 'Open PR…', value: 'pr' }] : []),
    { label: p.rejectTo ? 'Send back to Build' : 'Ask for changes', value: 'reject', validate: d => (d.feedback.trim() ? true : (toast('Write the feedback first', true), false)) },
    { label: 'Approve', value: 'approve', cls: 'inv' }]);
  if (res.action === 'approve') {
    await act(() => api('phase', { phase: p.id, action: 'approve' }), 'Approved');
    if (res.data.to) {
      const f = await act(() => call('forward', { cart: cur, to: res.data.to }));
      if (f) toast(f.sent ? `Report sent and the other lead told (${f.path})` : `Report copied to ${f.path}. That cartridge is off, so nobody was told yet.`);
    }
  }
  if (res.action === 'reject') act(() => api('phase', { phase: p.id, action: 'reject', feedback: res.data.feedback }), 'Feedback sent to the lead');
  if (res.action === 'pr') prDialog();
}
async function flowDialog() {
  const res = await dialog('Change the flow', `
    <select name="flow" aria-label="Flow">${Object.keys(FLOW_NAME).map(f => `<option value="${f}" ${f === S.cart.flow ? 'selected' : ''}>${FLOW_NAME[f]}</option>`).join('')}</select>
    ${Object.keys(FLOW_NAME).map(f => `<p class="dim"><b>${FLOW_NAME[f]}.</b> ${esc(FLOW_HELP[f])}</p>`).join('')}
    <p class="dim">${CHECKS_NOTE}</p>
    <div class="note warn">The phases start again from the first one. Files in <code>plans/</code> stay.</div>`,
  [CANCEL, { label: 'Change', value: 'ok', cls: 'inv' }]);
  if (res.action === 'ok' && res.data.flow !== S.cart.flow) act(() => api('flow', { flow: res.data.flow }), `Now on the ${FLOW_NAME[res.data.flow]} flow`);
}
async function templateDialog(name) {
  const t = await api('template?name=' + encodeURIComponent(name)).catch(e => (toast(e.message, true), null));
  if (!t) return;
  const res = await dialog(name === '_rules.md' ? 'Team rules for this project' : name === '_checks.md' ? 'Quality checks for this project' : `Template ${name} for this project`, `
    <div class="note">${t.custom ? 'This project uses its own version.' : 'This is the default from the tool.'}
      Saved in <code>.claude/team-ui/prompts/</code> of the project, which git ignores.
      Variables: <code>{{REQUEST}}</code> <code>{{RULES}}</code> <code>{{CHECKS}}</code> <code>{{STRONG}}</code> <code>{{FAST}}</code> <code>{{TEST}}</code> <code>{{BRANCH}}</code> <code>{{BASE}}</code> <code>{{TARGET}}</code> <code>{{SCOPE}}</code> <code>{{PROJECT}}</code></div>
    <textarea name="text" rows="18">${esc(t.text)}</textarea>`,
  [CANCEL, ...(t.custom ? [{ label: 'Reset to default', value: 'reset' }] : []), { label: 'Save for this project', value: 'save', cls: 'inv' }]);
  if (res.action === 'save') act(() => api('template', { name, text: res.data.text }), 'Template saved. Press Run again to use it.');
  if (res.action === 'reset') act(() => api('template', { name, text: null }), 'Back to the default template');
}
async function prDialog() {
  const d = await api('pr-draft').catch(e => (toast(e.message, true), null));
  if (!d) return;
  if (safeUrl(d.prUrl)) return window.open(d.prUrl, '_blank', 'noopener');
  const res = await dialog('Open a pull request', `
    <div class="note">Pushes <code>${esc(d.branch)}</code> to <code>origin</code>, then opens a pull request. Agents never push; only this button does.</div>
    ${d.ahead === 0 ? '<div class="note warn">The branch has no commits ahead of its base yet.</div>' : d.ahead ? `<p class="dim">${plural(d.ahead, 'commit')} ahead of the base.</p>` : ''}
    ${d.dirty ? '<div class="note warn">There are uncommitted changes. Only committed work is pushed.</div>' : ''}
    <label class="lbl" for="pr-base">Into branch</label><input type="text" id="pr-base" name="base" value="${esc(d.base)}">
    <label class="lbl" for="pr-title">Title</label><input type="text" id="pr-title" name="title" value="${esc(d.title)}">
    <label class="lbl" for="pr-body">Description</label><textarea id="pr-body" name="body" rows="10">${esc(d.body)}</textarea>
    <label class="opt"><input type="checkbox" name="draft" checked><span>Open as a draft</span></label>`,
  [CANCEL, { label: 'Push and open PR', value: 'go', cls: 'inv', validate: x => (x.title.trim() ? true : (toast('Write a title', true), false)) }]);
  if (res.action !== 'go') return;
  toast('Pushing and opening the PR…');
  const out = await act(() => api('pr-open', res.data));
  if (out && safeUrl(out.url)) {
    const r = await dialog('Pull request opened', `<p><a href="${esc(out.url)}" target="_blank" rel="noopener">${esc(out.url)}</a></p>`, [{ label: 'Close', value: 'cancel', cls: 'ghost' }, { label: 'Open it', value: 'open', cls: 'inv' }]);
    if (r.action === 'open') window.open(out.url, '_blank', 'noopener');
  }
}

// ---------- Add a cartridge ----------
async function addDialog() {
  if (!OV || !OV.projects.length) return projectsDialog();
  let project = (S && S.cart.project) || store.get('ctu-project', '') || OV.projects[0].id;
  if (!OV.projects.some(p => p.id === project)) project = OV.projects[0].id;
  const pending = dialog('Add a cartridge', `
    <label class="lbl" for="add-project">Project</label>
    <select id="add-project" name="project">${OV.projects.map(p => `<option value="${esc(p.id)}" title="${esc(p.path)}" ${p.id === project ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <div class="seg" role="tablist">
      <button type="button" class="seg-btn active" data-addtab="issues">Issues</button>
      <button type="button" class="seg-btn" data-addtab="new">New task</button>
      <button type="button" class="seg-btn" data-addtab="review">Review</button>
      <button type="button" class="seg-btn" data-addtab="research">Research</button>
      <button type="button" class="seg-btn" data-addtab="home">Main checkout</button>
    </div>
    <input type="hidden" name="tab" id="add-tab" value="issues">
    <div id="add-issues"><p class="dim">Loading issues…</p></div>
    <div id="add-new" hidden>
      <label class="lbl" for="new-text">Describe it in your own words</label>
      <textarea id="new-text" rows="3" placeholder="For example: the report page is slow when filtering by month; also want a CSV export button."></textarea>
      <div class="row"><button type="button" class="pbtn" data-draft="1">Draft the issue with Claude</button></div>
      <label class="lbl" for="new-title">Task name</label>
      <input type="text" id="new-title" name="title" placeholder="Short, for example: Speed up the report page">
      <label class="lbl" for="new-body">Details</label>
      <textarea id="new-body" name="body" rows="6" placeholder="Context, goal, acceptance criteria"></textarea>
      <label class="opt" id="new-create"><input type="checkbox" name="createIssue"><span>Also create this issue on GitHub</span></label>
    </div>
    <div id="add-review" hidden>
      <p class="dim">A read-only team reviews a branch and writes a report. It never touches the code of the team doing the work.</p>
      <div id="rv-targets"></div>
      <label class="lbl" for="rv-pr">Or a pull request number</label>
      <input type="text" id="rv-pr" name="pr" inputmode="numeric" placeholder="For example: 42">
    </div>
    <div id="add-research" hidden>
      <p class="dim">A team searches the web, checks each other's sources and writes a report with links. It does not touch code.</p>
      <label class="lbl" for="rs-q">Question</label>
      <textarea id="rs-q" name="question" rows="5" placeholder="For example: which library should we use to export PDFs from Node for reports with many tables? Compare speed, licence, stability."></textarea>
      <label class="lbl" for="rs-title">Short name (optional)</label>
      <input type="text" id="rs-title" name="rtitle" placeholder="For example: PDF library">
    </div>
    <div id="add-home" hidden>
      <p>Run a team directly in the project folder, on whatever branch it has checked out. No worktree, no new branch.</p>
      <div class="note warn">Use it for quick jobs. Two teams in the same folder would step on each other, so work cartridges get their own worktree.</div>
    </div>
    <div id="add-flow">
      <label class="lbl" for="add-flow-sel">Flow</label>
      <select id="add-flow-sel" name="flow"><option value="quick" selected>Quick: small task</option><option value="standard">Standard: medium task</option><option value="full">Full: big or risky</option></select>
      <p class="dim" id="flow-help">${FLOW_HELP.quick}</p><p class="dim">${CHECKS_NOTE}</p>
    </div>
    <div id="add-branch">
      <label class="lbl" for="add-br">Branch name</label>
      <input type="text" id="add-br" name="branch" placeholder="Automatic: issue/<number>-<title>">
      <label class="lbl" for="add-base">Start from</label>
      <select id="add-base" name="base"><option value="">Loading…</option></select>
      <label class="opt"><input type="checkbox" name="fetch" checked><span>Fetch the latest version of it first</span></label>
    </div>
    <div class="note">Adding a cartridge starts nothing. Its team runs only when you select it and press Start.</div>`,
  [CANCEL, { label: 'Add cartridge', value: 'add', cls: 'inv', validate: d => {
    if (d.tab === 'new') return d.title.trim() ? true : (toast('Write a task name', true), false);
    if (d.tab === 'review') return d.target || (d.pr || '').trim() ? true : (toast('Pick a cartridge or type a PR number', true), false);
    if (d.tab === 'research') return d.question.trim() ? true : (toast('Write the research question', true), false);
    if (d.tab === 'home') return true;
    return Object.keys(d).some(k => k.startsWith('iss_') && d[k]) ? true : (toast('Pick at least one issue', true), false);
  } }]);
  const load = async () => {
    const pid = $('#add-project').value;
    store.set('ctu-project', pid);
    const [iss, br] = await Promise.all([
      call('issues?project=' + encodeURIComponent(pid)).catch(e => ({ ok: false, error: e.message, issues: [] })),
      call('branches?project=' + encodeURIComponent(pid)).catch(() => ({ base: '', branches: [] })),
    ]);
    if (!$('#add-issues')) return;
    $('#add-issues').innerHTML = iss.ok ? (iss.issues.length ? `<ul class="pick-list">${iss.issues.map(i => `<li>
        <label class="pick ${i.cart ? 'used' : ''}"><input type="checkbox" name="iss_${i.number}" ${i.cart ? 'disabled' : ''}>
        <span><b>#${i.number}</b> ${esc(i.title)}${i.labels.length ? `<small>${i.labels.map(esc).join(', ')}</small>` : ''}</span>
        ${i.cart ? '<em>has a cartridge</em>' : ''}</label></li>`).join('')}</ul>` : '<p class="empty">No open issues in this repository.</p>')
      : `<div class="note">Could not load issues: ${esc(iss.error)}. You can still add a new task.</div>`;
    $('#new-create').hidden = !iss.ok;
    const opts = new Set([br.base, ...br.branches].filter(Boolean));
    $('#add-base').innerHTML = [...opts].map(b => `<option value="${esc(b)}" ${b === br.base ? 'selected' : ''}>${esc(b)}${b === br.base ? ' (default)' : ''}</option>`).join('');
    const targets = OV.cartridges.filter(c => c.project === pid && c.kind === 'team' && !c.home && c.branch);
    $('#rv-targets').innerHTML = targets.length ? `<label class="lbl" for="rv-target">Review a cartridge</label>
      <select id="rv-target" name="target"><option value="">Pick one…</option>${targets.map(c => `<option value="${esc(c.id)}">${esc(c.title)} (${esc(c.branch)})</option>`).join('')}</select>`
      : '<p class="empty">No cartridge in this project has its own branch yet.</p>';
  };
  $('#add-project').onchange = load;
  $('#add-flow-sel').onchange = () => { $('#flow-help').textContent = FLOW_HELP[$('#add-flow-sel').value]; };
  load();
  const res = await pending;
  if (res.action !== 'add') return;
  const d = res.data;
  let ep = 'cart-add', payload;
  const branchOpts = { branch: d.branch, base: d.base, fetch: !!d.fetch, flow: d.flow };
  if (d.tab === 'new') payload = { project: d.project, title: d.title, body: d.body, createIssue: !!d.createIssue, ...branchOpts };
  else if (d.tab === 'review') { ep = 'cart-add-review'; payload = (d.pr || '').trim() ? { project: d.project, pr: d.pr.trim() } : { project: d.project, target: d.target }; }
  else if (d.tab === 'research') { ep = 'cart-add-research'; payload = { project: d.project, question: d.question, title: d.rtitle }; }
  else if (d.tab === 'home') { ep = 'cart-add-home'; payload = { project: d.project, flow: d.flow }; }
  else payload = { project: d.project, issues: Object.keys(d).filter(k => k.startsWith('iss_') && d[k]).map(k => Number(k.slice(4))), ...branchOpts };
  toast('Adding…');
  const out = await act(() => call(ep, payload));
  if (out && out.made && out.made.length) {
    toast(out.made.length > 1 ? `Added ${out.made.length} cartridges. Press Start when you want one to run.` : 'Added. Press Start when you want it to run.');
    await switchCart(out.made[out.made.length - 1].id);
  }
}
async function draftIssue() {
  const text = $('#new-text').value.trim();
  if (!text) return toast('Describe the task first', true);
  const b = $('[data-draft]');
  b.disabled = true; b.textContent = 'Claude is writing…';
  try {
    const r = await call('draft-issue', { text });
    if (!r.ok) throw new Error(r.error);
    $('#new-title').value = r.title; $('#new-body').value = r.body;
  } catch (e) { toast(e.message, true); }
  finally { b.disabled = false; b.textContent = 'Draft again'; }
}
function addTab(tab) {
  $$('.seg-btn').forEach(x => x.classList.toggle('active', x.dataset.addtab === tab));
  $('#add-tab').value = tab;
  for (const t of ['issues', 'new', 'review', 'research', 'home']) $('#add-' + t).hidden = tab !== t;
  $('#add-branch').hidden = !['issues', 'new'].includes(tab);
  $('#add-flow').hidden = !['issues', 'new', 'home'].includes(tab);
}

// ---------- Projects and settings ----------
function projectsBody(sug) {
  const ps = OV.projects;
  return `<h3 class="lbl">Projects</h3>
    ${ps.length ? `<ul class="proj-list">${ps.map(p => `<li>
      <div><b>${esc(p.name)}</b><div class="dim">${esc(tilde(p.path))}</div></div>
      <div class="proj-inputs"><input type="text" data-test="${esc(p.id)}" value="${esc(p.testCommand)}" placeholder="Test command (optional), e.g. pnpm test" aria-label="Test command for ${esc(p.name)}">
        <input type="text" data-node="${esc(p.id)}" value="${esc(p.node || '')}" inputmode="decimal" placeholder="Node version via nvm (optional), e.g. 24" aria-label="Node version for ${esc(p.name)}"></div>
      <span class="proj-act"><button type="button" class="pbtn" data-act="saveproj" data-id="${esc(p.id)}">Save</button>
      <button type="button" class="pbtn ghost" data-act="rmproj" data-id="${esc(p.id)}">Remove</button></span></li>`).join('')}</ul>`
    : '<p class="empty">No projects yet.</p>'}
    <h3 class="lbl">Add a project</h3>
    <div class="composer"><input type="text" id="proj-path" placeholder="/full/path/to/a/git/repository" aria-label="Project path"><button type="button" class="pbtn inv" data-act="addproj">Add</button></div>
    ${sug.length ? `<p class="dim">Repositories found in your folders:</p><ul class="sug-list">${sug.map(s => `<li><button type="button" class="cmd" data-act="addpath" data-path="${esc(s)}">+ ${esc(tilde(s))}</button></li>`).join('')}</ul>` : ''}
    <h3 class="lbl">Teammate models</h3>
    <div class="two"><label>Planning and review<input type="text" name="strong" list="models" value="${esc(OV.models.strong)}"></label>
      <label>Building and tests<input type="text" name="fast" list="models" value="${esc(OV.models.fast)}"></label></div>
    <datalist id="models"><option value="fable"><option value="opus"><option value="sonnet"><option value="haiku"></datalist>
    <p class="dim">Prompts ask the lead to spawn teammates with these models. Cheaper models stretch your quota.</p>
    <h3 class="lbl">Folders to look for repositories</h3>
    <textarea name="scanRoots" rows="2" placeholder="One folder per line">${esc((OV.scanRoots || []).join('\n'))}</textarea>
    <p class="dim">Removing a project only takes it off this list. Its cartridges come back when you add it again.</p>`;
}
async function projectsDialog() {
  const sug = (await call('suggest').catch(() => ({ paths: [] }))).paths;
  const res = await dialog('Projects and settings', projectsBody(sug), [{ label: 'Close', value: 'cancel', cls: 'ghost' }, { label: 'Save settings', value: 'save', cls: 'inv' }]);
  if (res.action === 'save') {
    await act(() => call('settings', { models: { strong: res.data.strong.trim(), fast: res.data.fast.trim() }, scanRoots: res.data.scanRoots.split('\n').map(s => s.trim()).filter(Boolean) }), 'Settings saved');
  }
}
async function projectAction(b) {
  try {
    if (b.dataset.act === 'addproj' || b.dataset.act === 'addpath') {
      const p = b.dataset.path || $('#proj-path').value.trim();
      if (!p) return toast('Type the folder path', true);
      await call('project-add', { path: p });
      toast('Project added');
    } else if (b.dataset.act === 'saveproj') {
      const id = CSS.escape(b.dataset.id);
      await call('project-update', { project: b.dataset.id, testCommand: $(`[data-test="${id}"]`).value, node: $(`[data-node="${id}"]`).value });
      toast('Saved');
    } else if (b.dataset.act === 'rmproj') {
      if (!confirm('Take this project off the list? Nothing is deleted.')) return;
      await call('project-remove', { project: b.dataset.id });
      toast('Project removed from the list');
    }
    await refreshOverview();
    $('#dlg-body').innerHTML = projectsBody((await call('suggest').catch(() => ({ paths: [] }))).paths);
  } catch (e) { toast(e.message, true); }
}

// ---------- Start, Select, eject ----------
async function startDialog() {
  const st = S.start || {};
  const others = OV.cartridges.filter(x => x.running && x.id !== cur).length;
  const res = await dialog(`Power on: ${shortTitle({ ...S.cart, projectName: S.cart.projectName })}`, `
    ${others >= OV.softLimit ? `<div class="note warn">${plural(others, 'other cartridge')} running. Every cartridge is its own team, so quota use adds up. You can still start it.</div>` : ''}
    <div class="note">Runs <code>claude</code> in <code>${esc(cartWhere(S.cart))}</code> with agent teams on, using your subscription. Mode: <b>${MODE_LABEL[S.mode]}</b>.</div>
    <label class="lbl" for="o-pm">Permissions</label>
    <select id="o-pm" name="permissionMode">${OV.permissionModes.map(m => `<option value="${m}" ${(st.permissionMode || 'auto') === m ? 'selected' : ''}>${esc(PERMISSION_LABEL[m] || m)}</option>`).join('')}</select>
    <label class="lbl" for="o-tm">Teammates</label>
    <select id="o-tm" name="teammateMode">
      <option value="tmux" ${st.teammateMode !== 'in-process' ? 'selected' : ''}>One pane per teammate</option>
      <option value="in-process" ${st.teammateMode === 'in-process' ? 'selected' : ''}>All in the lead's pane</option>
    </select>
    <label class="lbl" for="o-model">Lead model</label>
    <select id="o-model" name="model">${['', 'fable', 'opus', 'sonnet', 'haiku'].map(m => `<option value="${m}" ${(st.model || '') === m ? 'selected' : ''}>${m || 'Default'}</option>`).join('')}</select>
    ${S.cart.hasHistory ? '<label class="opt"><input type="checkbox" name="resume"><span>Continue the last conversation of this cartridge (teammates do not come back)</span></label>' : ''}
    <label class="opt"><input type="checkbox" name="remoteControl" ${st.remoteControl ? 'checked' : ''}><span>Remote Control: talk to the lead from the Claude app on your phone</span></label>
    <input type="text" name="rcName" aria-label="Session name in the app" placeholder="Session name in the app (optional)" value="${esc(st.rcName || '')}">
    ${OV.platform === 'darwin' ? `<label class="opt"><input type="checkbox" name="caffeinate" ${st.caffeinate !== false ? 'checked' : ''}><span>Keep the Mac awake while it runs</span></label>` : ''}`,
  [CANCEL, { label: 'Eject…', value: 'eject' }, { label: 'Power on', value: 'go', cls: 'inv' }]);
  if (res.action === 'eject') return ejectDialog();
  if (res.action === 'go') {
    const { resume, ...opts } = res.data;
    await act(() => api('start', { opts, resume: !!resume }), 'Powered on');
    bootFx();
    if (isMobile()) go('term');
  }
}
async function stopDialog() {
  const res = await dialog(`Power off: ${shortTitle({ ...S.cart, projectName: S.cart.projectName })}?`,
    '<p>Teammates do not survive a power off; the lead can continue its conversation next time. Files in <code>plans/</code> stay. Other cartridges are not affected.</p>',
    [CANCEL, { label: 'Eject…', value: 'eject' }, { label: 'Restart', value: 'restart' }, { label: 'Power off now', value: 'kill' }, { label: 'Exit cleanly', value: 'stop', cls: 'inv' }]);
  if (res.action === 'eject') return ejectDialog();
  if (res.action === 'restart') { toast('Restarting…'); await act(() => api('restart', { resume: true }), 'Restarted'); bootFx(); }
  if (res.action === 'stop') { toast('Asking Claude to exit…'); act(() => api('stop', {}), 'Powered off'); }
  if (res.action === 'kill') act(() => api('stop', { hard: true }), 'Powered off');
}
async function ejectDialog() {
  const c = S.cart;
  const what = c.home ? `<p>Take <b>${esc(c.title)}</b> off the rack. The project folder stays exactly as it is.</p>`
    : c.kind === 'research' ? `<p>Take <b>${esc(c.title)}</b> off the rack.</p><div class="note">The report stays in <code>${esc(c.dir)}/plans/</code>.</div>`
      : `<p>Power off <b>${esc(c.title)}</b> and remove its worktree <code>${esc(c.dir)}</code>.</p>
      <div class="note">${c.kind === 'review' ? 'The review checkout is temporary; the reviewed branch is not touched.' : `Branch <code>${esc(c.branch)}</code> and its commits stay.`}
      The notebook (plans/) is archived under <code>.claude/team-ui/archive/</code> of the project. Uncommitted changes block the eject.</div>`;
  const res = await dialog('Eject this cartridge?', what, [CANCEL, { label: 'Eject', value: 'ok', cls: 'inv' }]);
  if (res.action !== 'ok') return;
  const r = await act(() => api('cart-remove', {}));
  if (r) { toast(r.archived ? 'Ejected. Notebook archived.' : 'Ejected.'); await switchCart(null); }
}
async function modeDialog() {
  if (!cur || !S) return toast('Pick a cartridge first', true);
  const next = S.mode === 'planning' ? 'code' : 'planning';
  const res = await dialog('Switch mode', `<p>Switch to <b>${MODE_LABEL[next]}</b>.</p>
    <div class="note">${next === 'planning' ? 'Agents may write only in <code>plans/</code>; every other file in the cartridge is locked.'
    : 'Agents may change code in this cartridge. They still cannot push, read .env files, run rm -rf, or write outside the cartridge.'}
    The lead and its teammates get the change right away; the console checks it on every file edit.</div>`,
  [CANCEL, { label: 'Switch', value: 'ok', cls: 'inv' }]);
  if (res.action === 'ok') act(() => api('mode', { mode: next }), `Now in ${MODE_LABEL[next]} mode`);
}
function bootFx() { const s = $('#screen'); s.classList.remove('boot'); void s.offsetWidth; s.classList.add('boot'); }

// ---------- Phone navigation ----------
function go(sec) {
  if (!cur) return;
  if (!isMobile()) { if (['team', 'inbox', 'plans', 'git'].includes(sec)) showSideTab(sec); return; }
  mobileSec = sec;
  $$('.screen-nav button').forEach(b => b.classList.toggle('active', b.dataset.go === sec));
  $$('.pane').forEach(p => p.classList.remove('show'));
  if (sec === 'flow') $('#sec-flow').classList.add('show');
  else if (sec === 'term') { $('#sec-term').classList.add('show'); refreshTerm(); }
  else { $('#sec-side').classList.add('show'); showSideTab(sec); }
}

// ---------- Events ----------
document.addEventListener('click', e => {
  const b = e.target.closest('button, li[data-file]');
  if (!b) return;
  if (b.dataset.cart !== undefined) return switchCart(b.dataset.cart);
  if (b.dataset.addtab) return addTab(b.dataset.addtab);
  if (b.dataset.draft) return draftIssue();
  const a = b.dataset.act;
  if (a === 'add') return addDialog();
  if (a === 'projects') return projectsDialog();
  if (a === 'trust') return act(() => api('trust', {}), 'Folder trusted');
  if (a === 'tpl') return templateDialog(b.dataset.name);
  if (a === 'flow') return flowDialog();
  if (['addproj', 'addpath', 'saveproj', 'rmproj'].includes(a)) return projectAction(b);
  if (b.dataset.ph) return phaseAction(b.dataset.ph, b.dataset.do);
  if (b.dataset.pane) { selPane = b.dataset.pane; renderPaneTabs(); $('#term').textContent = '…'; return refreshTerm(); }
  if (b.dataset.key) return sendKey(b.dataset.key);
  if (b.dataset.quick) return sendMsg(b.dataset.quick);
  if (b.dataset.go) return go(b.dataset.go);
  if (b.dataset.file) { planOpen = b.dataset.file; return loadPlans(); }
  if (b.id === 'plans-refresh') return loadPlans();
  if (b.id === 'git-refresh') return loadGit();
});
$('#btn-start').onclick = () => (!cur || !S ? toast('Pick a cartridge first', true) : S.running ? stopDialog() : startDialog());
$('#btn-select').onclick = modeDialog;
$('#st-mode').onclick = modeDialog;
$('#btn-add').onclick = addDialog;
$('#btn-reset').onclick = async () => {
  const r = await dialog('Restart the flow?', '<p>Every phase goes back to the start. Files in <code>plans/</code> are not deleted.</p>', [CANCEL, { label: 'Restart the flow', value: 'ok', cls: 'inv' }]);
  if (r.action === 'ok') act(() => api('reset', {}), 'Back to the first phase');
};
$('#request').addEventListener('input', () => { $('#request').dataset.dirty = '1'; $('#req-saved').textContent = 'not saved'; });
$('#btn-save-req').onclick = () => act(async () => {
  await api('request', { request: $('#request').value });
  delete $('#request').dataset.dirty;
  $('#req-saved').textContent = 'saved';
});
$('#composer').onsubmit = e => { e.preventDefault(); const t = $('#msg').value; $('#msg').value = ''; sendMsg(t); };
$('#msg').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#composer').requestSubmit(); } });
matchMedia('(max-width: 820px)').addEventListener('change', () => { if (isMobile()) go(mobileSec); else showSideTab(sideTab); });

// ---------- Loops ----------
(async function main() {
  bootFx();
  await refreshOverview();
  await refreshState();
  if (cur) { if (isMobile()) go('flow'); else showSideTab('team'); }
  setInterval(refreshOverview, 3000);
  setInterval(refreshState, 2500);
  setInterval(refreshTerm, 1200);
  setInterval(() => { if (sideTab === 'team' || sideTab === 'inbox') loadSide(false); }, 5000);
  refreshTerm();
})();

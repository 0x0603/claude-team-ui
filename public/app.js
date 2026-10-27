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
let termRaw = null; // the last terminal screen drawn, with its colour codes
let tab = store.get('ctu-tab', 'flow');  // flow | term | team | files
let filesSeg = 'notes';
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
// Appearance: auto follows the device; light and dark are remembered per browser
function applyTheme(v) {
  const r = document.documentElement;
  if (v === 'light' || v === 'dark') r.dataset.theme = v; else delete r.dataset.theme;
  if (v) store.set('ctu-theme', v === 'auto' ? null : v);
  requestAnimationFrame(() => { const m = $('meta[name="theme-color"]'); if (m) m.content = getComputedStyle(r).getPropertyValue('--bg').trim() || '#f5f5f7'; });
}
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
      const cell = table ? 'td' : 'th';
      if (!table) { out += '<table>'; table = true; }
      out += '<tr>' + l.trim().slice(1, -1).split('|').map(c => `<${cell}>${inline(c.trim())}</${cell}>`).join('') + '</tr>';
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
// The sheet slides down before it closes; opening another sheet meanwhile reuses the open one
function closeDlg() {
  const d = $('#dlg');
  d.onclose = null;
  d.classList.add('closing');
  clearTimeout(closeDlg.t);
  closeDlg.t = setTimeout(() => { d.classList.remove('closing'); if (d.open) d.close(); }, 200);
}
function openDlg() {
  const d = $('#dlg');
  clearTimeout(closeDlg.t);
  d.classList.remove('closing');
  if (!d.open) d.showModal();
}
function dialog(title, bodyHTML, actions) {
  return new Promise(resolve => {
    const d = $('#dlg');
    d.classList.remove('sheet');
    $('#dlg-title').textContent = title;
    $('#dlg-body').innerHTML = bodyHTML;
    const box = $('#dlg-actions');
    box.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.value === 'cancel' ? 'cancel' : (a.cls || '').replace('inv', 'primary').replace('ghost', 'plain'));
      b.textContent = a.label;
      b.value = a.value;
      b.type = 'button';
      b.onclick = () => {
        if (a.value === 'cancel') { closeDlg(); resolve({ action: 'cancel', data: {} }); return; }
        const data = Object.fromEntries($$('#dlg-body [name]').map(el => [el.name, el.type === 'checkbox' ? el.checked : el.value]));
        if (a.validate && !a.validate(data)) return;
        closeDlg();
        resolve({ action: a.value, data });
      };
      box.appendChild(b);
    }
    // A button in the body with data-action closes the sheet with that action, like a footer button
    $$('#dlg-body [data-action]').forEach(b => { b.onclick = () => { closeDlg(); resolve({ action: b.dataset.action, data: {} }); }; });
    d.onclose = () => resolve({ action: 'cancel', data: {} });
    openDlg();
  });
}
const CANCEL = { label: 'Cancel', value: 'cancel', cls: '' };
// iOS-style action sheet: a list of choices; resolves with the chosen value, or null
function sheet(title, items) {
  return new Promise(resolve => {
    const d = $('#dlg');
    d.classList.add('sheet');
    $('#dlg-title').textContent = title;
    $('#dlg-body').innerHTML = `<ul class="sheet-list">${items.map((it, i) => `<li><button type="button" data-sheet="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</button></li>`).join('')}</ul>`;
    $('#dlg-actions').innerHTML = '<button type="button" class="btn cancel" data-sheet-cancel="1">Cancel</button>';
    $$('#dlg-body [data-sheet]').forEach(b => { b.onclick = () => { closeDlg(); resolve(items[Number(b.dataset.sheet)].value); }; });
    $('[data-sheet-cancel]').onclick = () => { closeDlg(); resolve(null); };
    d.onclose = () => resolve(null);
    openDlg();
  });
}
const kindTag = c => {
  const k = c.home ? 'Main checkout' : c.kind === 'review' ? 'Review' : c.kind === 'research' ? 'Research' : '';
  return k ? `<span class="tag">${k}</span>` : '';
};
const FLOW_NAME = { quick: 'Quick', standard: 'Standard', full: 'Full' };
const flowTag = c => (c.kind === 'team' && c.flow ? `<span class="tag">${FLOW_NAME[c.flow]}</span>` : '');
const projTag = c => `<span class="tag proj">${esc(c.projectName)}</span>`;
const FLOW_HELP = {
  quick: 'Small task. The lead writes a one-page plan, one developer builds, one reviewer checks all five areas.',
  standard: 'Medium task. A planner and a critic, up to two developers, simplify, two reviewers.',
  full: 'Big or risky work. Spec, planning with five agents, task files, simplify, five reviewers, retro.',
};
const CHECKS_NOTE = 'Every flow builds and reviews logic, security, tests, docs and skills.';
const shortTitle = c => (c.home ? `${c.projectName} (main)` : c.title.replace(/^(Review |Research: )/, ''));


// ---------- Overview and home ----------
async function refreshOverview() {
  try { OV = await call('overview'); } catch { return; }
  if (cur && !OV.cartridges.some(c => c.id === cur)) setCart(null);
  renderNav();
  if (!cur) renderHome();
}
function usageText() {
  const u = OV && OV.usage;
  if (!u) return '';
  return [['5h', u.fiveHour], ['7d', u.sevenDay]].filter(([, x]) => x && x.pct != null).map(([l, x]) => `${l} ${Math.round(x.pct)}%`).join(', ');
}
// Plan usage as two rings: the 5-hour window outside, the week inside. They draw in once per page load.
let ringsDrawn = false;
const resetTime = t => (t - Date.now() > 20 * 3600000 ? new Date(t).toLocaleDateString([], { weekday: 'short' }) + ' ' : '') + clock(t);
function metersHTML() {
  const u = OV && OV.usage;
  if (!u || (!u.fiveHour && !u.sevenDay)) return '';
  const stale = Date.now() - (u.at || 0) > 30 * 60000;
  const pct = x => (x && x.pct != null ? Math.min(100, Math.max(0, x.pct)) : null);
  const ring = (cls, r, x) => (pct(x) == null ? '' : `<circle class="track" r="${r}" cx="40" cy="40"/>
    <circle class="val ${cls} ${pct(x) >= 80 ? 'hot' : ''}" r="${r}" cx="40" cy="40" pathLength="100" style="stroke-dashoffset:${100 - Math.max(1, pct(x))}"/>`);
  const line = (cls, label, x) => (pct(x) == null ? '' : `<div class="legend-row"><i class="key ${cls} ${pct(x) >= 80 ? 'hot' : ''}"></i>
    <b>${Math.round(pct(x))}%</b> ${label}${x.resetsAt ? `<small>resets ${resetTime(x.resetsAt)}</small>` : ''}</div>`);
  const draw = ringsDrawn ? '' : 'draw';
  ringsDrawn = true;
  return `<div class="usage ${stale ? 'stale' : ''}" title="Plan usage reported by Claude Code${stale ? ', last seen ' + ago(u.at) + ' ago' : ''}">
    <svg class="rings ${draw}" viewBox="0 0 80 80" aria-hidden="true">${ring('outer', 34, u.fiveHour)}${ring('inner', 23, u.sevenDay)}</svg>
    <div class="legend">${line('outer', '5-hour window', u.fiveHour)}${line('inner', 'this week', u.sevenDay)}</div></div>`;
}
const summary = () => (OV && cur ? OV.cartridges.find(c => c.id === cur) : null);
function renderNav() {
  const inCart = !!cur;
  $('#btn-back').hidden = !inCart;
  $('#btn-settings').hidden = inCart;
  $('#btn-add').hidden = inCart || !(OV && OV.projects.length);
  $('#btn-more').hidden = !inCart || !S;
  $('#home').hidden = inCart;
  $('#cart').hidden = !inCart;
  $('#tabbar').hidden = !inCart;
  const power = $('#btn-power');
  $('#app').classList.toggle('in-cart', inCart);
  if (!inCart) {
    $('#nav-title').textContent = '';
    power.hidden = true;
    $('#attention').hidden = true;
    document.title = 'Claude Team';
    return;
  }
  const c = (S && S.cart) || summary();
  $('#nav-title').textContent = c ? c.projectName : '';
  $('#nav-big').textContent = c ? shortTitle(c) : '';
  if (!S) { power.hidden = true; return; }
  power.hidden = false;
  power.textContent = S.running ? 'Stop' : 'Start';
  power.classList.toggle('stop', S.running);
  document.title = `${S.cart.title} · Claude Team`;
}
const rank = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
function stateLine(c) {
  if (c.attention) return `${c.attnLead ? 'The lead' : 'A teammate'} ${{ permission: 'asks for permission', trust: 'asks to trust the folder', exit: 'asks how to exit' }[c.attention] || 'is waiting for you'}`;
  if (c.running) return c.alive ? c.phase : 'claude exited';
  return c.phase === 'Done' ? 'All steps done' : `Next: ${c.phase}`;
}
function ticketHTML(c) {
  const cls = c.attention ? 'attn' : c.running ? 'run' : 'off';
  const meta = [c.projectName, c.kind === 'team' && c.flow ? `${FLOW_NAME[c.flow]} flow` : c.home ? 'Main checkout' : c.kind === 'review' ? 'Review' : 'Research',
    c.costUSD != null ? `${money(c.costUSD)} used` : '', c.prUrl ? 'PR open' : ''].filter(Boolean);
  let answer = '';
  if (c.attention === 'permission' || c.attention === 'question') {
    answer = `<div class="t-answer"><button class="btn primary" data-answer="enter" data-cid="${esc(c.id)}" data-pane="${esc(c.attnPane || '')}">${c.attention === 'permission' ? 'Allow' : 'Enter'}</button>
      <button class="btn" data-answer="esc" data-cid="${esc(c.id)}" data-pane="${esc(c.attnPane || '')}">${c.attention === 'permission' ? 'Deny' : 'Esc'}</button></div>`;
  } else if (c.attention === 'trust') {
    answer = `<div class="t-answer"><button class="btn primary" data-trust="${esc(c.id)}">Trust this folder</button></div>`;
  }
  const crew = c.running && c.crew && c.crew.length ? `<span class="crew">${c.crew.map(m => `<i class="orb ${m.attention ? 'attn' : m.busy ? 'busy' : ''}" title="${esc(m.name)}${m.attention ? ', waiting for you' : m.busy ? ', working' : ''}">${esc((m.name || '?')[0])}</i>`).join('')}</span>` : '';
  const said = c.running && !c.attention && c.said ? `<span class="t-said">${esc(c.said)}</span>` : '';
  const prog = c.steps && c.steps.total ? `<span class="t-prog" style="--v:${Math.round(100 * c.steps.done / c.steps.total)}%" title="${c.steps.done} of ${c.steps.total} steps done"></span>` : '';
  return `<li class="ticket ${cls}"><button class="ticket-open" data-cart="${esc(c.id)}">
    <span class="t-title">${esc(shortTitle(c))}</span><span class="t-state">${esc(stateLine(c))}</span>${said}
    <span class="t-foot">${crew}<span class="t-meta">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</span></span></button>${answer}${prog}</li>`;
}
let lastHome = '';
function renderHome() {
  const box = $('#home');
  if (!OV.projects.length) {
    lastHome = '';
    box.innerHTML = `<div class="empty-cta"><h2>Add your first project</h2>
      <p>Pick a git repository for the teams to work in. Each cartridge gets its own worktree and branch, so your checkout stays untouched.</p>
      <button class="btn primary" data-act="projects">Add a project</button></div>`;
    return;
  }
  const carts = [...OV.cartridges].sort(rank);
  const needs = carts.filter(c => c.attention), working = carts.filter(c => !c.attention && c.running), idle = carts.filter(c => !c.attention && !c.running);
  const head = needs.length ? `${needs.length} need${needs.length === 1 ? 's' : ''} you` : working.length ? `${working.length} working` : 'All quiet';
  const sub = needs.length ? (working.length ? `${working.length} more working.` : 'Answer from here, or open the cartridge.')
    : working.length ? 'Nothing needs you right now.' : carts.length ? 'No team is running.' : 'Add a cartridge to give a team some work.';
  const html = `<section class="hero"><h1>${head}${needs.length ? '<span class="pulse" aria-hidden="true"></span>' : ''}</h1><p>${sub}</p>${metersHTML()}</section>
    ${needs.length ? `<ul class="tickets">${needs.map(ticketHTML).join('')}</ul>` : ''}
    ${working.length ? `${needs.length ? '<h3 class="section-title">Working</h3>' : ''}<ul class="tickets">${working.map(ticketHTML).join('')}</ul>` : ''}
    ${idle.length ? `<h3 class="section-title">Not running</h3><ul class="tickets">${idle.map(ticketHTML).join('')}</ul>` : ''}
    ${carts.length ? '' : '<div class="empty-cta"><button class="btn primary" data-act="add">Add a cartridge</button></div>'}
    <p class="foot">${plural(OV.projects.length, 'project')}, version ${esc(OV.version)}</p>`;
  $('#nav-big').textContent = head;
  if (html === lastHome) return;
  // The one page-load moment: the headline and tickets rise in, once
  if (!lastHome) { box.classList.add('intro'); setTimeout(() => box.classList.remove('intro'), 1400); }
  box.innerHTML = html; lastHome = html;
  $$('#home .hero, #home .tickets > li, #home .section-title').forEach((el, i) => el.style.setProperty('--i', i));
  // Pulses keep their phase when the list re-renders, instead of restarting
  for (const el of box.querySelectorAll('.orb.busy, .orb.attn, .pulse')) el.style.animationDelay = `-${Date.now() % 2000}ms`;
}

// ---------- Selected cartridge ----------
async function refreshState() {
  if (!cur) { S = null; return; }
  try { S = await api('state'); }
  catch (e) { if (/No such cartridge|Invalid cartridge/.test(e.message)) setCart(null); return; }
  renderNav(); renderHead(); renderNext(); renderPhases(); renderPaneTabs(); renderAttention();
}
async function refreshAll() { await refreshOverview(); await refreshState(); }

const PILOT = {
  'hands-off': { name: 'Hands-off', sub: 'Plan checkpoints pass by themselves and reviews that need work go back to Build. It stops only before the merge.' },
  checkpoints: { name: 'Stops at checkpoints', sub: 'Steps run one after another; you approve the spec, the plan and the merge.' },
  manual: { name: 'Manual', sub: 'You run every step yourself.' },
};
function renderHead() {
  const c = S.cart;
  const facts = [
    `<span class="lock ${S.mode === 'code' ? 'code' : ''}">${S.mode === 'code' ? 'Can change code' : 'Plan only'}</span>`,
    c.kind === 'team' ? `<span>${FLOW_NAME[c.flow]} flow</span>` : '',
    `<button class="pilot ${S.pilot}" data-act="pilot">${PILOT[S.pilot].name}</button>`,
    c.branch ? `<code>${esc(c.branch)}</code>` : c.target ? `<span>Reviewing <code>${esc(c.target)}</code></span>` : c.home ? '<span>Main checkout</span>' : '',
    safeUrl(c.url) ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${c.issue ? 'Issue #' + c.issue : c.pr ? 'PR #' + c.pr : 'Link'}</a>` : '',
    safeUrl(c.prUrl) ? `<a href="${esc(c.prUrl)}" target="_blank" rel="noopener">Pull request</a>` : '',
  ].filter(Boolean);
  $('#cart-head').innerHTML = `<h1>${esc(c.title.replace(/^(Review |Research: )/, ''))}</h1><div class="facts">${facts.join('')}</div>`;
}
// What can be done at a step: the first is the main action, the rest go under "More"
function phaseOptions(p) {
  const out = [];
  if (p.kind === 'agent') {
    if (p.status === 'ready') out.push({ label: 'Run', what: 'run' }, { label: 'Edit the prompt, then run', what: 'edit' });
    if (p.status === 'running') out.push({ label: 'Mark done', what: 'done' }, { label: 'Send the prompt again', what: 'run' });
    if (p.rejectTo && p.status === 'running') out.push({ label: 'Bugs found, back to Build', what: 'back' });
  } else if (p.status === 'ready') out.push({ label: 'Review', what: 'review' });
  if (p.pr && S.cart.branch && !S.cart.home && p.status === 'ready' && !safeUrl(S.cart.prUrl)) out.push({ label: 'Open a pull request', what: 'pr' });
  return out;
}
function renderNext() {
  const idx = S.phases.findIndex(x => x.status === 'running');
  const p = S.phases[idx] || S.phases.find(x => x.status === 'ready');
  const lastDone = [...S.phases].reverse().find(x => x.status === 'done');
  const step = p ? S.phases.indexOf(p) + 1 : S.phases.length;
  const track = `<div class="track">${S.phases.map(x => `<i class="${x.status} kind-${x.kind}"></i>`).join('')}</div>
    <div class="track-label">Step ${step} of ${S.phases.length}</div>`;
  if (!p) {
    $('#next-step').innerHTML = `${track}<div class="next"><h2>All steps done</h2><p>Eject the cartridge when the branch is merged.</p>
      <div class="actions">${safeUrl(S.cart.prUrl) ? `<a class="btn primary" href="${esc(S.cart.prUrl)}" target="_blank" rel="noopener">View the pull request</a>` : ''}
      ${lastDone ? '<button class="btn plain" data-act="step-more">More</button>' : ''}</div></div>`;
    return;
  }
  const opts = phaseOptions(p);
  const quiet = p.status === 'running' && S.pilot !== 'manual' && S.running; // the team ends the step itself
  const main = quiet ? null : opts[0];
  const off = p.kind === 'agent' && !S.running;
  const more = opts.length - (main ? 1 : 0) + (lastDone ? 1 : 0);
  const kicker = p.status === 'running' ? 'Working on it' : p.kind === 'gate' ? 'Your decision' : 'Up next';
  const auto = S.pilot !== 'manual';
  const why = off ? (S.pilot === 'hands-off' ? 'Start the team. It works through the steps by itself and stops only before the merge.' : 'Start the team and this step runs as soon as Claude is ready.')
    : p.status === 'running' ? (S.pilot === 'hands-off' ? 'The team carries on by itself. You are asked only before the merge, or when an agent needs permission.'
      : auto ? 'When the lead reports done, the next step starts by itself until a checkpoint.' : 'When the lead reports done, this step closes.')
      : p.kind === 'agent' && auto ? 'Starts by itself as soon as the lead is free.' : p.desc || (p.file ? 'Read ' + p.file : '');
  $('#next-step').innerHTML = `${track}<div class="next">
    <div class="kicker ${p.kind === 'gate' ? 'wait' : ''}">${kicker}</div>
    <h2>${esc(p.title)}</h2><p>${esc(why)}</p>
    <div class="actions">${off ? `<button class="btn primary" data-act="start-run">${auto ? 'Start' : 'Start and run'}</button>`
      : main ? `<button class="btn ${p.kind === 'agent' && p.status === 'ready' && auto ? '' : 'primary'}" data-ph="${esc(p.id)}" data-do="${main.what}">${p.kind === 'agent' && p.status === 'ready' && auto ? 'Run now' : main.label}</button>` : ''}
      ${more ? '<button class="btn plain" data-act="step-more">More options</button>' : ''}
      ${safeUrl(S.cart.prUrl) && p.pr ? `<a class="btn plain" href="${esc(S.cart.prUrl)}" target="_blank" rel="noopener">View the pull request</a>` : ''}</div></div>`;
}
async function stepMore() {
  const p = S.phases.find(x => x.status === 'running') || S.phases.find(x => x.status === 'ready');
  const lastDone = [...S.phases].reverse().find(x => x.status === 'done');
  const quiet = p && p.status === 'running' && S.pilot !== 'manual' && S.running;
  const items = (p ? phaseOptions(p).slice(quiet ? 0 : 1) : []).map(o => ({ label: o.label, value: `${p.id}|${o.what}` }));
  if (lastDone && lastDone.rejectTo) items.push({ label: 'Bugs found, back to Build', sub: `After ${lastDone.title}`, value: `${lastDone.id}|back` });
  if (lastDone) items.push({ label: `Redo ${lastDone.title}`, sub: 'The steps after it lock again', value: `${lastDone.id}|reopen` });
  const v = await sheet(p ? p.title : 'Steps', items);
  if (v) { const [id, what] = v.split('|'); phaseAction(id, what); }
}
function renderPhases() {
  $('#phases').innerHTML = S.phases.map(p => `<li class="kind-${p.kind} ${p.status}"><span class="st-name">${esc(p.title)}</span>
    <span class="st-state">${p.status === 'running' ? 'working' : p.status === 'ready' ? 'next' : ''}</span></li>`).join('');
}
function renderPaneTabs() {
  const box = $('#pane-tabs');
  if (!S.running) { box.innerHTML = ''; selPane = null; return; }
  if (!S.panes.find(p => p.id === selPane)) selPane = S.panes[0] && S.panes[0].id;
  box.innerHTML = S.panes.map(p => `<button class="agent ${p.id === selPane ? 'active' : ''} ${p.attention ? 'attn' : ''}"
    data-pane="${esc(p.id)}" title="${esc([p.title, p.model].filter(Boolean).join(', '))}">${esc(p.label)}</button>`).join('');
}
// One card above the tabs, so a waiting agent can be answered from any tab
const ATTN_TEXT = {
  permission: [who => `${who} asks for permission.`, [['Allow', 'enter', 'primary'], ['Deny', 'esc']]],
  question: [who => `${who} is waiting for your answer.`, [['Enter', 'enter', 'primary'], ['Esc', 'esc']]],
  trust: [() => 'Claude asks whether you trust this folder. For a PR from a fork, check .claude/ and .mcp.json first.', [['Trust this folder', 'trust', 'primary'], ['Exit', 'enter']]],
  exit: [() => 'Claude asks how to exit while teammates are running.', [['Exit and stop tasks', 'enter', 'primary'], ['Stay', 'esc']]],
};
function renderAttention() {
  const p = S && S.running ? S.panes.find(x => x.attention) : null;
  $('#nav-attn').hidden = !p;
  const el = $('#attention');
  const a = p && ATTN_TEXT[p.attention];
  el.hidden = !a;
  if (!a) return;
  el.innerHTML = `<span>${esc(a[0](p.isLead ? 'The lead' : p.label))}</span><span class="acts">${a[1].map(([t, k, cls]) => (k === 'trust'
    ? `<button class="btn ${cls || ''}" data-act="trust">${t}</button>`
    : `<button class="btn ${cls || ''}" data-key="${k}" data-pane="${esc(p.id)}">${t}</button>`)).join('')}</span>`;
}
function setCart(id) {
  cur = id || null;
  store.set('ctu-cart', cur);
  S = null; selPane = null; planOpen = null;
  $('#term').textContent = '…'; termRaw = null;
  $('#attention').hidden = true;
}
// Plays a short entrance on an element; the class goes once it ends
function enter(el, cls) {
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.classList.remove('push', 'pop', 'fade');
  void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}
async function switchCart(id) {
  if ((id || null) === cur) return;
  setCart(id);
  renderNav();
  syncScroll();
  enter(cur ? $('#cart') : $('#home'), cur ? 'push' : 'pop');
  if (!cur) { renderHome(); return; }
  $('#cart-head').innerHTML = ''; $('#next-step').innerHTML = ''; $('#phases').innerHTML = '';
  await refreshState();
  const sm = OV && OV.cartridges.find(c => c.id === cur);
  setTab(sm && sm.attention ? 'term' : tab);
}
const TABS = ['flow', 'term', 'team', 'files'];
function setTab(t) {
  const was = tab;
  tab = TABS.includes(t) ? t : 'flow';
  store.set('ctu-tab', tab);
  $$('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#tabbar').style.setProperty('--ti', TABS.indexOf(tab));
  for (const x of TABS) $('#v-' + x).hidden = x !== tab;
  if (was !== tab) enter($('#v-' + tab), 'fade');
  syncScroll();
  if (tab === 'term') refreshTerm(true);
  else loadTab(true);
}

// ---------- Cartridge menu (⋯) ----------
async function pilotSheet() {
  const v = await sheet('Autopilot', Object.entries(PILOT).map(([k, x]) => ({ label: (k === S.pilot ? '✓ ' : '') + x.name, sub: x.sub, value: k })));
  if (v && v !== S.pilot) act(() => api('autopilot', { mode: v }), `Autopilot: ${PILOT[v].name}`);
}
async function cartMenu() {
  if (!S) return;
  const c = S.cart;
  const v = await sheet(c.title, [
    ...(S.running ? [] : [{ label: 'Start with options…', sub: 'Permissions, model, continue the last conversation', value: 'start-opts' }]),
    { label: `Autopilot: ${PILOT[S.pilot].name}`, sub: PILOT[S.pilot].sub, value: 'autopilot' },
    { label: 'Edit the task', value: 'task' },
    { label: S.mode === 'code' ? 'Back to plan only' : 'Allow code changes', sub: S.mode === 'code' ? 'Agents may write only in plans/' : 'Agents may change code in this cartridge', value: 'mode' },
    ...(c.kind === 'team' ? [{ label: 'Change the flow', sub: `Now: ${FLOW_NAME[c.flow]}`, value: 'flow' }] : []),
    { label: 'Edit team rules', sub: 'For this project', value: 'rules' },
    { label: 'Edit quality checks', sub: 'Logic, security, tests, docs, skills', value: 'checks' },
    { label: 'Restart the flow', sub: 'Every step goes back to the start', value: 'reset' },
    { label: 'Eject', sub: c.home ? 'Take it off the list' : 'Remove the worktree, keep the branch', value: 'eject', danger: true },
  ]);
  if (v === 'start-opts') startDialog();
  if (v === 'autopilot') pilotSheet();
  if (v === 'task') taskDialog();
  if (v === 'mode') modeDialog();
  if (v === 'flow') flowDialog();
  if (v === 'rules') templateDialog('_rules.md');
  if (v === 'checks') templateDialog('_checks.md');
  if (v === 'eject') ejectDialog();
  if (v === 'reset') {
    const r = await dialog('Restart the flow?', '<p>Every step goes back to the start. Files in <code>plans/</code> are not deleted.</p>', [CANCEL, { label: 'Restart the flow', value: 'ok', cls: 'inv' }]);
    if (r.action === 'ok') act(() => api('reset', {}), 'Back to the first step');
  }
}
async function taskDialog() {
  const res = await dialog('Task', `<textarea name="request" rows="10" placeholder="What should this team do?">${esc(S.request || '')}</textarea>
    <p class="dim">The steps' prompts include this text.</p>`, [CANCEL, { label: 'Save', value: 'ok', cls: 'inv' }]);
  if (res.action === 'ok') act(() => api('request', { request: res.data.request }), 'Task saved');
}
async function keysSheet() {
  const v = await sheet('Keys and commands', [
    { label: '← Left', value: 'k:left' }, { label: '→ Right', value: 'k:right' }, { label: 'Tab', value: 'k:tab' },
    { label: 'Shift+Tab', sub: 'Cycle the permission mode', value: 'k:shift-tab' }, { label: 'Ctrl+C', sub: 'Interrupt', value: 'k:ctrl-c' },
    { label: 'Ctrl+T', sub: 'Task list', value: 'k:ctrl-t' }, { label: 'Ctrl+O', sub: 'Expand', value: 'k:ctrl-o' },
    { label: 'x', sub: 'Stop the selected agent', value: 'k:x' },
    { label: 'Ask for status', value: 'q:Summarise each teammate\'s status in 5 lines: who is doing what, and who is stuck.' },
    { label: 'Tell the lead to wait', value: 'q:Wait for your teammates to complete their tasks before proceeding.' },
    { label: '/usage', value: 'q:/usage' }, { label: '/context', value: 'q:/context' },
    { label: 'Shut the team down', value: 'q:Ask all teammates to shut down gracefully.', danger: true },
  ]);
  if (!v) return;
  if (v.startsWith('k:')) sendKey(v.slice(2));
  else sendMsg(v.slice(2));
}

// ---------- Terminal ----------
let termBusy = false;
// Terminal colours: tmux's SGR codes (capture-pane -e) as spans. 16, 256 and truecolor; bold, dim, italic, underline, inverse.
const ANSI16 = ['#2e3138', '#ff6b6b', '#5fd38d', '#f5c451', '#6aa6ff', '#c792ea', '#4fd6d6', '#d4d7dd',
  '#6b7280', '#ff8f8f', '#86efac', '#fde68a', '#93c5fd', '#e0b0ff', '#99f6e4', '#ffffff'];
function xterm256(n) {
  if (n < 16) return ANSI16[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const c = x => (x ? x * 40 + 55 : 0);
  n -= 16;
  return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
}
function sgr(st, params) {
  const a = params.split(/[;:]/).map(Number);
  for (let i = 0; i < a.length; i++) {
    const c = a[i] || 0;
    if (c === 0) { for (const k in st) delete st[k]; }
    else if (c === 1) st.bold = true; else if (c === 2) st.dim = true; else if (c === 3) st.italic = true;
    else if (c === 4) st.under = true; else if (c === 7) st.inv = true; else if (c === 9) st.strike = true;
    else if (c === 21 || c === 22) st.bold = st.dim = false; else if (c === 23) st.italic = false;
    else if (c === 24) st.under = false; else if (c === 27) st.inv = false; else if (c === 29) st.strike = false;
    else if (c >= 30 && c <= 37) st.fg = ANSI16[c - 30]; else if (c >= 90 && c <= 97) st.fg = ANSI16[c - 82];
    else if (c >= 40 && c <= 47) st.bg = ANSI16[c - 40]; else if (c >= 100 && c <= 107) st.bg = ANSI16[c - 92];
    else if (c === 39) st.fg = null; else if (c === 49) st.bg = null;
    else if (c === 38 || c === 48) {
      const key = c === 38 ? 'fg' : 'bg';
      if (a[i + 1] === 5) { st[key] = xterm256(a[i + 2] || 0); i += 2; }
      else if (a[i + 1] === 2) { st[key] = `rgb(${a[i + 2] || 0},${a[i + 3] || 0},${a[i + 4] || 0})`; i += 4; }
    }
  }
}
function ansiHTML(raw) {
  const st = {};
  let out = '';
  for (const part of String(raw).split(/(\x1b\[[0-9;:]*m)/)) {
    if (part.startsWith('\x1b[')) { sgr(st, part.slice(2, -1)); continue; }
    if (!part) continue;
    const text = esc(part.replace(/\x1b[^a-zA-Z]*[a-zA-Z]?/g, ''));
    let fg = st.fg, bg = st.bg;
    if (st.inv) [fg, bg] = [bg || 'var(--term-solid)', fg || 'var(--term-ink)'];
    const css = (fg ? `color:${fg};` : '') + (bg ? `background:${bg};` : '') + (st.bold ? 'font-weight:600;' : '') + (st.dim ? 'opacity:.6;' : '')
      + (st.italic ? 'font-style:italic;' : '') + (st.under || st.strike ? `text-decoration:${st.under ? 'underline ' : ''}${st.strike ? 'line-through' : ''};` : '');
    out += css ? `<span style="${css}">${text}</span>` : text;
  }
  return out;
}
// Narrow screens wrap lines, so full-width rules and box edges would turn into blocks of dashes
const shortRules = raw => String(raw).split('\n').map(line =>
  /^\s*[╭┌╰└]?[─━═╌]{13,}[╮┐╯┘]?\s*$/.test(line.replace(/\x1b\[[0-9;:]*m/g, '')) ? line.replace(/[─━═╌]{13,}/, m => m.slice(0, 12)) : line).join('\n');
// "Jump to the newest line" shows once the terminal is scrolled up
function syncTermDown() { const t = $('#term'); $('#term-down').hidden = t.scrollHeight - t.scrollTop - t.clientHeight < 80; }
async function refreshTerm(force) {
  if (!cur || !S || tab !== 'term') return;
  if (!S.running) { termRaw = null; $('#term').textContent = 'This cartridge is off. Tap Start.'; return; }
  if (termBusy) return;
  termBusy = true;
  try {
    const r = await api('pane?id=' + encodeURIComponent(selPane || '') + '&lines=500&ansi=1');
    const t = $('#term');
    const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 40;
    const src = r.ansi ?? r.text ?? '';
    const raw = innerWidth < 700 ? shortRules(src) : src;
    const changed = raw !== termRaw;
    if (changed) { termRaw = raw; t.innerHTML = raw ? ansiHTML(raw) : '(empty)'; }
    // A hidden terminal loses its scroll position, so showing it again always goes to the newest line
    if (force || (changed && atBottom)) t.scrollTop = t.scrollHeight;
    syncTermDown();
  } catch {} finally { termBusy = false; }
}
async function sendMsg(text) {
  if (!text.trim()) return;
  if (!cur) return;
  await act(() => api('send', { pane: selPane, text }), 'Sent');
  setTimeout(() => refreshTerm(true), 500);
}
async function sendKey(key, pane) {
  if (!cur || !S || !S.running) return toast('This cartridge is off. Tap Start.', true);
  try { await api('key', { pane: pane || selPane, key }); refreshTerm(); refreshState(); refreshOverview(); } catch (e) { toast(e.message, true); }
}

// ---------- Team and files ----------
let tabBusy = false;
async function loadTab(force) {
  if (!cur || tabBusy) return;
  tabBusy = true;
  try {
    if (tab === 'team') await loadTeam();
    else if (tab === 'files' && force) await (filesSeg === 'git' ? loadGit() : loadPlans());
  } finally { tabBusy = false; }
}
async function loadTeam() {
  const t = await api('team').catch(() => null);
  if (!t) return;
  const u = t.usage;
  const models = Object.entries(u.models || {});
  const team = t.team;
  const members = team ? `<ul class="members">${team.members.map(m => `<li title="${esc(m.task)}"><span class="lamp ${m.active ? '' : 'off'}"></span>
      <span class="m-name">${esc(m.name)}</span><small>${esc(m.type === 'team-lead' ? 'lead' : m.model || m.type)}</small></li>`).join('')}</ul>`
    : `<p class="empty">${S && S.running ? 'No teammates yet. They join when the lead runs a step.' : 'The team appears here while the cartridge runs.'}</p>`;
  const tasks = t.tasks.length ? `<h3 class="section-title">Tasks</h3><ul class="members">${t.tasks.map(x => `<li><span class="m-name">${esc(x.subject)}</span>
      <small>${esc({ in_progress: 'in progress', pending: 'waiting', completed: 'done' }[x.status] || x.status)}${x.owner ? ', ' + esc(x.owner) : ''}</small></li>`).join('')}</ul>` : '';
  const plan = usageText();
  $('#tab-team').innerHTML = `<h3 class="section-title" style="margin-top:8px">Team</h3>${members}${tasks}
    <h3 class="section-title">Spent on this cartridge</h3><div class="spend"><div class="big">${money(u.costUSD)}</div>
    <div class="dim">${plural(u.sessions, 'session')}${u.lastActivity ? ', last active ' + ago(u.lastActivity) + ' ago' : ''}${plan ? '. Plan usage ' + plan : ''}</div>
    ${models.length ? `<table class="mini">${models.map(([m, x]) => `<tr><td>${esc(m.replace(/^claude-/, ''))}</td><td>${kTokens(x.input)} in</td><td>${kTokens(x.output)} out</td><td>${money(x.costUSD)}</td></tr>`).join('')}</table>` : ''}
    <p class="dim">API-equivalent cost from Claude Code. On a subscription it measures quota, not a bill.</p></div>`;
  $('#tab-inbox').innerHTML = t.messages.length ? t.messages.map(m => `<div class="msg"><div class="who"><b>${esc(m.from)}</b> to ${esc(m.to)}${m.time ? ', ' + esc(clock(m.time)) : ''}</div>
      ${m.summary ? `<div class="sum">${esc(m.summary)}</div>` : ''}<div class="body">${esc(m.text)}</div></div>`).join('')
    : '<p class="empty">No messages between agents yet.</p>';
}
async function loadPlans() {
  if (planOpen) {
    let view;
    try { const f = await api('file?path=' + encodeURIComponent(planOpen)); view = `<div class="doc">${md(f.text)}</div>`; }
    catch (e) { view = `<p class="empty">${esc(e.message)}</p>`; }
    $('#tab-files').innerHTML = `<div class="row left"><button class="btn plain" id="plans-back">All files</button></div>${view}`;
    return;
  }
  const files = await api('plans').catch(() => []);
  $('#tab-files').innerHTML = files.length ? `<ul class="filelist">${files.map(f => `<li><button data-file="${esc(f.path)}">
      <span class="f-name">${esc(f.path.replace(/^plans\//, ''))}</span><span class="f-age">${ago(f.mtime)} ago</span></button></li>`).join('')}</ul>`
    : '<p class="empty">The notebook is empty. The team writes its spec, plan and reports here as it works.</p>';
}
async function loadGit() {
  const g = await api('git').catch(e => ({ repo: false, error: e.message }));
  $('#tab-files').innerHTML = !g.repo ? `<p class="empty">Not a git folder. ${esc(g.error || '')}</p>` : `
    ${g.branch ? `<p class="dim" style="margin:0 2px 4px"><code>${esc(g.branch)}</code>${g.base ? `, ${plural(g.ahead || 0, 'commit')} ahead of <code>${esc(g.base)}</code>` : ''}</p>` : ''}
    <h3 class="section-title">Commits${g.base ? ' on this branch' : ''}</h3><pre class="pre">${esc(g.log || 'None yet')}</pre>
    <h3 class="section-title">Uncommitted changes</h3><pre class="pre">${esc(g.diff || 'None')}</pre>
    <h3 class="section-title">Status</h3><pre class="pre">${esc(g.status || 'Clean')}</pre>`;
}

// ---------- Phases ----------
async function phaseAction(id, what) {
  const p = S.phases.find(x => x.id === id);
  if (what === 'run') {
    await act(() => api('phase', { phase: id, action: 'run' }), `${p.title}: sent to the lead`);
    return;
  }
  if (what === 'edit') {
    if (!S.running) return toast('This cartridge is off. Tap Start.', true);
    const r = await api('prompt?phase=' + id).catch(e => (toast(e.message, true), null));
    if (!r) return;
    const modeNote = S.mode !== p.mode
      ? `<div class="note warn">This phase needs <b>${MODE_LABEL[p.mode]}</b> mode. The console switches it before sending; the lead and its teammates get it right away.</div>` : '';
    const res = await dialog(p.title, `${modeNote}
      <label class="lbl" for="dlg-text">Prompt for the lead (edit it before sending if you like)</label>
      <textarea id="dlg-text" name="text" rows="16">${esc(r.text)}</textarea>
      <div class="row left"><button type="button" class="btn plain" data-act="tpl" data-name="${esc(r.template)}">Edit this project's template</button></div>`,
    [CANCEL, { label: 'Send to the lead', value: 'send', cls: 'inv' }]);
    if (res.action === 'send') {
      const out = await act(() => api('phase', { phase: id, action: 'run', text: res.data.text }), 'Sent to the lead');
      if (out && out.modeChanged) toast(`Switched to ${MODE_LABEL[out.mode]} mode and sent the prompt`);
      setTab('term');
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
  const canPr = p.pr && S.cart.branch && !S.cart.home && !safeUrl(S.cart.prUrl);
  const res = await dialog(p.title, `${canPr ? '<div class="row left"><button type="button" class="btn" data-action="pr">Open a pull request</button></div>' : ''}${content}
    ${targets.length ? `<label class="lbl" for="dlg-to">Send the report to a cartridge (optional)</label>
    <select id="dlg-to" name="to"><option value="">Do not send</option>${targets.map(x =>
    `<option value="${esc(x.id)}" ${S.cart.target && x.branch === S.cart.target ? 'selected' : ''}>${esc(shortTitle(x))}${x.running ? '' : ' (off)'}</option>`).join('')}</select>` : ''}
    <label class="lbl" for="dlg-fb">Feedback (needed when you ask for changes)</label>
    <textarea id="dlg-fb" name="feedback" rows="3" placeholder="For example: drop the cache layer for now. Add a migration step with a rollback."></textarea>`,
  [CANCEL,
    { label: p.rejectTo ? 'Send back' : 'Ask for changes', value: 'reject', validate: d => (d.feedback.trim() ? true : (toast('Write the feedback first', true), false)) },
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
  const many = OV.projects.length > 1;
  let issProj = store.get('ctu-iss-proj', 'all');
  if (issProj !== 'all' && !OV.projects.some(p => p.id === issProj)) issProj = 'all';
  const pending = dialog('Add a cartridge', `
    <div class="chips" role="tablist">
      <button type="button" class="seg-btn active" data-addtab="issues">Issues</button>
      <button type="button" class="seg-btn" data-addtab="new">New task</button>
      <button type="button" class="seg-btn" data-addtab="review">Review</button>
      <button type="button" class="seg-btn" data-addtab="research">Research</button>
      <button type="button" class="seg-btn" data-addtab="home">Main folder</button>
    </div>
    <input type="hidden" name="tab" id="add-tab" value="issues">
    <div id="add-proj-wrap" hidden>
      <label class="lbl" for="add-project">Project</label>
      <select id="add-project" name="project">${OV.projects.map(p => `<option value="${esc(p.id)}" title="${esc(p.path)}" ${p.id === project ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    </div>
    <div id="add-issues">
      <div class="find-bar">
      <input type="search" id="iss-q" class="search" placeholder="Search issues" enterkeyhint="search" autocomplete="off">
      <div class="filters">
        <div class="segmented" id="iss-who"><button type="button" data-who="mine">Mine</button><button type="button" data-who="all">All</button></div>
        ${many ? `<select id="iss-proj" aria-label="Project"><option value="all">All projects</option>${OV.projects.map(p => `<option value="${esc(p.id)}" ${p.id === issProj ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
      </div>
      <p class="picked" id="iss-picked" hidden></p>
      </div>
      <div id="iss-list"><p class="dim">Loading issues…</p></div>
    </div>
    <div id="add-new" hidden>
      <label class="lbl" for="new-text">Describe it in your own words</label>
      <textarea id="new-text" rows="3" placeholder="For example: the report page is slow when filtering by month; also want a CSV export button."></textarea>
      <div class="row"><button type="button" class="btn" data-draft="1">Draft the issue with Claude</button></div>
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
      <p class="dim"><span id="flow-help">${FLOW_HELP.quick}</span> ${CHECKS_NOTE}</p>
    </div>
    <details id="add-branch" class="more-opts">
      <summary>Branch options</summary>
      <p class="dim" id="br-many" hidden>Issues from several projects each start from their project's default branch.</p>
      <div id="br-name">
        <label class="lbl" for="add-br">Branch name</label>
        <input type="text" id="add-br" name="branch" placeholder="Automatic: issue/<number>-<title>">
      </div>
      <div id="br-base">
        <label class="lbl" for="add-base">Start from</label>
        <select id="add-base" name="base"><option value="">Default branch</option></select>
      </div>
      <label class="opt"><input type="checkbox" name="fetch" checked><span>Fetch the latest version first</span></label>
    </details>`,
  [CANCEL, { label: 'Add', value: 'add', validate: d => addValid(d) }, { label: 'Add and start', value: 'start', cls: 'inv', validate: d => addValid(d) }]);
  function addValid(d) {
    if (d.tab === 'new') return d.title.trim() ? true : (toast('Write a task name', true), false);
    if (d.tab === 'review') return d.target || (d.pr || '').trim() ? true : (toast('Pick a cartridge or type a PR number', true), false);
    if (d.tab === 'research') return d.question.trim() ? true : (toast('Write the research question', true), false);
    if (d.tab === 'home') return true;
    return picked.size ? true : (toast('Pick at least one issue', true), false);
  }

  // Issues: picks survive filtering and searching; the list reloads from GitHub on each filter change
  const picked = new Map(); // "<project>#<number>" → issue
  let who = store.get('ctu-iss-who', 'mine'), issues = [], seq = 0, timer = 0;
  const issKey = i => `${i.project}#${i.number}`;
  const matches = (i, t) => !t || `#${i.number} ${i.title} ${i.labels.join(' ')}`.toLowerCase().includes(t);
  const renderIssues = (res) => {
    const t = $('#iss-q').value.trim().toLowerCase();
    const all = !many || $('#iss-proj').value === 'all';
    const list = issues.filter(i => matches(i, t)).sort((a, b) => !!a.cart - !!b.cart); // ones with a cartridge go last
    const err = res && res.error ? `<div class="note">Could not load issues from ${esc(res.error)}</div>` : '';
    if (!list.length) {
      $('#iss-list').innerHTML = err + (res && !res.ok ? '' : `<div class="empty">${t ? 'No open issue matches.' : who === 'mine' ? 'Nothing open is assigned to you.' : 'No open issues.'}
        ${who === 'mine' ? '<button type="button" class="btn plain" data-who-all="1">Show all issues</button>' : ''}</div>`);
      return;
    }
    $('#iss-list').innerHTML = err + `<ul class="pick-list">${list.map(i => {
      const meta = [all && many ? i.projectName : '', ...i.labels].filter(Boolean);
      return `<li><label class="pick ${i.cart ? 'used' : ''}"><input type="checkbox" data-pick="${esc(issKey(i))}" ${picked.has(issKey(i)) ? 'checked' : ''} ${i.cart ? 'disabled' : ''}>
        <span><b>#${i.number}</b> ${esc(i.title)}${meta.length ? `<small>${meta.map(esc).join(', ')}</small>` : ''}</span>
        ${i.cart ? '<em>has a cartridge</em>' : ''}</label></li>`;
    }).join('')}</ul>`;
  };
  const loadIssues = async () => {
    const my = ++seq;
    const proj = many ? $('#iss-proj').value : OV.projects[0].id;
    $$('#iss-who button').forEach(b => b.classList.toggle('active', b.dataset.who === who));
    const q = $('#iss-q').value.trim();
    const res = await call(`issues?project=${encodeURIComponent(proj)}&mine=${who === 'mine' ? 1 : 0}&q=${encodeURIComponent(q)}`)
      .catch(e => ({ ok: false, error: e.message, issues: [] }));
    if (my !== seq || !$('#iss-list')) return;
    issues = res.issues || [];
    $('#new-create').hidden = !res.ok;
    renderIssues(res);
  };
  const showPicked = () => {
    const n = picked.size, projects = new Set([...picked.values()].map(i => i.project));
    $('#iss-picked').hidden = !n;
    $('#iss-picked').textContent = n === 1 ? '1 issue picked' : `${n} issues picked`;
    $('#br-many').hidden = projects.size < 2;
    $('#br-base').hidden = projects.size > 1;
    $('#br-name').hidden = n > 1;
    if (projects.size === 1) loadBranches([...projects][0]);
  };
  $('#iss-list').onchange = e => {
    const k = e.target.dataset.pick;
    if (!k) return;
    if (e.target.checked) picked.set(k, issues.find(i => issKey(i) === k)); else picked.delete(k);
    showPicked();
  };
  $('#iss-list').onclick = e => { if (e.target.dataset.whoAll) { who = 'all'; store.set('ctu-iss-who', who); loadIssues(); } };
  $('#iss-who').onclick = e => { const w = e.target.closest('[data-who]'); if (w && w.dataset.who !== who) { who = w.dataset.who; store.set('ctu-iss-who', who); loadIssues(); } };
  if (many) $('#iss-proj').onchange = () => { store.set('ctu-iss-proj', $('#iss-proj').value); loadIssues(); };
  $('#iss-q').oninput = () => { renderIssues(); clearTimeout(timer); timer = setTimeout(loadIssues, 450); };
  $('#iss-q').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); loadIssues(); } };

  let branchesFor = null;
  const loadBranches = async pid => {
    if (pid === branchesFor) return;
    branchesFor = pid;
    const br = await call('branches?project=' + encodeURIComponent(pid)).catch(() => ({ base: '', branches: [] }));
    if (branchesFor !== pid || !$('#add-base')) return;
    const opts = new Set([br.base, ...br.branches].filter(Boolean));
    $('#add-base').innerHTML = [...opts].map(b => `<option value="${esc(b)}" ${b === br.base ? 'selected' : ''}>${esc(b)}${b === br.base ? ' (default)' : ''}</option>`).join('');
  };
  const load = async () => {
    const pid = $('#add-project').value;
    store.set('ctu-project', pid);
    if ($('#add-tab').value !== 'issues') loadBranches(pid);
    const targets = OV.cartridges.filter(c => c.project === pid && c.kind === 'team' && !c.home && c.branch);
    $('#rv-targets').innerHTML = targets.length ? `<label class="lbl" for="rv-target">Review a cartridge</label>
      <select id="rv-target" name="target"><option value="">Pick one…</option>${targets.map(c => `<option value="${esc(c.id)}">${esc(c.title)} (${esc(c.branch)})</option>`).join('')}</select>`
      : '<p class="empty">No cartridge in this project has its own branch yet.</p>';
  };
  $('#add-project').onchange = load;
  $('#add-flow-sel').onchange = () => { $('#flow-help').textContent = FLOW_HELP[$('#add-flow-sel').value]; };
  addSync = tab => tab === 'issues' ? showPicked() : loadBranches($('#add-project').value);
  load(); loadIssues();
  const res = await pending;
  if (res.action !== 'add' && res.action !== 'start') return;
  const d = res.data;
  let ep = 'cart-add', payload;
  const branchOpts = { branch: d.branch, base: d.base, fetch: !!d.fetch, flow: d.flow, start: res.action === 'start' };
  if (d.tab === 'new') payload = { project: d.project, title: d.title, body: d.body, createIssue: !!d.createIssue, ...branchOpts };
  else if (d.tab === 'review') { ep = 'cart-add-review'; payload = (d.pr || '').trim() ? { project: d.project, pr: d.pr.trim() } : { project: d.project, target: d.target }; }
  else if (d.tab === 'research') { ep = 'cart-add-research'; payload = { project: d.project, question: d.question, title: d.rtitle }; }
  else if (d.tab === 'home') { ep = 'cart-add-home'; payload = { project: d.project, flow: d.flow }; }
  else payload = { issues: [...picked.keys()], ...branchOpts };
  toast('Adding…');
  const out = await act(() => call(ep, payload));
  if (out && out.made && out.made.length) {
    toast(branchOpts.start ? 'Added. The team is starting.' : out.made.length > 1 ? `Added ${out.made.length} cartridges.` : 'Added. Tap Start when you want it to run.');
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
let addSync = null; // set by the open add sheet: reloads branches for the tab's project
function addTab(tab) {
  $$('.seg-btn').forEach(x => x.classList.toggle('active', x.dataset.addtab === tab));
  $('#add-tab').value = tab;
  for (const t of ['issues', 'new', 'review', 'research', 'home']) $('#add-' + t).hidden = tab !== t;
  $('#add-proj-wrap').hidden = tab === 'issues';
  if (tab !== 'issues') { $('#br-name').hidden = $('#br-base').hidden = false; $('#br-many').hidden = true; }
  if (addSync) addSync(tab);
  $('#add-branch').hidden = !['issues', 'new'].includes(tab);
  $('#add-flow').hidden = !['issues', 'new', 'home'].includes(tab);
}

// ---------- Projects and settings ----------
function projectsBody(sug) {
  const ps = OV.projects;
  const theme = store.get('ctu-theme', 'auto');
  return `<h3 class="lbl">Appearance</h3>
    <div class="segmented wrap">${['auto', 'light', 'dark'].map(t => `<button type="button" data-theme-set="${t}" class="${t === theme ? 'active' : ''}">${{ auto: 'Auto', light: 'Light', dark: 'Dark' }[t]}</button>`).join('')}</div>
    <h3 class="lbl">Projects</h3>
    ${ps.length ? `<ul class="proj-list">${ps.map(p => `<li>
      <div><b>${esc(p.name)}</b><div class="dim">${esc(tilde(p.path))}</div></div>
      <div class="proj-inputs"><input type="text" data-test="${esc(p.id)}" value="${esc(p.testCommand)}" placeholder="Test command (optional), e.g. pnpm test" aria-label="Test command for ${esc(p.name)}">
        <input type="text" data-node="${esc(p.id)}" value="${esc(p.node || '')}" inputmode="decimal" placeholder="Node version via nvm (optional), e.g. 24" aria-label="Node version for ${esc(p.name)}"></div>
      <span class="proj-act"><button type="button" class="btn" data-act="saveproj" data-id="${esc(p.id)}">Save</button>
      <button type="button" class="btn plain" data-act="rmproj" data-id="${esc(p.id)}">Remove</button></span></li>`).join('')}</ul>`
    : '<p class="empty">No projects yet.</p>'}
    <h3 class="lbl">Add a project</h3>
    <div class="row left"><input type="text" id="proj-path" placeholder="/full/path/to/a/git/repository" aria-label="Project path"><button type="button" class="btn primary" data-act="addproj">Add</button></div>
    ${sug.length ? `<p class="dim">Repositories found in your folders:</p><ul class="sug-list">${sug.map(s => `<li><button type="button" data-act="addpath" data-path="${esc(s)}">+ ${esc(tilde(s))}</button></li>`).join('')}</ul>` : ''}
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
  [CANCEL, { label: 'Start and run', value: 'go', cls: 'inv' }]);
  if (res.action === 'go') {
    const { resume, ...opts } = res.data;
    await act(() => api('start', { opts, resume: !!resume, run: true }), 'Starting…');
  }
}
async function stopDialog() {
  const v = await sheet('Stop this cartridge?', [
    { label: 'Stop', sub: 'Claude exits cleanly. plans/ stays; the lead can continue next time.', value: 'stop' },
    { label: 'Restart', sub: 'Stop and start again, continuing the conversation', value: 'restart' },
    { label: 'Force stop', sub: 'Kill the session now', value: 'kill', danger: true },
  ]);
  if (v === 'stop') { toast('Asking Claude to exit…'); act(() => api('stop', {}), 'Stopped'); }
  if (v === 'restart') { toast('Restarting…'); act(() => api('restart', { resume: true }), 'Restarted'); }
  if (v === 'kill') act(() => api('stop', { hard: true }), 'Stopped');
}
async function ejectDialog() {
  const c = S.cart;
  const what = c.home ? `<p>Take <b>${esc(c.title)}</b> off the list. The project folder stays exactly as it is.</p>`
    : c.kind === 'research' ? `<p>Take <b>${esc(c.title)}</b> off the list.</p><div class="note">The report stays in <code>${esc(c.dir)}/plans/</code>.</div>`
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

// Answer a waiting agent straight from the list, without opening the cartridge
// Answers from the home list: the ticket stops asking at once; the server re-reads the screen before it replies
async function answerFromHome(b) {
  const c = OV && OV.cartridges.find(x => x.id === b.dataset.cid);
  if (c) { c.attention = null; c.attnPane = null; renderHome(); }
  try { await call('key', { cart: b.dataset.cid, pane: b.dataset.pane || undefined, key: b.dataset.answer }); toast(b.dataset.answer === 'enter' ? 'Answered' : 'Declined'); }
  catch (e) { toast(e.message, true); }
  refreshOverview();
}

// ---------- Events ----------
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.dataset.sheet !== undefined) return;
  if (b.dataset.themeSet) { applyTheme(b.dataset.themeSet); $$('[data-theme-set]').forEach(x => x.classList.toggle('active', x === b)); return; }
  if (b.dataset.answer) return answerFromHome(b);
  if (b.dataset.act === 'pilot') return pilotSheet();
  if (b.dataset.trust) return act(() => call('trust', { cart: b.dataset.trust }), 'Folder trusted');
  if (b.dataset.cart !== undefined) return switchCart(b.dataset.cart);
  if (b.dataset.tab) return setTab(b.dataset.tab);
  if (b.dataset.seg) { filesSeg = b.dataset.seg; planOpen = null; $$('.segmented [data-seg]').forEach(x => x.classList.toggle('active', x === b)); return loadTab(true); }
  if (b.dataset.addtab) return addTab(b.dataset.addtab);
  if (b.dataset.draft) return draftIssue();
  const a = b.dataset.act;
  if (a === 'add') return addDialog();
  if (a === 'projects') return projectsDialog();
  if (a === 'trust') return act(() => api('trust', {}), 'Folder trusted');
  if (a === 'tpl') return templateDialog(b.dataset.name);
  if (a === 'step-more') return stepMore();
  if (a === 'start-run') return act(() => api('start', { run: true }), S && S.pilot !== 'manual' ? 'Starting. The team takes it from here.' : 'Starting. The step runs when Claude is ready.');
  if (a === 'keys') return keysSheet();
  if (['addproj', 'addpath', 'saveproj', 'rmproj'].includes(a)) return projectAction(b);
  if (b.dataset.ph) return phaseAction(b.dataset.ph, b.dataset.do);
  if (b.dataset.key) {
    if (b.closest('#attention')) { // same for the bar inside a cartridge
      const pane = S && S.panes.find(x => x.id === b.dataset.pane);
      if (pane) pane.attention = null;
      renderAttention();
    }
    return sendKey(b.dataset.key, b.dataset.pane);
  }
  if (b.dataset.pane) { selPane = b.dataset.pane; renderPaneTabs(); $('#term').textContent = '…'; termRaw = null; return refreshTerm(true); }
  if (b.dataset.file) { planOpen = b.dataset.file; return loadPlans(); }
  if (b.id === 'plans-back') { planOpen = null; return loadPlans(); }
});
$('#btn-back').onclick = () => switchCart(null);
$('#btn-settings').onclick = projectsDialog;
$('#btn-add').onclick = addDialog;
$('#btn-more').onclick = cartMenu;
$('#btn-power').onclick = () => (S ? (S.running ? stopDialog() : act(() => api('start', {}), 'Started')) : null);
$('#composer').onsubmit = e => { e.preventDefault(); const m = $('#msg'); const t = m.value; m.value = ''; m.style.height = ''; sendMsg(t); };
$('#msg').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#composer').requestSubmit(); } });
$('#msg').addEventListener('input', e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px'; });

// Keep the app inside the visible viewport, so the keyboard never covers what is being typed
// Scrolling: the navbar turns to glass once content slides under it, and the big title moves into it
function syncScroll(el) {
  el = el || $$('#app .scroll').find(x => x.offsetParent);
  const app = $('#app'), y = el ? el.scrollTop : 0;
  const big = el && el.querySelector('.hero h1, .cart-head h1');
  app.classList.toggle('scrolled', y > 4);
  app.classList.toggle('titled', !!big && y > big.offsetTop + big.offsetHeight - $('.navbar').offsetHeight);
}
document.addEventListener('scroll', e => { if (e.target.classList && e.target.classList.contains('scroll')) syncScroll(e.target); }, true);
$('#term').addEventListener('scroll', syncTermDown, { passive: true });
$('#term-down').onclick = () => { const t = $('#term'); t.scrollTo({ top: t.scrollHeight, behavior: 'smooth' }); };
document.addEventListener('focusout', () => setTimeout(fitViewport, 100));
// The dock (needs-you bar and tab bar) floats over the content; scroll areas leave room for it
new ResizeObserver(() => $('#app').style.setProperty('--dock-h', $('#dock').offsetHeight + 'px')).observe($('#dock'));
$('#dlg form').addEventListener('submit', e => { e.preventDefault(); const b = $('#dlg-actions .btn.primary'); if (b) b.click(); });
function fitViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  document.documentElement.style.setProperty('--app-h', vv.height + 'px');
  document.documentElement.style.setProperty('--app-top', vv.offsetTop + 'px');
  // Keyboard open (a field has focus and the view shrank): the tab bar steps aside
  $('#app').classList.toggle('kb', innerHeight - vv.height > 150 && !!document.activeElement && document.activeElement.matches('input, textarea'));
}
if (window.visualViewport) { visualViewport.addEventListener('resize', fitViewport); visualViewport.addEventListener('scroll', fitViewport); fitViewport(); }
document.addEventListener('focusin', e => {
  if (e.target.matches('#dlg-body input, #dlg-body textarea')) setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
});

// ---------- Loops ----------
(async function main() {
  applyTheme(store.get('ctu-theme', 'auto'));
  await refreshOverview();
  if (cur) { await refreshState(); setTab(tab); }
  setInterval(refreshOverview, 3000);
  setInterval(refreshState, 2500);
  setInterval(refreshTerm, 1200);
  setInterval(() => { if (tab === 'team') loadTab(false); }, 5000);
})();

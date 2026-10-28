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
let tab = store.get('ctu-tab', 'flow');  // flow | chat | term | team | files
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
  // The browser bar follows the theme: both colours on Auto, the chosen one otherwise
  const forced = { light: '#f5f5f7', dark: '#000000' }[r.dataset.theme];
  $$('meta[name="theme-color"]').forEach(m => { m.content = forced || (m.media.includes('dark') ? '#000000' : '#f5f5f7'); });
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
// Two requests in a row that never reach the server (the Mac asleep, Tailscale down) show a bar under the navbar
// with the last time it answered; the next answer hides it
let netFails = 0, netLastOk = 0;
function netSeen(okNow) {
  const el = $('#offline');
  if (okNow) { netFails = 0; netLastOk = Date.now(); if (el && !el.hidden) el.hidden = true; return; }
  if (++netFails < 2 || !el) return;
  el.textContent = `Console unreachable — retrying${netLastOk ? `. Last seen ${clock(netLastOk)}` : ''}`;
  el.hidden = false;
}
async function call(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CTU': '1' }, body: JSON.stringify(body) };
  let r;
  try { r = await fetch('/api/' + path, opt); } catch { netSeen(false); throw new Error('Console unreachable'); }
  netSeen(true);
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
        const data = Object.fromEntries($$('#dlg-body [name]').filter(el => el.type !== 'radio' || el.checked).map(el => [el.name, el.type === 'checkbox' ? el.checked : el.value]));
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
  quick: 'Small task. The lead writes a one-page plan and builds it alone; one reviewer checks all five areas.',
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
  if (!cur) { renderHome(); freshUsage(); }
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
  if (!u || (!u.fiveHour && !u.sevenDay)) return u && u.error ? `<button class="usage" data-act="usage"><small class="dim">Plan usage: ${esc(u.error)}</small></button>` : '';
  const stale = Date.now() - (u.at || 0) > 30 * 60000;
  const pct = x => (x && x.pct != null ? Math.min(100, Math.max(0, x.pct)) : null);
  const ring = (cls, r, x) => (pct(x) == null ? '' : `<circle class="track" r="${r}" cx="40" cy="40"/>
    <circle class="val ${cls} ${pct(x) >= 80 ? 'hot' : ''}" r="${r}" cx="40" cy="40" pathLength="100" style="stroke-dashoffset:${100 - Math.max(1, pct(x))}"/>`);
  const line = (cls, label, x) => (pct(x) == null ? '' : `<div class="legend-row"><i class="key ${cls} ${pct(x) >= 80 ? 'hot' : ''}"></i>
    <b>${Math.round(pct(x))}%</b> ${label}${x.resetsAt ? `<small>resets ${resetTime(x.resetsAt)}</small>` : ''}</div>`);
  const draw = ringsDrawn ? '' : 'draw';
  ringsDrawn = true;
  const note = stale || u.error ? `<small class="dim">${u.at ? `as of ${ago(u.at)} ago` : ''}${u.error ? ` · ${esc(u.error)}` : ''}</small>` : '';
  return `<button class="usage ${stale ? 'stale' : ''}" data-act="usage" aria-label="Plan usage, tap to refresh">
    <svg class="rings ${draw}" viewBox="0 0 80 80" aria-hidden="true">${ring('outer', 34, u.fiveHour)}${ring('inner', 23, u.sevenDay)}</svg>
    <div class="legend">${line('outer', '5-hour window', u.fiveHour)}${line('inner', 'this week', u.sevenDay)}${note}</div></button>`;
}
// The figures only move while Claude runs here, so the home screen asks for fresh ones (an HTTPS call to claude.ai, no
// tokens) once they are three minutes old, at most every three minutes. A tap on the rings asks right away.
let usageAsked = 0;
async function freshUsage(now) {
  const u = OV && OV.usage;
  if (!now && (Date.now() - usageAsked < 180000 || (u && Date.now() - (u.at || 0) < 180000))) return;
  usageAsked = Date.now();
  try { OV.usage = await call('usage', {}); } catch (e) { if (now) toast(e.message, true); return; }
  if (now && OV.usage && OV.usage.error) toast(OV.usage.error, true);
  if (now) ringsDrawn = false;
  if (!cur) renderHome();
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
const HEALTH_LINE = { exited: 'Claude stopped', error: 'Claude hit an error', limit: 'Usage limit reached', stalled: 'Looks stuck' };
const askLine = n => (n === 1 ? '1 question for you' : `${n} questions for you`);
function stateLine(c) {
  if (c.running && c.health) return HEALTH_LINE[c.health.kind];
  if (c.setup && c.setup.status === 'running') return `Preparing the worktree: ${c.setup.cmd}`;
  if (c.setup && c.setup.status === 'failed' && !c.running) return 'Setup failed';
  if (c.questions) return askLine(c.questions);
  if (c.attention) return `${c.attnLead ? 'The lead' : 'A teammate'} ${{ permission: 'asks for permission', trust: 'asks to trust the folder', exit: 'asks how to exit' }[c.attention] || 'is waiting for you'}`;
  const ops = opsState(c); // paused on budget or quota, powered off while idle, hibernated
  if (ops) return ops;
  if (c.running) return c.stepAt && c.phase !== 'Done' ? `${c.phase}, ${minutes(c.stepAt)}` : c.phase;
  return c.phase === 'Done' ? 'All steps done' : `Next: ${c.phase}`;
}
function ticketHTML(c) {
  const cls = c.attention || c.questions || c.paused ? 'attn' : (c.running && c.health) || (!c.running && c.setup && c.setup.status === 'failed') ? 'fail' : c.running ? 'run' : 'off';
  const meta = [c.projectName, c.kind === 'team' && c.flow ? `${FLOW_NAME[c.flow]} flow` : c.home ? 'Main checkout' : c.kind === 'review' ? 'Review' : 'Research',
    c.costUSD != null ? `${money(c.costUSD)} used` : '', c.prUrl ? 'PR open' : '', c.pr && c.pr.new ? `${plural(c.pr.new, 'new PR comment')}` : ''].filter(Boolean);
  const verdict = c.digest && c.digest.verdict ? `<span class="t-verdict ${verdictCls(c.digest.verdict)}">${esc(verdictText(c.digest))}</span>` : '';
  let answer = '';
  if (c.attention === 'permission' || c.attention === 'question') {
    answer = `<div class="t-answer"><button class="btn primary" data-answer="enter" data-cid="${esc(c.id)}" data-pane="${esc(c.attnPane || '')}">${c.attention === 'permission' ? 'Allow' : 'Enter'}</button>
      <button class="btn" data-answer="esc" data-cid="${esc(c.id)}" data-pane="${esc(c.attnPane || '')}">${c.attention === 'permission' ? 'Deny' : 'Esc'}</button></div>`;
  } else if (c.attention === 'trust') {
    answer = `<div class="t-answer"><button class="btn primary" data-trust="${esc(c.id)}">Trust this folder</button></div>`;
  }
  if (!answer) answer = opsTicketActions(c);
  const crew = c.running && c.crew && c.crew.length ? `<span class="crew">${c.crew.map(m => `<i class="orb ${m.attention ? 'attn' : m.busy ? 'busy' : ''}" title="${esc(m.name)}${m.attention ? ', waiting for you' : m.busy ? ', working' : ''}">${esc((m.name || '?')[0])}</i>`).join('')}</span>` : '';
  const said = c.running && !c.attention && !c.health && c.said ? `<span class="t-said">${esc(c.said)}</span>` : '';
  const prog = c.steps && c.steps.total ? `<span class="t-prog" style="--v:${Math.round(100 * c.steps.done / c.steps.total)}%" title="${c.steps.done} of ${c.steps.total} steps done"></span>` : '';
  return `<li class="ticket ${cls}"><button class="ticket-open" data-cart="${esc(c.id)}">
    <span class="t-title">${esc(shortTitle(c))}</span><span class="t-state">${esc(stateLine(c))}</span>${verdict}${said}
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
  const needs = carts.filter(c => c.attention || c.questions || c.paused || (c.running && c.health)), working = carts.filter(c => !needs.includes(c) && c.running), idle = carts.filter(c => !needs.includes(c) && !c.running);
  const head = needs.length ? `${needs.length} need${needs.length === 1 ? 's' : ''} you` : working.length ? `${working.length} working` : 'All quiet';
  const sub = needs.length ? (working.length ? `${working.length} more working.` : 'Answer from here, or open the cartridge.')
    : working.length ? 'Nothing needs you right now.' : carts.length ? 'No team is running.' : 'Add a cartridge to give a team some work.';
  const html = `<section class="hero"><h1>${head}${needs.length ? '<span class="pulse" aria-hidden="true"></span>' : ''}</h1><p>${sub}</p>${metersHTML()}${opsHomeHTML()}</section>
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
  renderNav(); renderHead(); renderDigest(); renderNext(); renderPhases(); renderPaneTabs(); renderAttention(); renderChatChrome(); renderOps();
}
async function refreshAll() { await refreshOverview(); await refreshState(); }

const PILOT = {
  'full-auto': { name: 'Full auto', sub: 'Runs to a draft pull request on its own: settles its own questions, allows its own permission prompts and retries after errors. The guard still blocks pushing, publishing, GitHub writes, rm -rf and secrets. Never merges.' },
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
    safeUrl(c.prUrl) ? `<button class="prc ${S.pr && S.pr.new ? 'new' : ''}" data-act="pr-check">${S.pr && S.pr.new ? plural(S.pr.new, 'new PR comment') : S.pr && S.pr.checkedAt ? 'No new PR comments' : 'Check PR comments'}</button>` : '',
    S.setup && S.setup.status === 'running' ? `<span class="setup run">Preparing: <code>${esc(S.setup.cmd)}</code></span>`
      : S.setup && S.setup.status === 'failed' ? '<button class="setup fail" data-act="setup-log">Setup failed, see the log</button>' : '',
  ].filter(Boolean);
  $('#cart-head').innerHTML = `<h1>${esc(c.title.replace(/^(Review |Research: )/, ''))}</h1><div class="facts">${facts.join('')}</div>`;
}
// The review report can be posted to the pull request from a review checkpoint; the label says when it last was
const postLabel = () => (S.prComment ? `Posted ${clock(S.prComment.at)} · Post again` : 'Post review to the PR');
const canPost = p => !!S.reviewPrUrl && (!p || (p.kind === 'gate' && p.status === 'ready' && /review/.test(p.file || '')));
// What can be done at a step: the first is the main action, the rest go under "More"
function phaseOptions(p) {
  const out = [];
  if (p.kind === 'agent') {
    if (p.status === 'ready') out.push({ label: 'Run', what: 'run' }, { label: 'Edit the prompt, then run', what: 'edit' });
    if (p.status === 'running') out.push({ label: 'Mark done', what: 'done' }, { label: 'Send the prompt again', what: 'run' });
    if (p.rejectTo && p.status === 'running') out.push({ label: 'Bugs found, back to Build', what: 'back' });
  } else if (p.status === 'ready') out.push({ label: 'Review', what: 'review' });
  if (p.pr && S.cart.branch && !S.cart.home && p.status === 'ready' && !safeUrl(S.cart.prUrl)) out.push({ label: 'Open a pull request', what: 'pr' });
  if (p.pr && p.status === 'ready' && safeUrl(S.cart.prUrl)) out.push({ label: 'Push to the pull request', what: 'push' }, { label: 'Address PR comments', what: 'address' });
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
    const pr = safeUrl(S.cart.prUrl);
    $('#next-step').innerHTML = `${track}<div class="next"><h2>All steps done</h2>
      <p>${pr ? 'When reviewers comment on the pull request, send their comments to the team. Eject once it is merged.' : 'Eject the cartridge when the branch is merged.'}</p>
      <div class="actions">${pr ? `<button class="btn primary" data-act="address-pr">Address PR comments</button><a class="btn plain" href="${esc(S.cart.prUrl)}" target="_blank" rel="noopener">View the pull request</a>` : ''}
      ${canPost(null) ? `<button class="btn plain" data-act="pr-comment">${postLabel()}</button>` : ''}
      ${lastDone ? '<button class="btn plain" data-act="step-more">More</button>' : ''}</div></div>`;
    return;
  }
  if (p.status === 'running' && S.running) { $('#next-step').innerHTML = track + (S.health ? failCard(p) : workingCard(p, lastDone)); return; }
  const opts = phaseOptions(p);
  const quiet = p.status === 'running' && S.pilot !== 'manual' && S.running; // the team ends the step itself
  const main = quiet ? null : opts[0];
  const off = p.kind === 'agent' && !S.running;
  const more = opts.length - (main ? 1 : 0) + (lastDone ? 1 : 0);
  const asks = p.kind === 'gate' && p.status === 'ready' ? S.questions || [] : [];
  const kicker = p.status === 'running' ? 'Working on it' : asks.length ? askLine(asks.length) : p.kind === 'gate' ? 'Your decision' : 'Up next';
  const auto = S.pilot !== 'manual';
  const why = off ? ({ 'full-auto': 'Start the team. It works through every step by itself and ends with a draft pull request.', 'hands-off': 'Start the team. It works through the steps by itself and stops only before the merge.' }[S.pilot] || 'Start the team and this step runs as soon as Claude is ready.')
    : p.status === 'running' ? (S.pilot === 'full-auto' ? 'The team carries on by itself, up to a draft pull request.' : S.pilot === 'hands-off' ? 'The team carries on by itself. You are asked only before the merge, or when an agent needs permission.'
      : auto ? 'When the lead reports done, the next step starts by itself until a checkpoint.' : 'When the lead reports done, this step closes.')
      : p.kind === 'agent' && auto ? 'Starts by itself as soon as the lead is free.' : p.desc || (p.file ? 'Read ' + p.file : '');
  $('#next-step').innerHTML = `${track}<div class="next">
    <div class="kicker ${p.kind === 'gate' ? 'wait' : ''}">${kicker}</div>
    <h2>${esc(p.title)}</h2>${asks.length ? questionList(asks.slice(0, 3), asks.length - 3) : `<p>${esc(why)}</p>`}
    <div class="actions">${off ? `<button class="btn primary" data-act="start-run">${auto ? 'Start' : 'Start and run'}</button>`
      : main ? `<button class="btn ${p.kind === 'agent' && p.status === 'ready' && auto ? '' : 'primary'}" data-ph="${esc(p.id)}" data-do="${main.what}">${p.kind === 'agent' && p.status === 'ready' && auto ? 'Run now' : asks.length ? 'Answer' : main.label}</button>` : ''}
      ${p.kind === 'gate' && p.status === 'ready' && S.running && S.pilot !== 'full-auto' ? `<button class="btn" data-act="hand-over">${p.pr ? (safeUrl(S.cart.prUrl) ? 'Let the team push' : 'Let the team open the PR') : 'Let the team decide'}</button>` : ''}
      ${more ? '<button class="btn plain" data-act="step-more">More options</button>' : ''}
      ${safeUrl(S.cart.prUrl) && p.pr ? `<a class="btn plain" href="${esc(S.cart.prUrl)}" target="_blank" rel="noopener">View the pull request</a>` : ''}
      ${canPost(p) ? `<button class="btn plain" data-act="pr-comment">${postLabel()}</button>` : ''}</div></div>`;
}
// Questions the team asks at a checkpoint, as written in the plan
function questionList(qs, more = 0) {
  return `<ol class="questions">${qs.map(q => `<li>${md(q).replace(/^<div class="md"><p>|<\/p><\/div>$/g, '')}</li>`).join('')}</ol>${more > 0 ? `<p class="dim">and ${more} more</p>` : ''}`;
}
// A running step: a spinner, how long it has run, one line on what is happening, and who is on it
const minutes = t => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? 'just started' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
function crewChips(crew) {
  return crew && crew.length ? `<div class="crew-row">${crew.map(m => `<span class="crew-chip ${m.attention ? 'attn' : m.busy ? 'busy' : ''}"><i></i>${esc(m.name)}</span>`).join('')}</div>` : '';
}
function workingCard(p) {
  return `<div class="next working">
    <div class="kicker"><span class="spinner" aria-hidden="true"></span>${S.fixRound ? `Fixing what the review found, round ${S.fixRound} of ${S.maxFixes}` : 'Working'}${S.stepAt ? ', ' + minutes(S.stepAt) : ''}</div>
    <h2>${esc(p.title)}</h2>
    <p class="doing">${esc(S.doing || { 'full-auto': 'The team runs to a draft pull request by itself.', 'hands-off': 'The team carries on by itself and stops only before the merge.' }[S.pilot] || 'When the lead reports done, the next step starts.')}</p>
    <div class="loading" aria-hidden="true"></div>
    ${crewChips(S.crew)}
    <div class="actions">${S.pilot !== 'full-auto' ? '<button class="btn" data-act="hand-over">Let the team decide</button>' : ''}<button class="btn plain" data-act="step-more">More options</button></div></div>`;
}
// Something went wrong: say what, and offer the one thing that usually fixes it
const HEAL = {
  exited: { title: 'Claude stopped', action: 'Restart' },
  error: { title: 'Claude hit an error', action: 'Tell it to continue' },
  limit: { title: 'Usage limit reached', action: 'Tell it to continue' },
  stalled: { title: 'Looks stuck', action: 'Ask the lead' },
};
function failCard(p) {
  const h = HEAL[S.health.kind];
  return `<div class="next fail ${S.health.kind}">
    <div class="kicker">${h.title}</div>
    <h2>${esc(p.title)}</h2>
    <p>${esc(S.health.text)}</p>
    ${crewChips(S.crew)}
    <div class="actions"><button class="btn primary" data-act="heal">${h.action}</button><button class="btn plain" data-act="step-more">More options</button></div></div>`;
}
// On the Mac: AirDrop or share the phone's sign-in link, or copy it
async function phoneLink() {
  const r = await call('phone-link').catch(e => ({ error: e.message, urls: [] }));
  const url = r.urls && r.urls[0];
  if (!url) return toast(r.error || 'Start the console with --tailscale (or --lan) to use it from a phone', true);
  try { if (navigator.share) return await navigator.share({ title: 'Claude Team', url }); } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { prompt('Sign-in link for your phone', url); }
}
async function heal() {
  const k = S && S.health && S.health.kind;
  if (k === 'exited') return act(() => api('restart', { resume: true }), 'Restarting');
  if (k === 'error' || k === 'limit') return act(() => api('send', { text: 'continue' }), 'Sent "continue"');
  if (k === 'stalled') return act(() => api('nudge', {}), 'Asked the lead');
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
// The timeline: every run of a step in order (a step sent back shows again), who took part and what they said,
// then the steps still ahead
const TL_OUT = { running: 'Working', done: 'Done', changes: 'Needs work', approved: 'Approved', stopped: 'Stopped' };
const span = (a, b) => { const m = Math.round(((b || Date.now()) - a) / 60000); return m < 1 ? 'under a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const agentName = n => (n === 'team-lead' ? 'lead' : n);
function renderPhases() {
  const runs = S.timeline || [];
  const ahead = S.phases.filter(p => p.status === 'locked' || (p.status === 'ready' && !(p.kind === 'agent' && runs.some(r => r.id === p.id && r.status === 'running'))));
  $('#phases').innerHTML = runs.map(r => `<li class="tl ${r.status} kind-${r.kind}">
      <div class="tl-head"><span class="tl-title">${esc(r.title)}</span><span class="tl-out">${esc(r.outcome || TL_OUT[r.status] || '')}</span></div>
      <div class="tl-meta">${r.kind === 'agent' ? (r.status === 'running' ? `${span(r.start)} so far` : span(r.start, r.end)) : clock(r.start)}</div>
      ${r.agents && r.agents.length ? `<div class="tl-agents">${r.agents.map(a => `<span>${esc(agentName(a))}</span>`).join('')}</div>` : ''}
      ${r.events && r.events.length ? `<ul class="tl-events">${r.eventCount > r.events.length ? `<li class="more">${r.eventCount - r.events.length} earlier messages</li>` : ''}${r.events.map(e =>
        `<li><b>${esc(agentName(e.who))}</b>${e.to && e.to !== 'team-lead' ? ` to ${esc(agentName(e.to))}` : ''}: ${esc(e.text)}</li>`).join('')}</ul>` : ''}
    </li>`).join('')
    + ahead.map(p => `<li class="tl pending kind-${p.kind}"><div class="tl-head"><span class="tl-title">${esc(p.title)}</span>
      <span class="tl-out">${p.status === 'ready' ? (p.kind === 'gate' ? 'Your turn' : 'Next') : 'Waiting'}</span></div></li>`).join('');
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
  el.hidden = !a || tab === 'chat';
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
  // A running cartridge opens on the chat (an agent waiting for you always does); Terminal, Team and Files stay as picked
  setTab(sm && sm.attention ? 'chat' : sm && sm.running && tab === 'flow' ? 'chat' : tab);
}
const TABS = ['flow', 'chat', 'term', 'team', 'files'];
function setTab(t) {
  const was = tab;
  tab = TABS.includes(t) ? t : 'flow';
  store.set('ctu-tab', tab);
  $$('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#tabbar').style.setProperty('--ti', TABS.indexOf(tab));
  for (const x of TABS) $('#v-' + x).hidden = x !== tab;
  $('#app').classList.toggle('composing', tab === 'chat' || tab === 'term'); // the assistant button moves off the composer
  if (was !== tab) enter($('#v-' + tab), 'fade');
  syncScroll();
  renderAttention(); // the bar hides on the chat tab, which shows the same card inline
  if (tab === 'term') refreshTerm(true);
  else if (tab === 'chat') { renderChatChrome(); refreshChat(true); }
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
    ...(safeUrl(c.prUrl) ? [{ label: 'Address PR comments', sub: 'Send the reviewers\' open comments to the team as a new build round', value: 'address-pr' }] : []),
    { label: 'Edit the task', value: 'task' },
    { label: S.mode === 'code' ? 'Back to plan only' : 'Allow code changes', sub: S.mode === 'code' ? 'Agents may write only in plans/' : 'Agents may change code in this cartridge', value: 'mode' },
    ...(c.kind === 'team' ? [{ label: 'Change the flow', sub: `Now: ${FLOW_NAME[c.flow]}`, value: 'flow' }] : []),
    { label: 'Edit team rules', sub: 'For this project', value: 'rules' },
    { label: 'Edit quality checks', sub: 'Logic, security, tests, docs, skills', value: 'checks' },
    { label: `Away mode: ${awayLabel()}`, sub: 'Minutes a mid-step question waits for you before the lead decides by itself', value: 'away' },
    ...(S.paused && S.running ? [{ label: 'Run anyway', sub: `Paused before ${S.paused.title}: ${S.paused.reason}`, value: 'run-anyway' }] : []),
    { label: `Budget: ${budgetLabel()}`, sub: S.paused && !S.running ? `Paused before ${S.paused.title}: ${S.paused.reason}`
      : `${S.costUSD != null ? money(S.costUSD) + ' used. ' : ''}Autopilot pauses before the next step once the cost passes it`, value: 'budget' },
    { label: 'Restart the flow', sub: 'Every step goes back to the start', value: 'reset' },
    { label: 'Eject', sub: c.home ? 'Take it off the list' : 'Remove the worktree, keep the branch', value: 'eject', danger: true },
  ]);
  if (v === 'start-opts') startDialog();
  if (v === 'autopilot') pilotSheet();
  if (v === 'address-pr') addressPr();
  if (v === 'task') taskDialog();
  if (v === 'mode') modeDialog();
  if (v === 'flow') flowDialog();
  if (v === 'rules') templateDialog('_rules.md');
  if (v === 'checks') templateDialog('_checks.md');
  if (v === 'away') awayDialog();
  if (v === 'run-anyway') runAnyway(cur);
  if (v === 'budget') budgetDialog(cur);
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
function ansiLine(line, st) {
  let out = '';
  for (const part of line.split(/(\x1b\[[0-9;:]*m)/)) {
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
// Tables Claude draws with box characters keep their shape: their lines never wrap and scroll sideways as one block
const TABLE_LINE = /[│┃┌┐└┘├┤┬┴┼╞╡╪]/;
function ansiHTML(raw) {
  const st = {};
  const out = [];
  let table = null;
  for (const line of String(raw).split('\n')) {
    const html = ansiLine(line, st);
    if (TABLE_LINE.test(line.replace(/\x1b\[[0-9;:]*m/g, ''))) { (table = table || []).push(html); continue; }
    if (table) { out.push(`<span class="tbl">${table.join('\n')}</span>`); table = null; }
    out.push(html);
  }
  if (table) out.push(`<span class="tbl">${table.join('\n')}</span>`);
  return out.join('\n');
}
// Narrow screens wrap lines, so full-width rules and Claude's rounded boxes would turn into blocks of dashes
// (square corners belong to tables, which keep their width)
const shortRules = raw => String(raw).split('\n').map(line =>
  /^\s*[╭╰]?[─━═╌]{13,}[╮╯]?\s*$/.test(line.replace(/\x1b\[[0-9;:]*m/g, '')) ? line.replace(/[─━═╌]{13,}/, m => m.slice(0, 12)) : line).join('\n');
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
    let view, text = '';
    try { const f = await api('file?path=' + encodeURIComponent(planOpen)); text = f.text; view = `<div class="doc">${md(f.text)}</div>`; }
    catch (e) { view = `<p class="empty">${esc(e.message)}</p>`; }
    // Copy or share the file as written, so a report can go straight into a chat with a teammate
    const share = text && navigator.share ? '<button class="btn plain" id="plans-share">Share</button>' : '';
    $('#tab-files').innerHTML = `<div class="row left"><button class="btn plain" id="plans-back">All files</button><span class="grow"></span>
      ${text ? '<button class="btn plain" id="plans-sum">Summary</button><button class="btn plain" id="plans-copy">Copy</button>' : ''}${share}</div>${view}`;
    if (text) {
      $('#plans-copy').onclick = async () => toast(await copyText(text) ? 'Copied' : 'Could not copy');
      // A summary is a chat about this cartridge, so follow-up questions work
      $('#plans-sum').onclick = () => asstAsk(`Summarize ${planOpen} from this cartridge's folder in at most 8 lines: its verdict or state, the key points, `
        + 'findings by severity if it has any, and what needs me. Read the file first.');
    }
    if (share) $('#plans-share').onclick = () => navigator.share({ title: planOpen.replace(/^plans\//, ''), text }).catch(() => {});
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
  } else if (what === 'push') {
    act(() => api('pr-push', {}), 'Pushed to the pull request');
  } else if (what === 'address') {
    addressPr();
  }
}
// Reviewers' comments on the open PR go to the team as a new build round
async function addressPr() {
  toast('Reading the pull request…');
  const r = await act(() => api('address-pr', {}));
  if (r) toast(r.count ? `${r.count} comment${r.count === 1 ? '' : 's'} sent to the team` : 'No open review comments on the pull request');
}
async function gateDialog(p) {
  let content = '<p class="empty">Nothing to review yet.</p>';
  if (p.file) {
    try { const f = await api('file?path=' + encodeURIComponent(p.file)); content = `<div class="doc">${md(f.text)}</div>`; }
    catch { content = `<div class="note warn"><code>${esc(p.file)}</code> does not exist yet. Wait for the lead to report the previous phase done, then open this again.</div>`; }
  }
  const targets = p.forward ? OV.cartridges.filter(x => x.kind === 'team' && x.id !== cur && x.project === S.cart.project) : [];
  const canPr = p.pr && S.cart.branch && !S.cart.home && !safeUrl(S.cart.prUrl);
  const asks = S.questions || [];
  const askBox = asks.length ? `<div class="ask"><h3>${askLine(asks.length)}</h3>${questionList(asks)}
    <label class="lbl" for="dlg-ans">Your answers, sent to the lead when you approve</label>
    <textarea id="dlg-ans" name="answers" rows="5" placeholder="Answer by number, for example: 1. Fine as planned. 2. Skip the mainnet runs for now."></textarea></div>
    <h3 class="lbl">${esc(p.file || 'The document')}</h3>` : '';
  const postable = canPost(p);
  const res = await dialog(p.title, `${canPr || postable ? `<div class="row left">${canPr ? '<button type="button" class="btn" data-action="pr">Open a pull request</button>' : ''}
    ${postable ? `<button type="button" class="btn plain" data-action="comment">${postLabel()}</button>` : ''}</div>` : ''}${askBox}${content}
    ${targets.length ? `<label class="lbl" for="dlg-to">Send the report to a cartridge (optional)</label>
    <select id="dlg-to" name="to"><option value="">Do not send</option>${targets.map(x =>
    `<option value="${esc(x.id)}" ${S.cart.target && x.branch === S.cart.target ? 'selected' : ''}>${esc(shortTitle(x))}${x.running ? '' : ' (off)'}</option>`).join('')}</select>` : ''}
    <label class="lbl" for="dlg-fb">Feedback (needed when you ask for changes)</label>
    <textarea id="dlg-fb" name="feedback" rows="3" placeholder="For example: drop the cache layer for now. Add a migration step with a rollback."></textarea>`,
  [CANCEL,
    { label: p.rejectTo ? 'Send back' : 'Ask for changes', value: 'reject', validate: d => (d.feedback.trim() ? true : (toast('Write the feedback first', true), false)) },
    { label: 'Approve', value: 'approve', cls: 'inv' }]);
  if (res.action === 'approve') {
    await act(() => api('phase', { phase: p.id, action: 'approve', answers: res.data.answers || '' }), res.data.answers && res.data.answers.trim() ? 'Answers sent, approved' : 'Approved');
    if (res.data.to) {
      const f = await act(() => call('forward', { cart: cur, to: res.data.to }));
      if (f) toast(f.sent ? `Report sent and the other lead told (${f.path})` : `Report copied to ${f.path}. That cartridge is off, so nobody was told yet.`);
    }
  }
  if (res.action === 'reject') act(() => api('phase', { phase: p.id, action: 'reject', feedback: res.data.feedback }), 'Feedback sent to the lead');
  if (res.action === 'pr') prDialog();
  if (res.action === 'comment') prCommentDialog();
}
// The review report, previewed and editable, goes to the pull request as a comment only from the Post button
async function prCommentDialog() {
  const d = await api('pr-comment-draft').catch(e => (toast(e.message, true), null));
  if (!d) return;
  const res = await dialog('Post the review to the pull request', `
    <div class="note">Posts a comment on <a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url.replace(/^https?:\/\/github\.com\//, ''))}</a> from your GitHub account. Agents cannot comment; only this button does.</div>
    ${d.written ? '' : `<div class="note warn"><code>${esc(d.file)}</code> is not written yet. You can still post a note.</div>`}
    ${d.commentedAt ? `<p class="dim">Posted before, at ${clock(d.commentedAt)}.</p>` : ''}
    <label class="lbl" for="prc-body">Comment</label><textarea id="prc-body" name="body" rows="14">${esc(d.body)}</textarea>`,
  [CANCEL, { label: 'Post', value: 'go', cls: 'inv', validate: x => (x.body.trim() ? true : (toast('Write the comment first', true), false)) }]);
  if (res.action !== 'go') return;
  const out = await act(() => api('pr-comment', { body: res.data.body }));
  if (out) toast('Posted to the pull request');
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

// A GitHub issue or pull request the user pasted: a link, or owner/repo#123
function ghRef(text) {
  const t = String(text || '').trim();
  let m = t.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/i);
  if (m) return { repo: `${m[1]}/${m[2]}`, kind: m[3].toLowerCase() === 'pull' ? 'pr' : 'issue', number: Number(m[4]) };
  m = t.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  return m ? { repo: `${m[1]}/${m[2]}`, kind: null, number: Number(m[3]) } : null;
}

// ---------- Add a cartridge ----------
// Placeholder rows while a list loads for the first time
const SKELETON = `<ul class="pick-list skeleton" aria-label="Loading">${'<li><span></span><span></span></li>'.repeat(4)}</ul>`;
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
    <div class="find-bar" id="find">
      <input type="search" id="iss-q" class="search" placeholder="Search issues, or paste a link" enterkeyhint="search" autocomplete="off">
      <div class="chips filters" id="iss-filters" aria-label="Filters"></div>
      <p class="picked" id="iss-picked" hidden></p>
    </div>
    <div id="add-issues">
      <div id="iss-list">${SKELETON}</div>
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
      <div id="rv-prs">${SKELETON}</div>
      <p class="dim">A read-only team reviews the pull request and writes a report. It never changes the code.</p>
      <details class="more-opts">
        <summary>A cartridge's branch, or a PR number</summary>
        <label class="lbl" for="rv-project">Project</label>
        <select id="rv-project" name="rvproject">${OV.projects.map(p => `<option value="${esc(p.id)}" ${p.id === project ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <div id="rv-targets"></div>
        <label class="lbl" for="rv-pr">Pull request number</label>
        <input type="text" id="rv-pr" name="pr" inputmode="numeric" placeholder="For example: 42">
      </details>
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
      <label class="opt"><input type="checkbox" name="fullauto" ${OV.pilot === 'full-auto' ? 'checked' : ''}><span>Let the team decide everything, up to a draft pull request</span></label>
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
    if (d.tab === 'review') return d.rvpick || d.target || (d.pr || '').trim() ? true : (toast('Pick a pull request or a cartridge, or type a PR number', true), false);
    if (d.tab === 'research') return d.question.trim() ? true : (toast('Write the research question', true), false);
    if (d.tab === 'home') return true;
    return picked.size ? true : (toast('Pick at least one issue', true), false);
  }

  // Issues and pull requests share the search and filters; picks survive filtering, and lists reload on filter changes
  const picked = new Map(); // "<project>#<number>" → issue
  let issues = [], prs = [], seq = 0, timer = 0, rvPick = '', prsFor = null;
  const reviewing = () => $('#add-tab').value === 'review';
  // Filters, one compact chip each, remembered per device. Issues start at "assigned to me" and pull requests at "mine"
  // (opened by me or waiting for my review): D30. Logins and labels for the pickers come from the results loaded so far.
  const ISS_DEF = { assignee: '@me', author: '', label: '', state: 'open', sort: 'updated' };
  const PR_DEF = { mine: '1', author: '', review: '', draft: '', decision: '' };
  const loadF = (k, def) => { try { const v = JSON.parse(store.get(k, '{}')); return { ...def, ...(v && typeof v === 'object' ? v : {}) }; } catch { return { ...def }; } };
  const fIss = loadF('ctu-iss-filter', ISS_DEF), fPr = loadF('ctu-pr-filter', PR_DEF);
  const saveF = () => { store.set('ctu-iss-filter', JSON.stringify(fIss)); store.set('ctu-pr-filter', JSON.stringify(fPr)); };
  const seen = { logins: new Set(), labels: new Set() };
  // Issues and pull requests reached through a pasted link stay in the lists whatever the filters say, marked "from the link"
  const linked = { issues: new Map(), prs: new Map() };
  const withLinked = (list, kind, key) => [...list.map(x => (linked[kind].has(key(x)) ? { ...x, fromLink: true } : x)),
    ...[...linked[kind].values()].filter(x => !list.some(y => key(y) === key(x)))];
  let repoIds = null;
  const fromLink = async ref => {
    if (!repoIds) repoIds = (await call('repo-ids').catch(() => ({ repos: {} }))).repos || {};
    const pid = Object.keys(repoIds).find(k => String(repoIds[k] || '').toLowerCase() === ref.repo.toLowerCase());
    if (!pid) return toast(`No project for ${ref.repo}`, true);
    const kind = ref.kind || (reviewing() ? 'pr' : 'issue');
    $('#find').classList.add('busy');
    try {
      if (kind === 'pr') {
        const { pr } = await call(`pr?project=${encodeURIComponent(pid)}&number=${ref.number}`);
        linked.prs.set(`${pid}#${pr.number}`, { ...pr, fromLink: true });
        if (!pr.cart) rvPick = `${pid}#${pr.number}`;
        prs = withLinked(prs, 'prs', x => `${x.project}#${x.number}`);
        $('#iss-q').value = '';
        if (reviewing()) renderPrs(); else addTab('review');
      } else {
        const { issue } = await call(`issue?project=${encodeURIComponent(pid)}&number=${ref.number}`);
        linked.issues.set(issKey(issue), { ...issue, fromLink: true });
        if (!issue.cart) picked.set(issKey(issue), issue);
        issues = withLinked(issues, 'issues', issKey);
        $('#iss-q').value = '';
        if (reviewing()) addTab('issues'); else { showPicked(); renderIssues(); }
      }
    } catch (e) { toast(e.message, true); }
    finally { if ($('#find')) $('#find').classList.remove('busy'); }
  };
  const proj = () => (many ? issProj : OV.projects[0].id);
  const mineOnly = () => (reviewing() ? fPr.mine === '1' : fIss.assignee === '@me');
  const prSig = () => `${proj()}|${JSON.stringify(fPr)}|${$('#iss-q').value.trim()}`;
  const chipSel = (key, value, opts, label) => `<select class="chip ${value ? 'active' : ''}" data-f="${key}" aria-label="${label}">${opts.map(([v, t]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  const chipBtn = (key, value, def, text) => `<button type="button" class="chip ${value !== def ? 'active' : ''}" data-ft="${key}">${esc(text)}</button>`;
  const withCur = (list, cur) => (cur && !list.includes(cur) ? [...list, cur] : list);
  const people = cur => withCur([...seen.logins].sort(), cur).filter(l => l !== '@me').map(l => [l, l]);
  const renderFilters = () => {
    const projChip = many ? chipSel('project', issProj === 'all' ? '' : issProj, [['', 'All projects'], ...OV.projects.map(p => [p.id, p.name])], 'Project') : '';
    $('#iss-filters').innerHTML = reviewing()
      ? chipSel('mine', fPr.mine === '1' ? '1' : '', [['1', 'Mine'], ['', 'Everyone’s']], 'Whose pull requests')
        + chipSel('author', fPr.author, [['', 'Any author'], ['@me', 'Opened by me'], ...people(fPr.author)], 'Author')
        + chipSel('review', fPr.review, [['', 'Any review'], ['me', 'Waiting for my review']], 'Review requested')
        + chipSel('draft', fPr.draft, [['', 'Draft or ready'], ['ready', 'Ready'], ['draft', 'Draft']], 'Draft')
        + chipSel('decision', fPr.decision, [['', 'Any decision'], ['approved', 'Approved'], ['changes_requested', 'Changes requested'], ['required', 'Review required'], ['none', 'No review yet']], 'Review decision')
        + projChip
      : chipSel('assignee', fIss.assignee, [['@me', 'Assigned to me'], ['', 'Any assignee'], ...people(fIss.assignee)], 'Assignee')
        + chipSel('author', fIss.author, [['', 'Any author'], ['@me', 'Opened by me'], ...people(fIss.author)], 'Author')
        + chipSel('label', fIss.label, [['', 'Any label'], ...withCur([...seen.labels].sort(), fIss.label).map(l => [l, l])], 'Label')
        + chipBtn('state', fIss.state, 'open', fIss.state === 'all' ? 'Open and closed' : 'Open')
        + chipBtn('sort', fIss.sort, 'updated', fIss.sort === 'created' ? 'Newest first' : 'Recently updated')
        + projChip;
  };
  const issKey = i => `${i.project}#${i.number}`;
  const matches = (i, t) => !t || `#${i.number} ${i.title} ${i.labels.join(' ')}`.toLowerCase().includes(t);
  const renderIssues = (res) => {
    const t = $('#iss-q').value.trim().toLowerCase();
    const all = !many || issProj === 'all';
    const withPr = issues.filter(i => i.prs && i.prs.length);
    const list = issues.filter(i => i.fromLink || (!(i.prs && i.prs.length) && matches(i, t))).sort((a, b) => !!b.fromLink - !!a.fromLink || !!a.cart - !!b.cart); // linked first, ones with a cartridge last
    const prNote = withPr.length ? `<button type="button" class="btn plain pr-note" data-addtab="review">${withPr.length === 1 ? '1 issue already has a pull request' : `${withPr.length} issues already have a pull request`}: review it</button>` : '';
    const err = res && res.error ? `<div class="note">Could not load issues from ${esc(res.error)}</div>` : '';
    if (!list.length) {
      $('#iss-list').innerHTML = err + (res && !res.ok ? '' : `<div class="empty">${t ? 'No issue matches.' : mineOnly() ? 'Nothing open without a pull request is assigned to you.' : 'No issues without a pull request match the filters.'}
        ${mineOnly() ? '<button type="button" class="btn plain" data-who-all="1">Show any assignee</button>' : ''}</div>`) + prNote;
      return;
    }
    $('#iss-list').innerHTML = err + `<ul class="pick-list">${list.map(i => {
      const meta = [i.fromLink ? 'from the link' : '', all && many ? i.projectName : '', ...i.labels].filter(Boolean);
      return `<li><label class="pick ${i.cart ? 'used' : ''}"><input type="checkbox" data-pick="${esc(issKey(i))}" ${picked.has(issKey(i)) ? 'checked' : ''} ${i.cart ? 'disabled' : ''}>
        <span><b>#${i.number}</b> ${esc(i.title)}${meta.length ? `<small>${meta.map(esc).join(', ')}</small>` : ''}</span>
        ${i.cart ? '<em>has a cartridge</em>' : ''}</label></li>`;
    }).join('')}</ul>${prNote}`;
  };
  // Review: open pull requests, opened by me or waiting for my review under Mine
  const REVIEW_STATE = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested' };
  const renderPrs = (res) => {
    const t = $('#iss-q').value.trim().toLowerCase();
    const all = !many || issProj === 'all';
    const list = prs.filter(x => x.fromLink || !t || `#${x.number} ${x.title} ${x.author} ${x.branch}`.toLowerCase().includes(t)).sort((a, b) => !!b.fromLink - !!a.fromLink || !!a.cart - !!b.cart);
    const err = res && res.error ? `<div class="note">Could not load pull requests from ${esc(res.error)}</div>` : '';
    $('#rv-prs').innerHTML = err + (list.length ? `<ul class="pick-list">${list.map(x => `<li>
      <label class="pick ${x.cart ? 'used' : ''}"><input type="radio" name="rvpick" value="${esc(x.project)}#${x.number}" ${rvPick === `${x.project}#${x.number}` ? 'checked' : ''} ${x.cart ? 'disabled' : ''}>
      <span><b>#${x.number}</b> ${esc(x.title)}<small>${[x.fromLink ? 'from the link' : '', all && many ? x.projectName : '', x.author, x.draft ? 'draft' : '', REVIEW_STATE[x.review] || ''].filter(Boolean).map(esc).join(', ')}</small></span>
      ${x.cart ? '<em>has a review</em>' : ''}</label></li>`).join('')}</ul>`
      : res && !res.ok ? '' : `<div class="empty">${t ? 'No open pull request matches.' : mineOnly() ? 'No open pull request by you or waiting for your review.' : 'No open pull request matches the filters.'}
        ${mineOnly() ? '<button type="button" class="btn plain" data-who-all="1">Show everyone’s</button>' : ''}</div>`);
  };
  const renderList = res => (reviewing() ? renderPrs(res) : renderIssues(res));
  const loadIssues = async () => {
    const my = ++seq, kind = reviewing() ? 'prs' : 'issues';
    const f = kind === 'prs' ? fPr : fIss;
    renderFilters();
    const q = $('#iss-q').value.trim();
    const sig = kind === 'prs' ? prSig() : '';
    $('#find').classList.add('busy'); // a bar runs under the search while GitHub answers; the old list dims
    if (kind === 'prs' && !prsFor) $('#rv-prs').innerHTML = SKELETON;
    const qs = Object.entries({ project: proj(), q, ...f }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const res = await call(`${kind}?${qs}`).catch(e => ({ ok: false, error: e.message, [kind]: [] }));
    if (my !== seq || !$('#iss-list')) return;
    $('#find').classList.remove('busy');
    for (const x of res[kind] || []) {
      for (const l of [x.author, ...(x.assignees || [])]) if (l) seen.logins.add(l);
      for (const l of x.labels || []) seen.labels.add(l);
    }
    renderFilters(); // the pickers now know the logins and labels this load brought in
    if (kind === 'prs') { prs = withLinked(res.prs || [], 'prs', x => `${x.project}#${x.number}`); prsFor = sig; renderPrs(res); return; }
    issues = withLinked(res.issues || [], 'issues', issKey);
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
  const showAll = e => { if (e.target.dataset.whoAll) { if (reviewing()) fPr.mine = ''; else fIss.assignee = ''; saveF(); loadIssues(); } };
  $('#iss-list').onclick = showAll;
  $('#rv-prs').onclick = showAll;
  $('#rv-prs').onchange = e => { if (e.target.name === 'rvpick') rvPick = e.target.value; };
  $('#iss-filters').onchange = e => {
    const k = e.target.dataset.f, v = e.target.value;
    if (!k) return;
    if (k === 'project') { issProj = v || 'all'; store.set('ctu-iss-proj', issProj); }
    else if (reviewing()) {
      fPr[k] = v;
      if (k === 'mine' && v) { fPr.author = ''; fPr.review = ''; } // Mine is both at once; a precise author or review replaces it
      else if ((k === 'author' || k === 'review') && v) fPr.mine = '';
    } else fIss[k] = v;
    saveF(); loadIssues();
  };
  $('#iss-filters').onclick = e => {
    const b = e.target.closest('[data-ft]');
    if (!b) return;
    if (b.dataset.ft === 'state') fIss.state = fIss.state === 'all' ? 'open' : 'all';
    if (b.dataset.ft === 'sort') fIss.sort = fIss.sort === 'created' ? 'updated' : 'created';
    saveF(); loadIssues();
  };
  // A pasted link or owner/repo#n picks that issue or pull request instead of searching for it
  $('#iss-q').oninput = () => { clearTimeout(timer); const ref = ghRef($('#iss-q').value); if (ref) return fromLink(ref); renderList(); timer = setTimeout(loadIssues, 450); };
  $('#iss-q').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); const ref = ghRef($('#iss-q').value); if (ref) fromLink(ref); else loadIssues(); } };

  let branchesFor = null;
  const loadBranches = async pid => {
    if (pid === branchesFor) return;
    branchesFor = pid;
    const br = await call('branches?project=' + encodeURIComponent(pid)).catch(() => ({ base: '', branches: [] }));
    if (branchesFor !== pid || !$('#add-base')) return;
    const opts = new Set([br.base, ...br.branches].filter(Boolean));
    $('#add-base').innerHTML = [...opts].map(b => `<option value="${esc(b)}" ${b === br.base ? 'selected' : ''}>${esc(b)}${b === br.base ? ' (default)' : ''}</option>`).join('');
  };
  const loadTargets = () => {
    const pid = $('#rv-project').value;
    const targets = OV.cartridges.filter(c => c.project === pid && c.kind === 'team' && !c.home && c.branch);
    $('#rv-targets').innerHTML = targets.length ? `<label class="lbl" for="rv-target">Review a cartridge</label>
      <select id="rv-target" name="target"><option value="">Pick one…</option>${targets.map(c => `<option value="${esc(c.id)}">${esc(c.title)} (${esc(c.branch)})</option>`).join('')}</select>`
      : '<p class="empty">No cartridge in this project has its own branch yet.</p>';
  };
  const load = () => {
    const pid = $('#add-project').value;
    store.set('ctu-project', pid);
    if (!['issues', 'review'].includes($('#add-tab').value)) loadBranches(pid);
  };
  $('#add-project').onchange = load;
  $('#rv-project').onchange = loadTargets;
  $('#add-flow-sel').onchange = () => { $('#flow-help').textContent = FLOW_HELP[$('#add-flow-sel').value]; };
  addSync = tab => {
    $('#iss-q').placeholder = tab === 'review' ? 'Search pull requests, or paste a link' : 'Search issues, or paste a link';
    if (tab === 'issues') { showPicked(); renderFilters(); renderIssues(); }
    else if (tab === 'review') { $('#iss-picked').hidden = true; renderFilters(); if (prsFor === prSig()) renderPrs(); else loadIssues(); }
    else loadBranches($('#add-project').value);
  };
  load(); loadTargets(); loadIssues();
  const res = await pending;
  if (res.action !== 'add' && res.action !== 'start') return;
  const d = res.data;
  let ep = 'cart-add', payload;
  const branchOpts = { branch: d.branch, base: d.base, fetch: !!d.fetch, flow: d.flow, start: res.action === 'start', ...(d.fullauto ? { pilot: 'full-auto' } : {}) };
  if (d.tab === 'new') payload = { project: d.project, title: d.title, body: d.body, createIssue: !!d.createIssue, ...branchOpts };
  else if (d.tab === 'review') {
    ep = 'cart-add-review';
    const [pid, n] = String(d.rvpick || '').split('#');
    payload = d.rvpick ? { project: pid, pr: n } : (d.pr || '').trim() ? { project: d.rvproject, pr: d.pr.trim() } : { project: d.rvproject, target: d.target };
  }
  else if (d.tab === 'research') { ep = 'cart-add-research'; payload = { project: d.project, question: d.question, title: d.rtitle }; }
  else if (d.tab === 'home') { ep = 'cart-add-home'; payload = { project: d.project, flow: d.flow, ...(d.fullauto ? { pilot: 'full-auto' } : {}) }; }
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
  $('#add-proj-wrap').hidden = tab === 'issues' || tab === 'review';
  $('#find').hidden = !['issues', 'review'].includes(tab);
  if (tab !== 'issues') { $('#br-name').hidden = $('#br-base').hidden = false; $('#br-many').hidden = true; }
  if (addSync) addSync(tab);
  $('#add-branch').hidden = !['issues', 'new'].includes(tab);
  $('#add-flow').hidden = !['issues', 'new', 'home'].includes(tab);
}

// ---------- Projects and settings ----------
function projectsBody(sug) {
  const ps = OV.projects;
  const theme = store.get('ctu-theme', 'auto');
  return `${location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? `<h3 class="lbl">Phone</h3>
    <div class="row left"><button type="button" class="btn" data-act="phone-link">Send the sign-in link to your phone</button></div>
    <p class="dim">With --tailscale, your own devices on the tailnet get in without a token. Otherwise open the link once and the phone stays signed in; anyone with that link can control the teams.</p>` : ''}
    <h3 class="lbl">Autopilot for new cartridges</h3>
    <div class="segmented wrap">${Object.entries(PILOT).map(([k, x]) => `<button type="button" data-pilot-default="${k}" class="${k === OV.pilot ? 'active' : ''}">${x.name}</button>`).join('')}</div>
    <p class="dim" id="pilot-help">${esc(PILOT[OV.pilot || 'hands-off'].sub)}</p>
    <h3 class="lbl">Appearance</h3>
    <div class="segmented wrap">${['auto', 'light', 'dark'].map(t => `<button type="button" data-theme-set="${t}" class="${t === theme ? 'active' : ''}">${{ auto: 'Auto', light: 'Light', dark: 'Dark' }[t]}</button>`).join('')}</div>
    <h3 class="lbl">Projects</h3>
    ${ps.length ? `<ul class="proj-list">${ps.map(p => `<li>
      <div><b>${esc(p.name)}</b><div class="dim">${esc(tilde(p.path))}</div></div>
      <div class="proj-inputs"><input type="text" data-test="${esc(p.id)}" value="${esc(p.testCommand)}" placeholder="Test command (optional), e.g. pnpm test" aria-label="Test command for ${esc(p.name)}">
        <input type="text" data-node="${esc(p.id)}" value="${esc(p.node || '')}" inputmode="decimal" placeholder="Node version via nvm (optional), e.g. 24" aria-label="Node version for ${esc(p.name)}">
        <input type="text" data-setup="${esc(p.id)}" value="${esc(p.setupCommand || '')}" placeholder="Setup for a new worktree (optional), e.g. pnpm install && pnpm build" aria-label="Setup command for ${esc(p.name)}">
        ${projectOpsInputs(p)}</div>
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
    <label class="lbl" for="pr-footer">Last line of every pull request the team opens</label>
    <input type="text" id="pr-footer" name="prFooter" value="${esc(OV.prFooter || '')}" placeholder="For example: Opened by my assistant. Review before merging.">
    <label class="lbl" for="q-timeout">Away mode: minutes a mid-step question waits for you</label>
    <input type="number" id="q-timeout" name="questionTimeoutMin" min="0" max="1440" step="1" inputmode="numeric" value="${esc(String(OV.questionTimeoutMin ?? 15))}">
    <p class="dim">After that, in hands-off and full auto, the lead is told to decide by itself and to note it under "Decided for you". 0 turns it off. Checkpoints and the merge still wait for you.</p>
    ${settingsOpsHTML()}
    <p class="dim">Removing a project only takes it off this list. Its cartridges come back when you add it again.</p>`;
}
async function projectsDialog() {
  const sug = (await call('suggest').catch(() => ({ paths: [] }))).paths;
  const res = await dialog('Projects and settings', projectsBody(sug), [{ label: 'Close', value: 'cancel', cls: 'ghost' }, { label: 'Save settings', value: 'save', cls: 'inv' }]);
  if (res.action === 'save') {
    await act(() => call('settings', { models: { strong: res.data.strong.trim(), fast: res.data.fast.trim() }, scanRoots: res.data.scanRoots.split('\n').map(s => s.trim()).filter(Boolean), prFooter: res.data.prFooter,
      questionTimeoutMin: res.data.questionTimeoutMin === '' ? 0 : Number(res.data.questionTimeoutMin), ...settingsOpsValues(res.data) }), 'Settings saved');
  }
  if (res.action === 'tidy') tidyDialog();
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
      await call('project-update', { project: b.dataset.id, testCommand: $(`[data-test="${id}"]`).value, node: $(`[data-node="${id}"]`).value, setupCommand: $(`[data-setup="${id}"]`).value,
        cleanCommand: $(`[data-clean="${id}"]`).value, env: $(`[data-env="${id}"]`).value });
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

// The output of the project's setup command in this cartridge, with a way to run it again
async function setupLogDialog() {
  let text = '';
  try { text = (await api('file?path=.claude/team-ui/setup.log')).text; } catch (e) { text = e.message; }
  const res = await dialog('Setup log', `<p class="dim">${esc((S.setup && S.setup.line) || '')}</p><pre class="log">${esc(text.slice(-20000))}</pre>`,
    [{ label: 'Close', value: 'cancel', cls: 'ghost' }, { label: 'Run setup again', value: 'again', cls: 'inv' }]);
  if (res.action === 'again') await act(() => api('setup', {}), 'Setup started');
}

// ---------- Start, Select, eject ----------
async function startDialog() {
  const st = S.start || {};
  const others = OV.cartridges.filter(x => x.running && x.id !== cur).length;
  const res = await dialog(`Power on: ${shortTitle({ ...S.cart, projectName: S.cart.projectName })}`, `
    ${others >= OV.softLimit ? `<div class="note warn">${plural(others, 'other cartridge')} running. Every cartridge is its own team, so quota use adds up. You can still start it.</div>` : ''}
    ${S.setup && S.setup.status === 'running' ? `<div class="note">Setup is still running (<code>${esc(S.setup.cmd)}</code>). Claude can start now; the first step waits until it is done.</div>` : ''}
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
    ${OV.platform === 'darwin' ? `<label class="opt"><input type="checkbox" name="caffeinate" ${st.caffeinate !== false ? 'checked' : ''}><span>Keep the Mac awake while it runs</span></label>` : ''}
    ${budgetField()}`,
  [CANCEL, { label: 'Start and run', value: 'go', cls: 'inv' }]);
  if (res.action === 'go') {
    const { resume, budgetUSD, ...opts } = res.data;
    await act(() => api('start', { opts, resume: !!resume, run: true, budgetUSD: budgetUSD === '' ? null : Number(budgetUSD) }), 'Starting…');
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
  if (r) { toast(r.archived ? 'Ejected. Notebook archived.' : 'Ejected.'); await switchCart(null); await afterEject(r); }
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
  if (b.dataset.pilotDefault) {
    const v = b.dataset.pilotDefault;
    return call('settings', { pilot: v }).then(() => {
      OV.pilot = v; $$('[data-pilot-default]').forEach(x => x.classList.toggle('active', x === b)); $('#pilot-help').textContent = PILOT[v].sub; toast(`New cartridges: ${PILOT[v].name}`);
    }).catch(e => toast(e.message, true));
  }
  if (b.dataset.themeSet) { applyTheme(b.dataset.themeSet); $$('[data-theme-set]').forEach(x => x.classList.toggle('active', x === b)); return; }
  if (b.dataset.answer) return answerFromHome(b);
  if (b.dataset.act === 'pilot') return pilotSheet();
  if (b.dataset.act === 'heal') return heal();
  if (b.dataset.chip) return chipAction(b.dataset.chip);
  if (b.dataset.xfile) return excerptDialog(b.dataset.xfile, b.dataset.xline);
  if (b.dataset.act === 'pr-check') return prCheck();
  if (b.dataset.act === 'usage') return freshUsage(true);
  if (b.dataset.act === 'pr-comment') return prCommentDialog();
  if (b.dataset.act === 'fix-sel') return digestFix(true);
  if (b.dataset.act === 'fix-all') return digestFix(false);
  if (b.dataset.act === 'open-pr') return prDialog();
  if (b.dataset.report) { planOpen = b.dataset.report; return setTab('files'); }
  if (b.dataset.act === 'address-pr') return addressPr();
  if (b.dataset.act === 'hand-over') return act(() => api('autopilot', { mode: 'full-auto' }), 'Full auto: the team decides from here, up to a draft pull request');
  if (b.dataset.act === 'phone-link') return phoneLink();
  if (b.dataset.trust) return act(() => call('trust', { cart: b.dataset.trust }), 'Folder trusted');
  if (b.dataset.cart !== undefined) return switchCart(b.dataset.cart);
  if (b.dataset.tab) return setTab(b.dataset.tab);
  if (b.dataset.seg) { filesSeg = b.dataset.seg; planOpen = null; $$('.segmented [data-seg]').forEach(x => x.classList.toggle('active', x === b)); return loadTab(true); }
  if (b.dataset.addtab) return addTab(b.dataset.addtab);
  if (b.dataset.draft) return draftIssue();
  const a = b.dataset.act;
  if (a === 'add') return addDialog();
  if (a === 'projects') return projectsDialog();
  if (a === 'setup-log') return setupLogDialog();
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
  // Keyboard open (a field has focus and the view shrank): the tab bar steps aside, and sheets sit above the keyboard
  const typing = !!document.activeElement && document.activeElement.matches('input, textarea');
  $('#app').classList.toggle('kb', innerHeight - vv.height > 150 && typing);
  document.documentElement.style.setProperty('--kb', (typing ? Math.max(0, innerHeight - vv.offsetTop - vv.height) : 0) + 'px');
}
if (window.visualViewport) { visualViewport.addEventListener('resize', fitViewport); visualViewport.addEventListener('scroll', fitViewport); fitViewport(); }
document.addEventListener('focusin', e => {
  for (const t of [60, 350]) setTimeout(fitViewport, t); // the keyboard animates in; follow it
  // Fields lower in a sheet scroll into view; the search stays put in its sticky bar
  if (e.target.matches('#dlg-body input, #dlg-body textarea') && !e.target.closest('.find-bar')) setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
});

// ---------- Loops ----------
(async function main() {
  applyTheme(store.get('ctu-theme', 'auto'));
  await refreshOverview();
  if (cur) { await refreshState(); setTab(tab); }
  setInterval(refreshOverview, 3000);
  setInterval(refreshState, 2500);
  setInterval(refreshTerm, 1200);
  setInterval(() => refreshChat(false), 2000);
  setInterval(() => { if (tab === 'team') loadTab(false); }, 5000);
})();

// ---------- Assistant: a chat that reads the workspace and proposes cards ----------
const ASST = { id: store.get('ctu-asst', '') || null, conv: null, view: 'chat', busy: false, live: null, err: null };
const asstDlg = () => $('#asst');
const ACT_VERB = { 'create-issue': 'Create the issue', 'start-work': 'Add the cartridge', 'review-pr': 'Add the review', research: 'Add the research', send: 'Send it' };
// The reply draft is a fenced block the user can copy; the rest is the answer
function splitReply(text) {
  let draft = null;
  const rest = String(text || '').replace(/```reply[^\n]*\n([\s\S]*?)```/g, (all, b) => { draft = b.trim(); return ''; });
  return { draft, rest: rest.replace(/\n{3,}/g, '\n\n').trim() };
}
function asstSetView(v) {
  ASST.view = v;
  $('#asst-chats').textContent = v === 'list' ? 'Back' : 'Chats';
  $('#asst-form').hidden = v === 'list';
  $('#asst-new').hidden = v === 'list';
}
async function asstLoad(id) {
  try { ASST.conv = await call('assistant/get?id=' + encodeURIComponent(id)); ASST.id = id; store.set('ctu-asst', id); }
  catch { ASST.id = null; ASST.conv = null; store.set('ctu-asst', null); }
}
// Tap: the newest chat. Hold, or New chat: a clean one, with a fresh Claude session
async function asstOpen(fresh) {
  const d = asstDlg();
  $('#fab-badge').hidden = true;
  if (!d.open) d.showModal();
  if (fresh) { ASST.id = null; ASST.conv = null; ASST.err = null; store.set('ctu-asst', null); }
  asstSetView('chat');
  if (ASST.id && !ASST.conv) await asstLoad(ASST.id);
  if (!ASST.id && !fresh) { try { const l = (await call('assistant/list')).conversations; if (l[0]) await asstLoad(l[0].id); } catch {} }
  asstRender();
  if (!isMobile()) $('#asst-in').focus();
}
function asstMsgHTML(m, i) {
  if (m.role === 'user') return `<div class="asst-msg u"><div class="bubble">${esc(m.text)}</div></div>`;
  if (m.role === 'note') return `<div class="asst-msg n">${esc(m.text)}</div>`;
  const { draft, rest } = splitReply(m.live ? m.text.replace(/```action[\s\S]*$/, '') : m.text);
  const copy = `<button type="button" class="btn" data-asst-copy="${i}"><svg><use href="#i-copy"/></svg>Copy</button>`;
  const cards = (m.actions || []).map((a, j) => `<button type="button" class="asst-card ${a.done ? 'done' : ''}" data-asst-act="${i}:${j}" ${a.done ? 'disabled' : ''}>
    <b>${a.done ? '✓ ' : ''}${esc(a.label)}</b><small>${esc(a.done ? a.done.note || 'Done' : a.sub || '')}</small></button>`).join('');
  return `<div class="asst-msg a${m.live ? ' live' : ''}"><div class="bubble">${md(rest || '…')}</div>
    ${draft ? `<div class="asst-reply"><div class="asst-reply-head">Reply draft${copy}</div><pre>${esc(draft)}</pre></div>` : ''}${cards}
    ${m.live ? '' : `<div class="asst-meta">${[m.model ? esc(m.model) : '', m.costUSD != null ? esc(money(m.costUSD)) : '', draft ? '' : `<button type="button" class="btn plain" data-asst-copy="${i}">Copy</button>`].filter(Boolean).join(' · ')}</div>`}</div>`;
}
async function asstRender() {
  const box = $('#asst-body');
  if (ASST.view === 'list') return asstRenderList();
  const msgs = ASST.conv ? ASST.conv.messages : [];
  $('#asst-title').textContent = (ASST.conv && ASST.conv.title) || 'Assistant';
  $('#asst-scope').textContent = ASST.conv && ASST.conv.cartTitle ? ASST.conv.cartTitle : ASST.conv ? 'Workspace' : cur ? (summary() || {}).title || 'This cartridge' : 'Workspace';
  // The chat's model, else the one picked last time; a new chat starts from that
  $('#asst-model').value = ASST.conv && ASST.conv.model != null ? ASST.conv.model || '' : store.get('ctu-asst-model', '');
  if (!msgs.length && !ASST.live) {
    // Prepared questions for the common asks; the last one only when the chat is about a cartridge
    const scoped = ASST.conv ? !!ASST.conv.cart : !!cur;
    const chips = [['needs', 'What needs me?'], ['weekly', 'Draft my weekly report'], ['pr', 'Summarize a PR'], ...(scoped ? [['here', 'Where is this cartridge?']] : [])];
    box.innerHTML = `<div class="empty-cta"><h2>Ask anything</h2><p>It reads your projects, your notes and GitHub, then answers with a reply you can paste to a teammate. Describe work and it drafts the issue. Paste an issue or pull request link to work on that one.</p>
      <div class="chips asst-chips">${chips.map(([k, t]) => `<button type="button" data-asst-chip="${k}">${t}</button>`).join('')}</div></div>`;
    return;
  }
  box.innerHTML = msgs.map(asstMsgHTML).join('') + (ASST.live ? `<div id="asst-live">${asstMsgHTML(ASST.live, -1)}</div>` : '')
    + (ASST.err ? `<div class="asst-msg a err"><div class="bubble"><div class="md"><p>${esc(ASST.err)}</p></div></div></div>` : '');
  box.scrollTop = box.scrollHeight;
}
async function asstRenderList() {
  const box = $('#asst-body');
  $('#asst-title').textContent = 'Chats';
  let list = [];
  try { list = (await call('assistant/list')).conversations; } catch (e) { toast(e.message, true); }
  box.innerHTML = list.length ? `<ul class="asst-list">${list.map(c => `<li class="${c.id === ASST.id ? 'current' : ''}">
      <button type="button" class="asst-open" data-asst-open="${esc(c.id)}"><b>${esc(c.title)}</b><small>${esc(ago(c.updatedAt))} ago · ${plural(c.messages, 'message')} · ${esc(money(c.costUSD))}</small></button>
      <button type="button" class="btn plain danger" data-asst-del="${esc(c.id)}">Delete</button></li>`).join('')}</ul>
    <div class="row"><button type="button" class="btn plain danger" data-asst-clear="1">Clear all chats</button></div>`
    : '<div class="empty-cta"><h2>No chats yet</h2><p>Go back and ask something.</p></div>';
}
let asstPaint = 0;
function asstPaintLive() {
  if (asstPaint) return;
  asstPaint = requestAnimationFrame(() => {
    asstPaint = 0;
    const el = $('#asst-live');
    if (!el || !ASST.live) return;
    el.innerHTML = asstMsgHTML(ASST.live, -1);
    const box = $('#asst-body');
    box.scrollTop = box.scrollHeight;
  });
}
// The answer streams as server-sent events on a POST, read by hand (EventSource cannot POST)
async function readSSE(body, onEvent) {
  const reader = body.getReader(), dec = new TextDecoder();
  let buf = '';
  const handle = block => {
    let type = 'message', data = '';
    for (const l of block.split('\n')) { if (l.startsWith('event:')) type = l.slice(6).trim(); else if (l.startsWith('data:')) data += l.slice(5).trim(); }
    if (data) onEvent(type, JSON.parse(data));
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) > -1) { handle(buf.slice(0, i)); buf = buf.slice(i + 2); }
  }
}
async function asstSend(text) {
  text = String(text || '').trim();
  if (!text || ASST.busy) return;
  ASST.busy = true; ASST.err = null;
  if (!ASST.conv) ASST.conv = { id: null, title: text.split('\n')[0].slice(0, 60), messages: [] };
  ASST.conv.messages.push({ role: 'user', text, at: Date.now() });
  ASST.live = { role: 'assistant', text: '', live: true };
  asstSetView('chat'); asstRender();
  const status = $('#asst-status');
  status.textContent = 'Thinking'; status.hidden = false;
  try {
    const r = await fetch('/api/assistant/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CTU': '1' },
      body: JSON.stringify({ conversation: ASST.id || undefined, text, cart: cur || undefined, model: $('#asst-model').value }) });
    if (r.status === 401) { location.reload(); return; }
    if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.statusText); }
    let done = null;
    await readSSE(r.body, (type, data) => {
      if (type === 'open') { ASST.id = data.conversation; store.set('ctu-asst', ASST.id); }
      else if (type === 'text') { ASST.live.text += data.text; asstPaintLive(); }
      else if (type === 'status') status.textContent = data.text;
      else if (type === 'done') done = data;
      else if (type === 'error') throw new Error(data.error);
    });
    if (!done) throw new Error('The connection dropped before the answer came');
    ASST.live = null;
    await asstLoad(done.conversation);
    if (!asstDlg().open) $('#fab-badge').hidden = false;
  } catch (e) { ASST.live = null; ASST.err = e.message; }
  finally { ASST.busy = false; status.hidden = true; asstRender(); }
}
// A card does something only after the user confirms it; the server runs it through the same routes as the buttons
async function asstAct(mi, ai) {
  const m = ASST.conv && ASST.conv.messages[mi];
  const a = m && m.actions && m.actions[ai];
  if (!a || a.done) return;
  if (a.type === 'open') { const u = safeUrl(a.url); if (u) window.open(u, '_blank', 'noopener'); return; }
  const preview = a.type === 'create-issue' ? `<p><b>${esc(a.title)}</b></p>${md(a.body || '')}`
    : a.type === 'send' || a.type === 'research' ? `<p>${esc(a.text || a.question)}</p>` : `<p>${esc(a.sub || '')}</p>`;
  const r = await dialog(a.label, `${preview}${a.type === 'start-work' && a.createIssue ? '<p>This also creates the issue on GitHub.</p>' : ''}`,
    [CANCEL, { label: ACT_VERB[a.type] || 'Do it', value: 'go', cls: 'primary' }]);
  if (r.action !== 'go') return;
  try {
    const out = await call('assistant/act', { conversation: ASST.id, message: mi, index: ai });
    toast(out.note || 'Done');
    await asstLoad(ASST.id); asstRender(); refreshOverview();
  } catch (e) { toast(e.message, true); }
}
// The owner/name of each project's repository, from the server (cached there), for the prepared questions
async function repoIdList() {
  try { return Object.values((await call('repo-ids')).repos || {}).filter(Boolean); } catch { return []; }
}
// A prepared question from an empty chat. The weekly report spells out the gh commands and the repositories, so the
// assistant runs those and nothing else
async function asstChip(kind) {
  if (kind === 'needs') return asstSend('Which cartridges wait for me right now, and what for? Shortest answer, one line each.');
  if (kind === 'here') return asstSend('Where does this cartridge stand: step, blockers, what needs me, next action?');
  if (kind === 'weekly') {
    const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const repos = await repoIdList();
    return asstSend(`Draft my weekly report: what I did on GitHub in the last 7 days (since ${since}) in these repositories: ${repos.join(', ') || 'the configured projects (find each repository with gh repo view in its folder)'}.\n`
      + 'Run exactly these for every repository R, nothing else:\n'
      + `- gh search prs --repo R --author @me --merged --merged-at ">=${since}" --json number,title,url --limit 50\n`
      + '- gh pr list --repo R --author @me --state open --json number,title,url,isDraft --limit 50\n'
      + `- gh search prs --repo R --reviewed-by @me --updated ">=${since}" --json number,title,url,author --limit 50\n`
      + `- gh search issues --repo R --author @me --created ">=${since}" --json number,title,url,state --limit 50\n`
      + `- gh search issues --repo R --assignee @me --closed ">=${since}" --json number,title,url --limit 50\n`
      + 'Then write the report in English, grouped by repository, with the groups Merged, Open, Reviewed, Issues opened, Issues closed: one bullet per item as "#number title"; '
      + 'leave out empty groups and repositories with nothing. The reply draft is the whole report.');
  }
  if (kind === 'pr') {
    const many = OV && OV.projects.length > 1;
    const mine = summary();
    const r = await dialog('Summarize a pull request', `<label class="lbl" for="asst-pr">Pull request link or number</label>
      <input type="text" id="asst-pr" name="pr" placeholder="https://github.com/owner/repo/pull/42, or 42" autocomplete="off">
      ${many ? `<label class="lbl" for="asst-pr-proj">Project, for a number</label><select id="asst-pr-proj" name="project">${OV.projects.map(p => `<option value="${esc(p.id)}" ${mine && mine.project === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}`,
    [CANCEL, { label: 'Ask', value: 'go', cls: 'inv', validate: d => (d.pr.trim() ? true : (toast('Give a link or a number', true), false)) }]);
    if (r.action !== 'go') return;
    let ref = r.data.pr.trim();
    if (/^#?\d+$/.test(ref)) { // a bare number: the project's repository turns it into a link
      const pid = r.data.project || ((OV && OV.projects[0]) || {}).id;
      const repos = (await call('repo-ids').catch(() => ({ repos: {} }))).repos || {};
      ref = repos[pid] ? `https://github.com/${repos[pid]}/pull/${ref.replace('#', '')}` : `#${ref.replace('#', '')} of project ${pid}`;
    }
    return asstSend(`Summarize PR ${ref}: what it changes, risks, review state, and whether it needs me. `
      + `Use gh pr view ${ref} --json title,body,author,state,isDraft,reviewDecision,additions,deletions,files and gh pr diff ${ref} (skim it, do not paste it).`);
  }
}
// The clipboard API needs a secure page; over plain http (a phone on the LAN) the old command still works
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  const ta = document.createElement('textarea');
  ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  (asstDlg().open ? asstDlg() : document.body).appendChild(ta); ta.focus(); ta.select(); // a closed dialog is not rendered
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}
{
  // Tap opens the newest chat, hold opens a new one, and a drag moves the button out of the way of what it covers.
  // The place is kept per device as offsets from the right and bottom edges, so it stays clear of the dock.
  const fab = $('#fab-asst');
  let hold = 0, held = false, drag = null;
  const edge = v => Math.max(8, Math.min(innerWidth - 64, innerHeight - 64, v));
  const place = () => {
    const m = /^(\d+),(\d+)$/.exec(store.get('ctu-fab', ''));
    if (m) { fab.style.right = edge(Number(m[1])) + 'px'; fab.style.bottom = edge(Number(m[2])) + 'px'; }
  };
  place();
  addEventListener('resize', place);
  fab.addEventListener('pointerdown', e => {
    held = false; clearTimeout(hold);
    const cs = getComputedStyle(fab);
    drag = { x: e.clientX, y: e.clientY, r: parseFloat(cs.right), b: parseFloat(cs.bottom), moved: false };
    try { fab.setPointerCapture(e.pointerId); } catch {}
    hold = setTimeout(() => { if (!drag || !drag.moved) { held = true; asstOpen(true); } }, 500);
  });
  fab.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 8) return;
    drag.moved = true; clearTimeout(hold);
    fab.style.right = edge(drag.r - dx) + 'px';
    fab.style.bottom = edge(drag.b - dy) + 'px';
  });
  const end = () => {
    clearTimeout(hold);
    if (drag && drag.moved) { held = true; store.set('ctu-fab', `${Math.round(parseFloat(fab.style.right))},${Math.round(parseFloat(fab.style.bottom))}`); }
    drag = null;
  };
  for (const ev of ['pointerup', 'pointercancel']) fab.addEventListener(ev, end);
  fab.addEventListener('click', () => { if (held) { held = false; return; } asstOpen(false); });
  fab.addEventListener('contextmenu', e => e.preventDefault());
}
$('#asst-close').onclick = () => asstDlg().close();
$('#asst-new').onclick = () => asstOpen(true);
// A new chat, scoped to the open cartridge when there is one, that starts with this question
async function asstAsk(q) { await asstOpen(true); await asstSend(q); }
$('#asst-model').onchange = e => { store.set('ctu-asst-model', e.target.value); if (ASST.conv) ASST.conv.model = e.target.value || null; };
$('#asst-chats').onclick = () => { asstSetView(ASST.view === 'list' ? 'chat' : 'list'); asstRender(); };
$('#asst-form').onsubmit = e => { e.preventDefault(); const t = $('#asst-in'); const v = t.value; t.value = ''; t.style.height = ''; asstSend(v); };
// Enter sends on a keyboard; on a phone the Send button does, so Enter can start a new line
$('#asst-in').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && (!isMobile() || e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#asst-form').requestSubmit(); } });
$('#asst-in').addEventListener('input', e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px'; });
asstDlg().addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.asstAct) { const [mi, ai] = b.dataset.asstAct.split(':').map(Number); return asstAct(mi, ai); }
  if (b.dataset.asstChip) return asstChip(b.dataset.asstChip);
  if (b.dataset.asstCopy !== undefined) {
    const m = ASST.conv && ASST.conv.messages[Number(b.dataset.asstCopy)];
    if (!m) return;
    const { draft } = splitReply(m.text);
    const ok = await copyText(draft || m.text);
    return toast(ok ? (draft ? 'Reply draft copied' : 'Copied') : 'Could not copy here', !ok);
  }
  if (b.dataset.asstOpen) { await asstLoad(b.dataset.asstOpen); asstSetView('chat'); return asstRender(); }
  if (b.dataset.asstDel) {
    const r = await dialog('Delete this chat?', '<p>Its messages go. Issues and cartridges it created stay.</p>', [CANCEL, { label: 'Delete', value: 'go', cls: 'danger' }]);
    if (r.action !== 'go') return;
    try { await call('assistant/delete', { id: b.dataset.asstDel }); if (ASST.id === b.dataset.asstDel) { ASST.id = null; ASST.conv = null; store.set('ctu-asst', null); } }
    catch (err) { toast(err.message, true); }
    return asstRender();
  }
  if (b.dataset.asstClear) {
    const r = await dialog('Delete all chats?', '<p>Every chat goes. Issues and cartridges they created stay.</p>', [CANCEL, { label: 'Delete all', value: 'go', cls: 'danger' }]);
    if (r.action !== 'go') return;
    try { await call('assistant/clear', {}); ASST.id = null; ASST.conv = null; store.set('ctu-asst', null); } catch (err) { toast(err.message, true); }
    return asstRender();
  }
});

// ---------- Chat: the lead's conversation as bubbles, with quick replies ----------
// Turns come from the lead's transcript (read only), from a cursor the server hands back; nothing is scraped off the screen
const CHAT = { cart: null, file: null, cursor: 0, turns: [], busy: false, pending: [], tick: 0, drawn: '' };
const TURN_LIMIT = 400;
const normKey = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 80);
function chatReset() { Object.assign(CHAT, { cart: cur, file: null, cursor: 0, turns: [], pending: [], drawn: '' }); $('#chat-body').innerHTML = ''; }
async function refreshChat(force) {
  if (!cur || !S || tab !== 'chat' || CHAT.busy) return;
  if (CHAT.cart !== cur) chatReset();
  // Every 2 s while the lead works, every 6 s while it sits idle
  if (!force && !(S.live && S.live.status) && (CHAT.tick++ % 3)) return;
  CHAT.busy = true;
  try {
    const r = await api(`chat?file=${encodeURIComponent(CHAT.file || '')}&since=${CHAT.cursor}`);
    if (r.reset || (CHAT.file && r.file && r.file !== CHAT.file)) { CHAT.turns = []; CHAT.pending = []; }
    CHAT.file = r.file; CHAT.cursor = r.cursor;
    if (r.turns.length) {
      for (const t of r.turns) if (t.role === 'user') CHAT.pending = CHAT.pending.filter(p => normKey(p.text) !== normKey(t.text));
      CHAT.turns = [...CHAT.turns, ...r.turns].slice(-TURN_LIMIT);
    }
    renderChat(force);
  } catch {} finally { CHAT.busy = false; }
}
function turnHTML(t) {
  const when = t.t ? `<div class="asst-meta">${esc(clock(t.t))}</div>` : '';
  if (t.role === 'user') return `<div class="asst-msg u ${t.pending ? 'pending' : ''}"><div class="bubble">${esc(t.text)}</div>${when}</div>`;
  if (t.role === 'assistant') return `<div class="asst-msg a"><div class="bubble">${md(t.text)}</div>${when}</div>`;
  if (t.role === 'tools') return `<div class="asst-msg n tools">${esc(t.text)}</div>`;
  if (t.role === 'step') return `<details class="chat-step"><summary>Step: ${esc(t.title || '')}<small>${t.t ? esc(clock(t.t)) : ''}</small></summary><pre>${esc(t.text)}</pre></details>`;
  if (t.role === 'console') return `<details class="chat-step console"><summary>Console: ${esc(t.title || '')}<small>${t.t ? esc(clock(t.t)) : ''}</small></summary><pre>${esc(t.text)}</pre></details>`;
  if (t.role === 'teammate') return `<div class="asst-msg n mate"><b>${esc(t.from)}</b>${t.summary ? ': ' + esc(t.summary) : ''}${t.text && t.text !== t.summary ? `<details><summary>Message</summary><pre>${esc(t.text)}</pre></details>` : ''}</div>`;
  return '';
}
function renderChat(force) {
  const box = $('#chat-body');
  const turns = [...CHAT.turns, ...CHAT.pending.map(p => ({ role: 'user', text: p.text, t: p.t, pending: true }))];
  const html = turns.length ? turns.map(turnHTML).join('')
    : `<div class="empty-cta"><h2>${S && S.running ? 'Nothing said yet' : 'This cartridge is off'}</h2><p>${S && S.running ? 'The lead\'s replies, the steps the console sends and your own messages show here.' : 'Start it to talk to the lead. Earlier conversations show here once there are any.'}</p></div>`;
  if (html === CHAT.drawn && !force) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = html; CHAT.drawn = html;
  if (force || atBottom) box.scrollTop = box.scrollHeight;
}
// The waiting-agent card and the quick replies, from the cartridge state
function renderChatChrome() {
  if (!cur || !S) return;
  const ask = $('#chat-ask');
  const p = S.running ? S.panes.find(x => x.attention) : null;
  const a = p && ATTN_TEXT[p.attention];
  ask.hidden = !a;
  if (a) ask.innerHTML = `<span>${esc(a[0](p.isLead ? 'The lead' : p.label))}</span><span class="acts">${a[1].map(([t, k, cls]) => (k === 'trust'
    ? `<button class="btn ${cls || ''}" data-act="trust">${t}</button>` : `<button class="btn ${cls || ''}" data-key="${k}" data-pane="${esc(p.id)}">${t}</button>`)).join('')}</span>`;
  const chips = chatChips();
  const el = $('#chat-chips');
  el.hidden = !chips.length;
  $('#app').classList.toggle('chipped', chips.length > 0); // the assistant button clears the chips row too
  el.innerHTML = chips.map(c => `<button type="button" class="${c.hot ? 'hot' : ''}" data-chip="${esc(c.id)}">${esc(c.label)}</button>`).join('');
  $('#chat-in').disabled = !S.running;
  $('#chat-in').placeholder = S.running ? 'Message the lead' : 'Start the cartridge to message the lead';
}
function chatChips() {
  if (!S || !S.running) return [];
  const out = [];
  const gate = S.phases.find(p => p.kind === 'gate' && p.status === 'ready');
  const d = S.digest;
  const waiting = (S.lead && S.lead.status === 'waiting') || S.panes.some(p => p.isLead && p.attention === 'question');
  if (waiting) out.push({ id: 'go', label: 'Go with your recommendation', hot: true }, { id: 'skip', label: 'Skip it for now' });
  if (S.pr && S.pr.new) out.push({ id: 'address', label: `Address ${plural(S.pr.new, 'new PR comment')}`, hot: true });
  if (gate && gate.pr) {
    out.push({ id: 'fix-all', label: 'Fix all critical and major' });
    if (safeUrl(S.cart.prUrl)) out.push({ id: 'push', label: 'Push fixes to the PR' });
    out.push({ id: 'review-again', label: 'Run the review again' });
    ((d && d.top) || []).slice(0, 3).forEach((f, i) => out.push({ id: `explain:${i}`, label: `Explain finding ${i + 1}` }));
  }
  if (safeUrl(S.cart.prUrl)) out.push({ id: 'pr-check', label: 'Check PR comments' });
  return out;
}
async function chipAction(id) {
  if (!S) return;
  const gate = S.phases.find(p => p.kind === 'gate' && p.status === 'ready');
  if (id === 'go') return chatSend('Go with your recommendation. Write the decision under "Decided for you" in plans/summary.md and carry on.');
  if (id === 'skip') return chatSend('Skip it for now and carry on. List it under Questions in plans/summary.md so I can come back to it.');
  if (id === 'fix-all') return gate && act(() => api('phase', { phase: gate.id, action: 'reject', feedback: '' }), 'Sent back to Build');
  if (id === 'push') return act(() => api('pr-push', {}), 'Pushed to the pull request');
  if (id === 'review-again') {
    const rv = [...S.phases].reverse().find(p => p.kind === 'agent' && p.rejectTo);
    if (!rv) return;
    const ok = await act(() => api('phase', { phase: rv.id, action: 'reopen' }));
    if (ok) await act(() => api('phase', { phase: rv.id, action: 'run' }), 'Review sent to the lead');
    return;
  }
  if (id.startsWith('explain:')) {
    const i = Number(id.split(':')[1]);
    const f = S.digest && S.digest.top[i];
    if (!f) return;
    return chatSend(`Explain finding ${i + 1} of your summary: ${f.file ? f.file + (f.line ? ':' + f.line : '') + ' — ' : ''}${f.text}. What is the risk, and what is the smallest fix?`);
  }
  if (id === 'address') return addressPr();
  if (id === 'pr-check') return prCheck();
}
async function chatSend(text) {
  text = String(text || '').trim();
  if (!text || !cur) return;
  const ok = await act(() => api('send', { text }));
  if (!ok) return;
  CHAT.pending.push({ text, t: Date.now() });
  renderChat(true);
  setTimeout(() => refreshChat(true), 800);
}
$('#chat-form').onsubmit = e => { e.preventDefault(); const m = $('#chat-in'); const t = m.value; m.value = ''; m.style.height = ''; chatSend(t); };
$('#chat-in').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && (!isMobile() || e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#chat-form').requestSubmit(); } });
$('#chat-in').addEventListener('input', e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px'; });

// ---------- Digest: the last step's summary, loud at a checkpoint ----------
const verdictCls = v => (/READY/.test(v) ? 'ready' : /NEEDS WORK/.test(v) ? 'work' : /DO NOT|BLOCKED/.test(v) ? 'stop' : '');
function countsText(c) {
  if (!c) return '';
  return [c.critical && `${c.critical} critical`, c.major && `${c.major} major`, c.minor && `${c.minor} minor`].filter(Boolean).join(', ');
}
const verdictText = d => `${d.verdict}${countsText(d.counts) ? ' · ' + countsText(d.counts) : ''}`;
const DIG = { ticked: new Set(), drawn: '' };
function renderDigest() {
  const box = $('#digest');
  const d = S && S.digest;
  const gate = S && S.phases.find(p => p.kind === 'gate' && p.status === 'ready');
  const done = S && S.phases.length && S.phases.every(p => p.status === 'done');
  if (!d || !(gate || done)) { box.hidden = true; if (DIG.drawn) { box.innerHTML = ''; DIG.drawn = ''; } return; }
  const pr = gate && gate.pr;
  const hasPr = safeUrl(S.cart.prUrl);
  const findings = (d.top || []).map((f, i) => `<li>${pr ? `<input type="checkbox" data-find="${i}" ${DIG.ticked.has(i) ? 'checked' : ''} aria-label="Fix this finding">` : ''}
      <span>${f.file ? `<button type="button" class="loc" data-xfile="${esc(f.file)}" data-xline="${f.line || 1}">${esc(f.file)}${f.line ? ':' + f.line : ''}</button>` : ''}${esc(f.text)}</span></li>`).join('');
  const list = items => `<ol class="list">${items.map(q => `<li>${esc(q.text)}</li>`).join('')}</ol>`;
  const meta = [countsText(d.counts), d.acceptance && `acceptance ${d.acceptance}`, d.tests && `tests ${d.tests}`, d.changed && `changed ${d.changed}`].filter(Boolean);
  const body = d.source === 'fallback'
    ? `<p class="dim">${d.section ? `${esc(d.section)}, from` : 'No summary in'} <code>${esc(d.file || 'the report')}</code>${d.section ? '' : '; its first lines'}</p>
       <div class="digest-doc">${md((d.lines || []).join('\n'))}</div>
       <div class="row left"><button type="button" class="btn plain" data-report="${esc(d.file || '')}">Read the whole file</button></div>`
    : `${meta.length ? `<div class="counts">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</div>` : ''}
       ${findings ? `<h3>${pr ? 'Findings: tick what to fix' : 'What matters most'}</h3><ol class="findings">${findings}</ol>` : ''}
       ${d.questions.length ? `<h3>Questions for you</h3>${list(d.questions)}` : ''}
       ${d.decided.length ? `<h3>Decided for you</h3>${list(d.decided)}` : ''}
       ${d.next ? `<p class="next-line"><b>Next:</b> ${esc(d.next)}</p>` : ''}`;
  const actions = pr ? `<div class="actions">
      ${findings ? `<button type="button" class="btn primary" data-act="fix-sel" ${DIG.ticked.size ? '' : 'disabled'}>Fix selected</button>` : ''}
      <button type="button" class="btn ${findings ? '' : 'primary'}" data-act="fix-all">Fix all critical and major</button>
      ${hasPr ? '<button type="button" class="btn plain" data-chip="push">Push to the PR</button>' : S.cart.branch && !S.cart.home ? '<button type="button" class="btn plain" data-act="open-pr">Ignore minor, open the PR</button>' : ''}</div>`
    : done && hasPr ? '<div class="actions"><button type="button" class="btn" data-act="pr-check">Check PR comments</button></div>' : '';
  const html = `<div class="kicker">${esc(d.forTitle || d.step || 'Summary')} · summary${d.at ? ' · ' + esc(d.at) : ''}</div>
    <h2 class="${verdictCls(d.verdict || '')}">${esc(d.verdict || (d.source === 'fallback' ? 'Report' : 'Summary'))}</h2>${body}${actions}`;
  if (html === DIG.drawn) return;
  box.innerHTML = html; DIG.drawn = html; box.hidden = false;
}
$('#digest').addEventListener('change', e => {
  const i = e.target.dataset && e.target.dataset.find;
  if (i == null) return;
  if (e.target.checked) DIG.ticked.add(Number(i)); else DIG.ticked.delete(Number(i));
  const b = $('#digest [data-act="fix-sel"]');
  if (b) b.disabled = !DIG.ticked.size;
});
// Send the work back to Build with the ticked findings as the notes, or with none (the review file lists them all)
async function digestFix(selected) {
  const gate = S && S.phases.find(p => p.kind === 'gate' && p.status === 'ready' && p.pr);
  const d = S && S.digest;
  if (!gate || !d) return;
  let fb = '';
  if (selected) {
    const picked = [...DIG.ticked].sort().map(i => d.top[i]).filter(Boolean);
    if (!picked.length) return toast('Tick the findings to fix first', true);
    fb = 'Fix these findings first, in this order:\n' + picked.map((f, n) => `${n + 1}. ${f.file ? f.file + (f.line ? ':' + f.line : '') + ' — ' : ''}${f.text}`).join('\n');
  }
  const ok = await act(() => api('phase', { phase: gate.id, action: 'reject', feedback: fb }), 'Sent back to Build');
  if (ok) { DIG.ticked.clear(); setTab('chat'); }
}
// ±20 lines around a finding, from HEAD of the cartridge
async function excerptDialog(file, line) {
  const x = await api(`excerpt?file=${encodeURIComponent(file)}&line=${encodeURIComponent(line || 1)}`).catch(e => (toast(e.message, true), null));
  if (!x) return;
  const rows = x.text.split('\n').map((l, i) => `<span data-n="${x.from + i}" class="${x.from + i === x.line ? 'hit' : ''}">${esc(l) || ' '}</span>`).join('');
  await dialog(`${x.file}:${x.line}`, `<pre class="code">${rows}</pre>`, [{ label: 'Close', value: 'cancel', cls: 'ghost' }]);
}
// PR comments are read when asked, never on a timer
async function prCheck() {
  const r = await act(() => api('pr-check', {}));
  if (!r) return;
  toast(r.new ? `${plural(r.new, 'new PR comment')}${r.decision ? ', review ' + r.decision.toLowerCase().replace(/_/g, ' ') : ''}` : 'No new PR comments');
  await refreshState();
}
const awayLabel = () => (!S ? '' : S.questionTimeoutMin == null ? `default (${S.questionTimeoutDefault ? S.questionTimeoutDefault + ' min' : 'off'})` : S.questionTimeoutMin ? `${S.questionTimeoutMin} min` : 'off');
async function awayDialog() {
  const res = await dialog('Away mode', `
    <p class="dim">When the lead asks you something in the middle of a step and you do not answer within this time, it is told to decide by itself
      and to note the choice under "Decided for you" in its summary. Only in hands-off and full auto; checkpoints and the merge always wait for you.</p>
    <label class="lbl" for="away-min">Minutes for this cartridge (empty = the setting for all, now ${esc(S.questionTimeoutDefault ? S.questionTimeoutDefault + ' min' : 'off')}; 0 = off)</label>
    <input type="number" id="away-min" name="min" min="0" max="1440" step="1" inputmode="numeric" value="${S.questionTimeoutMin == null ? '' : esc(String(S.questionTimeoutMin))}">`,
  [CANCEL, { label: 'Save', value: 'ok', cls: 'inv' }]);
  if (res.action === 'ok') act(() => api('question-timeout', { min: res.data.min === '' ? null : Number(res.data.min) }), 'Away mode saved');
}

// ---------- Housekeeping: memory, tidy up, idle power-off and budgets ----------
const bytes = b => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} kB` : `${Math.round(b || 0)} B`);
const idleFor = min => (min >= 60 ? `${Math.round(min / 6) / 10} h` : `${Math.round(min)} min`);
const COST_NOTE = 'Cost is Claude Code\'s API-equivalent figure; on a subscription it counts against your quota, not a bill.';
// Home, under the usage rings: memory taken by Claude processes, and what Tidy up could free
function opsHomeHTML() {
  const r = OV && OV.ram, t = OV && OV.tidy;
  const hot = r && r.totalBytes && (100 * r.bytes) / r.totalBytes > (OV.ramWarnPct || 70);
  const ram = r && r.at ? `<p class="ram ${hot ? 'hot' : ''}" title="Resident memory of every claude process on this Mac, sampled every 30 s">${esc(`${r.count} Claude process${r.count === 1 ? '' : 'es'}`)} · ${esc(bytes(r.bytes))}${hot ? ` of ${esc(bytes(r.totalBytes))}` : ''}</p>` : '';
  const tidy = t && t.freeable > 0 ? `<button class="btn tidy-btn" data-ops="tidy">Tidy up · ${esc(bytes(t.freeable))}</button>` : '';
  return ram || tidy ? `<div class="ops-home">${ram}${tidy}</div>` : '';
}
// The ticket's state line when autopilot paused, the cartridge powered off while idle, or it hibernates
function opsState(c) {
  if (c.paused) return `Paused before ${c.paused.title}: ${c.paused.reason}`;
  if (!c.running && c.autoOff) return `Powered off after ${idleFor(c.autoOff.idleMin || 0)} idle`;
  if (!c.running && c.hibernated) return `Hibernated, ${bytes(Math.max(0, (c.hibernated.before || 0) - (c.hibernated.after || 0)))} freed. Start installs again`;
  return '';
}
function opsTicketActions(c) {
  const id = esc(c.id);
  if (c.paused) {
    return `<div class="t-answer">${c.running ? `<button class="btn primary" data-ops="run-anyway" data-cid="${id}">Run anyway</button>` : ''}
      <button class="btn" data-ops="budget" data-cid="${id}">${c.paused.kind === 'budget' ? 'Raise budget' : 'Budget'}</button></div>`;
  }
  if (c.idleAgents) return `<div class="t-answer"><button class="btn" data-ops="dismiss" data-cid="${id}">Dismiss ${esc(plural(c.idleAgents, 'idle agent'))}</button></div>`;
  return '';
}
// The Flow tab, under the next step: a pause with its two ways on, idle teammates, why the cartridge is off
function renderOps() {
  const box = $('#ops-note');
  if (!box || !S) return;
  const parts = [];
  if (S.paused) {
    parts.push(`<div class="note warn ops-paused"><b>Autopilot paused before ${esc(S.paused.title)}:</b> ${esc(S.paused.reason)}.
      It waits here; your own Run always works.${S.paused.kind === 'budget' ? ' ' + esc(COST_NOTE) : ''}
      <div class="actions">${S.running ? '<button class="btn primary" data-ops="run-anyway">Run anyway</button>' : ''}
      <button class="btn" data-ops="budget">${S.paused.kind === 'budget' ? 'Raise budget' : 'Budget'}</button></div></div>`);
  }
  if (S.running && S.idleAgents) {
    parts.push(`<div class="note ops-line"><span>${esc(plural(S.idleAgents, 'idle agent'))} since the last step ended.</span>
      <button class="btn" data-ops="dismiss">Dismiss</button></div>`);
  }
  if (!S.running && S.autoOff) parts.push(`<div class="note">Powered off after ${esc(idleFor(S.autoOff.idleMin || 0))} idle. Start continues the conversation.</div>`);
  if (!S.running && S.hibernated) {
    parts.push(`<div class="note">Hibernated: ${esc(bytes(S.hibernated.before))} → ${esc(bytes(S.hibernated.after))}. Start runs the setup command first, then the team.</div>`);
  }
  const html = parts.join('');
  box.hidden = !html;
  if (box.innerHTML !== html) box.innerHTML = html;
}
const budgetLabel = () => (!S ? '' : S.budgetUSD == null ? `default (${S.budgetDefault ? money(S.budgetDefault) : 'none'})` : S.budgetUSD ? money(S.budgetUSD) : 'none');
function budgetField() {
  return `${S.paused ? `<div class="note warn">Autopilot paused before ${esc(S.paused.title)}: ${esc(S.paused.reason)}. Start and run runs it anyway.</div>` : ''}
    <label class="lbl" for="o-budget">Budget in dollars (empty = the setting for all, now ${esc(S.budgetDefault ? money(S.budgetDefault) : 'none')}; 0 = none)</label>
    <input type="number" id="o-budget" name="budgetUSD" min="0" step="0.5" inputmode="decimal" value="${S.budgetUSD == null ? '' : esc(String(S.budgetUSD))}">
    <p class="dim">Autopilot pauses before the next step once the cost passes it. ${esc(COST_NOTE)}</p>`;
}
// The budget of a cartridge, from its own view or from its ticket on home
async function budgetDialog(id) {
  const st = id === cur && S ? S : await call(`state?cart=${encodeURIComponent(id)}`).catch(e => (toast(e.message, true), null));
  if (!st) return;
  const cost = st.costUSD || 0, eff = st.budgetUSD == null ? st.budgetDefault : st.budgetUSD;
  const suggest = st.paused && st.paused.kind === 'budget' ? Math.ceil(cost + (eff || 0)) : st.budgetUSD;
  const res = await dialog('Budget', `<p class="dim">${cost ? `${esc(money(cost))} used so far. ` : ''}${st.paused ? `Paused before ${esc(st.paused.title)}: ${esc(st.paused.reason)}. ` : ''}
      Autopilot pauses before the next step once the cost passes the budget. ${esc(COST_NOTE)}</p>
    <label class="lbl" for="b-usd">Dollars for this cartridge (empty = the setting for all, now ${esc(st.budgetDefault ? money(st.budgetDefault) : 'none')}; 0 = none)</label>
    <input type="number" id="b-usd" name="usd" min="0" step="0.5" inputmode="decimal" value="${suggest == null ? '' : esc(String(suggest))}">`,
  [CANCEL, { label: 'Save', value: 'ok', cls: 'inv' }]);
  if (res.action !== 'ok') return;
  const r = await act(() => call('budget', { cart: id, budgetUSD: res.data.usd === '' ? null : Number(res.data.usd) }));
  if (r) toast(r.budgetUSD == null ? 'Budget: the setting for all' : r.budgetUSD ? `Budget: ${money(r.budgetUSD)}` : 'No budget');
}
async function runAnyway(id) {
  const r = await act(() => call('run-anyway', { cart: id }));
  if (r) toast(r.budgetUSD != null ? `Running. Budget now ${money(r.budgetUSD)}` : 'Running');
}
async function dismissIdle(id) {
  const r = await act(() => call('dismiss', { cart: id }));
  if (r) toast('Asked the lead to shut its idle teammates down');
}

// Settings: per-project clean-up command and variables; power, memory, budget and the storage line
function projectOpsInputs(p) {
  const env = Object.entries(p.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  return `<input type="text" data-clean="${esc(p.id)}" value="${esc(p.cleanCommand || '')}" placeholder="Clean-up when hibernating (optional; default drops node_modules, .turbo, dist, .next)" aria-label="Clean-up command for ${esc(p.name)}">
    <textarea data-env="${esc(p.id)}" rows="2" placeholder="Environment variables (optional), KEY=VALUE per line" aria-label="Environment variables for ${esc(p.name)}" spellcheck="false" autocapitalize="off">${esc(env)}</textarea>`;
}
function storageText() {
  const t = OV && OV.tidy;
  if (!t) return 'Measuring the folders…';
  return `Cartridges ${bytes(t.cartridges)} · notebook archives ${bytes(t.archives)} · Claude Code's own transcripts (~/.claude/projects) ${bytes(t.claudeProjects)}. `
    + 'Claude Code removes old transcripts itself after cleanupPeriodDays (default 30); the console never deletes there.';
}
function settingsOpsHTML() {
  const num = (id, name, label, v, min, max, step, help) => `<label class="lbl" for="${id}">${label}</label>
    <input type="number" id="${id}" name="${name}" min="${min}" max="${max}" step="${step}" inputmode="decimal" value="${esc(String(v ?? ''))}">${help ? `<p class="dim">${help}</p>` : ''}`;
  const t = OV && OV.tidy;
  return `<h3 class="lbl">Idle, memory and cost</h3>
    ${num('s-idle', 'idlePowerOffMin', 'Power off a cartridge that only waits for you, after minutes', OV.idlePowerOffMin, 0, 1440, 1,
      'Never while a step runs. Start continues the conversation. 0 turns it off.')}
    ${num('s-hib', 'hibernateDays', 'Offer to hibernate a cartridge powered off for days', OV.hibernateDays, 0, 3650, 1,
      'Tidy up then drops its installed packages and build output; Start installs again. 0 turns it off.')}
    ${num('s-ram', 'ramWarnPct', 'Memory line turns red above this share of the Mac\'s memory, %', OV.ramWarnPct, 10, 100, 1, '')}
    ${num('s-budget', 'defaultBudgetUSD', 'Budget per cartridge, dollars (0 = none)', OV.defaultBudgetUSD, 0, 100000, 0.5, '')}
    ${num('s-quota', 'quotaPausePct', 'Pause autopilot when 5-hour or 7-day usage reaches, %', OV.quotaPausePct, 0, 100, 1,
      `Autopilot waits before the next step; your own Run always works. ${esc(COST_NOTE)} 0 turns the quota pause off.`)}
    <h3 class="lbl">Storage</h3>
    <p class="dim">${esc(storageText())}</p>
    <div class="row left"><button type="button" class="btn" data-action="tidy">Tidy up${t && t.freeable > 0 ? ` · ${esc(bytes(t.freeable))}` : ''}</button></div>`;
}
function settingsOpsValues(d) {
  const n = v => (v === '' || v == null ? undefined : Number(v));
  return { idlePowerOffMin: n(d.idlePowerOffMin), hibernateDays: n(d.hibernateDays), ramWarnPct: n(d.ramWarnPct), defaultBudgetUSD: n(d.defaultBudgetUSD), quotaPausePct: n(d.quotaPausePct) };
}

// Tidy up: every action the report allows, grouped, safe ones ticked; Clean now confirms the list, then runs it
const relName = p => String(p || '').split('/').slice(-1)[0];
function tidyItems(t) {
  const groups = [];
  const add = (title, items) => { if (items.length) groups.push({ title, items }); };
  add('Finished cartridges', t.carts.filter(c => c.finished).map(c => ({
    label: `Eject ${c.title}`, sub: `${c.projectName} · ${c.finished}${c.freeBytes ? ` · frees ${bytes(c.freeBytes)}` : ''}. The branch stays; uncommitted changes block it.`,
    on: true, action: { type: 'eject', cart: c.id }, freed: c.freeBytes,
  })));
  add(`Idle for ${t.hibernateDays} days or more`, t.carts.filter(c => c.hibernate && !c.finished).map(c => ({
    label: `Hibernate ${c.title}`, sub: `${c.projectName} · ${bytes(c.bytes)} now, about ${bytes(Math.max(0, c.bytes - c.cleanBytes))} after. Start installs again.`,
    on: true, action: { type: 'hibernate', cart: c.id }, freed: c.cleanBytes,
  })));
  const left = [];
  for (const p of t.projects || []) {
    if (p.prunable) left.push({ label: `Prune ${plural(p.prunable, 'stale worktree record')}`, sub: `${p.name} · git worktree prune`, on: true, action: { type: 'prune', project: p.id } });
    for (const o of p.orphans) {
      left.push(o.kind === 'research'
        ? { label: `Delete research folder ${relName(o.path)}`, sub: `${p.name} · ${bytes(o.bytes)} · kept by an eject, holds its report`, on: false, action: { type: 'orphan', project: p.id, path: o.path }, freed: o.bytes }
        : { label: `Delete worktree ${relName(o.path)}`, sub: `${p.name} · ${bytes(o.bytes)} · no cartridge${o.dirty ? ' · has uncommitted changes, left alone' : ''}`, on: !o.dirty, off: o.dirty, action: { type: 'orphan', project: p.id, path: o.path }, freed: o.bytes });
    }
    for (const l of p.logs || []) left.push({ label: 'Delete the old setup log', sub: `${p.name} · ${bytes(l.bytes)} · its main-checkout cartridge is gone`, on: true, action: { type: 'setup-log', project: p.id }, freed: l.bytes });
    for (const a of p.archives) left.push({ label: `Delete archived notebook ${relName(a.path)}`, sub: `${p.name} · ${bytes(a.bytes)} · older than 180 days`, on: false, action: { type: 'archive', project: p.id, path: a.path }, freed: a.bytes });
  }
  add('Leftovers', left);
  const br = [];
  for (const p of t.projects || []) for (const b of p.branches) {
    br.push({ label: `Delete branch ${b.branch}`, sub: `${p.name} · ${b.why}`, on: false, action: { type: 'branch', project: p.id, branch: b.branch } });
    if (b.prMerged && b.remoteExists) br.push({ label: `Delete origin/${b.branch}`, sub: `${p.name} · the remote branch of a merged pull request`, on: false, action: { type: 'branch', project: p.id, branch: b.branch, remote: true } });
  }
  add('Merged branches of ejected cartridges', br);
  const deep = [];
  (t.projects || []).forEach((p, i) => {
    deep.push({ label: `Compact git in ${p.name}`, sub: 'git gc --auto', on: true, action: { type: 'gc', project: p.id } });
    if (p.pnpm && i === 0) deep.push({ label: 'Prune the pnpm store', sub: 'pnpm store prune: packages no project uses any more (shared by every project on this Mac; the next install downloads them again)', on: false, action: { type: 'store-prune', project: p.id } });
  });
  add('Deep clean', deep);
  return groups;
}
async function tidyDialog() {
  if (!(OV && OV.tidy)) toast('Measuring the folders…');
  let t;
  try { t = await call('tidy'); } catch (e) { return toast(e.message, true); }
  const groups = tidyItems(t);
  const flat = groups.flatMap(g => g.items);
  const body = `<p class="dim">${esc(storageText())}</p>
    ${groups.map(g => `<h3 class="lbl">${esc(g.title)}</h3>${g.items.map(it => { const i = flat.indexOf(it); return `<label class="opt tidy-item ${it.off ? 'off' : ''}"><input type="checkbox" name="t${i}" ${it.on ? 'checked' : ''} ${it.off ? 'disabled' : ''}>
      <span>${esc(it.label)}<small>${esc(it.sub)}</small></span></label>`; }).join('')}`).join('')}
    ${flat.length ? '' : '<p class="empty">Nothing to tidy right now.</p>'}
    <p class="dim">Measured ${esc(ago(t.at))} ago. Branches and archives are never ticked for you.</p>`;
  const res = await dialog('Tidy up', body, flat.length ? [{ label: 'Close', value: 'cancel', cls: 'ghost' }, { label: 'Clean now', value: 'go', cls: 'inv' }] : [{ label: 'Close', value: 'cancel', cls: 'ghost' }]);
  if (res.action !== 'go') return;
  const picked = flat.filter((it, i) => res.data[`t${i}`] && !it.off);
  if (!picked.length) return toast('Nothing ticked', true);
  return tidyRun(picked, 'Clean up?');
}
// Lists what will happen, then runs it; the result toast says how much was freed
async function tidyRun(picked, title) {
  const est = picked.reduce((n, it) => n + (it.freed || 0), 0);
  const ok = await dialog(title, `<ul class="tidy-list">${picked.map(it => `<li>${esc(it.label)}</li>`).join('')}</ul>
    <p class="dim">${est ? `Frees about ${esc(bytes(est))}. ` : ''}Each step is written to the project's actions.log.</p>`,
  [CANCEL, { label: 'Clean now', value: 'ok', cls: 'inv' }]);
  if (ok.action !== 'ok') return;
  toast('Cleaning…');
  const r = await act(() => call('tidy', { actions: picked.map(it => it.action) }));
  if (!r) return;
  const failed = r.results.filter(x => !x.ok);
  toast(`${r.freed ? `Freed ${bytes(r.freed)}` : 'Done'}${failed.length ? `. ${plural(failed.length, 'step')} failed: ${failed[0].error}` : ''}`, failed.length > 0);
}
// After an eject: the branch can go once it is merged, its remote once the pull request is merged; the notebook only if ticked
async function afterEject(r) {
  const items = [];
  const c = r.clean;
  if (c) {
    items.push({ label: `Delete the local branch ${c.branch}`, sub: c.merged ? `Merged: ${c.why}` : `Not merged: ${c.why}`, on: c.merged, off: !c.merged, action: { type: 'branch', project: r.project, branch: c.branch } });
    const remote = c.prMerged && c.remoteExists;
    items.push({ label: `Delete the remote branch origin/${c.branch}`, sub: remote ? 'The pull request is merged' : !c.prMerged ? 'Only once the pull request is merged' : 'origin has no such branch',
      on: remote, off: !remote, action: { type: 'branch', project: r.project, branch: c.branch, remote: true } });
  }
  if (r.archived) items.push({ label: 'Delete the archived notebook', sub: tilde(r.archived), on: false, action: { type: 'archive', project: r.project, path: r.archived } });
  if (!items.length) return;
  const res = await dialog('Ejected. Also clean up?', `<p class="dim">Eject kept ${c && r.archived ? 'the branch and the archived notebook' : c ? 'the branch' : 'the archived notebook'}. These go only if you tick them.</p>
    ${items.map((it, i) => `<label class="opt tidy-item ${it.off ? 'off' : ''}"><input type="checkbox" name="e${i}" ${it.on ? 'checked' : ''} ${it.off ? 'disabled' : ''}><span>${esc(it.label)}<small>${esc(it.sub)}</small></span></label>`).join('')}`,
  [{ label: 'Keep everything', value: 'cancel', cls: 'ghost' }, { label: 'Clean up', value: 'go', cls: 'inv' }]);
  if (res.action !== 'go') return;
  const picked = items.filter((it, i) => res.data[`e${i}`] && !it.off);
  if (!picked.length) return;
  const out = await act(() => call('tidy', { actions: picked.map(it => it.action) }));
  if (!out) return;
  const failed = out.results.filter(x => !x.ok);
  toast(failed.length ? failed[0].error : `Deleted: ${picked.map(it => it.label.replace(/^Delete the /, '')).join(', ')}`, failed.length > 0);
}
document.addEventListener('click', e => {
  const b = e.target.closest('button[data-ops]');
  if (!b) return;
  const id = b.dataset.cid || cur;
  const what = b.dataset.ops;
  if (what === 'tidy') return tidyDialog();
  if (what === 'run-anyway') return runAnyway(id);
  if (what === 'budget') return budgetDialog(id);
  if (what === 'dismiss') return dismissIdle(id);
});

// Ad creative Centre: one page app (dashboard, products with their marketing angles and footage library; team).
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDur = s => { s = Math.round(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

let ME = null;
const state = { view: 'dashboard', product: null, tab: 'overview', poll: null };

async function api(path, opts = {}) {
  const o = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
  const r = await fetch(path, o);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/api/auth')) { showAuth(); throw new Error('Not signed in'); }
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  return data;
}

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), err ? 5000 : 2500);
}
const fail = e => toast(e.message, true);

// ---------- Sign in ----------
let setupMode = false;
async function showAuth() {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  const { needed } = await api('/api/auth/setup');
  setupMode = needed;
  $('#setupName').classList.toggle('hidden', !needed);
  $('#authHint').textContent = needed ? 'First start: create the admin account.' : "Sign in to your team's creative library.";
  $('#authBtn').textContent = needed ? 'Create admin account' : 'Sign in';
  $('#authTitle').textContent = needed ? 'Get started' : 'Welcome back';
}

$('#authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#authErr').textContent = '';
  try {
    await api(setupMode ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: Object.fromEntries(f) });
    start();
  } catch (err) { $('#authErr').textContent = err.message; }
});

$('#logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); showAuth(); });

document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go) { location.hash = go.dataset.go; }
});
window.addEventListener('hashchange', route);

async function start() {
  try { ME = await api('/api/me'); } catch { return; }
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#meName').textContent = ME.user.name;
  $('#meRole').textContent = ME.user.role === 'admin' ? 'Admin' : 'Team member';
  $('#meAvatar').textContent = ME.user.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  $('#navTeam').classList.toggle('hidden', ME.user.role !== 'admin');
  route();
  refreshSide();
  clearInterval(state.sidePoll);
  state.sidePoll = setInterval(refreshSide, 8000);
}

// ---------- Sidebar: counts, recent products, footage being processed ----------
async function refreshSide() {
  if ($('#app').classList.contains('hidden')) return;
  const s = await api('/api/sidebar').catch(() => null);
  if (!s) return;
  const cnt = (id, n) => { $(id).textContent = n ? String(n) : ''; };
  cnt('#cntProducts', s.products); cnt('#cntTeam', s.team);
  const cur = (location.hash.match(/^#product\/(\d+)/) || [])[1];
  $('#sideRecent').innerHTML = s.recent.map(p => `<a class="side-p ${String(p.id) === cur ? 'on' : ''}" href="#product/${p.id}">
      ${productPic(p) ? `<img src="${productPic(p)}" alt="">` : '<span class="pimg-empty">🎬</span>'}<span>${esc(p.name)}</span></a>`).join('')
    || '<div class="side-empty">No product yet</div>';
  $('#live').innerHTML = s.processing
    ? `<div class="live-on"><span class="pulse"></span><div><b>${s.processing} video${s.processing > 1 ? 's' : ''} being processed</b>
        <small>Running in the background</small></div></div>`
    : '<div class="live-off">✅ No footage waiting</div>';
}

// Phone: open/close the sidebar
$('#menuBtn').addEventListener('click', () => document.body.classList.toggle('side-open'));
$('#sideShade').addEventListener('click', () => document.body.classList.remove('side-open'));
$('#sideNew').addEventListener('click', () => { location.hash = 'products'; state.openNew = true; route(); });

function route() {
  clearInterval(state.poll);
  document.body.classList.remove('side-open');
  const [view, id, tab] = (location.hash.slice(1) || 'dashboard').split('/');
  const nav = view === 'product' ? (tab === 'strategy' ? 'angles' : tab === 'footage' ? 'footage' : 'products') : view;
  document.querySelectorAll('.side-nav a').forEach(a => a.classList.toggle('on', a.dataset.go === nav));
  document.querySelectorAll('.side-p').forEach(a => a.classList.toggle('on', view === 'product' && a.getAttribute('href') === `#product/${id}`));
  if (view === 'team' && ME.user.role === 'admin') return renderTeam();
  if (view === 'product' && id) { state.tab = TABS.some(([k]) => k === tab) ? tab : 'overview'; return renderProduct(Number(id)); }
  if (view === 'products') return renderProducts();
  if (view === 'angles') return renderHub('angles');
  if (view === 'footage') return renderHub('footage');
  renderDashboard();
}

// ---------- Products ----------
const P_STATUS = { idea: '💡 Idea', testing: '🧪 Testing', scaling: '🚀 Scaling', paused: '⏸ Paused' };
let MARKETS = null;
const loadMarkets = async () => (MARKETS ??= await api('/api/markets').catch(() => ({})));
const flag = (code, size = '') => `<span class="flag f-${esc(code)} ${size}" title="${esc(MARKETS?.[code]?.name || code)}"></span>`;
const marketBadges = (list = []) => list.map(m => `<span class="mkf">${flag(m.code)}${esc(m.code)}</span>`).join('');
const productPic = p => (p.image ? `/media/product/${p.id}/image?v=${encodeURIComponent(p.image)}` : '');
const ago = iso => {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso.replace(' ', 'T') + 'Z')) / 864e5;
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? `${Math.floor(d)} days ago` : iso.slice(0, 10);
};

const ANALYSIS_LABEL = { done: '✅ Analysed', running: '⏳ Analysing…', failed: '⚠ Failed' };

async function renderProducts() {
  const v = $('#view');
  await loadMarkets();
  const list = await api('/api/products').catch(fail) || [];
  const q = (state.productQuery || '').toLowerCase();
  const shown = list.filter(p => !q || p.name.toLowerCase().includes(q));
  v.innerHTML = `
    <div class="page-head">
      <div><h1>Products</h1><div class="muted">${list.length} product${list.length === 1 ? '' : 's'} · click one to open its page</div></div>
      <div class="row"><input type="text" id="pSearch" placeholder="🔍 Search a product" value="${esc(state.productQuery || '')}" style="width:240px">
        <button class="btn primary" id="newProduct">+ New product</button></div>
    </div>
    <form id="newForm" class="card hidden" style="margin-bottom:14px">
      <h2>New product</h2>
      <label class="f">Product name</label><input type="text" name="name" required placeholder="e.g. BESTKANG Women's Luxury Watch">
      <div class="row" style="margin-top:12px"><button class="btn primary">Create</button><button type="button" class="btn" id="cancelNew">Cancel</button></div>
    </form>
    <div class="plist card">
      <div class="prow phead"><div>Product</div><div>Status</div><div>Markets</div><div>Analysis</div><div>Angles</div><div>Footage</div><div>Activity</div></div>
      ${shown.map(productRow).join('')}
      ${shown.length ? '' : `<div class="empty">${list.length ? 'No product matches.' : 'No product yet. Click <b>+ New product</b>.'}</div>`}
    </div>`;
  $('#newProduct').onclick = () => { $('#newForm').classList.remove('hidden'); $('#newForm [name=name]').focus(); };
  if (state.openNew) { state.openNew = false; $('#newProduct').click(); }
  $('#cancelNew').onclick = () => $('#newForm').classList.add('hidden');
  $('#newForm').onsubmit = async e => {
    e.preventDefault();
    try {
      const { id } = await api('/api/products', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      location.hash = `product/${id}/strategy`; // new product: start with its information and analysis
    } catch (err) { fail(err); }
  };
  const ps = $('#pSearch');
  ps.oninput = () => { state.productQuery = ps.value; const pos = ps.selectionStart; renderProducts().then(() => { const x = $('#pSearch'); x.focus(); x.setSelectionRange(pos, pos); }); };
}

// ---------- One product ----------
async function loadProduct(id) {
  state.data = await api(`/api/products/${id}`);
  state.product = id;
}

// The source link is Alibaba, 1688 or Amazon: its icon and name follow the link.
const sourceIcon = u => (/amazon./i.test(u || '') ? '📦' : '🏭');
const sourceName = u => (/amazon./i.test(u || '') ? 'Amazon' : /1688.com/i.test(u || '') ? '1688' : /alibaba./i.test(u || '') ? 'Alibaba' : 'Alibaba / 1688 / Amazon');

const TABS = [['overview', '✦ Overview'], ['strategy', '🎯 Marketing angles'], ['footage', '🎞 Footage library']];

// Where the product is: information → analysis → angles chosen → footage → scenes analysed.
function productSteps() {
  const { product: p, counts: c } = state.data;
  const steps = [
    { k: 'strategy', ic: '📦', t: 'Product info', d: p.description ? 'Description ready' : 'Add a description', done: Boolean(p.description) },
    { k: 'strategy', ic: '🧠', t: 'Analysis', d: c.analysed ? 'Done' : 'Analyse with AI', done: c.analysed > 0 },
    { k: 'strategy', ic: '🎯', t: 'Angles', d: c.selected_angles ? `${c.selected_angles} chosen` : c.angles ? `${c.angles} to choose from` : 'Generate angles', done: c.selected_angles > 0 },
    { k: 'footage', ic: '🎞', t: 'Footage', d: c.videos ? `${c.videos} video${c.videos > 1 ? 's' : ''}` : 'Upload videos', done: c.videos > 0 },
    { k: 'footage', ic: '✨', t: 'Scenes', d: c.analysed_scenes ? `${c.analysed_scenes} analysed` : 'Analysed by AI', done: c.analysed_scenes > 0 },
  ];
  const cur = steps.findIndex(s => !s.done);
  return steps.map((s, i) => ({ ...s, cur: i === cur }));
}

async function renderProduct(id) {
  try { await Promise.all([loadProduct(id), loadMarkets()]); } catch (e) { fail(e); location.hash = 'products'; return; }
  const { product: p, counts: c } = state.data;
  const pic = productPic(p);
  const counts = { strategy: c.angles, footage: c.videos };
  const link = (url, ic, label) => (url ? `<a class="glass-chip" href="${esc(url)}" target="_blank" rel="noopener">${ic} ${label} <i>↗</i></a>` : '');
  const steps = productSteps();
  const v = $('#view');
  v.innerHTML = `
    <a class="back" href="#products">← All products</a>
    <section class="hero2">
      ${pic ? `<div class="hero2-bg" style="background-image:url('${pic}')"></div>` : ''}
      <div class="hero2-top">
        <label class="hero2-pic" title="Change the picture">${pic ? `<img src="${pic}" alt="">` : '<span>📷<br><small>Add a picture</small></span>'}
          <span class="hero2-pic-edit">📷</span><input type="file" accept="image/*" class="hidden" id="pImage"></label>
        <div class="hero2-main">
          <div class="hero2-tags">
            <select id="pStatus" class="glass-sel">${Object.entries(P_STATUS).map(([k, l]) => `<option value="${k}" ${k === p.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
            ${p.markets.map(m => `<span class="glass-chip flagc">${flag(m.code)}${esc(MARKETS[m.code]?.name || m.code)}</span>`).join('')}
          </div>
          <h1>${esc(p.name)}</h1>
          <div class="hero2-links">
            ${link(p.link_product, '🛒', 'Product page')}${link(p.link_alibaba, sourceIcon(p.link_alibaba), sourceName(p.link_alibaba))}
            ${!p.link_product && !p.link_alibaba ? '<button class="glass-chip" id="addLinks">＋ Add links</button>' : ''}
          </div>
          <div class="hero2-by">Added ${esc(p.created_at.slice(0, 10))}${state.data.author ? ` by ${esc(state.data.author)}` : ''}</div>
        </div>
        <div class="hero2-actions">
          <div class="row" style="gap:6px;justify-content:flex-end">
            <button class="glass-btn" id="pEdit">✏️ Edit</button>
            ${ME.user.role === 'admin' ? '<button class="glass-btn danger" id="delProduct" title="Delete product">🗑</button>' : ''}
          </div>
        </div>
      </div>
      <div class="hero2-stats">
        <div><b>${c.angles}</b><span>🎯 Angles</span></div>
        <div class="${c.selected_angles ? 'win' : ''}"><b>${c.selected_angles}</b><span>✅ Chosen</span></div>
        <div><b>${c.videos}</b><span>🎞 Videos</span></div>
        <div><b>${c.scenes}</b><span>✨ Scenes</span></div>
      </div>
    </section>

    <div class="journey">
      ${steps.map((s, i) => `<a class="jstep ${s.done ? 'done' : ''} ${s.cur ? 'cur' : ''}" href="#product/${id}/${s.k}">
        <span class="jic">${s.done ? '✓' : s.ic}</span><div><b>${s.t}</b><small>${esc(s.d)}</small></div></a>${i < steps.length - 1 ? '<span class="jline"></span>' : ''}`).join('')}
    </div>

    <div class="tabs">${TABS.map(([k, l]) => `<a data-tab="${k}" class="${k === state.tab ? 'on' : ''}">${l}${counts[k] !== undefined ? ` <span class="cnt">${counts[k]}</span>` : ''}</a>`).join('')}</div>
    <div id="tab"></div>`;
  v.querySelectorAll('.tabs a').forEach(a => { a.onclick = () => { location.hash = `product/${id}/${a.dataset.tab}`; }; });
  $('#pStatus').onchange = e => api(`/api/products/${id}`, { method: 'PATCH', body: { status: e.target.value } }).then(() => toast('Status saved'), fail);
  $('#pImage').onchange = e => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    fetch(`/api/products/${id}/image`, { method: 'POST', body: fd }).then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error); renderProduct(id); refreshSide(); }), fail).catch(fail);
  };
  $('#pEdit').onclick = () => editProduct(p);
  $('#addLinks')?.addEventListener('click', () => editProduct(p));
  const del = $('#delProduct');
  if (del) del.onclick = async () => {
    if (!confirm(`Delete "${p.name}" with its analysis, marketing angles, videos and scenes? This cannot be undone.`)) return;
    try { await api(`/api/products/${id}`, { method: 'DELETE' }); location.hash = 'products'; refreshSide(); } catch (e) { fail(e); }
  };
  ({ overview: renderOverview, strategy: renderStrategy, footage: renderFootage }[state.tab] || renderOverview)();
}

// Overview: marketing angles and footage at a glance, links, markets, what the AI knows.
function renderOverview() {
  const { product: p, counts: c } = state.data;
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  // Each link tile can be filled or changed right where it is (click ＋ or ✏️, paste, Enter).
  const tile = (u, ic, title, color, key) => `<div class="ltile-wrap" data-link="${key}">${u
    ? `<a class="ltile" href="${esc(u)}" target="_blank" rel="noopener"><span class="lt-ic" style="background:${color}">${ic}</span>
        <div><b>${title}</b><small>${esc(host(u))}</small></div><i>↗</i></a><button class="lt-edit" data-ledit title="Change the link">✏️</button>`
    : `<button class="ltile empty" data-ledit><span class="lt-ic">${ic}</span><div><b>${title}</b><small>＋ Add the link</small></div></button>`}
    <form class="ltile ledit hidden"><span class="lt-ic" style="background:${color}">${ic}</span>
      <input type="url" name="url" value="${esc(u)}" placeholder="Paste the ${title} link…">
      <button class="btn sm primary">Save</button><button type="button" class="btn sm" data-lcancel>✕</button></form></div>`;
  const total = p.markets.length;
  $('#tab').innerHTML = `
    <div class="ov2">
      <section class="card">
        <div class="sec-h"><div><h2>📌 This product</h2><small>Marketing angles and footage library</small></div></div>
        <div class="ltiles">
          <a class="ltile" href="#product/${p.id}/strategy"><span class="lt-ic" style="background:linear-gradient(135deg,#7c3aed,#c084fc)">🎯</span>
            <div><b>Marketing angles</b><small>${c.analysed ? 'Analysed' : 'Not analysed yet'} · ${c.angles} angle${c.angles === 1 ? '' : 's'} · ${c.selected_angles} chosen</small></div><i>→</i></a>
          <a class="ltile" href="#product/${p.id}/footage"><span class="lt-ic" style="background:linear-gradient(135deg,#0ea5e9,#22d3ee)">🎞</span>
            <div><b>Footage library</b><small>${c.videos} video${c.videos === 1 ? '' : 's'} · ${c.analysed_scenes}/${c.scenes} scenes analysed · ${c.favorites} ★</small></div><i>→</i></a>
        </div>
      </section>

      <div class="ov2-grid">
        <section class="card">
          <div class="sec-h"><div><h2>🔗 Links</h2><small>Store, supplier and research</small></div><button class="btn sm" data-edit>✏️ Edit</button></div>
          <div class="ltiles">
            ${tile(p.link_product, '🛒', 'Product page', 'linear-gradient(135deg,#ff4d2e,#ff9d00)', 'link_product')}
            ${tile(p.link_alibaba, sourceIcon(p.link_alibaba), 'Alibaba / 1688 / Amazon', /amazon./i.test(p.link_alibaba) ? 'linear-gradient(135deg,#232f3e,#4a5a70)' : 'linear-gradient(135deg,#ff7a00,#ffb020)', 'link_alibaba')}
          </div>
        </section>

        <section class="card mk-card">
          <div class="sec-h"><div><h2>🌍 Markets</h2><small>${total ? `Selling in ${total} countr${total > 1 ? 'ies' : 'y'}` : 'Where do you sell it?'}</small></div><button class="btn sm" data-edit>✏️</button></div>
          ${total ? p.markets.map(m => `<div class="mk2">${flag(m.code, 'lg')}<div><b>${esc(MARKETS[m.code]?.name || m.code)}</b><small>Cash on delivery</small></div>
            <div class="mk2-price">${m.price ? `${esc(m.price)}<small>${esc(MARKETS[m.code]?.currency || '')}</small>` : '<span class="muted small">no price</span>'}</div></div>`).join('')
            : '<button class="ltile empty" data-edit style="width:100%"><span class="lt-ic">🌍</span><div><b>Add markets</b><small>Countries and prices</small></div></button>'}
        </section>
      </div>

      <section class="card ai-card">
        <div class="sec-h"><div><h2>🤖 What the AI knows</h2><small>Given to the AI with the description: benefits, buyers, price, offer, tone</small></div>
          <span class="ai-count" id="ovCount">${p.notes.length} chars</span></div>
        <textarea id="ovNotes" placeholder="e.g. Crystal bracelet, gold finish, a gift for her. 780 ZMW, buy 2 get the 3rd free. Pay on delivery, 24-72 h.">${esc(p.notes)}</textarea>
        <div class="ai-foot">
          <div class="ai-meta"></div>
          <button class="btn primary" id="ovSave">Save</button>
        </div>
      </section>

    </div>`;
  $('#tab').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editProduct(p));
  $('#tab').querySelectorAll('[data-link]').forEach(w => {
    const form = $('form', w), input = $('input', form);
    const view = [...w.children].filter(x => x !== form);
    const show = on => { form.classList.toggle('hidden', !on); view.forEach(x => x.classList.toggle('hidden', on)); if (on) { input.focus(); input.select(); } };
    $('[data-ledit]', w).onclick = e => { e.preventDefault(); show(true); };
    $('[data-lcancel]', form).onclick = () => show(false);
    input.onkeydown = e => { if (e.key === 'Escape') show(false); };
    form.onsubmit = async e => {
      e.preventDefault();
      try {
        await api(`/api/products/${p.id}`, { method: 'PATCH', body: { [w.dataset.link]: input.value.trim() } });
        toast(input.value.trim() ? 'Link saved' : 'Link removed');
        renderProduct(p.id);
      } catch (err) { fail(err); }
    };
  });
  const notes = $('#ovNotes');
  notes.oninput = () => { $('#ovCount').textContent = `${notes.value.length} chars`; };
  $('#ovSave').onclick = () => api(`/api/products/${p.id}`, { method: 'PATCH', body: { notes: notes.value } }).then(() => toast('Saved'), fail);
}


// ---------- Strategy (Module 1): Product → Analysis → Angles → Continue ----------
const STRAT_STEPS = [['product', 'Product', '📦'], ['analysis', 'Analysis', '🧠'], ['angles', 'Marketing angles', '🎯'], ['continue', 'Continue', '🚀']];

async function loadStrategy() {
  state.strat = await api(`/api/products/${state.product}/strategy`);
  return state.strat;
}
const jobOf = (kind, target) => state.strat.jobs.find(j => j.kind === kind && j.status === 'running' && (target === undefined || j.target_id === target));
const lastJob = kind => state.strat.jobs.find(j => j.kind === kind);

async function renderStrategy() {
  try { await loadStrategy(); } catch (e) { return fail(e); }
  const s = state.strat;
  if (!state.stratStep || state.stratFor !== state.product) {
    state.stratFor = state.product;
    state.stratStep = !s.analysis && !jobOf('analysis') ? 'product' : !s.angles.length && !jobOf('angles') && !jobOf('analysis') ? 'analysis' : 'angles';
    state.angleDraft = null;
  }
  if (!state.angleDraft) state.angleDraft = new Set(s.angles.filter(a => a.selected).map(a => a.id));
  drawStrategy();
  // While the AI works, check every 2 s.
  clearInterval(state.poll);
  if (s.jobs.some(j => j.status === 'running')) {
    state.poll = setInterval(async () => {
      if (state.tab !== 'strategy' || !location.hash.startsWith(`#product/${state.product}`)) return clearInterval(state.poll);
      const before = JSON.stringify(state.strat.jobs.map(j => [j.id, j.status]));
      await loadStrategy().catch(() => {});
      if (JSON.stringify(state.strat.jobs.map(j => [j.id, j.status])) !== before) {
        // A finished analysis moves on to the angles step.
        if (state.stratStep === 'analysis' && state.strat.angles.length && !state.strat.jobs.some(j => j.status === 'running')) state.stratStep = 'angles';
        state.angleDraft = new Set([...state.angleDraft].filter(id => state.strat.angles.some(a => a.id === id)));
        for (const a of state.strat.angles) if (a.selected) state.angleDraft.add(a.id);
        drawStrategy();
        if (!state.strat.jobs.some(j => j.status === 'running')) { clearInterval(state.poll); renderStrategy(); }
      } else drawStrategy(true);
    }, 2000);
  }
}

function drawStrategy(onlyTimers = false) {
  if (onlyTimers) { document.querySelectorAll('[data-since]').forEach(el => { el.textContent = elapsed(el.dataset.since); }); return; }
  const s = state.strat, p = state.data.product;
  const done = { product: Boolean(p.description || s.images.length || p.image), analysis: Boolean(s.analysis), angles: s.angles.length > 0, continue: s.angles.some(a => a.selected) };
  const t = $('#tab');
  const keepScroll = window.scrollY;
  t.innerHTML = `
    ${s.mock ? '<div class="mock-bar">🧪 Test mode: the AI answers are examples (ACC_AI_MOCK=1).</div>' : ''}
    <div class="sstepper">
      ${STRAT_STEPS.map(([k, l, ic], i) => `<button class="sstep ${state.stratStep === k ? 'on' : ''} ${done[k] ? 'done' : ''}" data-step="${k}">
        <span class="sstep-n">${done[k] && state.stratStep !== k ? '✓' : i + 1}</span><span class="sstep-t"><small>Step ${i + 1}</small>${ic} ${l}</span></button>
        ${i < STRAT_STEPS.length - 1 ? '<span class="sstep-line"></span>' : ''}`).join('')}
    </div>
    <div id="stratBody"></div>`;
  t.querySelectorAll('[data-step]').forEach(b => b.onclick = () => { state.stratStep = b.dataset.step; drawStrategy(); });
  ({ product: drawProductStep, analysis: drawAnalysisStep, angles: drawAnglesStep, continue: drawContinueStep })[state.stratStep]();
  window.scrollTo(0, keepScroll);
}

const elapsed = since => { const s = Math.max(0, Math.round((Date.now() - new Date(since.replace(' ', 'T') + 'Z')) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const working = (title, sub, job) => `<div class="ai-working"><div class="ai-orb"><span></span><span></span><span></span></div>
  <div><b>${title}</b><small>${sub}</small></div><span class="ai-time" data-since="${esc(job.created_at)}">${elapsed(job.created_at)}</span></div>`;
const failedBox = (msg, retryId) => `<div class="ai-failed"><b>⚠ ${esc(msg)}</b><button class="btn sm" id="${retryId}">↻ Try again</button></div>`;

// Step 1: product information (import from a link, or by hand) and pictures.
function drawProductStep() {
  const p = state.data.product, s = state.strat;
  const imp = state.imported;
  $('#stratBody').innerHTML = `
    <div class="sgrid">
      <section class="card simport">
        <div class="sec-h"><div><h2>🔗 Import from the product page</h2><small>We read the page; you check and correct everything before saving.</small></div></div>
        <form class="import-row" id="impForm"><input type="url" name="url" placeholder="https://savaro.storeep.com/products/… or Alibaba / Amazon link" value="${esc(imp?.url || p.link_product || '')}" required>
          <button class="btn primary" id="impBtn">Import</button></form>
        ${imp ? `<div class="imp-res">
          ${imp.warning ? `<div class="imp-warn">⚠ ${esc(imp.warning)}</div>` : ''}
          <div class="imp-fields">
            <div><span>Name</span><b>${esc(imp.name || '–')}</b></div>
            <div><span>Price</span><b>${esc(imp.price || '–')}</b></div>
            ${imp.offer ? `<div><span>Offer</span><b>${esc(imp.offer)}</b></div>` : ''}
            <div class="full"><span>Description</span><p>${esc((imp.description || '–').slice(0, 600))}${(imp.description || '').length > 600 ? '…' : ''}</p></div>
          </div>
          ${imp.images.length ? `<div class="imp-pics-h">Pictures found: tick the ones to keep</div><div class="imp-pics">${imp.images.map((u, i) => `
            <label class="imp-pic ${state.impPick?.has(i) ? 'on' : ''}"><input type="checkbox" data-pick="${i}" ${state.impPick?.has(i) ? 'checked' : ''}><img src="${esc(u)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.closest('label').remove()"></label>`).join('')}</div>` : ''}
          <div class="row" style="margin-top:12px"><button class="btn primary" id="impUse">✓ Use this information</button><button class="btn" id="impCancel">Cancel</button></div>
        </div>` : ''}
      </section>

      <form class="card sform" id="prodForm">
        <div class="sec-h"><div><h2>📦 Product information</h2><small>What the AI will analyse. Only facts: it does not invent anything.</small></div></div>
        <div class="f2">
          <label class="fl full"><span>Product name *</span><input name="name" value="${esc(p.name)}" required></label>
          <label class="fl full"><span>Product page URL</span><input name="link_product" value="${esc(p.link_product)}" placeholder="https://…"></label>
          <label class="fl full"><span>Description</span><textarea name="description" rows="7" placeholder="What it is, features, specs, what is in the box…">${esc(p.description)}</textarea></label>
          <label class="fl"><span>Selling price <i>(optional)</i></span><input name="price" value="${esc(p.price)}" placeholder="780 ZMW"></label>
          <label class="fl"><span>Promotional offer <i>(optional)</i></span><input name="offer" value="${esc(p.offer)}" placeholder="Buy 2, get the 3rd free"></label>
          <label class="fl"><span>Target country</span><select name="country"><option value="">Choose…</option>${Object.entries(MARKETS).map(([c, m]) => `<option value="${c}" ${p.country === c ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
          <label class="fl"><span>Target language</span><select name="language">${Object.entries(ME.languages).map(([k, l]) => `<option value="${k}" ${p.language === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        <div class="pics-h"><b>🖼 Product pictures</b><small>${s.images.length} · the AI looks at up to 4</small></div>
        <div class="pics">
          ${s.images.map(im => `<div class="pic ${p.image === im.file ? 'main' : ''}"><img src="/media/product-image/${im.id}" alt="" loading="lazy">
            ${p.image === im.file ? '<span class="pic-main">★ Main</span>' : `<button type="button" class="pic-btn" data-main="${im.id}" title="Make it the main picture">★</button>`}
            <button type="button" class="pic-btn del" data-delimg="${im.id}" title="Remove">✕</button></div>`).join('')}
          <label class="pic add"><input type="file" accept="image/*" multiple class="hidden" id="picIn"><span>＋</span><small>Add pictures</small></label>
        </div>
        <div class="sform-foot">
          <button type="submit" class="btn" name="save">Save</button>
          <button type="submit" class="btn primary big" name="go">Save &amp; analyse with AI →</button>
        </div>
      </form>
    </div>`;

  $('#impForm').onsubmit = async e => {
    e.preventDefault();
    const btn = $('#impBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spin sm"></span> Reading the page…';
    try {
      state.imported = await api('/api/import-url', { method: 'POST', body: { url: e.target.url.value } });
      state.impPick = new Set(state.imported.images.slice(0, 4).map((_, i) => i));
    } catch (err) { fail(err); }
    drawProductStep();
  };
  document.querySelectorAll('[data-pick]').forEach(cb => cb.onchange = () => { cb.checked ? state.impPick.add(Number(cb.dataset.pick)) : state.impPick.delete(Number(cb.dataset.pick)); cb.closest('label').classList.toggle('on', cb.checked); });
  $('#impCancel')?.addEventListener('click', () => { state.imported = null; drawProductStep(); });
  $('#impUse')?.addEventListener('click', async () => {
    const f = $('#prodForm');
    if (imp.name) f.name.value = imp.name;
    if (imp.description) f.description.value = imp.description;
    if (imp.price) f.price.value = imp.price;
    if (imp.offer) f.offer.value = imp.offer;
    f.link_product.value = imp.url;
    const urls = [...(state.impPick || [])].map(i => imp.images[i]);
    const btn = $('#impUse');
    btn.disabled = true; btn.textContent = urls.length ? `Saving ${urls.length} pictures…` : 'Saving…';
    try {
      await saveProductForm();
      if (urls.length) {
        const r = await api(`/api/products/${state.product}/images/from-urls`, { method: 'POST', body: { urls } });
        if (r.failed.length) toast(`${r.added} pictures saved, ${r.failed.length} could not be downloaded`, true);
      }
      state.imported = null;
      toast('Imported: check the information');
      await reloadProductData();
    } catch (err) { fail(err); btn.disabled = false; btn.textContent = '✓ Use this information'; }
  });
  $('#picIn').onchange = async e => {
    const fd = new FormData();
    for (const f of e.target.files) fd.append('files', f);
    const r = await fetch(`/api/products/${state.product}/images`, { method: 'POST', body: fd });
    if (!r.ok) return fail(new Error((await r.json().catch(() => ({}))).error || 'Upload failed'));
    await reloadProductData();
  };
  document.querySelectorAll('[data-main]').forEach(b => b.onclick = () => api(`/api/product-images/${b.dataset.main}/main`, { method: 'POST' }).then(reloadProductData, fail));
  document.querySelectorAll('[data-delimg]').forEach(b => b.onclick = () => { if (confirm('Remove this picture?')) api(`/api/product-images/${b.dataset.delimg}`, { method: 'DELETE' }).then(reloadProductData, fail); });
  $('#prodForm').onsubmit = async e => {
    e.preventDefault();
    const go = e.submitter?.name === 'go';
    try {
      await saveProductForm();
      if (go) {
        await api(`/api/products/${state.product}/analyze`, { method: 'POST', body: {} });
        state.stratStep = 'analysis';
      } else toast('Saved');
      await reloadProductData();
    } catch (err) { fail(err); }
  };
}

async function saveProductForm() {
  const f = Object.fromEntries(new FormData($('#prodForm')));
  await api(`/api/products/${state.product}`, { method: 'PATCH', body: f });
}
// The header (picture, name) may have changed: draw the whole product page again (the step stays).
async function reloadProductData() {
  const y = window.scrollY;
  await renderProduct(state.product);
  window.scrollTo(0, y);
  refreshSide();
}

// Step 2: the analysis.
function drawAnalysisStep() {
  const s = state.strat, a = s.analysis?.data;
  const job = jobOf('analysis'), fail2 = !job && s.lastAnalysis?.status === 'failed' ? s.lastAnalysis : null;
  const list = (title, ic, items, cls = '') => items?.length ? `<div class="an-box ${cls}"><h4>${ic} ${title}</h4><ul>${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
  $('#stratBody').innerHTML = `
    ${job ? working('Analysing the product…', 'Reading the description and pictures, thinking about the market. Usually 30-90 seconds.', job) : ''}
    ${jobOf('angles') ? working('Writing the marketing angles…', 'Analysis done: 8-12 distinct angles are on their way.', jobOf('angles')) : ''}
    ${fail2 ? failedBox(`The analysis failed: ${fail2.error}`, 'anRetry') : ''}
    ${!a && !job && !fail2 ? `<div class="card s-empty"><div class="s-empty-ic">🧠</div><h2>No analysis yet</h2>
      <p class="muted">The AI reads the product information and pictures and finds the audiences, pain points, objections and selling points for the target market.</p>
      <button class="btn primary big" id="anStart">Analyse with AI</button></div>` : ''}
    ${a ? `
      <div class="card an-head">
        <div><span class="chip">${esc(a.category)}</span><h2>${esc(state.data.product.name)}</h2><p>${esc(a.summary)}</p></div>
        <div class="row"><button class="btn" id="anRedo" ${job ? 'disabled' : ''}>↻ Analyse again</button><button class="btn primary" id="anNext">Marketing angles →</button></div>
      </div>
      <div class="an-grid">
        ${list('Main features', '⚙️', a.features)}
        ${list('Customer benefits', '💎', a.benefits)}
        ${list('Problems solved', '🧩', a.problems_solved)}
        <div class="an-box"><h4>👥 Target audiences</h4>${a.audiences.map(x => `<div class="aud"><b>${esc(x.name)}</b><small>${esc(x.description)}</small></div>`).join('')}</div>
        ${list('Pain points', '😣', a.pain_points)}
        ${list('Purchase motivations', '🛒', a.motivations)}
        <div class="an-box wide"><h4>🤔 Objections and answers</h4>${a.objections.map(x => `<div class="obj"><b>“${esc(x.objection)}”</b><span>→ ${esc(x.answer)}</span></div>`).join('')}</div>
        ${list('Unique selling points', '⭐', a.usps)}
        ${list('Emotional triggers', '❤️', a.emotional_triggers)}
        <div class="an-box wide market"><h4>🌍 ${esc(MARKETS[state.data.product.country]?.name || 'Market')} notes</h4><p>${esc(a.market_notes)}</p></div>
        ${list('To check or add (not invented)', '⚠️', a.missing_info, 'warn wide')}
      </div>` : ''}`;
  $('#anStart')?.addEventListener('click', startAnalysisNow);
  $('#anRetry')?.addEventListener('click', startAnalysisNow);
  $('#anRedo')?.addEventListener('click', () => { if (confirm('Analyse again? Angles you did not select or edit will be replaced.')) startAnalysisNow(); });
  $('#anNext')?.addEventListener('click', () => { state.stratStep = 'angles'; drawStrategy(); });
}
async function startAnalysisNow() {
  try { await api(`/api/products/${state.product}/analyze`, { method: 'POST', body: {} }); state.stratStep = 'analysis'; renderStrategy(); } catch (e) { fail(e); }
}

// Step 3: marketing angles as selectable cards.
function drawAnglesStep() {
  const s = state.strat, sel = state.angleDraft;
  const allJob = jobOf('angles') || jobOf('analysis');
  const lastAll = lastJob('angles');
  const saved = new Set(s.angles.filter(a => a.selected).map(a => a.id));
  const dirty = sel.size !== saved.size || [...sel].some(id => !saved.has(id));
  $('#stratBody').innerHTML = `
    ${allJob ? working(jobOf('analysis') ? 'Analysing the product…' : 'Writing the marketing angles…', 'Selected and edited angles are kept.', allJob) : ''}
    ${!allJob && lastAll?.status === 'failed' ? failedBox(`Angles failed: ${lastAll.error}`, 'agRetry') : ''}
    ${!s.analysis && !allJob ? `<div class="card s-empty"><div class="s-empty-ic">🎯</div><h2>Analyse the product first</h2><button class="btn primary big" id="agToAn">Go to analysis</button></div>` : `
    <div class="ag-hero">
      <div class="ag-hero-txt">
        <span class="ag-kicker">Step 3 · Choose your messages</span>
        <h2>🎯 ${s.angles.length} marketing angles</h2>
        <p>Each angle is a different reason to buy. Pick the ones to turn into ads.</p>
      </div>
      <div class="ag-hero-stats">
        <div><b>${s.angles.length}</b><span>Angles</span></div>
        <div class="hot"><b>${sel.size}</b><span>Selected</span></div>
        <div><b>${s.angles.reduce((n, a) => n + a.hooks.length, 0)}</b><span>Opening lines</span></div>
      </div>
      <div class="ag-hero-btns">
        <button class="btn" id="agCustom">＋ Custom angle</button>
        <button class="btn" id="agAll" ${allJob ? 'disabled' : ''}>↻ Regenerate all</button>
      </div>
    </div>
    <div class="angles">
      ${s.angles.map((a, i) => {
        const busy = jobOf('angle', a.id);
        return `<article class="angle th${i % 8} ${sel.has(a.id) ? 'on' : ''} ${busy ? 'busy' : ''}" data-angle="${a.id}">
          <header class="ang-head">
            <span class="ang-num">${String(i + 1).padStart(2, '0')}</span>
            <div class="ang-title"><h3>${esc(a.name)}</h3>${a.emotion ? `<span class="ang-emo">${esc(a.emotion)}</span>` : ''}</div>
            <span class="ang-check" title="Select">${sel.has(a.id) ? '✓' : '＋'}</span>
            ${a.custom ? '<span class="ang-edited">✏️ edited</span>' : ''}
          </header>
          <div class="ang-msg"><span>Selling message</span><p>${esc(a.message)}</p></div>
          <div class="ang-in">
            <p class="ang-desc">${esc(a.description)}</p>
            <div class="ang-meta">
              <div class="ang-tile"><i>👥</i><div><span>Who</span>${esc(a.audience)}</div></div>
              <div class="ang-tile pain"><i>💢</i><div><span>Their problem</span>${esc(a.pain_point)}</div></div>
            </div>
            <div class="ang-hooks"><span>🎬 Opening lines</span>${a.hooks.map(h => `<p><b>▶</b>${esc(h)}</p>`).join('')}</div>
            <div class="ang-types">${a.creative_types.map(c => `<span>${esc(c)}</span>`).join('')}</div>
            ${a.why ? `<details class="ang-why"><summary>💡 Why it could work</summary><p>${esc(a.why)}</p></details>` : ''}
          </div>
          <footer class="ang-actions">
            <button class="btn sm" data-aedit="${a.id}">✏️ Edit</button>
            <button class="btn sm" data-aregen="${a.id}" ${busy || allJob ? 'disabled' : ''}>${busy ? '<span class="spin sm"></span> Rewriting…' : '↻ Regenerate'}</button>
            <button class="btn sm ghost danger" data-adel="${a.id}" title="Delete">🗑</button>
            <span class="ang-pick">${sel.has(a.id) ? '✓ Selected' : 'Click to select'}</span>
          </footer>
        </article>`;
      }).join('')}
      ${allJob && !s.angles.length ? Array(6).fill('<article class="angle skeleton"><i></i><i></i><i></i><i></i></article>').join('') : ''}
    </div>
    <div class="ag-bar ${sel.size ? 'show' : ''}">
      <div><b>${sel.size}</b> angle${sel.size === 1 ? '' : 's'} selected${dirty ? ' · <span class="unsaved">not saved yet</span>' : ' · saved'}</div>
      <button class="btn" id="agClear">Clear</button>
      <button class="btn primary big" id="agSave">Save selection &amp; continue →</button>
    </div>`}`;
  $('#agToAn')?.addEventListener('click', () => { state.stratStep = 'analysis'; drawStrategy(); });
  $('#agRetry')?.addEventListener('click', regenAll);
  $('#agAll')?.addEventListener('click', () => { if (confirm('Regenerate all angles? Selected and edited angles are kept, the others are replaced.')) regenAll(); });
  $('#agCustom')?.addEventListener('click', () => editAngle(null));
  document.querySelectorAll('[data-angle]').forEach(card => card.onclick = e => {
    if (e.target.closest('button, details, summary')) return;
    const id = Number(card.dataset.angle);
    sel.has(id) ? sel.delete(id) : sel.add(id);
    drawAnglesStep();
  });
  document.querySelectorAll('[data-aedit]').forEach(b => b.onclick = () => editAngle(s.angles.find(a => a.id === Number(b.dataset.aedit))));
  document.querySelectorAll('[data-aregen]').forEach(b => b.onclick = async () => {
    try { await api(`/api/angles/${b.dataset.aregen}/regenerate`, { method: 'POST' }); renderStrategy(); } catch (e) { fail(e); }
  });
  document.querySelectorAll('[data-adel]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this angle?')) return;
    try { await api(`/api/angles/${b.dataset.adel}`, { method: 'DELETE' }); sel.delete(Number(b.dataset.adel)); renderStrategy(); } catch (e) { fail(e); }
  });
  $('#agClear')?.addEventListener('click', () => { sel.clear(); drawAnglesStep(); });
  $('#agSave')?.addEventListener('click', async () => {
    try {
      await api(`/api/products/${state.product}/angles/selection`, { method: 'POST', body: { ids: [...sel] } });
      toast(`${sel.size} angle(s) saved`);
      state.stratStep = 'continue';
      renderStrategy();
    } catch (e) { fail(e); }
  });
}
async function regenAll() {
  try { await api(`/api/products/${state.product}/angles/generate`, { method: 'POST' }); renderStrategy(); } catch (e) { fail(e); }
}

// Add or edit an angle (a window).
function editAngle(a) {
  const m = document.createElement('div');
  m.className = 'studio-wrap center';
  const v = a || { name: '', description: '', audience: '', pain_point: '', message: '', emotion: '', hooks: ['', '', ''], creative_types: [], why: '' };
  const hooks = [...v.hooks, '', '', ''].slice(0, 3);
  m.innerHTML = `<form class="modal-card ang-form">
    <div class="row spread"><h2 style="margin:0">${a ? '✏️ Edit angle' : '＋ Custom angle'}</h2><button type="button" class="btn ghost" data-x>✕</button></div>
    <div class="f2">
      <label class="fl"><span>Angle name *</span><input name="name" value="${esc(v.name)}" required></label>
      <label class="fl"><span>Emotional trigger</span><input name="emotion" value="${esc(v.emotion)}" placeholder="Love, pride, relief…"></label>
      <label class="fl full"><span>Short description</span><textarea name="description" rows="2">${esc(v.description)}</textarea></label>
      <label class="fl"><span>Target audience</span><input name="audience" value="${esc(v.audience)}"></label>
      <label class="fl"><span>Customer pain point</span><input name="pain_point" value="${esc(v.pain_point)}"></label>
      <label class="fl full"><span>Main selling message</span><input name="message" value="${esc(v.message)}"></label>
      ${hooks.map((h, i) => `<label class="fl full"><span>Opening line ${i + 1}</span><input name="hook${i}" value="${esc(h)}"></label>`).join('')}
      <label class="fl full"><span>Recommended creative types (comma separated)</span><input name="creative_types" value="${esc(v.creative_types.join(', '))}" placeholder="UGC testimonial, unboxing"></label>
      <label class="fl full"><span>Why it could work</span><textarea name="why" rows="2">${esc(v.why)}</textarea></label>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save angle</button></div>
  </form>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  m.querySelectorAll('[data-x]').forEach(b => b.onclick = close);
  m.onclick = e => { if (e.target === m) close(); };
  $('form', m).onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const body = { name: f.name, emotion: f.emotion, description: f.description, audience: f.audience, pain_point: f.pain_point, message: f.message,
      hooks: [f.hook0, f.hook1, f.hook2].filter(x => x.trim()), creative_types: f.creative_types.split(',').map(x => x.trim()).filter(Boolean), why: f.why };
    try {
      if (a) await api(`/api/angles/${a.id}`, { method: 'PATCH', body });
      else { const { id } = await api(`/api/products/${state.product}/angles`, { method: 'POST', body }); state.angleDraft.add(id); }
      close(); toast('Angle saved'); renderStrategy();
    } catch (err) { fail(err); }
  };
  setTimeout(() => $('[name=name]', m).focus(), 50);
}

// Step 4: the saved angles, ready for the next modules.
function drawContinueStep() {
  const chosen = state.strat.angles.filter(a => a.selected);
  $('#stratBody').innerHTML = chosen.length ? `
    <div class="card cont-hero"><div class="cont-ic">🚀</div><div><h2>${chosen.length} marketing angle${chosen.length > 1 ? 's' : ''} saved</h2>
      <p class="muted">They are kept with the product, and the footage scenes are matched with them.</p></div>
      <div class="row"><button class="btn" id="ctBack">← Change the selection</button><a class="btn primary big" href="#product/${state.product}/footage">Go to the footage library →</a></div></div>
    <div class="cont-list">${chosen.map((a, i) => `<div class="cont-item"><span>${i + 1}</span><div><b>${esc(a.name)}</b><small>“${esc(a.message)}”</small>
      <div class="cont-hooks">${a.hooks.map(h => `<em>${esc(h)}</em>`).join('')}</div></div></div>`).join('')}</div>`
    : `<div class="card s-empty"><div class="s-empty-ic">🎯</div><h2>No angle saved yet</h2><p class="muted">Select angles in step 3 and save them.</p>
      <button class="btn primary big" id="ctBack">Choose angles</button></div>`;
  $('#ctBack').onclick = () => { state.stratStep = 'angles'; drawStrategy(); };
}

// Edit product: a live preview on the left (picture, name, status, markets), the form on the right.
const REGIONS = [
  ['Southern Africa', ['ZM', 'ZW', 'MW', 'MZ', 'BW', 'NA']],
  ['East Africa', ['KE', 'TZ', 'UG', 'RW']],
  ['West & Central Africa', ['NG', 'GH', 'CI', 'SN', 'CM', 'CD']],
  ['North Africa', ['MA']],
];
function editProduct(p) {
  const draft = { name: p.name, status: p.status, link_product: p.link_product, link_alibaba: p.link_alibaba,
    markets: p.markets.map(m => ({ ...m })) };
  const pic = productPic(p);
  const m = document.createElement('div');
  m.className = 'studio-wrap center';
  document.body.appendChild(m);
  document.body.classList.add('noscroll');

  const linkField = (key, icon, label, ph) => `<div><div class="pe-lab">${label}</div>
    <div class="field"><span class="fi">${icon}</span><input type="text" data-k="${key}" value="${esc(draft[key])}" placeholder="${ph}">
      <a class="open" data-open="${key}" target="_blank" rel="noopener" ${draft[key] ? `href="${esc(draft[key])}"` : 'hidden'}>Open ↗</a></div></div>`;

  function preview() {
    $('#pePrevName').textContent = draft.name || 'Product name';
    $('#pePrevStatus').innerHTML = `<span class="pst st-${draft.status}">${P_STATUS[draft.status]}</span>`;
    $('#pePrevMk').innerHTML = draft.markets.map(x => `<span class="mkf dark">${flag(x.code)}${esc(x.code)}${x.price ? ` · ${esc(x.price)} ${esc(MARKETS[x.code]?.currency || '')}` : ''}</span>`).join('')
      || '<span class="small" style="color:#8e92a0">No market yet</span>';
  }
  function prices() {
    $('#pePrices').innerHTML = draft.markets.map(x => `<div class="price-row">${flag(x.code, 'lg')}<b>${esc(MARKETS[x.code]?.name || x.code)}</b>
      <div class="price-in"><input type="text" inputmode="decimal" data-price="${x.code}" value="${esc(x.price || '')}" placeholder="0"><span>${esc(MARKETS[x.code]?.currency || '')}</span></div></div>`).join('')
      || '<div class="st-empty">Tick the countries where you sell this product.</div>';
    m.querySelectorAll('[data-price]').forEach(inp => inp.oninput = () => {
      draft.markets.find(x => x.code === inp.dataset.price).price = inp.value.trim();
      preview();
    });
  }

  m.innerHTML = `<form class="pe" id="peForm">
    <aside class="pe-preview">
      <h3>Preview</h3>
      <label class="pe-pic">${pic ? `<img src="${pic}" alt="" id="pePicImg">` : '<span id="pePicImg">📷<br>Add a picture</span>'}
        <span class="pe-pic-btn">📷 Change picture</span><input type="file" accept="image/*" class="hidden" id="pePicIn"></label>
      <div id="pePrevStatus"></div>
      <div class="pe-name" id="pePrevName"></div>
      <div class="pe-mk" id="pePrevMk"></div>
    </aside>

    <div class="pe-form">
      <div class="pe-head"><h2>Edit product</h2><button type="button" class="btn ghost" data-x aria-label="Close">✕</button></div>
      <div class="pe-body">
        <section class="pe-sec">
          <h4><span class="ic">🏷️</span>Identity</h4>
          <div class="pe-lab">Name</div>
          <div class="field"><span class="fi">✏️</span><input type="text" data-k="name" value="${esc(draft.name)}" required placeholder="Product name"></div>
          <div class="pe-lab" style="margin-top:12px">Status</div>
          <div class="seg-ctl" id="peStatus">${Object.entries(P_STATUS).map(([k, l]) => `<button type="button" data-st="${k}" class="${k === draft.status ? 'on' : ''}">${l}</button>`).join('')}</div>
        </section>

        <section class="pe-sec">
          <h4><span class="ic">🔗</span>Links</h4>
          <div class="pe-links">
            ${linkField('link_product', '🛒', 'Product page (our store)', 'https://savaro.storeep.com/products/…')}
            ${linkField('link_alibaba', '🏭', 'Alibaba / 1688 / Amazon (where we found the product)', 'https://www.alibaba.com/… · https://detail.1688.com/… · https://www.amazon.com/…')}
          </div>
        </section>

        <section class="pe-sec">
          <h4><span class="ic">🌍</span>Markets &amp; prices<small id="peMkCount"></small></h4>
          ${REGIONS.map(([name, codes]) => `<div class="reg"><div class="reg-h">${name}</div><div class="mk-pills">
            ${codes.filter(c => MARKETS[c]).map(c => `<button type="button" class="mk-pill ${draft.markets.some(x => x.code === c) ? 'on' : ''}" data-mk="${c}">
              <span class="ck">✓</span>${flag(c)}${esc(MARKETS[c].name)}</button>`).join('')}
          </div></div>`).join('')}
          <div class="prices" id="pePrices"></div>
        </section>

      </div>
      <div class="pe-foot"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary big">Save changes</button></div>
    </div>
  </form>`;

  const close = () => { m.remove(); document.body.classList.remove('noscroll'); };
  m.querySelectorAll('[data-x]').forEach(b => b.onclick = close);
  m.onclick = e => { if (e.target === m) close(); };
  m.querySelectorAll('[data-k]').forEach(inp => inp.oninput = () => {
    draft[inp.dataset.k] = inp.value;
    const open = m.querySelector(`[data-open="${inp.dataset.k}"]`);
    if (open) { const ok = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+/.test(inp.value.trim()); open.hidden = !ok; if (ok) open.href = /^https?:/i.test(inp.value) ? inp.value : 'https://' + inp.value.trim(); }
    preview();
  });
  m.querySelectorAll('[data-st]').forEach(b => b.onclick = () => {
    draft.status = b.dataset.st;
    m.querySelectorAll('[data-st]').forEach(x => x.classList.toggle('on', x === b));
    preview();
  });
  m.querySelectorAll('[data-mk]').forEach(b => b.onclick = () => {
    const c = b.dataset.mk, i = draft.markets.findIndex(x => x.code === c);
    if (i >= 0) draft.markets.splice(i, 1); else draft.markets.push({ code: c, price: '' });
    b.classList.toggle('on', i < 0);
    $('#peMkCount').textContent = draft.markets.length ? `${draft.markets.length} selected` : '';
    prices(); preview();
  });
  $('#pePicIn').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    try {
      const r = await fetch(`/api/products/${p.id}/image`, { method: 'POST', body: fd });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Upload failed');
      const url = URL.createObjectURL(f);
      $('#pePicImg').outerHTML = `<img src="${url}" alt="" id="pePicImg">`;
      toast('Picture saved');
    } catch (err) { fail(err); }
  };
  $('#peForm').onsubmit = async e => {
    e.preventDefault();
    try {
      await api(`/api/products/${p.id}`, { method: 'PATCH', body: draft });
      close(); toast('Saved'); renderProduct(p.id); refreshSide();
    } catch (err) { fail(err); }
  };
  $('#peMkCount').textContent = draft.markets.length ? `${draft.markets.length} selected` : '';
  prices(); preview();
  setTimeout(() => m.querySelector('[data-k="name"]').focus(), 50);
}


function play(src) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<video src="${src}" controls autoplay playsinline></video>`;
  m.onclick = e => { if (e.target === m) m.remove(); };
  document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { m.remove(); document.removeEventListener('keydown', k); } });
  document.body.appendChild(m);
}

// ---------- Dashboard: real totals (nothing invented), recent products, where to go next ----------
async function renderDashboard() {
  const v = $('#view');
  const [d, list] = await Promise.all([api('/api/dashboard').catch(() => null), api('/api/products').catch(() => [])]);
  if (!d) return;
  await loadMarkets();
  v.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><div class="muted">Products, marketing angles and footage of the team</div></div>
      <button class="btn primary" id="dbNew">+ New product</button>
    </div>
    <section class="ag-hero">
      <div class="ag-hero-txt"><span class="ag-kicker">Ad creative Centre</span>
        <h2>${d.products ? `${d.products} product${d.products === 1 ? '' : 's'}` : 'Start with your first product'}</h2>
        <p>${d.products ? 'Analyse each product, choose its marketing angles, then upload its videos: the AI cuts them into scenes and matches them with the angles.' : 'Add a product, let the AI analyse it and write its marketing angles, then upload its videos.'}</p></div>
      <div class="ag-hero-stats">
        <div><b>${d.products}</b><span>Products</span></div>
        <div><b>${d.analysed}</b><span>Analysed</span></div>
        <div class="hot"><b>${d.selected}</b><span>Angles chosen</span></div>
        <div><b>${d.videos}</b><span>Videos${d.processing ? ` · ${d.processing} in work` : ''}</span></div>
        <div><b>${d.analysed_scenes}</b><span>Scenes analysed</span></div>
      </div>
    </section>
    ${d.products ? `
    <div class="ltiles" style="margin:16px 0">
      <a class="ltile" href="#angles"><span class="lt-ic" style="background:linear-gradient(135deg,#7c3aed,#c084fc)">🎯</span>
        <div><b>Marketing angles</b><small>${d.angles} written · ${d.selected} chosen</small></div><i>→</i></a>
      <a class="ltile" href="#footage"><span class="lt-ic" style="background:linear-gradient(135deg,#0ea5e9,#22d3ee)">🎞</span>
        <div><b>Footage library</b><small>${d.videos} video${d.videos === 1 ? '' : 's'} · ${d.scenes} scenes · ${d.favorites} ★</small></div><i>→</i></a>
    </div>
    <div class="plist card">
      <div class="prow phead"><div>Recent products</div><div>Status</div><div>Markets</div><div>Analysis</div><div>Angles</div><div>Footage</div><div>Activity</div></div>
      ${list.slice(0, 6).map(productRow).join('')}
    </div>` : `
    <div class="card s-empty" style="margin-top:16px"><div class="s-empty-ic">📦</div><h2>No product yet</h2>
      <p class="muted">1. Add a product (or import it from its page) · 2. Analyse it and choose its marketing angles · 3. Upload its videos</p>
      <button class="btn primary big" id="dbNew2">+ New product</button></div>`}`;
  const go = () => { state.openNew = true; location.hash = 'products'; };
  $('#dbNew').onclick = go;
  $('#dbNew2')?.addEventListener('click', go);
}

// One product line (dashboard and products list share it).
function productRow(p) {
  return `<a class="prow" href="#product/${p.id}">
    <div class="pname">${productPic(p) ? `<img src="${productPic(p)}" alt="" loading="lazy">` : '<span class="pimg-empty">🎬</span>'}<b>${esc(p.name)}</b></div>
    <div><span class="pst st-${p.status}">${P_STATUS[p.status] || esc(p.status)}</span></div>
    <div class="mks">${marketBadges(p.markets) || '<span class="muted small">–</span>'}</div>
    <div class="small">${ANALYSIS_LABEL[p.analysis_status] || '<span class="muted">–</span>'}</div>
    <div class="small">${p.angles ? `🎯 ${p.angles}${p.selected_angles ? ` · <b>${p.selected_angles} chosen</b>` : ''}` : '<span class="muted">–</span>'}</div>
    <div class="small">${p.videos ? `🎞 ${p.videos} video${p.videos > 1 ? 's' : ''} · ${p.scenes} scenes` : '<span class="muted">–</span>'}</div>
    <div class="muted small">${ago(p.last_activity)}</div>
  </a>`;
}

// ---------- Marketing angles / Footage library: every product, one click to its tab ----------
async function renderHub(kind) {
  const v = $('#view');
  await loadMarkets();
  const list = await api('/api/products').catch(fail) || [];
  const angles = kind === 'angles';
  v.innerHTML = `
    <div class="page-head">
      <div><h1>${angles ? '🎯 Marketing angles' : '🎞 Footage library'}</h1>
        <div class="muted">${angles ? 'Each product has its own analysis and angles: click a product to open them.' : 'Each product has its own videos and AI scenes: click a product to open them.'}</div></div>
    </div>
    <div class="plist card">
      <div class="prow phead"><div>Product</div><div>Status</div><div>Markets</div><div>Analysis</div><div>Angles</div><div>Footage</div><div>Activity</div></div>
      ${list.map(p => productRow(p).replace(`href="#product/${p.id}"`, `href="#product/${p.id}/${angles ? 'strategy' : 'footage'}"`)).join('')}
      ${list.length ? '' : '<div class="empty">No product yet. Add one from <b>+ New product</b>.</div>'}
    </div>`;
}

// ---------- Team ----------
async function renderTeam() {
  const v = $('#view');
  const users = await api('/api/users').catch(fail) || [];
  v.innerHTML = `
    <h1>Team</h1><p class="muted">Admins can manage the team and delete products. Members do everything else.</p>
    <div class="card">
      <table class="t"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr data-id="${u.id}">
        <td>${esc(u.name)}</td><td>${esc(u.email)}</td>
        <td><select data-role ${u.id === ME.user.id ? 'disabled' : ''}><option value="member" ${u.role === 'member' ? 'selected' : ''}>Member</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></td>
        <td>${u.active ? 'Active' : '<span style="color:var(--bad)">Disabled</span>'}</td>
        <td class="row" style="justify-content:flex-end">
          <button class="btn sm" data-pw>New password</button>
          ${u.id === ME.user.id ? '' : `<button class="btn sm ${u.active ? 'danger' : ''}" data-toggle>${u.active ? 'Disable' : 'Enable'}</button>`}
        </td></tr>`).join('')}
      </tbody></table>
    </div>
    <form class="card" id="addUser" style="margin-top:14px">
      <h2>Add a team member</h2>
      <div class="row" style="align-items:end">
        <div style="flex:1;min-width:160px"><label class="f">Name</label><input type="text" name="name" required></div>
        <div style="flex:1;min-width:200px"><label class="f">Email</label><input type="email" name="email" required></div>
        <div style="flex:1;min-width:160px"><label class="f">Password (8+)</label><input type="text" name="password" required minlength="8"></div>
        <div style="width:130px"><label class="f">Role</label><select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></div>
        <button class="btn primary">Add</button>
      </div>
    </form>`;
  $('#addUser').onsubmit = async e => {
    e.preventDefault();
    try { await api('/api/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Account created'); renderTeam(); } catch (err) { fail(err); }
  };
  v.querySelectorAll('tr[data-id]').forEach(tr => {
    const id = Number(tr.dataset.id), u = users.find(x => x.id === id);
    $('[data-role]', tr).onchange = e => api(`/api/users/${id}`, { method: 'PATCH', body: { role: e.target.value } }).then(() => toast('Role changed'), fail);
    const tg = $('[data-toggle]', tr);
    if (tg) tg.onclick = () => api(`/api/users/${id}`, { method: 'PATCH', body: { active: !u.active } }).then(renderTeam, fail);
    $('[data-pw]', tr).onclick = () => {
      const pw = prompt(`New password for ${u.name} (8 characters minimum):`);
      if (pw) api(`/api/users/${id}`, { method: 'PATCH', body: { password: pw } }).then(() => toast('Password changed'), fail);
    };
  });
}

// ---------- Footage library (Module 2): original videos, AI scenes, scene inspector ----------
const FST = { uploaded: '⬆ Uploaded', queued: '⏳ Queued', storing: '💾 Saving the original', metadata: '🔎 Extracting metadata', scenes: '✂️ Detecting scenes',
  analyzing: '🧠 Analyzing scenes', matching: '🎯 Matching marketing angles', completed: '✅ Completed', failed: '❌ Failed', cancelled: '⏹ Cancelled' };
const BUSY = ['uploaded', 'queued', 'storing', 'metadata', 'scenes', 'analyzing', 'matching'];
const fmtT = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
const fmtSize = b => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
const qClass = q => (q == null ? 'q-none' : q >= 75 ? 'q-good' : q >= 50 ? 'q-ok' : 'q-bad');
const FLAG = { watermark: ['💧', 'Watermark'], text_overlay: ['🔤', 'Text on screen'], low_quality: ['⚠', 'Low quality'], irrelevant: ['🚫', 'Not about the product'], staged: ['🎭', 'Staged / promotional (not a real customer)'] };

async function loadFootage() {
  const pid = state.product;
  const [cfg, lib, sc] = await Promise.all([
    state.footCfg ? state.footCfg : api('/api/footage/config'),
    api(`/api/products/${pid}/footage`),
    api(`/api/products/${pid}/scenes`),
  ]);
  state.footCfg = cfg;
  state.foot = { ...lib, scenes: sc.scenes, pid };
  state.fflt ??= { q: '', video: '', cat: '', angle: '', minQ: '', dur: '', aspect: '', status: '', fav: false, showExcl: false, sort: 'quality', vq: '', vstatus: '' };
}

async function renderFootage() {
  state.ftab ||= 'videos';
  const t = $('#tab');
  try { await loadFootage(); } catch (e) { fail(e); }
  const f = state.foot || { assets: [], scenes: [], totals: {} };
  const busy = f.assets.filter(a => BUSY.includes(a.status)).length;
  const analyzed = f.scenes.filter(s => s.status === 'analyzed').length;
  t.innerHTML = `
    <section class="fl-hero">
      <div class="fl-hero-txt">
        <span class="ag-kicker">Footage library</span>
        <h2>🎞 Every video of this product, cut into scenes and understood by AI</h2>
        <p>Upload once, reuse the scenes in every ad. Scenes play from a silent copy (all original sound removed); originals are kept as uploaded${state.footCfg ? ` (${state.footCfg.storage === 's3' ? 'cloud storage' : 'server storage'})` : ''}.</p>
      </div>
      <div class="ag-hero-stats fl-stats">
        <div><b>${f.assets.length}</b><span>Videos</span></div>
        <div><b>${f.scenes.length}</b><span>Scenes</span></div>
        <div class="hot"><b>${analyzed}</b><span>Analysed</span></div>
        <div><b>${f.scenes.filter(s => s.favorite).length}</b><span>★ Favourites</span></div>
        <div><b>$${(f.totals?.ai_cost || 0).toFixed(2)}</b><span>AI cost</span></div>
      </div>
    </section>
    <div class="fl-tabs">
      <a data-ft="videos" class="${state.ftab === 'videos' ? 'on' : ''}">🎬 Original videos <i>${f.assets.length}</i>${busy ? '<span class="fl-dot"></span>' : ''}</a>
      <a data-ft="scenes" class="${state.ftab === 'scenes' ? 'on' : ''}">✨ AI scenes <i>${f.scenes.length}</i></a>
    </div>
    <div id="ftabBody"></div>`;
  t.querySelectorAll('[data-ft]').forEach(a => a.onclick = () => { state.ftab = a.dataset.ft; renderFootage(); });
  if (state.ftab === 'scenes') drawScenes(); else drawVideos();
  watchFootage();
}

// While videos are processed, refresh every 2.5 s (only the lists, so typing in the filters is not lost).
function watchFootage() {
  clearInterval(state.fpoll);
  const pid = state.product;
  const busy = () => state.foot?.assets.some(a => BUSY.includes(a.status)) || ['queued', 'running'].includes(state.foot?.match_job?.status);
  if (!busy()) return;
  state.fpoll = setInterval(async () => {
    if (state.tab !== 'footage' || state.product !== pid || !location.hash.startsWith(`#product/${pid}`)) return clearInterval(state.fpoll);
    if (document.querySelector('.insp')) return; // do not redraw under the open inspector
    try { await loadFootage(); } catch { return; }
    state.ftab === 'scenes' ? drawScenes() : drawVideos();
    if (!busy()) { clearInterval(state.fpoll); renderFootage(); }
  }, 2500);
}

// ----- Original videos -----
function drawVideos() {
  const f = state.foot, cfg = state.footCfg, flt = state.fflt;
  const body = $('#ftabBody');
  if (!body) return;
  const keep = document.activeElement?.id;
  const q = flt.vq.trim().toLowerCase();
  const list = f.assets.filter(a => (!q || a.name.toLowerCase().includes(q) || a.original_name.toLowerCase().includes(q))
    && (!flt.vstatus || (flt.vstatus === 'busy' ? BUSY.includes(a.status) : a.status === flt.vstatus)));
  body.innerHTML = `
    <div class="fl-drop" id="flDrop">
      <input type="file" accept="${cfg.formats.join(',')},video/mp4,video/quicktime,video/webm" multiple class="hidden">
      <div class="fl-drop-ic">⬆</div>
      <div><b>Drop videos here, or click to choose</b>
        <small>MP4, MOV, WebM · up to ${cfg.maxMb >= 1024 ? `${(cfg.maxMb / 1024).toFixed(cfg.maxMb % 1024 ? 1 : 0)} GB` : `${cfg.maxMb} MB`} each · 20 at a time · AI analysis ≈ $${cfg.estimate30s.usd.toFixed(2)} per 30 s of video</small></div>
      <div class="fl-up hidden"><div class="fl-up-bar"><i></i></div><span>0%</span></div>
    </div>
    <div class="fl-tools">
      <input type="search" id="fvQ" placeholder="🔍 Search videos…" value="${esc(flt.vq)}">
      <select id="fvSt"><option value="">All statuses</option><option value="busy" ${flt.vstatus === 'busy' ? 'selected' : ''}>Processing</option>
        ${['completed', 'failed', 'cancelled'].map(s => `<option value="${s}" ${flt.vstatus === s ? 'selected' : ''}>${FST[s]}</option>`).join('')}</select>
      <span class="muted small">${list.length} of ${f.assets.length}</span>
    </div>
    ${list.length ? `<div class="fv-grid">${list.map(videoCard).join('')}</div>` : `<div class="empty card">${f.assets.length ? 'No video matches.' : 'No video yet. Drop your TikToks, phone or supplier videos above.'}</div>`}`;
  // Upload
  const drop = $('#flDrop'), input = $('input', drop);
  drop.onclick = e => { if (e.target !== input) input.click(); };
  input.onchange = () => uploadFootage(input.files);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); uploadFootage(e.dataTransfer.files); };
  $('#fvQ').oninput = e => { flt.vq = e.target.value; drawVideos(); };
  $('#fvSt').onchange = e => { flt.vstatus = e.target.value; drawVideos(); };
  if (keep === 'fvQ') { const i = $('#fvQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  body.querySelectorAll('.fv-card').forEach(card => {
    const a = f.assets.find(x => x.id === Number(card.dataset.id));
    const on = (sel, fn) => { const b = $(sel, card); if (b) b.onclick = e => { e.stopPropagation(); fn(b); }; };
    on('[data-play]', () => a.silent && play(`/media/footage/${a.id}/preview`));
    on('[data-rename]', async () => {
      const name = prompt('Video name:', a.name);
      if (name && name.trim() !== a.name) try { await api(`/api/footage/${a.id}`, { method: 'PATCH', body: { name } }); renderFootage(); } catch (e) { fail(e); }
    });
    on('[data-retry]', async () => { try { await api(`/api/footage/${a.id}/retry`, { method: 'POST' }); toast('Processing again'); renderFootage(); } catch (e) { fail(e); } });
    on('[data-cancel]', async () => { try { await api(`/api/footage/${a.id}/cancel`, { method: 'POST' }); toast('Stopping…'); setTimeout(renderFootage, 800); } catch (e) { fail(e); } });
    on('[data-del]', async () => {
      if (!confirm(`Delete "${a.name}" and its ${a.scenes} scenes? The original video is deleted too. This cannot be undone.`)) return;
      try { await api(`/api/footage/${a.id}`, { method: 'DELETE' }); toast('Video deleted'); renderFootage(); } catch (e) { fail(e); }
    });
    on('[data-scenes]', () => { state.fflt.video = String(a.id); state.ftab = 'scenes'; renderFootage(); });
    on('[data-log]', () => showJobLog(a));
  });
}

function videoCard(a) {
  const busy = BUSY.includes(a.status);
  const pct = Math.round((a.progress || 0) * 100);
  const chips = a.duration ? [fmtDur(a.duration), `${a.width}×${a.height}`, a.aspect, a.fps ? `${a.fps} fps` : '', a.vcodec, fmtSize(a.size), a.silent ? '🔇 Silent copy ✓' : ''].filter(Boolean) : [fmtSize(a.size)];
  return `<article class="fv-card st-${a.status}" data-id="${a.id}">
    <div class="fv-media ${a.orientation || ''}" data-play title="Preview">
      ${a.meta_done ? `<img src="/media/footage/${a.id}/thumb" alt="" loading="lazy">` : '<div class="fv-ph">🎬</div>'}
      ${a.silent ? '<span class="fv-playbtn">▶</span>' : ''}
      ${a.duration ? `<span class="fv-dur">${fmtDur(a.duration)}</span>` : ''}
      ${a.orientation ? `<span class="fv-ori">${a.orientation === 'vertical' ? '▯' : a.orientation === 'horizontal' ? '▭' : '◻'} ${esc(a.aspect)}</span>` : ''}
    </div>
    <div class="fv-body">
      <div class="fv-name"><b title="${esc(a.original_name)}">${esc(a.name)}</b><button class="icon-btn sm" data-rename title="Rename">✏️</button></div>
      <div class="fv-chips">${chips.map(c => `<span>${esc(c)}</span>`).join('')}</div>
      ${busy ? `<div class="fv-prog"><div class="fv-prog-top"><span>${FST[a.status] || a.status}</span><b>${pct}%</b></div><div class="fv-bar"><i style="width:${Math.max(4, pct)}%"></i></div>
          ${a.error ? `<small class="muted">${esc(a.error)}</small>` : ''}<button class="btn sm ghost" data-cancel>⏹ Cancel</button></div>`
        : a.status === 'failed' || a.status === 'cancelled' ? `<div class="fv-err"><span>${FST[a.status]}${a.error ? `: ${esc(a.error)}` : ''}</span><button class="btn sm" data-retry>↻ Retry</button></div>`
        : `<div class="fv-done"><span class="fv-ok">${FST.completed}</span>${a.error ? `<span class="fv-warn">${esc(a.error)}</span><button class="btn sm" data-retry>↻ Retry analysis</button>` : ''}</div>`}
    </div>
    <div class="fv-foot">
      <button class="btn sm primary" data-scenes ${a.scenes ? '' : 'disabled'}>✨ ${a.scenes} scene${a.scenes === 1 ? '' : 's'}</button>
      <span class="fv-cost" title="${a.ai_calls} AI call(s)">${a.ai_calls ? `AI $${a.ai_cost.toFixed(3)}` : ''}</span>
      <div class="fv-acts">
        <button class="icon-btn" data-log title="Processing log">📋</button>
        ${a.stored ? `<a class="icon-btn" href="/media/footage/${a.id}/original?download=1" title="Download the original" onclick="event.stopPropagation()">⬇</a>` : ''}
        <button class="icon-btn danger" data-del title="Delete">🗑</button>
      </div>
    </div>
  </article>`;
}

function uploadFootage(files) {
  if (!files?.length) return;
  const max = state.footCfg.maxMb * 1024 * 1024;
  const ok = [...files].filter(f => f.size <= max);
  if (ok.length < files.length) toast(`${files.length - ok.length} video(s) are bigger than ${state.footCfg.maxMb} MB and were skipped`, true);
  if (!ok.length) return;
  const fd = new FormData();
  for (const f of ok.slice(0, 20)) fd.append('files', f);
  const up = $('#flDrop .fl-up');
  up.classList.remove('hidden');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/products/${state.product}/footage`);
  xhr.upload.onprogress = e => { if (!e.lengthComputable) return; const p = Math.round((e.loaded / e.total) * 100); $('i', up).style.width = `${p}%`; $('span', up).textContent = p < 100 ? `Uploading ${p}%` : 'Checking the files…'; };
  xhr.onload = () => {
    const r = JSON.parse(xhr.responseText || '{}');
    if (xhr.status >= 300) { up.classList.add('hidden'); return fail(new Error(r.error || 'Upload failed')); }
    const msg = [r.added?.length ? `${r.added.length} video(s) added: processing starts now` : '',
      r.duplicates?.length ? `${r.duplicates.length} already in the library (${r.duplicates.map(d => d.existing).join(', ')})` : '',
      r.rejected?.length ? `${r.rejected.length} refused: ${r.rejected.map(x => `${x.name} (${x.reason})`).join(', ')}` : ''].filter(Boolean).join(' · ');
    toast(msg || 'Nothing added', !r.added?.length);
    renderFootage();
  };
  xhr.onerror = () => { up.classList.add('hidden'); fail(new Error('Upload failed: check your connection')); };
  xhr.send(fd);
}

async function showJobLog(a) {
  let jobs = [];
  try { jobs = await api(`/api/footage/${a.id}/jobs`); } catch (e) { return fail(e); }
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="modal-card"><h2>📋 ${esc(a.name)}</h2>
    ${jobs.map(j => `<div class="job-row"><b>${esc(j.kind)} · ${esc(j.status)}</b> <span class="muted small">attempt ${j.attempts} · ${esc(j.created_at)}</span>
      ${j.error ? `<div class="fv-warn">${esc(j.error)}</div>` : ''}<pre>${esc(j.log || '(no log yet)')}</pre></div>`).join('') || '<p class="muted">No job yet.</p>'}
    <div class="row" style="justify-content:flex-end"><button class="btn" data-x>Close</button></div></div>`;
  m.onclick = e => { if (e.target === m || e.target.dataset.x !== undefined) m.remove(); };
  document.body.appendChild(m);
}

// ----- AI scenes -----
function filteredScenes() {
  const f = state.foot, x = state.fflt;
  const q = x.q.trim().toLowerCase();
  let list = f.scenes.filter(s => (x.showExcl || !s.excluded)
    && (!x.fav || s.favorite)
    && (!x.video || s.asset_id === Number(x.video))
    && (!x.cat || s.categories.some(c => c.key === x.cat))
    && (!x.angle || s.angles.some(a => a.angle_id === Number(x.angle)))
    && (!x.minQ || (s.quality ?? -1) >= Number(x.minQ))
    && (!x.dur || (x.dur === 's' ? s.duration < 2 : x.dur === 'm' ? s.duration >= 2 && s.duration <= 5 : s.duration > 5))
    && (!x.aspect || s.aspect === x.aspect)
    && (!x.status || s.status === x.status)
    && (!q || [s.description, s.semantic, s.asset_name, ...s.tags.map(t => t.tag), ...s.categories.map(c => c.label), ...s.angles.map(a => a.name)].join(' ').toLowerCase().includes(q)));
  const by = { quality: (a, b) => (b.quality ?? -1) - (a.quality ?? -1), video: (a, b) => a.asset_id - b.asset_id || a.start - b.start, long: (a, b) => b.duration - a.duration,
    angle: (a, b) => (b.angles.find(z => z.angle_id === Number(x.angle))?.score ?? 0) - (a.angles.find(z => z.angle_id === Number(x.angle))?.score ?? 0) };
  return list.sort(by[x.sort] || by.quality);
}

function drawScenes() {
  const f = state.foot, x = state.fflt, cfg = state.footCfg;
  const body = $('#ftabBody');
  if (!body) return;
  const keep = document.activeElement?.id;
  const list = filteredScenes();
  const aspects = [...new Set(f.assets.map(a => a.aspect).filter(Boolean))];
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
  const busyMatch = f.match_job && ['queued', 'running'].includes(f.match_job.status);
  body.innerHTML = `
    ${f.angles_stale && !busyMatch ? `<div class="fl-banner">🎯 <div><b>Marketing angles changed</b><small>${f.angles_stale} analysed scene(s) were matched with older angles.</small></div><button class="btn primary sm" id="flRematch">↻ Re-match scenes</button></div>` : ''}
    ${busyMatch ? `<div class="fl-banner info"><span class="spin sm"></span><div><b>Matching scenes with the marketing angles…</b><small>${Math.round((f.match_job.progress || 0) * 100)}%</small></div></div>` : ''}
    <div class="fs-filters">
      <input type="search" id="fsQ" placeholder="🔍 Search scenes, tags, angles…" value="${esc(x.q)}">
      <select data-f="video">${opt('', 'All videos', x.video)}${f.assets.map(a => opt(a.id, a.name, x.video)).join('')}</select>
      <select data-f="cat">${opt('', 'All categories', x.cat)}${Object.entries(cfg.categories).map(([k, l]) => opt(k, l, x.cat)).join('')}</select>
      <select data-f="angle">${opt('', 'All angles', x.angle)}${f.angles.map(a => opt(a.id, `${a.selected ? '★ ' : ''}${a.name}`, x.angle)).join('')}</select>
      <select data-f="minQ">${opt('', 'Any quality', x.minQ)}${opt(40, 'Quality 40+', x.minQ)}${opt(60, 'Quality 60+', x.minQ)}${opt(80, 'Quality 80+', x.minQ)}</select>
      <select data-f="dur">${opt('', 'Any length', x.dur)}${opt('s', 'Under 2 s', x.dur)}${opt('m', '2 to 5 s', x.dur)}${opt('l', 'Over 5 s', x.dur)}</select>
      <select data-f="aspect">${opt('', 'Any format', x.aspect)}${aspects.map(a => opt(a, a, x.aspect)).join('')}</select>
      <select data-f="status">${opt('', 'Any status', x.status)}${opt('analyzed', 'Analysed', x.status)}${opt('pending', 'Waiting for AI', x.status)}${opt('failed', 'Analysis failed', x.status)}</select>
      <label class="fs-tg"><input type="checkbox" data-f="fav" ${x.fav ? 'checked' : ''}>★ Favourites</label>
      <label class="fs-tg"><input type="checkbox" data-f="showExcl" ${x.showExcl ? 'checked' : ''}>Show excluded</label>
      <select data-f="sort">${opt('quality', 'Sort: best quality', x.sort)}${opt('video', 'Sort: video order', x.sort)}${opt('long', 'Sort: longest', x.sort)}${x.angle ? opt('angle', 'Sort: angle match', x.sort) : ''}</select>
      <button class="btn sm ghost" id="fsReset">Reset</button>
    </div>
    <div class="fs-count">${list.length} scene${list.length === 1 ? '' : 's'}${list.length !== f.scenes.length ? ` of ${f.scenes.length}` : ''} · hover to play, click to open</div>
    ${list.length ? `<div class="fs-grid">${list.map(sceneCard).join('')}</div>` : `<div class="empty card">${f.scenes.length ? 'No scene matches these filters.' : 'No scene yet: upload videos in “Original videos”.'}</div>`}`;
  $('#flRematch')?.addEventListener('click', async () => { try { await api(`/api/products/${state.product}/scenes/rematch`, { method: 'POST' }); toast('Matching started'); renderFootage(); } catch (e) { fail(e); } });
  $('#fsQ').oninput = e => { x.q = e.target.value; drawScenes(); };
  if (keep === 'fsQ') { const i = $('#fsQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  body.querySelectorAll('[data-f]').forEach(el => el.onchange = () => { x[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; if (el.dataset.f === 'angle' && el.value) x.sort = 'angle'; drawScenes(); });
  $('#fsReset').onclick = () => { Object.assign(x, { q: '', video: '', cat: '', angle: '', minQ: '', dur: '', aspect: '', status: '', fav: false, showExcl: false, sort: 'quality' }); drawScenes(); };
  body.querySelectorAll('.fs-card').forEach(card => {
    const s = f.scenes.find(z => z.id === Number(card.dataset.id));
    card.onclick = () => openInspector(s.id);
    $('[data-fav]', card).onclick = async e => { e.stopPropagation(); await patchScene(s, { favorite: !s.favorite }); drawScenes(); };
    $('[data-excl]', card).onclick = async e => { e.stopPropagation(); await patchScene(s, { excluded: !s.excluded }); drawScenes(); };
    hoverPlay(card, s);
  });
}

function sceneCard(s) {
  const a = state.foot.assets.find(x => x.id === s.asset_id);
  const shown = s.angles.slice(0, 2);
  const look = s.duplicate_of ? '<span title="Same picture as another scene">⧉</span>' : s.similar_to ? '<span title="Looks like another scene">≈</span>' : '';
  return `<article class="fs-card ${s.excluded ? 'excl' : ''} ${s.favorite ? 'fav' : ''}" data-id="${s.id}">
    <div class="fs-media ${a?.orientation || ''}">
      ${s.has_thumb ? `<img src="/media/scene/${s.id}/thumb?v=${s.start}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<div class="fv-ph">⏳</div>'}
      <span class="fs-q ${qClass(s.quality)}" title="Quality score">${s.quality ?? '–'}</span>
      <span class="fv-dur">${s.duration.toFixed(1)}s</span>
      <div class="fs-flags">${s.flags.filter(k => FLAG[k]).map(k => `<span title="${FLAG[k][1]}">${FLAG[k][0]}</span>`).join('')}${look}</div>
      <button class="fs-btn fav-btn ${s.favorite ? 'on' : ''}" data-fav title="Favourite">★</button>
      <button class="fs-btn excl-btn ${s.excluded ? 'on' : ''}" data-excl title="${s.excluded ? 'Use it again' : 'Exclude from future ads'}">🚫</button>
      ${s.status === 'pending' ? '<div class="fs-state"><span class="spin sm"></span> Waiting for AI</div>' : s.status === 'failed' ? `<div class="fs-state bad">❌ ${esc(s.error || 'Analysis failed')}</div>` : ''}
      ${s.excluded ? '<div class="fs-state excl">Excluded</div>' : ''}
    </div>
    <div class="fs-body">
      <div class="fs-time">${fmtT(s.start)} → ${fmtT(s.end)} <span>· ${esc(s.asset_name)}</span></div>
      <p class="fs-desc">${esc(s.description || (s.status === 'analyzed' ? '' : 'Not analysed yet'))}</p>
      <div class="fs-cats">${s.categories.slice(0, 3).map(c => `<span>${esc(c.label)}</span>`).join('')}${s.categories.length > 3 ? `<span>+${s.categories.length - 3}</span>` : ''}</div>
      ${shown.length ? `<div class="fs-angles">${shown.map(x => `<span title="${esc(x.reason)}"><b>${x.score}%</b> ${esc(x.name)}</span>`).join('')}</div>` : ''}
    </div>
  </article>`;
}

// Hovering a scene plays just its seconds of the video (the original is never cut).
function hoverPlay(card, s) {
  const box = $('.fs-media', card);
  let v = null, t = null;
  card.onmouseenter = () => {
    t = setTimeout(() => {
      v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.src = `/media/footage/${s.asset_id}/preview#t=${s.start.toFixed(2)},${s.end.toFixed(2)}`;
      v.className = 'fs-hover';
      v.onloadedmetadata = () => { v.currentTime = s.start; v.play().catch(() => {}); };
      v.ontimeupdate = () => { if (v.currentTime >= s.end - 0.05 || v.currentTime < s.start - 0.3) v.currentTime = s.start; };
      box.appendChild(v);
    }, 250);
  };
  card.onmouseleave = () => { clearTimeout(t); if (v) { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); v = null; } };
}

async function patchScene(s, body) {
  try {
    const n = await api(`/api/scenes/${s.id}`, { method: 'PATCH', body });
    Object.assign(s, n);
    return n;
  } catch (e) { fail(e); }
}

// ----- Scene inspector -----
async function openInspector(id) {
  let s;
  try { s = await api(`/api/scenes/${id}`); } catch (e) { return fail(e); }
  const cfg = state.footCfg, f = state.foot;
  const a = f.assets.find(x => x.id === s.asset_id) || {};
  const d = s.details || {};
  const qp = d.quality_parts || {};
  const draft = {
    categories: new Set(s.categories.map(c => c.key)), tags: s.tags.map(t => t.tag),
    placements: new Map(s.placements.map(p => [p.placement, p.fit])), angles: s.angles.map(x => ({ ...x })),
  };
  document.querySelector('.insp')?.remove();
  const m = document.createElement('div');
  m.className = 'modal insp';
  const bar = (label, v) => `<div class="ib-row"><span>${label}</span><div class="ib-bar"><i class="${qClass(v)}" style="width:${v ?? 0}%"></i></div><b>${v ?? '–'}</b></div>`;
  const list = (arr) => (arr?.length ? arr.map(x => `<span>${esc(x)}</span>`).join('') : '<em>none</em>');
  const ORIGIN = { real_customer_style: 'Looks like a real customer video', staged_or_promotional: 'Staged / promotional footage (never use as a customer testimonial)', synthetic_or_cgi: 'Synthetic / CGI footage', unclear: 'Unclear' };
  const draw = () => {
    m.innerHTML = `<div class="insp-card">
      <header class="insp-head">
        <div><span class="ag-kicker">Scene ${s.id} · ${esc(s.asset_name)}</span><h2>${fmtT(s.start)} → ${fmtT(s.end)} <small>${s.duration.toFixed(2)} s</small></h2></div>
        <div class="insp-head-btns">
          <button class="btn sm ${s.favorite ? 'on-fav' : ''}" data-act="fav">★ ${s.favorite ? 'Favourite' : 'Add to favourites'}</button>
          <button class="btn sm ${s.excluded ? 'on-excl' : ''}" data-act="excl">🚫 ${s.excluded ? 'Excluded' : 'Exclude'}</button>
          <button class="icon-btn" data-act="close" title="Close">✕</button>
        </div>
      </header>
      <div class="insp-body">
        <div class="insp-left">
          <div class="insp-player ${a.orientation || ''}"><video id="ipV" src="/media/footage/${s.asset_id}/preview" playsinline controls></video></div>
          <div class="insp-tl" id="ipTl" title="Whole video: the coloured part is this scene">
            <i class="tl-scene" style="left:${(s.start / (a.duration || s.end)) * 100}%;width:${(s.duration / (a.duration || s.end)) * 100}%"></i><i class="tl-head" id="ipHead"></i>
          </div>
          <div class="insp-time"><span id="ipNow">${fmtT(s.start)}</span><label class="fs-tg"><input type="checkbox" id="ipLoop" checked> Loop this scene</label></div>
          <div class="insp-edit">
            <button class="btn sm" data-act="split" title="Cut the scene in two at the current time">✂ Split here</button>
            <button class="btn sm" data-act="start" title="The scene starts at the current time">⇤ Start here</button>
            <button class="btn sm" data-act="end" title="The scene ends at the current time">End here ⇥</button>
            <button class="btn sm" data-act="merge" title="Join with the next scene of the video">⤳ Merge with next</button>
            <button class="btn sm" data-act="reanalyze" title="Ask the AI again (costs a little)">↻ Re-analyse</button>
          </div>
          <div class="insp-trim"><label>Start <input type="number" step="0.1" min="0" id="ipS" value="${s.start.toFixed(2)}"></label><label>End <input type="number" step="0.1" min="0" id="ipE" value="${s.end.toFixed(2)}"></label><button class="btn sm" data-act="trim">Save times</button></div>
          <p class="muted small">Edits only change the scene's times: the original video is never modified.</p>
        </div>
        <div class="insp-right">
          ${s.status !== 'analyzed' ? `<div class="fl-banner ${s.status === 'failed' ? '' : 'info'}">${s.status === 'failed' ? '❌' : '<span class="spin sm"></span>'}<div><b>${s.status === 'failed' ? 'Analysis failed' : 'Waiting for the AI analysis'}</b><small>${esc(s.error || 'It updates by itself.')}</small></div></div>` : ''}
          <div class="insp-score">
            <div class="big-q ${qClass(s.quality)}"><b>${s.quality ?? '–'}</b><span>quality</span></div>
            <div><p>${esc(s.quality_note || 'No quality note yet.')}</p>
              <div class="insp-pills">${s.relevance != null ? `<span>🎯 Relevance ${s.relevance}/100</span>` : ''}${s.flags.map(k => FLAG[k] ? `<span>${FLAG[k][0]} ${FLAG[k][1]}</span>` : '').join('')}
                ${s.duplicate_of ? `<span>⧉ Same picture as scene ${s.duplicate_of}</span>` : s.similar_to ? `<span>≈ Looks like scene ${s.similar_to}</span>` : ''}</div></div>
          </div>
          <section><h4>Description <small>AI suggestion: edit freely</small></h4>
            <textarea id="ipDesc" rows="3">${esc(s.description)}</textarea>
            <label class="small muted">Short line for matching with the voice-over</label><input id="ipSem" value="${esc(s.semantic)}"></section>
          <section><h4>What the AI sees</h4><div class="insp-facts">
            <div><span>Objects</span><p class="tags">${list(d.objects)}</p></div>
            <div><span>Features shown</span><p class="tags">${list(d.features_shown)}</p></div>
            <div><span>Benefits shown</span><p class="tags">${list(d.benefits_supported)}</p></div>
            <div><span>People & product</span><p>${esc(d.human_interaction || '—')}</p></div>
            <div><span>Place</span><p>${esc(d.environment || '—')}</p></div>
            <div><span>Camera</span><p>${esc(d.camera_movement || '—')}</p></div>
            <div><span>Composition</span><p>${esc(d.composition || '—')}</p></div>
            <div><span>Text on screen</span><p class="tags">${list(d.text_overlays)}</p></div>
            <div><span>Watermark</span><p>${d.watermark ? (d.watermark.present ? `Yes${d.watermark.text ? `: ${esc(d.watermark.text)}` : ''}` : 'No') : '—'}</p></div>
            <div><span>Footage type</span><p>${esc(ORIGIN[d.origin] || '—')}</p></div>
            ${d.relevance_note ? `<div class="wide"><span>Why this relevance</span><p>${esc(d.relevance_note)}</p></div>` : ''}
          </div></section>
          <section><h4>Quality details</h4><div class="insp-bars">
            <div><small class="muted">AI judgment</small>${bar('Sharpness', qp.sharpness)}${bar('Lighting', qp.lighting)}${bar('Stability', qp.stability)}${bar('Product visible', qp.product_visibility)}${bar('Composition', qp.composition)}</div>
            <div><small class="muted">Measured on the frames</small>${bar('Sharpness', s.measured.sharpness)}${bar('Brightness', s.measured.brightness)}${bar('Contrast', s.measured.contrast)}${bar('Movement', s.measured.motion)}${bar('Picture score', s.measured.score)}</div>
          </div></section>
          <section><h4>Categories <small>click to change</small></h4><div class="chip-pick" id="ipCats">${Object.entries(cfg.categories).map(([k, l]) => `<button class="${draft.categories.has(k) ? 'on' : ''}" data-cat="${k}">${esc(l)}</button>`).join('')}</div></section>
          <section><h4>Tags</h4><div class="tag-edit" id="ipTags">${draft.tags.map((t, i) => `<span>${esc(t)}<button data-tdel="${i}">✕</button></span>`).join('')}<input id="ipTagIn" placeholder="＋ add a tag, Enter"></div></section>
          <section><h4>Where it fits in an ad</h4><div class="chip-pick" id="ipPl">${Object.entries(cfg.placements).map(([k, l]) => `<button class="${draft.placements.has(k) ? 'on' : ''}" data-pl="${k}">${esc(l)}${draft.placements.has(k) ? ` <i>${draft.placements.get(k)}%</i>` : ''}</button>`).join('')}</div></section>
          <section><h4>Marketing angles it supports</h4>
            <div class="ang-links" id="ipAng">${draft.angles.map((x, i) => `<div class="al-row"><b>${esc(x.name)}</b><input type="range" min="0" max="100" step="5" value="${x.score}" data-asc="${i}"><span>${x.score}%</span><button class="icon-btn sm" data-adel="${i}" title="Remove">✕</button>${x.reason ? `<small>${esc(x.reason)}</small>` : ''}</div>`).join('') || '<p class="muted small">No angle linked.</p>'}</div>
            ${f.angles.filter(an => !draft.angles.some(x => x.angle_id === an.id)).length ? `<select id="ipAddAng"><option value="">＋ Link an angle…</option>${f.angles.filter(an => !draft.angles.some(x => x.angle_id === an.id)).map(an => `<option value="${an.id}">${esc(an.name)}</option>`).join('')}</select>` : ''}
          </section>
        </div>
      </div>
      <footer class="insp-foot"><span class="muted small">${s.edited ? '✏️ Edited by the team · ' : ''}${s.model ? `Analysed by ${esc(s.model)}` : ''}</span><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="save">Save changes</button></footer>
    </div>`;
    wire();
  };
  const v = () => $('#ipV', m);
  const reload = async () => { try { await loadFootage(); } catch {} m.remove(); renderFootageKeep(); };
  const act = async (name) => {
    const t = v()?.currentTime ?? s.start;
    try {
      if (name === 'close') { m.remove(); return renderFootageKeep(); }
      if (name === 'fav' || name === 'excl') { Object.assign(s, await api(`/api/scenes/${s.id}`, { method: 'PATCH', body: name === 'fav' ? { favorite: !s.favorite } : { excluded: !s.excluded } })); return draw(); }
      if (name === 'split') { await api(`/api/scenes/${s.id}/split`, { method: 'POST', body: { at: t } }); toast('Scene split in two: the AI analyses both parts'); return reload(); }
      if (name === 'merge') { if (!confirm('Join this scene with the next scene of the video?')) return; await api(`/api/scenes/${s.id}/merge`, { method: 'POST' }); toast('Scenes merged: the AI analyses the new scene'); return reload(); }
      if (name === 'start' || name === 'end') { $(name === 'start' ? '#ipS' : '#ipE', m).value = t.toFixed(2); return; }
      if (name === 'trim') {
        await api(`/api/scenes/${s.id}/trim`, { method: 'POST', body: { start: Number($('#ipS', m).value), end: Number($('#ipE', m).value) } });
        toast('Times saved'); return reload();
      }
      if (name === 'reanalyze') { await api(`/api/scenes/${s.id}/reanalyze`, { method: 'POST' }); toast('The AI analyses this scene again'); return reload(); }
      if (name === 'save') {
        await api(`/api/scenes/${s.id}`, { method: 'PATCH', body: {
          description: $('#ipDesc', m).value, semantic: $('#ipSem', m).value, categories: [...draft.categories], tags: draft.tags,
          placements: [...draft.placements].map(([placement, fit]) => ({ placement, fit })),
          angles: draft.angles.map(x => ({ angle_id: x.angle_id, score: x.score, reason: x.reason })),
        } });
        toast('Scene saved'); return reload();
      }
    } catch (e) { fail(e); }
  };
  const wire = () => {
    m.querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act));
    const vid = v();
    vid.onloadedmetadata = () => { vid.currentTime = s.start; };
    vid.ontimeupdate = () => {
      const dur = a.duration || vid.duration || 1;
      $('#ipHead', m).style.left = `${(vid.currentTime / dur) * 100}%`;
      $('#ipNow', m).textContent = fmtT(vid.currentTime);
      if ($('#ipLoop', m).checked && (vid.currentTime >= s.end - 0.03 || vid.currentTime < s.start - 0.25)) { vid.currentTime = s.start; }
    };
    $('#ipTl', m).onclick = e => { const r = e.currentTarget.getBoundingClientRect(); $('#ipLoop', m).checked = false; vid.currentTime = ((e.clientX - r.left) / r.width) * (a.duration || vid.duration); };
    $('#ipCats', m).querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { const k = b.dataset.cat; draft.categories.has(k) ? draft.categories.delete(k) : draft.categories.add(k); b.classList.toggle('on'); });
    $('#ipPl', m).querySelectorAll('[data-pl]').forEach(b => b.onclick = () => { const k = b.dataset.pl; draft.placements.has(k) ? draft.placements.delete(k) : draft.placements.set(k, 70); keepDraw(); });
    $('#ipTags', m).querySelectorAll('[data-tdel]').forEach(b => b.onclick = () => { draft.tags.splice(Number(b.dataset.tdel), 1); keepDraw(); });
    $('#ipTagIn', m).onkeydown = e => { if (e.key === 'Enter' && e.target.value.trim()) { draft.tags.push(e.target.value.trim().toLowerCase().slice(0, 40)); keepDraw(); setTimeout(() => $('#ipTagIn', m)?.focus(), 0); } };
    m.querySelectorAll('[data-asc]').forEach(r => r.oninput = () => { draft.angles[Number(r.dataset.asc)].score = Number(r.value); r.nextElementSibling.textContent = `${r.value}%`; });
    m.querySelectorAll('[data-adel]').forEach(b => b.onclick = () => { draft.angles.splice(Number(b.dataset.adel), 1); keepDraw(); });
    $('#ipAddAng', m)?.addEventListener('change', e => { const an = f.angles.find(x => x.id === Number(e.target.value)); if (an) { draft.angles.push({ angle_id: an.id, name: an.name, score: 70, reason: '' }); keepDraw(); } });
  };
  // Redraw while keeping the typed text and the video position.
  const keepDraw = () => {
    const desc = $('#ipDesc', m)?.value, sem = $('#ipSem', m)?.value, t = v()?.currentTime, sc = $('.insp-right', m)?.scrollTop;
    s.description = desc ?? s.description; s.semantic = sem ?? s.semantic;
    draw();
    if (t != null) { const vid = v(); vid.onloadedmetadata = () => { vid.currentTime = t; }; }
    $('.insp-right', m).scrollTop = sc || 0;
  };
  m.onclick = e => { if (e.target === m) { m.remove(); renderFootageKeep(); } };
  document.addEventListener('keydown', function k(e) { if (e.key === 'Escape' && document.body.contains(m)) { m.remove(); document.removeEventListener('keydown', k); renderFootageKeep(); } });
  document.body.appendChild(m);
  draw();
}
// Back to the list after the inspector (keeps the scenes tab and filters).
function renderFootageKeep() { if (state.tab === 'footage') renderFootage(); }


start().catch(() => {});

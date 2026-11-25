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
  cnt('#cntProducts', s.products); cnt('#cntTeam', s.team); cnt('#cntProjects', s.projects);
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
  clearTimeout(state.sbTimer);
  if (state.cp && view !== 'project') { cpFlush(); state.cp = null; } // leaving a project: send unsaved changes
  const nav = view === 'product' ? (tab === 'strategy' ? 'angles' : tab === 'footage' ? 'footage' : 'products') : view === 'project' ? 'projects' : view;
  document.querySelectorAll('.side-nav a').forEach(a => a.classList.toggle('on', a.dataset.go === nav));
  document.querySelectorAll('.side-p').forEach(a => a.classList.toggle('on', view === 'product' && a.getAttribute('href') === `#product/${id}`));
  if (view === 'team' && ME.user.role === 'admin') return renderTeam();
  if (view === 'product' && id) { state.tab = TABS.some(([k]) => k === tab) ? tab : 'overview'; return renderProduct(Number(id)); }
  if (view === 'products') return renderProducts();
  if (view === 'angles') return renderHub('angles');
  if (view === 'footage') return renderHub('footage');
  if (view === 'projects') return renderProjects();
  if (view === 'project' && id === 'new') return renderNewProject();
  if (view === 'project' && id) return renderProjectPage(Number(id), tab);
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
          <a class="ltile" href="#projects" data-cpprod="${p.id}"><span class="lt-ic" style="background:linear-gradient(135deg,#ff4d2e,#ff9a3d)">🎬</span>
            <div><b>Creative projects</b><small>${c.projects} project${c.projects === 1 ? '' : 's'} for this product</small></div><i>→</i></a>
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
  $('#tab').querySelector('[data-cpprod]')?.addEventListener('click', () => { state.cpFilter = { q: '', product: String(p.id), country: '', type: '', status: '' }; });
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
      <a class="ltile" href="#projects"><span class="lt-ic" style="background:linear-gradient(135deg,#ff4d2e,#ff9a3d)">🎬</span>
        <div><b>Creative projects</b><small>${d.projects} project${d.projects === 1 ? '' : 's'} · ${d.ready_projects} brief${d.ready_projects === 1 ? '' : 's'} saved</small></div><i>→</i></a>
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

// ---------- Creative projects (Module 3): list, new project, 6-step workflow, Creative Brief ----------
const CP_STEPS = [['product', 'Product', '📦'], ['angles', 'Marketing angles', '🎯'], ['footage', 'Footage', '🎞'], ['type', 'Creative type', '🎬'], ['settings', 'Settings', '⚙️'], ['review', 'Review & save', '✅'], ['script', 'Script & storyboard', '📝'], ['audio', 'Audio studio', '🎙']];
const CP_STATUS = { draft: '📝 Draft', ready: '✅ Brief saved' };
const AIR = 'ai_recommended';
let REG = null;
const loadRegistry = async () => (REG ??= await api('/api/creative/registry'));
const typeName = id => (id === AIR ? '✨ AI Recommended' : REG?.types.find(t => t.id === id)?.name || id);

// ----- List -----
async function renderProjects() {
  const v = $('#view');
  await Promise.all([loadRegistry(), loadMarkets()]);
  const f = state.cpFilter ??= { q: '', product: '', country: '', type: '', status: '' };
  const [list, products] = await Promise.all([
    api('/api/creative-projects?' + new URLSearchParams(Object.entries(f).filter(([, x]) => x))).catch(e => { fail(e); return []; }),
    api('/api/products').catch(() => []),
  ]);
  const opt = (val, label, cur) => `<option value="${esc(val)}" ${String(cur) === String(val) ? 'selected' : ''}>${esc(label)}</option>`;
  v.innerHTML = `
    <div class="page-head">
      <div><h1>🎬 Creative projects</h1><div class="muted">Set up an ad project from a product, its angles and its footage, then save its Creative Brief.</div></div>
      <button class="btn primary" id="cpNew">+ New creative project</button>
    </div>
    <div class="fs-filters" style="position:static">
      <input type="search" id="cpQ" placeholder="🔍 Search projects…" value="${esc(f.q)}">
      <select data-cf="product">${opt('', 'All products', f.product)}${products.map(p => opt(p.id, p.name, f.product)).join('')}</select>
      <select data-cf="country">${opt('', 'All countries', f.country)}${Object.entries(MARKETS || {}).map(([k, m]) => opt(k, m.name, f.country)).join('')}</select>
      <select data-cf="type">${opt('', 'All creative types', f.type)}${[AIR, ...REG.types.map(t => t.id)].map(t => opt(t, typeName(t), f.type)).join('')}</select>
      <select data-cf="status">${opt('', 'Any status', f.status)}${Object.entries(CP_STATUS).map(([k, l]) => opt(k, l, f.status)).join('')}</select>
    </div>
    <div class="plist card">
      <div class="prow phead cp-row"><div>Project</div><div>Product</div><div>Creative types</div><div>Market</div><div>Videos</div><div>Status</div><div>Updated</div></div>
      ${list.map(p => `<a class="prow cp-row" href="#project/${p.id}/${p.status === 'ready' ? 'review' : p.step}">
          <div><b>${esc(p.name)}</b><small class="muted">by ${esc(p.author)}</small></div>
          <div class="pname">${p.product_image ? `<img src="/media/product/${p.product_id}/image?v=${encodeURIComponent(p.product_image)}" alt="" loading="lazy">` : '<span class="pimg-empty">🎬</span>'}<span>${esc(p.product_name)}</span></div>
          <div class="small">${p.types.length ? p.types.map(typeName).join(', ') : '<span class="muted">–</span>'}</div>
          <div class="small">${p.country ? `${flag(p.country)} ${esc(p.country)} · ${esc((ME.languages[p.language] || p.language || '').slice(0, 10))}` : '<span class="muted">–</span>'}</div>
          <div class="small">${p.variations || 1} · ${esc(p.aspect || '')} · ${p.duration || ''}s</div>
          <div><span class="pst ${p.status === 'ready' ? 'st-scaling' : 'st-idea'}">${CP_STATUS[p.status]}${p.brief_version ? ` · v${p.brief_version}` : ''}</span></div>
          <div class="muted small">${ago(p.updated_at)}</div></a>`).join('')}
      ${list.length ? '' : `<div class="empty">${Object.values(f).some(Boolean) ? 'No project matches.' : 'No creative project yet. Click <b>+ New creative project</b>.'}</div>`}
    </div>`;
  $('#cpNew').onclick = () => { location.hash = 'project/new'; };
  $('#cpQ').onchange = e => { f.q = e.target.value; renderProjects(); };
  v.querySelectorAll('[data-cf]').forEach(s => s.onchange = () => { f[s.dataset.cf] = s.value; renderProjects(); });
}

// ----- New project: pick a product (everything else is loaded from Module 1 and 2) -----
async function renderNewProject() {
  const v = $('#view');
  await loadMarkets();
  const products = await api('/api/products').catch(e => { fail(e); return []; });
  v.innerHTML = `
    <a class="back" href="#projects">← Creative projects</a>
    <div class="page-head"><div><h1>New creative project</h1><div class="muted">Step 1: choose the product. Its information, angles and footage are loaded from Modules 1 and 2.</div></div></div>
    ${products.length ? `<div class="cp-products">${products.map(p => `<button class="cp-prod" data-pid="${p.id}">
        ${productPic(p) ? `<img src="${productPic(p)}" alt="">` : '<span class="pimg-empty">🎬</span>'}
        <div><b>${esc(p.name)}</b><small>${p.country ? `${flag(p.country)} ${esc(MARKETS?.[p.country]?.name || p.country)} · ` : ''}${esc(ME.languages[p.language] || '')}</small>
          <small>🎯 ${p.angles} angles${p.selected_angles ? ` (${p.selected_angles} chosen)` : ''} · 🎞 ${p.videos} videos · ✨ ${p.scenes} scenes</small></div></button>`).join('')}</div>`
      : '<div class="card s-empty"><div class="s-empty-ic">📦</div><h2>No product yet</h2><p class="muted">Add a product first, analyse it and upload its footage.</p><a class="btn primary big" href="#products">Go to products</a></div>'}`;
  v.querySelectorAll('[data-pid]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { const { id } = await api('/api/creative-projects', { method: 'POST', body: { product_id: Number(b.dataset.pid) } }); location.hash = `project/${id}/angles`; refreshSide(); }
    catch (e) { fail(e); b.disabled = false; }
  });
}

// ----- One project: the workflow -----
async function renderProjectPage(id, step) {
  await Promise.all([loadRegistry(), loadMarkets(), state.footCfg ? null : api('/api/footage/config').then(c => { state.footCfg = c; }).catch(() => {})]);
  try { state.cp = await api(`/api/creative-projects/${id}`); } catch (e) { fail(e); location.hash = 'projects'; return; }
  state.cpStep = CP_STEPS.some(([k]) => k === step) ? step : state.cp.settings.step || 'angles';
  if (state.cp.settings.step !== state.cpStep && state.cp.can_edit) cpSave({ settings: { step: state.cpStep } }, { quiet: true, redraw: false });
  drawProject();
}

// Autosave: changes are merged and sent shortly after; the page redraws with the new validation.
let cpTimer = null, cpPending = null;
function cpSave(patch, { quiet = false, redraw = true, now = false } = {}) {
  if (!state.cp?.can_edit) return Promise.resolve();
  const merge = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a?.[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], v) : v;
    return out;
  };
  cpPending = merge(cpPending || {}, patch);
  const mark = $('#cpSaved'); if (mark && !quiet) mark.textContent = 'Saving…';
  clearTimeout(cpTimer);
  return new Promise(resolve => {
    cpTimer = setTimeout(async () => {
      const body = cpPending; cpPending = null;
      try {
        state.cp = await api(`/api/creative-projects/${state.cp.project.id}`, { method: 'PATCH', body });
        const m2 = $('#cpSaved'); if (m2) m2.textContent = '✓ Draft saved';
        if (redraw) drawProject(true);
      } catch (e) { fail(e); }
      resolve();
    }, now ? 0 : 500);
  });
}
const cpFlush = () => (cpPending ? cpSave({}, { now: true }) : Promise.resolve());

function drawProject(keepScroll = false) {
  const st = state.cp, s = st.settings, p = st.product;
  const v = $('#view');
  const y = window.scrollY, active = document.activeElement?.id;
  const errs = st.validation.errors, warns = st.validation.warnings;
  const stepIssues = k => errs.filter(e => e.step === k).length;
  const done = { product: true, angles: st.angle_ids.length > 0, footage: st.footage.used_ids.length > 0, type: s.types.length > 0, settings: !errs.some(e => e.step === 'settings'), review: st.project.status === 'ready', script: false, audio: false };
  v.innerHTML = `
    <a class="back" href="#projects">← Creative projects</a>
    <section class="ag-hero cp-hero">
      <div class="ag-hero-txt"><span class="ag-kicker">Creative project · ${esc(p.name)}</span>
        <h2><input id="cpName" class="cp-name" value="${esc(st.project.name)}" ${st.can_edit ? '' : 'disabled'} aria-label="Project name"></h2>
        <p>${CP_STATUS[st.project.status]}${st.briefs[0] ? ` · Brief v${st.briefs[0].version} saved ${ago(st.briefs[0].created_at)}` : ''} · <span id="cpSaved">${st.can_edit ? 'Changes are saved automatically' : 'View only: only its author or an admin can change it'}</span></p></div>
      <div class="ag-hero-stats">
        <div><b>${st.angle_ids.length}</b><span>Angles</span></div>
        <div><b>${st.footage.used_ids.length}</b><span>Scenes</span></div>
        <div><b>${s.types.length}</b><span>Types</span></div>
        <div class="hot"><b>${st.variations.count}</b><span>Videos planned</span></div>
      </div>
      <div class="ag-hero-btns">
        <button class="btn" id="cpDup" title="Copy the project (no media copied)">⧉ Duplicate</button>
        ${st.can_edit ? '<button class="btn" id="cpDel" title="Delete the project">🗑</button><button class="btn" id="cpDraft">💾 Save draft</button>' : ''}
      </div>
    </section>
    <div class="sstepper">
      ${CP_STEPS.map(([k, l, ic], i) => `<button class="sstep ${state.cpStep === k ? 'on' : ''} ${done[k] && state.cpStep !== k ? 'done' : ''}" data-cpstep="${k}">
        <span class="sstep-n">${done[k] && state.cpStep !== k ? '✓' : i + 1}</span><span class="sstep-t"><small>Step ${i + 1}${stepIssues(k) ? ` · <b style="color:var(--bad)">${stepIssues(k)} to fix</b>` : ''}</small>${ic} ${l}</span></button>
        ${i < CP_STEPS.length - 1 ? '<span class="sstep-line"></span>' : ''}`).join('')}
    </div>
    <div id="cpBody"></div>
    <div class="cp-nav">
      ${state.cpStep !== 'product' ? '<button class="btn" id="cpPrev">← Back</button>' : '<span></span>'}
      <span class="muted small">${errs.length ? `⛔ ${errs.length} blocking · ` : ''}${warns.length ? `⚠ ${warns.length} warning${warns.length > 1 ? 's' : ''}` : errs.length ? '' : '✓ Ready'}</span>
      ${state.cpStep === 'audio' ? '<span></span>' : state.cpStep !== 'review' ? '<button class="btn primary big" id="cpNext">Next →</button>' : `<div class="row"><button class="btn primary big" id="cpBrief" ${st.can_edit && !errs.length ? '' : 'disabled'}>✅ Save Creative Brief</button>${st.briefs.length ? '<button class="btn big" id="cpToScript">📝 Script & storyboard →</button>' : ''}</div>`}
    </div>`;
  const go = async k => { await cpFlush(); state.cpStep = k; location.hash = `project/${st.project.id}/${k}`; };
  v.querySelectorAll('[data-cpstep]').forEach(b => b.onclick = () => go(b.dataset.cpstep));
  const idx = CP_STEPS.findIndex(([k]) => k === state.cpStep);
  $('#cpPrev')?.addEventListener('click', () => go(CP_STEPS[idx - 1][0]));
  $('#cpNext')?.addEventListener('click', () => go(CP_STEPS[idx + 1][0]));
  $('#cpBrief')?.addEventListener('click', cpSaveBrief);
  $('#cpToScript')?.addEventListener('click', () => go('script'));
  $('#cpName').onchange = e => cpSave({ name: e.target.value });
  $('#cpDraft')?.addEventListener('click', async () => { await cpFlush(); await cpSave({ settings: { step: state.cpStep } }, { now: true }); toast('Draft saved'); });
  $('#cpDup').onclick = async () => { try { await cpFlush(); const { id } = await api(`/api/creative-projects/${st.project.id}/duplicate`, { method: 'POST' }); toast('Project duplicated (no media copied)'); location.hash = `project/${id}/review`; } catch (e) { fail(e); } };
  $('#cpDel')?.addEventListener('click', async () => {
    if (!confirm(`Delete the project "${st.project.name}" and its saved briefs? Products and footage are not touched.`)) return;
    try { await api(`/api/creative-projects/${st.project.id}`, { method: 'DELETE' }); toast('Project deleted'); location.hash = 'projects'; refreshSide(); } catch (e) { fail(e); }
  });
  ({ product: cpProduct, angles: cpAngles, footage: cpFootage, type: cpType, settings: cpSettings, review: cpReview, script: cpScript, audio: cpAudio })[state.cpStep]();
  const onStep = v.querySelector('.sstep.on'); if (onStep) onStep.parentElement.scrollLeft = Math.max(0, onStep.offsetLeft - 60);
  if (!st.can_edit) $('#cpBody').querySelectorAll('input, select, textarea, button:not([data-view])').forEach(x => { x.disabled = true; });
  if (keepScroll) { window.scrollTo(0, y); if (active) { const el = document.getElementById(active); if (el && el.type !== 'checkbox') { el.focus(); if (el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length); } } }
}

// Problems of a step, shown at its top.
const cpIssues = step => {
  const { errors, warnings } = state.cp.validation;
  const e = errors.filter(x => x.step === step), w = warnings.filter(x => x.step === step);
  return e.length || w.length ? `<div class="cp-issues">${e.map(x => `<div class="cp-err">⛔ ${esc(x.message)}</div>`).join('')}${w.map(x => `<div class="cp-warn">⚠ ${esc(x.message)}</div>`).join('')}</div>` : '';
};

// AI recommendations card (steps angles, type, settings, review).
function cpRecoCard(focus) {
  const st = state.cp, r = st.recommendations;
  const accept = (label, act, on) => `<button class="btn sm ${on ? 'ghost' : ''}" data-racc="${act}" ${on ? 'disabled' : ''}>${on ? '✓ Applied' : label}</button>`;
  const s = st.settings;
  const rows = !r ? '' : [
    focus !== 'settings' && r.angles.length ? `<div class="rc-row"><b>🎯 Angles</b><div>${r.angles.map(a => `<p><span>${esc(st.angles.find(x => x.id === a.id)?.name || a.id)}</span> ${esc(a.reason)}</p>`).join('')}</div>${accept('Use these angles', 'angles', r.angles.every(a => st.angle_ids.includes(a.id)))}</div>` : '',
    focus !== 'angles' && r.creative_types.length ? `<div class="rc-row"><b>🎬 Creative types</b><div>${r.creative_types.map(t => `<p><span>${esc(typeName(t.id))}</span> ${esc(t.reason)}</p>`).join('')}</div>${accept('Use these types', 'types', r.creative_types.every(t => s.types.includes(t.id)))}</div>` : '',
    focus === 'settings' || focus === 'review' ? [
      `<div class="rc-row"><b>⏱ Duration</b><div><p><span>${r.duration.value} s</span> ${esc(r.duration.reason)}</p></div>${accept('Apply', 'duration', s.duration === r.duration.value)}</div>`,
      `<div class="rc-row"><b>🎞 Pace</b><div><p><span>${esc(REG.paces[r.pace.value])}</span> ${esc(r.pace.reason)}</p></div>${accept('Apply', 'pace', s.pace === r.pace.value)}</div>`,
      `<div class="rc-row"><b>🎙 Tone</b><div><p><span>${esc(REG.tones[r.tone.value])}</span> ${esc(r.tone.reason)}</p></div>${accept('Apply', 'tone', s.tone === r.tone.value)}</div>`,
      `<div class="rc-row"><b>🪝 Hooks</b><div>${r.hook_styles.map(h => `<p><span>${esc(REG.hookStyles[h.value])}</span> ${esc(h.reason)}</p>`).join('')}</div>${accept('Apply', 'hooks', r.hook_styles.every(h => s.hook_styles.includes(h.value)))}</div>`,
    ].join('') : '',
    r.scene_categories.length && focus !== 'angles' ? `<div class="rc-row"><b>🎞 Footage to favour</b><div>${r.scene_categories.map(c => `<p><span>${esc(state.footCfg?.categories?.[c.value] || c.value)}</span> ${esc(c.reason)}</p>`).join('')}</div><span></span></div>` : '',
  ].join('');
  return `<section class="card cp-reco">
    <div class="sec-h"><div><h2>✨ AI recommendations</h2><small>${r ? esc(r.summary) : 'Based on the product analysis and the footage that really exists.'}</small></div>
      <div class="row">${r ? `<button class="btn sm primary" data-racc="all">Apply all</button>` : ''}<button class="btn sm ${r ? '' : 'primary'}" id="cpReco" ${st.ai ? '' : 'disabled title="AI is not set up"'}>${r ? '↻ Refresh' : '✨ Get recommendations'}</button></div></div>
    ${rows}
  </section>`;
}
function cpWireReco() {
  const st = state.cp, r = st.recommendations;
  $('#cpReco')?.addEventListener('click', async e => {
    const b = e.currentTarget; b.disabled = true; b.innerHTML = '<span class="spin sm"></span> Thinking…';
    try { await cpFlush(); const out = await api(`/api/creative-projects/${st.project.id}/recommendations`, { method: 'POST', body: { force: !!r } }); state.cp = out.state; toast(out.recommendations.cached ? 'Recommendations (unchanged inputs, no new AI call)' : 'Recommendations ready'); drawProject(true); }
    catch (err) { fail(err); b.disabled = false; b.textContent = '✨ Get recommendations'; }
  });
  document.querySelectorAll('[data-racc]').forEach(b => b.onclick = () => {
    const a = b.dataset.racc, s = st.settings, patch = { settings: {} };
    const all = a === 'all';
    if (all || a === 'angles') patch.angle_ids = [...new Set([...r.angles.map(x => x.id), ...(all ? [] : st.angle_ids)])];
    if (all || a === 'types') patch.settings.types = [...new Set([...r.creative_types.map(t => t.id), ...s.types.filter(t => t !== AIR && !all)])];
    if (all || a === 'duration') patch.settings.duration = r.duration.value;
    if (all || a === 'pace') patch.settings.pace = r.pace.value;
    if (all || a === 'tone') patch.settings.tone = r.tone.value;
    if (all || a === 'hooks') patch.settings.hook_styles = r.hook_styles.map(h => h.value);
    if (!Object.keys(patch.settings).length) delete patch.settings;
    cpSave(patch, { now: true }).then(() => toast(all ? 'All recommendations applied' : 'Applied'));
  });
}

// Step 1: product (read-only: it comes from Module 1)
function cpProduct() {
  const st = state.cp, p = st.product, fs = st.footage.status;
  $('#cpBody').innerHTML = `
    <section class="card cp-prodcard">
      ${productPic(p) ? `<img src="${productPic(p)}" alt="">` : '<span class="pimg-empty big">🎬</span>'}
      <div><h2>${esc(p.name)}</h2>
        <p class="muted">${p.country ? `${flag(p.country)} ${esc(MARKETS?.[p.country]?.name || p.country)}` : 'No target country'} · ${esc(ME.languages[p.language] || p.language)} · ${esc(p.price || 'no price')}${p.offer ? ` · 🏷 ${esc(p.offer)}` : ''}</p>
        <div class="cp-facts">
          <span>🧠 ${st.analysis ? 'Analysed' : 'Not analysed'}</span><span>🎯 ${st.angles.length} angles · ${st.angles.filter(a => a.selected).length} chosen</span>
          <span>🎞 ${fs.videos} video${fs.videos === 1 ? '' : 's'}${fs.processing ? ` (${fs.processing} in work)` : ''}</span><span>✨ ${fs.analysed}/${fs.scenes} scenes analysed</span><span>🔇 ${fs.eligible} production-ready</span>
        </div>
        <p class="small muted">The product information comes from Module 1: edit it on the product page. To use another product, create a new project.</p>
        <div class="row"><a class="btn sm" href="#product/${p.id}/strategy">Open its marketing angles</a><a class="btn sm" href="#product/${p.id}/footage">Open its footage library</a></div>
      </div>
    </section>
    ${!st.analysis || !st.angles.length ? '<div class="cp-issues"><div class="cp-warn">⚠ The product has no analysis or no marketing angles yet: open its Marketing angles tab (Module 1) first.</div></div>' : ''}
    ${!fs.eligible ? `<div class="cp-issues"><div class="cp-err">⛔ No analysed, silent footage yet. <a href="#product/${p.id}/footage">Upload and analyse videos in its Footage library (Module 2) →</a></div></div>` : ''}`;
}

// Step 2: marketing angles
function cpAngles() {
  const st = state.cp, sel = new Set(st.angle_ids), rec = new Set((st.recommendations?.angles || []).map(a => a.id));
  $('#cpBody').innerHTML = `${cpIssues('angles')}${cpRecoCard('angles')}
    <div class="ag-tools"></div>
    ${st.angles.length ? `<div class="angles">${st.angles.map((a, i) => `<article class="angle th${i % 8} ${sel.has(a.id) ? 'on' : ''}" data-cpang="${a.id}">
        <header class="ang-head"><span class="ang-num">${String(i + 1).padStart(2, '0')}</span>
          <div class="ang-title"><h3>${esc(a.name)}</h3>${rec.has(a.id) ? '<span class="ang-emo">✨ AI recommends</span>' : a.emotion ? `<span class="ang-emo">${esc(a.emotion)}</span>` : ''}</div>
          <span class="ang-check">${sel.has(a.id) ? '✓' : '＋'}</span></header>
        <div class="ang-msg"><span>Selling message</span><p>${esc(a.message)}</p></div>
        <div class="ang-in"><p class="ang-desc">${esc(a.description)}</p>
          <div class="ang-hooks"><span>🎬 Suggested opening lines</span>${a.hooks.map(h => `<p><b>▶</b>${esc(h)}</p>`).join('')}</div></div>
        <footer class="ang-actions"><span class="small"><b>${st.angleScenes[a.id] || 0}</b> relevant scene${st.angleScenes[a.id] === 1 ? '' : 's'}</span><span class="ang-pick">${sel.has(a.id) ? '✓ Selected' : 'Click to select'}</span></footer>
      </article>`).join('')}</div>`
      : `<div class="card s-empty"><div class="s-empty-ic">🎯</div><h2>No marketing angle yet</h2><p class="muted">Analyse the product and write its angles first.</p><a class="btn primary big" href="#product/${st.product.id}/strategy">Open Marketing angles</a></div>`}
    ${st.angles.length && state.cp.can_edit ? `<details class="card cp-custom"><summary><b>＋ Add a custom marketing angle</b> <small class="muted">saved with the product (Module 1)</small></summary>
      <form id="cpAngForm"><label class="f">Name</label><input name="name" required maxlength="80" placeholder="e.g. The gift she wears every day">
        <label class="f">Main selling message</label><input name="message" required maxlength="200">
        <label class="f">Description</label><textarea name="description" rows="2"></textarea>
        <button class="btn primary" style="margin-top:10px">Add the angle</button></form></details>` : ''}`;
  cpWireReco();
  $('#cpBody').querySelectorAll('[data-cpang]').forEach(c => c.onclick = () => {
    const id = Number(c.dataset.cpang);
    const ids = sel.has(id) ? st.angle_ids.filter(x => x !== id) : [...st.angle_ids, id];
    cpSave({ angle_ids: ids }, { now: true });
  });
  $('#cpAngForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const { id } = await api(`/api/products/${st.product.id}/angles`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      await cpSave({ angle_ids: [...st.angle_ids, id] }, { now: true }); toast('Custom angle added');
    } catch (err) { fail(err); }
  });
}

// Step 3: footage
function cpFootage() {
  const st = state.cp, s = st.settings, f = st.footage;
  const cats = state.footCfg?.categories || {};
  state.cp.footCats = cats;
  const inc = new Set(f.include), exc = new Set(f.exclude), used = new Set(f.used_ids);
  const flt = state.cpSceneFlt ??= { cat: '' };
  const shown = f.scenes.filter(x => !flt.cat || x.categories.includes(flt.cat));
  const modes = { auto: ['🤖', 'Automatic Selection', 'The future AI Creative Director picks the best scenes for each angle, type and quality.'], favorites: ['★', 'Favorites Only', 'Only scenes marked as favourites in the Footage library.'], manual: ['✋', 'Manual Selection', 'Pick the scenes yourself.'] };
  $('#cpBody').innerHTML = `${cpIssues('footage')}
    <div class="cp-modes">${Object.entries(modes).map(([k, [ic, t, d]]) => `<button class="cp-mode ${s.footage_mode === k ? 'on' : ''}" data-fmode="${k}"><i>${ic}</i><div><b>${t}</b><small>${d}</small></div></button>`).join('')}</div>
    <p class="small muted">Only analysed scenes from silent copies are listed (no original sound). Scenes excluded in the Footage library are never used. ${f.status.eligible} production-ready scene(s) · <b>${used.size}</b> used by this project.</p>
    ${f.scenes.length ? `<div class="fs-filters" style="position:static"><select id="cpCat"><option value="">All categories</option>${Object.entries(cats).map(([k, l]) => `<option value="${k}" ${flt.cat === k ? 'selected' : ''}>${esc(l)} (${f.categories[k] || 0})</option>`).join('')}</select>
      ${s.footage_mode === 'manual' ? '<button class="btn sm" id="cpAllIn">Select all shown</button><button class="btn sm" id="cpNoneIn">Clear</button>' : ''}</div>
      <div class="fs-grid">${shown.map(x => {
        const on = used.has(x.id), manual = s.footage_mode === 'manual';
        return `<article class="fs-card cp-scene ${on ? 'cp-on' : 'excl'}" data-scid="${x.id}">
          <div class="fs-media ${x.orientation || ''}"><img src="/media/scene/${x.id}/thumb?v=${x.start}" alt="" loading="lazy">
            <span class="fs-q ${qClass(x.quality)}">${x.quality ?? '–'}</span><span class="fv-dur">${x.duration.toFixed(1)}s</span>
            ${x.favorite ? '<span class="fs-flags"><span>★</span></span>' : ''}
            <span class="cp-tick">${on ? '✓' : manual ? '＋' : '🚫'}</span></div>
          <div class="fs-body"><div class="fs-time">${fmtT(x.start)} → ${fmtT(x.end)} <span>· ${esc(x.asset_name)}</span></div>
            <p class="fs-desc">${esc(x.description || '')}</p>
            <div class="fs-cats">${x.categories.slice(0, 3).map(c => `<span>${esc(cats[c] || c)}</span>`).join('')}</div>
            ${x.angles.filter(a => st.angle_ids.includes(a.angle_id)).length ? `<div class="fs-angles">${x.angles.filter(a => st.angle_ids.includes(a.angle_id)).map(a => `<span><b>${a.score}%</b> ${esc(st.angles.find(z => z.id === a.angle_id)?.name || '')}</span>`).join('')}</div>` : ''}
            <button class="btn sm" data-view="${x.id}">▶ Preview</button>
            <small class="muted">${manual ? (on ? 'Selected: click to remove' : 'Click to select') : (on ? 'Used: click to leave it out' : 'Left out: click to use it')}</small></div>
        </article>`;
      }).join('')}</div>` : `<div class="card s-empty"><div class="s-empty-ic">🎞</div><h2>No production-ready footage</h2><p class="muted">Upload videos and let the AI analyse them first.</p><a class="btn primary big" href="#product/${st.product.id}/footage">Open the Footage library</a></div>`}`;
  $('#cpBody').querySelectorAll('[data-fmode]').forEach(b => b.onclick = () => cpSave({ settings: { footage_mode: b.dataset.fmode } }, { now: true }));
  $('#cpCat')?.addEventListener('change', e => { flt.cat = e.target.value; cpFootage(); });
  const setScenes = (i, e) => cpSave({ scenes: { include: [...i], exclude: [...e] } }, { now: true });
  $('#cpAllIn')?.addEventListener('click', () => { shown.forEach(x => inc.add(x.id)); setScenes(inc, exc); });
  $('#cpNoneIn')?.addEventListener('click', () => setScenes([], exc));
  $('#cpBody').querySelectorAll('[data-scid]').forEach(c => c.onclick = e => {
    const id = Number(c.dataset.scid);
    if (e.target.closest('[data-view]')) { const x = f.scenes.find(z => z.id === id); return playScene(x); }
    if (!st.can_edit) return;
    if (s.footage_mode === 'manual') { inc.has(id) ? inc.delete(id) : inc.add(id); exc.delete(id); }
    else { exc.has(id) ? exc.delete(id) : exc.add(id); }
    setScenes(inc, exc);
  });
}
// Plays just the seconds of a scene from the silent copy.
function playScene(x) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<video src="/media/footage/${x.asset_id}/preview#t=${x.start},${x.end}" controls autoplay muted playsinline></video>`;
  const vid = $('video', m);
  vid.onloadedmetadata = () => { vid.currentTime = x.start; };
  vid.ontimeupdate = () => { if (vid.currentTime >= x.end) vid.currentTime = x.start; };
  m.onclick = e => { if (e.target === m) m.remove(); };
  document.body.appendChild(m);
}

// Step 4: creative types
function cpType() {
  const st = state.cp, s = st.settings, chosen = new Set(s.types), rec = new Map((st.recommendations?.creative_types || []).map(t => [t.id, t.reason]));
  const card = (t, i) => {
    const sup = st.typeSupport[t.id] || 0, noOffer = t.requiresOffer && !s.market.offer;
    return `<article class="cp-type ${chosen.has(t.id) ? 'on' : ''}" data-ctype="${t.id}">
      <div class="cp-type-h"><i>${t.icon}</i><div><b>${esc(t.name)}</b><small>${esc(t.description)}</small></div><span class="ang-check">${chosen.has(t.id) ? '✓' : '＋'}</span></div>
      <div class="cp-struct">${t.structure.map(b => `<span title="${esc(b.purpose)}">${esc(b.label)}</span>`).join('<i>→</i>')}</div>
      <div class="cp-type-f">
        <span class="${sup ? 'ok' : 'bad'}">${sup ? `🎞 ${sup} matching scene${sup > 1 ? 's' : ''}` : `⚠ No ${esc(t.needs.label)}`}</span>
        ${noOffer ? '<span class="bad">🏷 Needs a real offer</span>' : ''}${rec.has(t.id) ? `<span class="ok" title="${esc(rec.get(t.id))}">✨ AI recommends</span>` : ''}
      </div>
      ${t.rules.length ? `<p class="small muted">${t.rules.map(esc).join(' ')}</p>` : ''}
    </article>`;
  };
  $('#cpBody').innerHTML = `${cpIssues('type')}${cpRecoCard('type')}
    <div class="cp-types">
      <article class="cp-type ai ${chosen.has(AIR) ? 'on' : ''}" data-ctype="${AIR}">
        <div class="cp-type-h"><i>✨</i><div><b>AI Recommended</b><small>The AI picks the types that fit the product, the angles and the footage you really have.${st.recommendations ? ` Now: ${st.recommendations.creative_types.map(t => esc(typeName(t.id))).join(', ') || 'none'}.` : ' Get the recommendations to see them.'}</small></div><span class="ang-check">${chosen.has(AIR) ? '✓' : '＋'}</span></div>
      </article>
      ${REG.types.map(card).join('')}
    </div>
    <p class="small muted">You can choose several types: with the strategy "Different Creative Types", the videos are split between them. These structures guide the future scripts and storyboards.</p>`;
  cpWireReco();
  $('#cpBody').querySelectorAll('[data-ctype]').forEach(c => c.onclick = () => {
    const id = c.dataset.ctype;
    cpSave({ settings: { types: chosen.has(id) ? s.types.filter(x => x !== id) : [...s.types, id] } }, { now: true });
  });
}

// Step 5: settings
function cpSettings() {
  const st = state.cp, s = st.settings, m = s.market, d = st.productDefaults, pl = st.plan;
  const opt = (val, label, cur) => `<option value="${esc(val)}" ${String(cur) === String(val) ? 'selected' : ''}>${esc(label)}</option>`;
  const chips = (key, values, cur, multi = false) => `<div class="chip-pick">${Object.entries(values).map(([k, l]) => `<button type="button" class="${(multi ? cur.includes(k) : cur === k) ? 'on' : ''}" data-chip="${key}" data-val="${k}">${k === AIR ? '✨ ' : ''}${esc(l)}</button>`).join('')}</div>`;
  const inh = (k, label) => (String(m[k] ?? '') === String(d[k] ?? '') ? `<small class="cp-inh">from the product</small>` : `<small class="cp-inh own">project only · <a data-reset="${k}">use the product's: ${esc(d[k] || 'empty')}</a></small>`);
  const platDef = REG.platforms[s.platform]?.defaults;
  const platDiff = platDef && (platDef.aspect !== s.aspect || platDef.duration !== s.duration || platDef.pace !== s.pace);
  const cod = m.cod;
  $('#cpBody').innerHTML = `${cpIssues('settings')}${cpRecoCard('settings')}
    <section class="card cp-sec"><h3>🌍 Target market</h3>
      <div class="cp-grid">
        <label>Country ${inh('country')}<select data-m="country">${opt('', '—', m.country)}${Object.entries(MARKETS || {}).map(([k, x]) => opt(k, x.name, m.country)).join('')}</select></label>
        <label>Language ${inh('language')}<select data-m="language">${Object.entries(ME.languages).map(([k, l]) => opt(k, l, m.language)).join('')}</select></label>
        <label>Regional variant / dialect<input data-m="dialect" list="cpDialects" value="${esc(m.dialect)}" placeholder="optional"><datalist id="cpDialects">${(REG.dialects[m.language] || []).map(x => `<option value="${esc(x)}">`).join('')}</datalist></label>
        <label>Currency ${inh('currency')}<input data-m="currency" value="${esc(m.currency)}" maxlength="8"></label>
        <label>Selling price ${inh('price')}<input data-m="price" value="${esc(m.price)}" placeholder="e.g. 780"></label>
        <label class="wide">Promotional offer (only a real one) ${inh('offer')}<input data-m="offer" value="${esc(m.offer)}" placeholder="e.g. Buy 2, get the 3rd free"></label>
      </div>
      <div class="cp-confirm"><span class="small muted">Confirmed conditions (only these may be said in the ads):</span>
        ${[['cod', 'Cash on delivery'], ['free_delivery', 'Free delivery'], ['limited_stock', 'Limited stock'], ['guarantee', 'Guarantee']].map(([k, l]) => `<label class="fs-tg"><input type="checkbox" data-mc="${k}" ${m[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>
    </section>

    <section class="card cp-sec"><h3>📱 Platform, duration & format</h3>
      ${chips('platform', Object.fromEntries(Object.entries(REG.platforms).map(([k, x]) => [k, x.name])), s.platform)}
      ${platDiff ? `<p class="small">Suggested for ${esc(REG.platforms[s.platform].name)}: ${platDef.aspect} · ${platDef.duration} s · ${esc(REG.paces[platDef.pace])} pace <button class="btn sm" id="cpPlatDef">Apply</button></p>` : ''}
      <h4>Target duration</h4>
      <div class="chip-pick">${REG.durations.map(x => `<button type="button" class="${s.duration === x ? 'on' : ''}" data-dur="${x}">${x} s</button>`).join('')}
        <label class="fs-tg">Custom <input type="number" id="cpDur" min="${REG.limits.minDuration}" max="${REG.limits.maxDuration}" value="${s.duration}" style="width:80px"> s</label></div>
      <h4>Aspect ratio</h4>
      <div class="cp-aspects">${Object.entries(REG.aspects).map(([k, a]) => { const [w, h] = a.sizes['1080p']; return `<button type="button" class="cp-asp ${s.aspect === k ? 'on' : ''}" data-asp="${k}"><span style="aspect-ratio:${w}/${h}"></span><b>${k}</b><small>${esc(a.name.split(' ')[0])}</small></button>`; }).join('')}</div>
      <div class="row"><span class="small">Output resolution:</span>${REG.resolutions.map(r => { const [w, h] = REG.aspects[s.aspect].sizes[r]; return `<label class="fs-tg"><input type="radio" name="cpRes" value="${r}" ${s.resolution === r ? 'checked' : ''}> ${r} (${w}×${h})</label>`; }).join('')}</div>
    </section>

    <section class="card cp-sec"><h3>🎨 Style</h3>
      <h4>Advertising tone</h4>${chips('tone', REG.tones, s.tone)}
      <h4>Editing pace</h4>${chips('pace', REG.paces, s.pace)}
      <h4>Hook style <small class="muted">one or several</small></h4>${chips('hook_styles', REG.hookStyles, s.hook_styles, true)}
      <label class="f">Custom hook (optional)</label><input id="cpHook" value="${esc(s.custom_hook)}" maxlength="200" placeholder="e.g. Still looking for the perfect gift?">
      <h4>Call to action</h4>
      <div class="chip-pick">${REG.ctas.map(c => { const blocked = c.needs === 'cod' && !cod; return `<button type="button" class="${s.cta === c.text ? 'on' : ''}" data-cta="${esc(c.text)}" ${blocked ? 'disabled title="Confirm cash on delivery in Target market first"' : ''}>${esc(c.text)}</button>`; }).join('')}</div>
      <input id="cpCta" value="${esc(s.cta)}" maxlength="120" placeholder="Write your own call to action">
    </section>

    <details class="card cp-sec" ${state.cpAdv ? 'open' : ''} id="cpAdv"><summary><h3 style="display:inline">🎛 Production preferences</h3> <small class="muted">preferences only: nothing is generated in this module</small></summary>
      <div class="cp-toggles">${Object.entries(REG.production).map(([k, x]) => `<label class="cp-toggle"><input type="checkbox" data-prod="${k}" ${s.production[k] ? 'checked' : ''}><span></span>${esc(x.label)}</label>`).join('')}
        <label class="cp-toggle locked"><input type="checkbox" disabled><span></span>Original footage sound <small>always off</small></label></div>
    </details>

    <section class="card cp-sec"><h3>🔁 Variations</h3>
      <div class="chip-pick">${REG.variationCounts.map(x => `<button type="button" class="${st.variations.count === x ? 'on' : ''}" data-vc="${x}">${x} video${x > 1 ? 's' : ''}</button>`).join('')}
        <label class="fs-tg">Custom <input type="number" id="cpVc" min="1" max="${REG.limits.maxVariations}" value="${st.variations.count}" style="width:80px"></label></div>
      <h4>Variation strategies</h4>
      <div class="chip-pick">${Object.entries(REG.strategies).map(([k, l]) => `<button type="button" class="${st.variations.strategies.includes(k) ? 'on' : ''}" data-vs="${k}">${esc(l)}</button>`).join('')}</div>
      <div class="cp-plan"><p>${esc(pl.explanation)}</p>
        <table><thead><tr><th>Angle</th><th>Creative type</th><th>Videos</th></tr></thead><tbody>
          ${pl.combos.map((c, i) => `<tr><td>${c.angle_ids.map(a => esc(st.angles.find(x => x.id === a)?.name || a)).join(' + ') || '—'}</td><td>${c.types.map(t => esc(typeName(t))).join(' + ') || '—'}</td>
            <td><input type="number" min="0" max="${REG.limits.maxVariations}" value="${c.count}" data-dist="${i}" style="width:70px"></td></tr>`).join('')}
        </tbody><tfoot><tr><td colspan="2">Total ${pl.custom ? '(your distribution)' : '(automatic)'}</td><td><b class="${pl.total === st.variations.count ? '' : 'bad'}">${pl.total} / ${st.variations.count}</b></td></tr></tfoot></table>
        ${pl.custom ? '<button class="btn sm" id="cpDistAuto">↺ Back to automatic</button>' : ''}
        <p class="small muted">The number of variations is the total number of videos. Videos must differ in a meaningful way (not only cosmetic changes). Bulk generation comes in Module 9.</p></div>
    </section>`;
  cpWireReco();
  const b = $('#cpBody');
  b.querySelectorAll('[data-m]').forEach(i => i.onchange = () => cpSave({ settings: { market: { [i.dataset.m]: i.value, ...(i.dataset.m === 'country' && MARKETS?.[i.value] ? { currency: MARKETS[i.value].currency } : {}) } } }));
  b.querySelectorAll('[data-reset]').forEach(a => a.onclick = () => cpSave({ settings: { market: { [a.dataset.reset]: d[a.dataset.reset] } } }, { now: true }));
  b.querySelectorAll('[data-mc]').forEach(i => i.onchange = () => cpSave({ settings: { market: { [i.dataset.mc]: i.checked } } }, { now: true }));
  b.querySelectorAll('[data-chip]').forEach(x => x.onclick = () => {
    const k = x.dataset.chip, val = x.dataset.val;
    if (k === 'hook_styles') {
      let cur = s.hook_styles.includes(val) ? s.hook_styles.filter(h => h !== val) : [...s.hook_styles, val];
      if (val === AIR && cur.includes(AIR)) cur = [AIR];
      else if (val !== AIR) cur = cur.filter(h => h !== AIR);
      return cpSave({ settings: { hook_styles: cur } }, { now: true });
    }
    cpSave({ settings: { [k]: val } }, { now: true });
  });
  $('#cpPlatDef')?.addEventListener('click', () => cpSave({ settings: { aspect: platDef.aspect, duration: platDef.duration, pace: platDef.pace } }, { now: true }));
  b.querySelectorAll('[data-dur]').forEach(x => x.onclick = () => cpSave({ settings: { duration: Number(x.dataset.dur) } }, { now: true }));
  $('#cpDur').onchange = e => cpSave({ settings: { duration: Number(e.target.value) } }, { now: true });
  b.querySelectorAll('[data-asp]').forEach(x => x.onclick = () => cpSave({ settings: { aspect: x.dataset.asp } }, { now: true }));
  b.querySelectorAll('[name=cpRes]').forEach(x => x.onchange = () => cpSave({ settings: { resolution: x.value } }, { now: true }));
  $('#cpHook').onchange = e => cpSave({ settings: { custom_hook: e.target.value } });
  b.querySelectorAll('[data-cta]').forEach(x => x.onclick = () => cpSave({ settings: { cta: x.dataset.cta } }, { now: true }));
  $('#cpCta').onchange = e => cpSave({ settings: { cta: e.target.value } });
  $('#cpAdv').ontoggle = e => { state.cpAdv = e.target.open; };
  b.querySelectorAll('[data-prod]').forEach(i => i.onchange = () => cpSave({ settings: { production: { [i.dataset.prod]: i.checked } } }, { now: true }));
  const vars = (patch) => cpSave({ variations: { count: st.variations.count, strategies: st.variations.strategies, distribution: pl.custom ? pl.combos.map(c => ({ key: c.key, count: c.count })) : null, ...patch } }, { now: true });
  b.querySelectorAll('[data-vc]').forEach(x => x.onclick = () => vars({ count: Number(x.dataset.vc), distribution: null }));
  $('#cpVc').onchange = e => vars({ count: Number(e.target.value), distribution: null });
  b.querySelectorAll('[data-vs]').forEach(x => x.onclick = () => {
    const k = x.dataset.vs, cur = st.variations.strategies;
    vars({ strategies: cur.includes(k) ? cur.filter(y => y !== k) : [...cur, k], distribution: null });
  });
  b.querySelectorAll('[data-dist]').forEach(i => i.onchange = () => vars({ distribution: pl.combos.map((c, k) => ({ key: c.key, count: k === Number(i.dataset.dist) ? Number(i.value) : c.count })) }));
  $('#cpDistAuto')?.addEventListener('click', () => vars({ distribution: null }));
}

// Step 6: review
function cpReview() {
  const st = state.cp, s = st.settings, m = s.market, v = st.validation, pl = st.plan;
  const val = (key, labels) => (s[key] === AIR ? (st.recommendations?.[key]?.value ? `✨ ${esc(labels[st.recommendations[key].value])} (AI)` : '✨ AI Recommended (get the recommendations)') : esc(labels[s[key]]));
  const row = (k, x) => `<div><span>${k}</span><p>${x}</p></div>`;
  $('#cpBody').innerHTML = `
    ${v.errors.length ? `<div class="cp-issues">${v.errors.map(e => `<div class="cp-err">⛔ ${esc(e.message)} <a data-goto="${e.step}">Fix →</a></div>`).join('')}</div>` : '<div class="cp-issues"><div class="cp-ok">✓ No blocking problem: the Creative Brief can be saved.</div></div>'}
    ${v.warnings.length ? `<div class="cp-issues">${v.warnings.map(w => `<div class="cp-warn">⚠ ${esc(w.message)} <a data-goto="${w.step}">See →</a></div>`).join('')}</div>` : ''}
    ${cpRecoCard('review')}
    <section class="card"><div class="sec-h"><div><h2>📋 Configuration summary</h2><small>This becomes the Creative Brief: the single source for scripts, storyboards, voice-over and editing.</small></div></div>
      <div class="insp-facts">
        ${row('Product', `${esc(st.product.name)}`)}
        ${row('Marketing angles', st.angle_ids.map(id => esc(st.angles.find(a => a.id === id)?.name || id)).join(', ') || '—')}
        ${row('Footage', `${esc(REG.footageModes[s.footage_mode])} · ${st.footage.used_ids.length} scene(s), silent copies only`)}
        ${row('Creative types', s.types.map(typeName).join(', ') || '—')}
        ${row('Market', `${esc(MARKETS?.[m.country]?.name || m.country || '—')} · ${esc(ME.languages[m.language] || m.language)}${m.dialect ? ` (${esc(m.dialect)})` : ''} · ${esc([m.price, m.currency].filter(Boolean).join(' ') || 'no price')}${m.offer ? ` · 🏷 ${esc(m.offer)}` : ''}`)}
        ${row('Confirmed', [m.cod && 'Cash on delivery', m.free_delivery && 'Free delivery', m.limited_stock && 'Limited stock', m.guarantee && 'Guarantee'].filter(Boolean).join(', ') || 'nothing')}
        ${row('Platform & format', `${esc(REG.platforms[s.platform]?.name)} · ${s.duration} s · ${s.aspect} · ${s.resolution} (${REG.aspects[s.aspect].sizes[s.resolution].join('×')})`)}
        ${row('Tone · pace', `${val('tone', REG.tones)} · ${val('pace', REG.paces)}`)}
        ${row('Hooks', s.hook_styles.map(h => esc(REG.hookStyles[h])).join(', ') + (s.custom_hook ? ` · “${esc(s.custom_hook)}”` : ''))}
        ${row('Call to action', esc(s.cta || '—'))}
        ${row('Production', Object.entries(s.production).filter(([, x]) => x).map(([k]) => esc(REG.production[k].label)).join(', ') + ' · original sound: never')}
        <div class="wide"><span>Variations</span><p>${esc(pl.explanation)}</p><p class="small">${pl.lines.map(esc).join(' · ')}</p></div>
      </div>
    </section>
    <section class="card"><div class="sec-h"><div><h2>🗂 Saved Creative Briefs</h2><small>Each save is a new, frozen version. Product edits never change a saved brief.</small></div>
      <button class="btn sm" data-view="preview">👁 Preview the brief (JSON)</button></div>
      ${st.briefs.length ? `<div class="cp-briefs">${st.briefs.map(b => `<div><b>Version ${b.version}</b><span class="muted small">${esc(b.created_at)} · schema ${esc(b.schema_version)}</span><button class="btn sm" data-view="${b.version}">View</button></div>`).join('')}</div>` : '<p class="muted small">No brief saved yet.</p>'}
    </section>`;
  cpWireReco();
  $('#cpBody').querySelectorAll('[data-goto]').forEach(a => a.onclick = () => { location.hash = `project/${st.project.id}/${a.dataset.goto}`; });
  $('#cpBody').querySelectorAll('[data-view]').forEach(b => b.onclick = async () => {
    try {
      const x = b.dataset.view === 'preview' ? await api(`/api/creative-projects/${st.project.id}/brief/preview`) : (await api(`/api/creative-projects/${st.project.id}/brief?version=${b.dataset.view}`)).brief;
      const m2 = document.createElement('div');
      m2.className = 'modal';
      m2.innerHTML = `<div class="modal-card" style="width:min(900px,100%)"><div class="sec-h"><div><h2>${b.dataset.view === 'preview' ? 'Brief preview (not saved)' : `Creative Brief v${b.dataset.view}`}</h2></div><button class="btn sm" data-x>Close</button></div><pre class="cp-json">${esc(JSON.stringify(x, null, 2))}</pre></div>`;
      m2.onclick = e => { if (e.target === m2 || e.target.dataset.x !== undefined) m2.remove(); };
      document.body.appendChild(m2);
    } catch (e) { fail(e); }
  });
}

async function cpSaveBrief() {
  const st = state.cp;
  await cpFlush();
  const b = $('#cpBrief'); if (b) { b.disabled = true; b.innerHTML = '<span class="spin sm"></span> Saving…'; }
  const r = await fetch(`/api/creative-projects/${st.project.id}/brief`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { fail(new Error(j.error || 'Could not save')); state.cp = await api(`/api/creative-projects/${st.project.id}`); return drawProject(true); }
  state.cp = j.state; toast(`Creative Brief v${j.version} saved`); drawProject(true); refreshSide();
}

// ---------- Script & storyboard (Module 4): step 7 of a creative project ----------
const SB_ROLES = { hook: 'Hook', problem: 'Problem', intro: 'Product Introduction', solution: 'Solution', demonstration: 'Demonstration', feature: 'Feature', benefit: 'Benefit', objection: 'Objection Handling', offer: 'Offer', cta: 'CTA', supporting: 'Supporting Visual' };
const SB_STATUS = { draft: 'Draft', generating_strategy: 'Generating strategy…', generating_hooks: 'Generating hooks…', generating_script: 'Writing the script…', matching_footage: 'Matching footage…', generating_storyboard: 'Building the storyboard…', validating: 'Validating…', ready: 'Ready for review', approved: 'Approved', failed: 'Failed' };
const SB_TRANS = { hard_cut: 'Hard cut', smooth_cut: 'Smooth cut', fade: 'Fade', crossfade: 'Crossfade' };
const SB_MOTION = { none: 'No motion', subtle_zoom_in: 'Subtle zoom in', subtle_zoom_out: 'Subtle zoom out', reframe: 'Reframe' };
const SB_CROP = { none: 'No crop', product_focus: 'Product-focused crop', center: 'Center', top: 'Top', bottom: 'Bottom' };
const busyJob = sb => ['queued', 'running'].includes(sb?.job?.status);

async function cpScript() {
  const st = state.cp, body = $('#cpBody');
  if (!st.briefs.length) {
    body.innerHTML = `<div class="card s-empty"><div class="s-empty-ic">📝</div><h2>Save the Creative Brief first</h2><p class="muted">The script and storyboard are written from the saved Creative Brief (step 6).</p><button class="btn primary big" id="sbToReview">Go to Review & save</button></div>`;
    $('#sbToReview').onclick = () => { location.hash = `project/${st.project.id}/review`; };
    return;
  }
  const brief = await api(`/api/creative-projects/${st.project.id}/brief`).catch(() => null);
  if (!brief) return;
  state.sbBrief = brief;
  const videos = brief.brief.variations.videos;
  const plans = (await api(`/api/creative-projects/${st.project.id}/sb`)).plans.filter(p => p.brief_version === brief.version);
  state.sbVar = videos.some(v => v.index === state.sbVar) ? state.sbVar : 1;
  const plan = plans.find(p => p.variation_index === state.sbVar);
  state.sb = plan ? await api(`/api/sb-plans/${plan.id}`) : null;
  sbDraw();
}

function sbDraw(keepScroll = true) {
  const y = window.scrollY;
  const st = state.cp, sb = state.sb, brief = state.sbBrief, videos = brief.brief.variations.videos;
  const v = videos.find(x => x.index === state.sbVar) || videos[0];
  const angleName = id => brief.brief.marketing_angles.find(a => a.id === id)?.name || id;
  const busy = busyJob(sb), edit = st.can_edit && !busy;
  const head = `
    <section class="card sb-head">
      <div class="sb-head-row">
        <label>Planned video <select id="sbVar">${videos.map(x => `<option value="${x.index}" ${x.index === state.sbVar ? 'selected' : ''}>Video ${x.index} · ${esc(x.angle_ids.map(angleName).join(' + '))} · ${esc(typeName(x.creative_type))}${x.hook_style ? ` · ${esc(REG.hookStyles[x.hook_style] || x.hook_style)}` : ''}</option>`).join('')}</select></label>
        <span class="small muted">Brief v${brief.version} · ${videos.length} planned video${videos.length > 1 ? 's' : ''} (bulk generation comes in Module 9)</span>
        ${sb ? `<span class="pst ${sb.plan.status === 'approved' ? 'st-scaling' : sb.plan.status === 'failed' ? 'st-paused' : 'st-idea'}">${SB_STATUS[sb.plan.status] || sb.plan.status}</span>` : ''}
      </div>
      ${sb?.plan.newer_brief ? `<div class="cp-warn">⚠ A newer Creative Brief (v${sb.plan.newer_brief}) exists: this plan uses v${sb.plan.brief_version}.</div>` : ''}
      ${busy ? `<div class="sb-progress"><div class="ai-orb"><span></span><span></span><span></span></div><div><b>${SB_STATUS[sb.plan.status] || 'Working…'}</b><div class="fv-bar"><i style="width:${Math.max(5, Math.round((sb.job.progress || 0) * 100))}%"></i></div></div><button class="btn sm" id="sbCancel">⏹ Cancel</button></div>` : ''}
      ${sb?.job?.status === 'failed' ? `<div class="cp-err">⛔ ${esc(sb.job.error)} <a id="sbRetry">↻ Try again</a></div>` : ''}
      <div class="sb-head-row">
        ${!sb?.script ? `<button class="btn primary big" id="sbGen" ${st.can_edit && !busy ? '' : 'disabled'}>✨ Generate Script & Storyboard</button><span class="small muted">One click: strategy → 5 hooks → best hook → script → footage → storyboard → checks. Nothing is asked in between.</span>`
          : `<button class="btn" id="sbGenAll" ${edit ? '' : 'disabled'} title="Regenerate everything (locked content is kept)">↻ Regenerate all</button>`}
        ${sb ? `<span class="small muted sb-cost">AI: ${sb.cost.calls} call${sb.cost.calls === 1 ? '' : 's'} · $${sb.cost.usd.toFixed(3)}</span>` : ''}
      </div>
    </section>`;
  if (!sb || !sb.script) {
    $('#cpBody').innerHTML = head + `<div class="card s-empty"><div class="s-empty-ic">🎬</div><h2>No script yet for video ${v.index}</h2><p class="muted">The AI Creative Director uses the saved brief: ${esc(typeName(v.creative_type))}, ${esc(v.angle_ids.map(angleName).join(' + '))}, ${brief.brief.format.duration_seconds} s, ${esc(brief.brief.format.aspect_ratio)}, ${brief.brief.footage.scene_ids.length} eligible scenes.</p></div>`;
    sbWire();
    if (busy) sbPoll();
    return;
  }
  const c = sb.context, s = sb.script, b = sb.storyboard, val = sb.validation || { errors: [], warnings: [] };
  const diff = s.diff_seconds;
  const sceneOf = id => sb.scenes.find(x => x.id === id);
  $('#cpBody').innerHTML = head + `
    <section class="card"><div class="sec-h"><div><h2>📋 Creative summary</h2><small>From Creative Brief v${sb.plan.brief_version} · version v${sb.version.number}${sb.version.approved ? ' (approved)' : sb.version.frozen ? ' (frozen)' : ' (draft)'}</small></div></div>
      <div class="insp-facts">${[['Product', c.product], ['Marketing angle', c.angles.map(a => a.name).join(' + ')], ['Creative type', c.type.name], ['Target market', c.country || '—'], ['Language', `${c.language}${c.dialect ? ` (${c.dialect})` : ''}`], ['Duration', `${c.duration} s`], ['Aspect ratio', c.aspect], ['Footage', `${c.footage_mode} · ${c.usable_scenes} usable scenes`]].map(([k, x]) => `<div><span>${k}</span><p>${esc(x)}</p></div>`).join('')}</div>
    </section>

    <details class="card sb-sec" ${state.sbOpenStrategy ? 'open' : ''} id="sbStratBox"><summary><h2>🧭 Creative strategy</h2> <small class="muted">${esc(sb.strategy?.main_message || '')}</small></summary>
      ${sb.strategy ? `<div class="insp-facts sb-strategy">${[['main_message', 'Main message'], ['primary_pain_point', 'Primary pain point'], ['main_benefit', 'Main benefit'], ['emotional_approach', 'Emotional approach'], ['hook_strategy', 'Hook strategy'], ['selling_approach', 'Selling approach'], ['visual_approach', 'Visual storytelling'], ['cta_strategy', 'CTA strategy']].map(([k, l]) => `<div><span>${l}</span>${state.sbEditStrategy ? `<textarea data-strat="${k}" rows="2">${esc(sb.strategy[k])}</textarea>` : `<p>${esc(sb.strategy[k])}</p>`}</div>`).join('')}
        <div><span>Awareness level</span><p>${esc((sb.strategy.awareness_level || '').replace(/_/g, ' '))}</p></div>
        <div class="wide"><span>Narrative</span><p>${sb.strategy.narrative.map(n => `<b>${esc(SB_ROLES[n.role] || n.role)}</b>: ${esc(n.purpose)}`).join(' → ')}</p></div>
        ${sb.strategy.missing_visuals.length ? `<div class="wide"><span>Missing visuals (and supported alternatives)</span><p>${sb.strategy.missing_visuals.map(m => `⚠ ${esc(m.need)} → ${esc(m.alternative)}`).join('<br>')}</p></div>` : ''}
        ${sb.strategy.claims_to_avoid.length ? `<div class="wide"><span>Claims to avoid</span><p>${sb.strategy.claims_to_avoid.map(esc).join(' · ')}</p></div>` : ''}
      </div>` : ''}
      <div class="row">${state.sbEditStrategy ? '<button class="btn primary sm" id="sbStratSave">Save strategy</button><button class="btn sm" id="sbStratCancel">Cancel</button>' : `<button class="btn sm" id="sbStratEdit" ${edit ? '' : 'disabled'}>✏️ Edit</button><button class="btn sm" data-job="strategy" ${edit ? '' : 'disabled'}>↻ Regenerate strategy</button>`}</div>
    </details>

    <section class="card sb-sec"><div class="sec-h"><div><h2>🪝 Hooks</h2><small>${sb.hooks.auto ? '✨ The AI chose the best one: pick another any time.' : 'Chosen by the team.'}</small></div>
      <div class="row"><label class="fs-tg"><input type="checkbox" id="sbAuto" ${sb.hooks.auto ? 'checked' : ''} ${edit ? '' : 'disabled'}> Let the AI choose</label><button class="btn sm" data-job="hooks" ${edit ? '' : 'disabled'}>↻ New hooks</button></div></div>
      <div class="sb-hooks">${sb.hooks.items.map(h => `<article class="sb-hook ${h.id === sb.hooks.selected ? 'on' : ''}" data-hook="${h.id}">
        <div class="sb-hook-top"><span class="chip">${esc(REG.hookStyles[h.style] || h.style.replace(/_/g, ' '))}</span><span class="small muted">~${h.est_seconds} s · angle ${h.angle_relevance}%</span>${h.locked ? '🔒' : ''}</div>
        ${state.sbEditHook === h.id ? `<textarea data-hooktext rows="2">${esc(h.text)}</textarea><input data-hookost value="${esc(h.on_screen_text)}" placeholder="On-screen text"><div class="row"><button class="btn sm primary" data-hooksave>Save</button><button class="btn sm" data-hookcancel>Cancel</button></div>`
          : `<p class="sb-hook-text">“${esc(h.text)}”</p><p class="small"><b>Opening:</b> ${esc(h.visual_opening)}</p>${h.on_screen_text ? `<p class="small"><b>On screen:</b> ${esc(h.on_screen_text)}</p>` : ''}<p class="small muted">${esc(h.explanation)}</p>
          <div class="sb-mini">${h.scene_ids.map(id => `<img src="/media/scene/${id}/thumb" alt="" title="Scene ${id}">`).join('')}</div>`}
        <div class="row">${h.id === sb.hooks.selected ? '<b class="ok-t">✓ Selected</b>' : `<button class="btn sm" data-hooksel ${edit ? '' : 'disabled'}>Use this hook</button>`}
          <button class="icon-btn sm" data-hookedit title="Edit" ${edit ? '' : 'disabled'}>✏️</button><button class="icon-btn sm" data-hookregen title="Regenerate this hook" ${edit && !h.locked ? '' : 'disabled'}>↻</button></div>
      </article>`).join('')}</div>
    </section>

    <section class="card sb-sec"><div class="sec-h"><div><h2>📝 Script</h2><small>${esc(c.type.name)}: ${s.structure.map(esc).join(' → ')}</small></div>
      <div class="row"><button class="btn sm" id="sbCopy">📋 Copy</button><button class="btn sm" id="sbWhole" ${edit ? '' : 'disabled'}>✏️ Edit whole script</button><button class="btn sm" data-job="script" ${edit ? '' : 'disabled'}>↻ Regenerate script</button></div></div>
      <div class="sb-stats"><span>📝 ${s.words} words</span><span>🎙 ~${s.est_seconds} s estimated</span><span>🎯 ${s.target_seconds} s target</span><span class="${Math.abs(diff) > s.target_seconds * 0.12 ? 'bad' : 'ok'}">${diff > 0 ? '+' : ''}${diff} s</span><span class="muted">Provisional: the real voice-over (Module 5) sets the final timing.</span></div>
      ${state.sbWhole ? `<textarea id="sbWholeText" rows="10">${esc(s.segments.map(x => x.text).join('\n\n'))}</textarea><p class="small muted">One paragraph per segment (blank line between). Locked segments keep their text.</p><div class="row"><button class="btn primary sm" id="sbWholeSave">Save script</button><button class="btn sm" id="sbWholeCancel">Cancel</button></div>`
        : `<div class="sb-full">${s.segments.map(x => esc(x.text)).join(' ')}</div>`}
      <div class="sb-segs">${s.segments.map((x, i) => `<div class="sb-seg ${x.locked ? 'locked' : ''}" data-seg="${x.id}">
        <div class="sb-seg-l"><select data-segrole ${edit && !x.locked ? '' : 'disabled'}>${Object.entries(SB_ROLES).map(([k, l]) => `<option value="${k}" ${x.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <small>${x.est_start}–${x.est_end} s · ${x.words} w</small>${x.source === 'user' ? '<small>✏️ edited</small>' : ''}</div>
        <div class="sb-seg-m"><textarea data-segtext rows="2" ${edit && !x.locked ? '' : 'disabled'}>${esc(x.text)}</textarea>
          <input data-segost value="${esc(x.on_screen_text)}" placeholder="On-screen text (optional)" ${edit && !x.locked ? '' : 'disabled'}>
          ${x.visual_intent ? `<small class="muted">🎬 ${esc(x.visual_intent)}</small>` : ''}</div>
        <div class="sb-seg-r">
          <button class="icon-btn sm" data-seglock title="${x.locked ? 'Unlock' : 'Lock (kept on regeneration)'}" ${edit ? '' : 'disabled'}>${x.locked ? '🔒' : '🔓'}</button>
          <button class="icon-btn sm" data-segup title="Move up" ${edit && i ? '' : 'disabled'}>↑</button><button class="icon-btn sm" data-segdown title="Move down" ${edit && i < s.segments.length - 1 ? '' : 'disabled'}>↓</button>
          <button class="icon-btn sm" data-segregen title="Rewrite this segment" ${edit && !x.locked ? '' : 'disabled'}>↻</button>
          <button class="icon-btn sm" data-segmatch title="Find footage again for this segment" ${edit ? '' : 'disabled'}>🎞</button>
          <button class="icon-btn sm" data-segadd title="Add a segment after" ${edit ? '' : 'disabled'}>＋</button>
          <button class="icon-btn sm danger" data-segdel title="Remove" ${edit && !x.locked && s.segments.length > 1 ? '' : 'disabled'}>🗑</button></div>
      </div>`).join('')}</div>
    </section>

    <section class="card sb-sec"><div class="sec-h"><div><h2>🎬 Visual storyboard</h2><small>${b ? `${b.shots.length} shots · ${b.total_seconds} s · ${esc(c.pace)} pace · source footage never changes` : 'Not built yet'}</small></div>
      <div class="row"><button class="btn sm" data-job="storyboard" ${edit && s ? '' : 'disabled'}>↻ Regenerate storyboard (keep script)</button></div></div>
      ${b ? `<div class="sb-timeline">${b.shots.map(x => `<span class="r-${x.role}" style="flex:${Math.max(0.3, x.duration)}" title="${esc(SB_ROLES[x.role] || x.role)} · ${x.timeline_start}–${x.timeline_end} s">${x.order}</span>`).join('')}</div>
      ${b.missing.length ? `<div class="cp-issues">${b.missing.map(m => `<div class="cp-warn">⚠ No footage for segment ${esc(m.segment_id)}: ${esc(m.need)}<br><small>Suggestion: ${esc(m.alternative)}</small></div>`).join('')}</div>` : ''}
      <div class="sb-shots">${b.shots.map((x, i) => { const sc = sceneOf(x.scene_id); return `<article class="sb-shot ${x.locked ? 'locked' : ''}" data-shot="${x.id}">
        <div class="sb-shot-media" data-asset="${x.asset_id}" data-a="${x.source_start}" data-b="${x.source_end}"><img src="/media/scene/${x.scene_id}/thumb" alt="" loading="lazy">
          <span class="fs-q ${qClass(x.confidence)}" title="Match with the spoken text">${x.confidence}</span><span class="fv-dur">${x.duration.toFixed(1)}s</span><span class="sb-n">#${x.order}</span></div>
        <div class="sb-shot-b">
          <div class="sb-times"><span>⏱ ${x.timeline_start}–${x.timeline_end} s</span><span>🎞 scene ${x.scene_id}: ${x.source_start}–${x.source_end} s</span></div>
          <div class="chip">${esc(SB_ROLES[x.role] || x.role)}</div>
          ${x.voiceover ? `<p class="sb-vo">🎙 ${esc(x.voiceover)}</p>` : ''}
          <input data-shotost value="${esc(x.on_screen_text)}" placeholder="On-screen text" ${edit ? '' : 'disabled'}>
          <p class="small muted">${esc(x.visual_description || sc?.description || '')}</p>
          <p class="small"><b>Why:</b> ${esc(x.reason)}</p>
          <div class="sb-edit"><select data-shotf="transition" ${edit ? '' : 'disabled'}>${Object.entries(SB_TRANS).map(([k, l]) => `<option value="${k}" ${x.transition === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <select data-shotf="motion" ${edit ? '' : 'disabled'}>${Object.entries(SB_MOTION).map(([k, l]) => `<option value="${k}" ${x.motion === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <select data-shotf="crop" ${edit ? '' : 'disabled'}>${Object.entries(SB_CROP).map(([k, l]) => `<option value="${k}" ${x.crop === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          ${x.warnings.length ? `<div class="sb-warn">${x.warnings.map(w => `⚠ ${esc(w)}`).join('<br>')}</div>` : ''}
          ${x.alternatives.length ? `<div class="sb-alts"><small>Alternatives:</small>${x.alternatives.map(id => `<img src="/media/scene/${id}/thumb" alt="" title="Use scene ${id}" data-alt="${id}" class="${edit ? '' : 'off'}">`).join('')}</div>` : ''}
          ${state.sbTrim === x.id ? `<div class="sb-trim"><label>Start <input type="number" step="0.1" data-ta value="${x.source_start}" min="${sc?.start}" max="${sc?.end}"></label><label>End <input type="number" step="0.1" data-tb value="${x.source_end}" min="${sc?.start}" max="${sc?.end}"></label><small>Scene: ${sc?.start}–${sc?.end} s</small><button class="btn sm primary" data-trimsave>Save</button><button class="btn sm" data-trimcancel>Cancel</button></div>` : ''}
          <div class="sb-shot-a">
            <button class="icon-btn sm" data-shotlock title="${x.locked ? 'Unlock' : 'Lock'}" ${edit ? '' : 'disabled'}>${x.locked ? '🔒' : '🔓'}</button>
            <button class="btn sm" data-replace ${edit ? '' : 'disabled'}>🔍 Replace</button>
            <button class="icon-btn sm" data-trim title="Trim" ${edit ? '' : 'disabled'}>✂</button>
            <button class="icon-btn sm" data-shotleft title="Earlier" ${edit && i && b.shots[i - 1].segment_id === x.segment_id ? '' : 'disabled'}>←</button>
            <button class="icon-btn sm" data-shotright title="Later" ${edit && i < b.shots.length - 1 && b.shots[i + 1].segment_id === x.segment_id ? '' : 'disabled'}>→</button>
            <button class="icon-btn sm" data-shotregen title="Pick another scene" ${edit && !x.locked ? '' : 'disabled'}>↻</button>
            <button class="icon-btn sm" data-shotadd title="Add a shot after" ${edit ? '' : 'disabled'}>＋</button>
            <button class="icon-btn sm danger" data-shotdel title="Remove" ${edit && !x.locked ? '' : 'disabled'}>🗑</button></div>
        </div></article>`; }).join('')}</div>` : ''}
    </section>

    <section class="card sb-sec"><div class="sec-h"><div><h2>✅ Checks</h2><small>Checked ${val.checked_at ? ago(val.checked_at.replace('T', ' ').slice(0, 19)) : ''}</small></div><button class="btn sm" id="sbRecheck">↻ Check again</button></div>
      <div class="cp-issues">${val.errors.length ? val.errors.map(e => `<div class="cp-err">⛔ ${esc(e.message)}</div>`).join('') : '<div class="cp-ok">✓ No blocking problem.</div>'}${val.warnings.map(w => `<div class="cp-warn">⚠ ${esc(w.message)}</div>`).join('')}</div>
    </section>

    <section class="card sb-sec"><div class="sec-h"><div><h2>🗂 Versions</h2><small>Approved versions never change: editing one starts a new draft.</small></div>
      <div class="row"><button class="btn sm" id="sbSaveV" ${edit ? '' : 'disabled'}>💾 Save as a version</button><button class="btn sm" id="sbCompare" ${sb.versions.length > 1 ? '' : 'disabled'}>⇄ Compare</button></div></div>
      <div class="cp-briefs">${sb.versions.map(x => `<div><b>v${x.number}</b><span class="small">${esc(x.label)}</span><span class="pst ${x.approved ? 'st-scaling' : x.frozen ? 'st-paused' : 'st-idea'}">${x.approved ? '✅ Approved' : x.frozen ? 'Saved' : 'Working draft'}</span><span class="muted small">${esc(x.updated_at)}</span>
        ${x.id !== sb.version.id ? `<button class="btn sm" data-restore="${x.id}" ${edit ? '' : 'disabled'}>Restore</button>` : ''}<button class="btn sm" data-dupv="${x.id}" ${edit ? '' : 'disabled'}>Duplicate</button></div>`).join('')}</div>
      ${sb.approval ? `<div class="cp-ok">✅ Approved version v${sb.versions.find(x => x.id === sb.approval.version_id)?.number} on ${esc(sb.approval.approved_at)}: the production plan is ready for Module 5. <a id="sbPP">View the production plan</a></div>` : ''}
    </section>`;
  // The bottom bar: the final action.
  const nav = $('.cp-nav');
  if (nav) nav.innerHTML = `<button class="btn" id="sbBack">← Back</button><span class="muted small">${val.errors.length ? `⛔ ${val.errors.length} blocking · ` : ''}${val.warnings.length ? `⚠ ${val.warnings.length} warnings` : val.errors.length ? '' : '✓ Ready'}</span>
    <button class="btn primary big" id="sbApprove" ${edit && !val.errors.length && !sb.version.approved ? '' : 'disabled'}>${sb.version.approved ? '✅ Approved' : '✅ Approve Script & Storyboard'}</button>`;
  sbWire();
  if (keepScroll) window.scrollTo(0, y);
  if (busy) sbPoll();
}

// While generation runs: refresh every 1.5 s (the page stays usable).
function sbPoll() {
  clearTimeout(state.sbTimer);
  const pid = state.sb?.plan.id;
  state.sbTimer = setTimeout(async () => {
    if (state.cpStep !== 'script' || state.sb?.plan.id !== pid) return;
    try { state.sb = await api(`/api/sb-plans/${pid}`); } catch { return; }
    sbDraw();
  }, 1500);
}
async function sbAct(fn) { try { await fn(); } catch (e) { fail(e); } }
const sbPatch = body => sbAct(async () => { state.sb = await api(`/api/sb-plans/${state.sb.plan.id}`, { method: 'PATCH', body }); sbDraw(); });
const sbJob = (kind, target = '', extra = {}) => sbAct(async () => { await api(`/api/sb-plans/${state.sb.plan.id}/jobs`, { method: 'POST', body: { kind, target, ...extra } }); state.sb = await api(`/api/sb-plans/${state.sb.plan.id}`); sbDraw(); });

function sbWire() {
  const st = state.cp, sb = state.sb, pid = sb?.plan.id;
  $('#sbVar')?.addEventListener('change', e => { state.sbVar = Number(e.target.value); cpScript(); });
  const generate = force => sbAct(async () => {
    const r = await api(`/api/creative-projects/${st.project.id}/sb/generate`, { method: 'POST', body: { variation: state.sbVar, force } });
    state.sb = await api(`/api/sb-plans/${r.plan_id}`); sbDraw();
  });
  $('#sbGen')?.addEventListener('click', () => generate(false));
  $('#sbGenAll')?.addEventListener('click', () => { if (confirm('Regenerate the strategy, hooks, script and storyboard? Locked segments, hooks and shots are kept.')) generate(true); });
  $('#sbRetry')?.addEventListener('click', () => (sb.job.kind === 'full' ? generate(true) : sbJob(sb.job.kind, sb.job.target)));
  $('#sbCancel')?.addEventListener('click', () => sbAct(async () => { await api(`/api/sb-plans/${pid}/cancel`, { method: 'POST' }); toast('Stopping…'); }));
  $('#sbBack')?.addEventListener('click', () => { location.hash = `project/${st.project.id}/review`; });
  if (!sb?.script) return;
  document.querySelectorAll('[data-job]').forEach(b => b.onclick = () => sbJob(b.dataset.job));
  $('#sbStratBox').ontoggle = e => { state.sbOpenStrategy = e.target.open; };
  $('#sbStratEdit')?.addEventListener('click', () => { state.sbEditStrategy = true; state.sbOpenStrategy = true; sbDraw(); });
  $('#sbStratCancel')?.addEventListener('click', () => { state.sbEditStrategy = false; sbDraw(); });
  $('#sbStratSave')?.addEventListener('click', () => { const s = {}; document.querySelectorAll('[data-strat]').forEach(t => { s[t.dataset.strat] = t.value; }); state.sbEditStrategy = false; sbPatch({ strategy: s }); });
  $('#sbAuto')?.addEventListener('change', e => sbPatch({ hook_auto: e.target.checked }));
  document.querySelectorAll('[data-hook]').forEach(card => {
    const id = card.dataset.hook;
    $('[data-hooksel]', card)?.addEventListener('click', () => sbPatch({ hook_select: id }));
    $('[data-hookedit]', card)?.addEventListener('click', () => { state.sbEditHook = id; sbDraw(); });
    $('[data-hookcancel]', card)?.addEventListener('click', () => { state.sbEditHook = null; sbDraw(); });
    $('[data-hooksave]', card)?.addEventListener('click', () => { state.sbEditHook = null; sbPatch({ hook_edit: { id, text: $('[data-hooktext]', card).value, on_screen_text: $('[data-hookost]', card).value } }); });
    $('[data-hookregen]', card)?.addEventListener('click', () => sbJob('hook', id));
  });
  $('#sbCopy').onclick = () => navigator.clipboard.writeText(sb.script.segments.map(x => x.text).join('\n\n')).then(() => toast('Script copied'), () => fail(new Error('Copy failed')));
  $('#sbWhole')?.addEventListener('click', () => { state.sbWhole = true; sbDraw(); });
  $('#sbWholeCancel')?.addEventListener('click', () => { state.sbWhole = false; sbDraw(); });
  $('#sbWholeSave')?.addEventListener('click', () => { state.sbWhole = false; sbPatch({ script_text: $('#sbWholeText').value }); });
  const ids = sb.script.segments.map(x => x.id);
  document.querySelectorAll('[data-seg]').forEach(row => {
    const id = row.dataset.seg, seg = sb.script.segments.find(x => x.id === id), i = ids.indexOf(id);
    $('[data-segtext]', row).onchange = e => sbPatch({ segment: { id, text: e.target.value } });
    $('[data-segost]', row).onchange = e => sbPatch({ segment: { id, on_screen_text: e.target.value } });
    $('[data-segrole]', row).onchange = e => sbPatch({ segment: { id, role: e.target.value } });
    $('[data-seglock]', row).onclick = () => sbPatch({ segment: { id, locked: !seg.locked } });
    const move = d => { const o = [...ids]; [o[i], o[i + d]] = [o[i + d], o[i]]; sbPatch({ segment_order: o }); };
    $('[data-segup]', row).onclick = () => move(-1);
    $('[data-segdown]', row).onclick = () => move(1);
    $('[data-segregen]', row).onclick = () => { const ins = prompt('Optional instruction for the AI (e.g. "shorter", "mention the gift box"):', ''); if (ins !== null) sbJob('segment', id, { instruction: ins }); };
    $('[data-segmatch]', row).onclick = () => sbJob('match', id);
    $('[data-segadd]', row).onclick = () => sbPatch({ add_segment: { after_id: id, role: 'benefit', text: 'New segment.' } });
    $('[data-segdel]', row).onclick = () => { if (confirm('Remove this segment and its shots?')) sbPatch({ remove_segment: id }); };
  });
  document.querySelectorAll('[data-shot]').forEach(card => {
    const id = card.dataset.shot, shot = sb.storyboard.shots.find(x => x.id === id);
    $('[data-shotost]', card).onchange = e => sbPatch({ shot: { id, on_screen_text: e.target.value } });
    card.querySelectorAll('[data-shotf]').forEach(s => s.onchange = () => sbPatch({ shot: { id, [s.dataset.shotf]: s.value } }));
    $('[data-shotlock]', card).onclick = () => sbPatch({ shot: { id, locked: !shot.locked } });
    $('[data-replace]', card).onclick = () => sbPicker(sc => sbPatch({ shot: { id, scene_id: sc } }), shot.scene_id);
    $('[data-trim]', card).onclick = () => { state.sbTrim = id; sbDraw(); };
    $('[data-trimcancel]', card)?.addEventListener('click', () => { state.sbTrim = null; sbDraw(); });
    $('[data-trimsave]', card)?.addEventListener('click', () => { state.sbTrim = null; sbPatch({ shot: { id, source_start: Number($('[data-ta]', card).value), source_end: Number($('[data-tb]', card).value) } }); });
    $('[data-shotleft]', card).onclick = () => sbPatch({ move_shot: { id, dir: -1 } });
    $('[data-shotright]', card).onclick = () => sbPatch({ move_shot: { id, dir: 1 } });
    $('[data-shotregen]', card).onclick = () => sbJob('shot', id);
    $('[data-shotadd]', card).onclick = () => sbPicker(sc => sbPatch({ add_shot: { after_id: id, scene_id: sc } }));
    $('[data-shotdel]', card).onclick = () => { if (confirm('Remove this shot? The other shots of its segment take its time.')) sbPatch({ remove_shot: id }); };
    card.querySelectorAll('[data-alt]').forEach(img => img.onclick = () => { if (!img.classList.contains('off')) sbPatch({ shot: { id, scene_id: Number(img.dataset.alt) } }); });
    sbHover($('.sb-shot-media', card));
  });
  $('#sbRecheck').onclick = () => sbAct(async () => { state.sb = await api(`/api/sb-plans/${pid}/validate`, { method: 'POST' }); sbDraw(); toast('Checked'); });
  $('#sbSaveV')?.addEventListener('click', () => { const l = prompt('Name of this version (optional):', ''); if (l !== null) sbAct(async () => { state.sb = await api(`/api/sb-plans/${pid}/versions`, { method: 'POST', body: { label: l } }); sbDraw(); toast('Version saved'); }); });
  document.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => { if (confirm('Restore this version as the new working draft? The current draft stays in the history.')) sbAct(async () => { state.sb = await api(`/api/sb-plans/${pid}/versions/${b.dataset.restore}/restore`, { method: 'POST' }); sbDraw(); toast('Restored'); }); });
  document.querySelectorAll('[data-dupv]').forEach(b => b.onclick = () => sbAct(async () => { state.sb = await api(`/api/sb-plans/${pid}/versions/${b.dataset.dupv}/duplicate`, { method: 'POST' }); sbDraw(); toast('Duplicated as a new draft'); }));
  $('#sbCompare')?.addEventListener('click', sbCompare);
  $('#sbApprove')?.addEventListener('click', () => sbAct(async () => {
    const r = await fetch(`/api/sb-plans/${pid}/approve`, { method: 'POST' });
    const j = await r.json();
    if (!r.ok) { state.sb = await api(`/api/sb-plans/${pid}`); sbDraw(); throw new Error(j.error || 'Could not approve'); }
    state.sb = j; sbDraw(); toast('Approved: the production plan is ready for Module 5'); refreshSide();
  }));
  $('#sbPP')?.addEventListener('click', () => sbJson('Production plan (for Modules 5-8)', sb.approval.production_plan));
}
// Hovering a shot plays its seconds from the silent copy.
function sbHover(box) {
  if (!box) return;
  let v = null;
  box.onmouseenter = () => {
    const a = Number(box.dataset.a), b = Number(box.dataset.b);
    v = document.createElement('video'); v.muted = true; v.playsInline = true; v.className = 'fs-hover';
    v.src = `/media/footage/${box.dataset.asset}/preview#t=${a},${b}`;
    v.onloadedmetadata = () => { v.currentTime = a; v.play().catch(() => {}); };
    v.ontimeupdate = () => { if (v.currentTime >= b) v.currentTime = a; };
    box.appendChild(v);
  };
  box.onmouseleave = () => { if (v) { v.pause(); v.remove(); v = null; } };
}
// Pick a scene among the brief's usable scenes.
function sbPicker(onPick, current = null) {
  const scenes = state.sb.scenes, cats = state.footCfg?.categories || {};
  const m = document.createElement('div');
  m.className = 'modal';
  const draw = (q = '', cat = '') => {
    const list = scenes.filter(s => (!cat || s.categories.includes(cat)) && (!q || `${s.description} ${s.semantic}`.toLowerCase().includes(q.toLowerCase())));
    m.innerHTML = `<div class="modal-card" style="width:min(980px,100%)"><div class="sec-h"><div><h2>🔍 Choose a scene</h2><small>Only scenes allowed by the brief (silent, analysed, not excluded).</small></div><button class="btn sm" data-x>Close</button></div>
      <div class="fs-filters" style="position:static"><input type="search" id="pkQ" placeholder="Search descriptions…" value="${esc(q)}"><select id="pkC"><option value="">All categories</option>${Object.entries(cats).map(([k, l]) => `<option value="${k}" ${cat === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      <div class="fs-grid">${list.map(s => `<article class="fs-card ${s.id === current ? 'cp-on' : ''}" data-pick="${s.id}"><div class="fs-media ${s.orientation || ''}"><img src="/media/scene/${s.id}/thumb" alt="" loading="lazy"><span class="fs-q ${qClass(s.quality)}">${s.quality ?? '–'}</span><span class="fv-dur">${s.duration.toFixed(1)}s</span></div>
        <div class="fs-body"><div class="fs-time">Scene ${s.id} · ${fmtT(s.start)}–${fmtT(s.end)}</div><p class="fs-desc">${esc(s.description || s.semantic)}</p><div class="fs-cats">${s.categories.slice(0, 3).map(c => `<span>${esc(cats[c] || c)}</span>`).join('')}</div></div></article>`).join('') || '<p class="muted">No scene matches.</p>'}</div></div>`;
    m.querySelector('[data-x]').onclick = () => m.remove();
    $('#pkQ', m).onchange = e => draw(e.target.value, cat);
    $('#pkC', m).onchange = e => draw(q, e.target.value);
    m.querySelectorAll('[data-pick]').forEach(c => c.onclick = () => { m.remove(); onPick(Number(c.dataset.pick)); });
  };
  m.onclick = e => { if (e.target === m) m.remove(); };
  document.body.appendChild(m);
  draw();
}
async function sbCompare() {
  const vs = state.sb.versions;
  const a = prompt(`Compare which versions? Older first, e.g. "${vs[vs.length - 1].number} ${vs[0].number}"`, `${vs[Math.min(1, vs.length - 1)].number} ${vs[0].number}`);
  if (!a) return;
  const [x, y] = a.split(/[\s,]+/).map(Number);
  const A = vs.find(v => v.number === x), B = vs.find(v => v.number === y);
  if (!A || !B) return fail(new Error('Unknown version number'));
  try {
    const d = await api(`/api/sb-plans/${state.sb.plan.id}/compare?a=${A.id}&b=${B.id}`);
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="modal-card" style="width:min(900px,100%)"><div class="sec-h"><div><h2>⇄ v${d.a} → v${d.b}</h2><small>Estimated ${d.seconds[0]} s → ${d.seconds[1]} s</small></div><button class="btn sm" data-x>Close</button></div>
      ${d.hook ? `<h4>Hook</h4><p class="sb-del">${esc(d.hook.before || '—')}</p><p class="sb-add">${esc(d.hook.after || '—')}</p>` : ''}
      ${d.strategy.length ? `<h4>Strategy</h4>${d.strategy.map(c => `<p><b>${esc(c.field)}</b></p><p class="sb-del">${esc(JSON.stringify(c.before))}</p><p class="sb-add">${esc(JSON.stringify(c.after))}</p>`).join('')}` : ''}
      <h4>Script</h4>${d.script.length ? d.script.map(c => `<p><b>${esc(c.id)}</b> ${c.change}</p>${c.before ? `<p class="sb-del">${esc(c.before)}</p>` : ''}${c.after ? `<p class="sb-add">${esc(c.after)}</p>` : ''}`).join('') : '<p class="muted">No change.</p>'}
      <h4>Storyboard</h4>${d.storyboard.length ? `<ul>${d.storyboard.map(c => `<li><b>${esc(c.id)}</b> ${c.change}${c.scene_before ? ` · scene ${c.scene_before}` : ''}${c.scene_after ? ` → ${c.scene_after}` : ''}${c.trim_after ? ` · trim ${c.trim_before?.join('–')} → ${c.trim_after.join('–')}` : ''}</li>`).join('')}</ul>` : '<p class="muted">No change.</p>'}</div>`;
    m.onclick = e => { if (e.target === m || e.target.dataset.x !== undefined) m.remove(); };
    document.body.appendChild(m);
  } catch (e) { fail(e); }
}
function sbJson(title, obj) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="modal-card" style="width:min(900px,100%)"><div class="sec-h"><div><h2>${esc(title)}</h2></div><button class="btn sm" data-x>Close</button></div><pre class="cp-json">${esc(JSON.stringify(obj, null, 2))}</pre></div>`;
  m.onclick = e => { if (e.target === m || e.target.dataset.x !== undefined) m.remove(); };
  document.body.appendChild(m);
}

// ---------- Module 5: Audio studio (AI voice-over & background music) ----------
const AU_STATUS = { draft: 'Draft', preparing_plan: 'Preparing audio plan…', selecting_voice: 'Selecting voice…', generating_voiceover: 'Generating voice-over…', analyzing_timing: 'Analyzing voice-over timing…',
  validating_duration: 'Validating duration…', preparing_music: 'Preparing music…', generating_music: 'Generating music…', mixing_audio: 'Mixing audio…', synchronizing_storyboard: 'Synchronizing storyboard…',
  ready: 'Ready for review', approved: 'Approved', failed: 'Failed', cancelled: 'Cancelled' };
const AU_STAGE = { plan: 'audio plan', voice: 'voice selection', voiceover: 'voice-over', duration: 'duration check', music: 'music', mix: 'mixing', sync: 'storyboard sync', segment: 'segment' };
const auBusy = a => ['queued', 'running'].includes(a?.job?.status);
const auAct = fn => sbAct(fn);
const auFmt = s => (s == null ? '—' : `${Number(s).toFixed(1)} s`);

async function cpAudio() {
  const st = state.cp, body = $('#cpBody');
  body.innerHTML = '<div class="card"><p class="muted">Loading the audio studio…</p></div>';
  const [cfg, list] = await Promise.all([api('/api/audio/config').catch(() => ({ ready: false })), api(`/api/creative-projects/${st.project.id}/audio`).catch(fail)]);
  if (!list) return;
  state.auCfg = cfg; state.auPlans = list.plans;
  if (!list.plans.length) {
    body.innerHTML = `<div class="card s-empty"><div class="s-empty-ic">🎙</div><h2>Approve a script first</h2><p class="muted">The voice-over and music are made from an approved script & storyboard (step 7).</p><button class="btn primary big" id="auToScript">Go to Script & storyboard</button></div>`;
    $('#auToScript').onclick = () => { location.hash = `project/${st.project.id}/script`; };
    return;
  }
  if (!list.plans.some(p => p.sb_plan_id === state.auPlan)) state.auPlan = list.plans[0].sb_plan_id;
  const plan = list.plans.find(p => p.sb_plan_id === state.auPlan);
  state.au = plan.production_id ? await api(`/api/audio-productions/${plan.production_id}`).catch(fail) : null;
  auDraw();
}
async function auReload() { if (state.au) state.au = await api(`/api/audio-productions/${state.au.production.id}`); auDraw(); }
function auPoll() {
  clearTimeout(state.auTimer);
  const id = state.au?.production.id;
  state.auTimer = setTimeout(async () => {
    if (state.cpStep !== 'audio' || state.au?.production.id !== id) return;
    try { state.au = await api(`/api/audio-productions/${id}`); } catch { return; }
    auDraw();
  }, 1500);
}
const auPatch = body => auAct(async () => { state.au = await api(`/api/audio-productions/${state.au.production.id}`, { method: 'PATCH', body }); auDraw(); });
const auJob = (kind, target = '', extra = {}) => auAct(async () => { await api(`/api/audio-productions/${state.au.production.id}/jobs`, { method: 'POST', body: { kind, target, ...extra } }); await auReload(); });

function auDraw() {
  const y = window.scrollY;
  const st = state.cp, a = state.au, cfg = state.auCfg, plans = state.auPlans;
  const plan = plans.find(p => p.sb_plan_id === state.auPlan);
  const busy = auBusy(a), edit = st.can_edit && !busy && !a?.production.outdated;
  const head = `
    <section class="card sb-head">
      <div class="sb-head-row">
        <label>Approved script <select id="auPlan">${plans.map(p => `<option value="${p.sb_plan_id}" ${p.sb_plan_id === state.auPlan ? 'selected' : ''}>Video ${p.variation_index} · script v${p.sb_version_number} · brief v${p.brief_version}${p.production_id ? ' · audio started' : ''}</option>`).join('')}</select></label>
        ${a ? `<span class="pst ${a.production.status === 'approved' ? 'st-scaling' : a.production.status === 'failed' ? 'st-paused' : 'st-idea'}">${AU_STATUS[a.production.status] || a.production.status}</span>` : ''}
      </div>
      ${!cfg.ready ? '<div class="cp-warn">⚠ ElevenLabs is not connected: an admin adds <b>ELEVENLABS_API_KEY</b> in the server settings (Railway → Variables). Nothing is generated until then.</div>' : ''}
      ${a?.production.outdated ? `<div class="cp-err">⛔ The script was changed and approved again since this audio was made. This audio stays for the old script: choose the newest script above to make its audio.</div>` : ''}
      ${busy ? `<div class="sb-progress"><div class="ai-orb"><span></span><span></span><span></span></div><div><b>${AU_STATUS[a.production.status] || 'Working…'}</b><div class="fv-bar"><i style="width:${Math.max(5, Math.round((a.job.progress || 0) * 100))}%"></i></div></div><button class="btn sm" id="auCancel">⏹ Cancel</button></div>` : ''}
      ${a?.job?.status === 'failed' ? `<div class="cp-err">⛔ ${a.job.failed_stage ? `Stopped at the ${esc(AU_STAGE[a.job.failed_stage] || a.job.failed_stage)}: ` : ''}${esc(a.job.error)} <a id="auRetry">↻ Retry ${a.job.failed_stage ? 'from there' : ''}</a></div>` : ''}
      <div class="sb-head-row">
        ${!a?.voiceover && !a?.mix?.key ? `<button class="btn primary big" id="auGen" ${st.can_edit && !busy && cfg.ready ? '' : 'disabled'}>🎙 Generate Voiceover & Music</button><span class="small muted">One click: audio plan → voice → voice-over → real timing → duration check → music → mix → storyboard sync → checks.</span>`
          : `<button class="btn" id="auGenAll" ${edit && cfg.ready ? '' : 'disabled'} title="Run everything again (locked voice-over or music is kept; same text, voice and settings reuse the saved file)">↻ Run all again</button>`}
        ${a ? `<span class="small muted sb-cost">ElevenLabs: ${a.usage.characters} characters${a.usage.music_seconds ? ` · ${a.usage.music_seconds} s music` : ''} · ${a.usage.calls} call${a.usage.calls === 1 ? '' : 's'} · AI ${a.usage.ai_usd.toFixed(3)}</span>` : ''}
      </div>
    </section>`;
  if (!a || (!a.plan && !a.voiceover)) {
    $('#cpBody').innerHTML = head + `<div class="card s-empty"><div class="s-empty-ic">🎧</div><h2>No audio yet for video ${plan.variation_index}</h2><p class="muted">The AI Audio Director reads the approved script v${plan.sb_version_number}, picks a voice from your ElevenLabs account, makes the voice-over, chooses or generates background music, mixes it and fits the storyboard to the real speech.</p></div>`;
    auWire();
    if (busy) auPoll();
    return;
  }
  const c = a.context || {}, vo = a.voiceover, du = a.duration, val = a.validation || { errors: [], warnings: [] }, v = a.voice || {}, m = a.music || {}, mx = a.mix, sy = a.sync;
  const media = (what, extra = '') => `/api/audio-productions/${a.production.id}/media/${what}${extra}`;
  const ranges = cfg.ranges || { stability: [0, 1], similarity_boost: [0, 1], style: [0, 1], speed: [0.7, 1.2] };
  const set = v.settings || {};
  const slider = (k, l, help) => set[k] === undefined ? '' : `<label class="au-sl"><span>${l} <b data-slv="${k}">${Number(set[k]).toFixed(2)}</b></span><input type="range" data-set="${k}" min="${ranges[k][0]}" max="${ranges[k][1]}" step="0.05" value="${set[k]}" ${edit ? '' : 'disabled'}><small class="muted">${help}</small></label>`;
  const durCls = du ? (du.case === 'fits' ? 'ok' : du.case === 'slightly_long' ? 'warn' : 'bad') : '';
  $('#cpBody').innerHTML = head + `
    <section class="card"><div class="sec-h"><div><h2>📋 Audio summary</h2><small>Script v${c.script_version} · audio version v${a.version?.number}${a.version?.approved ? ' (approved)' : a.version?.frozen ? ' (frozen)' : ' (draft)'}</small></div></div>
      <div class="insp-facts">${[['Product', c.product], ['Marketing angle', (c.angles || []).join(' + ')], ['Creative type', c.creative_type], ['Language', `${c.language || ''}${c.dialect ? ` (${c.dialect})` : ''}`], ['Market', c.country || '—'],
        ['Target duration', `${c.duration} s`], ['Voice', v.name ? `${v.name} · ${v.model_name || v.model_id}` : '—'], ['Music', m.mode === 'none' ? 'None' : m.name || (m.fallback ? 'None (fallback)' : '—')],
        ['Voice-over', vo ? `${vo.duration.toFixed(1)} s (estimated script ${c.estimated_seconds} s)` : '—'], ['Final video', sy ? `${sy.final_duration} s` : du ? `${du.final} s` : '—'], ['Status', AU_STATUS[a.production.status] || a.production.status]].map(([k, x]) => `<div><span>${k}</span><p>${esc(x)}</p></div>`).join('')}</div>
      ${a.plan ? `<p class="small muted">🎬 ${esc(a.plan.summary)}</p>` : ''}
    </section>

    <section class="card sb-sec"><div class="sec-h"><div><h2>🎙 Voice-over</h2><small>${v.name ? `${esc(v.name)} · chosen by ${esc(v.source || 'the team')} · ${esc(v.fit?.level || '')} for ${esc(c.language || '')}${v.fit?.accents?.length ? ` · accent ${esc(v.fit.accents.join(', '))}` : ''}` : 'No voice yet'}</small></div>
      <div class="row"><button class="btn sm" id="auVoices" ${edit ? '' : 'disabled'}>🗣 Choose voice</button>${v.mode === 'manual' ? `<button class="btn sm" id="auVoiceAuto" ${edit ? '' : 'disabled'}>✨ Let the AI choose</button>` : ''}<button class="btn sm" data-aujob="voice" ${edit && cfg.ready ? '' : 'disabled'}>↻ Regenerate voice-over</button>
      <label class="fs-tg"><input type="checkbox" id="auLockVo" ${a.locked?.voiceover ? 'checked' : ''} ${edit ? '' : 'disabled'}> 🔒 Lock</label></div></div>
      ${(v.limitations || []).map(l => `<div class="cp-warn">⚠ ${esc(l)}</div>`).join('')}
      ${vo ? `<div class="au-player"><audio id="auVo" controls preload="metadata" src="${media('voiceover', `?vo=${vo.id}`)}"></audio><a class="btn sm" href="${media('voiceover', `?vo=${vo.id}&download=1`)}">⬇ Download</a></div>
        <div class="sb-stats"><span>🎙 ${vo.duration.toFixed(1)} s spoken</span><span>🎯 ${c.duration} s target</span>${du ? `<span class="${durCls}">${du.diff > 0 ? '+' : ''}${du.diff} s</span>` : ''}<span>⏱ timing: ${vo.alignment_source === 'provider' ? 'exact (ElevenLabs)' : vo.alignment_source === 'estimated' ? '<b class="bad">estimated</b>' : 'mapped'}</span><span class="muted">${vo.characters} characters</span></div>
        ${du ? `<div class="${du.case === 'fits' ? 'cp-ok' : du.case === 'slightly_long' ? 'cp-warn' : 'cp-err'}">${esc(du.action)}${du.case === 'slightly_long' && du.speed ? ` <a data-speed="${du.speed}">Regenerate at speed ${du.speed}</a>` : ''}${du.case !== 'fits' ? ` <label class="fs-tg"><input type="checkbox" id="auAccLong" ${a.accept?.long_duration ? 'checked' : ''} ${edit ? '' : 'disabled'}> Accept a ${du.final} s video</label>` : ''}</div>` : ''}
        ${vo.alignment_source === 'estimated' ? `<div class="cp-warn">⚠ ElevenLabs gave no timing for this take, so word and segment times are estimated. <label class="fs-tg"><input type="checkbox" id="auAccEst" ${a.accept?.estimated_timing ? 'checked' : ''} ${edit ? '' : 'disabled'}> I checked it: accept estimated timing</label></div>` : ''}
        ${v.shorter?.segments ? `<div class="cp-warn">✂️ Shorter script proposed (${esc(v.shorter.status)}): ${esc(v.shorter.note)}<div class="au-short">${v.shorter.segments.map(s => `<p><b>${esc(s.id)}</b> ${esc(s.text)}</p>`).join('')}</div>${v.shorter.status === 'proposed' ? `<button class="btn sm primary" id="auShortAcc" ${edit ? '' : 'disabled'}>Send to step 7 as a new draft</button>` : ''}</div>` : ''}
        <div class="au-segs">${vo.segments.map(s => `<div class="au-seg ${s.regenerated ? 'regen' : ''}"><div class="au-seg-t"><b>${esc(SB_ROLES[c.segments?.find(x => x.id === s.segment_id)?.role] || s.segment_id)}</b><span class="small muted">${fmtT(s.start)}–${fmtT(s.end)} · ${(s.end - s.start).toFixed(1)} s</span></div>
          <p>${esc(s.text)}</p>${s.speech_text !== s.text ? `<p class="small muted">🔊 Said as: ${esc(s.speech_text)}</p>` : ''}
          <div class="row"><button class="icon-btn sm" data-play="${s.start}:${s.end}" title="Play this segment">▶</button><button class="icon-btn sm" data-segregen="${esc(s.segment_id)}" title="Regenerate only this segment" ${edit && cfg.ready ? '' : 'disabled'}>↻</button></div></div>`).join('')}</div>
        ${a.voiceovers.length > 1 ? `<details class="au-more"><summary>Previous takes (${a.voiceovers.length})</summary>${a.voiceovers.map(x => `<div class="au-take ${x.id === vo.id ? 'on' : ''}"><span>#${x.id} · ${esc(x.voice_name)} · ${x.duration.toFixed(1)} s · ${esc(x.alignment_source)}${x.note ? ` · ${esc(x.note)}` : ''} · ${ago(x.created_at)}</span><audio controls preload="none" src="${media('voiceover', `?vo=${x.id}`)}"></audio>${x.id === vo.id ? '<b class="ok-t">In use</b>' : `<button class="btn sm" data-usevo="${x.id}" ${edit ? '' : 'disabled'}>Use this take</button>`}</div>`).join('')}</details>` : ''}`
        : '<p class="muted">No voice-over yet.</p>'}
      <details class="au-more" ${state.auOpenSet ? 'open' : ''} id="auSetBox"><summary>⚙️ Voice settings (${esc(v.settings_source || 'recommended')}) · model ${esc(v.model_id || '—')}</summary>
        <div class="au-sliders">${slider('stability', 'Stability', 'Lower = more expressive, higher = steadier')}${slider('similarity_boost', 'Similarity', 'How close to the original voice')}${slider('style', 'Style', 'Extra expressiveness (0 is safest)')}${slider('speed', 'Speed', '1 = normal; stays in a natural range')}
          ${set.use_speaker_boost !== undefined ? `<label class="fs-tg"><input type="checkbox" data-set="use_speaker_boost" ${set.use_speaker_boost ? 'checked' : ''} ${edit ? '' : 'disabled'}> Speaker boost</label>` : ''}
          <label>Model <select id="auModel" ${edit ? '' : 'disabled'}><option value="">Automatic (best for ${esc(c.language || 'the language')})</option>${(cfg.models || []).map(x => `<option value="${x.model_id}" ${v.model_wanted === x.model_id ? 'selected' : ''}>${esc(x.name)}${x.languages.length ? ` · ${x.languages.length} languages` : ''}</option>`).join('')}</select></label>
          <label class="fs-tg"><input type="checkbox" id="auAutoSpeed" ${v.auto_speed !== false ? 'checked' : ''} ${edit ? '' : 'disabled'}> Speed up a little automatically when slightly too long</label></div>
        <div class="row"><button class="btn sm primary" id="auSetSave" ${edit ? '' : 'disabled'}>Save & regenerate</button><button class="btn sm" id="auSetReset" ${edit ? '' : 'disabled'}>Reset to recommended</button><button class="btn sm" id="auPreset" ${v.voice_id ? '' : 'disabled'}>💾 Save as preset</button></div>
      </details>
    </section>

    <section class="card sb-sec"><div class="sec-h"><div><h2>🎵 Background music</h2><small>${a.plan ? `${esc(a.plan.music.mood)} · ${esc(a.plan.music.style)} · energy ${a.plan.music.energy}/5 · ~${a.plan.music.tempo_bpm} BPM` : ''}</small></div>
      <div class="row"><label class="fs-tg"><input type="checkbox" id="auLockMu" ${a.locked?.music ? 'checked' : ''} ${edit ? '' : 'disabled'}> 🔒 Lock</label></div></div>
      <div class="chip-pick" id="auMode">${[['ai', '✨ AI music'], ['library', '📚 Library'], ['upload', '⬆ Upload'], ['none', '🔇 No music']].map(([k, l]) => `<button data-mode="${k}" class="${(m.mode || 'ai') === k ? 'on' : ''}" ${edit ? '' : 'disabled'}>${l}</button>`).join('')}</div>
      ${m.fallback ? `<div class="cp-warn">⚠ ${esc(m.fallback)}</div>` : ''}
      ${a.music_asset ? `<div class="au-track"><div><b>${esc(a.music_asset.name)}</b><span class="small muted"> · ${a.music_asset.source === 'ai' ? 'AI generated (ElevenLabs Music)' : 'Uploaded'} · ${a.music_asset.duration.toFixed(0)} s original · ${esc(a.music_asset.license?.note || a.music_asset.license?.source || '')}</span></div>
        ${m.processed_key ? `<div class="au-player"><audio controls preload="none" src="${media('music')}"></audio><a class="btn sm" href="${media('music', '?download=1')}">⬇</a></div><p class="small muted">Prepared for ${m.prepared_for} s: ${m.processing?.loop ? 'looped' : 'trimmed'} from ${m.processing?.start || 0} s, fade in ${m.processing?.fade_in} s, fade out ${m.processing?.fade_out} s. The original file is kept.</p>` : ''}
        <div class="au-trim"><label>Start at (s) <input type="number" id="auMStart" min="0" step="0.5" value="${m.start || 0}" ${edit ? '' : 'disabled'}></label><label>Fade in (s) <input type="number" id="auMIn" min="0" max="10" step="0.1" value="${m.fade_in ?? cfg.mix_defaults?.fade_in ?? 0.6}" ${edit ? '' : 'disabled'}></label><label>Fade out (s) <input type="number" id="auMOut" min="0" max="10" step="0.1" value="${m.fade_out ?? cfg.mix_defaults?.fade_out ?? 1.2}" ${edit ? '' : 'disabled'}></label><button class="btn sm" id="auMApply" ${edit ? '' : 'disabled'}>Apply</button></div></div>` : ''}
      <div class="row">${(m.mode || 'ai') === 'ai' ? `<button class="btn sm" data-aujob="music" data-force="1" ${edit && cfg.ready ? '' : 'disabled'}>↻ New AI music</button>` : ''}<button class="btn sm" id="auLib" ${edit ? '' : 'disabled'}>📚 Music library</button><button class="btn sm" id="auUp" ${edit ? '' : 'disabled'}>⬆ Upload music</button></div>
      ${a.plan?.music.prompt ? `<p class="small muted">Prompt: ${esc(a.plan.music.prompt)}</p>` : ''}
    </section>

    <section class="card sb-sec"><div class="sec-h"><div><h2>🎚 Final mix</h2><small>${mx?.measured?.mix ? `${mx.measured.mix.i} LUFS · peak ${mx.measured.mix.tp} dBTP · voice ${mx.gains.voice_db > 0 ? '+' : ''}${mx.gains.voice_db} dB · music ${mx.gains.music_db} dB${mx.config.ducking ? ' · ducking on' : ''}` : 'Not mixed yet'}</small></div>
      <div class="row"><button class="btn sm" data-aujob="mix" ${edit ? '' : 'disabled'}>↻ Mix again</button></div></div>
      ${mx?.stale ? '<div class="cp-warn">⚠ Voice, music or settings changed: mix again.</div>' : ''}
      ${mx?.key ? `<div class="au-player"><audio controls preload="metadata" src="${media('mix')}"></audio><a class="btn sm" href="${media('mix', '?download=1')}">⬇ Download mix</a></div><p class="small muted">Voice, music and mix are kept as separate files. The footage's own sound is never used.</p>` : ''}
      <details class="au-more"><summary>⚙️ Advanced mixing</summary>
        <div class="au-trim">${[['music_rel_db', 'Music under voice (dB)', -30, 0, 1], ['voice_gain_db', 'Voice extra gain (dB)', -6, 6, 0.5], ['music_gain_db', 'Music extra gain (dB)', -12, 6, 0.5], ['final_lufs', 'Final loudness (LUFS)', -20, -10, 0.5], ['lead_in', 'Silence before voice (s)', 0, 2, 0.05]].map(([k, l, lo, hi, step]) => `<label>${l} <input type="number" data-mixk="${k}" min="${lo}" max="${hi}" step="${step}" value="${mx?.config?.[k] ?? cfg.mix_defaults?.[k] ?? ''}" ${edit ? '' : 'disabled'}></label>`).join('')}
          <label class="fs-tg"><input type="checkbox" id="auDuck" ${(mx?.config?.ducking ?? true) ? 'checked' : ''} ${edit ? '' : 'disabled'}> Lower the music while the voice speaks</label></div>
        <div class="row"><button class="btn sm primary" id="auMixSave" ${edit ? '' : 'disabled'}>Save & mix</button><button class="btn sm" id="auMixReset" ${edit ? '' : 'disabled'}>Reset</button></div>
        ${mx?.measured ? `<p class="small muted">Measured: voice ${mx.measured.voice?.i ?? '—'} LUFS · music ${mx.measured.music?.i ?? '—'} LUFS · mix ${mx.measured.mix?.i} LUFS, range ${mx.measured.mix?.lra} LU.</p>` : ''}
      </details>
    </section>

    <section class="card sb-sec"><div class="sec-h"><div><h2>🎞 Storyboard on the real speech</h2><small>${sy ? `${sy.shots.length} shots · ${sy.final_duration} s · ${sy.source === 'voiceover' ? 'from the voice-over timing' : 'estimated timing'}` : 'Not synchronized yet'}</small></div>
      <div class="row"><button class="btn sm" data-aujob="sync" ${edit ? '' : 'disabled'}>↻ Synchronize again</button>${sy?.review.length ? `<button class="btn sm primary" id="auSyncOk" ${edit ? '' : 'disabled'}>✓ I reviewed the changes</button>` : ''}</div></div>
      ${sy?.stale ? '<div class="cp-warn">⚠ The voice-over changed: synchronize again.</div>' : ''}
      ${sy ? `<div class="au-sync">${sy.segments.map(w => { const seg = c.segments?.find(x => x.id === w.id); const shots = sy.shots.filter(s => s.segment_id === w.id); return `<div class="au-win"><div class="au-win-h"><b>${esc(SB_ROLES[w.role] || w.role)}</b><span class="small muted">planned ${fmtT(w.est_start)}–${fmtT(w.est_end)} → real ${fmtT(w.start)}–${fmtT(w.end)}</span></div>
          <p class="small">${esc(seg?.text || '')}</p>
          <div class="au-shots">${shots.map(s => `<div class="au-shot ${s.needs_review ? 'review' : ''}"><img src="/media/scene/${s.scene_id}/thumb" alt=""><span>${s.old_duration.toFixed(1)} → <b>${s.duration.toFixed(1)} s</b></span>${s.needs_review ? '<i>review</i>' : ''}${s.warnings.length ? `<small class="bad">${esc(s.warnings.join(' · '))}</small>` : ''}</div>`).join('')}</div></div>`; }).join('')}</div>
        ${sy.proposals.length ? `<div class="cp-warn">💡 Proposals (nothing is changed without you): ${sy.proposals.map(p => esc(`shot ${p.shot_id}: ${p.note}`)).join(' · ')}</div>` : ''}` : ''}
    </section>

    <section class="card sb-sec"><div class="sec-h"><div><h2>🔎 Checks</h2><small>${val.errors.length ? `${val.errors.length} blocking` : 'Nothing blocking'} · ${val.warnings.length} warning${val.warnings.length === 1 ? '' : 's'}</small></div><button class="btn sm" id="auCheck">Check again</button></div>
      ${val.errors.map(e => `<div class="cp-err">⛔ ${esc(e.message)}</div>`).join('')}${val.warnings.map(w => `<div class="cp-warn">⚠ ${esc(w.message)}</div>`).join('')}${!val.errors.length && !val.warnings.length ? '<div class="cp-ok">✓ Everything checks out.</div>' : ''}
    </section>

    <details class="card sb-sec" id="auPronBox" ${state.auOpenPron ? 'open' : ''}><summary><h2>🔤 Pronunciation</h2> <small class="muted">How brand names and local words are said (the script itself never changes)</small></summary><div id="auPron"><p class="muted small">Loading…</p></div></details>

    <section class="card sb-sec"><div class="sec-h"><div><h2>🗂 Versions</h2><small>Every approval is frozen; a change after approval makes a new draft.</small></div>
      <div class="row"><button class="btn sm" id="auSaveV" ${edit ? '' : 'disabled'}>💾 Save version</button>${a.versions.length > 1 ? '<button class="btn sm" id="auCmp">⇄ Compare</button>' : ''}${a.package ? '<button class="btn sm" id="auPkg">{ } Audio package</button>' : ''}</div></div>
      <div class="au-vers">${a.versions.map(x => `<div class="au-ver ${x.id === a.version?.id ? 'on' : ''}"><b>v${x.number}</b><span>${esc(x.label || '')}${x.approved ? ' ✅' : x.frozen ? ' 🧊' : ''}</span><span class="small muted">${ago(x.updated_at || x.created_at)}</span>${x.id !== a.version?.id ? `<button class="btn sm" data-restore="${x.id}" ${edit ? '' : 'disabled'}>Restore</button>` : '<b class="ok-t">Current</b>'}</div>`).join('')}</div>
    </section>

    <div class="card au-approve"><span class="small muted">${a.version?.approved ? `Approved ${ago(a.package?.approved_at)}: Module 6 (video editing) will use this audio.` : 'Approve when the voice, music and timing sound right.'}</span>
      <button class="btn primary big" id="auApprove" ${edit && !val.errors.length && !a.version?.approved ? '' : 'disabled'}>${a.version?.approved ? '✅ Approved' : '✅ Approve Audio Production'}</button></div>`;
  auWire();
  auPron();
  if (busy) auPoll();
  window.scrollTo(0, y);
}

function auWire() {
  const st = state.cp, a = state.au;
  $('#auPlan')?.addEventListener('change', e => { state.auPlan = Number(e.target.value); cpAudio(); });
  const generate = force => auAct(async () => {
    const r = await api(`/api/creative-projects/${st.project.id}/audio/generate`, { method: 'POST', body: { sb_plan_id: state.auPlan, force } });
    state.au = await api(`/api/audio-productions/${r.production_id}`); auDraw();
  });
  $('#auGen')?.addEventListener('click', () => generate(false));
  $('#auGenAll')?.addEventListener('click', () => { if (confirm('Run the whole audio again? Locked parts are kept, and the same text, voice and settings reuse the saved voice-over (no new cost).')) generate(false); });
  $('#auCancel')?.addEventListener('click', () => auAct(async () => { await api(`/api/audio-productions/${a.production.id}/cancel`, { method: 'POST' }); toast('Stopping…'); }));
  $('#auRetry')?.addEventListener('click', () => auAct(async () => { await api(`/api/audio-productions/${a.production.id}/retry`, { method: 'POST' }); await auReload(); }));
  if (!a) return;
  document.querySelectorAll('[data-aujob]').forEach(b => b.onclick = () => auJob(b.dataset.aujob, '', b.dataset.force ? { force: true } : {}));
  document.querySelectorAll('[data-segregen]').forEach(b => b.onclick = () => auJob('segment', b.dataset.segregen));
  document.querySelectorAll('[data-speed]').forEach(b => b.onclick = () => auAct(async () => { await api(`/api/audio-productions/${a.production.id}`, { method: 'PATCH', body: { voice: { settings: { ...a.voice.settings, speed: Number(b.dataset.speed) } } } }); auJob('voiceover'); }));
  document.querySelectorAll('[data-play]').forEach(b => b.onclick = () => {
    const au = $('#auVo'); if (!au) return;
    const [s, e] = b.dataset.play.split(':').map(Number);
    au.currentTime = s; au.play();
    const stop = () => { if (au.currentTime >= e) { au.pause(); au.removeEventListener('timeupdate', stop); } };
    au.addEventListener('timeupdate', stop);
  });
  document.querySelectorAll('[data-usevo]').forEach(b => b.onclick = () => auPatch({ voiceover_id: Number(b.dataset.usevo) }));
  document.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => auAct(async () => { state.au = await api(`/api/audio-productions/${a.production.id}/versions/${b.dataset.restore}/restore`, { method: 'POST' }); auDraw(); toast('Version restored as a new draft'); }));
  $('#auVoices')?.addEventListener('click', () => auVoicePicker(id => auAct(async () => { await api(`/api/audio-productions/${a.production.id}`, { method: 'PATCH', body: { voice: { voice_id: id, settings: 'reset' } } }); auJob('voice'); })));
  $('#auVoiceAuto')?.addEventListener('click', () => auAct(async () => { await api(`/api/audio-productions/${a.production.id}`, { method: 'PATCH', body: { voice: { mode: 'auto' } } }); auJob('voice'); }));
  $('#auLockVo')?.addEventListener('change', e => auPatch({ locked: { voiceover: e.target.checked } }));
  $('#auLockMu')?.addEventListener('change', e => auPatch({ locked: { music: e.target.checked } }));
  $('#auAccLong')?.addEventListener('change', e => auPatch({ accept: { long_duration: e.target.checked } }));
  $('#auAccEst')?.addEventListener('change', e => auPatch({ accept: { estimated_timing: e.target.checked } }));
  $('#auSetBox')?.addEventListener('toggle', e => { state.auOpenSet = e.target.open; });
  $('#auPronBox')?.addEventListener('toggle', e => { state.auOpenPron = e.target.open; });
  document.querySelectorAll('input[type=range][data-set]').forEach(r => r.oninput = () => { const o = document.querySelector(`[data-slv="${r.dataset.set}"]`); if (o) o.textContent = Number(r.value).toFixed(2); });
  $('#auSetSave')?.addEventListener('click', () => auAct(async () => {
    const s = {}; document.querySelectorAll('[data-set]').forEach(x => { s[x.dataset.set] = x.type === 'checkbox' ? x.checked : Number(x.value); });
    await api(`/api/audio-productions/${a.production.id}`, { method: 'PATCH', body: { voice: { settings: s, model_id: $('#auModel').value, auto_speed: $('#auAutoSpeed').checked } } });
    auJob('voice');
  }));
  $('#auSetReset')?.addEventListener('click', () => auAct(async () => { await api(`/api/audio-productions/${a.production.id}`, { method: 'PATCH', body: { voice: { settings: 'reset', model_id: '' } } }); auJob('voice'); }));
  $('#auPreset')?.addEventListener('click', () => auAct(async () => {
    const name = prompt('Preset name', `${a.voice.name} · ${a.context?.creative_type || ''}`); if (!name) return;
    await api('/api/audio/voice-presets', { method: 'POST', body: { name, voice_id: a.voice.voice_id, model_id: a.voice.model_id, settings: a.voice.settings, market: a.context?.country || '', creative_type: a.context?.creative_type || '' } });
    toast('Preset saved');
  }));
  document.querySelectorAll('#auMode [data-mode]').forEach(b => b.onclick = () => auAct(async () => {
    const mode = b.dataset.mode;
    if (mode === 'library') return auLibrary();
    if (mode === 'upload') return auUpload();
    await api(`/api/audio-productions/${a.production.id}`, { method: 'PATCH', body: { music: { mode } } });
    auJob('music');
  }));
  $('#auMApply')?.addEventListener('click', () => auAct(async () => {
    await api(`/api/audio-productions/${a.production.id}`, { method: 'PATCH', body: { music: { start: Number($('#auMStart').value), fade_in: Number($('#auMIn').value), fade_out: Number($('#auMOut').value) } } });
    auJob('music');
  }));
  $('#auLib')?.addEventListener('click', () => auLibrary());
  $('#auUp')?.addEventListener('click', () => auUpload());
  $('#auMixSave')?.addEventListener('click', () => auAct(async () => {
    const mix = { ducking: $('#auDuck').checked }; document.querySelectorAll('[data-mixk]').forEach(x => { if (x.value !== '') mix[x.dataset.mixk] = Number(x.value); });
    await api(`/api/audio-productions/${a.production.id}`, { method: 'PATCH', body: { mix } });
    auJob('full', '', { from: 'mix' });
  }));
  $('#auMixReset')?.addEventListener('click', () => auAct(async () => { await api(`/api/audio-productions/${a.production.id}`, { method: 'PATCH', body: { mix: { reset: true } } }); auJob('mix'); }));
  $('#auSyncOk')?.addEventListener('click', () => auPatch({ sync_apply: true }));
  $('#auCheck')?.addEventListener('click', () => auAct(async () => { state.au = await api(`/api/audio-productions/${a.production.id}/validate`, { method: 'POST' }); auDraw(); }));
  $('#auSaveV')?.addEventListener('click', () => auAct(async () => { const label = prompt('Version name (optional)', ''); if (label === null) return; state.au = await api(`/api/audio-productions/${a.production.id}/versions`, { method: 'POST', body: { label } }); auDraw(); toast('Version saved'); }));
  $('#auCmp')?.addEventListener('click', auCompare);
  $('#auPkg')?.addEventListener('click', () => auAct(async () => { const p = await api(`/api/audio-productions/${a.production.id}/package`); sbJson(`Audio Production Package v${p.package.schema_version}${p.check.ok ? '' : ' ⚠ ' + p.check.problems.join(' · ')}`, p.package); }));
  $('#auShortAcc')?.addEventListener('click', () => auAct(async () => { if (!confirm('Send the shorter script to step 7 as a new draft? You approve it there, then make its audio.')) return; const r = await api(`/api/audio-productions/${a.production.id}/shorter/accept`, { method: 'POST' }); toast(r.message); await auReload(); }));
  $('#auApprove')?.addEventListener('click', () => auAct(async () => {
    const r = await fetch(`/api/audio-productions/${a.production.id}/approve`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) { if (d.validation) { state.au.validation = d.validation; auDraw(); } throw new Error(d.error); }
    state.au = d; auDraw(); toast('Audio approved: ready for video editing (Module 6)');
  }));
}

async function auPron() {
  const box = $('#auPron'); if (!box) return;
  const a = state.au, pid = state.cp.product.id;
  const d = await api(`/api/audio/pronunciation?product_id=${pid}`).catch(() => null); if (!d || !$('#auPron')) return;
  box.innerHTML = `<p class="small muted">Prices, currencies and numbers are already written out in ${esc(a.context?.language || 'the language')} automatically. Add a rule when a name is said wrongly, then regenerate the voice-over.</p>
    <table class="t"><thead><tr><th>Written</th><th>Said as</th><th>Where</th><th></th></tr></thead><tbody>${d.rules.map(r => `<tr><td>${esc(r.term)}</td><td>${esc(r.spoken)}${r.type === 'phoneme' ? ` <span class="chip">${esc(r.alphabet)}</span>` : ''}</td><td>${r.product_id ? 'This product' : 'Everywhere'}${r.language ? ` · ${esc(r.language)}` : ''}</td><td><button class="icon-btn sm" data-delrule="${r.id}">🗑</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No rules yet.</td></tr>'}</tbody></table>
    <div class="au-trim"><label>Written <input id="prTerm" placeholder="e.g. Xiomi"></label><label>Said as <input id="prSpoken" placeholder="e.g. Shao-mee"></label><label class="fs-tg"><input type="checkbox" id="prProd" checked> Only this product</label><button class="btn sm" id="prAdd">Add rule</button></div>
    ${a.plan?.pronunciation?.length ? `<p class="small muted">AI suggestions used in the voice-over: ${a.plan.pronunciation.map(p => `${esc(p.term)} → ${esc(p.spoken)}`).join(' · ')}</p>` : ''}`;
  box.querySelectorAll('[data-delrule]').forEach(b => b.onclick = () => auAct(async () => { await api(`/api/audio/pronunciation/${b.dataset.delrule}`, { method: 'DELETE' }); auPron(); }));
  $('#prAdd').onclick = () => auAct(async () => {
    await api('/api/audio/pronunciation', { method: 'POST', body: { term: $('#prTerm').value, spoken: $('#prSpoken').value, product_id: $('#prProd').checked ? pid : null, language: state.au?.voiceover?.language || '' } });
    toast('Rule added: regenerate the voice-over to hear it'); auPron();
  });
}

function auModal(html, width = 900) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="modal-card" style="width:min(${width}px,100%)">${html}</div>`;
  m.onclick = e => { if (e.target === m || e.target.dataset.x !== undefined) m.remove(); };
  document.body.appendChild(m);
  return m;
}
async function auVoicePicker(onPick) {
  const a = state.au, lang = a.voiceover?.language || '';
  const f = { q: '', gender: '', favorites: '', language: (state.cp.product.language || lang || '') };
  const m = auModal('<p class="muted">Loading voices…</p>');
  const draw = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const d = await api(`/api/audio/voices?${qs}`).catch(fail); if (!d) return;
    const card = m.querySelector('.modal-card');
    card.innerHTML = `<div class="sec-h"><div><h2>🗣 Voice library</h2><small>${d.voices.length} voice${d.voices.length === 1 ? '' : 's'} from your ElevenLabs account${d.synced_at ? ` · refreshed ${ago(d.synced_at)}` : ''}. Only voices on the account are shown; nothing is cloned.</small></div><div class="row"><button class="btn sm" id="vlSync">↻ Refresh from ElevenLabs</button><button class="btn sm" data-x>Close</button></div></div>
      <div class="au-trim"><input id="vlQ" placeholder="Search name, accent, style…" value="${esc(f.q)}"><select id="vlG"><option value="">Any gender</option><option value="female" ${f.gender === 'female' ? 'selected' : ''}>Female</option><option value="male" ${f.gender === 'male' ? 'selected' : ''}>Male</option></select>
        <select id="vlL"><option value="">Any language</option>${Object.entries(state.auCfg.languages || {}).map(([k, n]) => `<option value="${k}" ${f.language === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select><label class="fs-tg"><input type="checkbox" id="vlF" ${f.favorites ? 'checked' : ''}> ⭐ Favourites</label></div>
      <div class="au-voices">${d.voices.map(v => `<article class="au-voice ${v.voice_id === a.voice?.voice_id ? 'on' : ''}"><div class="au-voice-h"><b>${esc(v.name)}</b>${v.fit ? `<span class="chip ${v.fit.level === 'verified' ? 'win' : ''}">${esc(v.fit.level)}${v.fit.accents.length ? ` · ${esc(v.fit.accents.join(', '))}` : ''}</span>` : ''}<button class="icon-btn sm" data-fav="${esc(v.voice_id)}" data-on="${v.favorite ? 1 : 0}" title="Favourite">${v.favorite ? '⭐' : '☆'}</button></div>
        <p class="small muted">${esc([v.labels.gender, v.labels.age, v.labels.accent, v.labels.use_case, v.labels.description].filter(Boolean).join(' · '))}</p>${v.description ? `<p class="small">${esc(v.description)}</p>` : ''}
        ${v.preferred_for.length ? `<p class="small ok-t">Preferred for ${esc(v.preferred_for.join(', '))}</p>` : ''}
        <div class="row"><button class="btn sm" data-prev="${esc(v.voice_id)}">▶ Preview</button><button class="btn sm primary" data-use="${esc(v.voice_id)}">Use this voice</button>${ME?.user?.role === 'admin' && a.context ? `<button class="btn sm" data-pref="${esc(v.voice_id)}" title="Use this voice by default for ${esc(a.context.country)} in this language">📌 Default for market</button>` : ''}</div></article>`).join('') || '<p class="muted">No voice matches. Refresh from ElevenLabs or change the filters.</p>'}</div>`;
    $('#vlQ', card).onchange = e => { f.q = e.target.value; draw(); };
    $('#vlG', card).onchange = e => { f.gender = e.target.value; draw(); };
    $('#vlL', card).onchange = e => { f.language = e.target.value; draw(); };
    $('#vlF', card).onchange = e => { f.favorites = e.target.checked ? '1' : ''; draw(); };
    $('#vlSync', card).onclick = () => auAct(async () => { const r = await api('/api/audio/voices/sync', { method: 'POST' }); toast(`${r.count} voices on the account`); draw(); });
    card.querySelectorAll('[data-fav]').forEach(b => b.onclick = () => auAct(async () => { await api(`/api/audio/voices/${encodeURIComponent(b.dataset.fav)}/favorite`, { method: 'POST', body: { favorite: b.dataset.on !== '1' } }); draw(); }));
    card.querySelectorAll('[data-prev]').forEach(b => b.onclick = () => { const au = new Audio(`/api/audio/voices/${encodeURIComponent(b.dataset.prev)}/preview${f.language ? `?language=${f.language}` : ''}`); au.play().catch(() => toast('No preview for this voice', true)); });
    card.querySelectorAll('[data-use]').forEach(b => b.onclick = () => { m.remove(); onPick(b.dataset.use); });
    card.querySelectorAll('[data-pref]').forEach(b => b.onclick = () => auAct(async () => { await api('/api/audio/voice-preferences', { method: 'PUT', body: { scope: 'market', scope_key: `${a.context.country}:${state.au.voiceover?.language || f.language}`, voice_id: b.dataset.pref } }); toast('Default voice saved for this market'); draw(); }));
  };
  draw();
}
async function auLibrary() {
  const a = state.au;
  const f = { q: '', mood: '' };
  const m = auModal('<p class="muted">Loading music…</p>');
  const draw = async () => {
    const d = await api(`/api/audio/music?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`).catch(fail); if (!d) return;
    const card = m.querySelector('.modal-card');
    card.innerHTML = `<div class="sec-h"><div><h2>📚 Music library</h2><small>AI tracks and your uploads, reusable in every creative.</small></div><div class="row"><button class="btn sm" id="mlUp">⬆ Upload</button><button class="btn sm" data-x>Close</button></div></div>
      <div class="au-trim"><input id="mlQ" placeholder="Search…" value="${esc(f.q)}"><select id="mlM"><option value="">Any mood</option>${(state.auCfg.moods || []).map(x => `<option ${f.mood === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="au-lib">${d.tracks.map(t => `<div class="au-libt ${t.id === a.music?.asset_id ? 'on' : ''}"><div><b>${esc(t.name)}</b> <button class="icon-btn sm" data-tfav="${t.id}" data-on="${t.favorite ? 1 : 0}">${t.favorite ? '⭐' : '☆'}</button><br><span class="small muted">${t.source === 'ai' ? '✨ AI' : '⬆ Upload'} · ${t.duration.toFixed(0)} s · ${esc(t.mood || '—')}${t.tempo ? ` · ${t.tempo} BPM` : ''} · used ${t.used}× · ${esc(t.license?.commercial_use === 'confirmed' ? `rights confirmed by ${t.license.confirmed_by}` : t.license?.note || '')}</span></div>
        <audio controls preload="none" src="/api/audio/music/${t.id}/file"></audio><div class="row"><button class="btn sm primary" data-tuse="${t.id}">Use</button><button class="icon-btn sm" data-tren="${t.id}" title="Rename">✏️</button>${t.used ? '' : `<button class="icon-btn sm" data-tdel="${t.id}" title="Delete">🗑</button>`}</div></div>`).join('') || '<p class="muted">The library is empty: generate AI music or upload a track.</p>'}</div>`;
    $('#mlQ', card).onchange = e => { f.q = e.target.value; draw(); };
    $('#mlM', card).onchange = e => { f.mood = e.target.value; draw(); };
    $('#mlUp', card).onclick = () => { m.remove(); auUpload(); };
    card.querySelectorAll('[data-tuse]').forEach(b => b.onclick = () => auAct(async () => { m.remove(); await api(`/api/audio-productions/${a.production.id}`, { method: 'PATCH', body: { music: { asset_id: Number(b.dataset.tuse) } } }); auJob('music'); }));
    card.querySelectorAll('[data-tfav]').forEach(b => b.onclick = () => auAct(async () => { await api(`/api/audio/music/${b.dataset.tfav}`, { method: 'PATCH', body: { favorite: b.dataset.on !== '1' } }); draw(); }));
    card.querySelectorAll('[data-tren]').forEach(b => b.onclick = () => auAct(async () => { const n = prompt('New name'); if (!n) return; await api(`/api/audio/music/${b.dataset.tren}`, { method: 'PATCH', body: { name: n } }); draw(); }));
    card.querySelectorAll('[data-tdel]').forEach(b => b.onclick = () => auAct(async () => { if (!confirm('Delete this track from the library?')) return; await api(`/api/audio/music/${b.dataset.tdel}`, { method: 'DELETE' }); draw(); }));
  };
  draw();
}
function auUpload() {
  const a = state.au;
  const m = auModal(`<div class="sec-h"><div><h2>⬆ Upload music</h2><small>MP3, WAV, M4A, AAC, OGG or FLAC · up to ${state.auCfg.music_max_mb || 50} MB</small></div><button class="btn sm" data-x>Close</button></div>
    <div class="au-form"><input type="file" id="upF" accept=".mp3,.wav,.m4a,.aac,.ogg,.flac"><label>Name <input id="upN"></label><label>Mood <select id="upM"><option value="">—</option>${(state.auCfg.moods || []).map(x => `<option>${x}</option>`).join('')}</select></label>
      <label>Where it comes from / licence <input id="upL" placeholder="e.g. bought on Artlist, licence #123"></label>
      <label class="fs-tg"><input type="checkbox" id="upOk"> I own this music or have a licence to use it in paid ads.</label>
      <button class="btn primary" id="upGo">Upload and use</button></div>`, 560);
  $('#upGo', m).onclick = () => auAct(async () => {
    const file = $('#upF', m).files[0];
    if (!file) throw new Error('Choose a file');
    if (!$('#upOk', m).checked) throw new Error('Confirm you have the rights to use this music');
    const fd = new FormData();
    fd.append('name', $('#upN', m).value || file.name.replace(/\.[^.]+$/, '')); fd.append('mood', $('#upM', m).value); fd.append('license_source', $('#upL', m).value); fd.append('confirm_rights', 'yes'); fd.append('file', file);
    $('#upGo', m).disabled = true; $('#upGo', m).textContent = 'Uploading…';
    const r = await fetch('/api/audio/music/upload', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) { $('#upGo', m).disabled = false; $('#upGo', m).textContent = 'Upload and use'; throw new Error(d.error); }
    m.remove();
    if (d.duplicate) toast('This file is already in the library: using it');
    await api(`/api/audio-productions/${a.production.id}`, { method: 'PATCH', body: { music: { asset_id: d.id } } });
    auJob('music');
  });
}
async function auCompare() {
  const vs = state.au.versions;
  const a = prompt(`Compare which versions? Older first, e.g. "${vs[vs.length - 1].number} ${vs[0].number}"`, `${vs[Math.min(1, vs.length - 1)].number} ${vs[0].number}`);
  if (!a) return;
  const [x, y] = a.split(/[\s,]+/).map(Number);
  const A = vs.find(v => v.number === x), B = vs.find(v => v.number === y);
  if (!A || !B) return fail(new Error('Unknown version number'));
  try {
    const d = await api(`/api/audio-productions/${state.au.production.id}/compare?a=${A.id}&b=${B.id}`);
    const id = state.au.production.id;
    auModal(`<div class="sec-h"><div><h2>⇄ v${d.a} → v${d.b}</h2></div><button class="btn sm" data-x>Close</button></div>
      ${d.changes.length ? d.changes.map(c => `<p><b>${esc(c.field)}</b></p><p class="sb-del">${esc(typeof c.before === 'object' ? JSON.stringify(c.before) : c.before ?? '—')}</p><p class="sb-add">${esc(typeof c.after === 'object' ? JSON.stringify(c.after) : c.after ?? '—')}</p>`).join('') : '<p class="muted">No change.</p>'}
      <div class="au-cmp">${d.voiceovers.map((v, i) => v ? `<div><b>Voice-over v${i ? d.b : d.a}</b><audio controls preload="none" src="/api/audio-productions/${id}/media/voiceover?vo=${v}"></audio></div>` : '').join('')}</div>`);
  } catch (e) { fail(e); }
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

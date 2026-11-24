// Ad creative Centre: one page app (products → footage, scripts, creatives; team).
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KINDS = { hook: 'Hook', body: 'Body', cta: 'Call to action' };
const KIND_HINT = {
  hook: 'First 2-3 seconds: the scroll-stopper.',
  body: 'The demo: problem → product → benefits.',
  cta: 'End: order now, pay on delivery.',
};
const STATUS_LABEL = { draft: 'Draft', testing: 'Testing', winner: 'Winner 🏆', loser: 'Loser' };
const fmtDur = s => { s = Math.round(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

let ME = null;
const state = { view: 'products', product: null, tab: 'footage', sel: { hook: new Set(), body: new Set(), cta: new Set() }, poll: null };

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
  $('#buildbar').classList.add('hidden');
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

// ---------- Sidebar: counts, recent products, ads being made ----------
async function refreshSide() {
  if ($('#app').classList.contains('hidden')) return;
  const s = await api('/api/sidebar').catch(() => null);
  if (!s) return;
  const cnt = (id, n) => { $(id).textContent = n ? String(n) : ''; };
  cnt('#cntProducts', s.products); cnt('#cntMusic', s.music); cnt('#cntTeam', s.team);
  const cur = (location.hash.match(/^#product\/(\d+)/) || [])[1];
  $('#sideRecent').innerHTML = s.recent.map(p => `<a class="side-p ${String(p.id) === cur ? 'on' : ''}" href="#product/${p.id}">
      ${productPic(p) ? `<img src="${productPic(p)}" alt="">` : '<span class="pimg-empty">🎬</span>'}<span>${esc(p.name)}</span>
      ${p.making ? `<i class="dot" title="${p.making} ads being made"></i>` : ''}</a>`).join('')
    || '<div class="side-empty">No product yet</div>';
  const making = s.making + s.cutting;
  $('#live').innerHTML = making
    ? `<div class="live-on"><span class="pulse"></span><div><b>${s.making ? `${s.making} ad${s.making > 1 ? 's' : ''} being made` : ''}${s.making && s.cutting ? ' · ' : ''}${s.cutting ? `${s.cutting} video${s.cutting > 1 ? 's' : ''} being cut` : ''}</b>
        <small>Running in the background</small></div></div>`
    : `<div class="live-off">✅ All ads are ready${s.ready ? ` · <b>${s.ready}</b> made` : ''}</div>`;
}

// Phone: open/close the sidebar
$('#menuBtn').addEventListener('click', () => document.body.classList.toggle('side-open'));
$('#sideShade').addEventListener('click', () => document.body.classList.remove('side-open'));
$('#sideNew').addEventListener('click', () => { location.hash = 'products'; state.openNew = true; route(); });

function route() {
  clearInterval(state.poll);
  $('#buildbar').classList.add('hidden');
  closeStudio();
  document.body.classList.remove('side-open');
  const [view, id, tab] = (location.hash.slice(1) || 'products').split('/');
  document.querySelectorAll('.side-nav a').forEach(a => a.classList.toggle('on', a.dataset.go === view || (view === 'product' && a.dataset.go === 'products')));
  document.querySelectorAll('.side-p').forEach(a => a.classList.toggle('on', view === 'product' && a.getAttribute('href') === `#product/${id}`));
  state.music = null; // reload the music list for the Build bar
  if (view === 'team' && ME.user.role === 'admin') return renderTeam();
  if (view === 'music') return renderMusic();
  if (view === 'product' && id) { state.tab = tab || 'overview'; return renderProduct(Number(id)); }
  renderProducts();
}

// ---------- Products ----------
const P_STATUS = { idea: '💡 Idea', testing: '🧪 Testing', scaling: '🚀 Scaling', paused: '⏸ Paused' };
let MARKETS = null;
const loadMarkets = async () => (MARKETS ??= await api('/api/markets').catch(() => ({})));
const flag = (code, size = '') => `<span class="flag f-${esc(code)} ${size}" title="${esc(MARKETS?.[code]?.name || code)}"></span>`;
const marketBadges = (list = []) => list.map(m => `<span class="mkf">${flag(m.code)}${esc(m.code)}</span>`).join('');
const productPic = p => (p.image ? `/media/product/${p.id}/image?v=${encodeURIComponent(p.image)}` : p.cover_clip ? `/media/thumb/clip/${p.cover_clip}` : '');
const ago = iso => {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso.replace(' ', 'T') + 'Z')) / 864e5;
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? `${Math.floor(d)} days ago` : iso.slice(0, 10);
};

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
      <div class="prow phead"><div>Product</div><div>Status</div><div>Markets</div><div>Footage</div><div>Scripts</div><div>Ads</div><div>Activity</div></div>
      ${shown.map(p => `
        <a class="prow" href="#product/${p.id}">
          <div class="pname">${productPic(p) ? `<img src="${productPic(p)}" alt="" loading="lazy">` : '<span class="pimg-empty">🎬</span>'}<b>${esc(p.name)}</b></div>
          <div><span class="pst st-${p.status}">${P_STATUS[p.status] || esc(p.status)}</span></div>
          <div class="mks">${marketBadges(p.markets) || '<span class="muted small">–</span>'}</div>
          <div class="small">${p.hooks + p.bodies + p.ctas ? `<span class="chip hook">${p.hooks}</span><span class="chip body">${p.bodies}</span><span class="chip cta">${p.ctas}</span>` : '<span class="muted">–</span>'}</div>
          <div>${p.scripts || '<span class="muted">–</span>'}</div>
          <div>${p.creatives ? `${p.creatives}${p.winners ? ` <span class="chip win">🏆 ${p.winners}</span>` : ''}` : '<span class="muted">–</span>'}</div>
          <div class="muted small">${ago(p.last_activity)}</div>
        </a>`).join('')}
      ${shown.length ? '' : `<div class="empty">${list.length ? 'No product matches.' : 'No product yet. Click <b>+ New product</b>.'}</div>`}
    </div>`;
  $('#newProduct').onclick = () => { $('#newForm').classList.remove('hidden'); $('#newForm [name=name]').focus(); };
  if (state.openNew) { state.openNew = false; $('#newProduct').click(); }
  $('#cancelNew').onclick = () => $('#newForm').classList.add('hidden');
  $('#newForm').onsubmit = async e => {
    e.preventDefault();
    try {
      const { id } = await api('/api/products', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      location.hash = `product/${id}`;
    } catch (err) { fail(err); }
  };
  const ps = $('#pSearch');
  ps.oninput = () => { state.productQuery = ps.value; const pos = ps.selectionStart; renderProducts().then(() => { const x = $('#pSearch'); x.focus(); x.setSelectionRange(pos, pos); }); };
}

// ---------- One product ----------
async function loadProduct(id) {
  state.data = await api(`/api/products/${id}`);
  if (state.product !== id) { state.sel = { hook: new Set(), body: new Set(), cta: new Set() }; state.product = id; }
  // Forget selected clips that were deleted.
  const ids = new Set(state.data.clips.map(c => c.id));
  for (const k in state.sel) for (const x of state.sel[k]) if (!ids.has(x)) state.sel[k].delete(x);
}

const TABS = [['overview', 'Overview'], ['footage', 'Footage'], ['scripts', 'Scripts'], ['creatives', 'Creatives'], ['inspiration', 'Inspiration']];

async function renderProduct(id) {
  try { await Promise.all([loadProduct(id), loadMarkets()]); } catch (e) { fail(e); location.hash = 'products'; return; }
  const { product: p, clips, scripts, creatives, inspirations } = state.data;
  const pic = productPic({ ...p, cover_clip: clips[0]?.id });
  const counts = { footage: clips.length, scripts: scripts.length, creatives: creatives.length, inspiration: inspirations.length };
  const link = (url, label) => (url ? `<a class="plink" href="${esc(url)}" target="_blank" rel="noopener">${label} ↗</a>` : '');
  const v = $('#view');
  v.innerHTML = `
    <a class="back" href="#products">← All products</a>
    <div class="phero card">
      <label class="phero-img" title="Change the picture">${pic ? `<img src="${pic}" alt="">` : '<span>📷<br><small>Add a picture</small></span>'}
        <input type="file" accept="image/*" class="hidden" id="pImage"></label>
      <div class="phero-main">
        <div class="row" style="gap:6px">
          <select id="pStatus" class="pst-sel st-${p.status}">${Object.entries(P_STATUS).map(([k, l]) => `<option value="${k}" ${k === p.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
          ${p.markets.map(m => `<span class="mkf">${flag(m.code)}${esc(MARKETS[m.code]?.name || m.code)}</span>`).join('')}
        </div>
        <h1>${esc(p.name)}</h1>
        <div class="phero-meta">
          ${link(p.link_product, '🛒 Product page')}${link(p.link_alibaba, '🏭 Alibaba / 1688')}${link(p.link_amazon, '📦 Amazon')}
          <span class="muted small">Added ${esc(p.created_at.slice(0, 10))}${state.data.author ? ` by ${esc(state.data.author)}` : ''}</span>
        </div>
      </div>
      <div class="phero-actions">
        <button class="btn" id="pEdit">✏️ Edit</button>
        ${ME.user.role === 'admin' ? '<button class="btn sm ghost danger" id="delProduct">🗑 Delete</button>' : ''}
      </div>
    </div>
    <div class="tabs">${TABS.map(([k, l]) => `<a data-tab="${k}" class="${k === state.tab ? 'on' : ''}">${l}${counts[k] !== undefined ? ` <span class="cnt">${counts[k]}</span>` : ''}</a>`).join('')}</div>
    <div id="tab"></div>`;
  v.querySelectorAll('.tabs a').forEach(a => { a.onclick = () => { location.hash = `product/${id}/${a.dataset.tab}`; }; });
  $('#pStatus').onchange = e => api(`/api/products/${id}`, { method: 'PATCH', body: { status: e.target.value } }).then(() => { e.target.className = `pst-sel st-${e.target.value}`; toast('Status saved'); }, fail);
  $('#pImage').onchange = e => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    fetch(`/api/products/${id}/image`, { method: 'POST', body: fd }).then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error); renderProduct(id); }), fail).catch(fail);
  };
  $('#pEdit').onclick = () => editProduct(p);
  const del = $('#delProduct');
  if (del) del.onclick = async () => {
    if (!confirm(`Delete "${p.name}" with all its footage, scripts, videos and inspiration? This cannot be undone.`)) return;
    try { await api(`/api/products/${id}`, { method: 'DELETE' }); location.hash = 'products'; } catch (e) { fail(e); }
  };
  ({ overview: renderOverview, footage: renderFootage, scripts: renderScripts, creatives: renderCreatives, inspiration: renderInspiration }[state.tab] || renderOverview)();
}

// Overview: the product's brief, markets, numbers, latest ads and inspiration.
function renderOverview() {
  const { product: p, clips, scripts, creatives, inspirations } = state.data;
  const n = k => clips.filter(c => c.kind === k).length;
  const byLang = Object.entries(scripts.reduce((a, s) => ({ ...a, [s.language]: (a[s.language] || 0) + 1 }), {}));
  const ready = creatives.filter(c => c.render === 'ready');
  const field = (label, html) => `<div class="bf"><div class="bf-l">${label}</div><div class="bf-v">${html}</div></div>`;
  const url = u => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48))} ↗</a>` : '<span class="muted">Not added</span>');
  $('#tab').innerHTML = `
    <div class="ov">
      <div class="ov-main">
        <div class="card">
          <div class="row spread"><h2 style="margin:0">Brief</h2><button class="btn sm" id="ovEdit">✏️ Edit</button></div>
          <p class="muted small" style="margin:2px 0 12px">Everything the team needs for this product's ads.</p>
          <div class="bgrid">
            ${field('Product page', url(p.link_product))}
            ${field('Alibaba / 1688', url(p.link_alibaba))}
            ${field('Amazon', url(p.link_amazon))}
            ${field('CTA banner on videos', p.banner ? esc(p.banner) : '<span class="muted">"Pay on delivery" (default)</span>')}
          </div>
          ${field('Notes for the AI (benefits, buyers, price, offer)', `<textarea id="ovNotes" placeholder="e.g. Crystal bracelet, gold finish, gift for her, 680 ZMW, pay on delivery">${esc(p.notes)}</textarea>
            <div class="row" style="margin-top:6px"><button class="btn sm" id="ovSave">Save notes</button>${p.music_style ? `<span class="small muted">🎵 Music style: ${esc(p.music_style)}</span>` : ''}</div>`)}
        </div>

        <div class="card">
          <div class="row spread"><h2 style="margin:0">Latest ads</h2><a class="small" href="#product/${p.id}/creatives">All ${creatives.length} →</a></div>
          ${ready.length ? `<div class="mini-grid">${ready.slice(0, 6).map(c => `<a href="#product/${p.id}/creatives" class="mini"><img src="/media/thumb/creative/${c.id}" alt="" loading="lazy">
            <span class="mini-tag ${c.status}">${STATUS_LABEL[c.status]}</span></a>`).join('')}</div>`
            : `<div class="st-empty" style="margin-top:10px">No ad yet. Go to <a href="#product/${p.id}/footage">Footage</a>, tick clips and click <b>🎬 Create ads</b>.</div>`}
        </div>

        <div class="card">
          <div class="row spread"><h2 style="margin:0">Inspiration</h2><a class="small" href="#product/${p.id}/inspiration">${inspirations.length ? `All ${inspirations.length} →` : '+ Add'}</a></div>
          ${inspirations.length ? `<div class="mini-grid">${inspirations.slice(0, 6).map(i => `<a href="#product/${p.id}/inspiration" class="mini">
            <img src="${i.kind === 'image' ? `/media/inspiration/${i.id}` : `/media/thumb/insp/${i.id}`}" alt="" loading="lazy">${i.kind === 'video' ? '<span class="mini-play">▶</span>' : ''}</a>`).join('')}</div>`
            : '<div class="st-empty" style="margin-top:10px">Ads or screenshots you like for this product: the team copies their style.</div>'}
        </div>
      </div>

      <div class="ov-side">
        <div class="card">
          <div class="row spread"><h2 style="margin:0">Markets</h2><button class="btn sm" id="ovMk">✏️</button></div>
          ${p.markets.length ? p.markets.map(m => `<div class="mrow">${flag(m.code, 'lg')}<b>${esc(MARKETS[m.code]?.name || m.code)}</b>
            <span class="mprice">${m.price ? `${esc(m.price)} <small>${esc(MARKETS[m.code]?.currency || '')}</small>` : '<span class="muted small">no price</span>'}</span></div>`).join('')
            : '<div class="st-empty" style="margin-top:10px">Where do you sell it? Click ✏️</div>'}
        </div>
        <div class="card">
          <h2>Numbers</h2>
          <div class="nums">
            <div><b>${n('hook')}</b><span class="chip hook">hooks</span></div><div><b>${n('body')}</b><span class="chip body">bodies</span></div><div><b>${n('cta')}</b><span class="chip cta">CTAs</span></div>
            <div><b>${scripts.length}</b><span class="chip">scripts</span></div><div><b>${creatives.length}</b><span class="chip">ads</span></div><div><b>${creatives.filter(c => c.status === 'winner').length}</b><span class="chip win">winners</span></div>
          </div>
          ${byLang.length ? `<div class="small muted" style="margin-top:10px">Scripts: ${byLang.map(([l, k]) => `${k} ${ME.languages[l] || l}`).join(' · ')}</div>` : ''}
        </div>
        <div class="card next">
          <h2>Next step</h2>
          ${!clips.length ? `<p>Add footage: drop your TikToks in <a href="#product/${p.id}/footage">Auto-split</a>.</p>`
            : !scripts.length ? `<p>Write scripts with AI in <a href="#product/${p.id}/scripts">Scripts</a> (style BSS).</p>`
            : !creatives.length ? `<p>Tick clips in <a href="#product/${p.id}/footage">Footage</a> and click <b>🎬 Create ads</b>.</p>`
            : `<p>Mark ads as <b>Testing</b>, then <b>Winner</b> or <b>Loser</b> in <a href="#product/${p.id}/creatives">Creatives</a>.</p>`}
        </div>
      </div>
    </div>`;
  $('#ovEdit').onclick = () => editProduct(p);
  $('#ovMk').onclick = () => editProduct(p);
  $('#ovSave').onclick = () => api(`/api/products/${p.id}`, { method: 'PATCH', body: { notes: $('#ovNotes').value } }).then(() => toast('Notes saved'), fail);
}

// Edit product: a live preview on the left (picture, name, status, markets, CTA banner), the form on the right.
const REGIONS = [
  ['Southern Africa', ['ZM', 'ZW', 'MW', 'MZ', 'BW', 'NA']],
  ['East Africa', ['KE', 'TZ', 'UG', 'RW']],
  ['West & Central Africa', ['NG', 'GH', 'CI', 'SN', 'CM', 'CD']],
  ['North Africa', ['MA']],
];
function editProduct(p) {
  const draft = { name: p.name, status: p.status, banner: p.banner, link_product: p.link_product, link_alibaba: p.link_alibaba,
    link_amazon: p.link_amazon, markets: p.markets.map(m => ({ ...m })) };
  const pic = productPic({ ...p, cover_clip: state.data?.clips?.[0]?.id });
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
    $('#pePrevBanner').textContent = draft.banner || 'PAY ON DELIVERY';
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
      <h3>CTA on the videos</h3>
      <div class="pe-banner"><span id="pePrevBanner"></span><small>last seconds of each ad</small></div>
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
            <div class="pe-grid2">
              ${linkField('link_alibaba', '🏭', 'Alibaba / 1688', 'https://www.alibaba.com/product-detail/…')}
              ${linkField('link_amazon', '📦', 'Amazon', 'https://www.amazon.com/dp/…')}
            </div>
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

        <section class="pe-sec">
          <h4><span class="ic">📣</span>CTA banner on videos</h4>
          <div class="field"><span class="fi">🟧</span><input type="text" data-k="banner" maxlength="60" value="${esc(draft.banner)}" placeholder="PAY ON DELIVERY · 680 ZMW"></div>
          <p class="small muted" style="margin:6px 0 0">Shown on the CTA of Classic ads. Empty = "Pay on delivery" in the script's language.</p>
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


// Inspiration: ads and screenshots the team wants to copy the style of.
function renderInspiration() {
  const { inspirations } = state.data;
  const t = $('#tab');
  t.innerHTML = `
    <div class="card">
      <h2>✨ Inspiration</h2>
      <p class="muted small" style="margin-top:-4px">Ads that work, competitors' videos, screenshots: the style you want for this product's ads.</p>
      <div class="drop" id="inspDrop">⬆ Drop videos or pictures here or click to upload<input type="file" accept="video/*,image/*" multiple class="hidden"></div>
      <div class="progress hidden"><div></div></div>
    </div>
    <div class="insp-grid">
      ${inspirations.map(i => `<div class="card insp" data-id="${i.id}">
        <div class="insp-media">${i.kind === 'image' ? `<img src="/media/inspiration/${i.id}" alt="" loading="lazy" data-zoom>`
          : `<video src="/media/inspiration/${i.id}" poster="/media/thumb/insp/${i.id}" controls preload="none" playsinline></video>`}</div>
        <input type="text" value="${esc(i.name)}" data-name>
        <textarea data-note placeholder="What do you like in it? (hook, captions, music, angle…)">${esc(i.note)}</textarea>
        <div class="row spread"><span class="small muted">${i.kind === 'video' ? `🎬 ${fmtDur(i.duration)}` : '🖼 picture'} · ${esc(i.author || '')}</span>
          <button class="btn sm danger" data-del>✕</button></div>
      </div>`).join('')}
    </div>
    ${inspirations.length ? '' : '<div class="empty">Nothing yet. Drop the ads you want to copy.</div>'}`;
  const d = $('#inspDrop'), input = $('input', d);
  const send = files => upload(`/api/products/${state.product}/inspiration`, {}, files, d, r => `${r.added} added`);
  d.onclick = e => { if (e.target !== input) input.click(); };
  input.onchange = () => send(input.files);
  d.ondragover = e => { e.preventDefault(); d.classList.add('over'); };
  d.ondragleave = () => d.classList.remove('over');
  d.ondrop = e => { e.preventDefault(); d.classList.remove('over'); send(e.dataTransfer.files); };
  t.querySelectorAll('.insp').forEach(el => {
    const id = Number(el.dataset.id);
    $('[data-name]', el).onchange = e => api(`/api/inspirations/${id}`, { method: 'PATCH', body: { name: e.target.value } }).catch(fail);
    $('[data-note]', el).onchange = e => api(`/api/inspirations/${id}`, { method: 'PATCH', body: { note: e.target.value } }).then(() => toast('Saved'), fail);
    $('[data-del]', el).onclick = () => { if (confirm('Delete this inspiration?')) api(`/api/inspirations/${id}`, { method: 'DELETE' }).then(() => renderProduct(state.product), fail); };
    const z = $('[data-zoom]', el);
    if (z) z.onclick = () => { const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = `<img src="${z.src}" style="max-width:92vw;max-height:88vh;border-radius:10px">`; m.onclick = () => m.remove(); document.body.appendChild(m); };
  });
}


// Footage: three lanes (hook / body / CTA), upload, select clips to build videos.
const RAW_STATE = { queued: '⏳ Waiting', splitting: '✂️ Cutting…', done: '✅ Done', failed: '❌ Failed' };

function renderFootage() {
  const { clips, raws } = state.data;
  const t = $('#tab');
  t.innerHTML = `
    <div class="card autosplit">
      <h2>✂️ Auto-split full videos</h2>
      <div class="hint">Drop whole videos (your TikTok downloads). Each one is cut by itself: the first ~3 s go to <b>Hook</b>,
        the middle to <b>Body</b>, the last ~3 s to <b>CTA</b>, on scene changes when there are some. Check the clips after and move or delete the ones you don't like.</div>
      <div class="drop" data-raw>⬆ Drop full videos here or click to upload<input type="file" accept="video/*" multiple class="hidden"></div>
      <div class="progress hidden"><div></div></div>
      ${raws.length ? `<div class="raws">${raws.map(r => `
        <div class="raw" data-id="${r.id}">
          <span class="rname">${esc(r.original_name)}</span>
          <span class="rstate ${r.status}">${RAW_STATE[r.status]}${r.status === 'done' ? ` · ${r.parts} clips` : ''}</span>
          ${r.status === 'failed' ? `<span class="small muted">${esc(r.error).slice(0, 120)}</span><button class="btn sm" data-rretry>Try again</button>` : ''}
          ${r.status === 'failed' || r.status === 'queued' ? '<button class="btn sm danger" data-rdel>✕</button>' : ''}
        </div>`).join('')}</div>` : ''}
    </div>
    <p class="muted">Or put already-cut clips straight in the right lane.
    Tick clips in each lane, then <b>Build videos</b>: every hook × body × CTA you ticked becomes one ad.</p>
    <div class="grid lanes">
      ${Object.keys(KINDS).map(k => `
        <div class="card lane" data-kind="${k}">
          <h2><span class="dot" style="background:var(--${k})"></span>${KINDS[k]} <span class="muted small">(${clips.filter(c => c.kind === k).length})</span>
            <button class="btn sm" style="margin-left:auto" data-all="${k}">Tick all</button></h2>
          <div class="hint">${KIND_HINT[k]}</div>
          <div class="drop" data-kind="${k}">⬆ Drop videos here or click to upload<input type="file" accept="video/*" multiple class="hidden"></div>
          <div class="progress hidden"><div></div></div>
          <div class="clips">
            ${clips.filter(c => c.kind === k).map(c => `
              <div class="clip ${state.sel[k].has(c.id) ? 'sel' : ''}" data-id="${c.id}">
                <input type="checkbox" class="tick" ${state.sel[k].has(c.id) ? 'checked' : ''}>
                <span class="dur">${fmtDur(c.duration)}${c.has_audio ? '' : ' 🔇'}</span>
                <img src="/media/thumb/clip/${c.id}" alt="" data-play="/media/clip/${c.id}" loading="lazy">
                <div class="bar">
                  <input type="text" value="${esc(c.label)}" data-label title="Clip name">
                  <div class="row">
                    <select data-kind title="Move to">${Object.keys(KINDS).map(x => `<option value="${x}" ${x === c.kind ? 'selected' : ''}>${x.toUpperCase()}</option>`).join('')}</select>
                    <button class="btn sm danger" data-del title="Delete">✕</button>
                  </div>
                </div>
              </div>`).join('')}
          </div>
        </div>`).join('')}
    </div>`;

  t.querySelectorAll('.drop').forEach(d => {
    const input = $('input', d);
    const send = files => (d.dataset.raw !== undefined ? uploadRaw(files, d) : uploadClips(d.dataset.kind, files, d));
    d.onclick = e => { if (e.target !== input) input.click(); };
    input.onchange = () => send(input.files);
    d.ondragover = e => { e.preventDefault(); d.classList.add('over'); };
    d.ondragleave = () => d.classList.remove('over');
    d.ondrop = e => { e.preventDefault(); d.classList.remove('over'); send(e.dataTransfer.files); };
  });
  t.querySelectorAll('.raw').forEach(el => {
    const id = Number(el.dataset.id);
    const rt = $('[data-rretry]', el), rd = $('[data-rdel]', el);
    if (rt) rt.onclick = () => api(`/api/raws/${id}/retry`, { method: 'POST' }).then(() => renderProduct(state.product), fail);
    if (rd) rd.onclick = () => api(`/api/raws/${id}`, { method: 'DELETE' }).then(() => renderProduct(state.product), fail);
  });
  // While videos are being cut, check every 3 seconds and show the new clips.
  clearInterval(state.poll);
  if (raws.some(r => r.status === 'queued' || r.status === 'splitting')) {
    state.poll = setInterval(async () => {
      if (state.tab !== 'footage' || !location.hash.startsWith(`#product/${state.product}`)) return clearInterval(state.poll);
      const before = JSON.stringify(state.data.raws.map(r => r.status));
      await loadProduct(state.product).catch(() => {});
      if (JSON.stringify(state.data.raws.map(r => r.status)) !== before) renderProduct(state.product);
    }, 3000);
  }
  t.querySelectorAll('[data-all]').forEach(b => b.onclick = () => {
    const k = b.dataset.all, all = state.data.clips.filter(c => c.kind === k).map(c => c.id);
    const every = all.every(id => state.sel[k].has(id));
    state.sel[k] = new Set(every ? [] : all);
    renderFootage();
  });
  t.querySelectorAll('.clip').forEach(el => {
    const id = Number(el.dataset.id), kind = el.closest('.lane').dataset.kind;
    $('.tick', el).onchange = e => {
      e.target.checked ? state.sel[kind].add(id) : state.sel[kind].delete(id);
      el.classList.toggle('sel', e.target.checked);
      renderBuildBar();
    };
    $('[data-label]', el).onchange = e => api(`/api/clips/${id}`, { method: 'PATCH', body: { label: e.target.value } }).catch(fail);
    $('[data-kind]', el).onchange = async e => {
      try { await api(`/api/clips/${id}`, { method: 'PATCH', body: { kind: e.target.value } }); state.sel[kind].delete(id); renderProduct(state.product); } catch (err) { fail(err); }
    };
    $('[data-del]', el).onclick = async () => {
      if (!confirm('Delete this clip?')) return;
      try { await api(`/api/clips/${id}`, { method: 'DELETE' }); renderProduct(state.product); } catch (err) { fail(err); }
    };
  });
  t.querySelectorAll('[data-play]').forEach(img => img.onclick = () => play(img.dataset.play));
  renderBuildBar();
}

function uploadRaw(files, drop) { upload(`/api/products/${state.product}/raw`, {}, files, drop, r => `${r.queued} video(s) are being cut`); }
function uploadClips(kind, files, drop) {
  upload(`/api/products/${state.product}/clips`, { kind }, files, drop,
    r => `${r.added} clip(s) added${r.skipped?.length ? ` · not a video: ${r.skipped.join(', ')}` : ''}`, r => !!r.skipped?.length);
}

function upload(url, fields, files, drop, okMsg, isWarn = () => false, done = () => renderProduct(state.product)) {
  if (!files?.length) return;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append('files', f);
  const bar = drop.nextElementSibling;
  bar.classList.remove('hidden');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', url);
  xhr.upload.onprogress = e => { if (e.lengthComputable) $('div', bar).style.width = `${(e.loaded / e.total) * 100}%`; };
  xhr.onload = () => {
    const r = JSON.parse(xhr.responseText || '{}');
    if (xhr.status >= 300) return fail(new Error(r.error || 'Upload failed')), bar.classList.add('hidden');
    toast(okMsg(r), isWarn(r));
    done();
  };
  xhr.onerror = () => { fail(new Error('Upload failed: check your connection')); bar.classList.add('hidden'); };
  xhr.send(fd);
}

// ---------- Create-ads studio ----------
// Ticking clips shows a big "Create ads" button; it opens the studio, where every choice is a large card.
// Choices are remembered in this browser (scripts are remembered per product).
const build = Object.assign({ style: 'bss', format: '4x5', voice: '', voiceName: '', music: 'product', captions: true },
  JSON.parse(localStorage.getItem('acc-build') || '{}'));
const saveBuild = () => localStorage.setItem('acc-build', JSON.stringify(build));

// Voices (ElevenLabs) and music tracks, loaded once when the studio first needs them.
async function loadBuildLists() {
  if (!state.music) state.music = await api('/api/music').catch(() => []);
  if (ME.tts && !state.voices) {
    state.voicesError = '';
    state.voices = await api('/api/voices').catch(e => { state.voicesError = e.message; return []; });
  }
}

// Scripts ticked in the studio (kept per product, only ones that still exist).
function chosenScripts() {
  const ids = new Set(state.data.scripts.map(s => s.id));
  state.studioScripts ??= {};
  const mine = (state.studioScripts[state.product] || []).filter(id => ids.has(id));
  state.studioScripts[state.product] = mine;
  return mine;
}

// The floating button on the Footage tab.
function renderBuildBar() {
  const bb = $('#buildbar');
  const n = k => state.sel[k].size;
  if (state.tab !== 'footage' || n('hook') + n('body') + n('cta') === 0) return bb.classList.add('hidden');
  bb.classList.remove('hidden');
  bb.innerHTML = `<div class="fab">
    <div class="fab-sel"><span class="chip hook">${n('hook')} hooks</span><span class="chip body">${n('body')} bodies</span><span class="chip cta">${n('cta')} CTAs</span></div>
    <button class="btn sm ghost" id="bbClear">Clear</button>
    <button class="btn primary big" id="bbOpen">🎬 Create ads →</button>
  </div>`;
  $('#bbClear').onclick = () => { state.sel = { hook: new Set(), body: new Set(), cta: new Set() }; renderFootage(); };
  $('#bbOpen').onclick = openStudio;
}

// How many videos the current choices make, and what is still missing.
function studioPlan() {
  const n = k => state.sel[k].size;
  const sids = chosenScripts();
  const bss = build.style === 'bss';
  const tracks = state.music || [];
  const mine = tracks.filter(m => m.product_id === state.product);
  const voiceOn = Boolean(sids.length && ME.tts && build.voice);
  let music = build.music;
  if (music === 'product' && !mine.length) music = 'none';
  if (music === 'video' && voiceOn) music = mine.length ? 'product' : 'none';
  if (music === 'random' && !tracks.length) music = 'none';
  if (/^\d+$/.test(music) && !tracks.some(m => String(m.id) === music)) music = 'none';
  const clips = bss ? Math.max(n('hook'), 1) * Math.max(n('cta'), 1) : Math.max(n('hook'), 1) * Math.max(n('body'), 1) * Math.max(n('cta'), 1);
  const count = clips * Math.max(sids.length, 1);
  const missing = [];
  if (bss && !sids.length) missing.push('a script');
  if (bss && !build.voice) missing.push('a voice');
  if (bss && !n('body')) missing.push('body clips');
  return { n, sids, bss, tracks, mine, voiceOn, music, count, missing };
}

async function openStudio() {
  let m = $('#studio');
  if (!m) {
    m = document.createElement('div');
    m.id = 'studio';
    m.className = 'studio-wrap';
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m) closeStudio(); });
  }
  m.innerHTML = '<div class="studio"><div class="empty"><div class="spin" style="margin:0 auto 10px"></div>Loading voices and music…</div></div>';
  document.body.classList.add('noscroll');
  await loadBuildLists();
  renderStudio();
}
// Closes the studio and any other window on top (edit product…).
function closeStudio() { document.querySelectorAll('.studio-wrap').forEach(x => x.remove()); document.body.classList.remove('noscroll'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.querySelector('.studio-wrap')) closeStudio(); });

const LANG_FLAG = { en: 'EN', sw: 'SW', fr: 'FR' };

function renderStudio() {
  const m = $('#studio');
  if (!m) return;
  const P = studioPlan();
  const scripts = state.data.scripts;
  const voices = state.voices || [];
  const q = (state.voiceQuery || '').toLowerCase();
  const shownVoices = voices.filter(v => !q || (v.name + ' ' + v.info).toLowerCase().includes(q));
  const langs = [...new Set(scripts.map(s => s.language))];
  const card = (on, inner, attrs = '', disabled = false) =>
    `<button type="button" class="opt ${on ? 'on' : ''}" ${disabled ? 'disabled' : ''} ${attrs}>${inner}<span class="tick">✓</span></button>`;
  const v = voices.find(x => x.id === build.voice);

  m.innerHTML = `<div class="studio" role="dialog" aria-label="Create ads">
    <header class="st-head">
      <div><h2>🎬 Create ads</h2>
        <div class="st-sel"><span class="chip hook">${P.n('hook')} hooks</span><span class="chip body">${P.n('body')} bodies</span><span class="chip cta">${P.n('cta')} CTAs</span></div></div>
      <button class="btn ghost" id="stClose" aria-label="Close">✕</button>
    </header>

    <div class="st-body">
      <section class="st-sec">
        <h3><i>1</i> Style</h3>
        <div class="opts two">
          ${card(P.bss, `<div class="ill ill-bss"><b></b><b></b><b></b><b></b><span>the <em>perfect</em> gift</span></div>
            <div class="opt-t">BSS montage</div><div class="opt-d">One voice, a new shot every ~2 s, karaoke captions, arrows on the CTA. Like your inspiration ads.</div>`, 'data-style="bss"')}
          ${card(!P.bss, `<div class="ill ill-classic"><b class="h">HOOK</b><b class="b">BODY</b><b class="c">CTA</b></div>
            <div class="opt-t">Classic</div><div class="opt-d">Hook clip + body clip + CTA clip, each combination is one ad.</div>`, 'data-style="classic"')}
        </div>
      </section>

      ${P.bss ? `<section class="st-sec">
        <h3><i>2</i> Format</h3>
        <div class="opts two small">
          ${card(build.format === '4x5', '<div class="ratio r45"></div><div class="opt-t">4:5</div><div class="opt-d">Feed (Facebook, Instagram)</div>', 'data-format="4x5"')}
          ${card(build.format === '9x16', '<div class="ratio r916"></div><div class="opt-t">9:16</div><div class="opt-d">Reels, Stories, TikTok</div>', 'data-format="9x16"')}
        </div>
      </section>` : ''}

      <section class="st-sec">
        <h3><i>${P.bss ? 3 : 2}</i> Script <small>${P.sids.length ? `${P.sids.length} chosen: each one makes its own ads` : P.bss ? 'choose at least one' : 'optional'}</small></h3>
        ${scripts.length ? `<div class="quick">${langs.map(l => `<button type="button" class="btn sm" data-alllang="${l}">All ${ME.languages[l] || l}</button>`).join('')}
          <button type="button" class="btn sm" data-noscripts>None</button></div>
          <div class="opts scripts-grid">${scripts.map(s => card(P.sids.includes(s.id), `
            <div class="sc-top"><span class="chip">${LANG_FLAG[s.language] || esc(s.language)}</span>${s.style === 'bss' ? '<span class="chip win">BSS</span>' : ''}${s.angle ? `<span class="chip">${esc(s.angle)}</span>` : ''}</div>
            <div class="sc-hook">“${esc(s.hook)}”</div>
            <div class="opt-d">${esc(s.body.slice(0, 90))}${s.body.length > 90 ? '…' : ''}</div>`, `data-script="${s.id}"`)).join('')}</div>`
          : `<div class="st-empty">No script yet. <a href="#product/${state.product}/scripts" data-close>✨ Write scripts with AI</a> (choose the style BSS).</div>`}
      </section>

      <section class="st-sec">
        <h3><i>${P.bss ? 4 : 3}</i> Voice ${v ? `<small>${esc(v.name)}</small>` : ''}</h3>
        ${!ME.tts ? '<div class="st-empty">Voice-over is not set up on the server (ELEVENLABS_API_KEY).</div>'
          : state.voicesError ? `<div class="st-empty bad">⚠ ${esc(state.voicesError)}</div>`
          : `<div class="quick"><input type="text" id="stVoiceQ" placeholder="Search voices: female, african, warm…" value="${esc(state.voiceQuery || '')}">
              ${P.bss ? '' : `<button type="button" class="btn sm" data-novoice>No voice</button>`}
              <button type="button" class="btn sm" data-paste>✏️ Voice ID</button></div>
            <div class="opts voices">${shownVoices.map(x => card(build.voice === x.id, `
              <div class="vo-row"><span class="vo-av">${esc(x.name.slice(0, 1))}</span>
                <div><div class="opt-t">${esc(x.name)}</div><div class="opt-d">${esc(x.info || x.category || '')}</div></div></div>
              ${x.preview ? `<span class="play" data-preview="${esc(x.preview)}" title="Listen">▶</span>` : ''}`, `data-voice="${esc(x.id)}"`, !P.sids.length)).join('')
              || '<div class="st-empty">No voice matches.</div>'}</div>
            ${P.sids.length ? '' : '<p class="small muted">Choose a script first: the voice reads it.</p>'}`}
      </section>

      <section class="st-sec">
        <h3><i>${P.bss ? 5 : 4}</i> Music</h3>
        <div class="opts music">
          ${card(P.music === 'product', `<div class="mu-ic">✨</div><div class="opt-t">AI music of this product</div><div class="opt-d">${P.mine.length ? `${P.mine.length} tracks, a different one per ad` : 'None yet: make some below'}</div>`, 'data-music="product"', !P.mine.length)}
          ${card(P.music === 'none', '<div class="mu-ic">🔇</div><div class="opt-t">No music</div><div class="opt-d">Voice only</div>', 'data-music="none"')}
          ${card(P.music === 'video', `<div class="mu-ic">🎬</div><div class="opt-t">TikTok sound</div><div class="opt-d">${P.voiceOn ? 'Not with a voice (it has someone speaking)' : 'The original sound of the clips'}</div>`, 'data-music="video"', P.voiceOn)}
          ${card(P.music === 'random', `<div class="mu-ic">🎵</div><div class="opt-t">Library mix</div><div class="opt-d">${P.tracks.length} tracks, random per ad</div>`, 'data-music="random"', !P.tracks.length)}
        </div>
        ${ME.tts ? `<form class="make-music" id="stMake">
          <input type="text" name="prompt" placeholder="Describe new music: elegant luxury pop, soft piano, confident…" value="${esc(state.data.product.music_style || '')}">
          <button class="btn">✨ Make 2 tracks</button></form>` : ''}
      </section>

      ${P.bss ? '' : `<section class="st-sec">
        <h3><i>5</i> Captions</h3>
        <label class="switch"><input type="checkbox" id="stCaptions" ${build.captions ? 'checked' : ''} ${P.sids.length && ME.captions ? '' : 'disabled'}><span></span> Write the script on the video and add the CTA banner</label>
      </section>`}
    </div>

    <footer class="st-foot">
      <div class="st-sum">
        <div class="st-count"><b>${P.count}</b> ad${P.count === 1 ? '' : 's'}</div>
        <div class="small muted">${[P.bss ? `BSS · ${build.format === '9x16' ? '9:16' : '4:5'}` : 'Classic · 9:16',
          P.sids.length ? `${P.sids.length} script${P.sids.length > 1 ? 's' : ''}` : 'no script', v ? `🎙 ${esc(v.name)}` : '',
          { product: '✨ AI music', none: 'no music', video: '🎬 TikTok sound', random: '🎵 library mix' }[P.music] || '🎵 one track'].filter(Boolean).join(' · ')}</div>
      </div>
      ${P.missing.length ? `<div class="st-miss">Choose ${P.missing.join(', ')}</div>` : ''}
      <button class="btn primary big" id="stCreate" ${P.missing.length ? 'disabled' : ''}>Create ${P.count} ad${P.count === 1 ? '' : 's'} →</button>
    </footer>
  </div>`;

  // Choices
  const set = (k, v2) => { build[k] = v2; saveBuild(); renderStudio(); };
  $('#stClose').onclick = closeStudio;
  m.querySelectorAll('[data-close]').forEach(a => a.addEventListener('click', closeStudio));
  m.querySelectorAll('[data-style]').forEach(b => b.onclick = () => set('style', b.dataset.style));
  m.querySelectorAll('[data-format]').forEach(b => b.onclick = () => set('format', b.dataset.format));
  m.querySelectorAll('[data-script]').forEach(b => b.onclick = () => {
    const id = Number(b.dataset.script), list = chosenScripts();
    state.studioScripts[state.product] = list.includes(id) ? list.filter(x => x !== id) : [...list, id];
    renderStudio();
  });
  m.querySelectorAll('[data-alllang]').forEach(b => b.onclick = () => {
    state.studioScripts[state.product] = scripts.filter(s => s.language === b.dataset.alllang).map(s => s.id);
    renderStudio();
  });
  m.querySelector('[data-noscripts]')?.addEventListener('click', () => { state.studioScripts[state.product] = []; renderStudio(); });
  m.querySelectorAll('[data-voice]').forEach(b => b.onclick = e => {
    if (e.target.closest('[data-preview]')) return;
    build.voiceName = voices.find(x => x.id === b.dataset.voice)?.name || '';
    set('voice', b.dataset.voice);
  });
  m.querySelector('[data-novoice]')?.addEventListener('click', () => set('voice', ''));
  m.querySelector('[data-paste]')?.addEventListener('click', () => {
    const id = (prompt('ElevenLabs voice ID (ElevenLabs: Voices → a voice → ⋯ → Copy voice ID):') || '').trim();
    if (id) { build.voiceName = 'Voice ' + id.slice(0, 8); set('voice', id); }
  });
  const vq = $('#stVoiceQ');
  if (vq) vq.oninput = () => {
    state.voiceQuery = vq.value;
    const pos = vq.selectionStart;
    renderStudio();
    const again = $('#stVoiceQ'); again.focus(); again.setSelectionRange(pos, pos);
  };
  // Voice previews
  let audio = null;
  m.querySelectorAll('[data-preview]').forEach(p => p.onclick = e => {
    e.stopPropagation();
    if (audio) { audio.pause(); m.querySelectorAll('.play.on').forEach(x => { x.classList.remove('on'); x.textContent = '▶'; }); }
    if (audio && audio.src === p.dataset.preview) { audio = null; return; }
    audio = new Audio(p.dataset.preview);
    audio.play().catch(() => {});
    p.classList.add('on'); p.textContent = '❚❚';
    audio.onended = () => { p.classList.remove('on'); p.textContent = '▶'; };
  });
  m.querySelectorAll('[data-music]').forEach(b => b.onclick = () => set('music', b.dataset.music));
  const cap = $('#stCaptions');
  if (cap) cap.onchange = () => set('captions', cap.checked);
  const mk = $('#stMake');
  if (mk) mk.onsubmit = e => { e.preventDefault(); makeMusic(mk); };
  $('#stCreate').onclick = createAds;
}

// ✨ Make music: 2 instrumental tracks for this product with ElevenLabs.
async function makeMusic(form) {
  const prompt = form.prompt.value.trim();
  if (prompt.length < 3) return fail(new Error('Describe the music first (style and mood)'));
  const btn = $('button', form);
  btn.disabled = true; btn.textContent = '✨ Making… (1-2 min)';
  try {
    await api('/api/music/generate', { method: 'POST', body: { prompt, count: 2, seconds: 30, product_id: state.product } });
    state.data.product.music_style = prompt;
    state.music = null;
    build.music = 'product'; saveBuild();
    toast('2 music tracks made for this product');
    await loadBuildLists();
  } catch (e) { fail(e); }
  renderStudio();
}

async function createAds() {
  const P = studioPlan();
  const btn = $('#stCreate');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const v = (state.voices || []).find(x => x.id === build.voice) || (build.voice ? { name: build.voiceName } : null);
    await api(`/api/products/${state.product}/creatives`, { method: 'POST', body: {
      hooks: [...state.sel.hook], bodies: [...state.sel.body], ctas: [...state.sel.cta], script_ids: P.sids,
      voice_id: P.sids.length && ME.tts ? build.voice : '', voice_name: v?.name || '',
      music: P.music, captions: build.captions, style: build.style, format: build.format } });
    state.sel = { hook: new Set(), body: new Set(), cta: new Set() };
    closeStudio();
    toast(`${P.count} ad(s) are being made`);
    location.hash = `product/${state.product}/creatives`;
  } catch (e) { fail(e); btn.disabled = false; btn.textContent = `Create ${P.count} ads →`; }
}


// Scripts: AI writer + list.
function renderScripts() {
  const { scripts } = state.data;
  const langs = ME.languages;
  const t = $('#tab');
  t.innerHTML = `
    <form class="card" id="genForm">
      <h2>✨ Write scripts with AI</h2>
      ${ME.ai ? '' : '<p class="small" style="color:var(--bad)">AI is not set up on the server yet (ANTHROPIC_API_KEY). You can still add scripts by hand.</p>'}
      <div class="row" style="align-items:end">
        <div style="width:160px"><label class="f">Language</label><select name="language">${Object.entries(langs).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        <div style="width:210px"><label class="f">Style</label><select name="style"><option value="bss">BSS: gift story, ~25 s, one voice</option><option value="classic">Classic: hook / body / CTA</option></select></div>
        <div style="width:110px"><label class="f">How many</label><input type="number" name="count" min="1" max="6" value="3"></div>
        <div style="flex:1;min-width:220px"><label class="f">Extra instructions (optional)</label><input type="text" name="extra" placeholder="e.g. target mothers, use a gift angle, mention 2-for-1 offer"></div>
        <button class="btn primary" ${ME.ai ? '' : 'disabled'}>Generate</button>
      </div>
      <p class="small muted" style="margin-bottom:0">The AI uses the product name and the notes above. Each script = hook + body + CTA + post text + headline.</p>
    </form>
    <details class="card" style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">✍️ Add a script by hand</summary>
      <form id="manForm">
        <div class="row"><div style="width:160px"><label class="f">Language</label><select name="language">${Object.entries(langs).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        <div style="flex:1"><label class="f">Angle</label><input type="text" name="angle" placeholder="e.g. testimonial"></div></div>
        <label class="f">Hook</label><textarea name="hook" required></textarea>
        <label class="f">Body</label><textarea name="body" required></textarea>
        <label class="f">Call to action</label><textarea name="cta" required></textarea>
        <label class="f">Post text (optional)</label><textarea name="primary_text"></textarea>
        <label class="f">Headline (optional)</label><input type="text" name="headline">
        <button class="btn primary" style="margin-top:10px">Save script</button>
      </form>
    </details>
    <div class="grid scripts" style="margin-top:16px">
      ${scripts.map(s => `
        <div class="card script" data-id="${s.id}">
          <div class="row spread"><div class="chips"><span class="chip">${esc((langs[s.language] || s.language))}</span>${s.style === 'bss' ? '<span class="chip win">BSS</span>' : ''}${s.angle ? `<span class="chip">${esc(s.angle)}</span>` : ''}</div>
            <div class="row"><button class="btn sm" data-copy>Copy</button><button class="btn sm danger" data-del>✕</button></div></div>
          <div class="part hook"><span>Hook</span><div>${esc(s.hook)}</div></div>
          <div class="part body"><span>Body</span><div>${esc(s.body)}</div></div>
          <div class="part cta"><span>CTA</span><div>${esc(s.cta)}</div></div>
          ${s.primary_text || s.headline ? `<details><summary>Ad copy</summary>${s.headline ? `<div style="margin-top:6px"><b>${esc(s.headline)}</b></div>` : ''}<pre>${esc(s.primary_text)}</pre></details>` : ''}
          <div class="small muted" style="margin-top:8px">${esc(s.author || '')} · ${esc(s.created_at.slice(0, 16))}</div>
        </div>`).join('')}
    </div>
    ${scripts.length ? '' : '<div class="empty">No script yet.</div>'}`;

  $('#genForm').onsubmit = async e => {
    e.preventDefault();
    const btn = $('button', e.target);
    btn.disabled = true; btn.textContent = 'Writing… (up to a minute)';
    try {
      const { ids } = await api(`/api/products/${state.product}/scripts/generate`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast(`${ids.length} script(s) written`);
      renderProduct(state.product);
    } catch (err) { fail(err); btn.disabled = false; btn.textContent = 'Generate'; }
  };
  $('#manForm').onsubmit = async e => {
    e.preventDefault();
    try { await api(`/api/products/${state.product}/scripts`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); renderProduct(state.product); } catch (err) { fail(err); }
  };
  t.querySelectorAll('.script').forEach(el => {
    const s = scripts.find(x => x.id === Number(el.dataset.id));
    $('[data-copy]', el).onclick = () => {
      const txt = `HOOK:\n${s.hook}\n\nBODY:\n${s.body}\n\nCTA:\n${s.cta}${s.headline ? `\n\nHEADLINE:\n${s.headline}` : ''}${s.primary_text ? `\n\nPOST TEXT:\n${s.primary_text}` : ''}`;
      navigator.clipboard.writeText(txt).then(() => toast('Copied'), () => fail(new Error('Copy failed')));
    };
    $('[data-del]', el).onclick = async () => {
      if (!confirm('Delete this script?')) return;
      try { await api(`/api/scripts/${s.id}`, { method: 'DELETE' }); renderProduct(state.product); } catch (err) { fail(err); }
    };
  });
}

// Creatives: finished videos, their state, status and download.
const musicName = id => (state.musicAll || []).find(m => m.id === id)?.name || 'music';

function renderCreatives() {
  if (!state.musicAll) api('/api/music').then(m => { state.musicAll = m; if (state.tab === 'creatives') renderCreatives(); }).catch(() => {});
  const { creatives, scripts, clips } = state.data;
  const clipName = id => clips.find(c => c.id === id)?.label || (id ? `#${id}` : '');
  const t = $('#tab');
  const filter = state.filter || 'all';
  const list = creatives.filter(c => filter === 'all' || c.status === filter);
  t.innerHTML = `
    <div class="row spread" style="margin-bottom:14px">
      <div class="row">${['all', ...ME.statuses].map(s => `<button class="btn sm ${filter === s ? 'dark' : ''}" data-filter="${s}">${s === 'all' ? 'All' : STATUS_LABEL[s]}</button>`).join('')}</div>
      <span class="muted small">Build new videos from the Footage tab.</span>
    </div>
    <div class="grid creatives">
      ${list.map(c => {
        const s = scripts.find(x => x.id === c.script_id);
        const media = c.render === 'ready'
          ? `<video src="/media/creative/${c.id}" poster="/media/thumb/creative/${c.id}" controls preload="none" playsinline></video>`
          : c.render === 'failed' ? `<div style="padding:14px;text-align:center"><div style="color:#ff8a7a">Failed</div><div class="small" style="margin:6px 0">${esc(c.error).slice(0, 320)}</div><button class="btn sm" data-retry>Try again</button></div>`
          : `<div style="text-align:center"><div class="spin" style="margin:0 auto 8px"></div>${c.render === 'rendering' ? 'Making video…' : 'Waiting…'}</div>`;
        return `<div class="card creative" data-id="${c.id}">
          <div class="media">${media}</div>
          <div class="meta">
            <input type="text" value="${esc(c.name)}" data-name title="Name">
            <div class="small muted">${[c.hook_clip && `Hook: ${esc(clipName(c.hook_clip))}`, c.body_clip && `Body: ${esc(clipName(c.body_clip))}`, c.cta_clip && `CTA: ${esc(clipName(c.cta_clip))}`].filter(Boolean).join('<br>')}</div>
            ${s ? `<div class="small" title="${esc(s.hook + '\n\n' + s.body + '\n\n' + s.cta)}">📝 ${esc(s.language.toUpperCase())} · ${esc(s.hook.slice(0, 60))}</div>` : ''}
            ${c.voice_name || c.music_id || c.captions ? `<div class="small muted">${[c.voice_name && `🎙 ${esc(c.voice_name)}`, c.music_id && `🎵 ${esc(musicName(c.music_id))}`, c.captions && '💬 captions'].filter(Boolean).join(' · ')}</div>` : ''}
            <div class="row" style="flex-wrap:nowrap">
              <select data-status class="status-${c.status}">${ME.statuses.map(x => `<option value="${x}" ${x === c.status ? 'selected' : ''}>${STATUS_LABEL[x]}</option>`).join('')}</select>
              ${c.render === 'ready' ? `<a class="btn sm" href="/media/creative/${c.id}?download=1" title="Download">⬇</a>` : ''}
              <button class="btn sm danger" data-del title="Delete">✕</button>
            </div>
            <div class="small muted">${c.render === 'ready' ? fmtDur(c.duration) + ' · ' : ''}${esc(c.author || '')}</div>
          </div>
        </div>`;
      }).join('')}
    </div>
    ${list.length ? '' : `<div class="empty">${creatives.length ? 'No video with this status.' : 'No video yet. Go to <b>Footage</b>, tick hooks, bodies and CTAs, then click <b>Build</b>.'}</div>`}`;

  t.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { state.filter = b.dataset.filter; renderCreatives(); });
  t.querySelectorAll('.creative').forEach(el => {
    const id = Number(el.dataset.id);
    $('[data-name]', el).onchange = e => api(`/api/creatives/${id}`, { method: 'PATCH', body: { name: e.target.value } }).catch(fail);
    $('[data-status]', el).onchange = async e => {
      try { await api(`/api/creatives/${id}`, { method: 'PATCH', body: { status: e.target.value } }); e.target.className = `status-${e.target.value}`; } catch (err) { fail(err); }
    };
    $('[data-del]', el).onclick = async () => {
      if (!confirm('Delete this video?')) return;
      try { await api(`/api/creatives/${id}`, { method: 'DELETE' }); renderProduct(state.product); } catch (err) { fail(err); }
    };
    const retry = $('[data-retry]', el);
    if (retry) retry.onclick = async () => { try { await api(`/api/creatives/${id}/retry`, { method: 'POST' }); renderProduct(state.product); } catch (err) { fail(err); } };
  });

  // While videos are being made, check every 3 seconds.
  clearInterval(state.poll);
  if (creatives.some(c => c.render === 'queued' || c.render === 'rendering')) {
    state.poll = setInterval(async () => {
      if (state.tab !== 'creatives' || !location.hash.startsWith(`#product/${state.product}`)) return clearInterval(state.poll);
      const before = JSON.stringify(state.data.creatives.map(c => c.render));
      await loadProduct(state.product).catch(() => {});
      if (JSON.stringify(state.data.creatives.map(c => c.render)) !== before) renderCreatives();
    }, 3000);
  }
}

function play(src) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<video src="${src}" controls autoplay playsinline></video>`;
  m.onclick = e => { if (e.target === m) m.remove(); };
  document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { m.remove(); document.removeEventListener('keydown', k); } });
  document.body.appendChild(m);
}

// ---------- Music library ----------
async function renderMusic() {
  const v = $('#view');
  const tracks = await api('/api/music').catch(fail) || [];
  state.musicAll = tracks;
  v.innerHTML = `
    <h1>Music</h1>
    <p class="muted">Tracks for the background of the ads, shared by all products. Use music you are allowed to use in ads
      (Meta Sound Collection, Pixabay Music, YouTube Audio Library…): TikTok trending sounds get ads muted or rejected.
      Under a voice-over the music plays quietly. Videos cut with Auto-split add their own sound here by themselves (🎬).</p>
    <div class="card">
      <div class="drop" id="musicDrop">⬆ Drop music, or a video to take its sound (mp3, m4a, wav, mp4…)<input type="file" accept="audio/*,video/*" multiple class="hidden"></div>
      <div class="progress hidden"><div></div></div>
    </div>
    ${ME.tts ? `<form class="card" id="genMusic" style="margin-top:14px">
      <h2>✨ Make music with AI (ElevenLabs)</h2>
      <p class="small muted" style="margin-top:-4px">Instrumental, no voice, cleared for ads. Describe a style and a mood, without artist or song names.</p>
      <div class="row" style="align-items:end">
        <div style="flex:1;min-width:260px"><label class="f">Description</label>
          <input type="text" name="prompt" required placeholder="e.g. elegant luxury pop, soft piano and strings, confident, for a watch ad"></div>
        <div style="width:110px"><label class="f">Seconds</label><input type="number" name="seconds" min="10" max="120" value="30"></div>
        <div style="width:100px"><label class="f">How many</label><input type="number" name="count" min="1" max="3" value="2"></div>
        <button class="btn primary">Make</button>
      </div>
    </form>` : ''}
    <div class="card" style="margin-top:14px">
      ${tracks.length ? `<table class="t"><thead><tr><th>Name</th><th>Listen</th><th>Length</th><th>Used in</th><th></th></tr></thead><tbody>
        ${tracks.map(m => `<tr data-id="${m.id}">
          <td><input type="text" value="${esc(m.name)}" data-name></td>
          <td><audio controls preload="none" src="/media/music/${m.id}" style="height:32px"></audio></td>
          <td>${fmtDur(m.duration)}</td><td>${m.used} video${m.used === 1 ? '' : 's'}</td>
          <td><button class="btn sm danger" data-del>✕</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No music yet.</div>'}
    </div>`;
  const gen = $('#genMusic');
  if (gen) gen.onsubmit = async e => {
    e.preventDefault();
    const btn = $('button', gen);
    btn.disabled = true; btn.textContent = 'Making… (1-2 min)';
    try {
      const { ids } = await api('/api/music/generate', { method: 'POST', body: Object.fromEntries(new FormData(gen)) });
      toast(`${ids.length} track(s) made`);
      renderMusic();
    } catch (err) { fail(err); btn.disabled = false; btn.textContent = 'Make'; }
  };
  const d = $('#musicDrop'), input = $('input', d);
  const send = files => upload('/api/music', {}, files, d, r => `${r.added} track(s) added${r.skipped?.length ? ` · not audio: ${r.skipped.join(', ')}` : ''}`,
    r => !!r.skipped?.length, renderMusic);
  d.onclick = e => { if (e.target !== input) input.click(); };
  input.onchange = () => send(input.files);
  d.ondragover = e => { e.preventDefault(); d.classList.add('over'); };
  d.ondragleave = () => d.classList.remove('over');
  d.ondrop = e => { e.preventDefault(); d.classList.remove('over'); send(e.dataTransfer.files); };
  v.querySelectorAll('tr[data-id]').forEach(tr => {
    const id = Number(tr.dataset.id);
    $('[data-name]', tr).onchange = e => api(`/api/music/${id}`, { method: 'PATCH', body: { name: e.target.value } }).then(() => toast('Renamed'), fail);
    $('[data-del]', tr).onclick = () => { if (confirm('Delete this track?')) api(`/api/music/${id}`, { method: 'DELETE' }).then(renderMusic, fail); };
  });
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

start().catch(() => {});

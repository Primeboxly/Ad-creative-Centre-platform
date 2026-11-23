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
  $('#meName').textContent = `${ME.user.name} · ${ME.user.role}`;
  $('#navTeam').classList.toggle('hidden', ME.user.role !== 'admin');
  route();
}

function route() {
  clearInterval(state.poll);
  $('#buildbar').classList.add('hidden');
  const [view, id, tab] = (location.hash.slice(1) || 'products').split('/');
  document.querySelectorAll('header nav a').forEach(a => a.classList.toggle('on', a.dataset.go === view || (view === 'product' && a.dataset.go === 'products')));
  state.music = null; // reload the music list for the Build bar
  if (view === 'team' && ME.user.role === 'admin') return renderTeam();
  if (view === 'music') return renderMusic();
  if (view === 'product' && id) { state.tab = tab || 'footage'; return renderProduct(Number(id)); }
  renderProducts();
}

// ---------- Products ----------
async function renderProducts() {
  const v = $('#view');
  const list = await api('/api/products').catch(fail) || [];
  v.innerHTML = `
    <div class="row spread">
      <div><h1>Products</h1><div class="muted">One collection per product: put its footage in, get ad videos out.</div></div>
      <button class="btn primary" id="newProduct">+ New product</button>
    </div>
    <form id="newForm" class="card hidden" style="margin-top:14px">
      <h2>New product</h2>
      <label class="f">Product name</label><input type="text" name="name" required placeholder="e.g. Digital Laser Distance Meter 60m">
      <label class="f">Notes for the AI: benefits, who buys it, price, offer (optional)</label>
      <textarea name="notes" placeholder="Measures up to 60 m in one click, ±2 mm. For builders, tilers, painters. 45 USD, 2 for 90 USD. Pay on delivery."></textarea>
      <div class="row" style="margin-top:10px"><button class="btn primary">Create</button><button type="button" class="btn" id="cancelNew">Cancel</button></div>
    </form>
    <div class="grid products">
      ${list.map(p => `
        <div class="card product" data-id="${p.id}">
          <div class="cover" ${p.cover_clip ? `style="background-image:url('/media/thumb/clip/${p.cover_clip}')"` : ''}>${p.cover_clip ? '' : '🎬'}</div>
          <div class="info">
            <div class="name">${esc(p.name)}</div>
            <div class="chips">
              <span class="chip hook">${p.hooks} hooks</span><span class="chip body">${p.bodies} bodies</span><span class="chip cta">${p.ctas} CTAs</span>
              <span class="chip">${p.scripts} scripts</span><span class="chip">${p.creatives} videos</span>
              ${p.winners ? `<span class="chip win">${p.winners} winners</span>` : ''}
            </div>
          </div>
        </div>`).join('')}
    </div>
    ${list.length ? '' : '<div class="empty card" style="margin-top:16px">No product yet. Click <b>+ New product</b> to create the first collection.</div>'}`;
  $('#newProduct').onclick = () => { $('#newForm').classList.remove('hidden'); $('#newForm [name=name]').focus(); };
  $('#cancelNew').onclick = () => $('#newForm').classList.add('hidden');
  $('#newForm').onsubmit = async e => {
    e.preventDefault();
    try {
      const { id } = await api('/api/products', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      location.hash = `product/${id}`;
    } catch (err) { fail(err); }
  };
  v.querySelectorAll('.product').forEach(c => c.onclick = () => { location.hash = `product/${c.dataset.id}`; });
}

// ---------- One product ----------
async function loadProduct(id) {
  state.data = await api(`/api/products/${id}`);
  if (state.product !== id) { state.sel = { hook: new Set(), body: new Set(), cta: new Set() }; state.product = id; }
  // Forget selected clips that were deleted.
  const ids = new Set(state.data.clips.map(c => c.id));
  for (const k in state.sel) for (const x of state.sel[k]) if (!ids.has(x)) state.sel[k].delete(x);
}

async function renderProduct(id) {
  try { await loadProduct(id); } catch (e) { fail(e); location.hash = 'products'; return; }
  const { product: p, clips, scripts, creatives } = state.data;
  const v = $('#view');
  v.innerHTML = `
    <span class="back" data-go="products">← All products</span>
    <div class="row spread">
      <h1>${esc(p.name)}</h1>
      ${ME.user.role === 'admin' ? '<button class="btn sm danger" id="delProduct">Delete product</button>' : ''}
    </div>
    <div class="notes">
      <div>
        <textarea id="notes" placeholder="Notes for the AI: benefits, who buys it, price, offer…">${esc(p.notes)}</textarea>
        <input type="text" id="banner" maxlength="60" value="${esc(p.banner || '')}" style="margin-top:6px"
          placeholder="CTA banner on the video, e.g. PAY ON DELIVERY · 680 ZMW (empty = 'Pay on delivery' in the script's language)">
      </div>
      <button class="btn" id="saveNotes">Save</button>
    </div>
    <div class="tabs">
      <a data-tab="footage">Footage (${clips.length})</a>
      <a data-tab="scripts">Scripts (${scripts.length})</a>
      <a data-tab="creatives">Creatives (${creatives.length})</a>
    </div>
    <div id="tab"></div>`;
  v.querySelectorAll('.tabs a').forEach(a => {
    a.classList.toggle('on', a.dataset.tab === state.tab);
    a.onclick = () => { location.hash = `product/${id}/${a.dataset.tab}`; };
  });
  $('#saveNotes').onclick = async () => {
    try { await api(`/api/products/${id}`, { method: 'PATCH', body: { notes: $('#notes').value, banner: $('#banner').value } }); toast('Saved'); } catch (e) { fail(e); }
  };
  const del = $('#delProduct');
  if (del) del.onclick = async () => {
    if (!confirm(`Delete "${p.name}" with all its footage, scripts and videos? This cannot be undone.`)) return;
    try { await api(`/api/products/${id}`, { method: 'DELETE' }); location.hash = 'products'; } catch (e) { fail(e); }
  };
  ({ footage: renderFootage, scripts: renderScripts, creatives: renderCreatives }[state.tab] || renderFootage)();
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

// Build options are remembered in this browser.
const build = Object.assign({ script: '', voice: '', music: 'none', captions: true }, JSON.parse(localStorage.getItem('acc-build') || '{}'));
const saveBuild = () => localStorage.setItem('acc-build', JSON.stringify(build));

// Voices (ElevenLabs) and music tracks, loaded once when the Build bar first needs them.
async function loadBuildLists() {
  if (!state.music) state.music = await api('/api/music').catch(() => []);
  if (ME.tts && !state.voices) state.voices = await api('/api/voices').catch(e => { fail(e); return []; });
}

// "all:sw" = every Swahili script, a number = one script, '' = clips only.
function chosenScripts() {
  const scripts = state.data.scripts;
  if (build.script.startsWith('all:')) return scripts.filter(s => s.language === build.script.slice(4)).map(s => s.id);
  return scripts.some(s => String(s.id) === build.script) ? [Number(build.script)] : [];
}

function renderBuildBar() {
  const bb = $('#buildbar');
  const n = k => state.sel[k].size;
  const any = n('hook') + n('body') + n('cta') > 0;
  if (state.tab !== 'footage' || !any) return bb.classList.add('hidden');
  if (!state.music || (ME.tts && !state.voices)) loadBuildLists().then(() => { if (state.tab === 'footage') renderBuildBar(); });
  const scripts = state.data.scripts;
  const sids = chosenScripts();
  const clipsCount = Math.max(n('hook'), 1) * Math.max(n('body'), 1) * Math.max(n('cta'), 1);
  const count = clipsCount * Math.max(sids.length, 1);
  const langs = [...new Set(scripts.map(s => s.language))];
  const voices = state.voices || [];
  const tracks = state.music || [];
  if (build.voice && voices.length && !voices.some(v => v.id === build.voice)) build.voice = '';
  bb.classList.remove('hidden');
  bb.innerHTML = `<div class="inner">
    <div class="formula"><b>${n('hook')}</b> H × <b>${n('body')}</b> B × <b>${n('cta')}</b> CTA${sids.length > 1 ? ` × <b>${sids.length}</b> scripts` : ''}
      = <b>${count}</b> video${count === 1 ? '' : 's'}</div>
    <label class="bbf">📝 <select id="bbScript">
      <option value="">No script (clips only)</option>
      ${langs.map(l => `<option value="all:${l}" ${build.script === `all:${l}` ? 'selected' : ''}>All ${ME.languages[l] || l} scripts (${scripts.filter(s => s.language === l).length})</option>`).join('')}
      ${scripts.map(s => `<option value="${s.id}" ${build.script === String(s.id) ? 'selected' : ''}>${esc(s.language.toUpperCase())} · ${esc(s.angle || 'script')} · ${esc(s.hook.slice(0, 40))}</option>`).join('')}
    </select></label>
    <label class="bbf" title="${ME.tts ? '' : 'Add ELEVENLABS_API_KEY on the server to turn this on'}">🎙 <select id="bbVoice" ${ME.tts && sids.length ? '' : 'disabled'}>
      <option value="">${ME.tts ? 'No voice' : 'Voice: not set up'}</option>
      ${voices.map(v => `<option value="${esc(v.id)}" ${build.voice === v.id ? 'selected' : ''}>${esc(v.name)}${v.info ? ` · ${esc(v.info)}` : ''}</option>`).join('')}
    </select></label>
    <label class="bbf">🎵 <select id="bbMusic">
      <option value="none" ${build.music === 'none' ? 'selected' : ''}>No music</option>
      <option value="random" ${build.music === 'random' ? 'selected' : ''} ${tracks.length ? '' : 'disabled'}>Random track (${tracks.length})</option>
      ${tracks.map(m => `<option value="${m.id}" ${build.music === String(m.id) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
    </select></label>
    <label class="bbf"><input type="checkbox" id="bbCaptions" ${build.captions ? 'checked' : ''} ${sids.length && ME.captions ? '' : 'disabled'}> Captions</label>
    <button class="btn sm" id="bbClear" style="margin-left:auto">Clear</button>
    <button class="btn primary" id="bbBuild">Build ${count} video${count === 1 ? '' : 's'}</button>
  </div>`;
  $('#bbScript').onchange = e => { build.script = e.target.value; saveBuild(); renderBuildBar(); };
  $('#bbVoice').onchange = e => { build.voice = e.target.value; saveBuild(); };
  $('#bbMusic').onchange = e => { build.music = e.target.value; saveBuild(); };
  $('#bbCaptions').onchange = e => { build.captions = e.target.checked; saveBuild(); };
  $('#bbClear').onclick = () => { state.sel = { hook: new Set(), body: new Set(), cta: new Set() }; renderFootage(); };
  $('#bbBuild').onclick = async () => {
    const v = voices.find(x => x.id === build.voice);
    try {
      await api(`/api/products/${state.product}/creatives`, { method: 'POST', body: {
        hooks: [...state.sel.hook], bodies: [...state.sel.body], ctas: [...state.sel.cta], script_ids: sids,
        voice_id: sids.length && ME.tts ? build.voice : '', voice_name: v?.name || '',
        music: build.music === 'random' && !tracks.length ? 'none' : build.music, captions: build.captions } });
      state.sel = { hook: new Set(), body: new Set(), cta: new Set() };
      toast(`${count} video(s) are being made`);
      location.hash = `product/${state.product}/creatives`;
    } catch (e) { fail(e); }
  };
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
          <div class="row spread"><div class="chips"><span class="chip">${esc((langs[s.language] || s.language))}</span>${s.angle ? `<span class="chip">${esc(s.angle)}</span>` : ''}</div>
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
          : c.render === 'failed' ? `<div style="padding:14px;text-align:center"><div style="color:#ff8a7a">Failed</div><div class="small" style="margin:6px 0">${esc(c.error).slice(0, 160)}</div><button class="btn sm" data-retry>Try again</button></div>`
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
      Under a voice-over the music plays quietly.</p>
    <div class="card">
      <div class="drop" id="musicDrop">⬆ Drop music here or click to upload (mp3, m4a, wav… up to 50 MB)<input type="file" accept="audio/*" multiple class="hidden"></div>
      <div class="progress hidden"><div></div></div>
    </div>
    <div class="card" style="margin-top:14px">
      ${tracks.length ? `<table class="t"><thead><tr><th>Name</th><th>Listen</th><th>Length</th><th>Used in</th><th></th></tr></thead><tbody>
        ${tracks.map(m => `<tr data-id="${m.id}">
          <td><input type="text" value="${esc(m.name)}" data-name></td>
          <td><audio controls preload="none" src="/media/music/${m.id}" style="height:32px"></audio></td>
          <td>${fmtDur(m.duration)}</td><td>${m.used} video${m.used === 1 ? '' : 's'}</td>
          <td><button class="btn sm danger" data-del>✕</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No music yet.</div>'}
    </div>`;
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

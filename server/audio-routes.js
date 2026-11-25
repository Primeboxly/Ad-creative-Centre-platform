// Module 5 API: ElevenLabs account and capabilities, voice library (favourites, preferences, presets, previews),
// pronunciation rules, music library, audio productions (jobs, edits, versions, approval, package) and audio files.
// Behind sign-in. The ElevenLabs key never leaves the server; audio is served by the server, never by a provider link.
import multer from 'multer';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { db } from './db.js';
import { HttpError } from './errors.js';
import { DATA_DIR, TMP_DIR } from './paths.js';
import { storage } from './storage.js';
import { safeGet } from './fetchpage.js';
import { projectRow, canEdit } from './creative.js';
import { elevenReady, subscription, models as elModels, syncVoices, voicesSyncedAt, voiceRows, voiceLanguageFit, SETTING_RANGES, DEFAULT_SETTINGS, tts } from './eleven.js';
import { LANGUAGES } from './ai.js';
import { MOODS } from './audio-director.js';
import { MIX_DEFAULTS } from './audio-media.js';
import { speechText, rulesFor } from './audio-text.js';
import { voiceoverRow } from './audio-voice.js';
import { approvedPlans, getOrCreateProduction, productionRow, productionState, applyEdit, saveVersion, restoreVersion, compareVersions, approve, latestPackage, approvedAudioPackage,
  checkPackage, captionTiming, musicLibrary, musicAsset, addMusic, deleteMusic, revalidate, mustEdit, PACKAGE_SCHEMA, PACKAGE_VERSION, STATUSES } from './audio-production.js';
import { enqueue, cancel, retryFailed, KINDS, STAGES } from './audio-jobs.js';

const INCOMING = join(DATA_DIR, 'incoming');
const MUSIC_TYPES = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };
const MAX_MUSIC_MB = Number(process.env.AU_MUSIC_MAX_MB) || 50;
const admin = u => { if (u.role !== 'admin') throw new HttpError(403, 'Only an admin can change this'); };

export function mountAudio(app, { idParam }) {
  const upload = multer({ dest: INCOMING, limits: { fileSize: MAX_MUSIC_MB * 1024 * 1024, files: 1 },
    fileFilter: (req, f, cb) => { const ok = !!MUSIC_TYPES[extname(f.originalname).toLowerCase()]; if (!ok) req.rejected = 'Only MP3, WAV, M4A, AAC, OGG or FLAC files'; cb(null, ok); } });
  const receive = (req, res) => new Promise((resolve, reject) => upload.single('file')(req, res, err => {
    if (!err) return resolve();
    if (req.file) rmSync(req.file.path, { force: true });
    reject(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? `The file is bigger than ${MAX_MUSIC_MB} MB` : err.message));
  }));

  // ---------- Account & capabilities ----------
  app.get('/api/audio/config', async (req, res) => {
    const out = { ready: elevenReady(), moods: MOODS, ranges: SETTING_RANGES, defaults: DEFAULT_SETTINGS, mix_defaults: MIX_DEFAULTS, statuses: STATUSES, kinds: KINDS, stages: STAGES,
      languages: LANGUAGES, voices_synced_at: voicesSyncedAt(), package_version: PACKAGE_VERSION, music_max_mb: MAX_MUSIC_MB };
    if (!out.ready) return res.json(out);
    try { out.models = await elModels({ force: !!req.query.refresh }); } catch (e) { out.models_error = e.message; }
    res.json(out);
  });
  app.get('/api/audio/account', async (req, res) => {
    if (!elevenReady()) throw new HttpError(503, 'ElevenLabs is not set up: add ELEVENLABS_API_KEY to the server settings.');
    const sub = await subscription();
    const usage = db.prepare(`SELECT kind, COUNT(*) calls, SUM(characters) characters, SUM(seconds) seconds, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) failed FROM audio_usage WHERE created_at >= datetime('now','-30 days') GROUP BY kind`).all();
    res.json({ subscription: sub, usage_30_days: usage });
  });
  app.get('/api/audio/package-schema', (req, res) => res.json({ version: PACKAGE_VERSION, schema: PACKAGE_SCHEMA }));

  // ---------- Voice library ----------
  app.post('/api/audio/voices/sync', async (req, res) => {
    if (!elevenReady()) throw new HttpError(503, 'ElevenLabs is not set up: add ELEVENLABS_API_KEY to the server settings.');
    res.json({ count: await syncVoices(), synced_at: voicesSyncedAt() });
  });
  app.get('/api/audio/voices', (req, res) => {
    const q = String(req.query.q || '').toLowerCase(), lang = String(req.query.language || ''), gender = String(req.query.gender || ''), age = String(req.query.age || ''), accent = String(req.query.accent || '').toLowerCase(), useCase = String(req.query.use_case || '').toLowerCase();
    const prefs = db.prepare(`SELECT scope, scope_key, voice_id FROM voice_preferences`).all();
    let list = voiceRows().map(v => ({ ...v, fit: lang ? voiceLanguageFit(v, lang) : null, preferred_for: prefs.filter(p => p.voice_id === v.voice_id).map(p => `${p.scope}:${p.scope_key}`) }));
    if (lang) list = list.filter(v => v.fit.level !== 'none');
    if (q) list = list.filter(v => `${v.name} ${v.description} ${Object.values(v.labels).join(' ')}`.toLowerCase().includes(q));
    if (gender) list = list.filter(v => v.labels.gender === gender);
    if (age) list = list.filter(v => (v.labels.age || '').replace(/ /g, '_') === age);
    if (accent) list = list.filter(v => [v.labels.accent, ...v.languages.map(l => l.accent)].some(a => (a || '').toLowerCase().includes(accent)));
    if (useCase) list = list.filter(v => (v.labels.use_case || '').toLowerCase().includes(useCase));
    if (req.query.favorites) list = list.filter(v => v.favorite);
    const rank = { verified: 3, likely: 2, unknown: 1 };
    list.sort((a, b) => (b.favorite - a.favorite) || (lang ? rank[b.fit.level] - rank[a.fit.level] : 0) || a.name.localeCompare(b.name));
    res.json({ voices: list, synced_at: voicesSyncedAt(), presets: db.prepare(`SELECT * FROM voice_presets ORDER BY name`).all().map(p => ({ ...p, settings: JSON.parse(p.settings) })), preferences: prefs });
  });
  app.post('/api/audio/voices/:vid/favorite', (req, res) => {
    const vid = String(req.params.vid);
    if (!db.prepare(`SELECT 1 FROM el_voices WHERE voice_id = ?`).get(vid)) throw new HttpError(404, 'Voice not found');
    if (req.body?.favorite === false) db.prepare(`DELETE FROM voice_favorites WHERE voice_id = ?`).run(vid);
    else db.prepare(`INSERT OR IGNORE INTO voice_favorites (voice_id, created_by) VALUES (?, ?)`).run(vid, req.user.id);
    res.json({ ok: true });
  });
  // Preferred voice for a market (country:language) or a creative type. Admin only (affects everyone).
  app.put('/api/audio/voice-preferences', (req, res) => {
    admin(req.user);
    const scope = String(req.body?.scope || ''), key = String(req.body?.scope_key || '').slice(0, 60), vid = req.body?.voice_id ? String(req.body.voice_id) : '';
    if (!['market', 'type'].includes(scope) || !key) throw new HttpError(400, 'scope (market or type) and scope_key are needed');
    if (!vid) db.prepare(`DELETE FROM voice_preferences WHERE scope = ? AND scope_key = ?`).run(scope, key);
    else {
      if (!db.prepare(`SELECT 1 FROM el_voices WHERE voice_id = ? AND available = 1`).get(vid)) throw new HttpError(404, 'Voice not found on the account');
      db.prepare(`INSERT INTO voice_preferences (scope, scope_key, voice_id, created_by) VALUES (?,?,?,?) ON CONFLICT(scope, scope_key) DO UPDATE SET voice_id = excluded.voice_id`).run(scope, key, vid, req.user.id);
    }
    res.json({ preferences: db.prepare(`SELECT scope, scope_key, voice_id FROM voice_preferences`).all() });
  });
  app.post('/api/audio/voice-presets', (req, res) => {
    const b = req.body || {};
    if (!String(b.name || '').trim() || !b.voice_id) throw new HttpError(400, 'Name and voice are needed');
    const s = b.settings || {};
    const settings = Object.fromEntries(Object.entries(SETTING_RANGES).filter(([k]) => s[k] !== undefined).map(([k, [lo, hi]]) => [k, Math.max(lo, Math.min(hi, Number(s[k]) || 0))]));
    if (s.use_speaker_boost !== undefined) settings.use_speaker_boost = !!s.use_speaker_boost;
    const id = db.prepare(`INSERT INTO voice_presets (name, voice_id, model_id, settings, market, creative_type, created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(String(b.name).slice(0, 60), String(b.voice_id), String(b.model_id || ''), JSON.stringify(settings), String(b.market || ''), String(b.creative_type || ''), req.user.id).lastInsertRowid;
    res.status(201).json({ id });
  });
  app.delete('/api/audio/voice-presets/:id', (req, res) => {
    const p = db.prepare(`SELECT * FROM voice_presets WHERE id = ?`).get(idParam(req.params.id));
    if (!p) throw new HttpError(404, 'Preset not found');
    if (req.user.role !== 'admin' && p.created_by !== req.user.id) throw new HttpError(403, 'Not allowed');
    db.prepare(`DELETE FROM voice_presets WHERE id = ?`).run(p.id);
    res.json({ ok: true });
  });
  // The provider's own preview sample, fetched by the server once (public https only) and kept.
  app.get('/api/audio/voices/:vid/preview', async (req, res) => {
    const v = db.prepare(`SELECT * FROM el_voices WHERE voice_id = ?`).get(String(req.params.vid));
    if (!v) throw new HttpError(404, 'Voice not found');
    const lang = String(req.query.language || '');
    const langs = JSON.parse(v.languages || '[]');
    const url = (lang && langs.find(l => l.language === lang && l.preview_url)?.preview_url) || v.preview_url;
    if (!url) throw new HttpError(404, 'ElevenLabs gives no preview for this voice: use "Try with my text".');
    const key = `audio/voice-previews/${v.voice_id.replace(/[^\w-]/g, '')}${lang ? `-${lang.replace(/[^\w-]/g, '')}` : ''}.mp3`;
    if (!(await storage.exists(key))) {
      if (!/^https:\/\//.test(url)) throw new HttpError(400, 'Preview link refused');
      const r = await safeGet(url, { accept: 'audio/*', maxBytes: 5e6 });
      const dir = join(TMP_DIR, `pv-${Date.now()}`); mkdirSync(dir, { recursive: true });
      try { const f = join(dir, 'p.mp3'); writeFileSync(f, r.body); await storage.put(key, f, 'audio/mpeg'); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    return storage.serve(res, key, { type: 'audio/mpeg', maxAge: 86400 });
  });
  // A short sample of a voice saying a line of the script (paid: about as many credits as characters; capped at 200 characters, cached).
  app.post('/api/audio/voices/:vid/sample', async (req, res) => {
    if (!elevenReady()) throw new HttpError(503, 'ElevenLabs is not set up');
    const vid = String(req.params.vid), text = String(req.body?.text || '').trim().slice(0, 200), lang = String(req.body?.language || 'en'), model = String(req.body?.model_id || '');
    if (!text) throw new HttpError(400, 'Type a short line');
    if (!db.prepare(`SELECT 1 FROM el_voices WHERE voice_id = ? AND available = 1`).get(vid)) throw new HttpError(404, 'Voice not found on the account');
    const list = await elModels();
    const m = list.find(x => x.model_id === model) || list.find(x => x.model_id === 'eleven_multilingual_v2') || list[0];
    const spoken = speechText(text, lang, rulesFor(Number(req.body?.product_id) || 0, lang).filter(r => r.type === 'alias'));
    const key = `audio/samples/${Buffer.from(JSON.stringify([vid, m.model_id, spoken, req.body?.settings || {}])).toString('base64url').slice(0, 120)}.mp3`;
    if (!(await storage.exists(key))) {
      const r = await tts({ voiceId: vid, modelId: m.model_id, text: spoken, settings: { ...DEFAULT_SETTINGS, ...(req.body?.settings || {}) }, languageCode: lang, userId: req.user.id });
      const dir = join(TMP_DIR, `sm-${Date.now()}`); mkdirSync(dir, { recursive: true });
      try { const f = join(dir, 's.mp3'); writeFileSync(f, r.audio); await storage.put(key, f, 'audio/mpeg'); } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    res.json({ url: `/api/audio/samples/${key.split('/').pop()}`, spoken });
  });
  app.get('/api/audio/samples/:name', (req, res) => {
    const name = String(req.params.name);
    if (!/^[\w-]+\.mp3$/.test(name)) throw new HttpError(400, 'Bad name');
    return storage.serve(res, `audio/samples/${name}`, { type: 'audio/mpeg', maxAge: 86400 });
  });

  // ---------- Pronunciation rules ----------
  app.get('/api/audio/pronunciation', (req, res) => {
    const pid = Number(req.query.product_id) || null;
    res.json({ rules: db.prepare(`SELECT * FROM pronunciation_rules WHERE product_id IS NULL OR product_id = ? ORDER BY term`).all(pid), preview: req.query.text ? speechText(String(req.query.text).slice(0, 500), String(req.query.language || 'en'), rulesFor(pid || 0, String(req.query.language || 'en'))) : undefined });
  });
  app.post('/api/audio/pronunciation', (req, res) => {
    const b = req.body || {};
    const term = String(b.term || '').trim().slice(0, 80), spoken = String(b.spoken || '').trim().slice(0, 160);
    if (!term || !spoken) throw new HttpError(400, 'Word and how to say it are needed');
    const type = b.type === 'phoneme' ? 'phoneme' : 'alias';
    const id = db.prepare(`INSERT INTO pronunciation_rules (product_id, language, term, spoken, type, alphabet, case_sensitive, created_by) VALUES (?,?,?,?,?,?,?,?)`)
      .run(Number(b.product_id) || null, LANGUAGES[b.language] ? b.language : '', term, spoken, type, b.alphabet === 'cmu-arpabet' ? 'cmu-arpabet' : 'ipa', b.case_sensitive ? 1 : 0, req.user.id).lastInsertRowid;
    res.status(201).json({ id });
  });
  app.delete('/api/audio/pronunciation/:id', (req, res) => {
    const r = db.prepare(`SELECT * FROM pronunciation_rules WHERE id = ?`).get(idParam(req.params.id));
    if (!r) throw new HttpError(404, 'Rule not found');
    if (req.user.role !== 'admin' && r.created_by !== req.user.id) throw new HttpError(403, 'Not allowed');
    db.prepare(`DELETE FROM pronunciation_rules WHERE id = ?`).run(r.id);
    res.json({ ok: true });
  });

  // ---------- Music library ----------
  app.get('/api/audio/music', (req, res) => {
    const q = String(req.query.q || '').toLowerCase(), mood = String(req.query.mood || ''), src = String(req.query.source || '');
    let list = musicLibrary();
    if (q) list = list.filter(m => `${m.name} ${m.style} ${m.prompt}`.toLowerCase().includes(q));
    if (mood) list = list.filter(m => m.mood === mood);
    if (src) list = list.filter(m => m.source === src);
    if (req.query.min) list = list.filter(m => m.duration >= Number(req.query.min));
    if (req.query.favorites) list = list.filter(m => m.favorite);
    res.json({ tracks: list });
  });
  app.post('/api/audio/music/upload', async (req, res) => {
    await receive(req, res);
    if (!req.file) throw new HttpError(400, req.rejected || 'Choose a music file');
    try {
      const b = req.body || {};
      if (b.confirm_rights !== 'yes') throw new HttpError(400, 'Confirm that you own this music or have a licence to use it in ads.');
      const r = await addMusic({ file: req.file.path, name: String(b.name || req.file.originalname.replace(/\.[^.]+$/, '')).slice(0, 120), source: 'upload', mood: String(b.mood || ''), style: String(b.style || '').slice(0, 80),
        energy: Math.max(0, Math.min(5, Number(b.energy) || 0)), tempo: Number(b.tempo) || null,
        provider: { original_name: req.file.originalname.slice(0, 200), uploaded_at: new Date().toISOString() },
        license: { source: String(b.license_source || 'Uploaded by the team').slice(0, 200), commercial_use: 'confirmed', confirmed_by: req.user.name, confirmed_at: new Date().toISOString(), note: String(b.license_note || '').slice(0, 300) }, userId: req.user.id });
      res.status(201).json(r);
    } finally { rmSync(req.file.path, { force: true }); }
  });
  app.patch('/api/audio/music/:id', (req, res) => {
    const m = musicAsset(idParam(req.params.id));
    if (!m) throw new HttpError(404, 'Track not found');
    const b = req.body || {};
    if (b.name !== undefined) db.prepare(`UPDATE music_assets SET name = ? WHERE id = ?`).run(String(b.name).trim().slice(0, 120) || m.name, m.id);
    if (b.favorite !== undefined) db.prepare(`UPDATE music_assets SET favorite = ? WHERE id = ?`).run(b.favorite ? 1 : 0, m.id);
    if (b.mood !== undefined && (MOODS.includes(b.mood) || b.mood === '')) db.prepare(`UPDATE music_assets SET mood = ? WHERE id = ?`).run(b.mood, m.id);
    if (b.style !== undefined) db.prepare(`UPDATE music_assets SET style = ? WHERE id = ?`).run(String(b.style).slice(0, 80), m.id);
    res.json(musicAsset(m.id));
  });
  app.delete('/api/audio/music/:id', async (req, res) => { await deleteMusic(idParam(req.params.id), req.user); res.json({ ok: true }); });
  app.get('/api/audio/music/:id/file', (req, res) => {
    const m = musicAsset(idParam(req.params.id));
    if (!m) throw new HttpError(404, 'Track not found');
    return storage.serve(res, m.storage_key, { type: 'audio/mpeg', download: req.query.download ? `${m.name}.mp3` : undefined, maxAge: 3600 });
  });

  // ---------- Productions ----------
  app.get('/api/creative-projects/:id/audio', (req, res) => {
    const id = idParam(req.params.id);
    projectRow(id);
    res.json({ plans: approvedPlans(id), productions: db.prepare(`SELECT id, sb_plan_id, sb_version_id, variation_index, status, approved_version_id, updated_at FROM au_productions WHERE project_id = ? ORDER BY id DESC`).all(id) });
  });
  app.post('/api/creative-projects/:id/audio/open', (req, res) => {
    const p = getOrCreateProduction(idParam(req.params.id), idParam(req.body?.sb_plan_id), req.user);
    res.json({ production_id: p.id });
  });
  // One button: create (or open) the audio of an approved script and run the whole pipeline.
  app.post('/api/creative-projects/:id/audio/generate', (req, res) => {
    const p = getOrCreateProduction(idParam(req.params.id), idParam(req.body?.sb_plan_id), req.user);
    res.status(202).json({ production_id: p.id, job: enqueue(p.id, 'full', req.user, { options: { force: !!req.body?.force, refresh_voices: !!req.body?.refresh_voices } }) });
  });
  app.get('/api/audio-productions/:id', (req, res) => res.json(productionState(idParam(req.params.id), req.user)));
  app.post('/api/audio-productions/:id/jobs', (req, res) => {
    const id = idParam(req.params.id), b = req.body || {};
    const options = { force: !!b.force, force_voice: !!b.force_voice, no_speed: !!b.no_speed, refresh_voices: !!b.refresh_voices };
    if (b.from) options.from = String(b.from);
    res.status(202).json({ job: enqueue(id, String(b.kind || ''), req.user, { target: b.target ?? '', options }) });
  });
  app.post('/api/audio-productions/:id/retry', (req, res) => res.status(202).json({ job: retryFailed(idParam(req.params.id), req.user) }));
  app.post('/api/audio-productions/:id/cancel', (req, res) => res.json({ cancelled: cancel(idParam(req.params.id), req.user) }));
  app.get('/api/audio-productions/:id/jobs/latest', (req, res) => res.json(db.prepare(`SELECT * FROM au_jobs WHERE production_id = ? ORDER BY id DESC LIMIT 1`).get(idParam(req.params.id)) || null));
  app.patch('/api/audio-productions/:id', (req, res) => { const id = idParam(req.params.id); applyEdit(id, req.body || {}, req.user); res.json(productionState(id, req.user)); });
  app.post('/api/audio-productions/:id/validate', (req, res) => { const id = idParam(req.params.id); productionRow(id); revalidate(id); res.json(productionState(id, req.user)); });
  app.post('/api/audio-productions/:id/versions', (req, res) => { const id = idParam(req.params.id); saveVersion(id, req.user, req.body?.label); res.status(201).json(productionState(id, req.user)); });
  app.post('/api/audio-productions/:id/versions/:vid/restore', (req, res) => { const id = idParam(req.params.id); restoreVersion(id, idParam(req.params.vid), req.user); res.json(productionState(id, req.user)); });
  app.get('/api/audio-productions/:id/compare', (req, res) => res.json(compareVersions(idParam(req.params.id), idParam(req.query.a), idParam(req.query.b))));
  app.post('/api/audio-productions/:id/approve', (req, res) => {
    const id = idParam(req.params.id);
    try { approve(id, req.user); res.json(productionState(id, req.user)); }
    catch (e) { if (e.details) return res.status(422).json({ error: e.message, validation: e.details }); throw e; }
  });
  app.get('/api/audio-productions/:id/package', async (req, res) => {
    const p = latestPackage(idParam(req.params.id));
    if (!p) throw new HttpError(404, 'Nothing approved yet');
    res.json({ ...p, check: await checkPackage(p.package) });
  });
  app.get('/api/audio-productions/:id/captions', (req, res) => { const c = captionTiming(idParam(req.params.id)); if (!c) throw new HttpError(404, 'No voice-over yet'); res.json(c); });
  // For Modules 6-8: the approved audio package of a project's planned video.
  app.get('/api/creative-projects/:id/audio-package', async (req, res) => {
    const p = approvedAudioPackage(idParam(req.params.id), Number(req.query.variation) || 1);
    if (!p) throw new HttpError(404, 'No approved audio for this video yet');
    res.json({ ...p, check: await checkPackage(p.package) });
  });
  // A proposed shorter script goes to Module 4 only when the team accepts it (a new draft there, to approve again).
  app.post('/api/audio-productions/:id/shorter/accept', async (req, res) => {
    const id = idParam(req.params.id);
    const prod = productionRow(id); mustEdit(prod, req.user);
    const st = productionState(id, req.user);
    const sh = st.voice?.shorter;
    if (!sh?.segments?.length) throw new HttpError(400, 'No shorter script proposed');
    const { applyEdit: sbEdit } = await import('./sb-plan.js');
    for (const s of sh.segments) if (s.text?.trim()) sbEdit(prod.sb_plan_id, { segment: { id: s.id, text: s.text } }, req.user);
    applyEdit(id, {}, req.user);
    const v = db.prepare(`SELECT id, voice FROM au_versions WHERE production_id = ? ORDER BY number DESC LIMIT 1`).get(id);
    const voice = JSON.parse(v.voice || '{}'); voice.shorter = { ...voice.shorter, status: 'sent to step 7' };
    db.prepare(`UPDATE au_versions SET voice = ? WHERE id = ?`).run(JSON.stringify(voice), v.id);
    res.json({ ok: true, message: 'The shorter script is now a draft in step 7 (Script & storyboard): check and approve it there, then make its audio.' });
  });

  // ---------- Audio files (served by this server; downloads) ----------
  app.get('/api/audio-productions/:id/media/:what', (req, res) => {
    const id = idParam(req.params.id), what = String(req.params.what);
    productionRow(id);
    const dl = n => (req.query.download ? n : undefined);
    if (what === 'voiceover') {
      const vo = voiceoverRow(idParam(req.query.vo));
      if (!vo || vo.production_id !== id) throw new HttpError(404, 'Voice-over not found');
      return storage.serve(res, vo.storage_key, { type: 'audio/mpeg', download: dl(`voiceover-${vo.id}.mp3`) });
    }
    const st = productionState(id, req.user);
    const key = what === 'mix' ? st.mix?.key : what === 'music' ? st.music?.processed_key : null;
    if (!key) throw new HttpError(404, 'Not ready yet');
    return storage.serve(res, key, { type: 'audio/mpeg', download: dl(`${what}-${id}.mp3`) });
  });
}


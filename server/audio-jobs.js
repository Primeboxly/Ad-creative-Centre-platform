// Module 5 background work: the one-button "Generate Voiceover & Music" run (plan → voice → voice-over → timing →
// duration → music → mix → storyboard sync → checks) and targeted runs. Jobs live in the database (au_jobs): one at a
// time per production, cancel (stops ffmpeg too), automatic retry of temporary errors, "retry from the failed stage",
// and after a restart running jobs go back to the queue.
import { db } from './db.js';
import { HttpError } from './errors.js';
import { aiReady, aiMock } from './ai.js';
import { elevenReady, syncVoices, voicesSyncedAt, ElevenError } from './eleven.js';
import { directAudio, proposeShorter } from './audio-director.js';
import { candidateVoices, chooseVoice, chooseModel, modelSettings, generateVoiceover, regenerateSegment, voiceoverRow, durationPlan } from './audio-voice.js';
import { productionRow, mustEdit, productionPlanOf, isOutdated, workingVersion, docsOf, saveDocs, setStatus, revalidate, reusableTrack, generateMusic, musicAsset,
  prepareVersionMusic, mixVersion, mixConfig, synchronize } from './audio-production.js';

const num = (n, d) => { const v = Number(process.env[n]); return Number.isFinite(v) && v >= 0 ? v : d; };
const CFG = { concurrency: Math.min(3, num('AU_CONCURRENCY', 1)) || 1, maxAttempts: num('AU_MAX_ATTEMPTS', 2) || 1 };
export const STAGES = ['plan', 'voice', 'voiceover', 'duration', 'music', 'mix', 'sync'];
const RUNS = { full: STAGES, plan: ['plan'], voice: ['voice', 'voiceover', 'duration', 'music', 'mix', 'sync'], voiceover: ['voiceover', 'duration', 'music', 'mix', 'sync'],
  segment: ['segment', 'duration', 'music', 'mix', 'sync'], music: ['music', 'mix'], mix: ['mix'], sync: ['sync'], shorten: ['shorten'] };
export const KINDS = Object.keys(RUNS);
const STATUS = { plan: 'preparing_plan', voice: 'selecting_voice', voiceover: 'generating_voiceover', segment: 'generating_voiceover', timing: 'analyzing_timing', duration: 'validating_duration',
  music: 'preparing_music', music_ai: 'generating_music', mix: 'mixing_audio', sync: 'synchronizing_storyboard', shorten: 'validating_duration' };
const NEEDS_EL = new Set(['full', 'voice', 'voiceover', 'segment', 'music']);
class Cancelled extends Error {}

export function enqueue(prodId, kind, user, { target = '', options = {} } = {}) {
  const prod = productionRow(prodId); mustEdit(prod, user);
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Unknown audio job');
  if (isOutdated(prod)) throw new HttpError(409, 'The script & storyboard changed since this audio was started: open the newest approved version.');
  if (NEEDS_EL.has(kind) && !elevenReady()) throw new HttpError(503, 'ElevenLabs is not set up: add ELEVENLABS_API_KEY to the server settings.');
  if (['full', 'plan', 'shorten'].includes(kind) && !aiReady() && !aiMock()) throw new HttpError(503, 'AI is not set up: add ANTHROPIC_API_KEY to the server settings.');
  if (options.from && !STAGES.includes(options.from)) throw new HttpError(400, 'Unknown stage');
  const open = db.prepare(`SELECT * FROM au_jobs WHERE production_id = ? AND status IN ('queued','running')`).get(prodId);
  if (open) { if (open.kind === kind && open.target === String(target)) return open.id; throw new HttpError(409, 'Audio work is already running for this video: wait for it or cancel it'); }
  const id = db.prepare(`INSERT INTO au_jobs (production_id, kind, target, options, max_attempts, created_by) VALUES (?,?,?,?,?,?)`).run(prodId, kind, String(target), JSON.stringify(options), CFG.maxAttempts, user.id).lastInsertRowid;
  if (prod.status !== 'approved') setStatus(prodId, STATUS[(options.from || RUNS[kind][0])] || 'preparing_plan');
  kick();
  return id;
}
// Retry only what failed: the last failed job again, starting at its failed stage.
export function retryFailed(prodId, user) {
  const j = db.prepare(`SELECT * FROM au_jobs WHERE production_id = ? ORDER BY id DESC LIMIT 1`).get(prodId);
  if (!j || j.status !== 'failed') throw new HttpError(400, 'Nothing failed');
  const opts = JSON.parse(j.options || '{}');
  const from = STAGES.includes(j.failed_stage) && RUNS[j.kind].includes(j.failed_stage) ? j.failed_stage : '';
  return enqueue(prodId, from ? 'full' : j.kind, user, { target: from ? '' : j.target, options: { ...opts, from: from || undefined, retry_of: j.id } });
}
export function cancel(prodId, user) {
  const prod = productionRow(prodId); mustEdit(prod, user);
  const jobs = db.prepare(`SELECT * FROM au_jobs WHERE production_id = ? AND status IN ('queued','running')`).all(prodId);
  for (const j of jobs) {
    if (j.status === 'queued') db.prepare(`UPDATE au_jobs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?`).run(j.id);
    const a = active.get(j.id);
    if (a) { a.cancelled = true; for (const p of a.children) { try { p.kill('SIGKILL'); } catch {} } }
  }
  if (!jobs.some(j => j.status === 'running')) setStatus(prodId, 'cancelled');
  return jobs.length;
}

const active = new Map();
let workers = 0, timer = null;
export function startAudioWorker() { if (!timer) { timer = setInterval(kick, 5000); timer.unref?.(); } kick(); }
const kick = () => setImmediate(tick);
function tick() {
  while (workers < CFG.concurrency) {
    const job = db.prepare(`UPDATE au_jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1, error = '', failed_stage = ''
      WHERE id = (SELECT j.id FROM au_jobs j WHERE j.status = 'queued' AND NOT EXISTS (SELECT 1 FROM au_jobs r WHERE r.status = 'running' AND r.production_id = j.production_id) ORDER BY j.id LIMIT 1) RETURNING *`).get();
    if (!job) return;
    workers++;
    run(job).finally(() => { workers--; kick(); });
  }
}

async function run(job) {
  const ctl = { cancelled: false, children: new Set() };
  active.set(job.id, ctl);
  let current = '';
  const log = m => db.prepare(`UPDATE au_jobs SET log = substr(log || ?, -20000) WHERE id = ?`).run(`${new Date().toISOString().slice(11, 19)} ${m}\n`, job.id);
  const stage = (s, p, status = STATUS[s]) => { current = ['timing', 'music_ai'].includes(s) ? current : s; db.prepare(`UPDATE au_jobs SET stage = ?, progress = ? WHERE id = ?`).run(s, p, job.id); setStatus(job.production_id, status || 'preparing_plan'); };
  const check = () => { if (ctl.cancelled) throw new Cancelled('Cancelled'); };
  const ctx = { children: ctl.children, check };
  try {
    log(`Start ${job.kind}${job.target ? ` (${job.target})` : ''}, attempt ${job.attempts}`);
    await pipeline(job, { log, stage, check, ctx });
    check();
    const val = revalidate(job.production_id);
    db.prepare(`UPDATE au_jobs SET status = 'completed', progress = 1, stage = 'done', finished_at = datetime('now') WHERE id = ?`).run(job.id);
    setStatus(job.production_id, 'ready');
    log(`Done: ${val?.errors.length || 0} blocking, ${val?.warnings.length || 0} warnings`);
  } catch (e) {
    const cancelled = e instanceof Cancelled || ctl.cancelled;
    const transient = !cancelled && (e instanceof ElevenError ? !!e.transient : e instanceof HttpError ? [429, 500, 502, 503, 529].includes(e.status) && !/not set up/.test(e.message) : !/ffmpeg|ffprobe/i.test(e.message));
    const retry = transient && job.attempts < job.max_attempts;
    log(`${cancelled ? 'Cancelled' : retry ? 'Will try again' : 'Failed'}${current ? ` at ${current}` : ''}: ${e.message}`);
    if (!cancelled) console.error(`Audio job ${job.id} (${job.kind}):`, e.message);
    const opts = JSON.parse(job.options || '{}');
    if (retry && current && STAGES.includes(current) && job.kind === 'full') opts.from = current; // the retry resumes where it stopped
    db.prepare(`UPDATE au_jobs SET status = ?, error = ?, failed_stage = ?, options = ?, finished_at = CASE WHEN ? THEN NULL ELSE datetime('now') END WHERE id = ?`)
      .run(cancelled ? 'cancelled' : retry ? 'queued' : 'failed', cancelled ? '' : String(e.message).slice(0, 500), cancelled ? '' : current, JSON.stringify(opts), retry ? 1 : 0, job.id);
    setStatus(job.production_id, cancelled ? 'cancelled' : retry ? STATUS[current] || 'preparing_plan' : 'failed', cancelled || retry ? '' : String(e.message).slice(0, 500));
    if (cancelled) revalidate(job.production_id);
  } finally { active.delete(job.id); }
}

// ---------- The stages ----------
async function pipeline(job, { log, stage, check, ctx }) {
  const prod = productionRow(job.production_id);
  const pp = productionPlanOf(prod);
  const opts = JSON.parse(job.options || '{}');
  const userId = job.created_by;
  const v = workingVersion(prod.id, userId);
  let d = docsOf(v);
  const save = docs => { saveDocs(v.id, docs); d = { ...d, ...docs }; };
  let steps = RUNS[job.kind];
  if (opts.from) steps = steps.slice(Math.max(0, steps.indexOf(opts.from)));
  const wantsVoice = pp.production?.voiceover !== false, wantsMusic = pp.production?.music !== false;
  const lang = pp.target.language;
  const final = () => { const vo = d.voiceover_id ? voiceoverRow(d.voiceover_id) : null; return vo ? durationPlan(vo.duration, pp.format.duration_seconds, mixConfig(d.plan, d.mix).lead_in, vo.settings.speed || 1).final : pp.format.duration_seconds; };
  const locked = k => job.kind === 'full' && d.locked?.[k];

  for (const s of steps) {
    check();
    if (s === 'plan') {
      stage('plan', 0.05);
      if (elevenReady() && (!voicesSyncedAt() || opts.refresh_voices)) { const n = await syncVoices(); log(`Voice library refreshed: ${n} voices`); }
      const voices = candidateVoices(lang);
      const plan = await directAudio({ pp, voices, productionId: prod.id, userId, force: !!opts.force });
      const { _cached, ...rest } = plan;
      save({ plan: { ...rest, made_at: new Date().toISOString() } });
      log(`Audio plan ${_cached ? '(from cache)' : 'written'}: ${rest.summary}`);
    }
    if (s === 'voice') {
      if (!wantsVoice) { log('Voice-over is off in the brief'); continue; }
      if (locked('voiceover') && d.voiceover_id) { log('Voice-over locked: kept'); continue; }
      stage('voice', 0.15);
      const choice = chooseVoice({ voice: d.voice, plan: d.plan, pp });
      const model = await chooseModel(pp, d.voice?.model_wanted || '');
      const base = d.voice?.custom_settings || (d.plan ? d.plan.voice : null);
      const settings = modelSettings(model, base);
      save({ voice: { ...(d.voice || { mode: 'auto' }), voice_id: choice.voice.voice_id, name: choice.voice.name, source: choice.source, fit: choice.fit, limitations: choice.limitations, reasons: choice.reasons,
        labels: choice.voice.labels, model_id: model.model_id, model_name: model.name, settings, settings_source: d.voice?.custom_settings ? 'team' : d.plan ? 'ai plan' : 'defaults' } });
      log(`Voice: ${choice.voice.name} (${choice.source}, ${choice.fit.level} for ${lang}) · model ${model.model_id}`);
      for (const l of choice.limitations) log(`Limitation: ${l}`);
    }
    if (s === 'voiceover') {
      if (!wantsVoice) continue;
      if (locked('voiceover') && d.voiceover_id) continue;
      if (!d.voice?.voice_id) throw new HttpError(400, 'Choose a voice first');
      stage('voiceover', 0.3);
      const model = await chooseModel(pp, d.voice.model_id);
      const choice = { voice: { voice_id: d.voice.voice_id, name: d.voice.name } };
      const settings = modelSettings(model, { ...d.voice.settings, ...(opts.speed ? { speed: opts.speed } : {}) });
      const r = await generateVoiceover({ production: prod, pp, voiceChoice: choice, model, settings, plan: d.plan, userId, ctx, force: !!opts.force_voice });
      check();
      stage('timing', 0.45, 'analyzing_timing');
      const vo = voiceoverRow(r.id);
      save({ voiceover_id: r.id, voice: { ...d.voice, settings }, mix: d.mix ? { ...d.mix, stale: true } : d.mix, sync: d.sync ? { ...d.sync, stale: true } : d.sync });
      log(`Voice-over ${r.reused ? 'reused (same text, voice and settings)' : 'generated'}: ${vo.duration} s, timing ${vo.alignment_source}`);
    }
    if (s === 'segment') {
      stage('segment', 0.3);
      if (!d.voiceover_id) throw new HttpError(400, 'Generate the voice-over first');
      const vo = voiceoverRow(d.voiceover_id);
      const r = await regenerateSegment({ production: prod, pp, base: vo.id, segmentId: job.target, model: { model_id: vo.model_id }, userId, ctx });
      save({ voiceover_id: r.id, mix: d.mix ? { ...d.mix, stale: true } : d.mix, sync: d.sync ? { ...d.sync, stale: true } : d.sync });
      log(`Segment ${job.target} regenerated${r.uneven ? ' (level differs: listen)' : ''}`);
    }
    if (s === 'duration') {
      if (!d.voiceover_id) continue;
      stage('duration', 0.5);
      const vo = voiceoverRow(d.voiceover_id);
      const lead = mixConfig(d.plan, d.mix).lead_in;
      let dp = durationPlan(vo.duration, pp.format.duration_seconds, lead, vo.settings.speed || 1);
      log(`Duration: ${dp.case} (${dp.speech_end} s of speech for ${dp.target} s)`);
      // Slightly long: one regeneration at a slightly faster (still natural) speed, unless the team turned it off or locked the voice-over.
      if (dp.case === 'slightly_long' && dp.speed > (vo.settings.speed || 1) && d.voice?.auto_speed !== false && !d.locked?.voiceover && job.kind !== 'segment' && !opts.no_speed) {
        stage('voiceover', 0.55);
        const model = await chooseModel(pp, vo.model_id);
        const settings = modelSettings(model, { ...vo.settings, speed: dp.speed });
        const r = await generateVoiceover({ production: prod, pp, voiceChoice: { voice: { voice_id: vo.voice_id, name: vo.voice_name } }, model, settings, plan: d.plan, userId, ctx });
        save({ voiceover_id: r.id, voice: { ...d.voice, settings } });
        const nv = voiceoverRow(r.id);
        dp = durationPlan(nv.duration, pp.format.duration_seconds, lead, settings.speed);
        log(`Regenerated at speed ${settings.speed}: ${nv.duration} s → ${dp.case}`);
      }
      if (dp.case === 'too_long' && !d.voice?.shorter && (aiReady() || aiMock())) {
        const p = await proposeShorter({ segments: pp.voiceover.segments.map(x => ({ id: x.id, role: x.role, text: x.text })), targetSeconds: pp.format.duration_seconds - lead - 1, actualSeconds: dp.speech_end, language: pp.target.language_name || lang, productionId: prod.id, userId });
        save({ voice: { ...d.voice, shorter: { ...p, made_at: new Date().toISOString(), status: 'proposed' } } });
        log('Much too long: a shorter script was proposed (needs approval in step 7)');
      }
    }
    if (s === 'shorten') {
      stage('shorten', 0.5);
      const vo = d.voiceover_id ? voiceoverRow(d.voiceover_id) : null;
      if (!vo) throw new HttpError(400, 'Generate the voice-over first');
      const lead = mixConfig(d.plan, d.mix).lead_in;
      const p = await proposeShorter({ segments: pp.voiceover.segments.map(x => ({ id: x.id, role: x.role, text: x.text })), targetSeconds: pp.format.duration_seconds - lead - 1, actualSeconds: vo.duration + lead, language: pp.target.language_name || lang, productionId: prod.id, userId });
      save({ voice: { ...d.voice, shorter: { ...p, made_at: new Date().toISOString(), status: 'proposed' } } });
    }
    if (s === 'music') {
      const mode = d.music?.mode || (wantsMusic ? 'ai' : 'none');
      if (mode === 'none') { save({ music: { mode: 'none' } }); log('No music'); continue; }
      stage('music', 0.65);
      const len = final();
      let music = { ...(d.music || {}), mode };
      const keep = music.asset_id && musicAsset(music.asset_id) && (job.kind !== 'music' || locked('music') || mode !== 'ai');
      if (!keep) {
        if (mode === 'upload' || mode === 'library') {
          if (!music.asset_id) { const t = reusableTrack(d.plan?.music.mood, len); if (!t) throw new HttpError(400, mode === 'upload' ? 'Upload a music file first' : 'Choose a track from the music library'); music = { ...music, asset_id: t.id, name: t.name }; }
        } else {
          delete music.fallback;
          if (!d.plan) throw new HttpError(400, 'Make the audio plan first');
          try {
            stage('music_ai', 0.7, 'generating_music');
            const r = await generateMusic({ plan: d.plan, seconds: len, productionId: prod.id, userId, force: job.kind === 'music' && !!opts.force });
            const a = musicAsset(r.id);
            music = { ...music, asset_id: a.id, name: a.name };
            log(`Music ${r.reused ? 'reused from the library (same prompt and length)' : 'generated with ElevenLabs Music'}: ${a.name}, ${a.duration} s`);
          } catch (e) {
            if (e instanceof Cancelled) throw e;
            check();
            // Fallbacks never block the creative: a library track with the same mood, else no music.
            const t = reusableTrack(d.plan.music.mood, len);
            if (t) { music = { ...music, asset_id: t.id, name: t.name, fallback: `AI music failed (${e.message}): using library track "${t.name}".` }; }
            else { music = { mode: 'ai', fallback: `AI music failed (${e.message}) and no library track matches "${d.plan.music.mood}": continuing without music. Upload or pick a track, or try again.` }; }
            log(music.fallback);
          }
        }
      }
      check();
      if (music.asset_id && (music.prepared_for !== len || !music.processed_key)) {
        stage('music', 0.78);
        music = await prepareVersionMusic(prod, music, len, ctx);
        log(`Music prepared for ${len} s (${music.processing.loop ? 'looped' : 'trimmed'}, fades ${music.processing.fade_in}/${music.processing.fade_out} s)`);
      }
      save({ music, mix: d.mix ? { ...d.mix, stale: true } : d.mix });
    }
    if (s === 'mix') {
      stage('mix', 0.85);
      const m = await mixVersion(prod, d, final(), ctx);
      if (m) { save({ mix: m }); log(`Mixed: ${m.measured.mix?.i ?? '?'} LUFS, peak ${m.measured.mix?.tp ?? '?'} dBTP`); }
      else log('Nothing to mix');
    }
    if (s === 'sync') {
      stage('sync', 0.93);
      const vo = d.voiceover_id ? voiceoverRow(d.voiceover_id) : null;
      const sync = synchronize(pp, vo, { leadIn: vo ? mixConfig(d.plan, d.mix).lead_in : 0, final: final() });
      save({ sync });
      log(`Storyboard synchronized: ${sync.shots.length} shots, ${sync.final_duration} s, ${sync.review.length} to review, ${sync.proposals.length} proposal(s)`);
    }
  }
}

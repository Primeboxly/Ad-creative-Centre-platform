// Module 6 API: video edits of a project's approved audio, editing plan (EDL), team edits, render jobs, renders
// (served by this server after sign-in, never public links), versions, approval and the package for Module 7.
import { db } from './db.js';
import { HttpError } from './errors.js';
import { storage } from './storage.js';
import { projectRow } from './creative.js';
import { readyVideos, getOrCreateEdit, editRow, editState, applyEdit, saveVersion, restoreVersion, compareVersions, approve, latestPackage, approvedVideoPackage, revalidate } from './video-production.js';
import { enqueue, cancel, retryFailed } from './video-jobs.js';
import { EDL_SCHEMA, EDL_VERSION, QUALITY, FORMATS, PACE, FRAMINGS, MOTIONS, TRANSITIONS } from './video-schemas.js';
import { DIRECTOR_SCHEMA } from './video-director.js';

export function mountVideo(app, { idParam }) {
  app.get('/api/video/config', (req, res) => res.json({ edl_version: EDL_VERSION, qualities: Object.fromEntries(Object.entries(QUALITY).map(([k, q]) => [k, q.label])), formats: FORMATS, paces: Object.fromEntries(Object.entries(PACE).map(([k, p]) => [k, p.label])), framings: FRAMINGS, motions: MOTIONS, transitions: TRANSITIONS }));
  app.get('/api/video/schemas', (req, res) => res.json({ version: EDL_VERSION, edl: EDL_SCHEMA, director: DIRECTOR_SCHEMA }));
  app.get('/api/creative-projects/:id/video', (req, res) => { const id = idParam(req.params.id); projectRow(id); res.json({ videos: readyVideos(id) }); });
  app.post('/api/creative-projects/:id/video/open', (req, res) => res.json({ edit_id: getOrCreateEdit(idParam(req.params.id), idParam(req.body?.au_approval_id), req.user).id }));
  // One button: create (or open) the edit and run plan + preview render in the background.
  app.post('/api/creative-projects/:id/video/generate', (req, res) => {
    const e = getOrCreateEdit(idParam(req.params.id), idParam(req.body?.au_approval_id), req.user);
    res.status(202).json({ edit_id: e.id, job: enqueue(e.id, 'full', req.user, { target: QUALITY[req.body?.quality] ? req.body.quality : 'preview', options: { force: !!req.body?.force } }) });
  });
  app.get('/api/video-edits/:id', (req, res) => res.json(editState(idParam(req.params.id), req.user)));
  app.post('/api/video-edits/:id/jobs', (req, res) => {
    const id = idParam(req.params.id), b = req.body || {};
    res.status(202).json({ job: enqueue(id, String(b.kind || ''), req.user, { target: b.quality || '', options: { force: !!b.force, force_render: !!b.force_render } }) });
  });
  app.post('/api/video-edits/:id/retry', (req, res) => res.status(202).json({ job: retryFailed(idParam(req.params.id), req.user) }));
  app.post('/api/video-edits/:id/cancel', (req, res) => res.json({ cancelled: cancel(idParam(req.params.id), req.user) }));
  app.get('/api/video-edits/:id/jobs/latest', (req, res) => res.json(db.prepare(`SELECT * FROM vd_jobs WHERE edit_id = ? ORDER BY id DESC LIMIT 1`).get(idParam(req.params.id)) || null));
  app.patch('/api/video-edits/:id', (req, res) => { const id = idParam(req.params.id); applyEdit(id, req.body || {}, req.user); res.json(editState(id, req.user)); });
  app.post('/api/video-edits/:id/validate', (req, res) => { const id = idParam(req.params.id); editRow(id); revalidate(id); res.json(editState(id, req.user)); });
  app.post('/api/video-edits/:id/versions', (req, res) => { const id = idParam(req.params.id); saveVersion(id, req.user, req.body?.label); res.status(201).json(editState(id, req.user)); });
  app.post('/api/video-edits/:id/versions/:vid/restore', (req, res) => { const id = idParam(req.params.id); restoreVersion(id, idParam(req.params.vid), req.user); res.json(editState(id, req.user)); });
  app.get('/api/video-edits/:id/compare', (req, res) => res.json(compareVersions(idParam(req.params.id), idParam(req.query.a), idParam(req.query.b))));
  app.get('/api/video-edits/:id/edl', (req, res) => {
    const id = idParam(req.params.id);
    const v = req.query.version ? db.prepare(`SELECT * FROM vd_versions WHERE id = ? AND edit_id = ?`).get(idParam(req.query.version), id) : db.prepare(`SELECT * FROM vd_versions WHERE edit_id = ? ORDER BY number DESC LIMIT 1`).get(id);
    if (!v?.edl) throw new HttpError(404, 'No editing plan yet');
    res.json(JSON.parse(v.edl));
  });
  app.post('/api/video-edits/:id/approve', (req, res) => {
    const id = idParam(req.params.id);
    try { approve(id, idParam(req.body?.render_id), req.user); res.json(editState(id, req.user)); }
    catch (e) { if (e.details) return res.status(422).json({ error: e.message, validation: e.details }); throw e; }
  });
  app.get('/api/video-edits/:id/package', (req, res) => { const p = latestPackage(idParam(req.params.id)); if (!p) throw new HttpError(404, 'Nothing approved yet'); res.json(p); });
  // For Module 7: the approved edit of a project's planned video.
  app.get('/api/creative-projects/:id/video-package', (req, res) => {
    const p = approvedVideoPackage(idParam(req.params.id), Number(req.query.variation) || 1);
    if (!p) throw new HttpError(404, 'No approved video edit for this video yet');
    res.json(p);
  });
  // Rendered files (signed-in team only; ranges supported for the player).
  app.get('/api/video-renders/:rid/:what', async (req, res) => {
    const r = db.prepare(`SELECT * FROM vd_renders WHERE id = ?`).get(idParam(req.params.rid));
    if (!r) throw new HttpError(404, 'Render not found');
    projectRow(editRow(r.edit_id).project_id);
    const what = String(req.params.what);
    if (what === 'thumb') { if (!r.thumb_key) throw new HttpError(404, 'No thumbnail'); return storage.serve(res, r.thumb_key, { type: 'image/jpeg', maxAge: 3600 }); }
    if (what === 'video') { if (!r.storage_key) throw new HttpError(404, 'Not rendered yet'); return storage.serve(res, r.storage_key, { type: 'video/mp4', download: req.query.download ? `creative-${r.edit_id}-r${r.id}-${r.quality}.mp4` : undefined }); }
    throw new HttpError(404, 'Unknown file');
  });
}

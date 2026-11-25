// Module 4 API: script & storyboard plans, generation jobs, edits, versions, approval, production plan. Behind sign-in.
import { HttpError } from './errors.js';
import { projectRow } from './creative.js';
import { getOrCreatePlan, planRow, planState, applyEdit, saveVersion, restoreVersion, compareVersions, approve, latestApproval, listPlans, revalidate, approvedProductionPlan } from './sb-plan.js';
import { enqueue, cancel } from './sb-jobs.js';
import { SCRIPT_DOC, STORYBOARD_DOC, STRATEGY_DOC, HOOKS_DOC, SB_SCHEMA_VERSION } from './sb-schemas.js';

export function mountScripts(app, { idParam }) {
  app.get('/api/sb/schemas', (req, res) => res.json({ version: SB_SCHEMA_VERSION, strategy: STRATEGY_DOC, hooks: HOOKS_DOC, script: SCRIPT_DOC, storyboard: STORYBOARD_DOC }));
  app.get('/api/creative-projects/:id/sb', (req, res) => {
    const id = idParam(req.params.id);
    projectRow(id);
    res.json({ plans: listPlans(id) });
  });
  // One button: create the plan for the chosen planned video (latest brief) and run everything.
  app.post('/api/creative-projects/:id/sb/generate', (req, res) => {
    const plan = getOrCreatePlan(idParam(req.params.id), req.body?.variation, req.user);
    const job = enqueue(plan.id, 'full', req.user, { options: { force: !!req.body?.force } });
    res.status(202).json({ plan_id: plan.id, job });
  });
  // Open (or create without generating) the plan of a planned video.
  app.post('/api/creative-projects/:id/sb/open', (req, res) => {
    const plan = getOrCreatePlan(idParam(req.params.id), req.body?.variation, req.user);
    res.json({ plan_id: plan.id });
  });
  app.get('/api/sb-plans/:id', (req, res) => res.json(planState(idParam(req.params.id), req.user)));
  app.post('/api/sb-plans/:id/jobs', (req, res) => {
    const id = idParam(req.params.id);
    res.status(202).json({ job: enqueue(id, String(req.body?.kind || ''), req.user, { target: req.body?.target ?? '', options: { force: true, instruction: String(req.body?.instruction || '').slice(0, 300) } }) });
  });
  app.post('/api/sb-plans/:id/cancel', (req, res) => res.json({ cancelled: cancel(idParam(req.params.id), req.user) }));
  app.patch('/api/sb-plans/:id', (req, res) => {
    const id = idParam(req.params.id);
    applyEdit(id, req.body || {}, req.user);
    res.json(planState(id, req.user));
  });
  app.post('/api/sb-plans/:id/validate', (req, res) => { const id = idParam(req.params.id); planRow(id); revalidate(id); res.json(planState(id, req.user)); });
  app.post('/api/sb-plans/:id/versions', (req, res) => { const id = idParam(req.params.id); saveVersion(id, req.user, req.body?.label); res.status(201).json(planState(id, req.user)); });
  app.post('/api/sb-plans/:id/versions/:vid/restore', (req, res) => { const id = idParam(req.params.id); restoreVersion(id, idParam(req.params.vid), req.user); res.json(planState(id, req.user)); });
  app.post('/api/sb-plans/:id/versions/:vid/duplicate', (req, res) => { const id = idParam(req.params.id); restoreVersion(id, idParam(req.params.vid), req.user, { duplicate: true }); res.json(planState(id, req.user)); });
  app.get('/api/sb-plans/:id/compare', (req, res) => res.json(compareVersions(idParam(req.params.id), idParam(req.query.a), idParam(req.query.b))));
  app.post('/api/sb-plans/:id/approve', (req, res) => {
    const id = idParam(req.params.id);
    try { approve(id, req.user); res.json(planState(id, req.user)); }
    catch (e) { if (e.details) return res.status(422).json({ error: e.message, validation: e.details }); throw e; }
  });
  app.get('/api/sb-plans/:id/production-plan', (req, res) => {
    const a = latestApproval(idParam(req.params.id));
    if (!a) throw new HttpError(404, 'Nothing approved yet');
    res.json(a);
  });
  // For Modules 5-8: the approved production plan of a project's planned video.
  app.get('/api/creative-projects/:id/production-plan', (req, res) => {
    const a = approvedProductionPlan(idParam(req.params.id), Number(req.query.variation) || 1);
    if (!a) throw new HttpError(404, 'No approved script & storyboard for this video yet');
    res.json(a);
  });
}

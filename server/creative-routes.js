// Module 3 API: creative projects, AI recommendations and Creative Briefs. All behind sign-in.
import { HttpError } from './errors.js';
import { aiReady, aiMock } from './ai.js';
import { registry } from './creative-types.js';
import { createProject, updateProject, duplicateProject, deleteProject, listProjects, projectState, validateProject, variationPlan, canEdit, projectRow } from './creative.js';
import { saveBrief, getBrief, revalidateBrief, BRIEF_SCHEMA, BRIEF_SCHEMA_VERSION, buildBrief } from './creative-brief.js';
import { recommend } from './creative-ai.js';

export function mountCreative(app, { h, idParam }) {
  const full = (id, user) => {
    const st = projectState(id);
    return { ...st, validation: validateProject(st), plan: variationPlan(st), can_edit: canEdit(st.project, user), ai: aiReady() || aiMock() };
  };

  app.get('/api/creative/registry', (req, res) => res.json({ ...registry(), brief_schema_version: BRIEF_SCHEMA_VERSION }));
  app.get('/api/creative/brief-schema', (req, res) => res.json(BRIEF_SCHEMA));

  app.get('/api/creative-projects', (req, res) => res.json(listProjects(req.query || {})));
  app.post('/api/creative-projects', (req, res) => {
    if (!req.body?.product_id) throw new HttpError(400, 'Choose a product');
    const id = createProject({ productId: idParam(req.body.product_id), name: req.body.name, user: req.user });
    res.status(201).json({ id });
  });
  app.get('/api/creative-projects/:id', (req, res) => res.json(full(idParam(req.params.id), req.user)));
  app.patch('/api/creative-projects/:id', (req, res) => {
    const id = idParam(req.params.id);
    updateProject(id, req.body || {}, req.user);
    res.json(full(id, req.user));
  });
  app.post('/api/creative-projects/:id/duplicate', (req, res) => {
    projectRow(idParam(req.params.id));
    res.status(201).json({ id: duplicateProject(idParam(req.params.id), req.user) });
  });
  app.delete('/api/creative-projects/:id', (req, res) => { deleteProject(idParam(req.params.id), req.user); res.json({ ok: true }); });

  app.post('/api/creative-projects/:id/recommendations', h(async (req, res) => {
    const id = idParam(req.params.id);
    if (!aiReady() && !aiMock()) throw new HttpError(503, 'AI is not set up: add ANTHROPIC_API_KEY to the server settings.');
    const reco = await recommend(id, req.user, { force: !!req.body?.force });
    res.json({ recommendations: reco, state: full(id, req.user) });
  }));

  // Creative Brief: preview (not saved), save a version, read, check before generation.
  app.get('/api/creative-projects/:id/brief/preview', (req, res) => res.json(buildBrief(projectState(idParam(req.params.id)))));
  app.post('/api/creative-projects/:id/brief', (req, res) => {
    const id = idParam(req.params.id);
    try {
      const r = saveBrief(id, req.user);
      res.status(201).json({ id: r.id, version: r.version, state: full(id, req.user) });
    } catch (e) {
      if (e.details) return res.status(422).json({ error: e.message, validation: e.details });
      throw e;
    }
  });
  app.get('/api/creative-projects/:id/brief', (req, res) => {
    const v = req.query.version ? idParam(req.query.version) : null;
    res.json(getBrief(idParam(req.params.id), v));
  });
  app.get('/api/creative-projects/:id/brief/check', (req, res) => {
    const b = getBrief(idParam(req.params.id));
    res.json({ version: b.version, ...revalidateBrief(b.brief) });
  });
}

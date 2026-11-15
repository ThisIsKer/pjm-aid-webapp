import { Router, type Request, type Response } from 'express';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { config } from './config.ts';
import { importSnapshotIfPresent } from './snapshot.ts';
import { slug, toApi, toApiList } from './util.ts';

/** Today's date (YYYY-MM-DD) in the machine's local timezone. */
const today = () => new Date().toLocaleDateString('sv-SE');
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE');
};

const ACTIVE_MAIL = `(m.user_state = 'open' OR (m.user_state = 'snoozed' AND COALESCE(m.snoozed_until, '') <= :today))`;
const OPEN_DOC_GAP = `(r.check_status IN ('missing','outdated') AND r.waived = 0)`;

const PROJECT_SUMMARY = `
  SELECT p.*,
    (SELECT COUNT(*) FROM deadlines d WHERE d.project_id = p.id AND d.state = 'open' AND d.due_date < :today) AS overdue,
    (SELECT MIN(d.due_date) FROM deadlines d WHERE d.project_id = p.id AND d.state = 'open' AND d.due_date >= :today) AS next_deadline,
    (SELECT COUNT(*) FROM mail_threads m WHERE m.project_id = p.id AND m.category = 'needs_reply' AND ${ACTIVE_MAIL}) AS needs_reply,
    (SELECT COUNT(*) FROM doc_requirements r WHERE r.project_id = p.id AND ${OPEN_DOC_GAP}) AS missing_docs
  FROM projects p`;

/** Columns the UI / Claude may edit on a project (camelCase API name → DB column). */
const PROJECT_FIELDS: Record<string, { col: string; json?: boolean; bool?: boolean }> = {
  name: { col: 'name' },
  client: { col: 'client' },
  description: { col: 'description' },
  phase: { col: 'phase' },
  status: { col: 'status' },
  pmNote: { col: 'pm_note' },
  jiraKeys: { col: 'jira_keys', json: true },
  sharepointUrl: { col: 'sharepoint_url' },
  confluenceSpace: { col: 'confluence_space' },
  mailKeywords: { col: 'mail_keywords', json: true },
  mailDomains: { col: 'mail_domains', json: true },
  active: { col: 'active', bool: true },
};

function patch(db: DatabaseSync, table: string, id: string, body: Record<string, unknown>,
  fields: Record<string, { col: string; json?: boolean; bool?: boolean }>): number {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  for (const [key, def] of Object.entries(fields)) {
    if (!(key in body)) continue;
    const v = body[key];
    sets.push(`${def.col} = ?`);
    values.push(def.json ? JSON.stringify(v ?? []) : def.bool ? (v ? 1 : 0) : ((v ?? null) as SQLInputValue));
  }
  if (!sets.length) return 0;
  sets.push(`updated_at = datetime('now')`);
  return Number(db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...values, id).changes);
}

const notFound = (res: Response) => res.status(404).json({ error: 'not found' });
const param = (req: Request, name: string) => String(req.params[name]);

export function apiRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get('/health', (_req, res) => {
    const last = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();
    res.json({ ok: true, today: today(), lastSync: last ? toApi(last) : null });
  });

  // ---------- Dashboard ----------
  r.get('/dashboard', (req, res) => {
    const t = today();
    const horizon = addDays(t, Number(req.query['days'] ?? 14));
    const projects = toApiList(db.prepare(`${PROJECT_SUMMARY} WHERE p.active = 1
      ORDER BY CASE p.status WHEN 'red' THEN 0 WHEN 'amber' THEN 1 WHEN 'green' THEN 2 ELSE 3 END, p.name`).all({ today: t }));
    const deadlines = toApiList(db.prepare(`
      SELECT d.*, p.name AS project_name FROM deadlines d JOIN projects p ON p.id = d.project_id
      WHERE d.state = 'open' AND p.active = 1 AND d.due_date IS NOT NULL AND d.due_date <= :horizon
      ORDER BY d.due_date`).all({ horizon }));
    const count = (sql: string, params: Record<string, SQLInputValue> = {}) => (db.prepare(sql).get(params) as { n: number }).n;
    const last = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();
    res.json({
      today: t,
      horizon,
      kpis: {
        activeProjects: projects.length,
        overdue: deadlines.filter((d) => String(d['dueDate']) < t).length,
        dueSoon: deadlines.filter((d) => String(d['dueDate']) >= t).length,
        needsReply: count(`SELECT COUNT(*) AS n FROM mail_threads m WHERE m.category = 'needs_reply' AND ${ACTIVE_MAIL}`, { today: t }),
        missingDocs: count(`SELECT COUNT(*) AS n FROM doc_requirements r JOIN projects p ON p.id = r.project_id
          WHERE p.active = 1 AND ${OPEN_DOC_GAP}`),
      },
      projects,
      deadlines,
      lastSync: last ? toApi(last) : null,
    });
  });

  // ---------- Projects ----------
  r.get('/projects', (req, res) => {
    const where = req.query['all'] === 'true' ? '' : 'WHERE p.active = 1';
    res.json(toApiList(db.prepare(`${PROJECT_SUMMARY} ${where} ORDER BY p.name`).all({ today: today() })));
  });

  r.get('/projects/:id', (req, res) => {
    const id = param(req, 'id');
    const project = db.prepare(`${PROJECT_SUMMARY} WHERE p.id = :id`).get({ id, today: today() });
    if (!project) return notFound(res);
    res.json({
      ...toApi(project),
      deadlines: toApiList(db.prepare('SELECT * FROM deadlines WHERE project_id = ? ORDER BY state, due_date').all(id)),
      mailThreads: toApiList(db.prepare('SELECT * FROM mail_threads WHERE project_id = ? ORDER BY last_message_at DESC').all(id)),
      docRequirements: toApiList(db.prepare('SELECT * FROM doc_requirements WHERE project_id = ? ORDER BY phase, title').all(id)),
    });
  });

  r.post('/projects', (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body['name'] !== 'string' || !body['name'].trim()) return res.status(400).json({ error: 'name is required' });
    const id = typeof body['id'] === 'string' && body['id'] ? slug(body['id']) : slug(body['name']);
    db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, body['name']);
    patch(db, 'projects', id, body, PROJECT_FIELDS);
    res.status(201).json(toApi(db.prepare('SELECT * FROM projects WHERE id = ?').get(id)));
  });

  r.patch('/projects/:id', (req, res) => {
    const id = param(req, 'id');
    if (!patch(db, 'projects', id, req.body as Record<string, unknown>, PROJECT_FIELDS)) return notFound(res);
    res.json(toApi(db.prepare('SELECT * FROM projects WHERE id = ?').get(id)));
  });

  // ---------- Deadlines (manual ones; Jira ones arrive via snapshot) ----------
  r.post('/projects/:id/deadlines', (req, res) => {
    const projectId = param(req, 'id');
    const b = req.body as { title?: string; dueDate?: string };
    if (!b.title || !b.dueDate) return res.status(400).json({ error: 'title and dueDate are required' });
    const id = `manual-${Date.now().toString(36)}`;
    db.prepare(`INSERT INTO deadlines (id, project_id, title, due_date, source) VALUES (?, ?, ?, ?, 'manual')`)
      .run(id, projectId, b.title, b.dueDate);
    res.status(201).json(toApi(db.prepare('SELECT * FROM deadlines WHERE id = ?').get(id)));
  });

  r.patch('/deadlines/:id', (req, res) => {
    const changes = patch(db, 'deadlines', param(req, 'id'), req.body as Record<string, unknown>, {
      title: { col: 'title' }, dueDate: { col: 'due_date' }, state: { col: 'state' },
    });
    if (!changes) return notFound(res);
    res.json(toApi(db.prepare('SELECT * FROM deadlines WHERE id = ?').get(param(req, 'id'))));
  });

  // ---------- Mail triage ----------
  r.get('/mail', (req, res) => {
    const category = req.query['category'];
    const showAll = req.query['state'] === 'all';
    const rows = db.prepare(`
      SELECT m.*, p.name AS project_name FROM mail_threads m LEFT JOIN projects p ON p.id = m.project_id
      WHERE ${showAll ? '1 = 1' : ACTIVE_MAIL} ${category ? 'AND m.category = :category' : ''}
      ORDER BY CASE m.urgency WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, m.last_message_at`)
      .all(category ? { today: today(), category: String(category) } : { today: today() });
    res.json(toApiList(rows));
  });

  r.patch('/mail/:id', (req, res) => {
    const changes = patch(db, 'mail_threads', param(req, 'id'), req.body as Record<string, unknown>, {
      userState: { col: 'user_state' }, snoozedUntil: { col: 'snoozed_until' }, projectId: { col: 'project_id' },
    });
    if (!changes) return notFound(res);
    res.json(toApi(db.prepare('SELECT * FROM mail_threads WHERE id = ?').get(param(req, 'id'))));
  });

  // ---------- Documentation checklist ----------
  r.get('/docs', (req, res) => {
    const onlyGaps = req.query['gaps'] !== 'false';
    const rows = db.prepare(`
      SELECT r.*, p.name AS project_name FROM doc_requirements r JOIN projects p ON p.id = r.project_id
      WHERE p.active = 1 ${onlyGaps ? `AND (${OPEN_DOC_GAP} OR r.check_status = 'unknown')` : ''}
      ORDER BY p.name, r.phase, r.title`).all();
    res.json(toApiList(rows));
  });

  r.post('/projects/:id/docs', (req, res) => {
    const projectId = param(req, 'id');
    const b = req.body as { title?: string; repository?: string; phase?: string; locationHint?: string };
    if (!b.title || !b.repository) return res.status(400).json({ error: 'title and repository are required' });
    const id = `${projectId}--${slug(b.title)}`;
    db.prepare('INSERT INTO doc_requirements (id, project_id, phase, title, repository, location_hint) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, projectId, b.phase ?? null, b.title, b.repository, b.locationHint ?? null);
    res.status(201).json(toApi(db.prepare('SELECT * FROM doc_requirements WHERE id = ?').get(id)));
  });

  r.patch('/docs/:id', (req, res) => {
    const changes = patch(db, 'doc_requirements', param(req, 'id'), req.body as Record<string, unknown>, {
      waived: { col: 'waived', bool: true }, locationHint: { col: 'location_hint' }, phase: { col: 'phase' },
    });
    if (!changes) return notFound(res);
    res.json(toApi(db.prepare('SELECT * FROM doc_requirements WHERE id = ?').get(param(req, 'id'))));
  });

  // ---------- Sync (Claude snapshot import) ----------
  r.post('/sync/import', (req, res) => {
    res.json(importSnapshotIfPresent(db, config.snapshotFile, req.query['force'] === 'true'));
  });

  r.get('/sync/runs', (_req, res) => {
    res.json(toApiList(db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 20').all()));
  });

  return r;
}

import { Router, type Request, type Response } from 'express';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { agentStatus, currentOrLastJob, recentJobs, startSync, type SyncMode } from './agent.ts';
import { config } from './config.ts';
import { addDays, isoToday } from './flags.ts';
import { ACTIVE_MAIL, getProjectRow, loadDeadlines, loadProjects } from './projects.ts';
import { applyDocTemplate } from './seed.ts';
import { dayPlan } from './today.ts';
import { importSnapshotIfPresent } from './snapshot.ts';
import { slug, toApi, toApiList } from './util.ts';

type FieldDef = { col: string; json?: boolean; bool?: boolean };

/** Fields the UI / Claude may edit on a project (camelCase API name → DB column). */
const PROJECT_FIELDS: Record<string, FieldDef> = {
  name: { col: 'name' },
  client: { col: 'client' },
  description: { col: 'description' },
  phase: { col: 'phase' },
  status: { col: 'status' },
  pmNote: { col: 'pm_note' },
  sharepointUrl: { col: 'sharepoint_url' },
  sharepointFolderUri: { col: 'sharepoint_folder_uri' },
  confluenceSpace: { col: 'confluence_space' },
  mailKeywords: { col: 'mail_keywords', json: true },
  mailDomains: { col: 'mail_domains', json: true },
  active: { col: 'active', bool: true },
  groupId: { col: 'group_id' },
};

function patch(db: DatabaseSync, table: string, id: string, body: Record<string, unknown>, fields: Record<string, FieldDef>, touch = true): number {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  for (const [key, def] of Object.entries(fields)) {
    if (!(key in body)) continue;
    const v = body[key];
    sets.push(`${def.col} = ?`);
    values.push(def.json ? JSON.stringify(v ?? []) : def.bool ? (v ? 1 : 0) : ((v ?? null) as SQLInputValue));
  }
  if (!sets.length) return 0;
  if (touch) sets.push(`updated_at = datetime('now')`);
  return Number(db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...values, id).changes);
}

const notFound = (res: Response) => res.status(404).json({ error: 'not found' });
const param = (req: Request, name: string) => String(req.params[name]);
const lastSync = (db: DatabaseSync) => {
  const last = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();
  return last ? toApi(last) : null;
};

export function apiRouter(db: DatabaseSync): Router {
  const r = Router();

  r.get('/health', (_req, res) => res.json({ ok: true, today: isoToday(), lastSync: lastSync(db) }));

  // ---------- Dashboard ----------
  r.get('/dashboard', (req, res) => {
    const today = isoToday();
    const horizon = addDays(today, Number(req.query['days'] ?? 14));
    const projects = loadProjects(db);
    const deadlines = loadDeadlines(db,
      `d.state = 'open' AND p.active = 1 AND d.due_date IS NOT NULL AND d.due_date <= :horizon`, { horizon });
    const count = (sql: string, params: Record<string, SQLInputValue> = {}) => (db.prepare(sql).get(params) as { n: number }).n;
    res.json({
      today,
      horizon,
      kpis: {
        activeProjects: projects.length,
        overdue: deadlines.filter((d) => d.flags.includes('overdue')).length,
        atRisk: deadlines.filter((d) => d.flags.includes('at_risk')).length,
        dueSoon: deadlines.filter((d) => !d.flags.includes('overdue')).length,
        needsReply: count(`SELECT COUNT(*) AS n FROM mail_threads m WHERE m.category = 'needs_reply' AND ${ACTIVE_MAIL}`, { today }),
        missingDocs: projects.reduce((n, p) => n + p.missingDocs, 0),
        uncheckedDocs: projects.reduce((n, p) => n + p.uncheckedDocs, 0),
      },
      projects: projects.map(({ docs: _docs, ...p }) => p),
      deadlines,
      lastSync: lastSync(db),
    });
  });

  // ---------- Day plan: today's activities and meetings ----------
  r.get('/today', (req, res) => {
    const date = typeof req.query['date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query['date']) ? req.query['date'] : undefined;
    res.json(dayPlan(db, date));
  });

  // ---------- Projects ----------
  r.get('/projects', (req, res) => res.json(loadProjects(db, { all: req.query['all'] === 'true' })));

  r.get('/projects/:id', (req, res) => {
    const id = param(req, 'id');
    const [project] = loadProjects(db, { id });
    if (!project) return notFound(res);
    res.json({
      ...project,
      epics: toApiList(db.prepare('SELECT * FROM jira_epics WHERE project_id = ? ORDER BY key').all(id)),
      deadlines: loadDeadlines(db, 'd.eff_project_id = :id', { id }),
      mailThreads: toApiList(db.prepare('SELECT * FROM mail_threads WHERE project_id = ? ORDER BY last_message_at DESC').all(id)),
      docRequirements: project.docs,
    });
  });

  r.post('/projects', (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body['name'] !== 'string' || !body['name'].trim()) return res.status(400).json({ error: 'name is required' });
    const id = typeof body['id'] === 'string' && body['id'] ? slug(body['id']) : slug(body['name']);
    db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, body['name']);
    patch(db, 'projects', id, body, PROJECT_FIELDS);
    applyDocTemplate(db, id);
    res.status(201).json(getProjectRow(db, id));
  });

  r.patch('/projects/:id', (req, res) => {
    const id = param(req, 'id');
    if (!patch(db, 'projects', id, req.body as Record<string, unknown>, PROJECT_FIELDS)) return notFound(res);
    res.json(getProjectRow(db, id));
  });

  // ---------- Custom project groups ----------
  const groups = () => toApiList(db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM projects p WHERE p.group_id = g.id) AS project_count
    FROM project_groups g ORDER BY g.sort, g.name`).all());
  r.get('/groups', (_req, res) => res.json(groups()));

  r.post('/groups', (req, res) => {
    const b = req.body as { name?: string; color?: string };
    if (!b.name?.trim()) return res.status(400).json({ error: 'name is required' });
    const id = Number(db.prepare('INSERT INTO project_groups (name, color, sort) VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM project_groups))')
      .run(b.name.trim(), b.color ?? null).lastInsertRowid);
    res.status(201).json(toApi(db.prepare('SELECT * FROM project_groups WHERE id = ?').get(id)));
  });

  r.patch('/groups/:id', (req, res) => {
    const changes = patch(db, 'project_groups', param(req, 'id'), req.body as Record<string, unknown>, {
      name: { col: 'name' }, color: { col: 'color' }, sort: { col: 'sort' },
    }, false);
    if (!changes) return notFound(res);
    res.json(toApi(db.prepare('SELECT * FROM project_groups WHERE id = ?').get(param(req, 'id'))));
  });

  r.delete('/groups/:id', (req, res) => {
    // Projects in the group are kept and become ungrouped (ON DELETE SET NULL).
    const changes = Number(db.prepare('DELETE FROM project_groups WHERE id = ?').run(param(req, 'id')).changes);
    if (!changes) return notFound(res);
    res.status(204).end();
  });

  // ---------- Jira epics (link an epic to another project to group several epics) ----------
  r.get('/jira/epics', (_req, res) => {
    res.json(toApiList(db.prepare(`SELECT e.*, p.name AS project_name FROM jira_epics e
      LEFT JOIN projects p ON p.id = e.project_id WHERE e.active = 1 ORDER BY e.key`).all()));
  });

  r.patch('/jira/epics/:key', (req, res) => {
    const key = param(req, 'key');
    const projectId = (req.body as { projectId?: string }).projectId;
    if (!projectId || !getProjectRow(db, projectId)) return res.status(400).json({ error: 'valid projectId required' });
    const prev = db.prepare('SELECT project_id FROM jira_epics WHERE key = ?').get(key) as { project_id: string | null } | undefined;
    if (!prev) return notFound(res);
    db.prepare(`UPDATE jira_epics SET project_id = ?, updated_at = datetime('now') WHERE key = ?`).run(projectId, key);
    // A Jira-created project left without epics is hidden.
    if (prev.project_id && prev.project_id !== projectId) {
      db.prepare(`UPDATE projects SET active = 0 WHERE id = ? AND origin = 'jira'
        AND NOT EXISTS (SELECT 1 FROM jira_epics WHERE project_id = ?)`).run(prev.project_id, prev.project_id);
    }
    res.json(toApi(db.prepare('SELECT * FROM jira_epics WHERE key = ?').get(key)));
  });

  // ---------- Deadlines (manual ones; Jira phases arrive via snapshot) ----------
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
    const id = param(req, 'id');
    const row = db.prepare('SELECT source FROM deadlines WHERE id = ?').get(id) as { source: string } | undefined;
    if (!row) return notFound(res);
    if (row.source === 'jira') return res.status(409).json({ error: 'Jira phases are edited in Jira' });
    patch(db, 'deadlines', id, req.body as Record<string, unknown>, {
      title: { col: 'title' }, dueDate: { col: 'due_date' }, state: { col: 'state' },
    });
    res.json(toApi(db.prepare('SELECT * FROM deadlines WHERE id = ?').get(id)));
  });

  // ---------- Mail triage ----------
  r.get('/mail', (req, res) => {
    const category = req.query['category'];
    const showAll = req.query['state'] === 'all';
    const params: Record<string, SQLInputValue> = showAll ? {} : { today: isoToday() };
    if (category) params['category'] = String(category);
    const rows = db.prepare(`
      SELECT m.*, p.name AS project_name FROM mail_threads m LEFT JOIN projects p ON p.id = m.project_id
      WHERE ${showAll ? '1 = 1' : ACTIVE_MAIL} ${category ? 'AND m.category = :category' : ''}
      ORDER BY CASE m.urgency WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, m.last_message_at`).all(params);
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
  /** Documentation checklist of active projects; `required` = due given the project's current phase. */
  r.get('/docs', (req, res) => {
    const all = req.query['all'] === 'true';
    const rows = loadProjects(db).flatMap((p) => p.docs.map((d) => ({
      ...d, projectName: p['name'], projectPhase: p.currentPhase?.name ?? p['phase'] ?? null,
      projectFolderUrl: p['sharepointUrl'] ?? null,
    })));
    res.json(all ? rows : rows.filter((d) => d.required && !d.waived && d.checkStatus !== 'present'));
  });

  r.post('/projects/:id/docs', (req, res) => {
    const projectId = param(req, 'id');
    const b = req.body as { title?: string; repository?: string; phase?: string; requiredFrom?: string; locationHint?: string; foundUrl?: string };
    if (!b.title?.trim() || !['sharepoint', 'confluence'].includes(b.repository ?? '')) {
      return res.status(400).json({ error: 'title and repository (sharepoint | confluence) are required' });
    }
    if (!getProjectRow(db, projectId)) return notFound(res);
    const id = `${projectId}--${slug(b.title)}`;
    const found = b.foundUrl?.trim() || null;
    // Manual requirement (from_template = 0): kept even if the template changes. A link means "already present".
    db.prepare(`INSERT INTO doc_requirements (id, project_id, phase, required_from, title, repository, location_hint,
        check_status, found_url, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, b.phase || null, b.requiredFrom || null, b.title.trim(), b.repository!, b.locationHint?.trim() || null,
        found ? 'present' : 'unknown', found, found ? new Date().toISOString() : null);
    res.status(201).json(toApi(db.prepare('SELECT * FROM doc_requirements WHERE id = ?').get(id)));
  });

  r.patch('/docs/:id', (req, res) => {
    const changes = patch(db, 'doc_requirements', param(req, 'id'), req.body as Record<string, unknown>, {
      waived: { col: 'waived', bool: true }, locationHint: { col: 'location_hint' }, foundUrl: { col: 'found_url' },
    });
    if (!changes) return notFound(res);
    res.json(toApi(db.prepare('SELECT * FROM doc_requirements WHERE id = ?').get(param(req, 'id'))));
  });

  // ---------- Sync (Claude snapshot import) ----------
  r.post('/sync/import', (req, res) => {
    res.json(importSnapshotIfPresent(db, config.snapshotFile, req.query['force'] === 'true'));
  });

  // ---------- Sync now (Claude Code headless) ----------
  r.get('/sync/agent', (req, res) => res.json(agentStatus(req.query['refresh'] === 'true')));

  r.post('/sync/run', (req, res) => {
    const body = req.body as { mode?: string; lang?: string };
    const mode = String(body.mode ?? 'daily') as SyncMode;
    const lang = body.lang === 'en' ? 'en' : 'it';
    if (!['daily', 'docs', 'jira'].includes(mode)) return res.status(400).json({ error: 'mode must be daily, docs or jira' });
    try {
      res.status(202).json(startSync(db, mode, lang));
    } catch (err) {
      const e = err as Error & { status?: number };
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });

  r.get('/sync/jobs/current', (_req, res) => res.json(currentOrLastJob(db)));
  r.get('/sync/jobs', (_req, res) => res.json(recentJobs(db)));

  r.get('/sync/runs', (_req, res) => {
    res.json(toApiList(db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 20').all()));
  });

  return r;
}

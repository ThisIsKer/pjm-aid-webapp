import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { getSpSettings, rootAvailable, saveSpSettings, scanLocalSharePoint } from './localsp.ts';
import { bridgeStatus, getTodoSettings, loadTask, loadTasks, prepareBridge, queueTodoWrite, saveTodoSettings } from './todo.ts';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { agentStatus, currentOrLastJob, recentJobs, startSync, type SyncMode, autoSync } from './agent.ts';
import { config } from './config.ts';
import { addDays, isoToday } from './flags.ts';
import { ACTIVE_MAIL, getProjectRow, loadDeadlines, loadProjects, docRef } from './projects.ts';
import { applyDocTemplate } from './seed.ts';
import { dayPlan, weekPlan } from './today.ts';
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

export function apiRouter(db: DatabaseSync, sharepoint?: { rescan: () => void }, todo?: { refresh: () => void }): Router {
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
        attentionDocs: projects.reduce((n, p) => n + p.attentionDocs, 0),
      },
      projects: projects.map(({ docs: _docs, ...p }) => p),
      deadlines,
      lastSync: lastSync(db),
    });
  });

  // ---------- Day plan: today's activities and meetings ----------
  r.get('/week', (req, res) => {
    const date = typeof req.query['date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query['date']) ? req.query['date'] : undefined;
    res.json(weekPlan(db, date));
  });

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
      ...d, projectName: p['name'], projectClient: p['client'] ?? null, projectPhase: p.currentPhase?.name ?? p['phase'] ?? null,
      projectFolderUrl: p['sharepointUrl'] ?? null,
    })));
    res.json(all ? rows : rows.filter((d) => d.state === 'missing' && d.required || d.state === 'new' || d.state === 'updated'));
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
    if (found) db.prepare('UPDATE doc_requirements SET confirmed_at = ?, confirmed_ref = ? WHERE id = ?').run(new Date().toISOString(), docRef(found, null), id);
    res.status(201).json(toApi(db.prepare('SELECT * FROM doc_requirements WHERE id = ?').get(id)));
  });

  /** Files of the project's SharePoint folder, as listed by the last documentation check (folder browser). */
  r.get('/projects/:id/files', (req, res) => {
    // refresh=true: re-read the OneDrive-synced folder first (fast: names and dates only)
    if (req.query['refresh'] === 'true') scanLocalSharePoint(db, param(req, 'id'));
    const p = db.prepare('SELECT sharepoint_url, files_scanned_at, files_source FROM projects WHERE id = ?').get(param(req, 'id')) as
      { sharepoint_url: string | null; files_scanned_at: string | null; files_source: string | null } | undefined;
    if (!p) return notFound(res);
    res.json({
      folderUrl: p.sharepoint_url, scannedAt: p.files_scanned_at, source: p.files_source ?? 'claude',
      files: toApiList(db.prepare('SELECT path, url, modified_at, size FROM project_files WHERE project_id = ? ORDER BY path').all(param(req, 'id'))),
    });
  });

  /**
   * The user chooses where a document is: a file from the folder listing, a path below the project folder, or a link.
   * The location is pinned (Claude's matching no longer changes it) and confirmed (OK) for the file's current version.
   */
  r.put('/docs/:id/location', (req, res) => {
    const id = param(req, 'id');
    const row = db.prepare(`SELECT d.project_id, p.sharepoint_url FROM doc_requirements d JOIN projects p ON p.id = d.project_id
      WHERE d.id = ?`).get(id) as { project_id: string; sharepoint_url: string | null } | undefined;
    if (!row) return notFound(res);
    const input = String((req.body as { location?: string }).location ?? '').trim();
    if (!input) return res.status(400).json({ error: 'location is required (a path below the project folder or a link)' });
    let url: string;
    let path: string | null;
    if (/^https?:\/\//i.test(input)) {
      url = input.replace(/ /g, '%20');
      path = null;
    } else {
      if (!row.sharepoint_url) return res.status(400).json({ error: 'The project has no SharePoint folder: paste a full link instead' });
      path = input.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      url = `${row.sharepoint_url.replace(/\/+$/, '')}/${path.split('/').map((s) => encodeURIComponent(s)).join('/')}`;
    }
    const files = db.prepare('SELECT path, url, modified_at FROM project_files WHERE project_id = ?').all(row.project_id) as
      { path: string; url: string; modified_at: string | null }[];
    const n = (u: string) => { try { return decodeURIComponent(u).toLowerCase(); } catch { return u.toLowerCase(); } };
    const f = files.find((x) => n(x.url) === n(url) || (path && n(x.path) === n(path)));
    if (f) { url = f.url; path = f.path; }
    const modifiedAt = f?.modified_at ?? null;
    const now = new Date().toISOString();
    db.prepare(`UPDATE doc_requirements SET pinned = 1, check_status = 'present', found_url = ?, found_path = ?, found_modified_at = ?,
      checked_at = ?, confirmed_at = ?, confirmed_ref = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(url, path, modifiedAt, now, now, docRef(url, modifiedAt), id);
    res.json(toApi(db.prepare('SELECT * FROM doc_requirements WHERE id = ?').get(id)));
  });

  /** Back to Claude's automatic detection (next documentation check). */
  r.delete('/docs/:id/location', (req, res) => {
    const changes = db.prepare(`UPDATE doc_requirements SET pinned = 0, check_status = 'unknown', found_url = NULL, found_path = NULL,
      found_modified_at = NULL, confirmed_at = NULL, confirmed_ref = NULL, updated_at = datetime('now') WHERE id = ?`).run(param(req, 'id')).changes;
    if (!changes) return notFound(res);
    res.json(toApi(db.prepare('SELECT * FROM doc_requirements WHERE id = ?').get(param(req, 'id'))));
  });

  r.patch('/docs/:id', (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body['confirmed'] === 'boolean') {
      // OK = "the document is there and fine" (for the current version of the file, or by hand when not found)
      const row = db.prepare('SELECT check_status, found_url, found_modified_at FROM doc_requirements WHERE id = ?').get(param(req, 'id')) as
        { check_status: string; found_url: string | null; found_modified_at: string | null } | undefined;
      if (!row) return notFound(res);
      const ref = row.check_status === 'present' && row.found_url ? docRef(row.found_url, row.found_modified_at) : 'manual';
      db.prepare(`UPDATE doc_requirements SET confirmed_at = ?, confirmed_ref = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(body['confirmed'] ? new Date().toISOString() : null, body['confirmed'] ? ref : null, param(req, 'id'));
      delete body['confirmed'];
      if (!Object.keys(body).length) return res.json(toApi(db.prepare('SELECT * FROM doc_requirements WHERE id = ?').get(param(req, 'id'))));
    }
    const changes = patch(db, 'doc_requirements', param(req, 'id'), req.body as Record<string, unknown>, {
      waived: { col: 'waived', bool: true }, locationHint: { col: 'location_hint' }, foundUrl: { col: 'found_url' },
    });
    if (!changes) return notFound(res);
    res.json(toApi(db.prepare('SELECT * FROM doc_requirements WHERE id = ?').get(param(req, 'id'))));
  });

  // ---------- SharePoint folder synced on this PC (OneDrive) ----------
  const spStatus = () => {
    const s = getSpSettings(db);
    const available = s.enabled && rootAvailable(s);
    const stats = db.prepare(`SELECT COUNT(*) AS projects, SUM(files_source = 'local') AS mapped, MAX(CASE WHEN files_source = 'local'
      THEN files_scanned_at END) AS lastScanAt FROM projects WHERE active = 1`).get() as { projects: number; mapped: number | null; lastScanAt: string | null };
    return { ...s, available, projects: stats.projects, mapped: stats.mapped ?? 0, lastScanAt: stats.lastScanAt };
  };
  r.get('/settings/sharepoint', (_req, res) => res.json(spStatus()));
  r.put('/settings/sharepoint', (req, res) => {
    const b = req.body as { enabled?: boolean; localRoot?: string; webBase?: string };
    saveSpSettings(db, { enabled: b.enabled, localRoot: b.localRoot, webBase: b.webBase });
    if (getSpSettings(db).enabled === false) db.prepare(`UPDATE projects SET files_source = NULL WHERE files_source = 'local'`).run();
    sharepoint?.rescan();
    res.json(spStatus());
  });
  r.post('/sharepoint/scan', (_req, res) => {
    const result = scanLocalSharePoint(db);
    res.json({ ...result, status: spStatus() });
  });

  // ---------- To-do (local + Microsoft To Do) ----------
  const todoData = (all: boolean) => ({
    tasks: loadTasks(db, all),
    lists: toApiList(db.prepare('SELECT * FROM todo_lists ORDER BY (wellknown = \'defaultList\') DESC, name').all()),
    bridge: bridgeStatus(db),
  });
  r.get('/todo', (req, res) => res.json(todoData(req.query['all'] === 'true')));
  r.post('/todo', (req, res) => {
    const b = req.body as { title?: string; dueDate?: string | null; notes?: string | null; importance?: string; projectId?: string | null; listId?: string | null };
    if (!b.title?.trim()) return res.status(400).json({ error: 'title is required' });
    const id = randomUUID();
    const list = b.listId ? db.prepare('SELECT name FROM todo_lists WHERE id = ?').get(b.listId) as { name: string } | undefined : undefined;
    db.prepare(`INSERT INTO todo_tasks (id, list_id, list_name, title, notes, due_date, importance, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, list ? b.listId! : null, list?.name ?? null, b.title.trim(), b.notes?.trim() || null, b.dueDate || null,
        b.importance === 'high' ? 'high' : 'normal', b.projectId || null);
    queueTodoWrite(db, id);
    res.status(201).json(loadTask(db, id));
  });
  r.patch('/todo/:id', (req, res) => {
    const id = param(req, 'id');
    const cur = db.prepare('SELECT * FROM todo_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!cur) return notFound(res);
    const b = req.body as { title?: string; dueDate?: string | null; notes?: string | null; importance?: string; projectId?: string | null; completed?: boolean };
    const next = {
      title: b.title !== undefined ? b.title.trim() || String(cur['title']) : String(cur['title']),
      due_date: b.dueDate !== undefined ? b.dueDate || null : cur['due_date'],
      notes: b.notes !== undefined ? b.notes?.trim() || null : cur['notes'],
      importance: b.importance !== undefined ? (b.importance === 'high' ? 'high' : 'normal') : cur['importance'],
      status: b.completed !== undefined ? (b.completed ? 'completed' : 'notStarted') : cur['status'],
      project_id: b.projectId !== undefined ? b.projectId || null : cur['project_id'],
    };
    const completedAt = next.status === 'completed' ? (cur['completed_at'] ?? new Date().toISOString().slice(0, 10)) : null;
    db.prepare(`UPDATE todo_tasks SET title = ?, due_date = ?, notes = ?, importance = ?, status = ?, completed_at = ?, project_id = ?,
      updated_at = datetime('now') WHERE id = ?`).run(next.title, next.due_date as string | null, next.notes as string | null,
      next.importance as string, next.status as string, completedAt as string | null, next.project_id as string | null, id);
    // Only what To Do knows is written back (the project link stays in the app).
    const synced = ['title', 'due_date', 'notes', 'importance', 'status'].some((k) => (next as Record<string, unknown>)[k] !== cur[k]);
    if (synced) queueTodoWrite(db, id);
    res.json(loadTask(db, id));
  });
  r.post('/todo/:id/resend', (req, res) => {
    if (!queueTodoWrite(db, param(req, 'id'))) return res.status(409).json({ error: 'Microsoft To Do is not connected' });
    res.json(loadTask(db, param(req, 'id')));
  });
  r.delete('/todo/:id', (req, res) => {
    const t = db.prepare('SELECT todo_id FROM todo_tasks WHERE id = ?').get(param(req, 'id')) as { todo_id: string | null } | undefined;
    if (!t) return notFound(res);
    if (t.todo_id) return res.status(409).json({ error: 'This task is in Microsoft To Do: complete it, or delete it in To Do' });
    db.prepare('DELETE FROM todo_tasks WHERE id = ?').run(param(req, 'id'));
    res.json({ ok: true });
  });
  r.post('/todo/refresh', (_req, res) => {
    todo?.refresh();
    res.json(todoData(false));
  });
  r.get('/settings/todo', (_req, res) => res.json(bridgeStatus(db)));
  r.put('/settings/todo', (req, res) => {
    const b = req.body as { enabled?: boolean; bridgeDir?: string; defaultListId?: string | null };
    saveTodoSettings(db, b);
    prepareBridge(getTodoSettings(db));
    todo?.refresh();
    res.json(bridgeStatus(db));
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

  r.post('/sync/auto', (req, res) => {
    const body = req.body as { mode?: string; lang?: string };
    const mode = (['daily', 'docs', 'jira'].includes(String(body.mode)) ? body.mode : 'daily') as SyncMode;
    try {
      res.json(autoSync(db, mode, body.lang === 'en' ? 'en' : 'it'));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  r.get('/sync/jobs/current', (_req, res) => res.json(currentOrLastJob(db)));
  r.get('/sync/jobs', (_req, res) => res.json(recentJobs(db)));

  r.get('/sync/runs', (_req, res) => {
    res.json(toApiList(db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 20').all()));
  });

  return r;
}

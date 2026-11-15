import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { currentPhase, docRequired, isoToday, jiraRag, phaseFlags, type Flag, type PhaseLike } from './flags.ts';
import { toApi, toApiList } from './util.ts';

export const ACTIVE_MAIL = `(m.user_state = 'open' OR (m.user_state = 'snoozed' AND COALESCE(m.snoozed_until, '') <= :today))`;

export type DeadlineRow = PhaseLike & {
  id: string; effProjectId: string | null; epicKey: string | null; title: string; assignedToMe: boolean; flags: Flag[];
  [k: string]: unknown;
};

/** Deadlines (Jira phases + manual) with controllo-pm flags computed for today. */
export function loadDeadlines(db: DatabaseSync, where = '1 = 1', params: Record<string, SQLInputValue> = {}): DeadlineRow[] {
  const today = isoToday();
  const rows = toApiList<DeadlineRow>(db.prepare(`
    SELECT d.*, p.name AS project_name FROM v_deadlines d LEFT JOIN projects p ON p.id = d.eff_project_id
    WHERE ${where} ORDER BY d.due_date IS NULL, d.due_date, d.id`).all(params));
  return rows.map((d) => ({ ...d, flags: d.source === 'manual' ? phaseFlags(d, today).filter((f) => !f.startsWith('missing')) : phaseFlags(d, today) }));
}

export interface ProjectSummary {
  [key: string]: unknown;
  docs: (DocRow & { required: boolean })[];
  missingDocs: number;
  uncheckedDocs: number;
  currentPhase: { name: string; startsOn: string | null } | null;
  jiraRag: string;
  jiraRagReason: string;
  openPhases: number;
  overdue: number;
  atRisk: number;
  dataGaps: number;
  nextDeadline: string | null;
}

export function loadProjects(db: DatabaseSync, opts: { all?: boolean; id?: string } = {}): ProjectSummary[] {
  const today = isoToday();
  const where = opts.id ? 'WHERE p.id = :id' : opts.all ? '' : 'WHERE p.active = 1';
  const params: Record<string, SQLInputValue> = opts.id ? { today, id: opts.id } : { today };
  const rows = db.prepare(`
    SELECT p.*, g.name AS group_name, g.color AS group_color,
      (SELECT json_group_array(e.key) FROM jira_epics e WHERE e.project_id = p.id) AS jira_keys,
      (SELECT COUNT(*) FROM mail_threads m WHERE m.project_id = p.id AND m.category = 'needs_reply' AND ${ACTIVE_MAIL}) AS needs_reply
    FROM projects p LEFT JOIN project_groups g ON g.id = p.group_id ${where}
    ORDER BY CASE p.role WHEN 'pm' THEN 0 ELSE 1 END, p.name`).all(params);

  const byProject = new Map<string, DeadlineRow[]>();
  for (const d of loadDeadlines(db, `d.state = 'open'`)) {
    if (!d.effProjectId) continue;
    byProject.set(d.effProjectId, [...(byProject.get(d.effProjectId) ?? []), d]);
  }

  const docsByProject = new Map<string, DocRow[]>();
  for (const d of toApiList<DocRow>(db.prepare('SELECT * FROM doc_requirements ORDER BY id').all())) {
    docsByProject.set(d.projectId, [...(docsByProject.get(d.projectId) ?? []), d]);
  }

  return rows.map((row) => {
    const p = toApi(row);
    const phases = byProject.get(String(p['id'])) ?? [];
    const rag = jiraRag(phases);
    const upcoming = phases.map((d) => d.dueDate).filter((d): d is string => !!d && d >= today).sort();
    const cp = currentPhase(phases, today);
    const docs = (docsByProject.get(String(p['id'])) ?? []).map((d) => ({ ...d, required: docRequired(d, cp, p['phase'] as string | null) }));
    const due = docs.filter((d) => d.required && !d.waived);
    return {
      ...p,
      docs,
      missingDocs: due.filter((d) => d.checkStatus === 'missing' || d.checkStatus === 'outdated').length,
      uncheckedDocs: due.filter((d) => d.checkStatus === 'unknown').length,
      currentPhase: cp,
      jiraRag: rag.rag,
      jiraRagReason: rag.reason,
      openPhases: phases.length,
      overdue: phases.filter((d) => d.flags.includes('overdue')).length,
      atRisk: phases.filter((d) => d.flags.includes('at_risk')).length,
      dataGaps: phases.filter((d) => d.flags.some((f) => f.startsWith('missing'))).length,
      nextDeadline: upcoming[0] ?? null,
    };
  });
}

export type DocRow = {
  id: string; projectId: string; phase: string | null; requiredFrom: string | null; title: string;
  repository: string; locationHint: string | null; checkStatus: string; foundUrl: string | null;
  checkedAt: string | null; waived: boolean; fromTemplate: boolean;
};

export const getProjectRow = (db: DatabaseSync, id: string) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return row ? toApi(row) : null;
};

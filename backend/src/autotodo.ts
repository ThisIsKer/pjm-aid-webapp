import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { addDays, canonicalPhase, isoToday } from './flags.ts';
import { loadDeadlines } from './projects.ts';

/**
 * Automatic to-dos from the Jira planning: when a phase of one of my projects (PM role) gets close, the app adds
 * the PM tasks that go with it, e.g. "Create Mevis - FEI Slovacchia testbook" two weeks before the start of
 * Implementazione / Test interni. Each rule fires once per project (deleting the task does not bring it back);
 * while the task is open and its due date untouched, it follows the phase when Jira moves it.
 * Rules can be replaced with "autoTodos" in data/seed.json.
 */
export interface AutoTodoRule {
  id: string;
  /** Canonical phase names (Analisi, Implementazione, Test interni, UAT, Live, Post GoLive); several = the earliest start / latest end. */
  phases: string[];
  /** {project} is replaced by the project name. */
  title: string;
  /** Date the rule counts from: the phase start or its end (due date). */
  anchor: 'start' | 'end';
  /** The to-do appears this many days before the anchor; its due date is the anchor date. */
  daysBefore: number;
}

const BUILD = ['Implementazione', 'Test interni'];
export const DEFAULT_AUTO_TODOS: AutoTodoRule[] = [
  { id: 'analysis-docs', phases: ['Analisi'], title: 'Create {project} analysis documents', anchor: 'start', daysBefore: 14 },
  { id: 'analysis-meetings', phases: ['Analisi'], title: 'Schedule {project} analysis meetings', anchor: 'start', daysBefore: 14 },
  { id: 'build-use-cases', phases: BUILD, title: 'Retrieve {project} use cases', anchor: 'start', daysBefore: 14 },
  { id: 'build-check-team', phases: BUILD, title: 'Check with implementation team for {project} advancement', anchor: 'start', daysBefore: 14 },
  { id: 'build-testbook', phases: BUILD, title: 'Create {project} testbook', anchor: 'start', daysBefore: 14 },
  { id: 'uat-test-cases', phases: ['UAT'], title: 'Retrieve {project} test cases', anchor: 'start', daysBefore: 14 },
  { id: 'uat-share-testbook', phases: ['UAT'], title: 'Share {project} testbook', anchor: 'start', daysBefore: 14 },
  { id: 'uat-issue-list', phases: ['UAT'], title: 'Create {project} issue list', anchor: 'start', daysBefore: 14 },
  { id: 'uat-first-meeting', phases: ['UAT'], title: 'Schedule first UAT meeting for {project}', anchor: 'start', daysBefore: 14 },
  { id: 'golive-date', phases: ['Live'], title: 'Schedule go-live date for {project}', anchor: 'start', daysBefore: 14 },
  { id: 'golive-issue-list', phases: ['Live'], title: 'Check issue list for {project}', anchor: 'start', daysBefore: 14 },
  { id: 'postgolive-issue-list', phases: ['Post GoLive'], title: 'Create post go-live issue list for {project}', anchor: 'start', daysBefore: 14 },
  { id: 'postgolive-hypercare-end', phases: ['Post GoLive'], title: 'Share end of hypercare communication for {project}', anchor: 'end', daysBefore: 14 },
];

/** A phase that started (or ended) longer ago than this is not used: no flood of late to-dos for old phases. */
const MAX_LATE_DAYS = 7;

export function autoTodosEnabled(db: DatabaseSync): boolean {
  const r = db.prepare(`SELECT value FROM app_settings WHERE key = 'autotodo.enabled'`).get() as { value: string } | undefined;
  return (r?.value ?? '1') === '1';
}

export function setAutoTodosEnabled(db: DatabaseSync, on: boolean) {
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('autotodo.enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(on ? '1' : '0');
}

export function loadAutoTodoRules(seedFile: string): AutoTodoRule[] {
  try {
    const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')) as { autoTodos?: AutoTodoRule[] };
    if (Array.isArray(seed.autoTodos) && seed.autoTodos.length) return seed.autoTodos;
  } catch {
    /* no seed or invalid: defaults */
  }
  return DEFAULT_AUTO_TODOS;
}

/** Creates the to-dos whose time has come. Returns how many were created / moved. */
export function generateAutoTodos(db: DatabaseSync, rules: AutoTodoRule[], today = isoToday()) {
  const result = { created: 0, moved: 0 };
  if (!autoTodosEnabled(db)) return result;

  // Open Jira phases of the projects I manage, grouped by project.
  const phases = loadDeadlines(db, `d.state = 'open' AND d.source = 'jira' AND p.active = 1 AND p.role = 'pm'`);
  const byProject = new Map<string, { name: string; phases: { phase: string; start: string | null; end: string | null; key: string }[] }>();
  for (const d of phases) {
    if (!d.effProjectId) continue;
    const entry = byProject.get(d.effProjectId) ?? { name: String(d['projectName'] ?? d.effProjectId), phases: [] };
    entry.phases.push({ phase: canonicalPhase(String(d.phaseName ?? d.title)), start: d.startDate ?? null, end: d.dueDate ?? null, key: d.id });
    byProject.set(d.effProjectId, entry);
  }

  const logged = db.prepare('SELECT task_id, anchor FROM auto_todo_log WHERE key = ?');
  const log = db.prepare('INSERT INTO auto_todo_log (key, task_id, anchor) VALUES (?, ?, ?)');
  const relog = db.prepare('UPDATE auto_todo_log SET anchor = ? WHERE key = ?');
  const insert = db.prepare(`INSERT INTO todo_tasks (id, title, notes, due_date, project_id, origin) VALUES (?, ?, ?, ?, ?, 'auto')`);
  const task = db.prepare('SELECT status, due_date FROM todo_tasks WHERE id = ?');
  const move = db.prepare(`UPDATE todo_tasks SET due_date = ?, updated_at = datetime('now') WHERE id = ?`);

  db.exec('BEGIN');
  try {
    for (const [projectId, p] of byProject) {
      for (const rule of rules) {
        const matching = p.phases.filter((x) => rule.phases.includes(x.phase));
        const dates = matching.map((x) => (rule.anchor === 'start' ? x.start : x.end)).filter((d): d is string => !!d).sort();
        if (!dates.length) continue;
        const anchor = rule.anchor === 'start' ? dates[0]! : dates.at(-1)!;
        const key = `${projectId}::${rule.id}`;
        const done = logged.get(key) as { task_id: string | null; anchor: string | null } | undefined;
        if (done) {
          // Follow the plan while the task is open and its due date is still the one we set.
          const t = done.task_id ? task.get(done.task_id) as { status: string; due_date: string | null } | undefined : undefined;
          if (t && t.status !== 'completed' && t.due_date === done.anchor && done.anchor !== anchor) {
            move.run(anchor, done.task_id!);
            relog.run(anchor, key);
            result.moved++;
          }
          continue;
        }
        if (today < addDays(anchor, -rule.daysBefore) || anchor < addDays(today, -MAX_LATE_DAYS)) continue;
        const id = randomUUID();
        const hits = matching.filter((x) => (rule.anchor === 'start' ? x.start : x.end) === anchor);
        const note = `Auto: ${hits[0]!.phase} ${rule.anchor === 'start' ? 'starts' : 'ends'} ${anchor} (${hits.map((x) => x.key).join(', ')})`;
        insert.run(id, rule.title.replace(/\{project\}/g, p.name), note, anchor, projectId);
        log.run(key, id, anchor);
        result.created++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return result;
}

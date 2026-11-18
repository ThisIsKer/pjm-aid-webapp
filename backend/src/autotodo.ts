import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { addDays, canonicalPhase, isoToday } from './flags.ts';
import { loadDeadlines } from './projects.ts';

/**
 * Automatic to-dos from the Jira planning: when a phase of one of my projects (PM role) gets close, the app adds
 * the PM tasks that go with it, e.g. "Create Mevis - FEI Slovacchia testbook" two weeks before the start of
 * Implementazione / Test interni. Each rule fires once per project (deleting the task does not bring it back,
 * except with "Create automatic to-dos" on the project page); while the task is open and its due date untouched,
 * it follows the phase when Jira moves it. Titles are localised at display time (rule id + project name are
 * stored); rules can be replaced with "autoTodos" in data/seed.json.
 */
export interface AutoTodoRule {
  id: string;
  /** Canonical phase names (Analisi, Implementazione, Test interni, UAT, Live, Post GoLive); several = the earliest start / latest end. */
  phases: string[];
  /** English title; {project} is replaced by the project name. */
  title: string;
  /** Localised titles (it, en); missing languages fall back to `title`. */
  titles?: Record<string, string>;
  /** Date the rule counts from: the phase start or its end (due date). */
  anchor: 'start' | 'end';
  /** The to-do appears this many days before the anchor; its due date is the anchor date. */
  daysBefore: number;
}

const BUILD = ['Implementazione', 'Test interni'];
const rule = (id: string, phases: string[], en: string, it: string, anchor: 'start' | 'end' = 'start'): AutoTodoRule =>
  ({ id, phases, title: en, titles: { en, it }, anchor, daysBefore: 14 });

export const DEFAULT_AUTO_TODOS: AutoTodoRule[] = [
  rule('analysis-docs', ['Analisi'], 'Create {project} analysis documents', 'Creare i documenti di analisi di {project}'),
  rule('analysis-meetings', ['Analisi'], 'Schedule {project} analysis meetings', 'Pianificare le riunioni di analisi di {project}'),
  rule('build-use-cases', BUILD, 'Retrieve {project} use cases', 'Recuperare gli use case di {project}'),
  rule('build-check-team', BUILD, 'Check with implementation team for {project} advancement', 'Verificare con il team di implementazione l\'avanzamento di {project}'),
  rule('build-testbook', BUILD, 'Create {project} testbook', 'Creare il testbook di {project}'),
  rule('uat-test-cases', ['UAT'], 'Retrieve {project} test cases', 'Recuperare i casi di test di {project}'),
  rule('uat-share-testbook', ['UAT'], 'Share {project} testbook', 'Condividere il testbook di {project}'),
  rule('uat-issue-list', ['UAT'], 'Create {project} issue list', 'Creare la issue list di {project}'),
  rule('uat-first-meeting', ['UAT'], 'Schedule first UAT meeting for {project}', 'Pianificare il primo incontro UAT per {project}'),
  rule('golive-date', ['Live'], 'Schedule go-live date for {project}', 'Pianificare la data di go-live per {project}'),
  rule('golive-issue-list', ['Live'], 'Check issue list for {project}', 'Verificare la issue list di {project}'),
  rule('postgolive-issue-list', ['Post GoLive'], 'Create post go-live issue list for {project}', 'Creare la issue list post go-live di {project}'),
  rule('postgolive-hypercare-end', ['Post GoLive'], 'Share end of hypercare communication for {project}',
    'Condividere la comunicazione di fine hypercare per {project}', 'end'),
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
    if (Array.isArray(seed.autoTodos) && seed.autoTodos.length) {
      // A seed rule with a default id keeps the default translations unless it brings its own.
      return seed.autoTodos.map((r) => ({ ...r, titles: r.titles ?? DEFAULT_AUTO_TODOS.find((d) => d.id === r.id && d.title === r.title)?.titles }));
    }
  } catch {
    /* no seed or invalid: defaults */
  }
  return DEFAULT_AUTO_TODOS;
}

/** Info stored with an automatic to-do, shown (localised) under its title. */
interface AutoInfo { phase: string; anchor: 'start' | 'end'; date: string; keys: string[] }

/** Adds the localised titles of automatic to-dos ({ it, en }) to tasks coming from the API. */
export function withAutoTitles<T extends Record<string, unknown>>(tasks: T[], rules: AutoTodoRule[]): T[] {
  return tasks.map((t) => {
    const r = t['autoRule'] ? rules.find((x) => x.id === t['autoRule']) : undefined;
    const project = String(t['autoProject'] ?? t['projectName'] ?? '');
    let info: AutoInfo | null = null;
    try {
      info = t['autoInfo'] ? JSON.parse(String(t['autoInfo'])) : null;
    } catch {
      info = null;
    }
    const titles = r ? Object.fromEntries(Object.entries({ en: r.title, ...(r.titles ?? {}) })
      .map(([lang, text]) => [lang, text.replace(/\{project\}/g, project)])) : null;
    return { ...t, autoInfo: info, autoTitles: titles };
  });
}

/** To-dos created before titles were localised: recover rule id and info from the log and the old note. */
function migrateLegacy(db: DatabaseSync) {
  const rows = db.prepare(`SELECT t.id, t.notes, l.key FROM todo_tasks t JOIN auto_todo_log l ON l.task_id = t.id
    WHERE t.origin = 'auto' AND t.auto_rule IS NULL AND t.notes LIKE 'Auto: %'`).all() as { id: string; notes: string; key: string }[];
  const upd = db.prepare('UPDATE todo_tasks SET auto_rule = ?, auto_info = ?, auto_project = (SELECT name FROM projects WHERE id = todo_tasks.project_id), notes = NULL WHERE id = ?');
  for (const r of rows) {
    const m = /^Auto: (.+) (starts|ends) (\d{4}-\d{2}-\d{2}) \((.*)\)$/.exec(r.notes);
    const info = m ? { phase: m[1], anchor: m[2] === 'starts' ? 'start' : 'end', date: m[3], keys: m[4]!.split(', ') } : null;
    upd.run(r.key.split('::')[1] ?? null, info ? JSON.stringify(info) : null, r.id);
  }
}

export interface GenerateOptions {
  /** Only this project. */
  projectId?: string;
  /**
   * Requested from the project page: creates every rule whose phase is coming (no 14-day wait), also for
   * projects where I am not the PM, and re-creates to-dos that were deleted. Existing ones are never duplicated.
   */
  manual?: boolean;
  today?: string;
}

/** Creates the to-dos whose time has come. Returns how many were created / moved. */
export function generateAutoTodos(db: DatabaseSync, rules: AutoTodoRule[], opts: GenerateOptions = {}) {
  const result = { created: 0, moved: 0 };
  const today = opts.today ?? isoToday();
  migrateLegacy(db);
  if (!opts.manual && !autoTodosEnabled(db)) return result;

  // Open Jira phases, grouped by project.
  const where = [`d.state = 'open'`, `d.source = 'jira'`, `p.active = 1`];
  if (!opts.manual) where.push(`p.role = 'pm'`);
  if (opts.projectId) where.push('d.eff_project_id = :pid');
  const phases = loadDeadlines(db, where.join(' AND '), opts.projectId ? { pid: opts.projectId } : {});
  const byProject = new Map<string, { name: string; phases: { phase: string; start: string | null; end: string | null; key: string }[] }>();
  for (const d of phases) {
    if (!d.effProjectId) continue;
    const entry = byProject.get(d.effProjectId) ?? { name: String(d['projectName'] ?? d.effProjectId), phases: [] };
    entry.phases.push({ phase: canonicalPhase(String(d.phaseName ?? d.title)), start: d.startDate ?? null, end: d.dueDate ?? null, key: d.id });
    byProject.set(d.effProjectId, entry);
  }

  const logged = db.prepare('SELECT task_id, anchor FROM auto_todo_log WHERE key = ?');
  const log = db.prepare(`INSERT INTO auto_todo_log (key, task_id, anchor) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET task_id = excluded.task_id, anchor = excluded.anchor`);
  const relog = db.prepare('UPDATE auto_todo_log SET anchor = ? WHERE key = ?');
  const insert = db.prepare(`INSERT INTO todo_tasks (id, title, due_date, project_id, origin, auto_rule, auto_info, auto_project)
    VALUES (?, ?, ?, ?, 'auto', ?, ?, ?)`);
  const task = db.prepare('SELECT status, due_date FROM todo_tasks WHERE id = ?');
  const move = db.prepare(`UPDATE todo_tasks SET due_date = ?, auto_info = json_set(COALESCE(auto_info, '{}'), '$.date', ?),
    updated_at = datetime('now') WHERE id = ?`);

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
        const existing = done?.task_id ? task.get(done.task_id) as { status: string; due_date: string | null } | undefined : undefined;
        if (done && (existing || !opts.manual)) {
          // Follow the plan while the task is open and its due date is still the one we set.
          if (existing && existing.status !== 'completed' && existing.due_date === done.anchor && done.anchor !== anchor) {
            move.run(anchor, anchor, done.task_id!);
            relog.run(anchor, key);
            result.moved++;
          }
          continue;
        }
        if (anchor < addDays(today, -MAX_LATE_DAYS)) continue;
        if (!opts.manual && today < addDays(anchor, -rule.daysBefore)) continue;
        const hits = matching.filter((x) => (rule.anchor === 'start' ? x.start : x.end) === anchor);
        const info: AutoInfo = { phase: hits[0]!.phase, anchor: rule.anchor, date: anchor, keys: hits.map((x) => x.key) };
        const id = randomUUID();
        insert.run(id, rule.title.replace(/\{project\}/g, p.name), anchor, projectId, rule.id, JSON.stringify(info), p.name);
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

/** Deletes a project's automatic to-dos. They are not re-created by themselves (only from the project page). */
export function deleteAutoTodos(db: DatabaseSync, projectId: string): number {
  return Number(db.prepare(`DELETE FROM todo_tasks WHERE project_id = ? AND origin = 'auto'`).run(projectId).changes);
}

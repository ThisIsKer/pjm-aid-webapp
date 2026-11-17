import type { DatabaseSync } from 'node:sqlite';
import { toApi, toApiList } from './util.ts';

/**
 * To-do list kept in the app (table todo_tasks). Tasks can be linked to a project.
 * Completed tasks are listed for 14 days unless all=true.
 */
export const loadTasks = (db: DatabaseSync, all: boolean) => toApiList(db.prepare(`
  SELECT t.id, t.title, t.notes, t.due_date, t.importance, t.status, t.completed_at, t.project_id, t.created_at, t.updated_at,
    p.name AS project_name
  FROM todo_tasks t LEFT JOIN projects p ON p.id = t.project_id
  ${all ? '' : `WHERE t.status <> 'completed' OR t.completed_at >= date('now', '-14 days')`}
  ORDER BY t.status = 'completed', t.due_date IS NULL, t.due_date, t.importance = 'high' DESC, t.created_at`).all());

export const loadTask = (db: DatabaseSync, id: string) => {
  const r = db.prepare(`SELECT t.id, t.title, t.notes, t.due_date, t.importance, t.status, t.completed_at, t.project_id, t.created_at,
    t.updated_at, p.name AS project_name FROM todo_tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?`).get(id);
  return r ? toApi(r) : null;
};

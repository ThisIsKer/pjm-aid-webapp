import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { toApi, toApiList } from './util.ts';

/**
 * To-do list, synced with Microsoft To Do through two Power Automate flows and a OneDrive folder
 * (Claude's Microsoft 365 connector has no task permission; the new Outlook has no local API):
 *
 *   OneDrive/PJM aid/todo-export.json   ← flow "PJM aid – export To Do" writes all lists and to-dos (every 10 min)
 *   OneDrive/PJM aid/outbox/<id>.txt    → flow "PJM aid – write To Do" creates/updates the to-do, then deletes the file
 *
 * OneDrive syncs the folder with this PC, so the backend only reads and writes local files.
 * Tasks also work without the flows: they simply stay in the app ("local").
 * Setup: docs/todo-power-automate.md.
 */

const DEFAULT_DIR = path.join(os.homedir(), 'OneDrive - Archiva Group', 'PJM aid');
const EXPORT_FILE = 'todo-export.json';

export interface TodoSettings { enabled: boolean; bridgeDir: string; defaultListId: string | null }

export function getTodoSettings(db: DatabaseSync): TodoSettings {
  const rows = db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'todo.%'`).all() as { key: string; value: string }[];
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    enabled: (v['todo.enabled'] ?? '1') === '1',
    bridgeDir: process.env['PJM_TODO_DIR'] ?? v['todo.bridgeDir'] ?? DEFAULT_DIR,
    defaultListId: v['todo.defaultListId'] ?? null,
  };
}

export function saveTodoSettings(db: DatabaseSync, s: Partial<TodoSettings>) {
  const put = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (s.enabled !== undefined) put.run('todo.enabled', s.enabled ? '1' : '0');
  if (s.bridgeDir !== undefined) put.run('todo.bridgeDir', s.bridgeDir.trim().replace(/[\\/]+$/, ''));
  if (s.defaultListId !== undefined) put.run('todo.defaultListId', s.defaultListId ?? '');
}

const exportPath = (s: TodoSettings) => path.join(s.bridgeDir, EXPORT_FILE);
const outboxDir = (s: TodoSettings) => path.join(s.bridgeDir, 'outbox');

/** Creates the OneDrive folder, the outbox and an empty export (the export flow updates an existing file). */
export function prepareBridge(s: TodoSettings): boolean {
  try {
    fs.mkdirSync(outboxDir(s), { recursive: true });
    if (!fs.existsSync(exportPath(s))) fs.writeFileSync(exportPath(s), '[]');
    return true;
  } catch {
    return false;
  }
}

/** The bridge is live once the export flow has written at least one list. */
export function bridgeStatus(db: DatabaseSync) {
  const s = getTodoSettings(db);
  let exportedAt: string | null = null;
  let folder = false;
  try {
    folder = fs.statSync(s.bridgeDir).isDirectory();
    exportedAt = fs.statSync(exportPath(s)).mtime.toISOString();
  } catch {
    /* not there yet */
  }
  const lists = (db.prepare('SELECT COUNT(*) AS n FROM todo_lists').get() as { n: number }).n;
  let outbox = 0;
  try {
    outbox = fs.readdirSync(outboxDir(s)).filter((f) => f.endsWith('.txt')).length;
  } catch {
    /* none */
  }
  const pending = (db.prepare(`SELECT COUNT(*) AS n FROM todo_tasks WHERE sync_state = 'pending'`).get() as { n: number }).n;
  return { ...s, folder, exportedAt, lists, connected: s.enabled && lists > 0, outbox, pending };
}

// ---------- import (To Do → app) ----------

const dateOnly = (v: unknown): string | null => {
  const d = (v as { dateTime?: string } | null)?.dateTime ?? (typeof v === 'string' ? v : null);
  return d ? d.slice(0, 10) : null;
};
const textOf = (v: unknown): string | null => {
  const c = (v as { content?: string } | null)?.content ?? (typeof v === 'string' ? v : null);
  if (!c) return null;
  const t = c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return t || null;
};
const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : Array.isArray((v as any)?.value) ? (v as any).value : []);

let lastImportedMtime = 0;

/** Reads OneDrive/PJM aid/todo-export.json when it changed. Returns true when something was imported. */
export function importTodoExport(db: DatabaseSync, force = false): boolean {
  const s = getTodoSettings(db);
  if (!s.enabled) return false;
  let raw: string;
  let mtime: number;
  try {
    mtime = fs.statSync(exportPath(s)).mtimeMs;
    if (!force && mtime === lastImportedMtime) return false;
    raw = fs.readFileSync(exportPath(s), 'utf8').replace(/^﻿/, '');
  } catch {
    return false;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return false; // being written by OneDrive: next change will retry
  }
  const lists = asArray(Array.isArray(data) ? data : (data as any)?.lists);
  lastImportedMtime = mtime;
  if (!lists.length) return false;

  db.exec('BEGIN');
  try {
    const seenLists: string[] = [];
    const seenTodos: string[] = [];
    const upList = db.prepare(`INSERT INTO todo_lists (id, name, wellknown) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, wellknown = excluded.wellknown`);
    const byTodoId = db.prepare('SELECT id, sync_state, updated_at FROM todo_tasks WHERE todo_id = ?');
    const pendingCreate = db.prepare(`SELECT id FROM todo_tasks WHERE todo_id IS NULL AND sync_state = 'pending'
      AND list_id = ? AND lower(title) = lower(?) ORDER BY created_at LIMIT 1`);
    const link = db.prepare('UPDATE todo_tasks SET todo_id = ? WHERE id = ?');
    const fromTodo = db.prepare(`UPDATE todo_tasks SET list_id = ?, list_name = ?, title = ?, notes = ?, due_date = ?, importance = ?,
      status = ?, completed_at = ?, todo_modified_at = ?, sync_state = 'synced', updated_at = datetime('now') WHERE id = ?`);
    const insert = db.prepare(`INSERT INTO todo_tasks (id, todo_id, list_id, list_name, title, notes, due_date, importance, status,
      completed_at, todo_modified_at, origin, sync_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', 'synced', ?)`);

    for (const l of lists) {
      const listId = String(l.listId ?? l.id ?? '');
      if (!listId) continue;
      const listName = String(l.listName ?? l.displayName ?? '');
      upList.run(listId, listName, l.wellknown ?? l.wellknownListName ?? null);
      seenLists.push(listId);
      for (const t of asArray(l.todos ?? l.tasks)) {
        const todoId = String(t.id ?? '');
        if (!todoId) continue;
        seenTodos.push(todoId);
        const status = String(t.status ?? 'notStarted');
        const fields = [listId, listName, String(t.title ?? ''), textOf(t.body ?? t.content), dateOnly(t.dueDateTime ?? t.dueDate),
          String(t.importance ?? 'normal'), status, status === 'completed' ? (dateOnly(t.completedDateTime) ?? new Date().toISOString().slice(0, 10)) : null,
          t.lastModifiedDateTime ?? null] as const;
        let row = byTodoId.get(todoId) as { id: string; sync_state: string } | undefined;
        if (!row) {
          const p = pendingCreate.get(listId, String(t.title ?? '')) as { id: string } | undefined;
          if (p) { link.run(todoId, p.id); row = { id: p.id, sync_state: 'pending' }; }
        }
        if (!row) {
          insert.run(randomUUID(), todoId, ...fields, t.createdDateTime ?? new Date().toISOString());
          continue;
        }
        // A change made in the app and not yet written to To Do wins, until To Do shows it.
        const local = db.prepare('SELECT title, status, due_date FROM todo_tasks WHERE id = ?').get(row.id) as
          { title: string; status: string; due_date: string | null };
        const arrived = local.title === fields[2] && local.status === status && (local.due_date ?? null) === fields[4];
        if (row.sync_state === 'pending' && !arrived) continue;
        fromTodo.run(...fields, row.id);
      }
    }
    // To-dos deleted in To Do (in a list that was exported) disappear here too.
    if (seenLists.length) {
      const inLists = seenLists.map(() => '?').join(',');
      const known = seenTodos.length ? `AND todo_id NOT IN (${seenTodos.map(() => '?').join(',')})` : '';
      db.prepare(`DELETE FROM todo_tasks WHERE todo_id IS NOT NULL AND list_id IN (${inLists}) ${known}`).run(...seenLists, ...seenTodos);
      db.prepare(`DELETE FROM todo_lists WHERE id NOT IN (${inLists})`).run(...seenLists);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
}

// ---------- write (app → To Do) ----------

type Task = {
  id: string; todo_id: string | null; list_id: string | null; title: string; notes: string | null; due_date: string | null;
  importance: string; status: string;
};

/** Drops a request for the "write To Do" flow; returns false when the bridge is not set up. */
export function queueTodoWrite(db: DatabaseSync, taskId: string): boolean {
  const s = getTodoSettings(db);
  const status = bridgeStatus(db);
  if (!status.connected) return false;
  const t = db.prepare('SELECT * FROM todo_tasks WHERE id = ?').get(taskId) as Task | undefined;
  if (!t) return false;
  const listId = t.list_id ?? s.defaultListId ?? defaultList(db);
  if (!listId) return false;
  const request = {
    requestId: randomUUID(), action: t.todo_id ? 'update' : 'create', listId, todoId: t.todo_id ?? '',
    title: t.title, notes: t.notes ?? '', dueDate: t.due_date ? `${t.due_date}T09:00:00` : '',
    importance: t.importance || 'normal', status: t.status || 'notStarted',
  };
  try {
    fs.mkdirSync(outboxDir(s), { recursive: true });
    fs.writeFileSync(path.join(outboxDir(s), `${new Date().toISOString().replace(/[:.]/g, '-')}-${request.requestId.slice(0, 8)}.txt`),
      JSON.stringify(request));
  } catch {
    return false;
  }
  const list = db.prepare('SELECT name FROM todo_lists WHERE id = ?').get(listId) as { name: string } | undefined;
  db.prepare(`UPDATE todo_tasks SET list_id = ?, list_name = COALESCE(?, list_name), sync_state = 'pending', sent_at = ? WHERE id = ?`)
    .run(listId, list?.name ?? null, new Date().toISOString(), taskId);
  return true;
}

/** The "Tasks" list of To Do (wellknown defaultList), else the first one. */
function defaultList(db: DatabaseSync): string | null {
  const r = db.prepare(`SELECT id FROM todo_lists ORDER BY (wellknown = 'defaultList') DESC, name LIMIT 1`).get() as { id: string } | undefined;
  return r?.id ?? null;
}

export const loadTasks = (db: DatabaseSync, all: boolean) => toApiList(db.prepare(`
  SELECT t.*, p.name AS project_name FROM todo_tasks t LEFT JOIN projects p ON p.id = t.project_id
  ${all ? '' : `WHERE t.status <> 'completed' OR t.completed_at >= date('now', '-14 days')`}
  ORDER BY t.status = 'completed', t.due_date IS NULL, t.due_date, t.importance = 'high' DESC, t.created_at`).all());

export const loadTask = (db: DatabaseSync, id: string) => {
  const r = db.prepare('SELECT t.*, p.name AS project_name FROM todo_tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?').get(id);
  return r ? toApi(r) : null;
};

/** Watches the OneDrive folder for a new export (plus a periodic check, OneDrive events can be missed). */
export function watchTodo(db: DatabaseSync, onImported: () => void) {
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | null = null;
  let watched = '';
  const run = (force = false) => {
    try {
      if (importTodoExport(db, force)) {
        console.log('[todo] imported Microsoft To Do export');
        // Tasks added in the app before To Do was connected are sent now.
        for (const { id } of db.prepare(`SELECT id FROM todo_tasks WHERE sync_state = 'local' AND status <> 'completed'`).all() as { id: string }[]) {
          queueTodoWrite(db, id);
        }
        onImported();
      }
    } catch (err) {
      console.error('[todo] import failed:', (err as Error).message);
    }
  };
  const rewatch = () => {
    const s = getTodoSettings(db);
    if (watched === s.bridgeDir && watcher) return;
    watcher?.close();
    watcher = null;
    watched = s.bridgeDir;
    if (!s.enabled) return;
    prepareBridge(s);
    try {
      watcher = fs.watch(s.bridgeDir, (_e, f) => {
        if (f && f !== EXPORT_FILE) return;
        clearTimeout(timer);
        timer = setTimeout(() => run(), 3000);
      });
      watcher.on('error', () => { watcher?.close(); watcher = null; });
    } catch {
      watcher = null;
    }
  };
  rewatch();
  run(true);
  setInterval(() => { rewatch(); run(); }, 2 * 60_000).unref();
  return { refresh: () => { rewatch(); run(true); } };
}

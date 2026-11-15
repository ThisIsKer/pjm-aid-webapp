import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Ordered schema migrations. Never edit a migration that has shipped:
 * append a new one instead. PRAGMA user_version tracks how many ran.
 */
const MIGRATIONS: string[] = [
  /* v1 — initial schema */ `
  CREATE TABLE projects (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    client           TEXT,
    description      TEXT,
    phase            TEXT,
    status           TEXT NOT NULL DEFAULT 'grey' CHECK (status IN ('green','amber','red','grey')),
    suggested_status TEXT CHECK (suggested_status IN ('green','amber','red','grey')),
    suggested_reason TEXT,
    pm_note          TEXT,
    jira_keys        TEXT NOT NULL DEFAULT '[]',
    sharepoint_url   TEXT,
    confluence_space TEXT,
    mail_keywords    TEXT NOT NULL DEFAULT '[]',
    mail_domains     TEXT NOT NULL DEFAULT '[]',
    active           INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE deadlines (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    start_date      TEXT,
    due_date        TEXT,
    source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('jira','manual','claude')),
    source_ref      TEXT,
    assignee        TEXT,
    remaining_hours REAL,
    state           TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','done')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX ix_deadlines_due ON deadlines(due_date);

  CREATE TABLE mail_threads (
    id              TEXT PRIMARY KEY,
    project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
    subject         TEXT NOT NULL,
    counterpart     TEXT,
    last_message_at TEXT,
    last_from_me    INTEGER NOT NULL DEFAULT 0,
    category        TEXT NOT NULL CHECK (category IN ('needs_reply','waiting','fyi')),
    urgency         TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('high','normal','low')),
    summary         TEXT,
    web_link        TEXT,
    user_state      TEXT NOT NULL DEFAULT 'open' CHECK (user_state IN ('open','done','snoozed')),
    snoozed_until   TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE doc_requirements (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    phase         TEXT,
    title         TEXT NOT NULL,
    repository    TEXT NOT NULL CHECK (repository IN ('sharepoint','confluence')),
    location_hint TEXT,
    check_status  TEXT NOT NULL DEFAULT 'unknown' CHECK (check_status IN ('missing','present','outdated','unknown')),
    found_url     TEXT,
    checked_at    TEXT,
    waived        INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE sync_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    generated_at TEXT,
    imported_at  TEXT NOT NULL DEFAULT (datetime('now')),
    file_hash    TEXT,
    counts       TEXT,
    warnings     TEXT
  );
  `,
];

export function openDb(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  MIGRATIONS.slice(current).forEach((sql, i) => {
    transaction(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${current + i + 1}`);
    });
  });
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

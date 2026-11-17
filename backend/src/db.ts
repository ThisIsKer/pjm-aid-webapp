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
  /* v2 — Jira epics become projects; deadlines carry Jira phase data */ `
  ALTER TABLE projects ADD COLUMN role TEXT NOT NULL DEFAULT 'pm';
  ALTER TABLE projects ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';

  CREATE TABLE doc_template (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    phase         TEXT,
    title         TEXT NOT NULL,
    repository    TEXT NOT NULL CHECK (repository IN ('sharepoint','confluence')),
    location_hint TEXT
  );

  CREATE TABLE jira_epics (
    key             TEXT PRIMARY KEY,
    project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
    summary         TEXT,
    status          TEXT,
    status_category TEXT,
    start_date      TEXT,
    due_date        TEXT,
    assignee        TEXT,
    mine            INTEGER NOT NULL DEFAULT 0,
    url             TEXT,
    active          INTEGER NOT NULL DEFAULT 1,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO jira_epics (key, project_id)
    SELECT j.value, p.id FROM projects p, json_each(p.jira_keys) j;
  ALTER TABLE projects DROP COLUMN jira_keys;

  DROP TABLE deadlines;
  CREATE TABLE deadlines (
    id              TEXT PRIMARY KEY,
    project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
    epic_key        TEXT REFERENCES jira_epics(key) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    phase_name      TEXT,
    start_date      TEXT,
    due_date        TEXT,
    source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('jira','manual','claude')),
    source_ref      TEXT,
    url             TEXT,
    status_name     TEXT,
    status_category TEXT,
    assignee        TEXT,
    assigned_to_me  INTEGER NOT NULL DEFAULT 0,
    original_hours  REAL,
    remaining_hours REAL,
    open_subtasks   TEXT NOT NULL DEFAULT '[]',
    state           TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','done')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (project_id IS NOT NULL OR epic_key IS NOT NULL)
  );
  CREATE INDEX ix_deadlines_due ON deadlines(due_date);
  CREATE INDEX ix_deadlines_epic ON deadlines(epic_key);

  -- Effective project of a deadline: its own (manual) or the one its Jira epic is linked to.
  CREATE VIEW v_deadlines AS
    SELECT d.*, COALESCE(d.project_id, e.project_id) AS eff_project_id, e.summary AS epic_summary
    FROM deadlines d LEFT JOIN jira_epics e ON e.key = d.epic_key;
  `,
  /* v3 — phase-gated documentation checklist, SharePoint project folder */ `
  ALTER TABLE projects ADD COLUMN sharepoint_folder_uri TEXT;
  ALTER TABLE doc_template ADD COLUMN required_from TEXT;
  ALTER TABLE doc_template ADD COLUMN client_match TEXT;
  ALTER TABLE doc_requirements ADD COLUMN required_from TEXT;
  ALTER TABLE doc_requirements ADD COLUMN from_template INTEGER NOT NULL DEFAULT 0;
  UPDATE doc_requirements SET from_template = 1;
  `,
  /* v4 — "Sync now" jobs run through Claude Code */ `
  CREATE TABLE sync_jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    mode         TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('running','ok','error')),
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    steps        TEXT NOT NULL DEFAULT '[]',
    result_text  TEXT,
    denials      TEXT NOT NULL DEFAULT '[]',
    error        TEXT,
    cost_usd     REAL,
    imported     INTEGER NOT NULL DEFAULT 0
  );
  `,
  /* v5 — Outlook calendar (today's meetings) */ `
  CREATE TABLE calendar_events (
    id             TEXT PRIMARY KEY,
    subject        TEXT NOT NULL,
    start_at       TEXT NOT NULL,
    end_at         TEXT NOT NULL,
    is_all_day     INTEGER NOT NULL DEFAULT 0,
    location       TEXT,
    online_url     TEXT,
    organizer      TEXT,
    organizer_name TEXT,
    attendees      TEXT NOT NULL DEFAULT '[]',
    show_as        TEXT,
    is_cancelled   INTEGER NOT NULL DEFAULT 0,
    is_organizer   INTEGER NOT NULL DEFAULT 0,
    web_link       TEXT,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX ix_calendar_start ON calendar_events(start_at);
  `,
  /* v6 — custom project groups (user-defined, e.g. "FEI Germania") */ `
  CREATE TABLE project_groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    color      TEXT,
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ALTER TABLE projects ADD COLUMN group_id INTEGER REFERENCES project_groups(id) ON DELETE SET NULL;
  `,
  /* v7 — daily auto-sync origin; document confirmation (OK) and change detection */ `
  ALTER TABLE sync_jobs ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
  ALTER TABLE doc_requirements ADD COLUMN found_path TEXT;
  ALTER TABLE doc_requirements ADD COLUMN found_modified_at TEXT;
  ALTER TABLE doc_requirements ADD COLUMN confirmed_at TEXT;
  ALTER TABLE doc_requirements ADD COLUMN confirmed_ref TEXT;
  `,
  /* v8 — files of each SharePoint project folder (folder browser) and document locations chosen by the user */ `
  CREATE TABLE project_files (
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    url         TEXT NOT NULL,
    modified_at TEXT,
    size        INTEGER,
    PRIMARY KEY (project_id, path)
  );
  ALTER TABLE projects ADD COLUMN files_scanned_at TEXT;
  ALTER TABLE doc_requirements ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  `,
  /* v9 — app settings (SharePoint folder synced on this PC), file-list source, checklist keywords */ `
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
  ALTER TABLE projects ADD COLUMN files_source TEXT;
  ALTER TABLE doc_template ADD COLUMN keywords TEXT;
  `,
  /* v10 — to-do list (local tasks + Microsoft To Do via Power Automate) */ `
  CREATE TABLE todo_lists (id TEXT PRIMARY KEY, name TEXT NOT NULL, wellknown TEXT);
  CREATE TABLE todo_tasks (
    id               TEXT PRIMARY KEY,
    todo_id          TEXT UNIQUE,
    list_id          TEXT,
    list_name        TEXT,
    title            TEXT NOT NULL,
    notes            TEXT,
    due_date         TEXT,
    importance       TEXT NOT NULL DEFAULT 'normal',
    status           TEXT NOT NULL DEFAULT 'notStarted',
    completed_at     TEXT,
    project_id       TEXT REFERENCES projects(id) ON DELETE SET NULL,
    origin           TEXT NOT NULL DEFAULT 'app',
    sync_state       TEXT NOT NULL DEFAULT 'local',
    sent_at          TEXT,
    todo_modified_at TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX todo_tasks_due ON todo_tasks (status, due_date);
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

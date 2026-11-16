import fs from 'node:fs';
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.ts';
import { applyDocTemplate } from './seed.ts';
import type { Rag } from './flags.ts';

/**
 * Snapshot contract v2 — produced by the Claude `pjm-sync` skill (via tools/build-snapshot.ts) into
 * data/inbox/snapshot.json. Claude owns these fields; user-owned fields (project status/phase/note,
 * epic→project links, mail user_state, doc waivers) are never overwritten. See docs/ARCHITECTURE.md.
 */
export interface SnapshotEpic {
  key: string; summary: string; status?: string; statusCategory?: string; startDate?: string | null;
  dueDate?: string | null; assignee?: string | null; mine: boolean; url?: string;
}
export interface SnapshotPhase {
  key: string; epicKey: string; summary: string; phaseName?: string; status?: string; statusCategory?: string;
  startDate?: string | null; dueDate?: string | null; assignee?: string | null; assignedToMe?: boolean;
  originalHours?: number | null; remainingHours?: number | null; url?: string;
  openSubtasks?: { key: string; summary: string; assignee?: string | null }[];
}
export interface SnapshotV2 {
  schemaVersion: 2;
  generatedAt: string;
  /** When true, Jira phases / epics absent from this snapshot are considered closed. */
  complete?: boolean;
  jira?: { epics: SnapshotEpic[]; phases: SnapshotPhase[] };
  projects?: { id: string; suggestedStatus?: Rag; suggestedReason?: string }[];
  /** SharePoint project folder found by Claude (the standard "Progetti Clienti/<client>/<year>/<project>" folder). */
  projectFolders?: { projectId: string; folderUri: string; webUrl?: string }[];
  /** Every file of a project folder (path below the folder), replacing the previous listing of that project. */
  projectFiles?: { projectId: string; scannedAt?: string; files: { path: string; url: string; modifiedAt?: string; size?: number }[] }[];
  /**
   * Mail is incremental: only threads Claude looked at in this run (window since the last sync).
   * Threads not included are left untouched — they are closed by the user or updated by a later run.
   */
  mailThreads?: {
    id: string; projectId?: string | null; subject: string; counterpart?: string; lastMessageAt?: string;
    lastFromMe?: boolean; category: 'needs_reply' | 'waiting' | 'fyi'; urgency?: 'high' | 'normal' | 'low';
    summary?: string; webLink?: string;
  }[];
  /** Outlook calendar for a date range: events in [from, to) replace what the app had for that range. */
  calendar?: {
    from: string; to: string;
    events: {
      id: string; subject: string; start: string; end: string; isAllDay?: boolean; location?: string | null;
      onlineUrl?: string | null; organizer?: string | null; organizerName?: string | null; attendees?: string[];
      showAs?: string | null; isCancelled?: boolean; isOrganizer?: boolean; webLink?: string | null;
    }[];
  };
  docChecks?: { requirementId: string; status: 'missing' | 'present' | 'outdated' | 'unknown'; foundUrl?: string; foundPath?: string;
    modifiedAt?: string; checkedAt?: string }[];
}

export interface ImportResult {
  imported: boolean;
  reason?: string;
  counts?: Record<string, number>;
  warnings?: string[];
}

export function importSnapshotIfPresent(db: DatabaseSync, file: string, force = false): ImportResult {
  if (!fs.existsSync(file)) return { imported: false, reason: 'no snapshot file' };
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return { imported: false, reason: 'snapshot file is empty' };
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const last = db.prepare('SELECT file_hash FROM sync_runs ORDER BY id DESC LIMIT 1').get() as { file_hash: string } | undefined;
  if (!force && last?.file_hash === hash) return { imported: false, reason: 'snapshot already imported' };

  const snap = JSON.parse(raw) as SnapshotV2;
  if (snap.schemaVersion !== 2) throw new Error(`Unsupported snapshot schemaVersion ${String(snap.schemaVersion)} (expected 2)`);
  return importSnapshot(db, snap, hash);
}

/** "SAATI - FEI Germania" → "SAATI" */
const clientOf = (summary: string) => summary.split(/\s+[-–]\s+/)[0]?.trim() || null;
const notIn = (ids: string[], col = 'id') => (ids.length ? `AND ${col} NOT IN (${ids.map(() => '?').join(',')})` : '');

export function importSnapshot(db: DatabaseSync, snap: SnapshotV2, hash: string | null = null): ImportResult {
  const warnings: string[] = [];
  const counts = {
    epics: 0, projectsCreated: 0, phases: 0, projects: 0, projectFolders: 0, mailThreads: 0, docChecks: 0, calendarEvents: 0, projectFiles: 0,
    closedPhases: 0, closedEpics: 0, deactivatedProjects: 0,
  };

  transaction(db, () => {
    // ---------- Jira epics → projects ----------
    const upsertEpic = db.prepare(`
      INSERT INTO jira_epics (key, summary, status, status_category, start_date, due_date, assignee, mine, url, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET summary = excluded.summary, status = excluded.status,
        status_category = excluded.status_category, start_date = excluded.start_date, due_date = excluded.due_date,
        assignee = excluded.assignee, mine = excluded.mine, url = excluded.url, active = 1, updated_at = datetime('now')`);
    const epicProject = db.prepare('SELECT project_id FROM jira_epics WHERE key = ?');
    const createProject = db.prepare(`INSERT OR IGNORE INTO projects (id, name, client, role, origin) VALUES (?, ?, ?, ?, 'jira')`);
    const linkEpic = db.prepare('UPDATE jira_epics SET project_id = ? WHERE key = ?');
    const seenEpics: string[] = [];

    for (const e of snap.jira?.epics ?? []) {
      upsertEpic.run(e.key, e.summary, e.status ?? null, e.statusCategory ?? null, e.startDate ?? null,
        e.dueDate ?? null, e.assignee ?? null, e.mine ? 1 : 0, e.url ?? null);
      const { project_id } = epicProject.get(e.key) as { project_id: string | null };
      if (!project_id) {
        if (Number(createProject.run(e.key, e.summary, clientOf(e.summary), e.mine ? 'pm' : 'contributor').changes)) {
          applyDocTemplate(db, e.key);
          counts.projectsCreated++;
        }
        linkEpic.run(e.key, e.key);
      }
      seenEpics.push(e.key);
      counts.epics++;
    }

    // ---------- Jira phases → deadlines ----------
    const knownEpics = new Set((db.prepare('SELECT key FROM jira_epics').all() as { key: string }[]).map((r) => r.key));
    const upsertPhase = db.prepare(`
      INSERT INTO deadlines (id, epic_key, title, phase_name, start_date, due_date, source, source_ref, url, status_name,
        status_category, assignee, assigned_to_me, original_hours, remaining_hours, open_subtasks, state)
      VALUES (?, ?, ?, ?, ?, ?, 'jira', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET epic_key = excluded.epic_key, title = excluded.title, phase_name = excluded.phase_name,
        start_date = excluded.start_date, due_date = excluded.due_date, source_ref = excluded.source_ref, url = excluded.url,
        status_name = excluded.status_name, status_category = excluded.status_category, assignee = excluded.assignee,
        assigned_to_me = excluded.assigned_to_me, original_hours = excluded.original_hours,
        remaining_hours = excluded.remaining_hours, open_subtasks = excluded.open_subtasks, state = excluded.state,
        updated_at = datetime('now')`);
    const seenPhases: string[] = [];
    for (const p of snap.jira?.phases ?? []) {
      if (!knownEpics.has(p.epicKey)) {
        warnings.push(`phase ${p.key}: epic ${p.epicKey} not in snapshot`);
        continue;
      }
      upsertPhase.run(
        p.key, p.epicKey, p.summary, p.phaseName ?? null, p.startDate ?? null, p.dueDate ?? null, p.key, p.url ?? null,
        p.status ?? null, p.statusCategory ?? null, p.assignee ?? null, p.assignedToMe ? 1 : 0,
        p.originalHours ?? null, p.remainingHours ?? null, JSON.stringify(p.openSubtasks ?? []),
        p.statusCategory === 'done' ? 'done' : 'open',
      );
      seenPhases.push(p.key);
      counts.phases++;
    }

    // ---------- Claude's overall status suggestion ----------
    const updProject = db.prepare(`UPDATE projects SET suggested_status = ?, suggested_reason = ?, updated_at = datetime('now') WHERE id = ?`);
    for (const p of snap.projects ?? []) {
      if (Number(updProject.run(p.suggestedStatus ?? null, p.suggestedReason ?? null, p.id).changes)) counts.projects++;
      else warnings.push(`project: unknown id "${p.id}"`);
    }

    // ---------- SharePoint project folders ----------
    const updFolder = db.prepare(`UPDATE projects SET sharepoint_folder_uri = ?, sharepoint_url = COALESCE(sharepoint_url, ?),
      updated_at = datetime('now') WHERE id = ?`);
    for (const f of snap.projectFolders ?? []) {
      if (Number(updFolder.run(f.folderUri, f.webUrl ?? null, f.projectId).changes)) counts.projectFolders++;
      else warnings.push(`projectFolder: unknown project "${f.projectId}"`);
    }

    // ---------- Mail ----------
    const knownProjects = new Set((db.prepare('SELECT id FROM projects').all() as { id: string }[]).map((r) => r.id));
    const upsertMail = db.prepare(`
      INSERT INTO mail_threads (id, project_id, subject, counterpart, last_message_at, last_from_me, category, urgency, summary, web_link)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = COALESCE(mail_threads.project_id, excluded.project_id), subject = excluded.subject, counterpart = excluded.counterpart,
        category = excluded.category, urgency = excluded.urgency, summary = excluded.summary, web_link = excluded.web_link,
        last_from_me = excluded.last_from_me,
        -- a new message re-opens a thread the user had closed or snoozed
        user_state = CASE WHEN excluded.last_message_at > COALESCE(mail_threads.last_message_at, '') THEN 'open' ELSE mail_threads.user_state END,
        last_message_at = excluded.last_message_at,
        updated_at = datetime('now')`);
    for (const m of snap.mailThreads ?? []) {
      let projectId = m.projectId ?? null;
      if (projectId && !knownProjects.has(projectId)) {
        warnings.push(`mail ${m.id}: unknown project "${projectId}"`);
        projectId = null;
      }
      upsertMail.run(m.id, projectId, m.subject, m.counterpart ?? null, m.lastMessageAt ?? null, m.lastFromMe ? 1 : 0,
        m.category, m.urgency ?? 'normal', m.summary ?? null, m.webLink ?? null);
      counts.mailThreads++;
    }

    // ---------- Calendar (replace the synced range) ----------
    if (snap.calendar) {
      const { from, to, events } = snap.calendar;
      db.prepare('DELETE FROM calendar_events WHERE start_at >= ? AND start_at < ?').run(from, to);
      const ins = db.prepare(`INSERT OR REPLACE INTO calendar_events (id, subject, start_at, end_at, is_all_day, location, online_url,
        organizer, organizer_name, attendees, show_as, is_cancelled, is_organizer, web_link) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const e of events) {
        ins.run(e.id, e.subject, e.start, e.end, e.isAllDay ? 1 : 0, e.location ?? null, e.onlineUrl ?? null, e.organizer ?? null,
          e.organizerName ?? null, JSON.stringify(e.attendees ?? []), e.showAs ?? null, e.isCancelled ? 1 : 0, e.isOrganizer ? 1 : 0,
          e.webLink ?? null);
        counts.calendarEvents++;
      }
    }

    // ---------- Documentation checks ----------
    const updDoc = db.prepare(`
      UPDATE doc_requirements SET check_status = ?, found_url = ?, found_path = ?, found_modified_at = ?, checked_at = ?,
        updated_at = datetime('now') WHERE id = ?`);
    const isPinned = db.prepare('SELECT pinned FROM doc_requirements WHERE id = ?');
    for (const c of snap.docChecks ?? []) {
      // A location chosen by the user wins over Claude's match; it is refreshed from the file listing below.
      const pin = isPinned.get(c.requirementId) as { pinned: number } | undefined;
      if (pin?.pinned) { counts.docChecks++; continue; }
      const present = c.status === 'present' || c.status === 'outdated';
      if (Number(updDoc.run(c.status, present ? c.foundUrl ?? null : null, present ? c.foundPath ?? null : null,
        present ? c.modifiedAt ?? null : null, c.checkedAt ?? snap.generatedAt, c.requirementId).changes)) counts.docChecks++;
      else warnings.push(`docCheck: unknown requirement "${c.requirementId}"`);
    }

    // ---------- Project folder listings (folder browser) + refresh of user-chosen files ----------
    for (const pf of snap.projectFiles ?? []) {
      if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(pf.projectId)) {
        warnings.push(`projectFiles: unknown project "${pf.projectId}"`);
        continue;
      }
      db.prepare('DELETE FROM project_files WHERE project_id = ?').run(pf.projectId);
      const ins = db.prepare('INSERT OR REPLACE INTO project_files (project_id, path, url, modified_at, size) VALUES (?, ?, ?, ?, ?)');
      for (const f of pf.files) ins.run(pf.projectId, f.path, f.url, f.modifiedAt ?? null, f.size ?? null);
      db.prepare('UPDATE projects SET files_scanned_at = ? WHERE id = ?').run(pf.scannedAt ?? snap.generatedAt, pf.projectId);
      counts.projectFiles += pf.files.length;
      refreshPinnedDocs(db, pf.projectId, snap.generatedAt);
    }

    // ---------- Close what Claude no longer reports ----------
    if (snap.complete && snap.jira) {
      counts.closedPhases = Number(db.prepare(
        `UPDATE deadlines SET state = 'done', updated_at = datetime('now') WHERE source = 'jira' AND state = 'open' ${notIn(seenPhases)}`,
      ).run(...seenPhases).changes);
      counts.closedEpics = Number(db.prepare(
        `UPDATE jira_epics SET active = 0, updated_at = datetime('now') WHERE active = 1 AND summary IS NOT NULL ${notIn(seenEpics, 'key')}`,
      ).run(...seenEpics).changes);
      counts.deactivatedProjects = Number(db.prepare(`
        UPDATE projects SET active = 0, updated_at = datetime('now')
        WHERE origin = 'jira' AND active = 1
          AND NOT EXISTS (SELECT 1 FROM jira_epics e WHERE e.project_id = projects.id AND e.active = 1)`).run().changes);
    }

    db.prepare('INSERT INTO sync_runs (generated_at, file_hash, counts, warnings) VALUES (?, ?, ?, ?)')
      .run(snap.generatedAt ?? null, hash, JSON.stringify(counts), JSON.stringify(warnings));
  });

  return { imported: true, counts, warnings };
}

const norm = (u: string) => { try { return decodeURIComponent(u).toLowerCase(); } catch { return u.toLowerCase(); } };

/**
 * Documents whose file the user chose: take the file's current version from the latest listing of the folder
 * (a newer date → "updated"), or mark them missing when the file is no longer there.
 */
export function refreshPinnedDocs(db: DatabaseSync, projectId: string, checkedAt: string) {
  const files = db.prepare('SELECT path, url, modified_at FROM project_files WHERE project_id = ?').all(projectId) as
    { path: string; url: string; modified_at: string | null }[];
  const pinned = db.prepare('SELECT id, found_url, found_path FROM doc_requirements WHERE project_id = ? AND pinned = 1').all(projectId) as
    { id: string; found_url: string | null; found_path: string | null }[];
  const upd = db.prepare(`UPDATE doc_requirements SET check_status = ?, found_modified_at = COALESCE(?, found_modified_at), checked_at = ?,
    updated_at = datetime('now') WHERE id = ?`);
  for (const d of pinned) {
    const f = files.find((x) => (d.found_url && norm(x.url) === norm(d.found_url)) || (d.found_path && norm(x.path) === norm(d.found_path)));
    upd.run(f ? 'present' : 'missing', f?.modified_at ?? null, checkedAt, d.id);
  }
}

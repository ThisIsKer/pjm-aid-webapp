import fs from 'node:fs';
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.ts';

/**
 * Snapshot contract v1 — written by the Claude "pjm-sync" skill into data/inbox/snapshot.json.
 * Claude owns the fields below; user-owned fields (project status, pm note, mail user_state,
 * doc waivers) are never overwritten by an import. See docs/ARCHITECTURE.md.
 */
export interface SnapshotV1 {
  schemaVersion: 1;
  generatedAt: string;
  /** When true, Jira deadlines / mail threads absent from this snapshot are considered closed. */
  complete?: boolean;
  projects?: { id: string; suggestedStatus?: Status; suggestedReason?: string }[];
  deadlines?: {
    id: string; projectId: string; title: string; dueDate?: string; startDate?: string;
    source?: 'jira' | 'claude'; sourceRef?: string; assignee?: string; remainingHours?: number; state?: 'open' | 'done';
  }[];
  mailThreads?: {
    id: string; projectId?: string | null; subject: string; counterpart?: string; lastMessageAt?: string;
    lastFromMe?: boolean; category: 'needs_reply' | 'waiting' | 'fyi'; urgency?: 'high' | 'normal' | 'low';
    summary?: string; webLink?: string;
  }[];
  docChecks?: { requirementId: string; status: 'missing' | 'present' | 'outdated' | 'unknown'; foundUrl?: string; checkedAt?: string }[];
}
type Status = 'green' | 'amber' | 'red' | 'grey';

export interface ImportResult {
  imported: boolean;
  reason?: string;
  counts?: Record<string, number>;
  warnings?: string[];
}

export function importSnapshotIfPresent(db: DatabaseSync, file: string, force = false): ImportResult {
  if (!fs.existsSync(file)) return { imported: false, reason: 'no snapshot file' };
  const raw = fs.readFileSync(file, 'utf8');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const last = db.prepare('SELECT file_hash FROM sync_runs ORDER BY id DESC LIMIT 1').get() as { file_hash: string } | undefined;
  if (!force && last?.file_hash === hash) return { imported: false, reason: 'snapshot already imported' };

  const snap = JSON.parse(raw) as SnapshotV1;
  if (snap.schemaVersion !== 1) throw new Error(`Unsupported snapshot schemaVersion ${String(snap.schemaVersion)}`);
  return importSnapshot(db, snap, hash);
}

export function importSnapshot(db: DatabaseSync, snap: SnapshotV1, hash: string | null = null): ImportResult {
  const warnings: string[] = [];
  const counts = { projects: 0, deadlines: 0, mailThreads: 0, docChecks: 0, closedDeadlines: 0, closedMail: 0 };
  const knownProjects = new Set(
    (db.prepare('SELECT id FROM projects').all() as { id: string }[]).map((r) => r.id),
  );
  const known = (id: string | null | undefined, what: string) => {
    if (id && !knownProjects.has(id)) {
      warnings.push(`${what}: unknown project "${id}"`);
      return false;
    }
    return true;
  };

  transaction(db, () => {
    const updProject = db.prepare(`UPDATE projects SET suggested_status = ?, suggested_reason = ?, updated_at = datetime('now') WHERE id = ?`);
    for (const p of snap.projects ?? []) {
      if (!known(p.id, 'project')) continue;
      updProject.run(p.suggestedStatus ?? null, p.suggestedReason ?? null, p.id);
      counts.projects++;
    }

    const upsertDeadline = db.prepare(`
      INSERT INTO deadlines (id, project_id, title, start_date, due_date, source, source_ref, assignee, remaining_hours, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id, title = excluded.title, start_date = excluded.start_date,
        due_date = excluded.due_date, source = excluded.source, source_ref = excluded.source_ref,
        assignee = excluded.assignee, remaining_hours = excluded.remaining_hours, state = excluded.state,
        updated_at = datetime('now')`);
    const seenDeadlines: string[] = [];
    for (const d of snap.deadlines ?? []) {
      if (!known(d.projectId, `deadline ${d.id}`)) continue;
      upsertDeadline.run(
        d.id, d.projectId, d.title, d.startDate ?? null, d.dueDate ?? null, d.source ?? 'jira',
        d.sourceRef ?? null, d.assignee ?? null, d.remainingHours ?? null, d.state ?? 'open',
      );
      seenDeadlines.push(d.id);
      counts.deadlines++;
    }

    const upsertMail = db.prepare(`
      INSERT INTO mail_threads (id, project_id, subject, counterpart, last_message_at, last_from_me, category, urgency, summary, web_link)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id, subject = excluded.subject, counterpart = excluded.counterpart,
        category = excluded.category, urgency = excluded.urgency, summary = excluded.summary, web_link = excluded.web_link,
        last_from_me = excluded.last_from_me,
        -- a new message re-opens a thread the user had closed or snoozed
        user_state = CASE WHEN excluded.last_message_at > COALESCE(mail_threads.last_message_at, '') THEN 'open' ELSE mail_threads.user_state END,
        last_message_at = excluded.last_message_at,
        updated_at = datetime('now')`);
    const seenMail: string[] = [];
    for (const m of snap.mailThreads ?? []) {
      const projectId = m.projectId && known(m.projectId, `mail ${m.id}`) ? m.projectId : null;
      upsertMail.run(
        m.id, projectId, m.subject, m.counterpart ?? null, m.lastMessageAt ?? null, m.lastFromMe ? 1 : 0,
        m.category, m.urgency ?? 'normal', m.summary ?? null, m.webLink ?? null,
      );
      seenMail.push(m.id);
      counts.mailThreads++;
    }

    const updDoc = db.prepare(`
      UPDATE doc_requirements SET check_status = ?, found_url = ?, checked_at = ?, updated_at = datetime('now') WHERE id = ?`);
    for (const c of snap.docChecks ?? []) {
      const res = updDoc.run(c.status, c.foundUrl ?? null, c.checkedAt ?? snap.generatedAt, c.requirementId);
      if (res.changes === 0) warnings.push(`docCheck: unknown requirement "${c.requirementId}"`);
      else counts.docChecks++;
    }

    if (snap.complete) {
      // Anything Claude no longer reports is closed — Jira-sourced deadlines and open mail threads only.
      const notIn = (ids: string[]) => (ids.length ? `AND id NOT IN (${ids.map(() => '?').join(',')})` : '');
      counts.closedDeadlines = Number(db.prepare(
        `UPDATE deadlines SET state = 'done', updated_at = datetime('now') WHERE source = 'jira' AND state = 'open' ${notIn(seenDeadlines)}`,
      ).run(...seenDeadlines).changes);
      counts.closedMail = Number(db.prepare(
        `UPDATE mail_threads SET user_state = 'done', updated_at = datetime('now') WHERE user_state != 'done' ${notIn(seenMail)}`,
      ).run(...seenMail).changes);
    }

    db.prepare('INSERT INTO sync_runs (generated_at, file_hash, counts, warnings) VALUES (?, ?, ?, ?)')
      .run(snap.generatedAt ?? null, hash, JSON.stringify(counts), JSON.stringify(warnings));
  });

  return { imported: true, counts, warnings };
}

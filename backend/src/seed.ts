import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.ts';
import { slug } from './util.ts';

interface SeedDoc {
  /** Phase that produces the document (Analisi, Implementazione, Test interni, UAT, Live, Post GoLive). */
  phase?: string;
  /** From which project phase the document counts as missing. Default: the phase after `phase`. */
  requiredFrom?: string;
  title: string;
  repository: 'sharepoint' | 'confluence';
  /** Where Claude should look, e.g. "3. Analisi" or "99. Project documents". */
  locationHint?: string;
  /** Only for projects whose name matches this regex (case-insensitive), e.g. "^Tecnica". */
  clientMatch?: string;
  /** Words that identify the file in the project folder (case-insensitive); default: from the title. */
  keywords?: string[];
}

interface SeedProject {
  id: string;
  name: string;
  client?: string;
  description?: string;
  phase?: string;
  /** Jira epic keys that belong to this project (several epics can be grouped into one project). */
  jiraKeys?: string[];
  sharepointUrl?: string;
  confluenceSpace?: string;
  mailKeywords?: string[];
  mailDomains?: string[];
  /** Extra project-specific documents (on top of the template). */
  docs?: SeedDoc[];
}

interface SeedFile {
  docTemplate?: SeedDoc[];
  projects?: SeedProject[];
}

const readSeed = (file: string): SeedFile | null =>
  fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as SeedFile) : null;

const matches = (pattern: string | null, name: string) => {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, 'i').test(name);
  } catch {
    return false;
  }
};

/**
 * data/seed.json is the source of truth for the documentation checklist template: it is re-read at every start,
 * and every project's template-derived requirements are aligned with it (new items added, removed ones dropped).
 */
export function syncDocTemplate(db: DatabaseSync, seedFile: string): void {
  const template = readSeed(seedFile)?.docTemplate;
  if (!template) return;
  transaction(db, () => {
    db.exec('DELETE FROM doc_template');
    const ins = db.prepare(`INSERT INTO doc_template (phase, required_from, title, repository, location_hint, client_match, keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const d of template) {
      ins.run(d.phase ?? null, d.requiredFrom ?? null, d.title, d.repository, d.locationHint ?? null, d.clientMatch ?? null,
        d.keywords?.length ? JSON.stringify(d.keywords) : null);
    }
    for (const { id } of db.prepare('SELECT id FROM projects').all() as { id: string }[]) applyDocTemplate(db, id);
  });
}

/** Aligns a project's template-derived requirements with doc_template (keeps check results and waivers). */
export function applyDocTemplate(db: DatabaseSync, projectId: string): void {
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined;
  if (!project) return;
  const upsert = db.prepare(`
    INSERT INTO doc_requirements (id, project_id, phase, required_from, title, repository, location_hint, from_template)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET phase = excluded.phase, required_from = excluded.required_from,
      repository = excluded.repository, location_hint = excluded.location_hint
    WHERE doc_requirements.from_template = 1`);
  const keep: string[] = [];
  for (const t of db.prepare('SELECT * FROM doc_template ORDER BY id').all() as unknown as {
    phase: string | null; required_from: string | null; title: string; repository: string;
    location_hint: string | null; client_match: string | null;
  }[]) {
    if (!matches(t.client_match, project.name)) continue;
    const id = `${projectId}--${slug(t.title)}`;
    upsert.run(id, projectId, t.phase, t.required_from, t.title, t.repository, t.location_hint);
    keep.push(id);
  }
  db.prepare(`DELETE FROM doc_requirements WHERE project_id = ? AND from_template = 1
    ${keep.length ? `AND id NOT IN (${keep.map(() => '?').join(',')})` : ''}`).run(projectId, ...keep);
}

/**
 * Loads manual projects from data/seed.json into an empty database. Projects normally come from Jira
 * (one per epic, created by the snapshot import); the seed is for grouping epics or non-Jira work.
 */
export function seedIfEmpty(db: DatabaseSync, seedFile: string): number {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
  const seed = readSeed(seedFile);
  if (n > 0 || !seed?.projects?.length) return 0;

  const insertProject = db.prepare(`
    INSERT INTO projects (id, name, client, description, phase, sharepoint_url, confluence_space, mail_keywords, mail_domains)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const linkEpic = db.prepare(`INSERT INTO jira_epics (key, project_id) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET project_id = excluded.project_id`);
  const insertDoc = db.prepare(`
    INSERT OR IGNORE INTO doc_requirements (id, project_id, phase, required_from, title, repository, location_hint)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  transaction(db, () => {
    for (const p of seed.projects!) {
      insertProject.run(
        p.id, p.name, p.client ?? null, p.description ?? null, p.phase ?? null, p.sharepointUrl ?? null,
        p.confluenceSpace ?? null, JSON.stringify(p.mailKeywords ?? []), JSON.stringify(p.mailDomains ?? []),
      );
      for (const key of p.jiraKeys ?? []) linkEpic.run(key, p.id);
      for (const d of p.docs ?? []) {
        insertDoc.run(`${p.id}--${slug(d.title)}`, p.id, d.phase ?? null, d.requiredFrom ?? null, d.title, d.repository, d.locationHint ?? null);
      }
    }
  });
  console.log(`[seed] Loaded ${seed.projects.length} projects from ${seedFile}`);
  return seed.projects.length;
}

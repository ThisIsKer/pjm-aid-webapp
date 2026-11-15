import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.ts';
import { slug } from './util.ts';

interface SeedDoc {
  phase?: string;
  title: string;
  repository: 'sharepoint' | 'confluence';
  locationHint?: string;
}

interface SeedProject {
  id: string;
  name: string;
  client?: string;
  description?: string;
  phase?: string;
  jiraKeys?: string[];
  sharepointUrl?: string;
  confluenceSpace?: string;
  mailKeywords?: string[];
  mailDomains?: string[];
  /** Overrides the shared docTemplate for this project. */
  docs?: SeedDoc[];
}

interface SeedFile {
  docTemplate?: SeedDoc[];
  projects: SeedProject[];
}

/** Loads data/seed.json into an empty database. Never touches a database that already has projects. */
export function seedIfEmpty(db: DatabaseSync, seedFile: string): number {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
  if (n > 0) return 0;
  if (!fs.existsSync(seedFile)) {
    console.warn(`[seed] ${seedFile} not found — starting with an empty registry (see data/seed.example.json).`);
    return 0;
  }
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8')) as SeedFile;

  const insertProject = db.prepare(`
    INSERT INTO projects (id, name, client, description, phase, jira_keys, sharepoint_url, confluence_space, mail_keywords, mail_domains)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertDoc = db.prepare(`
    INSERT INTO doc_requirements (id, project_id, phase, title, repository, location_hint)
    VALUES (?, ?, ?, ?, ?, ?)`);

  transaction(db, () => {
    for (const p of seed.projects) {
      insertProject.run(
        p.id, p.name, p.client ?? null, p.description ?? null, p.phase ?? null,
        JSON.stringify(p.jiraKeys ?? []), p.sharepointUrl ?? null, p.confluenceSpace ?? null,
        JSON.stringify(p.mailKeywords ?? []), JSON.stringify(p.mailDomains ?? []),
      );
      for (const d of p.docs ?? seed.docTemplate ?? []) {
        insertDoc.run(`${p.id}--${slug(d.title)}`, p.id, d.phase ?? null, d.title, d.repository, d.locationHint ?? null);
      }
    }
  });
  console.log(`[seed] Loaded ${seed.projects.length} projects from ${seedFile}`);
  return seed.projects.length;
}

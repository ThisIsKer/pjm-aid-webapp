import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { loadProjects } from './projects.ts';
import { toApi, toApiList } from './util.ts';

/**
 * Writes data/registry.json: what the Claude pjm-sync skill needs to know about the app's state
 * (projects with their epics, current phase, SharePoint folder and documentation checklist; open mail threads;
 * last sync). Rewritten after every import and every change made in the UI.
 */
export function exportRegistry(db: DatabaseSync): void {
  try {
    const last = db.prepare('SELECT generated_at, imported_at FROM sync_runs ORDER BY id DESC LIMIT 1').get();
    const projects = loadProjects(db, { all: true }).map((p) => ({
      id: p['id'], name: p['name'], client: p['client'], group: p['groupName'] ?? null, role: p['role'], active: p['active'],
      jiraKeys: p['jiraKeys'], currentPhase: p.currentPhase, phaseOverride: p['phase'],
      sharepointUrl: p['sharepointUrl'], sharepointFolderUri: p['sharepointFolderUri'],
      confluenceSpace: p['confluenceSpace'], mailKeywords: p['mailKeywords'], mailDomains: p['mailDomains'],
      docs: p.docs.map((d) => ({
        id: d.id, title: d.title, phase: d.phase, repository: d.repository, locationHint: d.locationHint,
        required: d.required, waived: d.waived, checkStatus: d.checkStatus, state: d.state, foundUrl: d.foundUrl,
        foundModifiedAt: d.foundModifiedAt, checkedAt: d.checkedAt,
      })),
    }));
    const openMail = toApiList(db.prepare(`SELECT id, project_id, subject, counterpart, category, last_message_at, last_from_me,
      user_state FROM mail_threads WHERE user_state != 'done' ORDER BY last_message_at`).all());
    const registry = {
      generatedAt: new Date().toISOString(),
      lastSync: last ? toApi(last) : null,
      projects,
      openMail,
    };
    fs.mkdirSync(path.dirname(config.registryFile), { recursive: true });
    fs.writeFileSync(config.registryFile, JSON.stringify(registry, null, 2));
  } catch (err) {
    console.error('[registry] export failed:', (err as Error).message);
  }
}

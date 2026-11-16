import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { refreshPinnedDocs } from './snapshot.ts';
import { slug } from './util.ts';

/**
 * SharePoint "Progetti Clienti" synced to this PC by OneDrive: the backend reads names and dates of the files
 * (never their content, so OneDrive placeholders are not downloaded), keeps each project's file list and decides
 * which checklist documents are present. Links still point to SharePoint on the web.
 */

const DEFAULT_ROOT = path.join(os.homedir(), 'OneDrive - Archiva Group', 'DDM SOLUTIONS - Documenti', 'Delivery', 'Progetti Clienti');
const DEFAULT_WEB_BASE = 'https://archiva.sharepoint.com/sites/DDMSOLUTIONS/Documenti condivisi/Delivery/Progetti Clienti';
const MAX_FILES = 3000;
const MAX_DEPTH = 8;
const SKIP = /^(~\$|\.|desktop\.ini$|thumbs\.db$)|\.(lnk|tmp)$/i;

export interface SpSettings { enabled: boolean; localRoot: string; webBase: string }

export function getSpSettings(db: DatabaseSync): SpSettings {
  const rows = db.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'sp.%'`).all() as { key: string; value: string }[];
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    enabled: (v['sp.enabled'] ?? '1') === '1',
    localRoot: process.env['PJM_SP_LOCAL_ROOT'] ?? v['sp.localRoot'] ?? DEFAULT_ROOT,
    webBase: v['sp.webBase'] ?? DEFAULT_WEB_BASE,
  };
}

export function saveSpSettings(db: DatabaseSync, s: Partial<SpSettings>) {
  const put = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (s.enabled !== undefined) put.run('sp.enabled', s.enabled ? '1' : '0');
  if (s.localRoot !== undefined) put.run('sp.localRoot', s.localRoot.trim().replace(/[\\/]+$/, ''));
  if (s.webBase !== undefined) put.run('sp.webBase', s.webBase.trim().replace(/\/+$/, ''));
}

export const rootAvailable = (s: SpSettings) => {
  try {
    return fs.statSync(s.localRoot).isDirectory();
  } catch {
    return false;
  }
};

const dec = (u: string) => { try { return decodeURIComponent(u); } catch { return u; } };
const webUrl = (s: SpSettings, rel: string) =>
  `${s.webBase.split('/').map((seg, i) => (i < 3 ? seg : encodeURIComponent(dec(seg)))).join('/')}/${rel.split('/').map(encodeURIComponent).join('/')}`;

/** Relative path below "Progetti Clienti" of a project folder web URL, or null when it is elsewhere. */
function relFromUrl(s: SpSettings, url: string | null): string | null {
  if (!url) return null;
  const u = dec(url).replace(/\/+$/, '');
  const base = dec(s.webBase).replace(/\/+$/, '');
  return u.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? u.slice(base.length + 1) : null;
}

// ---------- finding a project folder (Progetti Clienti / <client> / <year> / <project>) ----------

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['di', 'del', 'della', 'e', 'per', 'con', 'the', 'and', 'of', 'spa', 's', 'p', 'a', 'srl', 'progetto']);
const SYN: Record<string, string> = {
  fei: 'fe', einvoicing: 'fe', fatturazione: 'fe', elettronica: 'fe',
  de: 'germania', ger: 'germania', germany: 'germania', deutschland: 'germania',
  fr: 'francia', france: 'francia', sk: 'slovacchia', slovakia: 'slovacchia', es: 'spagna', spain: 'spagna',
  emirati: 'uae', uk: 'regnounito',
};
/** Words too common to identify a project folder on their own. */
const GENERIC_TOK = new Set(['fe', 'ddm', 'sap', 'integrazione', 'passaggio', 'workflow', 'adeguamento']);
const tokens = (s: string) => new Set(norm(s).split(' ').filter((t) => t && !STOP.has(t)).map((t) => SYN[t] ?? t));

const listDirs = (dir: string) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

function findClientFolder(root: string, client: string): string | null {
  const c = norm(client).replace(/ /g, '');
  if (!c) return null;
  const dirs = listDirs(root);
  const exact = dirs.find((d) => norm(d).replace(/ /g, '') === c);
  if (exact) return exact;
  // "G.D. DORIGO S.P.A." ↔ "GD Dorigo", "IMA" ↔ "IMA [..]"
  const pref = dirs.filter((d) => { const n = norm(d).replace(/ /g, ''); return n.length >= 3 && (n.startsWith(c) || c.startsWith(n)); });
  return pref.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** Best folder for the project under the client's year folders (start year first, then the next, previous, newest). */
function discoverFolder(s: SpSettings, client: string, name: string, startYear: number | null): string | null {
  const clientDir = findClientFolder(s.localRoot, client);
  if (!clientDir) return null;
  const years = listDirs(path.join(s.localRoot, clientDir)).filter((y) => /^\d{4}$/.test(y)).map(Number).sort((a, b) => b - a);
  const order = startYear ? [startYear, startYear + 1, startYear - 1, ...years] : years;
  const topic = tokens(name.includes(' - ') ? name.slice(name.indexOf(' - ') + 3) : name);
  const clientTok = tokens(client);
  for (const y of [...new Set(order)].filter((y) => years.includes(y))) {
    let best: { dir: string; score: number } | null = null;
    for (const d of listDirs(path.join(s.localRoot, clientDir, String(y)))) {
      const shared = [...tokens(d)].filter((x) => !clientTok.has(x) && topic.has(x));
      if (!shared.some((x) => !GENERIC_TOK.has(x))) continue; // at least one specific word in common
      const score = shared.reduce((n, x) => n + (GENERIC_TOK.has(x) ? 0.25 : 1), 0);
      if (!best || score > best.score) best = { dir: d, score };
    }
    if (best) return `${clientDir}/${y}/${best.dir}`;
  }
  return null;
}

// ---------- listing ----------

interface LocalFile { path: string; url: string; modifiedAt: string; size: number }

function walk(s: SpSettings, rel: string): LocalFile[] {
  const out: LocalFile[] = [];
  const base = path.join(s.localRoot, ...rel.split('/'));
  const visit = (dir: string, sub: string, depth: number) => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.test(e.name)) continue;
      const p = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) visit(path.join(dir, e.name), p, depth + 1);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(path.join(dir, e.name)); // metadata only: placeholders stay online-only
          out.push({ path: p, url: webUrl(s, `${rel}/${p}`), modifiedAt: st.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z'), size: st.size });
        } catch {
          /* vanished while scanning */
        }
      }
      if (out.length >= MAX_FILES) return;
    }
  };
  visit(base, '', 0);
  return out;
}

// ---------- matching checklist documents to files ----------

/** Default keywords per checklist document (by words in its title); data/seed.json can override with "keywords". */
const DEFAULT_KEYWORDS: [RegExp, string[]][] = [
  [/analisi|analysis/, ['analisi', 'analysis', 'requirements gathering', 'raccolta requisiti', 'requisiti', 'specifiche funzionali', 'functional spec']],
  [/open topic/, ['open topics', 'open topic', 'open point', 'otl']],
  [/system test|test interni/, ['system test', 'test interni', 'internal test', 'test di sistema']],
  [/testbook|test book/, ['testbook', 'test book', 'casi di test', 'test cases']],
  [/collaudo/, ['collaudo', 'uat sign', 'sign off', 'signoff', 'verbale uat', 'acceptance']],
  [/cutover|go.?live/, ['cutover', 'cut over', 'go live', 'golive']],
];
const GENERIC = new Set(['documento', 'verbale', 'piano', 'documentazione', 'aggiornata', 'file', 'doc']);

function keywordsFor(title: string, custom: string[] | null): string[] {
  if (custom?.length) return custom.map((k) => norm(k)).filter(Boolean);
  const t = norm(title);
  for (const [re, kw] of DEFAULT_KEYWORDS) if (re.test(t)) return kw;
  const words = t.split(' ').filter((w) => w.length >= 4 && !GENERIC.has(w) && !STOP.has(w));
  return words.length ? [words.join(' ')] : [t];
}

function bestMatch(files: LocalFile[], keywords: string[], hint: string | null): LocalFile | null {
  const hintDirs = (hint ?? '').split(/,| or | oppure /i).map((h) => norm(h)).filter(Boolean);
  let best: { f: LocalFile; score: number } | null = null;
  for (const f of files) {
    if (/^0 offerta/.test(norm(f.path.split('/')[0] ?? ''))) continue; // the offer is not project documentation
    const parts = f.path.split('/');
    const name = norm(parts.at(-1)!.replace(/\.[^.]+$/, ''));
    const dirs = norm(parts.slice(0, -1).join(' '));
    let score = 0;
    if (keywords.some((k) => name.includes(k))) score = 3;
    else if (keywords.some((k) => dirs.includes(k)) && /\.(docx?|xlsx?|pdf|pptx?)$/i.test(f.path)) score = 1;
    if (!score) continue;
    if (hintDirs.some((h) => dirs.includes(h))) score += 1;
    if (!best || score > best.score || (score === best.score && f.modifiedAt > best.f.modifiedAt)) best = { f, score };
  }
  return best?.f ?? null;
}

// ---------- scan ----------

export interface ScanResult { available: boolean; projects: number; mapped: number; discovered: number; files: number; at: string }

export function scanLocalSharePoint(db: DatabaseSync, onlyProject?: string): ScanResult {
  const s = getSpSettings(db);
  const at = new Date().toISOString();
  const result: ScanResult = { available: false, projects: 0, mapped: 0, discovered: 0, files: 0, at };
  if (!s.enabled || !rootAvailable(s)) return result;
  result.available = true;

  const projects = db.prepare(`SELECT p.id, p.name, p.client, p.sharepoint_url,
      (SELECT MIN(e.start_date) FROM jira_epics e WHERE e.project_id = p.id) AS epic_start,
      (SELECT MIN(d.start_date) FROM v_deadlines d WHERE d.eff_project_id = p.id) AS phase_start
    FROM projects p WHERE p.active = 1 ${onlyProject ? 'AND p.id = ?' : ''}`).all(...(onlyProject ? [onlyProject] : [])) as
    { id: string; name: string; client: string | null; sharepoint_url: string | null; epic_start: string | null; phase_start: string | null }[];
  const keywordsByTitle = new Map((db.prepare('SELECT title, keywords FROM doc_template').all() as { title: string; keywords: string | null }[])
    .map((t) => [slug(t.title), t.keywords ? (JSON.parse(t.keywords) as string[]) : null]));

  const setUrl = db.prepare(`UPDATE projects SET sharepoint_url = ?, updated_at = datetime('now') WHERE id = ? AND sharepoint_url IS NULL`);
  const delFiles = db.prepare('DELETE FROM project_files WHERE project_id = ?');
  const insFile = db.prepare('INSERT OR REPLACE INTO project_files (project_id, path, url, modified_at, size) VALUES (?, ?, ?, ?, ?)');
  const setScanned = db.prepare(`UPDATE projects SET files_scanned_at = ?, files_source = 'local' WHERE id = ?`);
  const docs = db.prepare(`SELECT id, title, location_hint FROM doc_requirements
    WHERE project_id = ? AND repository = 'sharepoint' AND pinned = 0 AND waived = 0`);
  const updDoc = db.prepare(`UPDATE doc_requirements SET check_status = ?, found_url = ?, found_path = ?, found_modified_at = ?,
    checked_at = ?, updated_at = datetime('now') WHERE id = ?`);

  for (const p of projects) {
    result.projects++;
    let rel = relFromUrl(s, p.sharepoint_url);
    if (rel && !fs.existsSync(path.join(s.localRoot, ...rel.split('/')))) rel = null;
    if (!rel && !p.sharepoint_url) {
      const start = p.epic_start ?? p.phase_start;
      rel = discoverFolder(s, p.client ?? p.name.split(' - ')[0]!, p.name, start ? Number(start.slice(0, 4)) : null);
      if (rel) {
        setUrl.run(webUrl(s, rel), p.id);
        result.discovered++;
      }
    }
    if (!rel) continue;
    result.mapped++;
    const files = walk(s, rel);
    result.files += files.length;
    db.exec('BEGIN');
    try {
      delFiles.run(p.id);
      for (const f of files) insFile.run(p.id, f.path, f.url, f.modifiedAt, f.size);
      setScanned.run(at, p.id);
      for (const d of docs.all(p.id) as { id: string; title: string; location_hint: string | null }[]) {
        const key = d.id.slice(p.id.length + 2);
        const f = bestMatch(files, keywordsFor(d.title, keywordsByTitle.get(key) ?? null), d.location_hint);
        updDoc.run(f ? 'present' : 'missing', f?.url ?? null, f?.path ?? null, f?.modifiedAt ?? null, at, d.id);
      }
      refreshPinnedDocs(db, p.id, at);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return result;
}

/** Rescans when OneDrive changes something under Progetti Clienti (debounced), plus a periodic safety scan. */
export function watchLocalSharePoint(db: DatabaseSync, onScanned: () => void) {
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | null = null;
  let watchedRoot = '';
  const run = () => {
    try {
      const r = scanLocalSharePoint(db);
      if (r.available) {
        console.log(`[sharepoint] scanned ${r.mapped}/${r.projects} project folders, ${r.files} files${r.discovered ? `, ${r.discovered} folders found` : ''}`);
        onScanned();
      }
    } catch (err) {
      console.error('[sharepoint] scan failed:', (err as Error).message);
    }
  };
  const schedule = (ms = 10_000) => {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  const rewatch = () => {
    const s = getSpSettings(db);
    if (watchedRoot === s.localRoot && watcher) return;
    watcher?.close();
    watcher = null;
    watchedRoot = s.localRoot;
    if (!s.enabled || !rootAvailable(s)) return;
    // Native recursive watching only on Windows/macOS (on Linux Node walks the whole tree): elsewhere the periodic scan runs.
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    try {
      watcher = fs.watch(s.localRoot, { recursive: true }, () => schedule());
      watcher.on('error', () => { watcher?.close(); watcher = null; });
    } catch {
      watcher = null; // recursive watch unavailable: the periodic scan still runs
    }
  };
  rewatch();
  schedule(2_000);
  setInterval(() => { rewatch(); run(); }, 15 * 60_000).unref();
  return { rescan: () => { rewatch(); run(); } };
}

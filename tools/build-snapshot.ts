/**
 * Builds data/inbox/snapshot.json (schema v2) from raw Jira search results.
 * Used by the Claude `pjm-sync` skill; runs with plain Node ≥ 22.18 (no install needed).
 *
 *   node tools/build-snapshot.ts --me <accountId> --site https://archivagroup.atlassian.net \
 *     --epics a.json [--phases b.json ...] [--foreign c.json ...] [--subtasks d.json ...] --out snapshot.json
 *     [--mail mail.json] [--docs docs.json] [--folders folders.json]
 *     [--calendar <files…> --calendar-from <ISO> --calendar-to <ISO>]
 *   node tools/build-snapshot.ts --candidates --phases b.json --foreign c.json
 *       → prints the keys of open phases that are overdue or due within 14 days (to fetch their open sub-tasks)
 *
 * Input files may be: a raw Atlassian MCP result ({"issues":{"nodes":[...]}}), {"issues":[...]}, an array of
 * Jira issues ({key, fields}), or an array of compact rows:
 *   {key, summary, status, cat, due, start, origH, remH, parent, parentSummary, assignee, assigneeId}
 *
 * --mail, --docs, --folders are written by Claude (judgement calls) and merged as-is after validation:
 *   mail.json    [{subject, projectId?, counterpart, lastMessageAt, lastFromMe, category, urgency, summary, webLink}]
 *   docs.json    [{requirementId, status: missing|present|outdated|unknown, foundUrl?, foundPath?, modifiedAt?, checkedAt?}]
 *   folders.json [{projectId, folderUri, webUrl}]
 * --calendar takes raw Microsoft 365 `outlook_calendar_search` results (saved tool output, possibly several JSON
 * objects back to back) or compact rows [{id, subject, start, end, isAllDay, location, organizer, organizerName,
 * showAs, isCancelled, isOrganizer, webLink, onlineUrl}] — start/end as ISO strings (UTC with Z, or local time).
 */
import fs from 'node:fs';
import path from 'node:path';
import { addDays, canonicalPhase, isoToday, mailThreadId, phaseFlags } from '../backend/src/flags.ts';
import type { SnapshotEpic, SnapshotPhase, SnapshotV2 } from '../backend/src/snapshot.ts';

interface Row {
  key: string; summary: string; status: string | null; cat: string | null; due: string | null; start: string | null;
  origH: number | null; remH: number | null; parent: string | null; parentSummary: string | null;
  parentStatus: string | null; parentCat: string | null; assignee: string | null; assigneeId: string | null;
}

const START_FIELD = 'customfield_11738';
const hours = (sec: unknown) => (typeof sec === 'number' ? Math.round((sec / 3600) * 100) / 100 : null);

function normalize(x: Record<string, any>): Row {
  if (!x['fields']) {
    return {
      key: x['key'], summary: x['summary'] ?? '', status: x['status'] ?? null, cat: x['cat'] ?? null,
      due: x['due'] ?? null, start: x['start'] ?? null, origH: x['origH'] ?? null, remH: x['remH'] ?? null,
      parent: x['parent'] ?? null, parentSummary: x['parentSummary'] ?? null, parentStatus: null, parentCat: null,
      assignee: x['assignee'] ?? null, assigneeId: x['assigneeId'] ?? null,
    };
  }
  const f = x['fields'];
  return {
    key: x['key'], summary: f.summary ?? '', status: f.status?.name ?? null, cat: f.status?.statusCategory?.key ?? null,
    due: f.duedate ?? null, start: f[START_FIELD] ?? null,
    origH: hours(f.timeoriginalestimate), remH: hours(f.timeestimate),
    parent: f.parent?.key ?? null, parentSummary: f.parent?.fields?.summary ?? null,
    parentStatus: f.parent?.fields?.status?.name ?? null, parentCat: f.parent?.fields?.status?.statusCategory?.key ?? null,
    assignee: f.assignee?.displayName ?? null, assigneeId: f.assignee?.accountId ?? null,
  };
}

function load(files: string[]): Row[] {
  const out = new Map<string, Row>();
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.issues) ? data.issues : data?.issues?.nodes ?? [];
    for (const x of list) {
      const row = normalize(x as Record<string, any>);
      out.set(row.key, row);
    }
  }
  return [...out.values()];
}

function args() {
  const a: Record<string, string[]> = {};
  let cur = '';
  for (const tok of process.argv.slice(2)) {
    if (tok.startsWith('--')) a[(cur = tok.slice(2))] ??= [];
    else a[cur]?.push(tok);
  }
  return a;
}

const a = args();
const today = isoToday();
const site = (a['site']?.[0] ?? 'https://archivagroup.atlassian.net').replace(/\/$/, '');
const url = (key: string) => `${site}/browse/${key}`;
const me = a['me']?.[0];

const epicRows = load(a['epics'] ?? []);
const ownPhaseRows = load(a['phases'] ?? []);
const foreignPhaseRows = load(a['foreign'] ?? []).filter((r) => !ownPhaseRows.some((o) => o.key === r.key));
const phaseRows = [...ownPhaseRows, ...foreignPhaseRows];
const subtaskRows = load(a['subtasks'] ?? []);

if (a['candidates']) {
  const horizon = addDays(today, 14);
  console.log(phaseRows.filter((r) => r.cat !== 'done' && r.due && r.due <= horizon).map((r) => r.key).join(','));
  process.exit(0);
}

if (!me) throw new Error('--me <accountId> is required');
if (!a['out']?.[0]) throw new Error('--out <file> is required');

// Epics: mine from --epics; parents of foreign phases are added as not-mine.
const epics = new Map<string, SnapshotEpic>();
for (const r of epicRows) {
  epics.set(r.key, { key: r.key, summary: r.summary, status: r.status ?? undefined, statusCategory: r.cat ?? undefined,
    startDate: r.start, dueDate: r.due, assignee: r.assignee, mine: true, url: url(r.key) });
}
// Parents of --phases are my epics (the query is `parent in (<my epics>)`); parents of --foreign are not.
for (const [rows, mine] of [[ownPhaseRows, true], [foreignPhaseRows, false]] as const) {
  for (const r of rows) {
    if (r.parent && !epics.has(r.parent)) {
      epics.set(r.parent, { key: r.parent, summary: r.parentSummary ?? r.parent, status: r.parentStatus ?? undefined,
        statusCategory: r.parentCat ?? undefined, mine, url: url(r.parent) });
    }
  }
}

const subtasksByParent = new Map<string, { key: string; summary: string; assignee: string | null }[]>();
for (const s of subtaskRows) {
  if (!s.parent || s.cat === 'done') continue;
  subtasksByParent.set(s.parent, [...(subtasksByParent.get(s.parent) ?? []), { key: s.key, summary: s.summary, assignee: s.assignee }]);
}

const phases: SnapshotPhase[] = phaseRows.filter((r) => r.parent).map((r) => ({
  key: r.key, epicKey: r.parent!, summary: r.summary,
  phaseName: canonicalPhase(r.summary, epics.get(r.parent!)?.summary),
  status: r.status ?? undefined, statusCategory: r.cat ?? undefined, startDate: r.start, dueDate: r.due,
  assignee: r.assignee, assignedToMe: r.assigneeId === me, originalHours: r.origH, remainingHours: r.remH,
  url: url(r.key), openSubtasks: subtasksByParent.get(r.key) ?? [],
}));

// ---------- Calendar ----------
/** Parses a file holding one JSON value, or several JSON objects back to back (raw MCP tool output). */
function parseMany(raw: string): unknown[] {
  const text = raw.trim();
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [v];
  } catch { /* fall through: concatenated objects */ }
  const out: unknown[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}') { if (--depth === 0) out.push(JSON.parse(text.slice(start, i + 1))); }
  }
  return out;
}

/** Graph {dateTime, timeZone} → ISO; UTC gets a Z, other zones are kept as local wall-clock time. */
const graphTime = (t: any): string => {
  if (typeof t === 'string') return t;
  const dt = String(t?.dateTime ?? '').replace(/\.\d+$/, '');
  return /^utc$/i.test(String(t?.timeZone ?? '')) ? `${dt}Z` : dt;
};
const teamsUrl = (text: unknown) => String(text ?? '').match(/https:\/\/teams\.microsoft\.com\/[^\s>"')]+/)?.[0] ?? null;

const calendarEvents = (a['calendar'] ?? [])
  .flatMap((f) => parseMany(fs.readFileSync(f, 'utf8')))
  .flatMap((x: any) => (Array.isArray(x?.events) ? x.events : [x]))
  .filter((e: any) => e && e.subject !== undefined && e.start)
  .map((e: any) => ({
    id: String(e.id ?? `${e.subject}|${graphTime(e.start)}`), subject: String(e.subject ?? ''),
    start: graphTime(e.start), end: graphTime(e.end), isAllDay: !!e.isAllDay, location: e.location ?? null,
    onlineUrl: e.onlineUrl ?? teamsUrl(e.summary) ?? teamsUrl(e.location), organizer: e.organizer ?? null,
    organizerName: e.organizerName ?? null, attendees: e.attendees ?? [], showAs: e.showAs ?? null,
    isCancelled: !!e.isCancelled, isOrganizer: !!e.isOrganizer, webLink: e.webLink ?? null,
  }));
const uniqueEvents = [...new Map(calendarEvents.map((e) => [e.id, e])).values()];
if (a['calendar'] && (!a['calendar-from']?.[0] || !a['calendar-to']?.[0])) throw new Error('--calendar needs --calendar-from and --calendar-to');

// ---------- Claude-written sections ----------
const readJson = (flag: string): any[] => (a[flag] ?? []).flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const oneOf = (v: unknown, allowed: string[], what: string) => {
  if (!allowed.includes(String(v))) throw new Error(`${what}: "${String(v)}" is not one of ${allowed.join('/')}`);
  return v as never;
};

const mailById = new Map<string, NonNullable<SnapshotV2['mailThreads']>[number]>();
for (const m of readJson('mail')) {
  if (!m.subject) throw new Error(`mail entry without subject: ${JSON.stringify(m).slice(0, 120)}`);
  const id = m.id ?? mailThreadId(m.subject);
  const prev = mailById.get(id);
  if (prev && (prev.lastMessageAt ?? '') > (m.lastMessageAt ?? '')) continue; // keep the latest state of a thread
  mailById.set(id, {
    id, subject: m.subject, projectId: m.projectId ?? null, counterpart: m.counterpart, lastMessageAt: m.lastMessageAt,
    lastFromMe: !!m.lastFromMe, category: oneOf(m.category, ['needs_reply', 'waiting', 'fyi'], `mail "${m.subject}" category`),
    urgency: oneOf(m.urgency ?? 'normal', ['high', 'normal', 'low'], `mail "${m.subject}" urgency`),
    summary: m.summary, webLink: m.webLink,
  });
}
const docChecks = readJson('docs').map((d) => ({
  requirementId: String(d.requirementId),
  status: oneOf(d.status, ['missing', 'present', 'outdated', 'unknown'], `doc ${d.requirementId} status`),
  foundUrl: d.foundUrl ?? undefined, foundPath: d.foundPath ?? undefined, modifiedAt: d.modifiedAt ?? d.lastModifiedDateTime ?? undefined,
  checkedAt: d.checkedAt ?? undefined,
}));
const projectFolders = readJson('folders').map((f) => ({ projectId: String(f.projectId), folderUri: String(f.folderUri), webUrl: f.webUrl }));

const snapshot: SnapshotV2 = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  complete: true,
  jira: { epics: [...epics.values()], phases },
  ...(a['mail'] ? { mailThreads: [...mailById.values()] } : {}),
  ...(a['docs'] ? { docChecks } : {}),
  ...(a['folders'] ? { projectFolders } : {}),
  ...(a['calendar'] ? { calendar: { from: a['calendar-from']![0]!, to: a['calendar-to']![0]!, events: uniqueEvents } } : {}),
};
fs.mkdirSync(path.dirname(a['out'][0]), { recursive: true });
// Write atomically: the app watches the inbox and must never read a half-written file.
fs.writeFileSync(`${a['out'][0]}.tmp`, JSON.stringify(snapshot, null, 2));
fs.renameSync(`${a['out'][0]}.tmp`, a['out'][0]);

// Human summary for the chat (controllo-pm style).
const flagged = phases.map((p) => ({
  p,
  flags: phaseFlags({
    startDate: p.startDate ?? null, dueDate: p.dueDate ?? null, originalHours: p.originalHours ?? null,
    remainingHours: p.remainingHours ?? null, state: p.statusCategory === 'done' ? 'done' : 'open',
  }, today),
}));
const list = (f: string) => flagged.filter((x) => x.flags.includes(f as never)).map(({ p }) =>
  `  - ${p.key} ${p.summary} (due ${p.dueDate}, ${p.remainingHours ?? '?'}h left, ${p.assignee ?? 'unassigned'})` +
  (p.openSubtasks?.length ? `\n      open sub-tasks: ${p.openSubtasks.map((s) => s.summary).join('; ')}` : ''));
console.log(`Snapshot written: ${epics.size} epics (${[...epics.values()].filter((e) => e.mine).length} mine), ${phases.length} open phases, ${subtaskRows.length} sub-tasks`);
console.log(`OVERDUE (${list('overdue').length})\n${list('overdue').join('\n') || '  none'}`);
console.log(`AT RISK (${list('at_risk').length})\n${list('at_risk').join('\n') || '  none'}`);
console.log(`Phases with missing data: ${flagged.filter((x) => x.flags.some((f) => f.startsWith('missing'))).length}`);
if (a['mail']) {
  const byCat = (c: string) => [...mailById.values()].filter((m) => m.category === c);
  console.log(`MAIL: ${byCat('needs_reply').length} need a reply, ${byCat('waiting').length} waiting on others, ${byCat('fyi').length} fyi`);
  for (const m of byCat('needs_reply')) console.log(`  - ${m.urgency === 'high' ? '[urgent] ' : ''}${m.subject} — ${m.counterpart ?? ''}`);
}
if (a['calendar']) console.log(`CALENDAR: ${uniqueEvents.length} event(s) between ${a['calendar-from']![0]} and ${a['calendar-to']![0]}`);
if (a['docs']) {
  const by = (st: string) => docChecks.filter((d) => d.status === st).length;
  console.log(`DOCS checked: ${docChecks.length} (present ${by('present')}, missing ${by('missing')}, outdated ${by('outdated')}, unknown ${by('unknown')})`);
}

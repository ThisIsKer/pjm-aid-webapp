import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, type ChildProcess } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { agentStatus, claudeBin, runClaude, type ClaudeRunState } from './agent.ts';
import { config } from './config.ts';
import { addDays, isoToday } from './flags.ts';
import { toApi, toApiList } from './util.ts';

/**
 * PJM secretary page. The ledger in data/ledger/ is owned by the pjm-secretary skill and written only by
 * tools/secretary/ledger.mjs: this module READS its JSON files to build the page, and every change made in the app
 * (an item marked done, a proposal approved or rejected) goes through `ledger.mjs apply` with a small delta file —
 * the same path the skill uses — so the tool stays the single writer. Runs of the skill ("Ingest now", "Recap now")
 * use Claude Code headless, like "Sync now".
 */

// ---------- ledger shapes (see .claude/skills/pjm-secretary/references/ledger.schema.json) ----------
interface LSource { kind: string; threadKey?: string; ref?: string; webLink?: string; at: string; from?: string }
interface LItem {
  id: string; type: string; text: string; status: 'open' | 'reference' | 'closed'; owner?: string; counterpart?: string;
  due?: string; eventDate?: string; firstSeen: string; lastUpdated: string; sources: LSource[];
  closedAt?: string; closedReason?: string; details?: { system?: string; objects?: string[]; values?: string[] };
}
interface LDocChange { at: string; repository: string; name: string; url: string; change: string; path?: string; modifiedBy?: string }
interface LProject { projectId: string; name: string; client?: string; summary?: string; items: LItem[]; docChanges?: LDocChange[]; lastActivityAt?: string }
interface LMessage { id: string; at: string; from: string; fromMe: boolean; webLink?: string }
interface LThread {
  threadKey: string; source: 'mail' | 'teams' | 'meeting'; projectId: string; subject?: string; counterpart?: string; summary: string;
  replyState: 'needs_reply' | 'waiting' | 'fyi' | 'none'; urgency?: string; messages: LMessage[]; updatedAt: string;
  assignment?: { method: string; confidence: string; rule?: string };
}
interface LProposal {
  id: string; createdAt: string; projectId: string; kind: 'update' | 'create'; status: string; rationale: string; needsTemplate?: boolean;
  target: { location: string; docType: string; path: string; webUrl?: string; baseModifiedAt?: string };
  changes: { op: string; locator?: unknown; content: unknown; itemIds?: string[] }[];
  sources: LSource[]; decision?: { at: string; note?: string };
}
interface LState { lastRun?: { mail?: string; teams?: string; docs?: string; recap?: string } }

// ---------- what the API returns ----------
export interface SecEntry {
  id: string; kind: 'item' | 'thread'; type: string; projectId: string; projectName: string | null; appProjectId: string | null;
  text: string; detail: string | null; owner: string | null; counterpart: string | null; due: string | null; eventDate: string | null;
  status: 'open' | 'reference' | 'closed'; urgency: string | null; since: string; lastUpdated: string; link: string | null; sourceKind: string | null; ownerMissing: boolean;
}

/** Written in run.notes of the deltas the app applies, so their run reports can be told apart. */
const APP_NOTE = 'PJM aid app';
const ITEM_RE = /^(.+)-(DEC|OPN|ACT|QST|WAI|TEC|DAT|RSK)-(\d{3,})$/;
const PROPOSAL_RE = /^P-\d{8}-\d{3}$/;
const HORIZON_DAYS = 14;
const dir = (...p: string[]) => path.join(config.ledgerDir, ...p);

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T;
  } catch {
    return null;
  }
}
const listJson = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')) : []);
const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

export const ledgerAvailable = () => isDir(config.ledgerDir);

// Same link rules as ledger.mjs (mail links are derived from the Outlook message id).
const OWA = 'https://outlook.office365.com/owa/?ItemID=';
const mailWebLink = (id: string) => `${OWA}${encodeURIComponent(id.replace(/_/g, '+'))}&exvsurl=1&viewmodel=ReadMessageItem`;
function sourceLink(src?: LSource): string | null {
  if (!src) return null;
  if (src.webLink) return src.webLink;
  if (src.kind === 'mail' && src.ref) return mailWebLink(src.ref);
  if (src.ref && /^https?:\/\//.test(src.ref)) return src.ref;
  return null;
}
const lastMsg = (th: LThread) => th.messages.reduce<LMessage | null>((a, m) => (!a || Date.parse(m.at) > Date.parse(a.at) ? m : a), null);
function threadLink(th: LThread): string | null {
  const m = lastMsg(th);
  if (!m) return null;
  return m.webLink ?? (th.source === 'mail' ? mailWebLink(m.id) : null);
}

interface Ledger { state: LState; projects: Map<string, LProject>; threads: LThread[]; proposals: LProposal[] }

function loadLedger(): Ledger | null {
  if (!ledgerAvailable()) return null;
  const projects = new Map<string, LProject>();
  for (const f of listJson(dir('projects'))) {
    const p = readJson<LProject>(dir('projects', f));
    if (p?.projectId) projects.set(p.projectId, p);
  }
  const threads: LThread[] = [];
  if (isDir(dir('threads'))) {
    for (const pid of fs.readdirSync(dir('threads'))) {
      if (!isDir(dir('threads', pid))) continue;
      for (const f of listJson(dir('threads', pid))) {
        const t = readJson<LThread>(dir('threads', pid, f));
        if (t?.threadKey) threads.push(t);
      }
    }
  }
  const proposals = listJson(dir('proposals')).map((f) => readJson<LProposal>(dir('proposals', f))).filter((p): p is LProposal => !!p);
  return { state: readJson<LState>(dir('state.json')) ?? {}, projects, threads, proposals };
}

/** Ledger project id (a Jira epic key, `_unassigned` or `_internal-…`) → the app's project and its name. */
function projectResolver(db: DatabaseSync, ledger: Ledger) {
  const epics = new Map((db.prepare('SELECT key, project_id FROM jira_epics WHERE project_id IS NOT NULL').all() as { key: string; project_id: string }[])
    .map((r) => [r.key, r.project_id]));
  const names = new Map((db.prepare('SELECT id, name FROM projects').all() as { id: string; name: string }[]).map((r) => [r.id, r.name]));
  return (pid: string) => {
    const appProjectId = epics.get(pid) ?? (names.has(pid) ? pid : null);
    const ledgerName = ledger.projects.get(pid)?.name;
    const name = (appProjectId && names.get(appProjectId)) || (ledgerName && ledgerName !== pid ? ledgerName : null)
      || (pid.startsWith('_') ? null : pid);
    return { appProjectId, projectName: name };
  };
}

function itemEntry(it: LItem, pid: string, resolve: ReturnType<typeof projectResolver>): SecEntry {
  const src = it.sources.at(-1);
  const details = it.details ? [it.details.system, ...(it.details.objects ?? []), ...(it.details.values ?? [])].filter(Boolean).join(' · ') : '';
  return {
    id: it.id, kind: 'item', type: it.type, projectId: pid, ...resolve(pid), text: it.text,
    detail: it.status === 'closed' ? (it.closedReason ?? null) : details || null,
    owner: it.owner ?? null, counterpart: it.counterpart ?? null, due: it.due ?? null, eventDate: it.eventDate ?? null,
    status: it.status, urgency: null, since: it.firstSeen, lastUpdated: it.lastUpdated, link: sourceLink(src), sourceKind: src?.kind ?? null,
    ownerMissing: ['action', 'question'].includes(it.type) && !it.owner,
  };
}

function threadEntry(th: LThread, resolve: ReturnType<typeof projectResolver>): SecEntry {
  const m = lastMsg(th);
  return {
    id: `thread:${th.threadKey}`, kind: 'thread', type: th.replyState, projectId: th.projectId, ...resolve(th.projectId),
    text: th.subject || th.counterpart || th.threadKey, detail: th.summary || null, owner: null, counterpart: th.counterpart ?? m?.from ?? null,
    due: null, eventDate: null, status: 'open', urgency: th.urgency ?? null, since: m?.at ?? th.updatedAt, lastUpdated: th.updatedAt,
    link: threadLink(th), sourceKind: th.source, ownerMissing: false,
  };
}

const URG: Record<string, number> = { high: 0, normal: 1, low: 2 };
/** On me: overdue first, then high urgency, then by due date, then the longest waiting. */
function byPressure(today: string) {
  return (a: SecEntry, b: SecEntry) => {
    const ao = a.due && a.due < today ? 0 : 1;
    const bo = b.due && b.due < today ? 0 : 1;
    return ao - bo || (URG[a.urgency ?? 'normal'] ?? 1) - (URG[b.urgency ?? 'normal'] ?? 1)
      || (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.since.localeCompare(b.since);
  };
}

function recapDates(): string[] {
  return listJson(dir('recaps')).map((f) => f.slice(0, -5)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
}

/**
 * Everything the secretary page shows. `project` (an app project id or a ledger project id) narrows every list;
 * `days` is the look-back for decisions, document changes and quiet unassigned threads.
 */
export function secretaryOverview(db: DatabaseSync, opts: { project?: string; days?: number } = {}) {
  const ledger = loadLedger();
  const job = currentOrLastSecretaryJob(db);
  const agent = agentStatus();
  if (!ledger) return { available: false, ledgerDir: config.ledgerDir, job, agentAvailable: agent.available };

  const today = isoToday();
  const horizon = addDays(today, HORIZON_DAYS);
  const days = Math.min(Math.max(opts.days ?? 7, 1), 60);
  const since = Date.now() - days * 864e5;
  const resolve = projectResolver(db, ledger);
  const inScope = (e: { projectId: string; appProjectId: string | null }) =>
    !opts.project || e.projectId === opts.project || e.appProjectId === opts.project;

  const items: SecEntry[] = [];
  for (const [pid, pr] of ledger.projects) for (const it of pr.items) if (it.status !== 'closed') items.push(itemEntry(it, pid, resolve));
  const threads = ledger.threads.map((t) => threadEntry(t, resolve));
  const live = items.filter(inScope);
  const liveThreads = threads.filter(inScope);
  const isMe = (o: string | null) => o === 'me';

  const onMe = [
    ...live.filter((e) => e.status !== 'reference' && ((isMe(e.owner) && ['action', 'question', 'open_point'].includes(e.type)) || e.ownerMissing)),
    ...liveThreads.filter((t) => t.type === 'needs_reply'),
  ].sort(byPressure(today));
  const waiting = [
    ...live.filter((e) => e.type === 'waiting_on' || (['action', 'question'].includes(e.type) && e.owner && !isMe(e.owner))),
    ...liveThreads.filter((t) => t.type === 'waiting'),
  ].sort((a, b) => a.since.localeCompare(b.since));
  const openPoints = live.filter((e) => e.type === 'open_point' && !isMe(e.owner)).sort((a, b) => a.since.localeCompare(b.since));
  const risks = live.filter((e) => e.type === 'risk').sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
  const dates = live.filter((e) => e.type === 'date' && e.eventDate && e.eventDate <= horizon)
    .sort((a, b) => (a.eventDate ?? '').localeCompare(b.eventDate ?? ''));
  const decisions = live.filter((e) => ['decision', 'technical'].includes(e.type) && Date.parse(e.since) >= since)
    .sort((a, b) => b.since.localeCompare(a.since));
  // threads to sort belong to no project: shown with no filter, or with the "to sort" filter itself
  const unassigned = threads.filter((t) => t.projectId === '_unassigned' && (!opts.project || opts.project === '_unassigned')
    && (['needs_reply', 'waiting'].includes(t.type) || Date.parse(t.lastUpdated) >= since))
    .sort((a, b) => b.since.localeCompare(a.since));

  const docChanges = [...ledger.projects].flatMap(([pid, pr]) => (pr.docChanges ?? [])
    .filter((d) => Date.parse(d.at) >= since)
    .map((d) => ({ ...d, projectId: pid, ...resolve(pid) })))
    .filter(inScope)
    .sort((a, b) => b.at.localeCompare(a.at));

  const proposals = ledger.proposals
    .filter((p) => ['pending', 'stale', 'approved'].includes(p.status))
    .map((p) => ({ ...p, ...resolve(p.projectId), sources: p.sources.map((s) => ({ ...s, link: sourceLink(s) })) }))
    .filter(inScope)
    .sort((a, b) => (a.status === 'approved' ? 1 : 0) - (b.status === 'approved' ? 1 : 0) || a.id.localeCompare(b.id));

  // Projects that have something to show (for the project filter), busiest first.
  const counts = new Map<string, { projectId: string; appProjectId: string | null; projectName: string | null; open: number }>();
  for (const e of [...items, ...threads.filter((t) => ['needs_reply', 'waiting'].includes(t.type))]) {
    const key = e.appProjectId ?? e.projectId;
    const c = counts.get(key) ?? { projectId: e.projectId, appProjectId: e.appProjectId, projectName: e.projectName, open: 0 };
    c.open++;
    counts.set(key, c);
  }

  return {
    available: true,
    today, horizon, days,
    lastRun: ledger.state.lastRun ?? {},
    kpis: {
      onMe: onMe.length,
      needsReply: onMe.filter((e) => e.kind === 'thread').length,
      waiting: waiting.length,
      proposals: proposals.filter((p) => p.status !== 'approved').length,
      approved: proposals.filter((p) => p.status === 'approved').length,
      risks: risks.length,
      unassigned: unassigned.length,
    },
    onMe, waiting, openPoints, risks, dates, decisions, docChanges, proposals, unassigned,
    projects: [...counts.values()].sort((a, b) => b.open - a.open),
    recapDates: recapDates().slice(0, 30),
    job, agentAvailable: agent.available,
  };
}

/** How many things wait on Sebastiano (dashboard KPI); null when the secretary has no ledger yet. */
export function secretaryOnMeCount(db: DatabaseSync): number | null {
  const o = secretaryOverview(db);
  return o.available ? (o as { kpis: { onMe: number } }).kpis.onMe : null;
}

/** One end-of-day recap (data/ledger/recaps/<date>.json) with every line's link resolved, as recap-render does. */
export function secretaryRecap(db: DatabaseSync, date?: string) {
  const ledger = loadLedger();
  if (!ledger) return null;
  const all = recapDates();
  const day = date && all.includes(date) ? date : all[0];
  if (!day) return { date: null, dates: [], recap: null };
  const rc = readJson<Record<string, any>>(dir('recaps', `${day}.json`));
  if (!rc) return { date: day, dates: all, recap: null };
  const resolve = projectResolver(db, ledger);
  const threads = new Map(ledger.threads.map((t) => [t.threadKey, t]));
  const findItem = (id: string) => {
    for (const pr of ledger.projects.values()) { const it = pr.items.find((x) => x.id === id); if (it) return it; }
    return null;
  };
  const link = (l: { link?: string; itemId?: string; threadKey?: string }) => {
    if (l.link) return l.link;
    if (l.itemId) { const it = findItem(l.itemId); if (it) return sourceLink(it.sources.at(-1)); }
    if (l.threadKey) { const th = threads.get(l.threadKey); if (th) return threadLink(th); }
    return null;
  };
  const lines = (v: unknown) => (Array.isArray(v) ? v.map((l) => ({ ...l, link: link(l) })) : []);
  const recap = {
    ...rc,
    projects: (rc['projects'] ?? []).map((p: Record<string, unknown>) => ({
      ...p, appProjectId: resolve(String(p['projectId'])).appProjectId,
      changedToday: lines(p['changedToday']), waitingOnMe: lines(p['waitingOnMe']), waitingOnOthers: lines(p['waitingOnOthers']),
      documentation: lines(p['documentation']), jira: lines(p['jira']),
    })),
  };
  return { date: day, dates: all.slice(0, 30), recap };
}

/** The day's events (data/ledger/events/<date>.json), newest first, with links. */
export function secretaryEvents(db: DatabaseSync, date: string) {
  const ledger = loadLedger();
  if (!ledger) return null;
  const resolve = projectResolver(db, ledger);
  const threads = new Map(ledger.threads.map((t) => [t.threadKey, t]));
  const items = new Map<string, LItem>();
  for (const pr of ledger.projects.values()) for (const it of pr.items) items.set(it.id, it);
  const ev = readJson<{ events: { at: string; kind: string; projectId: string; ref?: string; text: string }[] }>(dir('events', `${date}.json`));
  return {
    date,
    events: (ev?.events ?? []).map((e) => {
      let link: string | null = null;
      if (e.ref && ['mail_in', 'mail_out', 'teams'].includes(e.kind)) { const th = threads.get(e.ref); link = th ? threadLink(th) : null; }
      else if (e.ref && e.kind.startsWith('item_')) link = sourceLink(items.get(e.ref)?.sources.at(-1));
      else if (e.ref && /^https?:\/\//.test(e.ref)) link = e.ref;
      return { ...e, ...resolve(e.projectId), link };
    }).sort((a, b) => b.at.localeCompare(a.at)),
  };
}

/** Run reports written by ledger.mjs apply (data/ledger/runs/<YYYY-MM-DD_HHmmss>-<mode>.md), newest first. */
export function secretaryRuns(limit = 20) {
  if (!isDir(dir('runs'))) return [];
  return fs.readdirSync(dir('runs')).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, limit).map((f) => {
    const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})-([a-z]+)\.md$/.exec(f);
    const text = fs.readFileSync(dir('runs', f), 'utf8');
    return {
      file: f, mode: m?.[5] ?? null, at: m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}` : null,
      fromApp: text.includes(APP_NOTE), text: text.slice(0, 8000),
    };
  });
}

// ---------- changes made in the app: always through `ledger.mjs apply` ----------
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

function applyDelta(delta: Record<string, unknown>): string {
  if (!ledgerAvailable()) throw Object.assign(new Error('The secretary ledger does not exist yet (data/ledger)'), { status: 404 });
  if (!fs.existsSync(config.ledgerTool)) throw Object.assign(new Error(`Ledger tool not found: ${config.ledgerTool}`), { status: 500 });
  fs.mkdirSync(dir('inbox'), { recursive: true });
  let file = dir('inbox', `delta-${stamp()}-app.json`);
  for (let i = 2; fs.existsSync(file); i++) file = dir('inbox', `delta-${stamp()}-app${i}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, ...delta }, null, 2)}\n`, 'utf8');
  const r = spawnSync(process.execPath, [config.ledgerTool, 'apply', file], {
    cwd: config.root, encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, PJM_LEDGER_ROOT: config.ledgerDir },
  });
  if (r.status !== 0) {
    // On errors ledger.mjs writes nothing and leaves the delta in the inbox: remove it, the app will retry from scratch.
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    throw Object.assign(new Error((r.stderr || r.stdout || r.error?.message || 'ledger apply failed').trim()), { status: 422 });
  }
  return r.stdout.trim();
}

/** "Done" on an item: closes it in the ledger (it stays visible in the archive and the event log). */
export function closeSecretaryItem(id: string, reason?: string) {
  if (!ITEM_RE.test(id)) throw Object.assign(new Error('invalid item id'), { status: 400 });
  const report = applyDelta({
    run: { mode: 'cleanup', notes: [`${APP_NOTE}: ${id} chiuso`] },
    items: [{ op: 'close', id, reason: (reason?.trim() || 'fatto (chiuso dall\'app)').slice(0, 200) }],
  });
  return { ok: true, report };
}

/**
 * Decision on a documentation proposal. The app only records it: approved proposals are applied to the document in
 * Claude Code ("applica le proposte approvate"), which re-checks that the file has not changed and asks permission
 * for the edit (references/review.md).
 */
export function decideSecretaryProposal(id: string, status: string, note?: string) {
  if (!PROPOSAL_RE.test(id)) throw Object.assign(new Error('invalid proposal id'), { status: 400 });
  if (!['approved', 'rejected', 'pending'].includes(status)) throw Object.assign(new Error('status must be approved, rejected or pending'), { status: 400 });
  const current = readJson<LProposal>(dir('proposals', `${id}.json`));
  if (!current) throw Object.assign(new Error(`unknown proposal ${id}`), { status: 404 });
  if (!['pending', 'stale', 'approved'].includes(current.status)) {
    throw Object.assign(new Error(`proposal ${id} is already ${current.status}`), { status: 409 });
  }
  const report = applyDelta({
    run: { mode: 'apply', notes: [`${APP_NOTE}: ${id} → ${status}`] },
    proposalUpdates: [{ id, status, ...(note?.trim() ? { note: note.trim().slice(0, 300) } : {}) }],
  });
  return { ok: true, report };
}

// ---------- "Ingest now" / "Recap now": the pjm-secretary skill through Claude Code ----------
export type SecretaryMode = 'ingest' | 'recap';
interface SecJob extends ClaudeRunState {
  id: number; mode: SecretaryMode; status: 'running' | 'ok' | 'error'; startedAt: string; finishedAt?: string; applied?: boolean;
}

const SCOPE: Record<SecretaryMode, string> = {
  ingest: 'secretary ingest',
  recap: 'secretary recap (riepilogo di fine giornata: ingest first, then the recap as in references/recap.md)',
};
const prompt = (mode: SecretaryMode, lang: 'it' | 'en') =>
  `Run the pjm-secretary skill (you are invoked headless by the PJM aid app in its repo folder, nobody can answer questions): ` +
  `${SCOPE[mode]}. Write the final message in ${lang === 'en' ? 'English' : 'Italian'}.`;

/** Step code for a tool call (translated by the frontend: sec.step.<code>). */
function stepOf(tool: string): string {
  const t = tool.toLowerCase();
  if (t === 'skill') return 'skill';
  if (t.includes('chat_message_search') || t.includes('teams')) return 'teams';
  if (t.includes('calendar')) return 'calendar';
  if (t.includes('outlook') || t.endsWith('__get_me')) return 'mail';
  if (t.includes('read_resource')) return 'body';
  if (t.includes('sharepoint')) return 'docs';
  if (t.includes('confluence')) return 'confluence';
  if (t.includes('jira') || t.includes('atlassian')) return 'jira';
  if (t === 'bash' || t === 'powershell') return 'ledger';
  if (t === 'write' || t === 'edit') return 'write';
  if (t === 'read' || t === 'glob' || t === 'grep' || t === 'toolsearch') return 'read';
  return tool;
}

let current: { job: SecJob; child: ChildProcess } | null = null;

function saveJob(db: DatabaseSync, job: SecJob) {
  db.prepare(`UPDATE secretary_jobs SET status = ?, finished_at = ?, steps = ?, result_text = ?, denials = ?, error = ?, cost_usd = ?,
    applied = ? WHERE id = ?`).run(job.status, job.finishedAt ?? null, JSON.stringify(job.steps), job.resultText ?? null,
    JSON.stringify(job.denials), job.error ?? null, job.costUsd ?? null, job.applied ? 1 : 0, job.id);
}

/** Newest run report written since `iso` (proof that the run reached `ledger.mjs apply`). */
function reportSince(iso: string): boolean {
  if (!isDir(dir('runs'))) return false;
  const t = Date.parse(iso) - 1000;
  return fs.readdirSync(dir('runs')).some((f) => f.endsWith('.md') && fs.statSync(dir('runs', f)).mtimeMs >= t);
}

export function startSecretary(db: DatabaseSync, mode: SecretaryMode, lang: 'it' | 'en' = 'it'): SecJob {
  if (current) throw Object.assign(new Error('A secretary run is already in progress'), { status: 409 });
  if (!agentStatus().available) throw Object.assign(new Error(`Claude Code not found ("${claudeBin()} --version" failed)`), { status: 503 });
  if (!fs.existsSync(config.ledgerTool)) throw Object.assign(new Error(`Ledger tool not found: ${config.ledgerTool}`), { status: 500 });

  const startedAt = new Date().toISOString();
  const id = Number(db.prepare(`INSERT INTO secretary_jobs (mode, status, started_at) VALUES (?, 'running', ?)`).run(mode, startedAt).lastInsertRowid);
  const job: SecJob = { id, mode, status: 'running', startedAt, steps: [], denials: [] };
  const child = runClaude(job, prompt(mode, lang), stepOf, () => {
    job.finishedAt = new Date().toISOString();
    job.applied = reportSince(startedAt);
    job.status = job.error ? 'error' : 'ok';
    saveJob(db, job);
    current = null;
  });
  current = { job, child };
  saveJob(db, job);
  return job;
}

export function currentOrLastSecretaryJob(db: DatabaseSync) {
  if (current) return current.job;
  const row = db.prepare('SELECT * FROM secretary_jobs ORDER BY id DESC LIMIT 1').get();
  return row ? toApi<SecJob>(row) : null;
}

export const recentSecretaryJobs = (db: DatabaseSync) => toApiList(db.prepare('SELECT * FROM secretary_jobs ORDER BY id DESC LIMIT 10').all());

/** On startup, runs left "running" by a previous backend process are marked as interrupted. */
export function markInterruptedSecretaryJobs(db: DatabaseSync) {
  db.prepare(`UPDATE secretary_jobs SET status = 'error', error = 'Interrupted (backend restarted)', finished_at = datetime('now')
    WHERE status = 'running'`).run();
}

#!/usr/bin/env node
// PJM secretary — ledger tool (Node 18+, no dependencies). Run from the pjm-aid-webapp folder.
//
// Claude never reads or rewrites the large ledger files. It reads compact views printed by this tool and writes one
// small delta file per run; this tool validates the delta, numbers items, links sources, merges everything into the
// ledger, auto-closes past dates, archives old items and writes the run report.
//
//   node tools/secretary/ledger.mjs status
//   node tools/secretary/ledger.mjs context [--projects ID,ID] [--all] [--days 10]
//   node tools/secretary/ledger.mjs apply data/ledger/inbox/delta-YYYYMMDD-HHmmss.json
//   node tools/secretary/ledger.mjs proposals
//   node tools/secretary/ledger.mjs recap-context YYYY-MM-DD
//   node tools/secretary/ledger.mjs recap-render YYYY-MM-DD
//   node tools/secretary/ledger.mjs migrate
//   node tools/secretary/ledger.mjs tree shared "Client/2026/Project"   (also: tree buffer, tree personal "…")
//   node tools/secretary/ledger.mjs organize-apply data/ledger/organize/plan-YYYYMMDD-HHmmss.json
//   node tools/secretary/ledger.mjs organize-undo [log.json]   (default: the latest run)
//
// Env overrides (tests only): PJM_LEDGER_ROOT, PJM_PERSONAL_ROOT, PJM_SHARED_ROOT, PJM_BUFFER_ROOT.

import {
  constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

const LEDGER = resolve(process.env.PJM_LEDGER_ROOT || 'data/ledger');
const PERSONAL_ROOT = resolve(
  process.env.PJM_PERSONAL_ROOT || 'C:/Users/SebastianoFilippetto/OneDrive - Archiva Group/Documents/PJM Management',
);
const ROOTS = {
  shared: resolve(process.env.PJM_SHARED_ROOT || 'C:/Users/SebastianoFilippetto/OneDrive - Archiva Group/DDM SOLUTIONS - Documenti/Delivery/Progetti Clienti'),
  personal: PERSONAL_ROOT,
  buffer: resolve(process.env.PJM_BUFFER_ROOT || join(PERSONAL_ROOT, '00 Da archiviare')),
};
const ARCHIVE_AFTER_DAYS = 30;
const TYPE_CODE = {
  decision: 'DEC', open_point: 'OPN', action: 'ACT', question: 'QST',
  waiting_on: 'WAI', technical: 'TEC', date: 'DAT', risk: 'RSK',
};
const REFERENCE_TYPES = new Set(['decision', 'technical']);
const PROJECT_RE = /^([A-Z][A-Z0-9]+-[0-9]+|_unassigned|_internal-[a-z0-9-]+)$/;
const ITEM_RE = /^(.+)-(DEC|OPN|ACT|QST|WAI|TEC|DAT|RSK)-(\d{3,})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[a-z0-9-]{1,90}$/;
const SOURCE_KINDS = ['mail', 'teams', 'meeting', 'sharepoint', 'confluence', 'jira', 'manual'];
const EVENT_KINDS = [
  'mail_in', 'mail_out', 'teams', 'item_opened', 'item_updated', 'item_closed', 'doc_change', 'note_updated',
  'proposal_created', 'proposal_applied', 'proposal_rejected', 'files_organized',
];
const MODES = ['ingest', 'recap', 'docwatch', 'apply', 'cleanup'];

// ---------- time ----------
const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:`
    + `${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}
const localDate = (d = new Date()) => isoLocal(d).slice(0, 10);
const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s);
const maxIso = (a, b) => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);
const hhmm = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayMonth = (iso) => { const d = new Date(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
function workingDaysBack(n) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  while (n > 0) { d.setDate(d.getDate() - 1); if (d.getDay() !== 0 && d.getDay() !== 6) n--; }
  return d;
}
function addDays(dateStr, n) { const d = new Date(`${dateStr}T12:00:00`); d.setDate(d.getDate() + n); return localDate(d); }

// ---------- helpers ----------
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '').map((k) => [k, o[k]]));
const OWA = 'https://outlook.office365.com/owa/?ItemID=';
const mailWebLink = (id) => `${OWA}${encodeURIComponent(id.replace(/_/g, '+'))}&exvsurl=1&viewmodel=ReadMessageItem`;
const sourceLink = (src) => src?.webLink || (src?.kind === 'mail' && src.ref ? mailWebLink(src.ref) : null);
const msgLink = (thread, msg) => msg?.webLink || (thread?.source === 'mail' && msg?.id ? mailWebLink(msg.id) : null);
function prefixOf(pid) {
  if (pid === '_unassigned') return 'UNASSIGNED';
  if (pid.startsWith('_internal-')) return `INT-${pid.slice(10).toUpperCase()}`;
  return pid;
}
function pidOfItem(id) {
  const m = ITEM_RE.exec(id || ''); if (!m) return null;
  if (m[1] === 'UNASSIGNED') return '_unassigned';
  if (m[1].startsWith('INT-')) return `_internal-${m[1].slice(4).toLowerCase()}`;
  return m[1];
}
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; out[k] = v; } else out._.push(argv[i]);
  }
  return out;
}

// ---------- io (cached, written only at the end) ----------
const cache = new Map();
const dirty = new Map();
function load(p, fallback) {
  if (cache.has(p)) return cache.get(p);
  let v;
  if (existsSync(p)) v = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  else if (fallback !== undefined) v = structuredClone(fallback);
  if (v !== undefined) cache.set(p, v);
  return v;
}
function touch(p, v) { cache.set(p, v); dirty.set(p, v); }
function flush() {
  for (const [p, v] of dirty) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, 'utf8'); }
  dirty.clear();
}
const listJson = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []);

const P = {
  state: join(LEDGER, 'state.json'),
  project: (id) => join(LEDGER, 'projects', `${id}.json`),
  archive: (id) => join(LEDGER, 'projects', 'archive', `${id}.json`),
  threads: join(LEDGER, 'threads'),
  thread: (pid, key) => join(LEDGER, 'threads', pid, `${key}.json`),
  docindex: join(LEDGER, 'docindex.json'),
  proposals: join(LEDGER, 'proposals'),
  events: (d) => join(LEDGER, 'events', `${d}.json`),
  recap: (d) => join(LEDGER, 'recaps', `${d}.json`),
  runs: join(LEDGER, 'runs'),
  processed: join(LEDGER, 'inbox', 'processed'),
  organize: join(LEDGER, 'organize'),
  organizeLogs: join(LEDGER, 'organize', 'logs'),
  rules: join(LEDGER, 'rules.json'),
};

const newProject = (id) => ({ schemaVersion: 1, projectId: id, name: id, nextSeq: 1, items: [], docChanges: [], updatedAt: isoLocal() });
const projectIds = () => listJson(join(LEDGER, 'projects')).map((f) => f.slice(0, -5));
function threadIndex() {
  const idx = new Map();
  if (!existsSync(P.threads)) return idx;
  for (const pid of readdirSync(P.threads)) for (const f of listJson(join(P.threads, pid))) idx.set(f.slice(0, -5), pid);
  return idx;
}
const lastMsg = (th) => th.messages.reduce((a, m) => (!a || Date.parse(m.at) > Date.parse(a.at) ? m : a), null);

// ---------- housekeeping shared by apply and migrate ----------
function housekeeping(pids, stats, now) {
  const today = localDate();
  const cutoff = Date.now() - ARCHIVE_AFTER_DAYS * 864e5;
  for (const pid of pids) {
    const pr = load(P.project(pid)); if (!pr) continue;
    let changed = false;
    for (const it of pr.items) {
      if (it.status === 'open' && REFERENCE_TYPES.has(it.type)) { it.status = 'reference'; changed = true; }
      if (it.type === 'date' && it.status === 'open' && it.eventDate && it.eventDate < today) {
        it.status = 'closed'; it.closedAt = now; it.closedReason = 'data passata'; stats.autoClosed++; changed = true;
      }
    }
    const old = (it) => it.status !== 'open' && Date.parse(it.lastUpdated) < cutoff && (!it.closedAt || Date.parse(it.closedAt) < cutoff);
    const moveItems = pr.items.filter(old);
    const moveDocs = (pr.docChanges || []).filter((d) => Date.parse(d.at) < cutoff);
    if (moveItems.length || moveDocs.length) {
      const ar = load(P.archive(pid), { schemaVersion: 1, projectId: pid, items: [], docChanges: [] });
      ar.items.push(...moveItems); ar.docChanges.push(...moveDocs);
      pr.items = pr.items.filter((it) => !old(it));
      pr.docChanges = (pr.docChanges || []).filter((d) => Date.parse(d.at) >= cutoff);
      touch(P.archive(pid), ar); stats.archived += moveItems.length; changed = true;
    }
    if (changed) { pr.updatedAt = now; touch(P.project(pid), pr); }
  }
}

// ---------- status ----------
function windowFrom(state) {
  const last = state.lastRun?.mail;
  const floor = Date.now() - 7 * 864e5;
  const from = last ? Date.parse(last) - 3600e3 : workingDaysBack(2).getTime();
  return isoLocal(new Date(Math.max(from, floor)));
}
function cmdStatus() {
  const st = load(P.state, { schemaVersion: 1, lastRun: {} });
  const lr = st.lastRun || {};
  console.log(`now: ${isoLocal()}`);
  console.log(`lastRun: mail=${lr.mail || '-'} teams=${lr.teams || '-'} docs=${lr.docs || '-'} recap=${lr.recap || '-'}`);
  console.log(`window: from ${windowFrom(st)} to now`);
  console.log(`docs window: from ${lr.docs || isoLocal(workingDaysBack(2))}`);
}

// ---------- context ----------
function itemLine(it) {
  const when = [it.eventDate && `il ${it.eventDate}`, it.due && `entro ${it.due}`].filter(Boolean).join(' ');
  const who = it.owner ? ` | owner ${it.owner}` : '';
  return `${it.id} | ${it.type}${when ? ` ${when}` : ''} | ${it.status}${who} | ${clip(it.text, 140)}`;
}
function cmdContext(args) {
  const days = Number(args.days) || 10;
  const since = Date.now() - days * 864e5;
  cmdStatus();
  const idx = threadIndex();
  const rows = [];
  for (const [key, pid] of idx) {
    const th = load(P.thread(pid, key)); const lm = th && lastMsg(th);
    if (!lm || Date.parse(lm.at) < since) continue;
    rows.push([Date.parse(lm.at), `${key} | ${pid} | ${th.source} | ultimo ${isoLocal(new Date(lm.at)).slice(0, 16)} ${lm.fromMe ? 'io' : 'loro'} | ${th.replyState} | ${clip(th.subject || th.counterpart || '', 70)}`]);
  }
  console.log(`\n# Thread recenti (${days} gg): ${rows.length}`);
  rows.sort((a, b) => b[0] - a[0]).forEach((r) => console.log(r[1]));
  let pids = args.projects && args.projects !== true ? String(args.projects).split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (args.all) pids = projectIds();
  if (!pids.length) { console.log('\n(nessun progetto richiesto: usa --projects ID,ID o --all)'); return; }
  for (const pid of pids) {
    const pr = load(P.project(pid));
    console.log(`\n## ${pid}${pr ? ` — ${pr.name}` : ' (nuovo)'}`);
    if (!pr) continue;
    const live = pr.items.filter((it) => it.status !== 'closed');
    if (!live.length) console.log('(nessun item aperto o di riferimento)');
    live.forEach((it) => console.log(itemLine(it)));
  }
}

// ---------- apply ----------
function cmdApply(file) {
  if (!file || !existsSync(file)) { console.error(`apply: file not found: ${file}`); process.exit(1); }
  const delta = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const errors = []; const err = (m) => errors.push(m);
  const now = isoLocal(); const today = localDate();
  if (delta.schemaVersion !== 1) err('schemaVersion must be 1');
  const run = delta.run || {};
  if (!MODES.includes(run.mode)) err(`run.mode must be one of ${MODES.join(', ')}`);
  const me = (run.me || []).map((s) => String(s).toLowerCase());
  const stats = { threads: 0, messages: 0, opened: 0, updated: 0, closed: 0, superseded: 0, proposals: 0, docChanges: 0, autoClosed: 0, archived: 0 };
  const byProject = {};
  const bump = (pid, k) => { (byProject[pid] ||= { thread: 0, aperti: 0, aggiornati: 0, chiusi: 0 })[k]++; };
  const events = [];
  const touchedProjects = new Set();
  const projectFor = (pid) => { touchedProjects.add(pid); return load(P.project(pid), newProject(pid)); };
  const saveProject = (pr) => { pr.updatedAt = now; touch(P.project(pr.projectId), pr); };
  const idx = threadIndex();
  const removals = [];

  // projects meta
  for (const [pid, meta] of Object.entries(delta.projects || {})) {
    if (!PROJECT_RE.test(pid)) { err(`projects.${pid}: invalid project id`); continue; }
    const pr = projectFor(pid);
    if (meta.name) pr.name = clip(meta.name, 120);
    if (meta.client) pr.client = clip(meta.client, 80);
    if (meta.summary) pr.summary = clip(meta.summary, 1200);
    saveProject(pr);
  }

  // threads
  const threadRef = (key) => {
    const pid = idx.get(key); if (!pid) return null;
    const path = P.thread(pid, key); const th = load(path);
    return th ? { th, path } : null;
  };
  (delta.threads || []).forEach((t, i) => {
    const w = `threads[${i}]`;
    if (!KEY_RE.test(t.threadKey || '')) return err(`${w}.threadKey invalid (a-z0-9-, max 90)`);
    if (!PROJECT_RE.test(t.projectId || '')) return err(`${w}.projectId invalid: ${t.projectId}`);
    if (!['mail', 'teams', 'meeting'].includes(t.source)) return err(`${w}.source must be mail|teams|meeting`);
    if (t.replyState && !['needs_reply', 'waiting', 'fyi', 'none'].includes(t.replyState)) return err(`${w}.replyState invalid`);
    if (t.urgency && !['high', 'normal', 'low'].includes(t.urgency)) return err(`${w}.urgency invalid`);
    const oldPid = idx.get(t.threadKey);
    const oldPath = oldPid ? P.thread(oldPid, t.threadKey) : null;
    const path = P.thread(t.projectId, t.threadKey);
    const th = (oldPath && load(oldPath)) || {
      schemaVersion: 1, threadKey: t.threadKey, source: t.source, projectId: t.projectId,
      assignment: { method: 'judgement', confidence: 'low' }, messages: [], summary: '', items: [], replyState: 'none',
    };
    if (oldPath && oldPath !== path) { removals.push(oldPath); cache.delete(oldPath); dirty.delete(oldPath); }
    Object.assign(th, pick(t, ['subject', 'chatId', 'language', 'replyState', 'urgency', 'counterpart']));
    if (t.summary) th.summary = clip(t.summary, 600);
    if (t.assignment) {
      if (!['rule', 'registry', 'judgement', 'manual'].includes(t.assignment.method) || !['high', 'medium', 'low'].includes(t.assignment.confidence)) err(`${w}.assignment invalid`);
      else th.assignment = pick(t.assignment, ['method', 'confidence', 'rule']);
    }
    for (const p of t.participants || []) {
      if (!p.name) continue;
      const k = (p.email || p.name).toLowerCase();
      if (!(th.participants ||= []).some((x) => (x.email || x.name).toLowerCase() === k)) th.participants.push(pick(p, ['name', 'email', 'org']));
    }
    const known = new Set(th.messages.map((m) => m.id));
    const fresh = [];
    (t.newMessages || []).forEach((m, j) => {
      if (!m.id || !isIso(m.at) || !m.from) return err(`${w}.newMessages[${j}] needs id, at (ISO), from`);
      if (known.has(m.id)) return;
      const msg = { id: m.id, at: m.at, from: m.from, fromMe: !!m.fromMe };
      if (m.webLink && t.source !== 'mail') msg.webLink = m.webLink;
      if (m.attachments?.length) msg.attachments = m.attachments.map((a) => clip(a, 120));
      th.messages.push(msg); fresh.push(msg); known.add(m.id);
    });
    th.messages.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    th.projectId = t.projectId; th.updatedAt = now;
    idx.set(t.threadKey, t.projectId);
    touch(path, th);
    stats.threads++; stats.messages += fresh.length; bump(t.projectId, 'thread'); touchedProjects.add(t.projectId);
    if (fresh.length) {
      const lm = fresh[fresh.length - 1];
      const kind = t.source === 'teams' ? 'teams' : lm.fromMe ? 'mail_out' : 'mail_in';
      const label = t.source === 'teams' ? `Teams – ${th.counterpart || th.subject || 'chat'}` : th.subject || th.threadKey;
      events.push({ at: lm.at, kind, projectId: t.projectId, ref: t.threadKey, text: clip(`${label}: ${th.summary}`, 300) });
      const pr = projectFor(t.projectId); pr.lastActivityAt = maxIso(pr.lastActivityAt, lm.at); saveProject(pr);
    }
  });

  // sources
  function resolveSource(src, w) {
    if (!src || typeof src !== 'object') { err(`${w}.source missing`); return null; }
    if (src.threadKey) {
      const ref = threadRef(src.threadKey);
      if (!ref) { err(`${w}.source: unknown thread ${src.threadKey}`); return null; }
      let msg;
      if (src.messageId) msg = ref.th.messages.find((m) => m.id === src.messageId);
      else if (src.at) { const ts = Date.parse(src.at); msg = ref.th.messages.find((m) => Date.parse(m.at) === ts); }
      else msg = lastMsg(ref.th);
      if (!msg) { err(`${w}.source: message not found in ${src.threadKey} (at ${src.at || '-'})`); return null; }
      const out = { kind: ref.th.source, threadKey: src.threadKey, ref: msg.id, at: msg.at, from: msg.from };
      if (msg.webLink) out.webLink = msg.webLink;
      return { source: out, thread: ref };
    }
    if (!SOURCE_KINDS.includes(src.kind) || !src.ref || !isIso(src.at)) { err(`${w}.source needs threadKey, or kind+ref+at`); return null; }
    return { source: pick(src, ['kind', 'ref', 'webLink', 'at', 'from']), thread: null };
  }
  const linkThread = (r, id) => { if (r.thread && !r.thread.th.items.includes(id)) { r.thread.th.items.push(id); touch(r.thread.path, r.thread.th); } };
  function findItem(id) {
    const pid = pidOfItem(id); if (!pid) return null;
    const pr = load(P.project(pid)); if (!pr) return null;
    let item = pr.items.find((x) => x.id === id);
    if (!item) {
      const ar = load(P.archive(pid)); const k = ar ? ar.items.findIndex((x) => x.id === id) : -1;
      if (k < 0) return null;
      [item] = ar.items.splice(k, 1); pr.items.push(item); touch(P.archive(pid), ar);
    }
    touchedProjects.add(pid);
    return { item, pid, pr };
  }
  const details = (d) => (d && typeof d === 'object' ? pick({
    system: d.system && clip(d.system, 80),
    objects: Array.isArray(d.objects) ? d.objects.map(String) : undefined,
    values: Array.isArray(d.values) ? d.values.map(String) : undefined,
  }, ['system', 'objects', 'values']) : undefined);

  // items
  const localRefs = new Map();
  (delta.items || []).forEach((op, i) => {
    const w = `items[${i}]`;
    for (const k of ['due', 'eventDate']) if (op[k] && !DATE_RE.test(op[k])) return err(`${w}.${k} must be YYYY-MM-DD`);
    if (op.text !== undefined && (!op.text || String(op.text).length > 500)) return err(`${w}.text empty or > 500 chars`);
    if (op.op === 'open') {
      if (!PROJECT_RE.test(op.projectId || '')) return err(`${w}.projectId invalid: ${op.projectId}`);
      if (!TYPE_CODE[op.type]) return err(`${w}.type invalid: ${op.type}`);
      if (!op.text) return err(`${w}.text missing`);
      const r = resolveSource(op.source, w); if (!r) return;
      const pr = projectFor(op.projectId);
      const id = `${prefixOf(op.projectId)}-${TYPE_CODE[op.type]}-${String(pr.nextSeq).padStart(3, '0')}`;
      pr.nextSeq++;
      const item = { id, type: op.type, text: String(op.text), ...pick(op, ['language', 'owner', 'counterpart', 'due', 'eventDate']) };
      const d = details(op.details); if (d && Object.keys(d).length) item.details = d;
      Object.assign(item, { status: REFERENCE_TYPES.has(op.type) ? 'reference' : 'open', firstSeen: r.source.at, lastUpdated: r.source.at, sources: [r.source] });
      pr.items.push(item); pr.lastActivityAt = maxIso(pr.lastActivityAt, r.source.at); saveProject(pr);
      linkThread(r, id);
      if (op.ref) localRefs.set(op.ref, id);
      stats.opened++; bump(op.projectId, 'aperti');
      events.push({ at: r.source.at, kind: 'item_opened', projectId: op.projectId, ref: id, text: clip(op.text, 300) });
      return;
    }
    if (!['update', 'close', 'supersede'].includes(op.op)) return err(`${w}.op must be open|update|close|supersede`);
    const id = localRefs.get(op.id) || op.id;
    const found = findItem(id); if (!found) return err(`${w}: unknown item ${op.id}`);
    const { item, pid, pr } = found;
    let r = null;
    if (op.source) { r = resolveSource(op.source, w); if (!r) return; item.sources.push(r.source); linkThread(r, id); }
    const at = r?.source.at || now;
    if (op.op === 'update') {
      Object.assign(item, pick(op, ['text', 'owner', 'counterpart', 'due', 'eventDate', 'language']));
      const d = details(op.details); if (d && Object.keys(d).length) item.details = d;
      if (op.reopen && item.status === 'closed') { item.status = REFERENCE_TYPES.has(item.type) ? 'reference' : 'open'; delete item.closedAt; delete item.closedReason; delete item.supersededBy; }
      stats.updated++; bump(pid, 'aggiornati');
      events.push({ at, kind: 'item_updated', projectId: pid, ref: id, text: clip(item.text, 300) });
    } else if (op.op === 'close') {
      item.status = 'closed'; item.closedAt = at; if (op.reason) item.closedReason = clip(op.reason, 200);
      stats.closed++; bump(pid, 'chiusi');
      events.push({ at, kind: 'item_closed', projectId: pid, ref: id, text: clip(item.text, 300) });
    } else {
      const by = localRefs.get(op.by) || op.by;
      if (!by || !ITEM_RE.test(by)) return err(`${w}.by must be an item id or the ref of an item opened earlier in this delta`);
      item.status = 'closed'; item.closedAt = at; item.supersededBy = by; item.closedReason = `sostituito da ${by}`;
      stats.superseded++; bump(pid, 'chiusi');
      events.push({ at, kind: 'item_closed', projectId: pid, ref: id, text: clip(`Sostituito da ${by}: ${item.text}`, 300) });
    }
    item.lastUpdated = maxIso(item.lastUpdated, at); saveProject(pr);
  });

  // document changes (only what changed since the last docs run)
  if (delta.docChanges?.length) {
    const di = load(P.docindex, { schemaVersion: 1, documents: {} });
    delta.docChanges.forEach((d, i) => {
      const w = `docChanges[${i}]`;
      if (!PROJECT_RE.test(d.projectId || '') || !['sharepoint', 'confluence'].includes(d.repository) || !d.name || !d.url || !isIso(d.modifiedAt)) return err(`${w} needs projectId, repository, name, url, modifiedAt`);
      const prev = di.documents[d.url];
      di.documents[d.url] = { projectId: d.projectId, name: d.name, modifiedAt: d.modifiedAt, ...pick(d, ['modifiedBy', 'version']) };
      if (prev && Date.parse(prev.modifiedAt) >= Date.parse(d.modifiedAt)) return;
      if (d.modifiedBy && me.some((x) => d.modifiedBy.toLowerCase().includes(x))) return;
      const change = d.change === 'new' && !prev ? 'new' : 'updated';
      const pr = projectFor(d.projectId);
      (pr.docChanges ||= []).push({ at: d.modifiedAt, repository: d.repository, name: d.name, url: d.url, change, ...pick(d, ['path', 'modifiedBy', 'version', 'note']) });
      saveProject(pr); stats.docChanges++;
      events.push({ at: d.modifiedAt, kind: 'doc_change', projectId: d.projectId, ref: d.url, text: clip(`${change === 'new' ? 'Nuovo' : 'Modificato'}: ${d.name}${d.modifiedBy ? ` (${d.modifiedBy})` : ''}`, 300) });
    });
    touch(P.docindex, di);
  }

  // proposals
  if (delta.proposals?.length) {
    const stamp = today.replace(/-/g, '');
    let seq = listJson(P.proposals).filter((f) => f.startsWith(`P-${stamp}-`)).map((f) => Number(f.slice(11, 14))).reduce((a, b) => Math.max(a, b), 0);
    delta.proposals.forEach((p, i) => {
      const w = `proposals[${i}]`;
      const t = p.target || {};
      if (!PROJECT_RE.test(p.projectId || '') || !['update', 'create'].includes(p.kind) || !['shared', 'personal'].includes(t.location) || !t.docType || !t.path) return err(`${w} needs projectId, kind, target.location/docType/path`);
      if (!Array.isArray(p.changes) || !p.changes.length) return err(`${w}.changes empty`);
      const ops = ['add_row', 'update_row', 'close_row', 'add_section', 'replace_section', 'new_document'];
      if (p.changes.some((c) => !ops.includes(c.op) || c.content === undefined)) return err(`${w}.changes: op or content invalid`);
      if (!p.rationale) return err(`${w}.rationale missing`);
      const sources = (p.sources || []).map((s, j) => resolveSource(s, `${w}.sources[${j}]`)).filter(Boolean).map((r) => r.source);
      if (!sources.length) return err(`${w}.sources empty`);
      const id = `P-${stamp}-${String(++seq).padStart(3, '0')}`;
      const changes = p.changes.map((c) => ({ ...pick(c, ['op', 'locator', 'content']), ...(c.itemIds ? { itemIds: c.itemIds.map((x) => localRefs.get(x) || x) } : {}) }));
      touch(join(P.proposals, `${id}.json`), {
        schemaVersion: 1, id, createdAt: now, projectId: p.projectId, kind: p.kind,
        target: pick(t, ['location', 'docType', 'path', 'webUrl', 'baseModifiedAt']), changes,
        rationale: clip(p.rationale, 300), ...(p.needsTemplate ? { needsTemplate: true } : {}), sources, status: 'pending',
      });
      stats.proposals++;
      events.push({ at: now, kind: 'proposal_created', projectId: p.projectId, ref: id, text: clip(`Proposta ${id}: ${p.rationale}`, 300) });
    });
  }
  (delta.proposalUpdates || []).forEach((u, i) => {
    const w = `proposalUpdates[${i}]`;
    const path = join(P.proposals, `${u.id}.json`); const p = load(path);
    if (!p) return err(`${w}: unknown proposal ${u.id}`);
    if (!['approved', 'rejected', 'applied', 'stale', 'pending'].includes(u.status)) return err(`${w}.status invalid`);
    p.status = u.status; p.decision = { at: now, ...(u.note ? { note: clip(u.note, 300) } : {}) };
    if (u.status === 'applied') { p.appliedAt = now; if (isIso(u.resultModifiedAt)) p.resultModifiedAt = u.resultModifiedAt; }
    if (u.target) Object.assign(p.target, pick(u.target, ['path', 'webUrl', 'baseModifiedAt']));
    if (u.changes) p.changes = u.changes;
    touch(path, p);
    if (u.status === 'applied' || u.status === 'rejected') events.push({ at: now, kind: u.status === 'applied' ? 'proposal_applied' : 'proposal_rejected', projectId: p.projectId, ref: u.id, text: clip(`Proposta ${u.id}: ${p.rationale}`, 300) });
  });

  // extra events (notes etc.)
  (delta.events || []).forEach((e, i) => {
    if (!EVENT_KINDS.includes(e.kind) || !PROJECT_RE.test(e.projectId || '') || !e.text) return err(`events[${i}] needs kind, projectId, text`);
    events.push({ at: isIso(e.at) ? e.at : now, kind: e.kind, projectId: e.projectId, ...(e.ref ? { ref: e.ref } : {}), text: clip(e.text, 300) });
  });

  // state
  const st = load(P.state, { schemaVersion: 1, lastRun: {} });
  for (const [k, v] of Object.entries(run.lastRun || {})) {
    if (!['mail', 'teams', 'docs', 'recap'].includes(k) || !isIso(v)) err(`run.lastRun.${k} invalid`);
    else (st.lastRun ||= {})[k] = v;
  }

  if (errors.length) {
    console.error(`DELTA NON APPLICATO (${errors.length} errori). Correggi il file e rilancia apply:`);
    errors.forEach((e) => console.error(` - ${e}`));
    process.exit(2);
  }
  touch(P.state, st);
  housekeeping(new Set([...projectIds(), ...touchedProjects]), stats, now);

  const ev = load(P.events(today), { schemaVersion: 1, date: today, events: [] });
  ev.events.push(...events); ev.events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  touch(P.events(today), ev);

  const lines = [
    `# Run ${run.mode} — ${now}`, '',
    run.window ? `Finestra: ${run.window.from} → ${run.window.to}` : null,
    run.sources ? `Fonti: ${Object.entries(run.sources).map(([k, v]) => `${k} ${v.seen ?? 0} visti / ${v.noise ?? 0} rumore`).join(' · ')}` : null,
    `Thread: ${stats.threads} (messaggi nuovi ${stats.messages}) · Item: +${stats.opened} aperti, ${stats.updated} aggiornati, ${stats.closed} chiusi, ${stats.superseded} sostituiti · Auto-chiusi ${stats.autoClosed} · Archiviati ${stats.archived}`,
    `Doc cambiati: ${stats.docChanges} · Proposte create: ${stats.proposals}`,
    '', '| Progetto | Thread | Aperti | Aggiornati | Chiusi |', '|---|---|---|---|---|',
    ...Object.entries(byProject).map(([pid, b]) => `| ${pid} | ${b.thread} | ${b.aperti} | ${b.aggiornati} | ${b.chiusi} |`),
    run.denied?.length ? `\nStrumenti negati: ${run.denied.join(', ')}` : null,
    ...(run.notes || []).map((n) => `- ${clip(n, 300)}`),
  ].filter((l) => l !== null);
  const report = lines.join('\n');
  flush();
  for (const p of removals) if (existsSync(p)) unlinkSync(p);
  mkdirSync(P.runs, { recursive: true });
  writeFileSync(join(P.runs, `${now.slice(0, 19).replace(/[:T]/g, (c) => (c === 'T' ? '_' : ''))}-${run.mode}.md`), `${report}\n`, 'utf8');
  mkdirSync(P.processed, { recursive: true });
  renameSync(file, join(P.processed, basename(file)));
  console.log(report);
}

// ---------- proposals ----------
function cmdProposals() {
  const list = listJson(P.proposals).map((f) => load(join(P.proposals, f))).filter((p) => ['pending', 'stale', 'approved'].includes(p.status));
  console.log(`# Proposte aperte: ${list.length}`);
  for (const p of list) console.log(`${p.id} | ${p.projectId} | ${p.status} | ${p.target.docType} | ${basename(p.target.path)} | ${p.changes.length} modifiche${p.needsTemplate ? ' | needsTemplate' : ''} | ${clip(p.rationale, 120)}`);
}

// ---------- recap ----------
function cmdRecapContext(date) {
  if (!DATE_RE.test(date || '')) { console.error('recap-context: date YYYY-MM-DD required'); process.exit(1); }
  const ev = load(P.events(date), { events: [] }).events;
  const horizon = addDays(date, 7);
  const idx = threadIndex();
  const threadsBy = {};
  for (const [key, pid] of idx) {
    const th = load(P.thread(pid, key));
    if (th && ['needs_reply', 'waiting'].includes(th.replyState)) (threadsBy[pid] ||= []).push(th);
  }
  const evBy = {}; for (const e of ev) (evBy[e.projectId] ||= []).push(e);
  const pids = [...new Set([...projectIds(), ...Object.keys(evBy)])].sort();
  console.log(`# Recap context ${date} — eventi del giorno: ${ev.length}`);
  const lr = load(P.state, { lastRun: {} }).lastRun || {};
  if (!lr.docs || !lr.docs.startsWith(date)) {
    console.log(`ATTENZIONE: docwatch non ancora eseguito oggi (ultimo: ${lr.docs || 'mai'}). Eseguilo (references/recap.md §1) e applica il delta PRIMA di scrivere il recap.`);
  }
  const ownerless = [];
  for (const pid of projectIds()) {
    const pr = load(P.project(pid));
    for (const it of pr?.items || []) if (it.status === 'open' && ['action', 'question'].includes(it.type) && !it.owner) ownerless.push(it);
  }
  if (ownerless.length) {
    console.log(`ATTENZIONE: ${ownerless.length} azioni/domande aperte senza owner (non compaiono in Aspetta me / Aspetto altri). Assegna l'owner con un delta 'update' prima del recap:`);
    ownerless.forEach((it) => console.log(`- ${itemLine(it)}`));
  }
  for (const pid of pids) {
    const pr = load(P.project(pid)) || newProject(pid);
    const open = pr.items.filter((it) => it.status === 'open');
    const mine = open.filter((it) => it.owner === 'me' && ['action', 'question', 'open_point'].includes(it.type));
    const others = open.filter((it) => it.type === 'waiting_on' || (it.type === 'question' && it.owner && it.owner !== 'me'));
    const dated = open.filter((it) => { const d = it.eventDate || it.due; return d && d <= horizon; });
    const thr = threadsBy[pid] || [];
    const evs = (evBy[pid] || []).filter((e) => !['mail_in', 'mail_out', 'teams'].includes(e.kind));
    if (!evs.length && !mine.length && !thr.length && !dated.length && !(evBy[pid] || []).length) continue;
    console.log(`\n## ${pid} — ${pr.name}`);
    if (evs.length) { console.log('Novità oggi:'); evs.forEach((e) => console.log(`- ${e.kind} ${e.ref || ''} | ${clip(e.text, 160)}`)); }
    const reply = thr.filter((t) => t.replyState === 'needs_reply');
    if (mine.length || reply.length) {
      console.log('Aspetta me:');
      mine.forEach((it) => console.log(`- ${itemLine(it)}`));
      reply.forEach((t) => { const lm = lastMsg(t); console.log(`- thread ${t.threadKey} | ${t.urgency || 'normal'} | da ${lm?.from} il ${lm ? dayMonth(lm.at) : '-'} | ${clip(t.subject || t.counterpart, 80)}`); });
    }
    const wait = thr.filter((t) => t.replyState === 'waiting');
    if (others.length || wait.length) {
      console.log('Aspetto altri:');
      others.forEach((it) => console.log(`- ${itemLine(it)}`));
      wait.forEach((t) => { const lm = lastMsg(t); console.log(`- thread ${t.threadKey} | ultimo ${lm ? dayMonth(lm.at) : '-'} | ${clip(t.subject || t.counterpart, 80)}`); });
    }
    if (dated.length) { console.log('Date entro 7 giorni / scadute:'); dated.forEach((it) => console.log(`- ${itemLine(it)}`)); }
  }
  const props = listJson(P.proposals).map((f) => load(join(P.proposals, f))).filter((p) => p.status === 'pending' || p.status === 'stale');
  console.log(`\n# Proposte in attesa: ${props.length}${props.length ? ` (${props.map((p) => p.id).join(', ')})` : ''}`);
  const un = (threadsBy._unassigned || []).concat([...idx].filter(([, pid]) => pid === '_unassigned').map(([k]) => load(P.thread('_unassigned', k))).filter((t) => t && t.updatedAt?.startsWith(date)));
  const seen = new Set();
  console.log('# Da smistare (thread _unassigned aggiornati oggi o in attesa):');
  un.forEach((t) => { if (!seen.has(t.threadKey)) { seen.add(t.threadKey); console.log(`- ${t.threadKey} | ${clip(t.subject || t.counterpart, 80)}`); } });
}

const HEAD = {
  it: { title: 'Riepilogo', changedToday: 'Cosa è cambiato oggi', waitingOnMe: 'Aspetta me', waitingOnOthers: 'Aspetto altri', documentation: 'Documentazione', jira: 'Jira', tomorrow: 'Domani', unassigned: 'Da smistare', proposals: 'Proposte in attesa', review: 'scrivi *proposte* per rivederle', notes: 'Note', source: 'fonte' },
  en: { title: 'Daily recap', changedToday: 'What changed today', waitingOnMe: 'Waiting on me', waitingOnOthers: 'Waiting on others', documentation: 'Documentation', jira: 'Jira', tomorrow: 'Tomorrow', unassigned: 'To sort', proposals: 'Pending proposals', review: 'type *proposte* to review them', notes: 'Notes', source: 'source' },
  fr: { title: 'Récapitulatif', changedToday: 'Ce qui a changé aujourd’hui', waitingOnMe: 'En attente de moi', waitingOnOthers: 'En attente des autres', documentation: 'Documentation', jira: 'Jira', tomorrow: 'Demain', unassigned: 'À trier', proposals: 'Propositions en attente', review: 'écris *proposte* pour les revoir', notes: 'Notes', source: 'source' },
};
function backupIfExists(p) {
  if (!existsSync(p)) return null;
  const d = new Date();
  const stamp = `${localDate(d)}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const ext = extname(p); const name = basename(p, ext); const od = join(dirname(p), 'old');
  mkdirSync(od, { recursive: true });
  let dest = join(od, `${name}_${stamp}${ext}`);
  if (existsSync(dest)) dest = join(od, `${name}_${stamp}${pad(d.getSeconds())}${ext}`);
  copyFileSync(p, dest, constants.COPYFILE_EXCL);
  return dest;
}
function cmdRecapRender(date) {
  if (!DATE_RE.test(date || '')) { console.error('recap-render: date YYYY-MM-DD required'); process.exit(1); }
  const rc = load(P.recap(date));
  if (!rc) { console.error(`recap-render: ${P.recap(date)} not found`); process.exit(1); }
  const h = HEAD[rc.language] || HEAD.it;
  const idx = threadIndex();
  const link = (l) => {
    if (l.link) return l.link;
    if (l.itemId) { const pid = pidOfItem(l.itemId); const pr = pid && load(P.project(pid)); const it = pr?.items.find((x) => x.id === l.itemId); if (it) return sourceLink(it.sources[it.sources.length - 1]); }
    if (l.threadKey && idx.has(l.threadKey)) { const th = load(P.thread(idx.get(l.threadKey), l.threadKey)); return msgLink(th, lastMsg(th)); }
    return null;
  };
  const line = (l) => { const u = link(l); return `- ${l.urgency === 'high' ? '**!** ' : ''}${l.text}${u ? ` ([${h.source}](${u}))` : ''}`; };
  const out = [`# ${h.title} ${date}`, ''];
  for (const p of rc.projects || []) {
    const parts = [['changedToday', p.changedToday], ['waitingOnMe', p.waitingOnMe], ['waitingOnOthers', p.waitingOnOthers], ['documentation', p.documentation], ['jira', p.jira]].filter(([, v]) => v?.length);
    if (!parts.length) continue;
    out.push(`## ${p.name} (${p.projectId})`, '');
    for (const [k, v] of parts) out.push(`**${h[k]}**`, ...v.map(line), '');
  }
  if (rc.tomorrow?.length) out.push(`## ${h.tomorrow}`, '', ...rc.tomorrow.map((m) => `- ${hhmm(m.start)}${m.end ? `–${hhmm(m.end)}` : ''} ${m.subject}${m.projectId ? ` (${m.projectId})` : ''}`), '');
  if (rc.unassigned?.length) out.push(`## ${h.unassigned}`, '', ...rc.unassigned.map((u) => `- ${u}`), '');
  out.push(`## ${h.proposals}`, '', `${rc.pendingProposals ?? 0}${rc.pendingProposals ? ` — ${h.review}` : ''}`, '');
  if (rc.notes?.length) out.push(`## ${h.notes}`, '', ...rc.notes.map((n) => `- ${n}`), '');
  const target = join(PERSONAL_ROOT, 'Recap', date.slice(0, 4), `Recap_${date}.md`);
  mkdirSync(dirname(target), { recursive: true });
  const bak = backupIfExists(target);
  writeFileSync(target, out.join('\n'), 'utf8');
  console.log(target);
  if (bak) console.log(`backup: ${bak}`);
}

// ---------- migrate (one-off, safe to re-run) ----------
function cmdMigrate() {
  const stats = { autoClosed: 0, archived: 0 };
  let ref = 0;
  for (const pid of projectIds()) {
    const pr = load(P.project(pid));
    for (const it of pr.items) if (it.status === 'open' && REFERENCE_TYPES.has(it.type)) ref++;
  }
  housekeeping(projectIds(), stats, isoLocal());
  flush();
  console.log(`migrate: ${ref} decisioni/tecnici → reference, ${stats.autoClosed} date passate chiuse, ${stats.archived} item archiviati`);
}

// ---------- organize: folder listing, approved plans, undo ----------
const IGNORE_FILES = /^(desktop\.ini|thumbs\.db|\.ds_store)$/i;
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function parseLoc(s, w, err) {
  const m = /^(shared|personal|buffer):(.*)$/.exec(String(s || ''));
  if (!m) { err(`${w}: path must start with shared:, personal: or buffer:`); return null; }
  const root = ROOTS[m[1]];
  const abs = resolve(root, m[2].replace(/^[\\/]+/, ''));
  if (abs !== root && !abs.toLowerCase().startsWith(root.toLowerCase() + sep)) { err(`${w}: ${s} is outside the ${m[1]} root`); return null; }
  return { root: m[1], rel: m[2], abs };
}
function stem(name) {
  const ext = extname(name).toLowerCase();
  let s = basename(name, extname(name)).toLowerCase();
  s = s.replace(/^(copia di|copy of)\s+/, '').replace(/\s*-\s*(copia|copy)(\s*\(\d+\))?$/, '').replace(/\s*\(\d+\)$/, '')
    .replace(/[_\s-]*(v|ver|rev)\.?\s*\d+(\.\d+)*/g, '').replace(/[_\s-]*(final|finale|def|definitivo|draft|bozza)\b/g, '')
    .replace(/[_\s-]*\d{4}[-_.]?\d{2}[-_.]?\d{2}/g, '').replace(/[_\s-]*\d{2}[-_.]\d{2}[-_.]\d{4}/g, '').replace(/[\s_-]+/g, ' ').trim();
  return `${s}${ext}`;
}
function walk(dir, base, out, depth) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_FILES.test(name)) continue;
    const abs = join(dir, name);
    let st; try { st = statSync(abs); } catch { continue; }
    const rel = base ? `${base}/${name}` : name;
    if (st.isDirectory()) {
      if (name.toLowerCase() === 'old') { out.push({ rel, dir: true, old: true, count: readdirSync(abs).length }); continue; }
      out.push({ rel, dir: true });
      if (depth > 0) walk(abs, rel, out, depth - 1);
    } else out.push({ rel, size: st.size, mtime: st.mtime, lock: name.startsWith('~$') });
  }
  return out;
}
function folderTemplate() {
  const r = load(P.rules, {});
  return Object.keys(r.folderTemplate || {});
}
function cmdTree(args) {
  const [, rootName, relPath = ''] = args._;
  const errs = []; const loc = parseLoc(`${rootName}:${relPath}`, 'tree', (e) => errs.push(e));
  if (!loc) { console.error(errs.join('\n')); process.exit(1); }
  if (!existsSync(loc.abs)) { console.error(`tree: not found: ${loc.abs}`); process.exit(1); }
  const entries = walk(loc.abs, '', [], Number(args.depth) || 6);
  const files = entries.filter((e) => !e.dir && !e.lock);
  const locks = entries.filter((e) => e.lock).map((e) => e.rel.replace(/~\$/, ''));
  const total = files.reduce((a, f) => a + f.size, 0);
  console.log(`# ${rootName}:${relPath || '.'} — ${files.length} file, ${kb(total)}`);
  const tpl = folderTemplate();
  if (rootName === 'shared' && tpl.length && relPath.split('/').filter(Boolean).length >= 3) {
    const top = entries.filter((e) => e.dir && !e.rel.includes('/')).map((e) => e.rel);
    const missing = tpl.filter((x) => !top.includes(x));
    const extra = top.filter((x) => !tpl.includes(x) && x.toLowerCase() !== 'old');
    if (missing.length) console.log(`Sottocartelle standard mancanti: ${missing.join(' | ')}`);
    if (extra.length) console.log(`Sottocartelle non standard: ${extra.join(' | ')}`);
    const loose = files.filter((f) => !f.rel.includes('/'));
    if (loose.length) console.log(`File nella radice del progetto: ${loose.length}`);
  }
  if (locks.length) console.log(`Aperti da qualcuno adesso (file di lock ~$): ${locks.join(' | ')}`);
  const today = localDate();
  const recent = files.filter((f) => localDate(f.mtime) === today);
  if (recent.length) console.log(`Modificati oggi (non spostare): ${recent.map((f) => f.rel).join(' | ')}`);
  const groups = {};
  for (const f of files) { const k = `${dirname(f.rel)}|${stem(basename(f.rel))}`; (groups[k] ||= []).push(f); }
  const dups = Object.values(groups).filter((g) => g.length > 1);
  if (dups.length) {
    console.log('Possibili versioni/duplicati (stessa cartella):');
    dups.forEach((g) => console.log(`- ${g.sort((a, b) => b.mtime - a.mtime).map((f) => `${f.rel} (${localDate(f.mtime)})`).join('  >  ')}`));
  }
  console.log('');
  for (const e of entries) {
    if (e.lock) continue;
    const depth = e.rel.split('/').length - 1;
    const pad2 = '  '.repeat(depth);
    if (e.dir) console.log(`${pad2}${basename(e.rel)}/${e.old ? ` (old: ${e.count} elementi, non toccare)` : ''}`);
    else console.log(`${pad2}${basename(e.rel)} | ${kb(e.size)} | ${localDate(e.mtime)}`);
  }
}
function cmdOrganizeApply(file) {
  if (!file || !existsSync(file)) { console.error(`organize-apply: file not found: ${file}`); process.exit(1); }
  const plan = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const errors = []; const err = (m) => errors.push(m);
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.ops) || !plan.ops.length) err('plan needs schemaVersion 1 and a non-empty ops array');
  const planned = new Set(); const steps = [];
  (plan.ops || []).forEach((op, i) => {
    const w = `ops[${i}]`;
    if (!op.reason) err(`${w}.reason missing`);
    if (op.op === 'mkdir') {
      const d = parseLoc(op.path, w, err); if (!d) return;
      if (existsSync(d.abs)) return; // nothing to do
      steps.push({ op: 'mkdir', to: d.abs, reason: op.reason, projectId: op.projectId }); planned.add(d.abs.toLowerCase()); return;
    }
    if (!['move', 'archive'].includes(op.op)) return err(`${w}.op must be move | archive | mkdir`);
    const src = parseLoc(op.from || op.path, w, err); if (!src) return;
    if (!existsSync(src.abs) || !statSync(src.abs).isFile()) return err(`${w}: source file not found: ${op.from || op.path}`);
    if (src.abs.toLowerCase().split(sep).includes('old')) return err(`${w}: files inside an "old" folder are never moved`);
    if (existsSync(join(dirname(src.abs), `~$${basename(src.abs).slice(2)}`)) || existsSync(join(dirname(src.abs), `~$${basename(src.abs)}`))) return err(`${w}: ${basename(src.abs)} is open right now (lock file present)`);
    if (localDate(statSync(src.abs).mtime) === localDate()) return err(`${w}: ${basename(src.abs)} was modified today, leave it for now`);
    let dest;
    if (op.op === 'archive') {
      const ext = extname(src.abs); const d = localDate(statSync(src.abs).mtime);
      dest = join(dirname(src.abs), 'old', `${basename(src.abs, ext)}_${d}${ext}`);
      if (existsSync(dest)) { const n = new Date(); dest = join(dirname(src.abs), 'old', `${basename(src.abs, ext)}_${d}_${pad(n.getHours())}${pad(n.getMinutes())}${ext}`); }
    } else {
      const to = parseLoc(op.to, w, err); if (!to) return;
      const isDir = /[\\/]$/.test(op.to) || (existsSync(to.abs) && statSync(to.abs).isDirectory());
      dest = isDir ? join(to.abs, basename(src.abs)) : to.abs;
    }
    if (existsSync(dest) || planned.has(dest.toLowerCase())) return err(`${w}: destination already exists: ${dest}`);
    planned.add(dest.toLowerCase());
    steps.push({ op: op.op, from: src.abs, to: dest, reason: op.reason, projectId: op.projectId });
  });
  if (errors.length) {
    console.error(`PIANO NON ESEGUITO (${errors.length} errori), nessun file toccato:`);
    errors.forEach((e) => console.error(` - ${e}`));
    process.exit(2);
  }
  const now = isoLocal(); const done = [];
  let failure = null;
  for (const s of steps) {
    try {
      if (s.op === 'mkdir') mkdirSync(s.to, { recursive: true });
      else { mkdirSync(dirname(s.to), { recursive: true }); renameSync(s.from, s.to); }
      done.push(s);
    } catch (e) { failure = `${s.op} ${s.from || ''} → ${s.to}: ${e.message}`; break; }
  }
  mkdirSync(P.organizeLogs, { recursive: true });
  const logPath = join(P.organizeLogs, `${now.slice(0, 19).replace(/[:T]/g, (c) => (c === 'T' ? '_' : ''))}.json`);
  writeFileSync(logPath, `${JSON.stringify({ schemaVersion: 1, at: now, plan: basename(file), executed: done, failure }, null, 2)}\n`, 'utf8');
  const byP = {};
  for (const s of done) if (s.op !== 'mkdir') { const k = s.projectId && PROJECT_RE.test(s.projectId) ? s.projectId : '_unassigned'; byP[k] = (byP[k] || 0) + 1; }
  if (Object.keys(byP).length) {
    const today = localDate();
    const ev = load(P.events(today), { schemaVersion: 1, date: today, events: [] });
    for (const [pid, n] of Object.entries(byP)) ev.events.push({ at: now, kind: 'files_organized', projectId: pid, ref: basename(logPath), text: `Riorganizzati ${n} file` });
    touch(P.events(today), ev); flush();
  }
  mkdirSync(join(P.organize, 'processed'), { recursive: true });
  renameSync(file, join(P.organize, 'processed', basename(file)));
  const rel = (a) => { for (const [k, r] of Object.entries(ROOTS)) if (a.toLowerCase().startsWith(r.toLowerCase() + sep)) return `${k}:${relative(r, a).split(sep).join('/')}`; return a; };
  console.log(`Eseguite ${done.length}/${steps.length} operazioni. Log: ${logPath}`);
  done.forEach((s) => console.log(`- ${s.op}: ${s.from ? `${rel(s.from)} → ` : ''}${rel(s.to)}`));
  if (failure) { console.log(`INTERROTTO: ${failure}. Le operazioni eseguite si annullano con organize-undo.`); process.exit(3); }
}
function cmdOrganizeUndo(file) {
  let logPath = file;
  if (!logPath) {
    const logs = listJson(P.organizeLogs).filter((f) => !JSON.parse(readFileSync(join(P.organizeLogs, f), 'utf8')).undoneAt).sort();
    if (!logs.length) { console.error('organize-undo: no runs left to undo'); process.exit(1); }
    logPath = join(P.organizeLogs, logs[logs.length - 1]);
  }
  const log = JSON.parse(readFileSync(logPath, 'utf8'));
  if (!Array.isArray(log.executed)) { console.error(`organize-undo: ${basename(logPath)} is not an organize log`); process.exit(1); }
  if (log.undoneAt) { console.error(`organize-undo: ${basename(logPath)} already undone at ${log.undoneAt}`); process.exit(1); }
  const problems = []; let n = 0;
  for (const s of [...log.executed].reverse()) {
    if (s.op === 'mkdir') continue;
    if (!existsSync(s.to)) { problems.push(`missing now: ${s.to}`); continue; }
    if (existsSync(s.from)) { problems.push(`original place occupied: ${s.from}`); continue; }
    mkdirSync(dirname(s.from), { recursive: true }); renameSync(s.to, s.from); n++;
  }
  log.undoneAt = isoLocal(); writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  console.log(`Annullate ${n} operazioni di ${basename(logPath)} (le cartelle create restano).`);
  problems.forEach((p) => console.log(`- non annullato: ${p}`));
}

// ---------- main ----------
const args = parseArgs(process.argv.slice(2));
const [cmd, arg] = args._;
switch (cmd) {
  case 'status': cmdStatus(); break;
  case 'context': cmdContext(args); break;
  case 'apply': cmdApply(arg); break;
  case 'proposals': cmdProposals(); break;
  case 'recap-context': cmdRecapContext(arg); break;
  case 'recap-render': cmdRecapRender(arg); break;
  case 'migrate': cmdMigrate(); break;
  case 'tree': cmdTree(args); break;
  case 'organize-apply': cmdOrganizeApply(arg); break;
  case 'organize-undo': cmdOrganizeUndo(arg); break;
  default:
    console.error('usage: ledger.mjs status | context [--projects A,B] [--all] [--days N] | apply <delta.json> | proposals | recap-context <date> | recap-render <date> | migrate | tree <shared|personal|buffer> [path] | organize-apply <plan.json> | organize-undo [log.json]');
    process.exit(1);
}

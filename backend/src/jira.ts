import type { DatabaseSync } from 'node:sqlite';
import { dayPlan } from './today.ts';

/**
 * Jira work log. Hours are written through **Tempo** (api.tempo.io, personal Tempo API token) when a Tempo token is
 * saved — exactly like Tempo's "Registra ore" dialog — otherwise straight to Jira. The Jira API token (Atlassian
 * e-mail + token) is always needed: it identifies me (accountId) and turns issue keys into the numeric ids Tempo wants.
 * Tokens are kept only in the local database (data/, git-ignored) and never returned by the API.
 */
const DEFAULT_SITE = 'https://archivagroup.atlassian.net';
const DEFAULT_TEMPO = 'https://api.tempo.io/4';

interface Settings {
  site: string; email: string | null; token: string | null; accountId: string | null; displayName: string | null;
  tempoBase: string; tempoToken: string | null; tempoOk: boolean;
}
type HttpError = Error & { status?: number };

const get = (db: DatabaseSync, key: string) =>
  (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
const put = (db: DatabaseSync, key: string, value: string | null) => value === null
  ? db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
  : db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

function settings(db: DatabaseSync): Settings {
  return {
    site: (get(db, 'jira.site') ?? DEFAULT_SITE).replace(/\/+$/, ''),
    email: get(db, 'jira.email'), token: get(db, 'jira.token'),
    accountId: get(db, 'jira.accountId'), displayName: get(db, 'jira.displayName'),
    tempoBase: (get(db, 'tempo.base') ?? DEFAULT_TEMPO).replace(/\/+$/, ''),
    tempoToken: get(db, 'tempo.token'), tempoOk: get(db, 'tempo.ok') === '1',
  };
}

const jiraReady = (s: Settings) => !!(s.token && s.accountId);
const tempoReady = (s: Settings) => jiraReady(s) && !!s.tempoToken && s.tempoOk;

/** What the UI may see (never the tokens). */
export function jiraStatus(db: DatabaseSync) {
  const s = settings(db);
  return {
    site: s.site, email: s.email, hasToken: !!s.token, connected: jiraReady(s), displayName: s.displayName,
    hasTempoToken: !!s.tempoToken, tempoConnected: tempoReady(s),
  };
}

function errorText(text: string) {
  try {
    const j = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> | { message?: string }[] };
    const list = [
      ...(j.errorMessages ?? []),
      ...(Array.isArray(j.errors) ? j.errors.map((e) => e?.message) : Object.values(j.errors ?? {})),
    ].filter((m): m is string => typeof m === 'string' && !!m);
    if (list.length) return list.join('; ');
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300);
}

async function request<T>(url: string, auth: string, who: 'Jira' | 'Tempo', init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { authorization: auth, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err: HttpError = new Error(res.status === 401
      ? (who === 'Jira' ? 'Jira rejected the e-mail / API token (401)' : 'Tempo rejected the API token (401)')
      : `${who} ${res.status}: ${errorText(text)}`);
    err.status = 502;
    throw err;
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

function jira<T>(s: Settings, path: string, init?: { method?: string; body?: unknown }) {
  if (!s.email || !s.token) throw Object.assign(new Error('Jira API token not set (Settings → Jira)'), { status: 400 });
  return request<T>(`${s.site}${path}`, `Basic ${Buffer.from(`${s.email}:${s.token}`).toString('base64')}`, 'Jira', init);
}

function tempo<T>(s: Settings, path: string, init?: { method?: string; body?: unknown }) {
  if (!s.tempoToken) throw Object.assign(new Error('Tempo API token not set (Settings → Jira)'), { status: 400 });
  return request<T>(`${s.tempoBase}${path}`, `Bearer ${s.tempoToken}`, 'Tempo', init);
}

/** My Tempo work logs of a day. */
const tempoDay = (s: Settings, date: string) =>
  tempo<{ results: { issue: { id: number }; timeSpentSeconds: number }[] }>(
    s, `/worklogs/user/${encodeURIComponent(s.accountId!)}?from=${date}&to=${date}&limit=1000`);

/**
 * Saves e-mail / tokens and checks them: Jira with /myself, Tempo by reading my work logs of today.
 * `{ clear: true }` removes both tokens, `{ clearTempo: true }` only the Tempo one.
 */
export async function saveJiraSettings(db: DatabaseSync,
  b: { site?: string; email?: string; token?: string; tempoToken?: string; tempoBase?: string; clear?: boolean; clearTempo?: boolean }) {
  if (b.clear || b.clearTempo) {
    const keys = b.clear ? ['jira.token', 'jira.accountId', 'jira.displayName', 'tempo.token', 'tempo.ok'] : ['tempo.token', 'tempo.ok'];
    for (const k of keys) put(db, k, null);
    return jiraStatus(db);
  }
  if (b.site?.trim()) put(db, 'jira.site', b.site.trim().replace(/\/+$/, ''));
  if (b.email?.trim()) put(db, 'jira.email', b.email.trim());
  if (b.token?.trim()) put(db, 'jira.token', b.token.trim());
  if (b.tempoBase?.trim()) put(db, 'tempo.base', b.tempoBase.trim().replace(/\/+$/, ''));
  if (b.tempoToken?.trim()) {
    put(db, 'tempo.token', b.tempoToken.trim());
    put(db, 'tempo.ok', null);
  }
  const me = await jira<{ accountId: string; displayName: string }>(settings(db), '/rest/api/3/myself');
  put(db, 'jira.accountId', me.accountId);
  put(db, 'jira.displayName', me.displayName);
  const s = settings(db);
  if (s.tempoToken) {
    try {
      await tempoDay(s, new Date().toLocaleDateString('sv-SE'));
      put(db, 'tempo.ok', '1');
    } catch (err) {
      put(db, 'tempo.ok', null);
      throw err;
    }
  }
  return jiraStatus(db);
}

// ---------- helpers ----------

const round = (h: number) => Math.round(h * 4) / 4;
const hours = (sec: number) => Math.round((sec / 3600) * 100) / 100;

/** Numeric id and remaining estimate (seconds) of issues, by key. */
async function issueInfo(s: Settings, keys: string[]) {
  const out = new Map<string, { id: string; remaining: number | null }>();
  for (let i = 0; i < keys.length; i += 50) {
    const jql = encodeURIComponent(`key in (${keys.slice(i, i + 50).join(',')})`);
    const r = await jira<{ issues: { id: string; key: string; fields?: { timetracking?: { remainingEstimateSeconds?: number } } }[] }>(
      s, `/rest/api/3/search/jql?jql=${jql}&fields=timetracking&maxResults=100`);
    for (const it of r.issues) out.set(it.key, { id: String(it.id), remaining: it.fields?.timetracking?.remainingEstimateSeconds ?? null });
  }
  return out;
}

/** Local midnight → next midnight of a day, as epoch ms (Jira's startedAfter / startedBefore). */
function dayRange(date: string) {
  const from = new Date(`${date}T00:00:00`);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from: from.getTime(), to: to.getTime() };
}

/** "2026-11-18T09:00:00.000+0100" in local time, as Jira wants it. */
function started(date: string) {
  const d = new Date(`${date}T09:00:00`);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  return `${date}T09:00:00.000${sign}${hh}${mm}`;
}

/** Jira-only mode: hours I logged on an issue that day (logs made in Tempo are invisible here). */
async function jiraLoggedOn(s: Settings, key: string, date: string): Promise<number> {
  const { from, to } = dayRange(date);
  const r = await jira<{ worklogs: { author?: { accountId?: string }; timeSpentSeconds: number }[] }>(
    s, `/rest/api/3/issue/${encodeURIComponent(key)}/worklog?startedAfter=${from}&startedBefore=${to}&maxResults=100`);
  return hours(r.worklogs.filter((w) => w.author?.accountId === s.accountId).reduce((n, w) => n + w.timeSpentSeconds, 0));
}

// ---------- proposal ----------

/**
 * The day's Jira activities with a proposal: the hours planned for the day on each issue, net of what is already
 * logged on that issue that day (so nothing is logged twice).
 * With Tempo, "already logged" covers everything in my Tempo timesheet for the day.
 */
export async function worklogProposal(db: DatabaseSync, date: string) {
  const plan = dayPlan(db, date);
  const s = settings(db);
  const via: 'tempo' | 'jira' | null = tempoReady(s) ? 'tempo' : jiraReady(s) ? 'jira' : null;
  const items = plan.activities.filter((a) => a.source === 'jira');
  const logged = new Map<string, number>();
  let loggedDay: number | null = null;
  let warning: string | null = null;

  try {
    if (via === 'tempo') {
      const [day, info] = await Promise.all([
        tempoDay(s, date),
        items.length ? issueInfo(s, items.map((a) => a.id)) : Promise.resolve(new Map<string, { id: string; remaining: number | null }>()),
      ]);
      const byId = new Map<string, number>();
      for (const w of day.results) byId.set(String(w.issue.id), (byId.get(String(w.issue.id)) ?? 0) + w.timeSpentSeconds);
      loggedDay = hours(day.results.reduce((n, w) => n + w.timeSpentSeconds, 0));
      for (const a of items) {
        const id = info.get(a.id)?.id;
        logged.set(a.id, id ? hours(byId.get(id) ?? 0) : 0);
      }
    } else if (via === 'jira') {
      await Promise.all(items.map(async (a) => logged.set(a.id, await jiraLoggedOn(s, a.id, date))));
      loggedDay = hours([...logged.values()].reduce((n, h) => n + h * 3600, 0));
    }
  } catch (err) {
    warning = (err as Error).message;
    logged.clear();
    loggedDay = null;
  }

  const available = Math.max(0, plan.capacityHours - plan.meetingHours);

  return {
    date, connected: via !== null, via, warning, loggedDayHours: loggedDay,
    capacityHours: plan.capacityHours, meetingHours: plan.meetingHours, availableHours: available,
    items: items.map((a) => {
      const already = logged.get(a.id);
      return {
        key: a.id, title: a.phaseName ?? a.title, project: a.epicSummary ?? a.projectName, url: a.url,
        plannedHours: a.hoursToday, remainingHours: a.remainingHours, loggedHours: already ?? null,
        proposedHours: Math.max(0, round((a.hoursToday ?? 0) - (already ?? 0))), overdue: a.overdue,
      };
    }),
  };
}

// ---------- logging ----------

/** Writes the work logs, one per issue (through Tempo when connected); returns the outcome of each. */
export async function logWork(db: DatabaseSync, date: string, entries: { key: string; hours: number; comment?: string }[]) {
  const s = settings(db);
  const viaTempo = tempoReady(s);
  if (!viaTempo && !jiraReady(s)) throw Object.assign(new Error('Jira API token not set (Settings → Jira)'), { status: 400 });
  const info = viaTempo ? await issueInfo(s, entries.map((e) => e.key)) : null;

  const results: { key: string; hours: number; ok: boolean; error?: string; worklogId?: string }[] = [];
  const ins = db.prepare(`INSERT INTO worklog_entries (issue_key, work_date, seconds, comment, jira_worklog_id, ok, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const lower = db.prepare(`UPDATE deadlines SET remaining_hours = MAX(0, remaining_hours - ?), updated_at = datetime('now')
    WHERE id = ? AND remaining_hours IS NOT NULL`);

  for (const e of entries) {
    const seconds = Math.round(e.hours * 3600);
    if (!(seconds > 0)) continue;
    const comment = e.comment?.trim() || null;
    try {
      let id: string | undefined;
      if (viaTempo) {
        const issue = info!.get(e.key);
        if (!issue) throw new Error(`${e.key} not found in Jira`);
        // as in Tempo's dialog, the remaining estimate goes down by the time spent
        const w = await tempo<{ tempoWorklogId: number }>(s, '/worklogs', {
          method: 'POST',
          body: {
            issueId: Number(issue.id), authorAccountId: s.accountId, startDate: date, startTime: '09:00:00',
            timeSpentSeconds: seconds, description: comment ?? `Working on issue ${e.key}`,
            ...(issue.remaining !== null ? { remainingEstimateSeconds: Math.max(0, issue.remaining - seconds) } : {}),
          },
        });
        id = `tempo:${w?.tempoWorklogId}`;
        if (issue.remaining !== null) issue.remaining = Math.max(0, issue.remaining - seconds);
      } else {
        const w = await jira<{ id: string }>(s, `/rest/api/3/issue/${encodeURIComponent(e.key)}/worklog?adjustEstimate=auto`, {
          method: 'POST',
          body: {
            timeSpentSeconds: seconds, started: started(date),
            ...(comment ? { comment: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }] } } : {}),
          },
        });
        id = w?.id;
      }
      ins.run(e.key, date, seconds, comment, id ?? null, 1, null);
      lower.run(e.hours, e.key); // the dashboard follows right away; the next sync brings Jira's exact figure
      results.push({ key: e.key, hours: e.hours, ok: true, worklogId: id });
    } catch (err) {
      ins.run(e.key, date, seconds, comment, null, 0, (err as Error).message);
      results.push({ key: e.key, hours: e.hours, ok: false, error: (err as Error).message });
    }
  }
  return { date, via: viaTempo ? 'tempo' : 'jira', results, loggedHours: results.filter((r) => r.ok).reduce((n, r) => n + r.hours, 0) };
}

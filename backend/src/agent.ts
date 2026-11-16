import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { isoToday } from './flags.ts';
import { toApi, toApiList } from './util.ts';

/**
 * "Sync now": runs the pjm-sync skill through Claude Code in headless mode (`claude -p`) in the repo folder.
 * Claude Code uses the claude.ai login and connectors (Jira, Microsoft 365) of the signed-in user; the allowed
 * tools are listed in .claude/settings.json. The snapshot it writes is picked up by the inbox watcher.
 */
export type SyncMode = 'daily' | 'docs' | 'jira';

const SCOPE: Record<SyncMode, string> = {
  daily: 'Jira, mail and calendar',
  docs: 'full sync with docs (Jira, mail, calendar and documentation checks)',
  jira: 'Jira only',
};
const prompt = (mode: SyncMode, lang: 'it' | 'en') =>
  `Run the pjm-sync skill in local mode (you are invoked headless by the PJM aid app in its repo folder): ${SCOPE[mode]}. ` +
  `Write the final report in ${lang === 'en' ? 'English' : 'Italian'}.`;
const TIMEOUT_MS = 25 * 60 * 1000;
const bin = () => process.env['PJM_CLAUDE_BIN'] ?? 'claude';
const isWin = process.platform === 'win32';

interface Step { at: string; label: string; count: number }
interface Job {
  id: number; mode: SyncMode; origin: 'manual' | 'auto'; status: 'running' | 'ok' | 'error'; startedAt: string; finishedAt?: string;
  steps: Step[]; resultText?: string; denials: string[]; error?: string; costUsd?: number; imported?: boolean;
}

let current: { job: Job; child: ChildProcess } | null = null;
let agentInfo: { available: boolean; version: string | null; bin: string; checkedAt: string } | null = null;

export function agentStatus(refresh = false) {
  if (!agentInfo || refresh) {
    const r = spawnSync(bin(), ['--version'], { encoding: 'utf8', shell: isWin, windowsHide: true, timeout: 20_000 });
    const out = `${r.stdout ?? ''}`.trim();
    agentInfo = { available: r.status === 0 && !!out, version: out || null, bin: bin(), checkedAt: new Date().toISOString() };
  }
  return { ...agentInfo, running: !!current };
}

/** Step code for a tool call seen in the stream (translated by the frontend: sync.step.<code>). */
function stepFor(tool: string): string {
  const t = tool.toLowerCase();
  if (t === 'skill') return 'skill';
  if (t.includes('atlassianuserinfo')) return 'jiraUser';
  if (t.includes('searchjiraissues')) return 'jira';
  if (t.includes('confluence')) return 'confluence';
  if (t.includes('calendar')) return 'calendar';
  if (t.includes('outlook') || t.endsWith('__get_me')) return 'mail';
  if (t.includes('sharepoint') || t.includes('read_resource')) return 'sharepoint';
  if (t === 'bash' || t === 'powershell') return 'build';
  if (t === 'write' || t === 'edit') return 'write';
  if (t === 'read' || t === 'glob' || t === 'grep' || t === 'toolsearch') return 'read';
  return tool;
}

function save(db: DatabaseSync, job: Job) {
  db.prepare(`UPDATE sync_jobs SET status = ?, finished_at = ?, steps = ?, result_text = ?, denials = ?, error = ?,
    cost_usd = ?, imported = ? WHERE id = ?`).run(job.status, job.finishedAt ?? null, JSON.stringify(job.steps),
    job.resultText ?? null, JSON.stringify(job.denials), job.error ?? null, job.costUsd ?? null, job.imported ? 1 : 0, job.id);
}

export function startSync(db: DatabaseSync, mode: SyncMode, lang: 'it' | 'en' = 'it', origin: 'manual' | 'auto' = 'manual'): Job {
  if (current) throw Object.assign(new Error('A sync is already running'), { status: 409 });
  if (!agentStatus().available) throw Object.assign(new Error(`Claude Code not found ("${bin()} --version" failed)`), { status: 503 });

  const startedAt = new Date().toISOString();
  const id = Number(db.prepare(`INSERT INTO sync_jobs (mode, origin, status, started_at) VALUES (?, ?, 'running', ?)`)
    .run(mode, origin, startedAt).lastInsertRowid);
  const job: Job = { id, mode, origin, status: 'running', startedAt, steps: [], denials: [] };

  // Prompt goes through stdin: no quoting problems with the Windows shell.
  const child = spawn(bin(), ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none'], {
    cwd: config.root, shell: isWin, windowsHide: true, env: { ...process.env },
  });
  current = { job, child };
  child.stdin?.end(prompt(mode, lang));

  const addStep = (label: string) => {
    const last = job.steps.at(-1);
    if (last?.label === label) last.count++;
    else job.steps.push({ at: new Date().toISOString(), label, count: 1 });
    if (job.steps.length > 40) job.steps.shift();
  };
  addStep('start');

  let buffer = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Record<string, any>;
        if (msg['type'] === 'assistant') {
          for (const c of msg['message']?.content ?? []) if (c.type === 'tool_use') addStep(stepFor(String(c.name)));
        } else if (msg['type'] === 'result') {
          job.resultText = typeof msg['result'] === 'string' ? msg['result'] : undefined;
          job.costUsd = typeof msg['total_cost_usd'] === 'number' ? msg['total_cost_usd'] : undefined;
          // Keep what was denied and, for shell commands, the command itself (shown in the app).
          job.denials = (msg['permission_denials'] ?? []).map((d: any) => {
            const input = d.tool_input ?? d.toolInput ?? {};
            const detail = input.command ?? input.file_path ?? input.path ?? '';
            return `${d.tool_name ?? d.toolName ?? '?'}${detail ? `: ${String(detail).slice(0, 160)}` : ''}`;
          });
          if (msg['is_error']) job.error = job.resultText ?? String(msg['subtype'] ?? 'error');
        }
      } catch {
        /* non-JSON line: ignore */
      }
    }
  });
  child.stderr?.on('data', (c: Buffer) => { stderr = (stderr + c.toString('utf8')).slice(-4000); });

  const timer = setTimeout(() => {
    job.error = `Timed out after ${TIMEOUT_MS / 60000} minutes`;
    child.kill();
  }, TIMEOUT_MS);

  let finished = false;
  const finish = (code: number | null, spawnError?: Error) => {
    clearTimeout(timer);
    if (finished) return;
    finished = true;
    job.finishedAt = new Date().toISOString();
    if (spawnError) job.error = spawnError.message;
    else if (code !== 0 && !job.error) job.error = stderr.trim() || `Claude Code exited with code ${code}`;
    // The inbox watcher imports the snapshot ~1.5 s after it lands; check a little later.
    setTimeout(() => {
      const last = db.prepare('SELECT imported_at FROM sync_runs ORDER BY id DESC LIMIT 1').get() as { imported_at: string } | undefined;
      job.imported = !!last && new Date(`${last.imported_at.replace(' ', 'T')}Z`) >= new Date(job.startedAt);
      job.status = job.error ? 'error' : 'ok';
      save(db, job);
      current = null;
    }, 3000);
  };
  child.on('error', (err) => finish(null, err));
  child.on('close', (code) => finish(code));
  save(db, job);
  return job;
}

const localDay = (ts: string) => new Date(ts).toLocaleDateString('sv-SE');

/**
 * First opening of the day: start a sync unless one already ran today (any "Sync now" job, auto or manual,
 * or a snapshot imported today, e.g. from Cowork or the scheduled task).
 */
export function autoSync(db: DatabaseSync, mode: SyncMode, lang: 'it' | 'en') {
  if (current) return { started: false, reason: 'running', job: current.job };
  const today = isoToday();
  const jobs = db.prepare('SELECT started_at FROM sync_jobs ORDER BY id DESC LIMIT 20').all() as { started_at: string }[];
  if (jobs.some((j) => localDay(j.started_at) === today)) return { started: false, reason: 'done', job: null };
  const runs = db.prepare('SELECT imported_at FROM sync_runs ORDER BY id DESC LIMIT 5').all() as { imported_at: string }[];
  if (runs.some((r) => localDay(`${r.imported_at.replace(' ', 'T')}Z`) === today)) return { started: false, reason: 'imported', job: null };
  if (!agentStatus().available) return { started: false, reason: 'unavailable', job: null };
  return { started: true, reason: 'started', job: startSync(db, mode, lang, 'auto') };
}

export function currentOrLastJob(db: DatabaseSync) {
  if (current) return current.job;
  const row = db.prepare('SELECT * FROM sync_jobs ORDER BY id DESC LIMIT 1').get();
  return row ? toApi(row) : null;
}

export const recentJobs = (db: DatabaseSync) => toApiList(db.prepare('SELECT * FROM sync_jobs ORDER BY id DESC LIMIT 10').all());

/** On startup, jobs left "running" by a previous backend process are marked as interrupted. */
export function markInterruptedJobs(db: DatabaseSync) {
  db.prepare(`UPDATE sync_jobs SET status = 'error', error = 'Interrupted (backend restarted)', finished_at = datetime('now')
    WHERE status = 'running'`).run();
}

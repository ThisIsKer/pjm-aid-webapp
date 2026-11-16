/**
 * PJM aid MCP server (stdio). Lets Claude read and update the board from any conversation:
 * "what's late on IMA?", "mark the Dorigo mail as done", "set SAATI FR to green".
 * It talks to the running backend's REST API (http://127.0.0.1:4310), so the backend stays the only writer.
 *
 *   Claude Code:  claude mcp add pjm-aid --scope user -- node <repo>/backend/src/mcp.ts
 *   Claude app:   claude_desktop_config.json → "pjm-aid": { "command": "node", "args": ["<repo>/backend/src/mcp.ts"] }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = `http://127.0.0.1:${process.env['PJM_PORT'] ?? 4310}/api`;

async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init?.method ?? 'GET',
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new Error(`The PJM aid backend is not running on ${BASE}. Start it with "npm run dev" or "npm start" in the repo.`);
  }
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
const fail = (err: unknown) => ({ content: [{ type: 'text' as const, text: (err as Error).message }], isError: true });
const tool = <A,>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
  try {
    return text(await fn(args));
  } catch (err) {
    return fail(err);
  }
};

/** Resolves a project by id, Jira epic key, or (part of) its name / client. */
async function resolveProject(query: string) {
  const projects = await api<any[]>('/projects?all=true');
  const q = query.trim().toLowerCase();
  const exact = projects.find((p) => p.id.toLowerCase() === q || (p.jiraKeys ?? []).some((k: string) => k.toLowerCase() === q));
  if (exact) return exact;
  const matches = projects.filter((p) => `${p.name} ${p.client ?? ''}`.toLowerCase().includes(q));
  const active = matches.filter((p) => p.active);
  const pick = active.length ? active : matches;
  if (pick.length === 1) return pick[0];
  if (!pick.length) throw new Error(`No project matches "${query}". Use pjm_list_projects to see them.`);
  throw new Error(`"${query}" matches several projects: ${pick.map((p) => `${p.id} (${p.name})`).join('; ')}. Use the id.`);
}

const projectLine = (p: any) => ({
  id: p.id, name: p.name, group: p.groupName ?? null, role: p.role, active: p.active, myStatus: p.status, jiraRag: p.jiraRag, jiraReason: p.jiraRagReason,
  phase: p.phase ?? p.currentPhase?.name ?? null, nextDeadline: p.nextDeadline, overdue: p.overdue, atRisk: p.atRisk,
  mailsToAnswer: p.needsReply, missingDocs: p.missingDocs, uncheckedDocs: p.uncheckedDocs, epics: p.jiraKeys,
});

const server = new McpServer({ name: 'pjm-aid', version: '0.4.0' });

server.registerTool('pjm_dashboard', {
  title: 'PJM dashboard',
  description: 'Overview of all active projects: KPIs, each project\'s Jira status and phase, overdue and due-soon phases (14 days) with flags, last sync. Start here for "how are my projects doing?".',
  inputSchema: { days: z.number().int().min(1).max(60).optional().describe('Horizon for upcoming deadlines (default 14)') },
  annotations: { readOnlyHint: true },
}, tool(async ({ days }: { days?: number }) => {
  const d = await api(`/dashboard${days ? `?days=${days}` : ''}`);
  return {
    today: d.today, horizon: d.horizon, kpis: d.kpis, lastSync: d.lastSync?.generatedAt ?? null,
    projects: d.projects.map(projectLine),
    deadlines: d.deadlines.map((x: any) => ({
      key: x.id, project: x.projectName, phase: x.phaseName ?? x.title, due: x.dueDate, flags: x.flags,
      remainingHours: x.remainingHours, assignee: x.assignee, openSubtasks: x.openSubtasks?.map((s: any) => s.summary), url: x.url,
    })),
  };
}));

server.registerTool('pjm_today', {
  title: "Today's plan",
  description: "The day plan: Jira phases planned for the day (hours to spend today = remaining estimate spread over the working days left; overdue ones in full), manual deadlines due, and Outlook meetings, with total load vs 8 h. On weekends it plans the next Monday. Optional date YYYY-MM-DD.",
  inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
  annotations: { readOnlyHint: true },
}, tool(async ({ date }: { date?: string }) => {
  const d = await api(`/today${date ? `?date=${date}` : ''}`);
  return {
    day: d.day, load: { activities: d.activityHours, meetings: d.meetingHours, capacity: d.capacityHours },
    activities: d.activities.map((x: any) => ({ project: x.projectName, phase: x.phaseName ?? x.title, key: x.id,
      hoursToday: x.hoursToday, remaining: x.remainingHours, due: x.dueDate, overdue: x.overdue })),
    meetings: d.meetings.map((m: any) => ({ subject: m.subject, start: m.start, end: m.end, client: m.client, organizer: m.organizerName, join: m.onlineUrl })),
  };
}));

server.registerTool('pjm_list_projects', {
  title: 'List projects',
  description: 'All projects with id, Jira epics, status, phase and counters. Hidden projects only with includeHidden.',
  inputSchema: { includeHidden: z.boolean().optional() },
  annotations: { readOnlyHint: true },
}, tool(async ({ includeHidden }: { includeHidden?: boolean }) =>
  (await api<any[]>(`/projects?all=${!!includeHidden}`)).map(projectLine)));

server.registerTool('pjm_get_project', {
  title: 'Project detail',
  description: 'Everything about one project: epics, open Jira phases with flags and open sub-tasks, mail threads, documentation checklist. "project" can be the id, a Jira epic key (DDMD-1234) or part of the name/client (e.g. "Mevis", "SAATI FR").',
  inputSchema: { project: z.string() },
  annotations: { readOnlyHint: true },
}, tool(async ({ project }: { project: string }) => {
  const p = await resolveProject(project);
  const d = await api(`/projects/${encodeURIComponent(p.id)}`);
  return {
    ...projectLine(d), pmNote: d.pmNote, sharepointUrl: d.sharepointUrl,
    phases: d.deadlines.filter((x: any) => x.state === 'open').map((x: any) => ({
      key: x.id, phase: x.phaseName ?? x.title, start: x.startDate, due: x.dueDate, flags: x.flags,
      originalHours: x.originalHours, remainingHours: x.remainingHours, assignee: x.assignee,
      openSubtasks: x.openSubtasks?.map((s: any) => s.summary), source: x.source,
    })),
    mail: d.mailThreads.filter((m: any) => m.userState !== 'done').map((m: any) => ({
      id: m.id, subject: m.subject, category: m.category, urgency: m.urgency, from: m.counterpart, at: m.lastMessageAt, summary: m.summary,
    })),
    docs: d.docRequirements.map((r: any) => ({
      id: r.id, title: r.title, phase: r.phase, required: r.required, waived: r.waived, status: r.checkStatus, url: r.foundUrl,
    })),
  };
}));

server.registerTool('pjm_list_mail', {
  title: 'Mails to handle',
  description: 'Open mail threads triaged by the last sync: needs_reply (I owe an answer), waiting (others owe me), fyi.',
  inputSchema: { category: z.enum(['needs_reply', 'waiting', 'fyi']).optional() },
  annotations: { readOnlyHint: true },
}, tool(async ({ category }: { category?: string }) =>
  (await api<any[]>(`/mail${category ? `?category=${category}` : ''}`)).map((m) => ({
    id: m.id, project: m.projectName, subject: m.subject, category: m.category, urgency: m.urgency,
    from: m.counterpart, at: m.lastMessageAt, summary: m.summary, link: m.webLink,
  }))));

server.registerTool('pjm_update_mail', {
  title: 'Update a mail thread',
  description: 'Mark a thread done, snooze it for some days, reopen it, or assign it to a project. Use the id from pjm_list_mail.',
  inputSchema: {
    threadId: z.string(),
    action: z.enum(['done', 'snooze', 'reopen', 'assign']),
    days: z.number().int().min(1).max(60).optional().describe('For snooze (default 3)'),
    project: z.string().optional().describe('For assign: project id, epic key or name'),
  },
}, tool(async ({ threadId, action, days, project }: { threadId: string; action: string; days?: number; project?: string }) => {
  const id = encodeURIComponent(threadId);
  if (action === 'assign') {
    if (!project) throw new Error('project is required for assign');
    const p = await resolveProject(project);
    return api(`/mail/${id}`, { method: 'PATCH', body: { projectId: p.id } });
  }
  if (action === 'snooze') {
    const until = new Date();
    until.setDate(until.getDate() + (days ?? 3));
    return api(`/mail/${id}`, { method: 'PATCH', body: { userState: 'snoozed', snoozedUntil: until.toLocaleDateString('sv-SE') } });
  }
  return api(`/mail/${id}`, { method: 'PATCH', body: { userState: action === 'done' ? 'done' : 'open', snoozedUntil: null } });
}));

server.registerTool('pjm_doc_gaps', {
  title: 'Documentation gaps',
  description: 'Documents that need attention: missing although due for the current phase, or found for the first time / updated since the user confirmed them (state new / updated). Optionally for one project.',
  inputSchema: { project: z.string().optional() },
  annotations: { readOnlyHint: true },
}, tool(async ({ project }: { project?: string }) => {
  const rows = await api<any[]>('/docs');
  const p = project ? await resolveProject(project) : null;
  return rows.filter((r) => !p || r.projectId === p.id).map((r) => ({
    id: r.id, project: r.projectName, phase: r.projectPhase, document: r.title, status: r.checkStatus, where: r.locationHint,
  }));
}));

server.registerTool('pjm_update_project', {
  title: 'Update a project',
  description: 'Set my RAG status, a PM note, a phase override, the SharePoint link or the custom group of a project, or hide/show it.',
  inputSchema: {
    project: z.string(),
    status: z.enum(['green', 'amber', 'red', 'grey']).optional(),
    pmNote: z.string().optional(),
    phase: z.string().nullable().optional().describe('Overrides the phase derived from Jira; null to clear'),
    sharepointUrl: z.string().url().optional(),
    active: z.boolean().optional(),
    group: z.string().nullable().optional().describe('Custom group name (created if missing); null removes the project from its group'),
  },
}, tool(async ({ project, group, ...changes }: { project: string; group?: string | null; [k: string]: unknown }) => {
  const p = await resolveProject(project);
  const body: Record<string, unknown> = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
  if (group === null) body['groupId'] = null;
  else if (group) {
    const groups = await api<any[]>('/groups');
    const existing = groups.find((g) => g.name.toLowerCase() === group.trim().toLowerCase());
    body['groupId'] = existing ? existing.id : (await api('/groups', { method: 'POST', body: { name: group.trim() } })).id;
  }
  if (!Object.keys(body).length) throw new Error('Nothing to change');
  return api(`/projects/${encodeURIComponent(p.id)}`, { method: 'PATCH', body });
}));

server.registerTool('pjm_add_deadline', {
  title: 'Add a manual deadline',
  description: 'Adds a deadline that is not in Jira (e.g. a client meeting or a delivery) to a project.',
  inputSchema: { project: z.string(), title: z.string(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD') },
}, tool(async ({ project, title, dueDate }: { project: string; title: string; dueDate: string }) => {
  const p = await resolveProject(project);
  return api(`/projects/${encodeURIComponent(p.id)}/deadlines`, { method: 'POST', body: { title, dueDate } });
}));

server.registerTool('pjm_waive_doc', {
  title: 'Mark a document as not needed',
  description: 'Waives (or restores) a documentation requirement for a project. Use the id from pjm_doc_gaps or pjm_get_project.',
  inputSchema: { requirementId: z.string(), waived: z.boolean().default(true) },
}, tool(async ({ requirementId, waived }: { requirementId: string; waived: boolean }) =>
  api(`/docs/${encodeURIComponent(requirementId)}`, { method: 'PATCH', body: { waived } })));

server.registerTool('pjm_confirm_doc', {
  title: 'Confirm a document is OK',
  description: 'Marks a documentation requirement as present and OK (the found file in its current version, or by hand when it is kept elsewhere). confirmed=false removes the OK. A document updated after the OK needs attention again.',
  inputSchema: { requirementId: z.string(), confirmed: z.boolean().default(true) },
}, tool(async ({ requirementId, confirmed }: { requirementId: string; confirmed: boolean }) =>
  api(`/docs/${encodeURIComponent(requirementId)}`, { method: 'PATCH', body: { confirmed } })));

server.registerTool('pjm_sync_status', {
  title: 'Sync status',
  description: 'When the board was last synced with Jira/Outlook/SharePoint, and the last "Sync now" run.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, tool(async () => {
  const [health, job] = await Promise.all([api('/health'), api('/sync/jobs/current')]);
  return { lastSync: health.lastSync, lastSyncNowRun: job };
}));

await server.connect(new StdioServerTransport());
console.error(`[pjm-aid mcp] ready (backend ${BASE})`);

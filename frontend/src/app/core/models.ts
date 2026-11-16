export type Rag = 'green' | 'amber' | 'red' | 'grey';

export interface Project {
  id: string;
  name: string;
  client: string | null;
  description: string | null;
  phase: string | null;
  status: Rag;
  suggestedStatus: Rag | null;
  suggestedReason: string | null;
  pmNote: string | null;
  jiraKeys: string[];
  sharepointUrl: string | null;
  confluenceSpace: string | null;
  mailKeywords: string[];
  mailDomains: string[];
  active: boolean;
  role: 'pm' | 'contributor';
  origin: 'manual' | 'jira';
  // computed by the API
  currentPhase: { name: string; startsOn: string | null } | null;
  jiraRag: Rag;
  jiraRagReason: string;
  openPhases: number;
  overdue: number;
  atRisk: number;
  dataGaps: number;
  nextDeadline: string | null;
  needsReply: number;
  missingDocs: number;
  uncheckedDocs: number;
  attentionDocs: number;
  sharepointFolderUri: string | null;
  groupId: number | null;
  groupName: string | null;
  groupColor: string | null;
}

export interface ProjectGroup {
  id: number;
  name: string;
  color: string | null;
  sort: number;
  projectCount?: number;
}

export type Flag = 'overdue' | 'at_risk' | 'missing_due' | 'missing_start' | 'missing_estimate';

export interface JiraEpic {
  key: string;
  projectId: string | null;
  projectName?: string | null;
  summary: string | null;
  status: string | null;
  mine: boolean;
  url: string | null;
  active: boolean;
}

export interface Deadline {
  id: string;
  projectId: string | null;
  effProjectId: string | null;
  projectName?: string | null;
  epicKey: string | null;
  epicSummary: string | null;
  title: string;
  phaseName: string | null;
  startDate: string | null;
  dueDate: string | null;
  source: 'jira' | 'manual' | 'claude';
  sourceRef: string | null;
  url: string | null;
  statusName: string | null;
  assignee: string | null;
  assignedToMe: boolean;
  originalHours: number | null;
  remainingHours: number | null;
  openSubtasks: { key: string; summary: string; assignee?: string | null }[];
  state: 'open' | 'done';
  flags: Flag[];
}

export type MailCategory = 'needs_reply' | 'waiting' | 'fyi';

export interface MailThread {
  id: string;
  projectId: string | null;
  projectName?: string | null;
  subject: string;
  counterpart: string | null;
  lastMessageAt: string | null;
  lastFromMe: boolean;
  category: MailCategory;
  urgency: 'high' | 'normal' | 'low';
  summary: string | null;
  webLink: string | null;
  userState: 'open' | 'done' | 'snoozed';
  snoozedUntil: string | null;
}

export interface DocRequirement {
  id: string;
  projectId: string;
  projectName?: string;
  phase: string | null;
  title: string;
  repository: 'sharepoint' | 'confluence';
  locationHint: string | null;
  requiredFrom: string | null;
  checkStatus: 'missing' | 'present' | 'outdated' | 'unknown';
  state: DocState;
  foundUrl: string | null;
  foundPath: string | null;
  foundModifiedAt: string | null;
  confirmedAt: string | null;
  checkedAt: string | null;
  /** Location chosen by the user (kept over Claude's matching). */
  pinned: boolean;
  waived: boolean;
  required: boolean;
  projectPhase?: string | null;
  projectFolderUrl?: string | null;
  projectClient?: string | null;
}

/** ok = confirmed by you · new = found, not confirmed yet · updated = changed after your OK · missing · unchecked · waived */
export type DocState = 'ok' | 'new' | 'updated' | 'missing' | 'unchecked' | 'waived';

export interface SyncRun {
  id: number;
  generatedAt: string | null;
  importedAt: string;
  counts: Record<string, number>;
  warnings: string[];
}

export interface Dashboard {
  today: string;
  horizon: string;
  kpis: { activeProjects: number; overdue: number; atRisk: number; dueSoon: number; needsReply: number; missingDocs: number; uncheckedDocs: number; attentionDocs: number };
  projects: Project[];
  deadlines: Deadline[];
  lastSync: SyncRun | null;
}

export interface ProjectDetail extends Project {
  pmNote: string | null;
  epics: JiraEpic[];
  deadlines: Deadline[];
  mailThreads: MailThread[];
  docRequirements: DocRequirement[];
}

export interface SyncStep { at: string; label: string; count: number }

export interface SyncJob {
  id: number;
  mode: 'daily' | 'docs' | 'jira';
  origin?: 'manual' | 'auto';
  status: 'running' | 'ok' | 'error';
  startedAt: string;
  finishedAt?: string | null;
  steps: SyncStep[];
  resultText?: string | null;
  denials: string[];
  error?: string | null;
  costUsd?: number | null;
  imported?: boolean;
}

export interface AgentStatus { available: boolean; version: string | null; bin: string; running: boolean }

export interface TodayActivity {
  id: string; projectId: string | null; projectName: string | null; epicSummary: string | null; title: string;
  phaseName: string | null; source: string; url: string | null; startDate: string | null; dueDate: string;
  remainingHours: number | null; hoursToday: number | null; overdue: boolean; dueToday: boolean; flags: Flag[];
  openSubtasks: { key: string; summary: string }[];
}

export interface Meeting {
  id: string; subject: string; start: string; end: string; isAllDay: boolean; location: string | null;
  onlineUrl: string | null; organizerName: string | null; isOrganizer: boolean; showAs: string | null;
  webLink: string | null; attendeeCount: number; client: string | null; projectIds: string[];
}

export interface DayPlan {
  today: string; day: string; isToday: boolean; capacityHours: number; activityHours: number; meetingHours: number;
  activities: TodayActivity[]; meetings: Meeting[]; calendarSyncedAt: string | null;
}

/** A file of the project's SharePoint folder, as listed by Claude's last documentation check. */
export interface ProjectFile { path: string; url: string; modifiedAt: string | null; size: number | null }
export interface ProjectFiles { folderUrl: string | null; scannedAt: string | null; files: ProjectFile[] }

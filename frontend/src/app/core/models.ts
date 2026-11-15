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
  // computed by the API
  overdue: number;
  nextDeadline: string | null;
  needsReply: number;
  missingDocs: number;
}

export interface Deadline {
  id: string;
  projectId: string;
  projectName?: string;
  title: string;
  startDate: string | null;
  dueDate: string | null;
  source: 'jira' | 'manual' | 'claude';
  sourceRef: string | null;
  assignee: string | null;
  remainingHours: number | null;
  state: 'open' | 'done';
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
  checkStatus: 'missing' | 'present' | 'outdated' | 'unknown';
  foundUrl: string | null;
  checkedAt: string | null;
  waived: boolean;
}

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
  kpis: { activeProjects: number; overdue: number; dueSoon: number; needsReply: number; missingDocs: number };
  projects: Project[];
  deadlines: Deadline[];
  lastSync: SyncRun | null;
}

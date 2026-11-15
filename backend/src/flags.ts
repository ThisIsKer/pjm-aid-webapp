/**
 * Jira phase rules — same as the `controllo-pm` skill:
 *  - overdue:         open phase with a due date in the past
 *  - at_risk:         due within `windowDays` (default 14) and remaining estimate greater than
 *                     `factor` (default 0.5) days × remaining working days (Mon–Fri, from tomorrow to due date inclusive)
 *  - missing_due / missing_start / missing_estimate: field not filled in Jira
 * Pure functions: shared by the backend and tools/build-snapshot.ts.
 */

export type Flag = 'overdue' | 'at_risk' | 'missing_due' | 'missing_start' | 'missing_estimate';
export type Rag = 'green' | 'amber' | 'red' | 'grey';

/** Standard DDMD phase sequence (order matters). */
export const PHASE_ORDER = ['Analisi', 'Implementazione', 'Test interni', 'UAT', 'Live', 'Post GoLive'] as const;
/** Phases that run alongside the sequence and never count as "current phase". */
export const CONTINUOUS_PHASES = ['SAL/Allineamenti'] as const;

const HOURS_PER_DAY = 8;

export interface PhaseLike {
  phaseName?: string | null;
  startDate: string | null;
  dueDate: string | null;
  originalHours: number | null;
  remainingHours: number | null;
  state: 'open' | 'done';
}

export const isoToday = () => new Date().toLocaleDateString('sv-SE');

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE');
}

/** Working days (Mon–Fri, holidays ignored) from the day after `today` up to and including `due`. */
export function workdaysUntil(today: string, due: string): number {
  let n = 0;
  for (let d = addDays(today, 1); d <= due; d = addDays(d, 1)) {
    const wd = new Date(`${d}T12:00:00`).getDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

export function phaseFlags(p: PhaseLike, today: string, windowDays = 14, factor = 0.5): Flag[] {
  if (p.state === 'done') return [];
  const flags: Flag[] = [];
  if (p.dueDate && p.dueDate < today) flags.push('overdue');
  else if (p.dueDate && p.dueDate <= addDays(today, windowDays) && p.remainingHours != null) {
    const threshold = workdaysUntil(today, p.dueDate) * factor * HOURS_PER_DAY;
    if (p.remainingHours > threshold) flags.push('at_risk');
  }
  if (!p.dueDate) flags.push('missing_due');
  if (!p.startDate) flags.push('missing_start');
  if (p.originalHours == null) flags.push('missing_estimate');
  return flags;
}

/**
 * Normalises a phase summary to a standard phase name:
 * "IMA - S4 - SAL/Allineamenti - MB" (epic "IMA - S4") → "SAL/Allineamenti";
 * "… - UAT e Rework - CB" → "UAT"; "… - Live VB" → "Live"; "Costacurta - SAL - AC" → "SAL/Allineamenti".
 */
export function canonicalPhase(summary: string, epicSummary?: string | null): string {
  const known = [...PHASE_ORDER, ...CONTINUOUS_PHASES].sort((a, b) => b.length - a.length);
  let rest = summary.trim();
  const prefixed = !!epicSummary && rest.toLowerCase().startsWith(epicSummary.trim().toLowerCase());
  if (prefixed) rest = rest.slice(epicSummary!.trim().length);
  rest = rest.replace(/^\s*[-–]\s*/, '').trim();
  const lower = rest.toLowerCase();
  const startsWith = known.find((k) => lower.startsWith(k.toLowerCase()));
  if (startsWith) return startsWith;
  if (/\bSAL\b/i.test(rest)) return 'SAL/Allineamenti';
  if (!prefixed) {
    const anywhere = known.find((k) => new RegExp(`(^|[\\s-])${k.replace('/', '\\/')}`, 'i').test(rest));
    if (anywhere) return anywhere;
  }
  return rest.replace(/\s+[-–]\s+[A-Z]{2,4}$/, '').trim();
}

export const phaseIndex = (name: string | null | undefined) =>
  PHASE_ORDER.findIndex((p) => p.toLowerCase() === (name ?? '').toLowerCase());

/** Latest sequential phase that has started (and is still open); otherwise the next one to start. */
export function currentPhase(phases: PhaseLike[], today: string): { name: string; startsOn: string | null } | null {
  const seq = phases.filter((p) => p.state === 'open' && phaseIndex(p.phaseName) >= 0);
  const started = seq.filter((p) => p.startDate && p.startDate <= today);
  if (started.length) {
    const p = started.reduce((a, b) => (phaseIndex(b.phaseName) > phaseIndex(a.phaseName) ? b : a));
    return { name: PHASE_ORDER[phaseIndex(p.phaseName)]!, startsOn: null };
  }
  if (!seq.length) return null;
  const next = seq.reduce((a, b) => (phaseIndex(b.phaseName) < phaseIndex(a.phaseName) ? b : a));
  return { name: PHASE_ORDER[phaseIndex(next.phaseName)]!, startsOn: next.startDate };
}

/** RAG derived from Jira only: red = something overdue, amber = something at risk, green = open phases all fine. */
export function jiraRag(phases: (PhaseLike & { flags: Flag[] })[]): { rag: Rag; reason: string } {
  const open = phases.filter((p) => p.state === 'open');
  const overdue = open.filter((p) => p.flags.includes('overdue')).length;
  const atRisk = open.filter((p) => p.flags.includes('at_risk')).length;
  if (overdue) return { rag: 'red', reason: `${overdue} phase(s) overdue${atRisk ? `, ${atRisk} at risk` : ''}` };
  if (atRisk) return { rag: 'amber', reason: `${atRisk} phase(s) at risk` };
  if (open.length && open.every((p) => !p.dueDate)) return { rag: 'grey', reason: 'phases not planned yet (no due dates)' };
  if (open.length) return { rag: 'green', reason: `${open.length} open phase(s) on track` };
  return { rag: 'grey', reason: 'no open Jira phases' };
}

/**
 * Is a document due, given the project's current phase? `requiredFrom` defaults to the phase after `phase`
 * (a phase's deliverable is expected once the next phase has started). Unknown project phase → not due.
 */
export function docRequired(
  doc: { phase: string | null; requiredFrom: string | null },
  current: { name: string; startsOn: string | null } | null,
  manualPhase?: string | null,
): boolean {
  let from = phaseIndex(doc.requiredFrom);
  if (from < 0) {
    const produced = phaseIndex(doc.phase);
    if (produced < 0) return true; // no phase information: always expected
    from = Math.min(produced + 1, PHASE_ORDER.length - 1);
  }
  let at = current ? phaseIndex(current.name) - (current.startsOn ? 1 : 0) : phaseIndex(manualPhase);
  if (!current && at < 0) return false;
  return at >= from;
}

/** "R: I: Re: FE FRANCIA" → "fe francia" — used to group mails of the same thread. */
export function normalizeSubject(subject: string): string {
  let s = subject.trim();
  const prefix = /^(re|r|i|fw|fwd|aw|wg|tr|rif|risposta automatica|automatic reply|antwort)\s*:\s*/i;
  while (prefix.test(s)) s = s.replace(prefix, '');
  return s.replace(/\s+/g, ' ').toLowerCase();
}

/** Stable id of a mail thread: "mail:" + slug of the normalised subject. */
export function mailThreadId(subject: string): string {
  const slug = normalizeSubject(subject).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `mail:${slug.slice(0, 120)}`;
}

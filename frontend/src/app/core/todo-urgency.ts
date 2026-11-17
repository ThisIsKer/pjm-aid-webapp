/** Due-date urgency of a to-do: overdue = critical, due within the next 2 days (today included) = warning. */
export type Urgency = 'critical' | 'warning' | null;

const iso = (d: Date) => d.toLocaleDateString('sv-SE');
export const todayIso = () => iso(new Date());
export const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

export const SOON_DAYS = 2;

export function todoUrgency(t: { dueDate: string | null; status: string }): Urgency {
  if (t.status === 'completed' || !t.dueDate) return null;
  if (t.dueDate < todayIso()) return 'critical';
  if (t.dueDate <= plusDays(SOON_DAYS)) return 'warning';
  return null;
}

/** Open tasks by due date (no date last), important first on the same day; completed at the end. */
export function byDueDate<T extends { dueDate: string | null; status: string; importance: string; title: string }>(a: T, b: T): number {
  return Number(a.status === 'completed') - Number(b.status === 'completed')
    || Number(!a.dueDate) - Number(!b.dueDate)
    || (a.dueDate ?? '').localeCompare(b.dueDate ?? '')
    || Number(b.importance === 'high') - Number(a.importance === 'high')
    || a.title.localeCompare(b.title);
}

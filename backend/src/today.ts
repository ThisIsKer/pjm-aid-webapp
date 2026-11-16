import type { DatabaseSync } from 'node:sqlite';
import { addDays, isoToday, phaseIndex, planDay, workdaysInclusive } from './flags.ts';
import { loadDeadlines, loadProjects } from './projects.ts';
import { toApiList } from './util.ts';

const HOURS_PER_DAY = 8;
const round = (h: number) => Math.round(h * 4) / 4;
const localDate = (iso: string) => new Date(iso).toLocaleDateString('sv-SE');
const hoursBetween = (a: string, b: string) => Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000);

/**
 * The day plan: Jira phases assigned to me whose planning covers the day (start ≤ day ≤ due, or overdue),
 * with the hours to spend today = remaining estimate spread over the working days left; manual deadlines due
 * that day; Outlook meetings of that day. On weekends the plan is for the next Monday.
 */
export function dayPlan(db: DatabaseSync, date?: string) {
  const today = isoToday();
  const day = date ?? planDay(today);

  const activities = loadDeadlines(db, `d.state = 'open' AND p.active = 1 AND d.due_date IS NOT NULL
      AND (d.source <> 'jira' OR d.assigned_to_me = 1)`)
    .filter((d) => d.source === 'jira'
      ? (d.startDate ?? d.dueDate!) <= day
      : d.dueDate! <= day)
    .map((d) => {
      const overdue = d.dueDate! < day;
      const remaining = d.remainingHours ?? null;
      const hoursToday = remaining == null ? null
        : remaining <= 0 ? 0
        : Math.max(0.25, round(overdue ? remaining : remaining / workdaysInclusive(day, d.dueDate!)));
      return {
        id: d.id, projectId: d.effProjectId, projectName: d['projectName'] ?? null, epicSummary: d['epicSummary'] ?? null,
        title: d.title, phaseName: d.phaseName ?? null, source: d['source'], url: d['url'] ?? null,
        startDate: d.startDate, dueDate: d.dueDate, remainingHours: remaining, hoursToday, overdue,
        dueToday: d.dueDate === day, flags: d.flags,
        openSubtasks: (d['openSubtasks'] as unknown[]) ?? [],
      };
    })
    // Overdue first, then due today, then the biggest share of today's time.
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(b.dueToday) - Number(a.dueToday)
      || (b.hoursToday ?? 0) - (a.hoursToday ?? 0) || a.dueDate!.localeCompare(b.dueDate!)
      || phaseIndex(a.phaseName) - phaseIndex(b.phaseName));

  // Meetings: fetch a window around the day, keep those whose local date is the day.
  const rows = toApiList<Record<string, any>>(db.prepare(`SELECT * FROM calendar_events
    WHERE start_at >= ? AND start_at < ? ORDER BY start_at`).all(`${day.slice(0, 8)}01`, `${day}T99`))
    .filter((e) => localDate(e['startAt']) === day && !e['isCancelled']);

  // Label meetings with the client(s) they belong to: client name in the subject or in an attendee's domain.
  const clients = new Map<string, { client: string; projectIds: string[] }>();
  for (const p of loadProjects(db)) {
    const client = String(p['client'] ?? p['name']);
    const token = client.toLowerCase().split(/[^a-z0-9àèéìòù]+/).find((t) => t.length >= 3);
    if (!token || token === 'tecnica') continue;
    const entry = clients.get(token) ?? { client, projectIds: [] };
    entry.projectIds.push(String(p['id']));
    clients.set(token, entry);
  }
  const meetings = rows.map((e) => {
    const haystack = `${e['subject']} ${(e['attendees'] as string[]).join(' ')} ${e['organizer'] ?? ''}`.toLowerCase();
    const match = [...clients.entries()].find(([token]) => new RegExp(`(^|[^a-z0-9])${token}`).test(haystack));
    return {
      id: e['id'], subject: e['subject'], start: e['startAt'], end: e['endAt'], isAllDay: e['isAllDay'],
      location: e['location'], onlineUrl: e['onlineUrl'], organizerName: e['organizerName'] ?? e['organizer'],
      isOrganizer: e['isOrganizer'], showAs: e['showAs'], webLink: e['webLink'], attendeeCount: (e['attendees'] as string[]).length,
      client: match?.[1].client ?? null, projectIds: match?.[1].projectIds ?? [],
    };
  });

  const activityHours = round(activities.reduce((n, a) => n + (a.hoursToday ?? 0), 0));
  const meetingHours = round(meetings.filter((m) => !m.isAllDay && m.showAs !== 'free')
    .reduce((n, m) => n + hoursBetween(m.start, m.end), 0));
  const lastCalendar = db.prepare('SELECT MAX(updated_at) AS at FROM calendar_events').get() as { at: string | null };

  return {
    today, day, isToday: day === today, capacityHours: HOURS_PER_DAY, activityHours, meetingHours,
    activities, meetings, calendarSyncedAt: lastCalendar.at,
  };
}

const isWorkday = (d: string) => { const w = new Date(`${d}T12:00:00`).getDay(); return w !== 0 && w !== 6; };

/**
 * The week plan: the next 5 working days from the plan day (today, or Monday on weekends). Each Jira phase's
 * remaining estimate is burnt down day by day (hours of a day = what is left ÷ working days left to the due date),
 * so the week adds up to the estimate; overdue phases take all their remaining hours on the first day.
 * Manual deadlines and phases without an estimate appear on their due day (or the first day when overdue).
 */
export function weekPlan(db: DatabaseSync, date?: string) {
  const today = isoToday();
  const days: string[] = [];
  for (let d = date ?? planDay(today); days.length < 5; d = addDays(d, 1)) if (isWorkday(d)) days.push(d);
  const first = days[0]!;
  const last = days.at(-1)!;

  const items = loadDeadlines(db, `d.state = 'open' AND p.active = 1 AND d.due_date IS NOT NULL
      AND (d.source <> 'jira' OR d.assigned_to_me = 1)`)
    .filter((d) => (d.source === 'jira' ? (d.startDate ?? d.dueDate!) : d.dueDate!) <= last);
  const left = new Map(items.map((d) => [d.id, d.remainingHours ?? null]));

  const plan = days.map((day) => {
    const activities = [];
    for (const d of items) {
      const due = d.dueDate!;
      const overdue = due < first;
      const startsBy = d.source === 'jira' ? (d.startDate ?? due) <= day : true;
      if (!startsBy) continue;
      const remaining = left.get(d.id);
      let hours: number | null;
      if (d.source !== 'jira' || remaining == null) {
        // no estimate to spread: show it on its due day (overdue ones on the first day)
        if (!(due === day || (overdue && day === first))) continue;
        hours = null;
      } else {
        if (!overdue && due < day) continue; // done by its due date
        if (remaining <= 0) continue;
        hours = overdue ? remaining : Math.min(remaining, Math.max(0.25, round(remaining / workdaysInclusive(day, due))));
        left.set(d.id, remaining - hours);
        if (hours <= 0) continue;
      }
      activities.push({
        id: d.id, projectId: d.effProjectId, projectName: d['projectName'] ?? null, epicSummary: d['epicSummary'] ?? null,
        title: d.title, phaseName: d.phaseName ?? null, source: d['source'], url: d['url'] ?? null,
        startDate: d.startDate, dueDate: due, remainingHours: d.remainingHours ?? null, hoursToday: hours,
        overdue, dueToday: due === day, flags: d.flags, openSubtasks: (d['openSubtasks'] as unknown[]) ?? [],
      });
    }
    activities.sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(b.dueToday) - Number(a.dueToday)
      || (b.hoursToday ?? 0) - (a.hoursToday ?? 0) || a.dueDate.localeCompare(b.dueDate));
    const meetings = dayPlan(db, day);
    return {
      day, isToday: day === today, activities,
      activityHours: round(activities.reduce((n, a) => n + (a.hoursToday ?? 0), 0)),
      meetingHours: meetings.meetingHours, meetingCount: meetings.meetings.length,
    };
  });

  return {
    today, from: first, to: last, capacityHours: HOURS_PER_DAY * days.length,
    activityHours: round(plan.reduce((n, d) => n + d.activityHours, 0)),
    meetingHours: round(plan.reduce((n, d) => n + d.meetingHours, 0)),
    days: plan,
  };
}

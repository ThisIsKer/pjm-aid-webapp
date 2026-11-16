import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { I18n, TPipe, jiraReason } from '../../core/i18n';
import type { Dashboard, DayPlan, Meeting, Project, ProjectGroup, Rag } from '../../core/models';
import { FlagBadges } from '../../shared/flag-badges';
import { RagDot } from '../../shared/rag-dot';
import { SyncService } from '../../core/sync';

const SEVERITY: Record<Rag, number> = { red: 0, amber: 1, green: 2, grey: 3 };
const FILTER_KEY = 'pjm.dashGroup';

type ProjectRow =
  | { key: string; header: { name: string | null; color: string | null; count: number }; project?: undefined }
  | { key: string; header?: undefined; project: Project };

@Component({
  selector: 'app-dashboard',
  imports: [DatePipe, RouterLink, RagDot, FlagBadges, TPipe],
  templateUrl: './dashboard.html',
})
export class DashboardPage {
  private readonly sync = inject(SyncService);
  protected readonly i18n = inject(I18n);
  protected readonly data = httpResource<Dashboard>(() => '/api/dashboard');
  protected readonly plan = httpResource<DayPlan>(() => '/api/today');
  protected readonly groups = httpResource<ProjectGroup[]>(() => '/api/groups');
  protected readonly syncMessage = signal<string | null>(null);
  protected readonly onlyMine = signal(false);

  /** '' = all groups, 'none' = ungrouped, otherwise a group id. Remembered in this browser. */
  protected readonly groupFilter = signal<string>(DashboardPage.storedFilter());

  private static storedFilter(): string {
    try {
      return localStorage.getItem(FILTER_KEY) ?? '';
    } catch {
      return '';
    }
  }

  constructor() {
    // reload when a sync (auto or from Settings) ends
    effect(() => {
      if (this.sync.completed()) this.reload();
    });
    effect(() => {
      const v = this.groupFilter();
      try {
        localStorage.setItem(FILTER_KEY, v);
      } catch {
        /* storage unavailable: keep the choice for this session only */
      }
    });
  }

  /** PM projects first, then by Jira severity, then name. */
  protected readonly projects = computed(() =>
    [...(this.data.value()?.projects ?? [])].sort((a: Project, b: Project) =>
      (a.role === b.role ? 0 : a.role === 'pm' ? -1 : 1) || SEVERITY[a.jiraRag] - SEVERITY[b.jiraRag] || a.name.localeCompare(b.name)),
  );

  /** Projects table rows: when custom groups exist, a header row per group (ungrouped last). */
  protected readonly projectRows = computed<ProjectRow[]>(() => {
    const projects = this.projects();
    const groups = this.groups.value() ?? [];
    const filter = this.groupFilter();
    const known = new Set(groups.map((g) => g.id));
    const ungrouped = projects.filter((p) => !p.groupId || !known.has(p.groupId));
    if (!groups.length) return projects.map((p) => ({ key: p.id, project: p }));

    const sections: { id: string; name: string | null; color: string | null; list: Project[] }[] = [
      ...groups.map((g) => ({ id: String(g.id), name: g.name, color: g.color, list: projects.filter((p) => p.groupId === g.id) })),
      { id: 'none', name: null, color: null, list: ungrouped },
    ];
    const rows: ProjectRow[] = [];
    for (const s of sections) {
      if (!s.list.length || (filter && filter !== s.id)) continue;
      rows.push({ key: `h-${s.id}`, header: { name: s.name, color: s.color, count: s.list.length } });
      for (const p of s.list) rows.push({ key: p.id, project: p });
    }
    return rows;
  });

  protected readonly deadlines = computed(() =>
    (this.data.value()?.deadlines ?? []).filter((d) => !this.onlyMine() || d.assignedToMe),
  );

  /** Share of the 8-hour day taken by activities and meetings (for the load bar). */
  protected readonly load = computed(() => {
    const p = this.plan.value();
    if (!p) return null;
    const total = Math.max(p.capacityHours, p.activityHours + p.meetingHours);
    return { activities: (p.activityHours / total) * 100, meetings: (p.meetingHours / total) * 100, over: p.activityHours + p.meetingHours > p.capacityHours };
  });

  /** Phases with no hours left (and not overdue) are folded away: they only need closing in Jira. */
  protected readonly showIdle = signal(false);
  protected readonly activeActivities = computed(() => (this.plan.value()?.activities ?? []).filter((a) => a.overdue || a.hoursToday !== 0));
  protected readonly idleActivities = computed(() => (this.plan.value()?.activities ?? []).filter((a) => !a.overdue && a.hoursToday === 0));

  protected reason = (p: Project) => jiraReason(this.i18n, p);
  protected isTentative = (m: Meeting) => m.showAs === 'tentative';

  protected reload() {
    this.data.reload();
    this.plan.reload();
    this.groups.reload();
  }

}

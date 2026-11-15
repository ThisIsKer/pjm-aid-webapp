import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { I18n, TPipe, jiraReason } from '../../core/i18n';
import type { Dashboard, DayPlan, Meeting, Project, Rag } from '../../core/models';
import { FlagBadges } from '../../shared/flag-badges';
import { RagDot } from '../../shared/rag-dot';
import { SyncButton } from '../../shared/sync-button';

const SEVERITY: Record<Rag, number> = { red: 0, amber: 1, green: 2, grey: 3 };

@Component({
  selector: 'app-dashboard',
  imports: [DatePipe, RouterLink, RagDot, FlagBadges, SyncButton, TPipe],
  templateUrl: './dashboard.html',
})
export class DashboardPage {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly data = httpResource<Dashboard>(() => '/api/dashboard');
  protected readonly plan = httpResource<DayPlan>(() => '/api/today');
  protected readonly syncMessage = signal<string | null>(null);
  protected readonly onlyMine = signal(false);

  /** PM projects first, then by Jira severity, then name. */
  protected readonly projects = computed(() =>
    [...(this.data.value()?.projects ?? [])].sort((a: Project, b: Project) =>
      (a.role === b.role ? 0 : a.role === 'pm' ? -1 : 1) || SEVERITY[a.jiraRag] - SEVERITY[b.jiraRag] || a.name.localeCompare(b.name)),
  );

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
  }

  protected async importSnapshot() {
    const res = await this.api.importSnapshot();
    this.syncMessage.set(res.imported
      ? (res.warnings?.length ? this.i18n.t('dash.importedWarn', { n: res.warnings.length }) : this.i18n.t('dash.imported'))
      : this.i18n.t('dash.nothing'));
    this.reload();
  }
}

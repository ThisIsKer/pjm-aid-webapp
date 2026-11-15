import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import type { Dashboard, Project, Rag } from '../../core/models';
import { FlagBadges } from '../../shared/flag-badges';
import { RagDot } from '../../shared/rag-dot';

const SEVERITY: Record<Rag, number> = { red: 0, amber: 1, green: 2, grey: 3 };

@Component({
  selector: 'app-dashboard',
  imports: [DatePipe, RouterLink, RagDot, FlagBadges],
  templateUrl: './dashboard.html',
})
export class DashboardPage {
  private readonly api = inject(Api);
  protected readonly data = httpResource<Dashboard>(() => '/api/dashboard');
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

  protected async importSnapshot() {
    const res = await this.api.importSnapshot();
    this.syncMessage.set(res.imported ? `Imported${res.warnings?.length ? ` with ${res.warnings.length} warning(s)` : ''}` : (res.reason ?? 'Nothing to import'));
    this.data.reload();
  }
}

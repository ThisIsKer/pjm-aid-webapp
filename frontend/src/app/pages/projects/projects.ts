import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { httpResource } from '@angular/common/http';
import { Api } from '../../core/api';
import type { Project, Rag } from '../../core/models';
import { RagDot } from '../../shared/rag-dot';

@Component({
  selector: 'app-projects',
  imports: [DatePipe, RagDot, RouterLink],
  template: `
    <header class="page-head">
      <h1>Projects</h1>
      <label class="small muted"><input type="checkbox" [checked]="showHidden()" (change)="showHidden.set(!showHidden())" /> show hidden</label>
    </header>
    <p class="muted small">
      One project is created per Jira epic. To group several epics (e.g. a client epic and its "Tecnica" epic) pick the target in
      <em>Group into</em>. Hide projects you don't want on the dashboard.
    </p>
    <div class="card">
      <table>
        <thead>
          <tr><th></th><th>Project</th><th>My status</th><th>Phase</th><th>Jira</th><th>Next due</th><th>Group into</th><th></th></tr>
        </thead>
        <tbody>
          @for (p of projects(); track p.id) {
            <tr [class.muted]="!p.active">
              <td><app-rag-dot [status]="p.status" /></td>
              <td>
                <a class="plain" [routerLink]="['/projects', p.id]"><strong>{{ p.name }}</strong></a>
                @if (p.role === 'contributor') { <span class="badge">contributor</span> }
                <div class="small">@for (k of p.jiraKeys; track k) { <a [href]="jiraUrl(k)" target="_blank">{{ k }}</a>&nbsp; }</div>
              </td>
              <td>
                <select [value]="p.status" (change)="setStatus(p, $any($event.target).value)">
                  @for (s of statuses; track s) { <option [value]="s" [selected]="s === p.status">{{ s }}</option> }
                </select>
              </td>
              <td>{{ p.phase ?? p.currentPhase?.name ?? '—' }}</td>
              <td><span class="badge {{ p.jiraRag }}" [title]="p.jiraRagReason">{{ p.jiraRag === 'grey' ? 'n/a' : p.jiraRag }}</span></td>
              <td>{{ p.nextDeadline ? (p.nextDeadline | date: 'dd/MM/yy') : '—' }}</td>
              <td>
                @if (p.jiraKeys.length) {
                  <select (change)="groupInto(p, $any($event.target).value)">
                    <option value="">—</option>
                    @for (t of targets(); track t.id) { @if (t.id !== p.id) { <option [value]="t.id">{{ t.name }}</option> } }
                  </select>
                }
              </td>
              <td><button (click)="toggleActive(p)">{{ p.active ? 'Hide' : 'Show' }}</button></td>
            </tr>
          } @empty {
            <tr><td colspan="8" class="empty">No projects yet — run the Claude sync.</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class ProjectsPage {
  private readonly api = inject(Api);
  protected readonly statuses: Rag[] = ['green', 'amber', 'red', 'grey'];
  protected readonly showHidden = signal(false);
  protected readonly all = httpResource<Project[]>(() => '/api/projects?all=true');
  protected readonly projects = computed(() => (this.all.value() ?? []).filter((p) => this.showHidden() || p.active));
  protected readonly targets = computed(() => (this.all.value() ?? []).filter((p) => p.active));

  protected jiraUrl = (key: string) => `https://archivagroup.atlassian.net/browse/${key}`;

  protected async setStatus(p: Project, status: Rag) {
    await this.api.updateProject(p.id, { status });
    this.all.reload();
  }

  protected async toggleActive(p: Project) {
    await this.api.updateProject(p.id, { active: !p.active });
    this.all.reload();
  }

  protected async groupInto(p: Project, targetId: string) {
    if (!targetId) return;
    for (const key of p.jiraKeys) await this.api.linkEpic(key, targetId);
    this.all.reload();
  }
}

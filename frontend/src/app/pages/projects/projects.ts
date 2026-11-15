import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { I18n, TPipe, jiraReason } from '../../core/i18n';
import type { Project, Rag } from '../../core/models';
import { RagDot } from '../../shared/rag-dot';

@Component({
  selector: 'app-projects',
  imports: [DatePipe, RagDot, RouterLink, TPipe],
  template: `
    <header class="page-head">
      <h1>{{ 'proj.title' | t }}</h1>
      <label class="small muted"><input type="checkbox" [checked]="showHidden()" (change)="showHidden.set(!showHidden())" /> {{ 'proj.showHidden' | t }}</label>
    </header>
    <p class="muted small">{{ 'proj.help' | t }}</p>
    <div class="card">
      <table>
        <thead>
          <tr><th></th><th>{{ 'col.project' | t }}</th><th>{{ 'col.myStatus' | t }}</th><th>{{ 'col.phase' | t }}</th><th>{{ 'col.jira' | t }}</th>
            <th>{{ 'col.nextDue' | t }}</th><th>{{ 'col.groupInto' | t }}</th><th></th></tr>
        </thead>
        <tbody>
          @for (p of projects(); track p.id) {
            <tr [class.muted]="!p.active">
              <td><app-rag-dot [status]="p.status" /></td>
              <td>
                <a class="plain" [routerLink]="['/projects', p.id]"><strong>{{ p.name }}</strong></a>
                @if (p.role === 'contributor') { <span class="badge">{{ 'common.contributor' | t }}</span> }
                <div class="small">@for (k of p.jiraKeys; track k) { <a [href]="jiraUrl(k)" target="_blank">{{ k }}</a>&nbsp; }</div>
              </td>
              <td>
                <select (change)="setStatus(p, $any($event.target).value)">
                  @for (s of statuses; track s) { <option [value]="s" [selected]="s === p.status">{{ 'rag.' + s | t }}</option> }
                </select>
              </td>
              <td>{{ p.phase ?? p.currentPhase?.name ?? '—' }}</td>
              <td><span class="badge {{ p.jiraRag }}" [title]="reason(p)">{{ 'rag.' + p.jiraRag | t }}</span></td>
              <td>{{ p.nextDeadline ? (p.nextDeadline | date: 'dd/MM/yy' : undefined : i18n.locale()) : '—' }}</td>
              <td>
                @if (p.jiraKeys.length) {
                  <select (change)="groupInto(p, $any($event.target).value)">
                    <option value="">—</option>
                    @for (t of targets(); track t.id) { @if (t.id !== p.id) { <option [value]="t.id">{{ t.name }}</option> } }
                  </select>
                }
              </td>
              <td><button (click)="toggleActive(p)">{{ (p.active ? 'common.hide' : 'common.show') | t }}</button></td>
            </tr>
          } @empty {
            <tr><td colspan="8" class="empty">{{ 'proj.empty' | t }}</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class ProjectsPage {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly statuses: Rag[] = ['green', 'amber', 'red', 'grey'];
  protected readonly showHidden = signal(false);
  protected readonly all = httpResource<Project[]>(() => '/api/projects?all=true');
  protected readonly projects = computed(() => (this.all.value() ?? []).filter((p) => this.showHidden() || p.active));
  protected readonly targets = computed(() => (this.all.value() ?? []).filter((p) => p.active));

  protected jiraUrl = (key: string) => `https://archivagroup.atlassian.net/browse/${key}`;
  protected reason = (p: Project) => jiraReason(this.i18n, p);

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

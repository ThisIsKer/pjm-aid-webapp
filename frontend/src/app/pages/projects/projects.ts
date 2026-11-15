import { Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Api } from '../../core/api';
import type { Project, Rag } from '../../core/models';
import { RagDot } from '../../shared/rag-dot';

@Component({
  selector: 'app-projects',
  imports: [DatePipe, RagDot],
  template: `
    <header class="page-head"><h1>Projects</h1></header>
    <div class="card">
      <table>
        <thead>
          <tr><th></th><th>Project</th><th>Status</th><th>Phase</th><th>Jira</th><th>Docs</th><th>Next deadline</th></tr>
        </thead>
        <tbody>
          @for (p of projects.value() ?? []; track p.id) {
            <tr>
              <td><app-rag-dot [status]="p.status" /></td>
              <td><strong>{{ p.name }}</strong><div class="muted small">{{ p.client }}</div></td>
              <td>
                <select [value]="p.status" (change)="setStatus(p, $any($event.target).value)">
                  @for (s of statuses; track s) { <option [value]="s">{{ s }}</option> }
                </select>
              </td>
              <td>{{ p.phase ?? '—' }}</td>
              <td class="small">{{ p.jiraKeys.join(', ') || '—' }}</td>
              <td class="small">
                @if (p.sharepointUrl) { <a [href]="p.sharepointUrl" target="_blank">SharePoint</a> }
                @if (p.confluenceSpace) { <span class="muted"> · Confluence {{ p.confluenceSpace }}</span> }
              </td>
              <td>{{ p.nextDeadline ? (p.nextDeadline | date: 'dd/MM/yyyy') : '—' }}</td>
            </tr>
          } @empty {
            <tr><td colspan="7" class="empty">No projects. Add them to data/seed.json.</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class ProjectsPage {
  private readonly api = inject(Api);
  protected readonly statuses: Rag[] = ['green', 'amber', 'red', 'grey'];
  protected readonly projects = httpResource<Project[]>(() => '/api/projects');

  protected async setStatus(p: Project, status: Rag) {
    await this.api.updateProject(p.id, { status });
    this.projects.reload();
  }
}

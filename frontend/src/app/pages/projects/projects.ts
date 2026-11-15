import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { I18n, TPipe, jiraReason } from '../../core/i18n';
import type { Project, ProjectGroup, Rag } from '../../core/models';
import { GroupDialog } from '../../shared/group-dialog';
import { RagDot } from '../../shared/rag-dot';

const NEW_GROUP = '__new__';

@Component({
  selector: 'app-projects',
  imports: [DatePipe, RagDot, RouterLink, TPipe, GroupDialog],
  template: `
    <header class="page-head">
      <h1>{{ 'proj.title' | t }}</h1>
      <div class="meta">
        <label class="small muted"><input type="checkbox" [checked]="showHidden()" (change)="showHidden.set(!showHidden())" /> {{ 'proj.showHidden' | t }}</label>
        <button class="primary" (click)="dialog.open()">+ {{ 'grp.new' | t }}</button>
      </div>
    </header>
    <p class="muted small">{{ 'proj.help' | t }}</p>

    @if (groups.value()?.length) {
      <div class="group-chips">
        <span class="small muted">{{ 'grp.title' | t }}:</span>
        @for (g of groups.value(); track g.id) {
          <span class="group-chip">
            <span class="group-dot" [style.background]="g.color"></span>{{ g.name }} <span class="muted">{{ g.projectCount }}</span>
            <button (click)="dialog.open(g)" [title]="'grp.edit' | t">✎</button>
            <button (click)="deleteGroup(g)" [title]="'grp.delete' | t">✕</button>
          </span>
        }
      </div>
    }

    @for (s of sections(); track s.key) {
      <div class="card group-section">
        <h2>
          @if (s.group) { <span class="group-dot" [style.background]="s.group.color"></span>{{ s.group.name }} }
          @else { <span class="muted">{{ 'grp.none' | t }}</span> }
          <span class="muted small">· {{ s.projects.length }}</span>
        </h2>
        <table>
          <thead>
            <tr><th></th><th>{{ 'col.project' | t }}</th><th>{{ 'col.myStatus' | t }}</th><th>{{ 'col.phase' | t }}</th><th>{{ 'col.jira' | t }}</th>
              <th>{{ 'col.nextDue' | t }}</th><th>{{ 'col.group' | t }}</th><th>{{ 'col.groupInto' | t }}</th><th></th></tr>
          </thead>
          <tbody>
            @for (p of s.projects; track p.id) {
              <tr [class.muted]="!p.active">
                <td><app-rag-dot [status]="p.status" /></td>
                <td>
                  <a class="plain" [routerLink]="['/projects', p.id]"><strong>{{ p.name }}</strong></a>
                  @if (p.role === 'contributor') { <span class="badge">{{ 'common.contributor' | t }}</span> }
                  <div class="small">@for (k of p.jiraKeys; track k) { <a [href]="jiraUrl(k)" target="_blank">{{ k }}</a>&nbsp; }</div>
                </td>
                <td>
                  <select (change)="setStatus(p, $any($event.target).value)">
                    @for (st of statuses; track st) { <option [value]="st" [selected]="st === p.status">{{ 'rag.' + st | t }}</option> }
                  </select>
                </td>
                <td>{{ p.phase ?? p.currentPhase?.name ?? '—' }}</td>
                <td><span class="badge {{ p.jiraRag }}" [title]="reason(p)">{{ 'rag.' + p.jiraRag | t }}</span></td>
                <td>{{ p.nextDeadline ? (p.nextDeadline | date: 'dd/MM/yy' : undefined : i18n.locale()) : '—' }}</td>
                <td>
                  <select (change)="setGroup(p, $any($event.target))">
                    <option value="" [selected]="!p.groupId">—</option>
                    @for (g of groups.value() ?? []; track g.id) { <option [value]="g.id" [selected]="g.id === p.groupId">{{ g.name }}</option> }
                    <option [value]="newGroup">+ {{ 'grp.new' | t }}…</option>
                  </select>
                </td>
                <td>
                  @if (p.jiraKeys.length) {
                    <select (change)="groupInto(p, $any($event.target).value)" [title]="'proj.mergeHelp' | t">
                      <option value="">—</option>
                      @for (t of targets(); track t.id) { @if (t.id !== p.id) { <option [value]="t.id">{{ t.name }}</option> } }
                    </select>
                  }
                </td>
                <td><button (click)="toggleActive(p)">{{ (p.active ? 'common.hide' : 'common.show') | t }}</button></td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @empty {
      <div class="card empty">{{ 'proj.empty' | t }}</div>
    }
    <app-group-dialog #dialog (saved)="onGroupSaved($event)" />
  `,
})
export class ProjectsPage {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly statuses: Rag[] = ['green', 'amber', 'red', 'grey'];
  protected readonly newGroup = NEW_GROUP;
  protected readonly showHidden = signal(false);
  protected readonly all = httpResource<Project[]>(() => '/api/projects?all=true');
  protected readonly groups = httpResource<ProjectGroup[]>(() => '/api/groups');
  protected readonly projects = computed(() => (this.all.value() ?? []).filter((p) => this.showHidden() || p.active));
  protected readonly targets = computed(() => (this.all.value() ?? []).filter((p) => p.active));

  /** One section per custom group (in the groups' order), then the ungrouped projects. */
  protected readonly sections = computed(() => {
    const projects = this.projects();
    const out: { key: string; group: ProjectGroup | null; projects: Project[] }[] = [];
    for (const g of this.groups.value() ?? []) {
      const list = projects.filter((p) => p.groupId === g.id);
      if (list.length) out.push({ key: `g${g.id}`, group: g, projects: list });
    }
    const rest = projects.filter((p) => !p.groupId || !(this.groups.value() ?? []).some((g) => g.id === p.groupId));
    if (rest.length) out.push({ key: 'none', group: null, projects: rest });
    return out;
  });

  protected jiraUrl = (key: string) => `https://archivagroup.atlassian.net/browse/${key}`;
  protected reason = (p: Project) => jiraReason(this.i18n, p);

  private reload() {
    this.all.reload();
    this.groups.reload();
  }

  protected async setStatus(p: Project, status: Rag) {
    await this.api.updateProject(p.id, { status });
    this.all.reload();
  }

  protected async setGroup(p: Project, select: HTMLSelectElement) {
    if (select.value === NEW_GROUP) {
      select.value = p.groupId ? String(p.groupId) : '';
      this.dialogRef()?.open(null, p.id);
      return;
    }
    await this.api.updateProject(p.id, { groupId: select.value ? Number(select.value) : null });
    this.reload();
  }

  protected async onGroupSaved(e: { group: ProjectGroup; forProject: string | null }) {
    if (e.forProject) await this.api.updateProject(e.forProject, { groupId: e.group.id });
    this.reload();
  }

  protected async deleteGroup(g: ProjectGroup) {
    if (!confirm(this.i18n.t('grp.confirmDelete', { name: g.name }))) return;
    await this.api.deleteGroup(g.id);
    this.reload();
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

  private readonly dialogRef = viewChild(GroupDialog);
}

import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { I18n, TPipe } from '../../core/i18n';
import type { DocRequirement, Project } from '../../core/models';
import { AddDocDialog } from '../../shared/add-doc-dialog';

@Component({
  selector: 'app-docs',
  imports: [DatePipe, RouterLink, TPipe, AddDocDialog],
  template: `
    <header class="page-head">
      <h1>{{ 'docs.title' | t }}</h1>
      <div class="meta">
        <label class="small muted"><input type="checkbox" [checked]="showAll()" (change)="showAll.set(!showAll())" /> {{ 'docs.full' | t }}</label>
        <button class="primary" (click)="addDoc.open()">+ {{ 'doc.add' | t }}</button>
      </div>
    </header>
    <p class="muted small">{{ 'docs.help' | t }}</p>
    @for (g of groups(); track g.projectId) {
      <div class="card" style="margin-bottom: 12px">
        <div class="card-head">
          <h2><a class="plain" [routerLink]="['/projects', g.projectId]">{{ g.projectName }}</a>
            <span class="muted small">· {{ g.projectPhase ?? ('docs.phaseUnknown' | t) }}</span></h2>
          @if (g.folderUrl) { <a class="small" [href]="g.folderUrl" target="_blank">{{ 'pd.spFolder' | t }}</a> }
        </div>
        <table>
          <thead><tr><th>{{ 'col.document' | t }}</th><th>{{ 'col.phase' | t }}</th><th>{{ 'col.where' | t }}</th><th>{{ 'col.status' | t }}</th><th>{{ 'col.checked' | t }}</th><th></th></tr></thead>
          <tbody>
            @for (r of g.docs; track r.id) {
              <tr [class.muted]="!r.required || r.waived">
                <td>{{ r.title }}</td>
                <td class="small">{{ r.phase ?? '—' }}@if (!r.required) { <div>{{ 'doc.dueFrom' | t: { p: r.requiredFrom ?? ('doc.nextPhase' | t) } }}</div> }</td>
                <td class="small">{{ r.repository === 'sharepoint' ? 'SharePoint' : 'Confluence' }}
                  @if (r.locationHint) { <div class="muted">{{ r.locationHint }}</div> }</td>
                <td>
                  @if (r.waived) { <span class="badge">{{ 'doc.waived' | t }}</span> }
                  @else {
                    <span class="badge" [class.red]="r.checkStatus === 'missing'" [class.amber]="r.checkStatus === 'outdated'"
                      [class.green]="r.checkStatus === 'present'">{{ 'doc.status.' + r.checkStatus | t }}</span>
                  }
                  @if (r.foundUrl) { <a class="small" [href]="r.foundUrl" target="_blank"> {{ 'common.open' | t }}</a> }
                </td>
                <td class="small">{{ r.checkedAt ? (r.checkedAt | date: 'dd/MM' : undefined : i18n.locale()) : '—' }}</td>
                <td><button (click)="toggleWaive(r)">{{ (r.waived ? 'doc.restore' : 'doc.notNeeded') | t }}</button></td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @empty {
      <div class="card empty">{{ 'docs.empty' | t }}</div>
    }
    <app-add-doc-dialog #addDoc [projects]="projectOptions()" (added)="docs.reload()" />
  `,
})
export class DocsPage {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly showAll = signal(false);
  protected readonly docs = httpResource<DocRequirement[]>(() => `/api/docs?all=${this.showAll()}`);
  private readonly projects = httpResource<Project[]>(() => '/api/projects');
  protected readonly projectOptions = computed(() =>
    (this.projects.value() ?? []).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)));

  protected readonly groups = computed(() => {
    const map = new Map<string, { projectId: string; projectName: string; projectPhase: string | null; folderUrl: string | null; docs: DocRequirement[] }>();
    for (const d of this.docs.value() ?? []) {
      const g = map.get(d.projectId) ?? { projectId: d.projectId, projectName: d.projectName ?? d.projectId,
        projectPhase: d.projectPhase ?? null, folderUrl: d.projectFolderUrl ?? null, docs: [] };
      g.docs.push(d);
      map.set(d.projectId, g);
    }
    return [...map.values()].sort((a, b) => a.projectName.localeCompare(b.projectName));
  });

  protected async toggleWaive(r: DocRequirement) {
    await this.api.updateDoc(r.id, { waived: !r.waived });
    this.docs.reload();
  }
}

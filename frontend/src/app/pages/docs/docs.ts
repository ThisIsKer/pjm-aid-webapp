import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Api } from '../../core/api';
import type { DocRequirement } from '../../core/models';

@Component({
  selector: 'app-docs',
  imports: [DatePipe],
  template: `
    <header class="page-head">
      <h1>Documentation</h1>
      <label class="small muted"><input type="checkbox" [checked]="showAll()" (change)="showAll.set(!showAll())" /> full checklist</label>
    </header>
    <p class="muted small">
      A document is due once the project reaches the phase it is required from (current phase comes from Jira).
      Claude checks SharePoint / Confluence when you ask it to <em>sync PJM docs</em>. The checklist template lives in <code>data/seed.json</code>.
    </p>
    @for (g of groups(); track g.projectId) {
      <div class="card" style="margin-bottom: 12px">
        <div class="card-head">
          <h2>{{ g.projectName }} <span class="muted small">· {{ g.projectPhase ?? 'phase unknown' }}</span></h2>
          @if (g.folderUrl) { <a class="small" [href]="g.folderUrl" target="_blank">SharePoint folder</a> }
        </div>
        <table>
          <thead><tr><th>Document</th><th>Phase</th><th>Where</th><th>Status</th><th>Checked</th><th></th></tr></thead>
          <tbody>
            @for (r of g.docs; track r.id) {
              <tr [class.muted]="!r.required || r.waived">
                <td>{{ r.title }}</td>
                <td class="small">{{ r.phase ?? '—' }}@if (!r.required) { <div>due from {{ r.requiredFrom ?? 'next phase' }}</div> }</td>
                <td class="small">{{ r.repository === 'sharepoint' ? 'SharePoint' : 'Confluence' }}
                  @if (r.locationHint) { <div class="muted">{{ r.locationHint }}</div> }</td>
                <td>
                  @if (r.waived) { <span class="badge">not needed</span> }
                  @else {
                    <span class="badge" [class.red]="r.checkStatus === 'missing'" [class.amber]="r.checkStatus === 'outdated'"
                      [class.green]="r.checkStatus === 'present'">{{ r.checkStatus === 'unknown' ? 'not checked' : r.checkStatus }}</span>
                  }
                  @if (r.foundUrl) { <a class="small" [href]="r.foundUrl" target="_blank"> open</a> }
                </td>
                <td class="small">{{ r.checkedAt ? (r.checkedAt | date: 'dd/MM') : '—' }}</td>
                <td>
                  <button (click)="toggleWaive(r)" [title]="r.waived ? 'Required again' : 'Not needed for this project'">
                    {{ r.waived ? 'Restore' : 'Not needed' }}
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @empty {
      <div class="card empty">No documentation gaps for the current project phases.</div>
    }
  `,
})
export class DocsPage {
  private readonly api = inject(Api);
  protected readonly showAll = signal(false);
  protected readonly docs = httpResource<DocRequirement[]>(() => `/api/docs?all=${this.showAll()}`);

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

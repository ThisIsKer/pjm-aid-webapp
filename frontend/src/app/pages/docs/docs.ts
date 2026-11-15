import { Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Api } from '../../core/api';
import type { DocRequirement } from '../../core/models';

@Component({
  selector: 'app-docs',
  imports: [DatePipe],
  template: `
    <header class="page-head"><h1>Documentation gaps</h1></header>
    <div class="card">
      <table>
        <thead><tr><th>Project</th><th>Document</th><th>Where</th><th>Status</th><th>Last check</th><th></th></tr></thead>
        <tbody>
          @for (r of docs.value() ?? []; track r.id) {
            <tr>
              <td>{{ r.projectName }}</td>
              <td>{{ r.title }} @if (r.phase) { <div class="muted small">{{ r.phase }}</div> }</td>
              <td class="small">{{ r.repository === 'sharepoint' ? 'SharePoint / Teams' : 'Confluence' }}
                @if (r.locationHint) { <div class="muted">{{ r.locationHint }}</div> }</td>
              <td>
                <span class="badge" [class.red]="r.checkStatus === 'missing'" [class.amber]="r.checkStatus === 'outdated'">{{ r.checkStatus }}</span>
                @if (r.foundUrl) { <a class="small" [href]="r.foundUrl" target="_blank"> open</a> }
              </td>
              <td class="small">{{ r.checkedAt ? (r.checkedAt | date: 'dd/MM HH:mm') : 'never' }}</td>
              <td><button (click)="waive(r)" title="Not needed for this project">Not needed</button></td>
            </tr>
          } @empty {
            <tr><td colspan="6" class="empty">No documentation gaps.</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class DocsPage {
  private readonly api = inject(Api);
  protected readonly docs = httpResource<DocRequirement[]>(() => '/api/docs');

  protected async waive(r: DocRequirement) {
    await this.api.updateDoc(r.id, { waived: true });
    this.docs.reload();
  }
}

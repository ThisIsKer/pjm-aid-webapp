import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { I18n, TPipe } from '../../core/i18n';
import type { DocRequirement, Project } from '../../core/models';
import { SyncService } from '../../core/sync';
import { AddDocDialog } from '../../shared/add-doc-dialog';
import { DocLocation, DocStateBadge } from '../../shared/doc-cells';

interface Tile {
  projectId: string; projectName: string; client: string | null; phase: string | null; folderUrl: string | null;
  docs: DocRequirement[]; missing: number; attention: number; ok: number; total: number;
}

@Component({
  selector: 'app-docs',
  imports: [DatePipe, RouterLink, TPipe, AddDocDialog, DocLocation, DocStateBadge],
  template: `
    <header class="page-head">
      <h1>{{ 'docs.title' | t }}</h1>
      <div class="meta">
        <span class="small"><span class="count-dot red"></span>{{ 'docs.totMissing' | t: { n: totals().missing } }}
          · <span class="count-dot amber"></span>{{ 'docs.totAttention' | t: { n: totals().attention } }}</span>
        <button class="primary" (click)="addDoc.open()">+ {{ 'doc.add' | t }}</button>
      </div>
    </header>
    <p class="muted small">{{ 'docs.help' | t }}</p>

    <div class="doc-tiles">
      @for (g of tiles(); track g.projectId) {
        <button class="doc-tile card" (click)="openTile(g.projectId)" [title]="g.projectName">
          <div class="tile-top">
            <div class="tile-name">{{ g.projectName }}</div>
            <div class="small muted">{{ g.phase ?? ('docs.phaseUnknown' | t) }}</div>
          </div>
          <div class="tile-mid small muted">
            {{ 'docs.okOf' | t: { ok: g.ok, n: g.total } }}
            @if (!g.folderUrl) { <div class="warn-text">{{ 'docs.noFolderShort' | t }}</div> }
          </div>
          <div class="tile-bottom">
            <span class="tile-count red" [class.zero]="!g.missing"><b>{{ g.missing }}</b>{{ 'docs.missing' | t }}</span>
            <span class="tile-count amber" [class.zero]="!g.attention"><b>{{ g.attention }}</b>{{ 'docs.attention' | t }}</span>
          </div>
        </button>
      } @empty {
        <div class="card empty">{{ 'docs.empty' | t }}</div>
      }
    </div>

    <dialog #detail class="dialog docs-dialog" (close)="selectedId.set(null)">
      @if (selected(); as g) {
        <div class="dialog-head">
          <div>
            <h2><a class="plain" [routerLink]="['/projects', g.projectId]" (click)="close()">{{ g.projectName }}</a>
              <span class="muted small">· {{ g.phase ?? ('docs.phaseUnknown' | t) }}</span></h2>
            <div class="small">
              @if (g.folderUrl) { <a [href]="g.folderUrl" target="_blank">{{ 'pd.spFolder' | t }}</a> }
              @else { <span class="muted">{{ 'docs.noFolder' | t }}</span> }
            </div>
          </div>
          <div class="meta">
            <button (click)="addDoc.open(g.projectId)">+ {{ 'doc.add' | t }}</button>
            <button (click)="close()">{{ 'common.closeCap' | t }}</button>
          </div>
        </div>
        <div class="dialog-body">
          <table>
            <thead><tr><th>{{ 'col.document' | t }}</th><th>{{ 'col.where' | t }}</th><th>{{ 'col.status' | t }}</th>
              <th>{{ 'col.checked' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (r of g.docs; track r.id) {
                <tr [class.muted]="r.waived">
                  <td>{{ r.title }}
                    <div class="small muted">{{ r.phase ?? '—' }}@if (!r.required) { · {{ 'doc.dueFrom' | t: { p: r.requiredFrom ?? ('doc.nextPhase' | t) } }} }</div></td>
                  <td class="small"><app-doc-location [doc]="r" [folderUrl]="g.folderUrl" /></td>
                  <td><app-doc-state [doc]="r" /></td>
                  <td class="small">{{ r.checkedAt ? (r.checkedAt | date: 'dd/MM/yy' : undefined : i18n.locale()) : '—' }}</td>
                  <td class="actions">
                    @if (!r.waived) {
                      <button class="ok-btn" [class.on]="r.state === 'ok'" (click)="toggleOk(r)"
                        [title]="(r.state === 'ok' ? 'doc.okUndo' : 'doc.okHelp') | t">{{ r.state === 'ok' ? '✓ Ok' : 'Ok' }}</button>
                    }
                    <button (click)="toggleWaive(r)">{{ (r.waived ? 'doc.restore' : 'doc.notNeeded') | t }}</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </dialog>
    <app-add-doc-dialog #addDoc [projects]="projectOptions()" (added)="docs.reload()" />
  `,
})
export class DocsPage {
  private readonly api = inject(Api);
  private readonly sync = inject(SyncService);
  protected readonly i18n = inject(I18n);
  protected readonly docs = httpResource<DocRequirement[]>(() => '/api/docs?all=true');
  private readonly projects = httpResource<Project[]>(() => '/api/projects');
  protected readonly selectedId = signal<string | null>(null);
  private readonly detail = viewChild.required<ElementRef<HTMLDialogElement>>('detail');

  protected readonly projectOptions = computed(() =>
    (this.projects.value() ?? []).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)));

  /** One tile per active project: red = missing docs that are due, yellow = found for the first time or updated. */
  protected readonly tiles = computed<Tile[]>(() => {
    const map = new Map<string, Tile>();
    for (const d of this.docs.value() ?? []) {
      const t = map.get(d.projectId) ?? { projectId: d.projectId, projectName: d.projectName ?? d.projectId,
        client: d.projectClient ?? null, phase: d.projectPhase ?? null, folderUrl: d.projectFolderUrl ?? null,
        docs: [], missing: 0, attention: 0, ok: 0, total: 0 };
      t.docs.push(d);
      if (d.state === 'missing' && d.required) t.missing++;
      if (d.state === 'new' || d.state === 'updated') t.attention++;
      if (!d.waived) t.total++;
      if (d.state === 'ok') t.ok++;
      map.set(d.projectId, t);
    }
    return [...map.values()].sort((a, b) => b.missing - a.missing || b.attention - a.attention || a.projectName.localeCompare(b.projectName));
  });

  protected readonly totals = computed(() => this.tiles().reduce((s, t) => ({ missing: s.missing + t.missing, attention: s.attention + t.attention }),
    { missing: 0, attention: 0 }));
  protected readonly selected = computed(() => this.tiles().find((t) => t.projectId === this.selectedId()) ?? null);

  constructor() {
    effect(() => {
      if (this.sync.completed()) this.docs.reload();
    });
  }

  protected openTile(id: string) {
    this.selectedId.set(id);
    this.detail().nativeElement.showModal();
  }

  protected close() {
    this.detail().nativeElement.close();
  }

  protected async toggleWaive(r: DocRequirement) {
    await this.api.updateDoc(r.id, { waived: !r.waived });
    this.docs.reload();
  }

  protected async toggleOk(r: DocRequirement) {
    await this.api.updateDoc(r.id, { confirmed: r.state !== 'ok' });
    this.docs.reload();
  }
}

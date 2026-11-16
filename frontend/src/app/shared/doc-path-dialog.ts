import { Component, ElementRef, computed, inject, output, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Api } from '../core/api';
import { I18n, TPipe } from '../core/i18n';
import type { DocRequirement, ProjectFile, ProjectFiles } from '../core/models';

/**
 * "Where is this document?": browse the project's SharePoint folder (as listed by Claude's last documentation
 * check) and pick the file, or type a path below the project folder / paste a link.
 */
@Component({
  selector: 'app-doc-path-dialog',
  imports: [DatePipe, TPipe],
  template: `
    <dialog #dlg class="dialog path-dialog" (close)="doc.set(null)">
      @if (doc(); as d) {
        <form method="dialog" (submit)="$event.preventDefault(); save()">
          <h2>{{ 'path.title' | t: { t: d.title } }}</h2>
          <div class="segmented small-seg">
            <button type="button" [class.on]="tab() === 'browse'" (click)="tab.set('browse')">{{ 'path.browse' | t }}</button>
            <button type="button" [class.on]="tab() === 'manual'" (click)="tab.set('manual')">{{ 'path.manual' | t }}</button>
          </div>

          @if (tab() === 'browse') {
            @if (!files().length) {
              <div class="note small">{{ (loading() ? 'path.loading' : 'path.noListing') | t }}</div>
            } @else {
              <input class="path-filter" type="search" [value]="filter()" (input)="filter.set($any($event.target).value)"
                [placeholder]="'path.search' | t" />
              @if (!filter()) {
                <nav class="crumbs small">
                  <button type="button" class="link" (click)="cwd.set('')">{{ 'doc.projectFolder' | t }}</button>
                  @for (c of crumbs(); track c.path) { › <button type="button" class="link" (click)="cwd.set(c.path)">{{ c.name }}</button> }
                </nav>
              }
              <ul class="file-list">
                @if (!filter()) {
                  @if (cwd()) {
                    <li class="folder" (click)="up()"><span class="ico">↰</span><span class="name">..</span></li>
                  }
                  @for (f of folders(); track f.path) {
                    <li class="folder" (click)="cwd.set(f.path)">
                      <svg class="ico" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" /></svg>
                      <span class="name">{{ f.name }}</span><span class="muted small">{{ 'path.files' | t: { n: f.count } }}</span>
                    </li>
                  }
                }
                @for (f of shownFiles(); track f.path) {
                  <li class="file" [class.selected]="selected() === f.path" (click)="selected.set(f.path)" (dblclick)="selected.set(f.path); save()">
                    <svg class="ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                    <span class="name">{{ baseName(f.path) }}
                      @if (filter()) { <span class="muted small"> · {{ dirName(f.path) || ('doc.projectFolder' | t) }}</span> }</span>
                    <span class="muted small">{{ f.modifiedAt ? (f.modifiedAt | date: 'dd/MM/yy' : undefined : i18n.locale()) : '' }}</span>
                  </li>
                } @empty {
                  @if (filter() || !folders().length) { <li class="muted small empty-row">{{ 'path.emptyFolder' | t }}</li> }
                }
              </ul>
              <div class="small muted">
                {{ (listing()?.source === 'local' ? 'path.listedLocal' : 'path.listedOn') | t: { d: (listing()?.scannedAt | date: 'dd/MM/yy HH:mm' : undefined : i18n.locale()) } }}
                @if (listing()?.folderUrl) { · <a [href]="listing()!.folderUrl" target="_blank">{{ 'path.openSp' | t }}</a> }
              </div>
            }
          } @else {
            <label class="form-label">{{ 'path.manualLabel' | t }}
              <input [value]="manual()" (input)="manual.set($any($event.target).value)" [placeholder]="'path.manualPh' | t" />
            </label>
            <div class="small muted">
              @if (listing()?.folderUrl) { {{ 'path.relativeTo' | t }} <a [href]="listing()!.folderUrl" target="_blank">{{ folderLabel() }}</a> }
              @else { {{ 'path.noFolder' | t }} }
            </div>
          }

          @if (error()) { <div class="error small">{{ error() }}</div> }
          <div class="dialog-actions">
            @if (d.pinned) { <button type="button" class="link small" (click)="clear()" style="margin-right:auto">{{ 'path.auto' | t }}</button> }
            <button type="button" (click)="close()">{{ 'common.cancel' | t }}</button>
            <button type="submit" class="primary" [disabled]="saving() || !canSave()">{{ 'common.save' | t }}</button>
          </div>
        </form>
      }
    </dialog>
  `,
})
export class DocPathDialog {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  readonly saved = output<void>();
  protected readonly doc = signal<DocRequirement | null>(null);
  protected readonly listing = signal<ProjectFiles | null>(null);
  protected readonly loading = signal(false);
  protected readonly tab = signal<'browse' | 'manual'>('browse');
  protected readonly cwd = signal('');
  protected readonly filter = signal('');
  protected readonly selected = signal<string | null>(null);
  protected readonly manual = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  protected readonly files = computed<ProjectFile[]>(() => this.listing()?.files ?? []);
  protected readonly crumbs = computed(() => {
    const parts = this.cwd() ? this.cwd().split('/') : [];
    return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
  });
  /** Sub-folders of the current folder, with the number of files below each. */
  protected readonly folders = computed(() => {
    const prefix = this.cwd() ? `${this.cwd()}/` : '';
    const map = new Map<string, number>();
    for (const f of this.files()) {
      if (!f.path.startsWith(prefix)) continue;
      const rest = f.path.slice(prefix.length).split('/');
      if (rest.length > 1) map.set(rest[0]!, (map.get(rest[0]!) ?? 0) + 1);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([name, count]) => ({ name, count, path: prefix + name }));
  });
  protected readonly shownFiles = computed(() => {
    const q = this.filter().trim().toLowerCase();
    if (q) return this.files().filter((f) => f.path.toLowerCase().includes(q)).slice(0, 200);
    const prefix = this.cwd() ? `${this.cwd()}/` : '';
    return this.files().filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('/'))
      .sort((a, b) => a.path.localeCompare(b.path));
  });
  protected readonly folderLabel = computed(() => {
    const u = this.listing()?.folderUrl ?? '';
    try {
      return decodeURIComponent(u).split('/Progetti Clienti/')[1] ?? decodeURIComponent(u);
    } catch {
      return u;
    }
  });
  protected readonly canSave = computed(() => (this.tab() === 'browse' ? !!this.selected() : !!this.manual().trim()));

  protected baseName = (p: string) => p.split('/').at(-1) ?? p;
  protected dirName = (p: string) => p.split('/').slice(0, -1).join(' › ');

  async open(doc: DocRequirement) {
    this.doc.set(doc);
    this.error.set(null);
    this.filter.set('');
    this.selected.set(doc.foundPath ?? null);
    this.cwd.set(doc.foundPath ? doc.foundPath.split('/').slice(0, -1).join('/') : '');
    this.manual.set(doc.foundPath ?? doc.foundUrl ?? '');
    this.listing.set(null);
    this.loading.set(true);
    this.dlg().nativeElement.showModal();
    try {
      const l = await this.api.projectFiles(doc.projectId);
      this.listing.set(l);
      if (!l.files.length) this.tab.set('manual');
      else {
        this.tab.set('browse');
        // the chosen file may not be in the listing (typed by hand): start from the root then
        if (doc.foundPath && !l.files.some((f) => f.path === doc.foundPath)) this.cwd.set('');
      }
    } catch {
      this.tab.set('manual');
    } finally {
      this.loading.set(false);
    }
  }

  close() {
    this.dlg().nativeElement.close();
  }

  protected up() {
    this.cwd.set(this.cwd().split('/').slice(0, -1).join('/'));
  }

  protected async save() {
    const d = this.doc();
    if (!d || !this.canSave()) return;
    const location = this.tab() === 'browse' ? this.selected()! : this.manual().trim();
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.api.setDocLocation(d.id, location);
      this.saved.emit();
      this.close();
    } catch (err: any) {
      this.error.set(err?.error?.error ?? String(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected async clear() {
    const d = this.doc();
    if (!d) return;
    await this.api.clearDocLocation(d.id);
    this.saved.emit();
    this.close();
  }
}

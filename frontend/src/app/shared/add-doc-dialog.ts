import { Component, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { Api } from '../core/api';
import { I18n, TPipe } from '../core/i18n';

export const PHASES = ['Analisi', 'Implementazione', 'Test interni', 'UAT', 'Live', 'Post GoLive'];

/** Pop-up form to add a document to a project's checklist (optionally already present, with its link). */
@Component({
  selector: 'app-add-doc-dialog',
  imports: [TPipe],
  template: `
    <dialog #dlg class="dialog" (close)="reset()">
      <form method="dialog" (submit)="$event.preventDefault(); submit()">
        <h2>{{ 'dlg.title' | t }}</h2>
        <div class="form">
          @if (!projectId()) {
            <label>{{ 'dlg.project' | t }} *
              <select (change)="project.set($any($event.target).value)">
                <option value="" [selected]="!project()">{{ 'dlg.choose' | t }}</option>
                @for (p of projects(); track p.id) { <option [value]="p.id" [selected]="project() === p.id">{{ p.name }}</option> }
              </select>
            </label>
          }
          <label>{{ 'dlg.docTitle' | t }} *
            <input [value]="title()" (input)="title.set($any($event.target).value)" [placeholder]="'dlg.titlePh' | t" />
          </label>
          <div class="row">
            <label>{{ 'dlg.phase' | t }}
              <select (change)="phase.set($any($event.target).value)">
                <option value="" [selected]="!phase()">—</option>
                @for (ph of phases; track ph) { <option [value]="ph" [selected]="phase() === ph">{{ ph }}</option> }
              </select>
            </label>
            <label>{{ 'dlg.requiredFrom' | t }}
              <select (change)="requiredFrom.set($any($event.target).value)">
                <option value="" [selected]="!requiredFrom()">{{ 'dlg.defaultNext' | t }}</option>
                @for (ph of phases; track ph) { <option [value]="ph" [selected]="requiredFrom() === ph">{{ ph }}</option> }
              </select>
            </label>
          </div>
          <div class="row">
            <label>{{ 'dlg.repo' | t }}
              <select (change)="repository.set($any($event.target).value)">
                <option value="sharepoint" [selected]="repository() === 'sharepoint'">SharePoint / Teams</option>
                <option value="confluence" [selected]="repository() === 'confluence'">Confluence</option>
              </select>
            </label>
            <label>{{ 'dlg.location' | t }}
              <input [value]="location()" (input)="location.set($any($event.target).value)" [placeholder]="'dlg.locationPh' | t" />
            </label>
          </div>
          <label>{{ 'dlg.link' | t }}
            <input type="url" [value]="link()" (input)="link.set($any($event.target).value)" placeholder="https://…" />
            <span class="muted small">{{ 'dlg.linkHelp' | t }}</span>
          </label>
          @if (error()) { <div class="error small">{{ error() }}</div> }
        </div>
        <div class="dialog-actions">
          <button type="button" (click)="close()">{{ 'common.cancel' | t }}</button>
          <button type="submit" class="primary" [disabled]="saving()">{{ 'common.add' | t }}</button>
        </div>
      </form>
    </dialog>
  `,
})
export class AddDocDialog {
  private readonly api = inject(Api);
  private readonly i18n = inject(I18n);
  /** Fixed project (project page); when empty the form shows a project picker. */
  readonly projectId = input<string | null>(null);
  readonly projects = input<{ id: string; name: string }[]>([]);
  readonly added = output<void>();
  protected readonly phases = PHASES;
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  protected readonly project = signal('');
  protected readonly title = signal('');
  protected readonly phase = signal('');
  protected readonly requiredFrom = signal('');
  protected readonly repository = signal<'sharepoint' | 'confluence'>('sharepoint');
  protected readonly location = signal('');
  protected readonly link = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);

  open(projectId?: string) {
    this.reset();
    if (projectId) this.project.set(projectId);
    this.dlg().nativeElement.showModal();
  }

  close() {
    this.dlg().nativeElement.close();
  }

  protected reset() {
    this.project.set('');
    this.title.set('');
    this.phase.set('');
    this.requiredFrom.set('');
    this.repository.set('sharepoint');
    this.location.set('');
    this.link.set('');
    this.error.set(null);
  }

  protected async submit() {
    const projectId = this.projectId() ?? this.project();
    if (!projectId || !this.title().trim()) {
      this.error.set(this.i18n.t('dlg.missing'));
      return;
    }
    this.saving.set(true);
    try {
      await this.api.addDoc(projectId, {
        title: this.title().trim(), phase: this.phase() || undefined, requiredFrom: this.requiredFrom() || undefined,
        repository: this.repository(), locationHint: this.location().trim() || undefined, foundUrl: this.link().trim() || undefined,
      });
      this.close();
      this.added.emit();
    } catch (err: any) {
      this.error.set(err?.status === 409 ? this.i18n.t('dlg.exists') : (err?.error?.error ?? String(err)));
    } finally {
      this.saving.set(false);
    }
  }
}

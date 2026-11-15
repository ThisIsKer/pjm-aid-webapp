import { Component, ElementRef, inject, output, signal, viewChild } from '@angular/core';
import { Api } from '../core/api';
import { I18n, TPipe } from '../core/i18n';
import type { ProjectGroup } from '../core/models';

export const GROUP_COLORS = ['#5b7cfa', '#2bb3a3', '#e2a94a', '#e06c75', '#a37cf0', '#4cbb85', '#d97ac9', '#8a94a8'];

/** Create or rename a custom project group (name + colour). */
@Component({
  selector: 'app-group-dialog',
  imports: [TPipe],
  template: `
    <dialog #dlg class="dialog">
      <form method="dialog" (submit)="$event.preventDefault(); submit()">
        <h2>{{ (editing() ? 'grp.edit' : 'grp.new') | t }}</h2>
        <div class="form">
          <label>{{ 'grp.name' | t }} *
            <input [value]="name()" (input)="name.set($any($event.target).value)" [placeholder]="'grp.namePh' | t" />
          </label>
          <label>{{ 'grp.color' | t }}
            <span class="swatches">
              @for (c of colors; track c) {
                <button type="button" class="swatch" [class.on]="color() === c" [style.background]="c" (click)="color.set(c)" [attr.aria-label]="c"></button>
              }
            </span>
          </label>
          @if (error()) { <div class="error small">{{ error() }}</div> }
        </div>
        <div class="dialog-actions">
          <button type="button" (click)="close()">{{ 'common.cancel' | t }}</button>
          <button type="submit" class="primary">{{ (editing() ? 'common.save' : 'common.add') | t }}</button>
        </div>
      </form>
    </dialog>
  `,
})
export class GroupDialog {
  private readonly api = inject(Api);
  private readonly i18n = inject(I18n);
  /** Emits the saved group (and, for a new group, the project it was created for). */
  readonly saved = output<{ group: ProjectGroup; forProject: string | null }>();
  protected readonly colors = GROUP_COLORS;
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  protected readonly editing = signal<ProjectGroup | null>(null);
  protected readonly name = signal('');
  protected readonly color = signal(GROUP_COLORS[0]!);
  protected readonly error = signal<string | null>(null);
  private forProject: string | null = null;

  /** New group (optionally to assign straight away to a project) or rename/recolour an existing one. */
  open(group: ProjectGroup | null = null, forProject: string | null = null) {
    this.editing.set(group);
    this.forProject = forProject;
    this.name.set(group?.name ?? '');
    this.color.set(group?.color ?? GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)]!);
    this.error.set(null);
    this.dlg().nativeElement.showModal();
  }

  close() {
    this.dlg().nativeElement.close();
  }

  protected async submit() {
    const name = this.name().trim();
    if (!name) {
      this.error.set(this.i18n.t('grp.nameRequired'));
      return;
    }
    try {
      const g = this.editing();
      const group = g
        ? await this.api.updateGroup(g.id, { name, color: this.color() })
        : await this.api.createGroup(name, this.color());
      this.close();
      this.saved.emit({ group, forProject: this.forProject });
    } catch (err: any) {
      this.error.set(String(err?.error?.error ?? err).includes('UNIQUE') ? this.i18n.t('grp.exists') : (err?.error?.error ?? String(err)));
    }
  }
}

import { Component, computed, inject, input, output } from '@angular/core';
import { formatDate } from '@angular/common';
import { I18n, TPipe } from '../core/i18n';
import type { DocRequirement } from '../core/models';

/**
 * "Where" cell: the file Claude found in the project folder on SharePoint
 * (Delivery › Progetti Clienti › <client> › <year> › <project>), with link, sub-folder and last change;
 * otherwise where it is expected.
 */
@Component({
  selector: 'app-doc-location',
  imports: [TPipe],
  template: `
    @let d = doc();
    <div class="doc-loc">
    <div class="doc-loc-body">
    @if (d.foundUrl) {
      @if (d.pinned && d.checkStatus === 'missing') { <span class="red-text">{{ 'doc.goneFrom' | t }}</span> }
      <a [href]="d.foundUrl" target="_blank" [title]="d.foundPath ?? d.foundUrl">{{ fileName() }}</a>
      @if (meta()) { <div class="muted" [title]="d.pinned ? ('doc.pinned' | t) : ''">{{ meta() }}</div> }
    } @else if (d.repository === 'confluence') {
      Confluence @if (d.locationHint) { <div class="muted">{{ d.locationHint }}</div> }
    } @else if (folderUrl()) {
      @if (d.state === 'missing') { {{ 'doc.notFoundIn' | t }} } @else { {{ 'doc.expectedIn' | t }} }
      <a [href]="folderUrl()" target="_blank">{{ 'doc.projectFolder' | t }}</a>
      @if (d.locationHint) { <div class="muted">{{ 'doc.expected' | t: { h: d.locationHint } }}</div> }
    } @else {
      <span class="muted">{{ 'docs.noFolder' | t }}</span>
      @if (d.locationHint) { <div class="muted">{{ 'doc.expected' | t: { h: d.locationHint } }}</div> }
    }
    </div>
    @if (editable()) {
      <button type="button" class="icon-btn" (click)="edit.emit()" [title]="'doc.editPath' | t" [attr.aria-label]="'doc.editPath' | t">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
      </button>
    }
    </div>
  `,
})
export class DocLocation {
  protected readonly i18n = inject(I18n);
  readonly doc = input.required<DocRequirement>();
  readonly folderUrl = input<string | null>(null);
  /** Shows the pencil that opens the location dialog. */
  readonly editable = input(true);
  readonly edit = output<void>();
  private readonly parts = computed(() => {
    const d = this.doc();
    const path = d.foundPath ?? decode(d.foundUrl ?? '').split('/').slice(-1)[0] ?? '';
    return path.split('/').filter(Boolean);
  });
  protected readonly fileName = computed(() => this.parts().at(-1) ?? this.i18n.t('common.open'));
  protected readonly folderPath = computed(() => this.parts().slice(0, -1).join(' › '));
  /** Sub-folder · Confluence · last change · "chosen by you" (only the parts that apply). */
  protected readonly meta = computed(() => {
    const d = this.doc();
    return [
      this.folderPath(),
      d.repository === 'confluence' ? 'Confluence' : '',
      d.foundModifiedAt ? this.i18n.t('doc.modified', { d: formatDate(d.foundModifiedAt, 'dd/MM/yy', this.i18n.locale()) }) : '',
      d.pinned ? this.i18n.t('doc.pinnedShort') : '',
    ].filter(Boolean).join(' · ');
  });
}

/** Status badge: Ok (confirmed) · New / Updated (needs a look) · Missing · Not checked · Not needed. */
@Component({
  selector: 'app-doc-state',
  imports: [TPipe],
  template: `
    @let d = doc();
    <span class="badge" [class.green]="d.state === 'ok'" [class.amber]="d.state === 'new' || d.state === 'updated'"
      [class.red]="d.state === 'missing' && d.required">{{ 'doc.state.' + d.state | t }}</span>
    @if (d.state === 'missing' && !d.required) { <div class="small muted">{{ 'doc.notDueYet' | t }}</div> }
  `,
})
export class DocStateBadge {
  readonly doc = input.required<DocRequirement>();
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

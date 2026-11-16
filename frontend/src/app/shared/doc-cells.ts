import { Component, computed, inject, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { I18n, TPipe } from '../core/i18n';
import type { DocRequirement } from '../core/models';

/**
 * "Where" cell: the file Claude found in the project folder on SharePoint
 * (Delivery › Progetti Clienti › <client> › <year> › <project>), with link, sub-folder and last change;
 * otherwise where it is expected.
 */
@Component({
  selector: 'app-doc-location',
  imports: [DatePipe, TPipe],
  template: `
    @let d = doc();
    @if (d.foundUrl) {
      <a [href]="d.foundUrl" target="_blank" [title]="d.foundPath ?? d.foundUrl">{{ fileName() }}</a>
      <div class="muted">
        @if (folderPath()) { {{ folderPath() }} · }
        @if (d.repository === 'confluence') { Confluence · }
        @if (d.foundModifiedAt) { {{ 'doc.modified' | t: { d: (d.foundModifiedAt | date: 'dd/MM/yy' : undefined : i18n.locale()) } }} }
      </div>
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
  `,
})
export class DocLocation {
  protected readonly i18n = inject(I18n);
  readonly doc = input.required<DocRequirement>();
  readonly folderUrl = input<string | null>(null);
  private readonly parts = computed(() => {
    const d = this.doc();
    const path = d.foundPath ?? decode(d.foundUrl ?? '').split('/').slice(-1)[0] ?? '';
    return path.split('/').filter(Boolean);
  });
  protected readonly fileName = computed(() => this.parts().at(-1) ?? this.i18n.t('common.open'));
  protected readonly folderPath = computed(() => this.parts().slice(0, -1).join(' › '));
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

import { Component, input } from '@angular/core';
import { TPipe } from '../core/i18n';
import type { Rag } from '../core/models';

@Component({
  selector: 'app-rag-dot',
  imports: [TPipe],
  template: `<span class="rag rag-{{ status() }}" [title]="'rag.' + status() | t"></span>`,
})
export class RagDot {
  readonly status = input.required<Rag>();
}

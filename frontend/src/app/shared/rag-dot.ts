import { Component, input } from '@angular/core';
import type { Rag } from '../core/models';

@Component({
  selector: 'app-rag-dot',
  template: `<span class="rag rag-{{ status() }}" [title]="status()"></span>`,
})
export class RagDot {
  readonly status = input.required<Rag>();
}

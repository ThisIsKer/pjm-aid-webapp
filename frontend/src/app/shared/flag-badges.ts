import { Component, input } from '@angular/core';
import { TPipe } from '../core/i18n';
import type { Flag } from '../core/models';

const CLASSES: Record<Flag, string> = {
  overdue: 'red', at_risk: 'amber', missing_due: '', missing_start: '', missing_estimate: '',
};

@Component({
  selector: 'app-flag-badges',
  imports: [TPipe],
  template: `@for (f of flags(); track f) { <span class="badge {{ classes[f] }}">{{ 'flag.' + f | t }}</span> }`,
  styles: `:host { display: inline-flex; gap: 4px; flex-wrap: wrap; }`,
})
export class FlagBadges {
  readonly flags = input.required<Flag[]>();
  protected readonly classes = CLASSES;
}

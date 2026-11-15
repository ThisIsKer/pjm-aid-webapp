import { Component, input } from '@angular/core';
import type { Flag } from '../core/models';

const LABELS: Record<Flag, { text: string; cls: string }> = {
  overdue: { text: 'overdue', cls: 'red' },
  at_risk: { text: 'at risk', cls: 'amber' },
  missing_due: { text: 'no due date', cls: '' },
  missing_start: { text: 'no start date', cls: '' },
  missing_estimate: { text: 'no estimate', cls: '' },
};

@Component({
  selector: 'app-flag-badges',
  template: `@for (f of flags(); track f) { <span class="badge {{ labels[f].cls }}">{{ labels[f].text }}</span> }`,
  styles: `:host { display: inline-flex; gap: 4px; flex-wrap: wrap; }`,
})
export class FlagBadges {
  readonly flags = input.required<Flag[]>();
  protected readonly labels = LABELS;
}

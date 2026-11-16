import { Component, ElementRef, afterRenderEffect, inject, input, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { I18n, TPipe } from '../core/i18n';
import type { SyncJob } from '../core/models';

/** Progress of a "Sync now" job: step list (auto-scrolled), errors, denied tools and Claude's final report. */
@Component({
  selector: 'app-sync-progress',
  imports: [DatePipe, TPipe],
  template: `
    @if (job(); as j) {
      <div class="card-head">
        <strong>
          @if (j.status === 'running') { <span class="spinner" aria-hidden="true"></span> }
          {{ 'sync.state.' + j.status | t }} · <span class="muted">{{ 'sync.mode.' + j.mode | t }}</span>
        </strong>
        <span class="muted small">{{ j.startedAt | date: 'HH:mm:ss' : undefined : i18n.locale() }}@if (j.finishedAt) { – {{ j.finishedAt | date: 'HH:mm:ss' : undefined : i18n.locale() }} }</span>
      </div>
      <ul class="steps small" #steps>
        @for (s of j.steps; track s.at) {
          <li [class.current]="$last && j.status === 'running'">{{ stepLabel(s.label) }}@if (s.count > 1) { <span class="muted"> ×{{ s.count }}</span> }</li>
        }
      </ul>
      @if (j.error) { <div class="error small">{{ j.error }}</div> }
      @if (j.denials.length) {
        @if (j.status === 'ok' && j.imported) {
          <div class="small muted">{{ 'sync.deniedInfo' | t: { l: j.denials.join(' · ') } }}</div>
        } @else {
          <div class="small warn">{{ 'sync.denied' | t: { l: j.denials.join(' · ') } }}</div>
        }
      }
      @if (j.status === 'ok' && !j.imported) { <div class="small warn">{{ 'sync.notImported' | t }}</div> }
      @if (j.resultText && showResult()) { <div class="result small">{{ j.resultText }}</div> }
    }
  `,
})
export class SyncProgress {
  protected readonly i18n = inject(I18n);
  readonly job = input<SyncJob | null>(null);
  readonly showResult = input(true);
  private readonly stepsEl = viewChild<ElementRef<HTMLElement>>('steps');

  constructor() {
    // Keep the step list scrolled to the latest step.
    afterRenderEffect(() => {
      this.job();
      const el = this.stepsEl()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  protected stepLabel(code: string): string {
    const key = `sync.step.${code}`;
    const label = this.i18n.t(key);
    return label === key ? code : label;
  }
}

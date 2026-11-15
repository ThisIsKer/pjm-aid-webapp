import { Component, DestroyRef, ElementRef, afterRenderEffect, inject, output, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Api } from '../core/api';
import { I18n, TPipe } from '../core/i18n';
import type { AgentStatus, SyncJob } from '../core/models';

/** "Sync now": asks the backend to run the pjm-sync skill through Claude Code and follows its progress. */
@Component({
  selector: 'app-sync-button',
  imports: [DatePipe, TPipe],
  template: `
    <div class="sync-now">
      <select (change)="mode.set($any($event.target).value)" [disabled]="running()">
        @for (m of modes; track m) { <option [value]="m" [selected]="mode() === m">{{ 'sync.mode.' + m | t }}</option> }
      </select>
      <button class="primary" (click)="start()" [disabled]="running() || !agent.value()?.available"
        [title]="agent.value()?.available ? ('sync.tooltip' | t: { v: agent.value()?.version }) : ('sync.unavailable' | t)">
        {{ (running() ? 'sync.running' : 'sync.now') | t }}
      </button>
    </div>
    @if (job(); as j) {
      @if (open()) {
        <div class="sync-panel card">
          <div class="card-head">
            <strong>{{ 'sync.state.' + j.status | t }}</strong>
            <span class="muted small">{{ j.startedAt | date: 'HH:mm:ss' : undefined : i18n.locale() }}@if (j.finishedAt) { – {{ j.finishedAt | date: 'HH:mm:ss' : undefined : i18n.locale() }} }
              <button class="link" (click)="open.set(false)">{{ 'common.close' | t }}</button></span>
          </div>
          <ul class="steps small" #steps>
            @for (s of j.steps; track s.at) { <li>{{ stepLabel(s.label) }}@if (s.count > 1) { <span class="muted"> ×{{ s.count }}</span> }</li> }
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
          @if (j.resultText) { <div class="result small" #result>{{ j.resultText }}</div> }
        </div>
      }
    }
  `,
})
export class SyncButton {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  readonly finished = output<void>();
  protected readonly modes: SyncJob['mode'][] = ['daily', 'docs', 'jira'];
  protected readonly agent = httpResource<AgentStatus>(() => '/api/sync/agent');
  protected readonly mode = signal<SyncJob['mode']>('daily');
  protected readonly job = signal<SyncJob | null>(null);
  protected readonly running = signal(false);
  protected readonly open = signal(false);
  private readonly stepsEl = viewChild<ElementRef<HTMLElement>>('steps');
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearInterval(this.timer));
    // Keep the step list scrolled to the latest step.
    afterRenderEffect(() => {
      this.job();
      const el = this.stepsEl()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
    // Pick up a sync started from another tab or before a reload.
    this.api.currentSyncJob().then((j) => {
      if (j?.status === 'running') {
        this.job.set(j);
        this.open.set(true);
        this.follow();
      }
    }).catch(() => undefined);
  }

  protected stepLabel(code: string): string {
    const key = `sync.step.${code}`;
    const label = this.i18n.t(key);
    return label === key ? code : label;
  }

  protected async start() {
    try {
      this.job.set(await this.api.startSync(this.mode(), this.i18n.lang()));
      this.open.set(true);
      this.follow();
    } catch (err: any) {
      this.job.set({ id: 0, mode: this.mode(), status: 'error', startedAt: new Date().toISOString(), steps: [], denials: [],
        error: err?.error?.error ?? this.i18n.t('sync.startError') });
      this.open.set(true);
    }
  }

  private follow() {
    this.running.set(true);
    clearInterval(this.timer);
    this.timer = setInterval(async () => {
      const j = await this.api.currentSyncJob().catch(() => null);
      if (!j) return;
      this.job.set(j);
      if (j.status !== 'running') {
        clearInterval(this.timer);
        this.running.set(false);
        this.finished.emit();
      }
    }, 2000);
  }
}

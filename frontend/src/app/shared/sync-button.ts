import { Component, DestroyRef, inject, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Api } from '../core/api';
import type { AgentStatus, SyncJob } from '../core/models';

/** "Sync now": asks the backend to run the pjm-sync skill through Claude Code and follows its progress. */
@Component({
  selector: 'app-sync-button',
  imports: [DatePipe],
  template: `
    <div class="sync-now">
      <select (change)="mode.set($any($event.target).value)" [disabled]="running()">
        <option value="daily" [selected]="mode() === 'daily'">Jira + mail</option>
        <option value="docs" [selected]="mode() === 'docs'">Jira + mail + docs</option>
        <option value="jira" [selected]="mode() === 'jira'">Jira only</option>
      </select>
      <button class="primary" (click)="start()" [disabled]="running() || !agent.value()?.available"
        [title]="agent.value()?.available ? 'Runs the pjm-sync skill with Claude Code (' + agent.value()?.version + ')' : 'Claude Code not found on this machine'">
        {{ running() ? 'Syncing…' : 'Sync now' }}
      </button>
    </div>
    @if (job(); as j) {
      @if (open()) {
        <div class="sync-panel card">
          <div class="card-head">
            <strong>
              @switch (j.status) {
                @case ('running') { Sync running… }
                @case ('ok') { Sync finished }
                @case ('error') { Sync failed }
              }
            </strong>
            <span class="muted small">{{ j.startedAt | date: 'HH:mm:ss' }}@if (j.finishedAt) { – {{ j.finishedAt | date: 'HH:mm:ss' }} }
              <button class="link" (click)="open.set(false)">close</button></span>
          </div>
          <ul class="steps small">
            @for (s of j.steps; track s.at) { <li>{{ s.label }}@if (s.count > 1) { <span class="muted"> ×{{ s.count }}</span> }</li> }
          </ul>
          @if (j.error) { <div class="error small">{{ j.error }}</div> }
          @if (j.denials.length) {
            <div class="small warn">Tools denied (add them to .claude/settings.json if needed): {{ j.denials.join(', ') }}</div>
          }
          @if (j.resultText) { <div class="result small">{{ j.resultText }}</div> }
        </div>
      }
    }
  `,
})
export class SyncButton {
  private readonly api = inject(Api);
  readonly finished = output<void>();
  protected readonly agent = httpResource<AgentStatus>(() => '/api/sync/agent');
  protected readonly mode = signal<SyncJob['mode']>('daily');
  protected readonly job = signal<SyncJob | null>(null);
  protected readonly running = signal(false);
  protected readonly open = signal(false);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearInterval(this.timer));
    // Pick up a sync started from another tab or before a reload.
    this.api.currentSyncJob().then((j) => {
      if (j?.status === 'running') {
        this.job.set(j);
        this.open.set(true);
        this.follow();
      }
    }).catch(() => undefined);
  }

  protected async start() {
    try {
      this.job.set(await this.api.startSync(this.mode()));
      this.open.set(true);
      this.follow();
    } catch (err: any) {
      this.job.set({ id: 0, mode: this.mode(), status: 'error', startedAt: new Date().toISOString(), steps: [], denials: [],
        error: err?.error?.error ?? 'Could not start the sync' });
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

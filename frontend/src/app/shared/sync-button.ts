import { Component, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { TPipe } from '../core/i18n';
import type { AgentStatus, SyncJob } from '../core/models';
import { SyncService } from '../core/sync';

/** "Sync now": scope selector + button. Progress is shown by <app-sync-progress> (Settings) and the overlay. */
@Component({
  selector: 'app-sync-button',
  imports: [TPipe],
  template: `
    <div class="sync-now">
      <select (change)="mode.set($any($event.target).value)" [disabled]="sync.running()">
        @for (m of modes; track m) { <option [value]="m" [selected]="mode() === m">{{ 'sync.mode.' + m | t }}</option> }
      </select>
      <button class="primary" (click)="sync.start(mode())" [disabled]="sync.running() || !agent.value()?.available"
        [title]="agent.value()?.available ? ('sync.tooltip' | t: { v: agent.value()?.version }) : ('sync.unavailable' | t)">
        {{ (sync.running() ? 'sync.running' : 'sync.now') | t }}
      </button>
    </div>
  `,
})
export class SyncButton {
  protected readonly sync = inject(SyncService);
  protected readonly modes: SyncJob['mode'][] = ['daily', 'docs', 'jira'];
  protected readonly mode = signal<SyncJob['mode']>('daily');
  protected readonly agent = httpResource<AgentStatus>(() => '/api/sync/agent');
}

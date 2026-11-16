import { Component, inject } from '@angular/core';
import { TPipe } from '../core/i18n';
import { SyncService } from '../core/sync';
import { SyncProgress } from './sync-progress';

/** Blocking layer shown while the daily auto-sync (first opening of the day) runs. */
@Component({
  selector: 'app-sync-overlay',
  imports: [SyncProgress, TPipe],
  template: `
    @if (sync.overlay()) {
      <div class="sync-overlay" role="dialog" aria-modal="true" [attr.aria-label]="'auto.title' | t">
        <div class="card sync-overlay-card">
          <div class="overlay-head">
            <div>
              <h2>{{ 'auto.title' | t }}</h2>
              <div class="small muted">{{ 'auto.help' | t }}</div>
            </div>
            <button (click)="sync.overlay.set(false)" [title]="'auto.closeHelp' | t">{{ 'common.closeCap' | t }}</button>
          </div>
          <app-sync-progress [job]="sync.job()" />
        </div>
      </div>
    }
  `,
})
export class SyncOverlay {
  protected readonly sync = inject(SyncService);
}

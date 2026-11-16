import { Component, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Api } from '../../core/api';
import { I18n, TPipe, type Lang } from '../../core/i18n';
import type { AgentStatus } from '../../core/models';
import { SyncService } from '../../core/sync';
import { Theme, type ThemeChoice } from '../../core/theme';
import { SyncButton } from '../../shared/sync-button';
import { SyncProgress } from '../../shared/sync-progress';

@Component({
  selector: 'app-settings',
  imports: [TPipe, DatePipe, SyncButton, SyncProgress],
  template: `
    <header class="page-head"><h1>{{ 'set.title' | t }}</h1></header>
    <div class="settings">
      <div class="card">
        <h2>{{ 'set.sync' | t }}</h2>
        <div class="setting">
          <div>
            <div class="label">{{ 'set.lastSync' | t }}</div>
            <div class="help">{{ 'set.lastSyncHelp' | t }}</div>
          </div>
          <span>{{ health.value()?.lastSync?.generatedAt ? (health.value()!.lastSync!.generatedAt | date: 'EEE dd/MM/yyyy HH:mm' : undefined : i18n.locale()) : '—' }}</span>
        </div>
        <div class="setting">
          <div>
            <div class="label">{{ 'sync.now' | t }}</div>
            <div class="help">{{ agent.value()?.available ? ('sync.tooltip' | t: { v: agent.value()?.version }) : ('sync.unavailable' | t) }}</div>
          </div>
          <app-sync-button />
        </div>
        @if (sync.job()) {
          <div class="sync-panel"><app-sync-progress [job]="sync.job()" /></div>
        }
        <div class="setting">
          <div>
            <div class="label">{{ 'set.auto' | t }}</div>
            <div class="help">{{ 'set.autoHelp' | t }}</div>
            <label class="small"><input type="checkbox" [checked]="sync.docsOnMonday()" [disabled]="!sync.autoEnabled()"
              (change)="sync.setDocsOnMonday(!sync.docsOnMonday())" /> {{ 'set.autoDocsMonday' | t }}</label>
          </div>
          <div class="segmented">
            <button [class.on]="sync.autoEnabled()" (click)="sync.setAuto(true)">{{ 'common.on' | t }}</button>
            <button [class.on]="!sync.autoEnabled()" (click)="sync.setAuto(false)">{{ 'common.off' | t }}</button>
          </div>
        </div>
        <div class="setting">
          <div>
            <div class="label">{{ 'dash.import' | t }}</div>
            <div class="help">{{ 'set.importHelp' | t }}</div>
          </div>
          <div class="sync-now">
            @if (importMessage(); as m) { <span class="small muted">{{ m }}</span> }
            <button (click)="importSnapshot()">{{ 'dash.import' | t }}</button>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>{{ 'set.appearance' | t }}</h2>
        <div class="setting">
          <div>
            <div class="label">{{ 'set.language' | t }}</div>
            <div class="help">{{ 'set.languageHelp' | t }}</div>
          </div>
          <div class="segmented">
            @for (l of langs; track l.id) {
              <button [class.on]="i18n.lang() === l.id" (click)="i18n.setLang(l.id)">{{ l.label }}</button>
            }
          </div>
        </div>
        <div class="setting">
          <div>
            <div class="label">{{ 'set.theme' | t }}</div>
            <div class="help">{{ 'set.themeHelp' | t }}</div>
          </div>
          <div class="segmented">
            @for (c of themes; track c) {
              <button [class.on]="theme.choice() === c" (click)="theme.set(c)">{{ 'set.theme.' + c | t }}</button>
            }
          </div>
        </div>
      </div>

      <div class="card">
        <h2>{{ 'set.claude' | t }}</h2>
        <div class="setting">
          <div>
            <div class="label">Claude Code</div>
            <div class="help">{{ 'set.claudeHelp' | t }}</div>
          </div>
          @if (agent.value(); as a) {
            <span class="badge" [class.green]="a.available" [class.red]="!a.available">
              {{ a.available ? a.version : ('sync.unavailable' | t) }}
            </span>
          }
        </div>
      </div>
    </div>
  `,
})
export class SettingsPage {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly theme = inject(Theme);
  protected readonly sync = inject(SyncService);
  protected readonly langs: { id: Lang; label: string }[] = [{ id: 'it', label: 'Italiano' }, { id: 'en', label: 'English' }];
  protected readonly themes: ThemeChoice[] = ['light', 'dark', 'system'];
  protected readonly importMessage = signal<string | null>(null);
  protected readonly agent = httpResource<AgentStatus>(() => '/api/sync/agent');
  protected readonly health = httpResource<{ lastSync: { generatedAt: string | null } | null }>(() => '/api/health');

  constructor() {
    effect(() => {
      if (this.sync.completed()) this.health.reload();
    });
  }

  protected async importSnapshot() {
    const res = await this.api.importSnapshot();
    this.importMessage.set(res.imported
      ? (res.warnings?.length ? this.i18n.t('dash.importedWarn', { n: res.warnings.length }) : this.i18n.t('dash.imported'))
      : this.i18n.t('dash.nothing'));
    if (res.imported) this.sync.notifyChanged();
  }
}

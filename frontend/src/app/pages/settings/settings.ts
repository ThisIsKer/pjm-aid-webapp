import { Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { I18n, TPipe, type Lang } from '../../core/i18n';
import type { AgentStatus } from '../../core/models';
import { Theme, type ThemeChoice } from '../../core/theme';

@Component({
  selector: 'app-settings',
  imports: [TPipe, DatePipe],
  template: `
    <header class="page-head"><h1>{{ 'set.title' | t }}</h1></header>
    <div class="settings">
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
        <div class="setting">
          <div>
            <div class="label">{{ 'set.lastSync' | t }}</div>
            <div class="help">{{ 'set.lastSyncHelp' | t }}</div>
          </div>
          <span class="muted">{{ health.value()?.lastSync?.generatedAt ? (health.value()!.lastSync!.generatedAt | date: 'dd/MM/yyyy HH:mm' : undefined : i18n.locale()) : '—' }}</span>
        </div>
      </div>
    </div>
  `,
})
export class SettingsPage {
  protected readonly i18n = inject(I18n);
  protected readonly theme = inject(Theme);
  protected readonly langs: { id: Lang; label: string }[] = [{ id: 'it', label: 'Italiano' }, { id: 'en', label: 'English' }];
  protected readonly themes: ThemeChoice[] = ['light', 'dark', 'system'];
  protected readonly agent = httpResource<AgentStatus>(() => '/api/sync/agent');
  protected readonly health = httpResource<{ lastSync: { generatedAt: string | null } | null }>(() => '/api/health');
}

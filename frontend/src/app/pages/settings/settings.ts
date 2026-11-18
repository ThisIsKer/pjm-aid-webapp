import { Component, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Api } from '../../core/api';
import { I18n, TPipe, type Lang } from '../../core/i18n';
import type { AgentStatus, AutoTodoRule, JiraStatus, SpStatus } from '../../core/models';
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
        <h2>{{ 'sp.title' | t }}</h2>
        <p class="help small muted">{{ 'sp.help' | t }}</p>
        @if (sp.value(); as s) {
          <div class="setting">
            <div>
              <div class="label">{{ 'sp.use' | t }}</div>
              <div class="help">
                @if (!s.enabled) { {{ 'sp.off' | t }} }
                @else if (s.available) {
                  <span class="green-text">{{ 'sp.ok' | t: { m: s.mapped, n: s.projects } }}</span>
                  @if (s.lastScanAt) { · {{ 'sp.lastScan' | t: { d: (s.lastScanAt | date: 'dd/MM HH:mm' : undefined : i18n.locale()) } }} }
                } @else { <span class="red-text">{{ 'sp.missing' | t }}</span> }
              </div>
            </div>
            <div class="segmented">
              <button [class.on]="s.enabled" (click)="saveSp({ enabled: true })">{{ 'common.on' | t }}</button>
              <button [class.on]="!s.enabled" (click)="saveSp({ enabled: false })">{{ 'common.off' | t }}</button>
            </div>
          </div>
          <div class="setting stack">
            <label class="form-label">{{ 'sp.folder' | t }} <span class="muted">— {{ 'sp.folderHelp' | t }}</span>
              <input [value]="s.localRoot" #root />
            </label>
            <details class="small">
              <summary class="muted">{{ 'sp.advanced' | t }}</summary>
              <label class="form-label">{{ 'sp.web' | t }} <input [value]="s.webBase" #web /></label>
            </details>
            <div class="sync-now">
              @if (spMessage(); as m) { <span class="small muted">{{ m }}</span> }
              <button (click)="rescan()" [disabled]="!s.enabled || scanning()">{{ 'sp.rescan' | t }}</button>
              <button class="primary" (click)="saveSp({ localRoot: root.value, webBase: web.value })">{{ 'common.save' | t }}</button>
            </div>
          </div>
        }
      </div>

      <div class="card">
        <h2>Jira</h2>
        <p class="help small muted">{{ 'jr.help' | t }}
          <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank">{{ 'jr.createToken' | t }}</a></p>
        @if (jira.value(); as j) {
          <div class="setting">
            <div>
              <div class="label">{{ 'jr.status' | t }}</div>
              <div class="help">
                @if (j.connected) { <span class="green-text">{{ 'jr.connected' | t: { n: j.displayName } }}</span> }
                @else if (j.hasToken) { <span class="red-text">{{ 'jr.notVerified' | t }}</span> }
                @else { {{ 'jr.noToken' | t }} }
                · Tempo:
                @if (j.tempoConnected) { <span class="green-text">{{ 'jr.tempoOk' | t }}</span> }
                @else if (j.hasTempoToken) { <span class="red-text">{{ 'jr.notVerified' | t }}</span> }
                @else { {{ 'jr.tempoNone' | t }} }
                @if (jiraMsg(); as m) { · <span [class.red-text]="jiraErr()">{{ m }}</span> }
              </div>
            </div>
            <div class="sync-now">
              @if (j.hasTempoToken) { <button (click)="saveJira({ clearTempo: true })">{{ 'jr.removeTempo' | t }}</button> }
              @if (j.hasToken) { <button (click)="saveJira({ clear: true })">{{ 'jr.remove' | t }}</button> }
            </div>
          </div>
          <div class="setting stack">
            <label class="form-label">{{ 'jr.email' | t }} <input type="email" [value]="j.email ?? ''" #jEmail autocomplete="username" /></label>
            <label class="form-label">{{ 'jr.token' | t }} <input type="password" #jToken autocomplete="off" [placeholder]="j.hasToken ? ('jr.tokenKeep' | t) : ''" /></label>
            <label class="form-label">{{ 'jr.tempoToken' | t }}
              <input type="password" #tToken autocomplete="off" [placeholder]="j.hasTempoToken ? ('jr.tokenKeep' | t) : ''" /></label>
            <div class="help small muted">{{ 'jr.tempoHelp' | t }}</div>
            <div class="sync-now">
              <button class="primary" (click)="saveJira({ email: jEmail.value, token: jToken.value, tempoToken: tToken.value }); jToken.value = ''; tToken.value = ''">{{ 'jr.save' | t }}</button>
            </div>
          </div>
        }
      </div>

      <div class="card">
        <h2>{{ 'auto.todoTitle' | t }}</h2>
        <p class="help small muted">{{ 'auto.todoHelp' | t }}</p>
        @if (autoTodo.value(); as a) {
          <div class="setting">
            <div>
              <div class="label">{{ 'auto.todoUse' | t }}</div>
              <div class="help">@if (autoMessage(); as m) { {{ m }} }</div>
            </div>
            <div class="sync-now">
              <button (click)="runAuto()" [disabled]="!a.enabled">{{ 'auto.todoRun' | t }}</button>
              <div class="segmented">
                <button [class.on]="a.enabled" (click)="saveAuto(true)">{{ 'common.on' | t }}</button>
                <button [class.on]="!a.enabled" (click)="saveAuto(false)">{{ 'common.off' | t }}</button>
              </div>
            </div>
          </div>
          <table class="auto-rules small">
            <thead><tr><th>{{ 'col.phase' | t }}</th><th>{{ 'auto.todoTask' | t }}</th><th>{{ 'auto.todoWhen' | t }}</th></tr></thead>
            <tbody>
              @for (r of a.rules; track r.id) {
                <tr><td>{{ r.phases.join(' / ') }}</td><td>{{ r.titles?.[i18n.lang()] ?? r.title }}</td>
                  <td class="muted">{{ (r.anchor === 'start' ? 'auto.todoBeforeStart' : 'auto.todoBeforeEnd') | t: { n: r.daysBefore } }}</td></tr>
              }
            </tbody>
          </table>
        }
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
  protected readonly sp = httpResource<SpStatus>(() => '/api/settings/sharepoint');
  protected readonly autoTodo = httpResource<{ enabled: boolean; rules: AutoTodoRule[] }>(() => '/api/settings/autotodo');
  protected readonly autoMessage = signal<string | null>(null);
  protected readonly jira = httpResource<JiraStatus>(() => '/api/settings/jira');
  protected readonly jiraMsg = signal<string | null>(null);
  protected readonly jiraErr = signal(false);

  protected async saveJira(body: { email?: string; token?: string; tempoToken?: string; clear?: boolean; clearTempo?: boolean }) {
    this.jiraMsg.set(null);
    try {
      this.jira.set(await this.api.saveJira(body));
      this.jiraErr.set(false);
      this.jiraMsg.set(body.clear || body.clearTempo ? null : this.i18n.t('jr.verified'));
    } catch (err: any) {
      this.jiraErr.set(true);
      this.jiraMsg.set(err?.error?.error ?? String(err));
      this.jira.reload();
    }
  }

  protected async saveAuto(enabled: boolean) {
    const r = await this.api.saveAutoTodos(enabled);
    this.autoTodo.reload();
    this.autoMessage.set(enabled ? this.i18n.t('auto.todoDone', { c: r.created, m: r.moved }) : null);
  }

  protected async runAuto() {
    const r = await this.api.runAutoTodos();
    this.autoMessage.set(this.i18n.t('auto.todoDone', { c: r.created, m: r.moved }));
  }
  protected readonly spMessage = signal<string | null>(null);
  protected readonly scanning = signal(false);

  protected async saveSp(body: Partial<Pick<SpStatus, 'enabled' | 'localRoot' | 'webBase'>>) {
    this.sp.set(await this.api.saveSharePoint(body));
    this.spMessage.set(null);
    this.sync.notifyChanged();
  }

  protected async rescan() {
    this.scanning.set(true);
    try {
      const r = await this.api.scanSharePoint();
      this.sp.set(r.status);
      this.spMessage.set(this.i18n.t('sp.scanned', { f: r.files, m: r.mapped }));
      this.sync.notifyChanged();
    } finally {
      this.scanning.set(false);
    }
  }
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

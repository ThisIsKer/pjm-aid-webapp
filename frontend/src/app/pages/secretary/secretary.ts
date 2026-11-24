import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { I18n, TPipe } from '../../core/i18n';
import type { SecEntry, SecEvent, SecProposal, SecRecap, SecRunReport, SecretaryJob, SecretaryOverview } from '../../core/models';
import { SecretaryService } from '../../core/secretary';
import { SyncProgress } from '../../shared/sync-progress';

type SideTab = 'recap' | 'day' | 'runs';
const PROJECT_KEY = 'pjm.secProject';
const TAB_KEY = 'pjm.secTab';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* session only */
  }
}
const localIso = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The secretary's view of my projects, from the pjm-secretary ledger: what waits on me, what I wait on, risks,
 * dates and decisions, documentation proposals to decide, and on the right the end-of-day recap, the day's events
 * and the runs. Changes made here (done, approve, reject) go to the ledger through ledger.mjs on the backend.
 */
@Component({
  selector: 'app-secretary',
  imports: [DatePipe, NgTemplateOutlet, RouterLink, TPipe, SyncProgress],
  templateUrl: './secretary.html',
})
export class SecretaryPage {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly sec = inject(SecretaryService);

  /** '' = all projects; otherwise an app project id or a ledger project id (_unassigned, _internal-…). */
  protected readonly project = signal(stored(PROJECT_KEY) ?? '');
  /** ?project=… (links from the project page) — preselects the filter. */
  readonly projectParam = input<string | undefined>(undefined, { alias: 'project' });
  protected readonly data = httpResource<SecretaryOverview>(() =>
    `/api/secretary${this.project() ? `?project=${encodeURIComponent(this.project())}` : ''}`);

  protected readonly tab = signal<SideTab>((stored(TAB_KEY) as SideTab) || 'recap');
  /** '' = the latest recap. */
  protected readonly recapDate = signal('');
  protected readonly recap = httpResource<SecRecap>(() =>
    this.tab() === 'recap' ? `/api/secretary/recap${this.recapDate() ? `?date=${this.recapDate()}` : ''}` : undefined);
  protected readonly day = signal(localIso());
  protected readonly events = httpResource<{ date: string; events: SecEvent[] }>(() =>
    this.tab() === 'day' ? `/api/secretary/events?date=${this.day()}` : undefined);
  protected readonly runs = httpResource<{ reports: SecRunReport[]; jobs: SecretaryJob[] }>(() =>
    this.tab() === 'runs' ? '/api/secretary/runs' : undefined);
  protected readonly showAppRuns = signal(false);

  /** Id of the item / proposal being changed, and the last error. */
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  /** Proposal being rejected (inline reason field) and its reason. */
  protected readonly rejecting = signal<string | null>(null);
  protected readonly rejectNote = signal('');
  /** Panel briefly highlighted after a KPI click. */
  protected readonly flash = signal<string | null>(null);

  protected readonly today = computed(() => this.data.value()?.today ?? localIso());
  protected readonly visibleRuns = computed(() =>
    (this.runs.value()?.reports ?? []).filter((r) => this.showAppRuns() || !r.fromApp));
  protected readonly agendaEmpty = computed(() => {
    const d = this.data.value();
    return !!d && !d.risks.length && !d.dates.length && !d.decisions.length && !d.docChanges.length;
  });
  /** The selected project still in the list (it may have no open items any more). */
  protected readonly projectOptions = computed(() => {
    const list = this.data.value()?.projects ?? [];
    const sel = this.project();
    const keyOf = (p: { appProjectId: string | null; projectId: string }) => p.appProjectId ?? p.projectId;
    return sel && !list.some((p) => keyOf(p) === sel) ? [...list, { projectId: sel, appProjectId: null, projectName: sel, open: 0 }] : list;
  });

  constructor() {
    effect(() => {
      const p = this.projectParam();
      if (p) untracked(() => this.project.set(p));
    });
    effect(() => store(PROJECT_KEY, this.project()));
    effect(() => store(TAB_KEY, this.tab()));
    // a run started here (or elsewhere in the app) ended, or the ledger changed: reload everything shown
    effect(() => {
      if (this.sec.completed()) this.reload();
    });
  }

  protected reload() {
    this.data.reload();
    if (this.tab() === 'recap') this.recap.reload();
    if (this.tab() === 'day') this.events.reload();
    if (this.tab() === 'runs') this.runs.reload();
  }

  protected projectKey(p: { appProjectId: string | null; projectId: string }) {
    return p.appProjectId ?? p.projectId;
  }

  protected projectLabel(p: { projectName: string | null; projectId: string }): string {
    if (p.projectName) return p.projectName;
    if (p.projectId === '_unassigned') return this.i18n.t('sec.unassigned');
    if (p.projectId.startsWith('_internal-')) return this.i18n.t('sec.internal', { n: p.projectId.slice(10) });
    return p.projectId;
  }

  /** Red edge = overdue; amber = urgent, or due within 2 days. */
  protected edge(e: SecEntry): string {
    const today = this.today();
    if (e.due && e.due < today) return 'u-critical';
    if (e.urgency === 'high' || (e.due && e.due <= this.addDays(today, 2))) return 'u-warning';
    return '';
  }

  protected typeClass(e: SecEntry): string {
    switch (e.type) {
      case 'needs_reply': case 'risk': return 'red';
      case 'action': case 'question': return 'amber';
      case 'waiting': case 'waiting_on': return 'info';
      default: return '';
    }
  }

  protected age(iso: string): string {
    const days = Math.floor((Date.parse(`${this.today()}T23:59:59`) - Date.parse(iso)) / 864e5);
    if (days <= 0) return this.i18n.t('sec.ageToday');
    if (days === 1) return this.i18n.t('sec.ageYesterday');
    return this.i18n.t('sec.ageDays', { n: days });
  }

  /** Label of the button that closes an item, by type (an action is done, a risk resolved, a wait received). */
  protected closeLabel(e: SecEntry): string | null {
    if (e.kind !== 'item' || e.status !== 'open') return null;
    if (e.type === 'risk') return 'sec.resolved';
    if (e.type === 'waiting_on') return 'sec.received';
    if (e.type === 'date') return null; // dates close by themselves once past
    return 'sec.done';
  }

  protected async close(e: SecEntry) {
    const label = this.closeLabel(e);
    if (!label) return;
    await this.act(e.id, () => this.api.closeSecretaryItem(e.id, this.i18n.t(`${label}.reason`)));
  }

  protected async decide(p: SecProposal, status: 'approved' | 'rejected' | 'pending', note?: string) {
    await this.act(p.id, () => this.api.decideSecretaryProposal(p.id, status, note));
    this.rejecting.set(null);
    this.rejectNote.set('');
  }

  private async act(id: string, fn: () => Promise<unknown>) {
    this.busy.set(id);
    this.error.set(null);
    try {
      await fn();
      this.sec.notifyChanged();
    } catch (err: any) {
      this.error.set(this.i18n.t('sec.actionError', { e: err?.error?.error ?? err?.message ?? '?' }));
    } finally {
      this.busy.set(null);
    }
  }

  /** KPI click: bring the matching list into view and highlight its panel for a moment. */
  protected jump(target: string) {
    document.getElementById(`sec-${target}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    this.flash.set(target);
    setTimeout(() => this.flash.set(null), 1200);
  }

  protected fileName(p: string) {
    return p.split(/[\\/]/).pop() ?? p;
  }

  /** A proposal change in words: row values as "column: value", sections as their first lines. */
  protected changeText(content: unknown): string {
    if (content == null) return '';
    if (typeof content === 'string') return content.length > 400 ? `${content.slice(0, 399)}…` : content;
    if (typeof content === 'object') return Object.entries(content as Record<string, unknown>).map(([k, v]) => `${k}: ${v}`).join(' · ');
    return String(content);
  }

  protected locatorText(locator: unknown): string {
    if (locator == null) return '';
    if (typeof locator === 'object') return Object.entries(locator as Record<string, unknown>).map(([k, v]) => `${k} ${v}`).join(', ');
    return String(locator);
  }

  protected shiftDay(n: number) {
    this.day.set(this.addDays(this.day(), n));
  }

  private addDays(iso: string, n: number) {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + n);
    return localIso(d);
  }

  protected modeLabel(mode: string | null) {
    const key = `sec.mode.${mode ?? '?'}`;
    const t = this.i18n.t(key);
    return t === key ? (mode ?? '?') : t;
  }

  /** First stats line of a run report ("Thread: … · Item: …"). */
  protected runSummary(r: SecRunReport) {
    return r.text.split('\n').find((l) => l.startsWith('Thread:')) ?? '';
  }

  protected eventLabel(kind: string) {
    const key = `sec.ev.${kind}`;
    const t = this.i18n.t(key);
    return t === key ? kind : t;
  }
}

import { Component, ElementRef, computed, inject, output, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { I18n, TPipe } from '../core/i18n';
import type { WorklogProposal } from '../core/models';

interface Row { key: string; title: string; project: string | null; url: string | null; planned: number | null; logged: number | null;
  include: boolean; hours: number; comment: string; result?: { ok: boolean; error?: string } }

/**
 * "Jira work log": today's Jira activities with the proposed hours (planned hours fitted into the working day
 * minus meetings, minus what is already logged). Adjust, untick what you did not work on, log in one click.
 */
@Component({
  selector: 'app-worklog-dialog',
  imports: [RouterLink, TPipe],
  template: `
    <dialog #dlg class="dialog worklog-dialog">
      <div class="dialog-head">
        <div>
          <h2>{{ 'wl.title' | t }}</h2>
          <div class="small muted">{{ 'wl.help' | t }}</div>
        </div>
        <input type="date" [value]="date()" (change)="load($any($event.target).value)" />
      </div>
      <div class="dialog-body">
        @if (loading()) { <div class="empty">…</div> }
        @else if (data(); as d) {
          @if (!d.connected) {
            <div class="note small">{{ 'wl.noToken' | t }} <a routerLink="/settings" (click)="close()">{{ 'wl.toSettings' | t }}</a></div>
          } @else {
            <div class="small muted wl-via">
              {{ (d.via === 'tempo' ? 'wl.viaTempo' : 'wl.viaJira') | t }}
              @if (d.loggedDayHours !== null) { · {{ 'wl.loggedDay' | t: { h: d.loggedDayHours } }} }
              @if (d.via === 'jira') { · <a routerLink="/settings" (click)="close()">{{ 'wl.addTempo' | t }}</a> }
            </div>
          }
          @if (d.warning) { <div class="error small">{{ d.warning }}</div> }
          @if (rows().length) {
            <table class="worklog-table">
              <thead><tr><th></th><th>{{ 'wl.activity' | t }}</th><th class="num">{{ 'wl.planned' | t }}</th><th class="num">{{ 'wl.logged' | t }}</th>
                <th class="num">{{ 'wl.hours' | t }}</th><th>{{ 'wl.comment' | t }}</th><th></th></tr></thead>
              <tbody>
                @for (r of rows(); track r.key; let i = $index) {
                  <tr [class.muted]="!r.include">
                    <td><input type="checkbox" [checked]="r.include" (change)="patch(i, { include: !r.include })" [disabled]="!!r.result?.ok" /></td>
                    <td>
                      @if (r.url) { <a [href]="r.url" target="_blank">{{ r.key }}</a> } @else { {{ r.key }} } · {{ r.title }}
                      <div class="small muted">{{ r.project }}</div>
                    </td>
                    <td class="num small">{{ r.planned ?? '—' }}</td>
                    <td class="num small">{{ r.logged === null ? '—' : r.logged }}</td>
                    <td class="num"><input type="number" class="wl-hours" min="0" max="24" step="0.25" [value]="r.hours"
                      [disabled]="!r.include || !!r.result?.ok" (input)="patch(i, { hours: +$any($event.target).value || 0 })" /></td>
                    <td><input class="wl-comment" [value]="r.comment" [placeholder]="'wl.commentPh' | t" [disabled]="!r.include || !!r.result?.ok"
                      (input)="patch(i, { comment: $any($event.target).value })" /></td>
                    <td class="small">
                      @if (r.result; as res) {
                        @if (res.ok) { <span class="badge green">✓</span> } @else { <span class="badge red" [title]="res.error ?? ''">{{ 'wl.failed' | t }}</span> }
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
            <div class="wl-total small" [class.over]="total() > d.availableHours">
              {{ 'wl.total' | t: { h: total(), a: d.availableHours, m: d.meetingHours } }}
            </div>
          } @else {
            <div class="empty">{{ 'wl.none' | t }}</div>
          }
        }
        @if (error()) { <div class="error small">{{ error() }}</div> }
      </div>
      <div class="dialog-actions wl-actions">
        <button (click)="close()">{{ 'common.closeCap' | t }}</button>
        <button class="primary" (click)="submit()" [disabled]="busy() || !data()?.connected || !toLog().length">
          {{ 'wl.submit' | t: { h: total() } }}
        </button>
      </div>
    </dialog>
  `,
})
export class WorklogDialog {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  readonly logged = output<void>();
  protected readonly date = signal(new Date().toLocaleDateString('sv-SE'));
  protected readonly data = signal<WorklogProposal | null>(null);
  protected readonly rows = signal<Row[]>([]);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  protected readonly toLog = computed(() => this.rows().filter((r) => r.include && r.hours > 0 && !r.result?.ok));
  protected readonly total = computed(() => Math.round(this.toLog().reduce((n, r) => n + r.hours, 0) * 100) / 100);

  open() {
    this.dlg().nativeElement.showModal();
    void this.load(new Date().toLocaleDateString('sv-SE'));
  }

  close() {
    this.dlg().nativeElement.close();
  }

  protected async load(date: string) {
    this.date.set(date);
    this.loading.set(true);
    this.error.set(null);
    try {
      const d = await this.api.worklogProposal(date);
      this.data.set(d);
      this.rows.set(d.items.map((i) => ({ key: i.key, title: i.title, project: i.project, url: i.url, planned: i.plannedHours,
        logged: i.loggedHours, include: i.proposedHours > 0, hours: i.proposedHours, comment: '' })));
    } catch (err: any) {
      this.error.set(err?.error?.error ?? String(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected patch(i: number, change: Partial<Row>) {
    this.rows.update((rows) => rows.map((r, j) => (j === i ? { ...r, ...change } : r)));
  }

  protected async submit() {
    const entries = this.toLog().map((r) => ({ key: r.key, hours: r.hours, comment: r.comment || undefined }));
    if (!entries.length) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await this.api.logWork(this.date(), entries);
      this.rows.update((rows) => rows.map((r) => {
        const out = res.results.find((x) => x.key === r.key);
        return out ? { ...r, result: { ok: out.ok, error: out.error }, logged: out.ok ? (r.logged ?? 0) + r.hours : r.logged } : r;
      }));
      if (res.results.some((r) => r.ok)) this.logged.emit();
    } catch (err: any) {
      this.error.set(err?.error?.error ?? String(err));
    } finally {
      this.busy.set(false);
    }
  }
}

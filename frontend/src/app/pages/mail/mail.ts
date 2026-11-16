import { Component, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Api } from '../../core/api';
import { SyncService } from '../../core/sync';
import { I18n, TPipe } from '../../core/i18n';
import type { MailCategory, MailThread } from '../../core/models';

@Component({
  selector: 'app-mail',
  imports: [DatePipe, TPipe],
  template: `
    <header class="page-head"><h1>{{ 'mail.title' | t }}</h1></header>
    <div class="tabs">
      @for (c of categories; track c) {
        <button [class.active]="category() === c" (click)="category.set(c)">{{ 'mail.tab.' + c | t }}</button>
      }
    </div>
    <div class="card">
      <table>
        <thead><tr><th>{{ 'col.subject' | t }}</th><th>{{ 'col.project' | t }}</th><th>{{ 'col.fromTo' | t }}</th><th>{{ 'col.last' | t }}</th><th></th></tr></thead>
        <tbody>
          @for (m of threads.value() ?? []; track m.id) {
            <tr>
              <td>
                @if (m.urgency === 'high') { <span class="badge red">{{ 'common.urgent' | t }}</span> }
                @if (m.webLink) { <a [href]="m.webLink" target="_blank">{{ m.subject }}</a> } @else { {{ m.subject }} }
                @if (m.summary) { <div class="muted small">{{ m.summary }}</div> }
              </td>
              <td>{{ m.projectName ?? '—' }}</td>
              <td class="small">{{ m.counterpart }}</td>
              <td class="small">{{ m.lastMessageAt | date: 'dd/MM HH:mm' : undefined : i18n.locale() }}@if (m.lastFromMe) { <div class="muted">{{ 'mail.lastMe' | t }}</div> }</td>
              <td style="white-space: nowrap">
                <button (click)="done(m)">{{ 'common.done' | t }}</button>
                <button (click)="snooze(m, 3)">{{ 'mail.snooze' | t }}</button>
              </td>
            </tr>
          } @empty {
            <tr><td colspan="5" class="empty">{{ 'mail.empty' | t }}</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class MailPage {
  private readonly sync = inject(SyncService);
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly categories: MailCategory[] = ['needs_reply', 'waiting', 'fyi'];
  protected readonly category = signal<MailCategory>('needs_reply');
  protected readonly threads = httpResource<MailThread[]>(() => `/api/mail?category=${this.category()}`);

  protected async done(m: MailThread) {
    await this.api.updateMail(m.id, { userState: 'done' });
    this.threads.reload();
  }

  protected async snooze(m: MailThread, days: number) {
    const until = new Date();
    until.setDate(until.getDate() + days);
    await this.api.updateMail(m.id, { userState: 'snoozed', snoozedUntil: until.toLocaleDateString('sv-SE') });
    this.threads.reload();
  }

  constructor() {
    effect(() => {
      if (this.sync.completed()) this.threads.reload();
    });
  }
}

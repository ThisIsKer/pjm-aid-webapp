import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Api } from '../../core/api';
import type { MailCategory, MailThread } from '../../core/models';

@Component({
  selector: 'app-mail',
  imports: [DatePipe],
  template: `
    <header class="page-head"><h1>Mail</h1></header>
    <div class="tabs">
      @for (t of tabs; track t.value) {
        <button [class.active]="category() === t.value" (click)="category.set(t.value)">{{ t.label }}</button>
      }
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Subject</th><th>Project</th><th>From / to</th><th>Last message</th><th></th></tr></thead>
        <tbody>
          @for (m of threads.value() ?? []; track m.id) {
            <tr>
              <td>
                @if (m.urgency === 'high') { <span class="badge red">urgent</span> }
                @if (m.webLink) { <a [href]="m.webLink" target="_blank">{{ m.subject }}</a> } @else { {{ m.subject }} }
                @if (m.summary) { <div class="muted small">{{ m.summary }}</div> }
              </td>
              <td>{{ m.projectName ?? '—' }}</td>
              <td class="small">{{ m.counterpart }}</td>
              <td class="small">{{ m.lastMessageAt | date: 'dd/MM HH:mm' }}@if (m.lastFromMe) { <div class="muted">last: me</div> }</td>
              <td style="white-space: nowrap">
                <button (click)="done(m)">Done</button>
                <button (click)="snooze(m, 3)">Snooze 3d</button>
              </td>
            </tr>
          } @empty {
            <tr><td colspan="5" class="empty">Nothing here. Threads arrive from Outlook with each Claude sync (ask Claude to <em>sync PJM</em>).</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class MailPage {
  private readonly api = inject(Api);
  protected readonly tabs: { value: MailCategory; label: string }[] = [
    { value: 'needs_reply', label: 'Needs my reply' },
    { value: 'waiting', label: 'Waiting on others' },
    { value: 'fyi', label: 'FYI' },
  ];
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
}

import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { I18n, TPipe } from '../core/i18n';
import type { TodoTask } from '../core/models';
import { autoInfoText, taskTitle } from '../core/todo-text';
import { byDueDate, todayIso, todoUrgency } from '../core/todo-urgency';

/** Dashboard side panel: open to-dos by due date (overdue = critical, due soon = warning) with a quick add. */
@Component({
  selector: 'app-todo-panel',
  imports: [DatePipe, RouterLink, TPipe],
  host: { class: 'card panel todo-side' },
  template: `
    <div class="card-head">
      <h2>{{ 'todo.title' | t }}</h2>
      <a class="small" routerLink="/todo">{{ 'todo.openPage' | t }}</a>
    </div>
    <form class="todo-quick" (submit)="$event.preventDefault(); add()">
      <input [value]="title()" (input)="title.set($any($event.target).value)" [placeholder]="'todo.quickPh' | t" />
      <div class="row">
        <input type="date" [value]="due()" (input)="due.set($any($event.target).value)" [title]="'todo.due' | t" />
        <button class="primary" type="submit" [disabled]="!title().trim()">+</button>
      </div>
    </form>
    @if (counts(); as c) {
      @if (c.critical || c.warning) {
        <div class="small todo-side-counts">
          @if (c.critical) { <span class="badge red">{{ 'todo.nCritical' | t: { n: c.critical } }}</span> }
          @if (c.warning) { <span class="badge amber">{{ 'todo.nWarning' | t: { n: c.warning } }}</span> }
        </div>
      }
    }
    <div class="scroll">
      <ul class="todo-side-list">
        @for (t of open(); track t.id) {
          <li [class]="'u-' + (urgency(t) ?? 'none')">
            <input type="checkbox" class="todo-check" (change)="complete(t)" [title]="'todo.complete' | t" />
            <div class="what">
              <div class="title">@if (t.importance === 'high') { <span class="star-on">★</span> }{{ label(t) }}
                @if (t.origin === 'auto') { <span class="badge auto" [title]="autoInfo(t)">{{ 'todo.auto' | t }}</span> }</div>
              <div class="small muted">
                @if (t.dueDate) { {{ t.dueDate | date: 'EEE d/MM' : undefined : i18n.locale() }} } @else { {{ 'todo.noDue' | t }} }
                @if (t.projectId) { · <a [routerLink]="['/projects', t.projectId]">{{ t.projectName }}</a> }
              </div>
            </div>
            @switch (urgency(t)) {
              @case ('critical') { <span class="badge red">{{ 'rag.red' | t }}</span> }
              @case ('warning') { <span class="badge amber">{{ 'rag.amber' | t }}</span> }
            }
          </li>
        } @empty {
          <li class="muted small empty-row">{{ 'todo.none' | t }}</li>
        }
      </ul>
    </div>
  `,
})
export class TodoPanel {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly data = httpResource<{ tasks: TodoTask[] }>(() => '/api/todo');
  protected readonly title = signal('');
  protected readonly due = signal(todayIso());
  protected readonly urgency = todoUrgency;
  protected readonly label = (t: TodoTask) => taskTitle(t, this.i18n.lang());
  protected readonly autoInfo = (t: TodoTask) => autoInfoText(this.i18n, t);

  protected readonly open = computed(() => (this.data.value()?.tasks ?? []).filter((t) => t.status !== 'completed').sort(byDueDate));
  protected readonly counts = computed(() => {
    const u = this.open().map(todoUrgency);
    return { critical: u.filter((x) => x === 'critical').length, warning: u.filter((x) => x === 'warning').length };
  });

  reload() {
    this.data.reload();
  }

  protected async add() {
    const title = this.title().trim();
    if (!title) return;
    await this.api.addTask({ title, dueDate: this.due() || null });
    this.title.set('');
    this.due.set(todayIso());
    this.data.reload();
  }

  protected async complete(t: TodoTask) {
    await this.api.updateTask(t.id, { completed: true });
    this.data.reload();
  }
}

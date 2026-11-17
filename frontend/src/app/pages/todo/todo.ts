import { Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { I18n, TPipe } from '../../core/i18n';
import type { Project, TodoTask } from '../../core/models';
import { byDueDate, todayIso, todoUrgency } from '../../core/todo-urgency';

/**
 * To-do list kept in the app, ordered by due date. Overdue tasks are marked critical, tasks due within the
 * next 2 days warning (same labels as the Jira status).
 */
@Component({
  selector: 'app-todo',
  imports: [RouterLink, TPipe],
  template: `
    <header class="page-head">
      <h1>{{ 'todo.title' | t }}</h1>
      <div class="meta">
        @if (counts().critical) { <span class="badge red">{{ 'todo.nCritical' | t: { n: counts().critical } }}</span> }
        @if (counts().warning) { <span class="badge amber">{{ 'todo.nWarning' | t: { n: counts().warning } }}</span> }
        <label class="small muted"><input type="checkbox" [checked]="showDone()" (change)="showDone.set(!showDone())" /> {{ 'todo.showDone' | t }}</label>
      </div>
    </header>

    <form class="card todo-add" (submit)="$event.preventDefault(); add()">
      <input class="grow" [value]="newTitle()" (input)="newTitle.set($any($event.target).value)" [placeholder]="'todo.newPh' | t" />
      <input type="date" [value]="newDue()" (input)="newDue.set($any($event.target).value)" [title]="'todo.due' | t" />
      <select (change)="newProject.set($any($event.target).value)" [title]="'todo.project' | t">
        <option value="" [selected]="!newProject()">{{ 'todo.noProject' | t }}</option>
        @for (p of projects(); track p.id) { <option [value]="p.id" [selected]="newProject() === p.id">{{ p.name }}</option> }
      </select>
      <button class="primary" type="submit" [disabled]="!newTitle().trim()">+ {{ 'common.add' | t }}</button>
    </form>

    <div class="todo-filters">
      <input type="search" [value]="query()" (input)="query.set($any($event.target).value)" [placeholder]="'todo.search' | t" />
      <select (change)="projectFilter.set($any($event.target).value)">
        <option value="">{{ 'todo.allProjects' | t }}</option>
        @for (p of projects(); track p.id) { <option [value]="p.id" [selected]="projectFilter() === p.id">{{ p.name }}</option> }
        <option value="__none" [selected]="projectFilter() === '__none'">{{ 'todo.noProject' | t }}</option>
      </select>
      <span class="small muted">{{ 'todo.count' | t: { n: openCount() } }}</span>
    </div>

    @if (tasks().length) {
      <section class="card todo-group">
        <ul class="todo-list">
          @for (t of tasks(); track t.id) {
            <li [class.done]="t.status === 'completed'" [class]="'u-' + (urgency(t) ?? 'none')">
              <input type="checkbox" class="todo-check" [checked]="t.status === 'completed'" (change)="toggleDone(t)" [title]="'todo.complete' | t" />
              <div class="todo-main">
                <input class="todo-title" [value]="t.title" (change)="update(t, { title: $any($event.target).value })" />
                <input class="todo-notes small" [value]="t.notes ?? ''" [placeholder]="'todo.notesPh' | t"
                  (change)="update(t, { notes: $any($event.target).value || null })" />
              </div>
              @switch (urgency(t)) {
                @case ('critical') { <span class="badge red">{{ 'rag.red' | t }}</span> }
                @case ('warning') { <span class="badge amber">{{ 'rag.amber' | t }}</span> }
              }
              @if (t.projectId) { <a class="badge" [routerLink]="['/projects', t.projectId]">{{ t.projectName ?? t.projectId }}</a> }
              <button class="icon-btn star" [class.on]="t.importance === 'high'" (click)="update(t, { importance: t.importance === 'high' ? 'normal' : 'high' })"
                [title]="'todo.important' | t">★</button>
              <select class="todo-project" (change)="update(t, { projectId: $any($event.target).value || null })" [title]="'todo.project' | t">
                <option value="" [selected]="!t.projectId">—</option>
                @for (p of projects(); track p.id) { <option [value]="p.id" [selected]="t.projectId === p.id">{{ p.name }}</option> }
              </select>
              <input type="date" class="todo-due" [class.overdue]="urgency(t) === 'critical'" [class.soon]="urgency(t) === 'warning'"
                [value]="t.dueDate ?? ''" (change)="update(t, { dueDate: $any($event.target).value || null })" />
              <button class="icon-btn" (click)="remove(t)" [title]="'todo.delete' | t">✕</button>
            </li>
          }
        </ul>
      </section>
    } @else {
      <div class="card empty">{{ (query() || projectFilter()) ? ('todo.noMatch' | t) : ('todo.empty' | t) }}</div>
    }
  `,
})
export class TodoPage {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly showDone = signal(false);
  protected readonly data = httpResource<{ tasks: TodoTask[] }>(() => `/api/todo?all=${this.showDone()}`);
  private readonly projectsRes = httpResource<Project[]>(() => '/api/projects');
  protected readonly projects = computed(() => [...(this.projectsRes.value() ?? [])].sort((a, b) => a.name.localeCompare(b.name)));
  protected readonly urgency = todoUrgency;

  protected readonly newTitle = signal('');
  protected readonly newDue = signal(todayIso());
  protected readonly newProject = signal('');
  protected readonly query = signal('');
  protected readonly projectFilter = signal('');

  private readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const pf = this.projectFilter();
    return (this.data.value()?.tasks ?? []).filter((t) =>
      (this.showDone() || t.status !== 'completed')
      && (!q || `${t.title} ${t.notes ?? ''} ${t.projectName ?? ''}`.toLowerCase().includes(q))
      && (!pf || (pf === '__none' ? !t.projectId : t.projectId === pf)));
  });
  /** By due date (no date last); completed at the end. */
  protected readonly tasks = computed(() => [...this.filtered()].sort(byDueDate));
  protected readonly openCount = computed(() => this.filtered().filter((t) => t.status !== 'completed').length);
  protected readonly counts = computed(() => {
    const u = this.filtered().map(todoUrgency);
    return { critical: u.filter((x) => x === 'critical').length, warning: u.filter((x) => x === 'warning').length };
  });

  protected async add() {
    const title = this.newTitle().trim();
    if (!title) return;
    await this.api.addTask({ title, dueDate: this.newDue() || null, projectId: this.newProject() || null });
    this.newTitle.set('');
    this.newDue.set(todayIso());
    this.data.reload();
  }

  protected async update(t: TodoTask, body: Partial<Pick<TodoTask, 'title' | 'dueDate' | 'projectId' | 'importance' | 'notes'>>) {
    if (body.title !== undefined && !body.title.trim()) {
      this.data.reload();
      return;
    }
    await this.api.updateTask(t.id, body);
    this.data.reload();
  }

  protected async toggleDone(t: TodoTask) {
    await this.api.updateTask(t.id, { completed: t.status !== 'completed' });
    this.data.reload();
  }

  protected async remove(t: TodoTask) {
    if (!confirm(this.i18n.t('todo.confirmDelete', { t: t.title }))) return;
    await this.api.deleteTask(t.id);
    this.data.reload();
  }
}

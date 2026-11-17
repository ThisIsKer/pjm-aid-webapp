import { Component, computed, inject, signal } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { I18n, TPipe } from '../../core/i18n';
import type { Project, TodoTask } from '../../core/models';

type Group = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'none' | 'done';
const ORDER: Group[] = ['overdue', 'today', 'tomorrow', 'week', 'later', 'none', 'done'];
const iso = (d: Date) => d.toLocaleDateString('sv-SE');
const plus = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

/** To-do list kept in the app: tasks with due date, importance and an optional project. */
@Component({
  selector: 'app-todo',
  imports: [RouterLink, TPipe],
  template: `
    <header class="page-head">
      <h1>{{ 'todo.title' | t }}</h1>
      <div class="meta">
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

    @for (g of groups(); track g.key) {
      <section class="card todo-group" [class]="'g-' + g.key">
        <h2>{{ 'todo.group.' + g.key | t }} <span class="muted small">· {{ g.tasks.length }}</span></h2>
        <ul class="todo-list">
          @for (t of g.tasks; track t.id) {
            <li [class.done]="t.status === 'completed'">
              <input type="checkbox" class="todo-check" [checked]="t.status === 'completed'" (change)="toggleDone(t)" [title]="'todo.complete' | t" />
              <div class="todo-main">
                <input class="todo-title" [value]="t.title" (change)="update(t, { title: $any($event.target).value })" />
                <input class="todo-notes small" [value]="t.notes ?? ''" [placeholder]="'todo.notesPh' | t"
                  (change)="update(t, { notes: $any($event.target).value || null })" />
              </div>
              @if (t.projectId) { <a class="badge" [routerLink]="['/projects', t.projectId]">{{ t.projectName ?? t.projectId }}</a> }
              <button class="icon-btn star" [class.on]="t.importance === 'high'" (click)="update(t, { importance: t.importance === 'high' ? 'normal' : 'high' })"
                [title]="'todo.important' | t">★</button>
              <select class="todo-project" (change)="update(t, { projectId: $any($event.target).value || null })" [title]="'todo.project' | t">
                <option value="" [selected]="!t.projectId">—</option>
                @for (p of projects(); track p.id) { <option [value]="p.id" [selected]="t.projectId === p.id">{{ p.name }}</option> }
              </select>
              <input type="date" class="todo-due" [class.overdue]="g.key === 'overdue'" [value]="t.dueDate ?? ''"
                (change)="update(t, { dueDate: $any($event.target).value || null })" />
              <button class="icon-btn" (click)="remove(t)" [title]="'todo.delete' | t">✕</button>
            </li>
          }
        </ul>
      </section>
    } @empty {
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

  protected readonly newTitle = signal('');
  protected readonly newDue = signal('');
  protected readonly newProject = signal('');
  protected readonly query = signal('');
  protected readonly projectFilter = signal('');

  private readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const pf = this.projectFilter();
    return (this.data.value()?.tasks ?? []).filter((t) =>
      (!q || `${t.title} ${t.notes ?? ''} ${t.projectName ?? ''}`.toLowerCase().includes(q))
      && (!pf || (pf === '__none' ? !t.projectId : t.projectId === pf)));
  });
  protected readonly openCount = computed(() => this.filtered().filter((t) => t.status !== 'completed').length);

  /** Tasks grouped by due date: overdue, today, tomorrow, next 7 days, later, no date, completed. */
  protected readonly groups = computed(() => {
    const today = iso(new Date());
    const tomorrow = plus(1);
    const week = plus(7);
    const by = new Map<Group, TodoTask[]>();
    for (const t of this.filtered()) {
      if (t.status === 'completed' && !this.showDone()) continue;
      const g: Group = t.status === 'completed' ? 'done'
        : !t.dueDate ? 'none'
        : t.dueDate < today ? 'overdue'
        : t.dueDate === today ? 'today'
        : t.dueDate === tomorrow ? 'tomorrow'
        : t.dueDate <= week ? 'week' : 'later';
      by.set(g, [...(by.get(g) ?? []), t]);
    }
    return ORDER.filter((k) => by.has(k)).map((key) => ({ key, tasks: by.get(key)! }));
  });

  protected async add() {
    const title = this.newTitle().trim();
    if (!title) return;
    await this.api.addTask({ title, dueDate: this.newDue() || null, projectId: this.newProject() || null });
    this.newTitle.set('');
    this.newDue.set('');
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

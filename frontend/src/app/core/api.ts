import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Deadline, DocRequirement, MailThread, Project, ProjectFiles, ProjectGroup, SpStatus, SyncJob, TodoBridge, TodoTask } from './models';

/** Write operations. Reads use httpResource() directly in the pages. */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  updateProject(id: string, body: Partial<Project>) {
    return firstValueFrom(this.http.patch<Project>(`/api/projects/${id}`, body));
  }

  updateMail(id: string, body: Partial<Pick<MailThread, 'userState' | 'snoozedUntil' | 'projectId'>>) {
    return firstValueFrom(this.http.patch<MailThread>(`/api/mail/${id}`, body));
  }

  addDoc(projectId: string, body: { title: string; repository: 'sharepoint' | 'confluence'; phase?: string; requiredFrom?: string;
    locationHint?: string; foundUrl?: string }) {
    return firstValueFrom(this.http.post<DocRequirement>(`/api/projects/${encodeURIComponent(projectId)}/docs`, body));
  }

  updateDoc(id: string, body: Partial<Pick<DocRequirement, 'waived' | 'locationHint' | 'phase'>> & { confirmed?: boolean }) {
    return firstValueFrom(this.http.patch<DocRequirement>(`/api/docs/${id}`, body));
  }

  createGroup(name: string, color: string | null) {
    return firstValueFrom(this.http.post<ProjectGroup>('/api/groups', { name, color }));
  }

  updateGroup(id: number, body: Partial<Pick<ProjectGroup, 'name' | 'color' | 'sort'>>) {
    return firstValueFrom(this.http.patch<ProjectGroup>(`/api/groups/${id}`, body));
  }

  deleteGroup(id: number) {
    return firstValueFrom(this.http.delete<{ ok: boolean }>(`/api/groups/${id}`));
  }

  /** refresh: re-read the OneDrive copy of the project folder first. */
  projectFiles(projectId: string, refresh = true) {
    return firstValueFrom(this.http.get<ProjectFiles>(`/api/projects/${encodeURIComponent(projectId)}/files?refresh=${refresh}`));
  }

  saveSharePoint(body: Partial<Pick<SpStatus, 'enabled' | 'localRoot' | 'webBase'>>) {
    return firstValueFrom(this.http.put<SpStatus>('/api/settings/sharepoint', body));
  }

  scanSharePoint() {
    return firstValueFrom(this.http.post<{ mapped: number; projects: number; files: number; discovered: number; status: SpStatus }>('/api/sharepoint/scan', {}));
  }

  /** location = path below the project folder, or a full link. */
  setDocLocation(id: string, location: string) {
    return firstValueFrom(this.http.put<DocRequirement>(`/api/docs/${encodeURIComponent(id)}/location`, { location }));
  }

  clearDocLocation(id: string) {
    return firstValueFrom(this.http.delete<DocRequirement>(`/api/docs/${encodeURIComponent(id)}/location`));
  }

  addTask(body: { title: string; dueDate?: string | null; notes?: string | null; importance?: string; projectId?: string | null; listId?: string | null }) {
    return firstValueFrom(this.http.post<TodoTask>('/api/todo', body));
  }

  updateTask(id: string, body: Partial<Pick<TodoTask, 'title' | 'dueDate' | 'notes' | 'importance' | 'projectId'>> & { completed?: boolean }) {
    return firstValueFrom(this.http.patch<TodoTask>(`/api/todo/${encodeURIComponent(id)}`, body));
  }

  deleteTask(id: string) {
    return firstValueFrom(this.http.delete<{ ok: boolean }>(`/api/todo/${encodeURIComponent(id)}`));
  }

  resendTask(id: string) {
    return firstValueFrom(this.http.post<TodoTask>(`/api/todo/${encodeURIComponent(id)}/resend`, {}));
  }

  refreshTodo() {
    return firstValueFrom(this.http.post('/api/todo/refresh', {}));
  }

  saveTodoSettings(body: Partial<Pick<TodoBridge, 'enabled' | 'bridgeDir' | 'defaultListId'>>) {
    return firstValueFrom(this.http.put<TodoBridge>('/api/settings/todo', body));
  }

  linkEpic(key: string, projectId: string) {
    return firstValueFrom(this.http.patch(`/api/jira/epics/${key}`, { projectId }));
  }

  addDeadline(projectId: string, title: string, dueDate: string) {
    return firstValueFrom(this.http.post<Deadline>(`/api/projects/${projectId}/deadlines`, { title, dueDate }));
  }

  updateDeadline(id: string, body: Partial<Pick<Deadline, 'title' | 'dueDate' | 'state'>>) {
    return firstValueFrom(this.http.patch<Deadline>(`/api/deadlines/${id}`, body));
  }

  startSync(mode: SyncJob['mode'], lang: 'it' | 'en') {
    return firstValueFrom(this.http.post<SyncJob>('/api/sync/run', { mode, lang }));
  }

  /** First opening of the day: the backend starts a sync unless one already ran today. */
  autoSync(mode: SyncJob['mode'], lang: 'it' | 'en') {
    return firstValueFrom(this.http.post<{ started: boolean; reason: string; job: SyncJob | null }>('/api/sync/auto', { mode, lang }));
  }

  currentSyncJob() {
    return firstValueFrom(this.http.get<SyncJob | null>('/api/sync/jobs/current'));
  }

  importSnapshot(force = false) {
    return firstValueFrom(
      this.http.post<{ imported: boolean; reason?: string; warnings?: string[] }>(`/api/sync/import?force=${force}`, {}),
    );
  }
}

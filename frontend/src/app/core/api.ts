import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Deadline, DocRequirement, MailThread, Project, ProjectGroup, SyncJob } from './models';

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

  updateDoc(id: string, body: Partial<Pick<DocRequirement, 'waived' | 'locationHint' | 'phase'>>) {
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

  currentSyncJob() {
    return firstValueFrom(this.http.get<SyncJob | null>('/api/sync/jobs/current'));
  }

  importSnapshot(force = false) {
    return firstValueFrom(
      this.http.post<{ imported: boolean; reason?: string; warnings?: string[] }>(`/api/sync/import?force=${force}`, {}),
    );
  }
}

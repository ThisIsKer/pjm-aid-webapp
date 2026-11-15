import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { DocRequirement, MailThread, Project } from './models';

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

  updateDoc(id: string, body: Partial<Pick<DocRequirement, 'waived' | 'locationHint' | 'phase'>>) {
    return firstValueFrom(this.http.patch<DocRequirement>(`/api/docs/${id}`, body));
  }

  importSnapshot(force = false) {
    return firstValueFrom(
      this.http.post<{ imported: boolean; reason?: string; warnings?: string[] }>(`/api/sync/import?force=${force}`, {}),
    );
  }
}

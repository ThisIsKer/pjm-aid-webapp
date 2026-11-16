import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { SyncService } from '../../core/sync';
import { DocLocation, DocStateBadge } from '../../shared/doc-cells';
import { DocPathDialog } from '../../shared/doc-path-dialog';
import { I18n, TPipe, jiraReason } from '../../core/i18n';
import { AddDocDialog } from '../../shared/add-doc-dialog';
import type { Deadline, DocRequirement, MailThread, ProjectDetail, Rag } from '../../core/models';
import { FlagBadges } from '../../shared/flag-badges';
import { RagDot } from '../../shared/rag-dot';

@Component({
  selector: 'app-project-detail',
  imports: [DatePipe, RouterLink, FlagBadges, RagDot, TPipe, AddDocDialog, DocLocation, DocStateBadge, DocPathDialog],
  templateUrl: './project-detail.html',
})
export class ProjectDetailPage {
  private readonly sync = inject(SyncService);
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  /** Route parameter (component input binding). */
  readonly id = input.required<string>();
  protected readonly project = httpResource<ProjectDetail>(() => `/api/projects/${encodeURIComponent(this.id())}`);
  protected readonly statuses: Rag[] = ['green', 'amber', 'red', 'grey'];

  // Edit form (initialised from the loaded project)
  protected readonly status = signal<Rag>('grey');
  protected readonly phase = signal('');
  protected readonly pmNote = signal('');
  protected readonly sharepointUrl = signal('');
  protected readonly saved = signal<string | null>(null);

  // New manual deadline
  protected readonly newTitle = signal('');
  protected readonly newDue = signal('');

  protected readonly jiraPhases = computed(() => (this.project.value()?.deadlines ?? []).filter((d) => d.source === 'jira' && d.state === 'open'));
  protected readonly manual = computed(() => (this.project.value()?.deadlines ?? []).filter((d) => d.source !== 'jira'));
  protected readonly openMail = computed(() => (this.project.value()?.mailThreads ?? []).filter((m) => m.userState !== 'done'));

  constructor() {
    effect(() => {
      if (this.sync.completed()) this.project.reload();
    });
    effect(() => {
      const p = this.project.value();
      if (!p) return;
      this.status.set(p.status);
      this.phase.set(p.phase ?? '');
      this.pmNote.set(p.pmNote ?? '');
      this.sharepointUrl.set(p.sharepointUrl ?? '');
    });
  }

  protected reason = (p: ProjectDetail) => jiraReason(this.i18n, p);
  protected jiraUrl = (key: string) => `https://archivagroup.atlassian.net/browse/${key}`;

  protected async save() {
    await this.api.updateProject(this.id(), {
      status: this.status(), phase: this.phase().trim() || null, pmNote: this.pmNote().trim() || null,
      sharepointUrl: this.sharepointUrl().trim() || null,
    } as never);
    this.saved.set(this.i18n.t('pd.saved', { t: new Date().toLocaleTimeString(this.i18n.locale(), { hour: '2-digit', minute: '2-digit' }) }));
    this.project.reload();
  }

  protected async toggleActive() {
    const p = this.project.value();
    if (!p) return;
    await this.api.updateProject(p.id, { active: !p.active });
    this.project.reload();
  }

  protected async addDeadline() {
    if (!this.newTitle().trim() || !this.newDue()) return;
    await this.api.addDeadline(this.id(), this.newTitle().trim(), this.newDue());
    this.newTitle.set('');
    this.newDue.set('');
    this.project.reload();
  }

  protected async toggleDeadline(d: Deadline) {
    await this.api.updateDeadline(d.id, { state: d.state === 'open' ? 'done' : 'open' });
    this.project.reload();
  }

  protected async mailDone(m: MailThread) {
    await this.api.updateMail(m.id, { userState: 'done' });
    this.project.reload();
  }

  protected async toggleOk(r: DocRequirement) {
    await this.api.updateDoc(r.id, { confirmed: r.state !== 'ok' });
    this.project.reload();
  }

  protected async toggleWaive(r: DocRequirement) {
    await this.api.updateDoc(r.id, { waived: !r.waived });
    this.project.reload();
  }
}

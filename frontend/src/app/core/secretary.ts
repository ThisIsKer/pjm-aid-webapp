import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';
import { I18n } from './i18n';
import type { SecretaryJob } from './models';

/**
 * Secretary runs started from the app ("Ingest now", "Recap now"): the job being followed and a `completed`
 * counter that pages watch to reload. Same pattern as SyncService, separate because both can run at once.
 */
@Injectable({ providedIn: 'root' })
export class SecretaryService {
  private readonly api = inject(Api);
  private readonly i18n = inject(I18n);
  readonly job = signal<SecretaryJob | null>(null);
  readonly running = computed(() => this.job()?.status === 'running');
  /** Incremented when a followed run ends, or the app changed the ledger: pages reload when it changes. */
  readonly completed = signal(0);
  private timer: ReturnType<typeof setInterval> | undefined;
  private initialised = false;

  /** At app start: follow a run already in progress (e.g. started before a page reload). */
  async init() {
    if (this.initialised) return;
    this.initialised = true;
    try {
      const j = await this.api.currentSecretaryJob();
      this.job.set(j);
      if (j?.status === 'running') this.follow();
    } catch {
      /* backend down: the pages show it */
    }
  }

  async start(mode: SecretaryJob['mode']) {
    try {
      this.job.set(await this.api.startSecretary(mode, this.i18n.lang()));
      this.follow();
    } catch (err: any) {
      this.job.set({ id: 0, mode, status: 'error', startedAt: new Date().toISOString(), steps: [], denials: [],
        error: err?.error?.error ?? this.i18n.t('sec.startError') });
    }
  }

  notifyChanged() {
    this.completed.update((n) => n + 1);
  }

  private follow() {
    clearInterval(this.timer);
    this.timer = setInterval(async () => {
      const j = await this.api.currentSecretaryJob().catch(() => null);
      if (!j) return;
      this.job.set(j);
      if (j.status !== 'running') {
        clearInterval(this.timer);
        this.completed.update((n) => n + 1);
      }
    }, 2000);
  }
}

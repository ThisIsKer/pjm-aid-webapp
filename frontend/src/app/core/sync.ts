import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';
import { I18n } from './i18n';
import type { SyncJob } from './models';

const AUTO_KEY = 'pjm.autoSync';
const DOCS_MONDAY_KEY = 'pjm.autoSyncDocsMonday';

function read(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === 'on';
  } catch {
    return fallback;
  }
}
function write(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? 'on' : 'off');
  } catch {
    /* storage unavailable: session only */
  }
}

/**
 * "Sync now" state shared by the whole app: the job being followed, the blocking overlay of the daily
 * auto-sync, and a `completed` counter that pages watch to reload their data.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly api = inject(Api);
  private readonly i18n = inject(I18n);
  readonly job = signal<SyncJob | null>(null);
  readonly running = computed(() => this.job()?.status === 'running');
  /** Incremented every time a followed sync ends: pages reload when it changes. */
  readonly completed = signal(0);
  /** Full-screen layer shown while the daily auto-sync runs. */
  readonly overlay = signal(false);
  /** Settings (kept in this browser). */
  readonly autoEnabled = signal(read(AUTO_KEY, true));
  readonly docsOnMonday = signal(read(DOCS_MONDAY_KEY, true));
  private timer: ReturnType<typeof setInterval> | undefined;
  private initialised = false;

  setAuto(on: boolean) {
    this.autoEnabled.set(on);
    write(AUTO_KEY, on);
  }

  setDocsOnMonday(on: boolean) {
    this.docsOnMonday.set(on);
    write(DOCS_MONDAY_KEY, on);
  }

  /** Called once at app start: follow a running sync, or start the daily one on the first opening of the day. */
  async init() {
    if (this.initialised) return;
    this.initialised = true;
    try {
      if (this.autoEnabled()) {
        const mode: SyncJob['mode'] = new Date().getDay() === 1 && this.docsOnMonday() ? 'docs' : 'daily';
        const res = await this.api.autoSync(mode, this.i18n.lang());
        if (res.job && res.job.status === 'running') {
          this.job.set(res.job);
          if (res.job.origin === 'auto') this.overlay.set(true);
          this.follow();
          return;
        }
      }
      const j = await this.api.currentSyncJob();
      if (j?.status === 'running') {
        this.job.set(j);
        this.follow();
      } else if (j) {
        this.job.set(j);
      }
    } catch {
      /* backend down: the pages show it */
    }
  }

  async start(mode: SyncJob['mode']) {
    try {
      this.job.set(await this.api.startSync(mode, this.i18n.lang()));
      this.follow();
    } catch (err: any) {
      this.job.set({ id: 0, mode, origin: 'manual', status: 'error', startedAt: new Date().toISOString(), steps: [], denials: [],
        error: err?.error?.error ?? this.i18n.t('sync.startError') });
    }
  }

  /** Let pages reload after something other than "Sync now" changed the data (e.g. a manual import). */
  notifyChanged() {
    this.completed.update((n) => n + 1);
  }

  private follow() {
    clearInterval(this.timer);
    this.timer = setInterval(async () => {
      const j = await this.api.currentSyncJob().catch(() => null);
      if (!j) return;
      this.job.set(j);
      if (j.status !== 'running') {
        clearInterval(this.timer);
        this.completed.update((n) => n + 1);
        // A successful daily sync closes its overlay by itself; on errors it stays open to show what happened.
        if (j.status === 'ok' && this.overlay()) setTimeout(() => this.overlay.set(false), 1500);
      }
    }, 2000);
  }
}

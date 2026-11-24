import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { I18n, TPipe } from './core/i18n';
import { SecretaryService } from './core/secretary';
import { SyncService } from './core/sync';
import { Theme } from './core/theme';
import { SyncOverlay } from './shared/sync-overlay';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TPipe, SyncOverlay],
  templateUrl: './app.html',
  host: { '(document:keydown.escape)': 'navOpen.set(false)' },
})
export class App {
  protected readonly i18n = inject(I18n);
  /** Instantiated here so the saved theme is applied at startup. */
  private readonly theme = inject(Theme);
  protected readonly sync = inject(SyncService);
  protected readonly secretary = inject(SecretaryService);
  /** The navigation menu is hidden; the PJM aid logo opens it. */
  protected readonly navOpen = signal(false);
  protected readonly nav = [
    { path: '/dashboard', label: 'nav.dashboard' },
    { path: '/projects', label: 'nav.projects' },
    { path: '/secretary', label: 'nav.secretary' },
    { path: '/mail', label: 'nav.mail' },
    { path: '/todo', label: 'nav.todo' },
    { path: '/docs', label: 'nav.docs' },
  ];

  constructor() {
    document.documentElement.lang = this.i18n.lang();
    // first opening of the day → daily sync (blocking overlay); otherwise follow a sync already running
    void this.sync.init();
    // follow a secretary run already in progress (started before a reload)
    void this.secretary.init();
  }
}

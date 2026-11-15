import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { I18n, TPipe } from './core/i18n';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TPipe],
  templateUrl: './app.html',
})
export class App {
  protected readonly i18n = inject(I18n);
  protected readonly nav = [
    { path: '/dashboard', label: 'nav.dashboard' },
    { path: '/projects', label: 'nav.projects' },
    { path: '/mail', label: 'nav.mail' },
    { path: '/docs', label: 'nav.docs' },
  ];

  constructor() {
    document.documentElement.lang = this.i18n.lang();
  }
}

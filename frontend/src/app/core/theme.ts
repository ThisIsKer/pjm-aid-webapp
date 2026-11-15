import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';

export type ThemeChoice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'pjm.theme';

/** Light / dark theme. "system" follows the operating system setting. The choice is remembered in this browser. */
@Injectable({ providedIn: 'root' })
export class Theme {
  readonly choice = signal<ThemeChoice>(Theme.stored());
  private readonly media = window.matchMedia('(prefers-color-scheme: dark)');
  private readonly systemDark = signal(this.media.matches);
  /** The theme actually applied. */
  readonly effective = computed(() => (this.choice() === 'system' ? (this.systemDark() ? 'dark' : 'light') : this.choice()));

  constructor() {
    const onChange = (e: MediaQueryListEvent) => this.systemDark.set(e.matches);
    this.media.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => this.media.removeEventListener('change', onChange));
    effect(() => document.documentElement.setAttribute('data-theme', this.effective()));
  }

  private static stored(): ThemeChoice {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === 'dark' || v === 'system' ? v : 'light';
    } catch {
      return 'light';
    }
  }

  set(choice: ThemeChoice) {
    this.choice.set(choice);
    try {
      localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      /* storage unavailable: keep the choice for this session only */
    }
  }
}

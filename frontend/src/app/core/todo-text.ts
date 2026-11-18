import { formatDate } from '@angular/common';
import type { I18n } from './i18n';
import type { TodoTask } from './models';

/** Title in the current language: automatic to-dos are translated (unless you renamed them). */
export function taskTitle(t: TodoTask, lang: string): string {
  return t.autoTitles?.[lang] ?? t.autoTitles?.['en'] ?? t.title;
}

/** "Auto: UAT starts on 23/11/26 (DDMD-6405)" in the current language. */
export function autoInfoText(i18n: I18n, t: TodoTask): string {
  const a = t.autoInfo;
  if (!a) return '';
  return i18n.t(a.anchor === 'end' ? 'todo.autoInfoEnd' : 'todo.autoInfoStart', {
    p: a.phase, d: formatDate(a.date, 'dd/MM/yy', i18n.locale()), k: (a.keys ?? []).join(', '),
  });
}

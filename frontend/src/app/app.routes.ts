import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: 'dashboard', title: 'Dashboard · PJM aid', loadComponent: () => import('./pages/dashboard/dashboard').then((m) => m.DashboardPage) },
  { path: 'projects', title: 'Projects · PJM aid', loadComponent: () => import('./pages/projects/projects').then((m) => m.ProjectsPage) },
  { path: 'projects/:id', title: 'Project · PJM aid', loadComponent: () => import('./pages/project-detail/project-detail').then((m) => m.ProjectDetailPage) },
  { path: 'mail', title: 'Mail · PJM aid', loadComponent: () => import('./pages/mail/mail').then((m) => m.MailPage) },
  { path: 'todo', title: 'To-do · PJM aid', loadComponent: () => import('./pages/todo/todo').then((m) => m.TodoPage) },
  { path: 'secretary', title: 'Secretary · PJM aid', loadComponent: () => import('./pages/secretary/secretary').then((m) => m.SecretaryPage) },
  { path: 'docs', title: 'Documentation · PJM aid', loadComponent: () => import('./pages/docs/docs').then((m) => m.DocsPage) },
  { path: 'settings', title: 'Settings · PJM aid', loadComponent: () => import('./pages/settings/settings').then((m) => m.SettingsPage) },
  { path: '**', redirectTo: 'dashboard' },
];

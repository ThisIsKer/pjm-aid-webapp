import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: 'dashboard', title: 'Dashboard · PJM aid', loadComponent: () => import('./pages/dashboard/dashboard').then((m) => m.DashboardPage) },
  { path: 'projects', title: 'Projects · PJM aid', loadComponent: () => import('./pages/projects/projects').then((m) => m.ProjectsPage) },
  { path: 'mail', title: 'Mail · PJM aid', loadComponent: () => import('./pages/mail/mail').then((m) => m.MailPage) },
  { path: 'docs', title: 'Documentation · PJM aid', loadComponent: () => import('./pages/docs/docs').then((m) => m.DocsPage) },
  { path: '**', redirectTo: 'dashboard' },
];

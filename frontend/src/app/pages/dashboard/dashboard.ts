import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import type { Dashboard } from '../../core/models';
import { RagDot } from '../../shared/rag-dot';

@Component({
  selector: 'app-dashboard',
  imports: [DatePipe, RouterLink, RagDot],
  templateUrl: './dashboard.html',
})
export class DashboardPage {
  private readonly api = inject(Api);
  protected readonly data = httpResource<Dashboard>(() => '/api/dashboard');
  protected readonly syncMessage = signal<string | null>(null);

  protected async importSnapshot() {
    const res = await this.api.importSnapshot();
    this.syncMessage.set(res.imported ? `Imported${res.warnings?.length ? ` with ${res.warnings.length} warning(s)` : ''}` : (res.reason ?? 'Nothing to import'));
    this.data.reload();
  }
}

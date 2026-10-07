import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import type { AuditInfo } from "./api.js";
import { shortId, when } from "./format.js";
import { SessionService } from "./session.service.js";

@Component({
  selector: "app-audit",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Audit trail</h2>
    <p class="row"><button data-testid="refresh-audit" (click)="load()">Refresh</button></p>
    @if (error()) {
      <p class="error" role="alert" data-testid="error">{{ error() }}</p>
    }
    <table>
      <thead><tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
      <tbody>
        @for (e of events(); track e.id) {
          <tr [attr.data-testid]="'audit-' + e.id">
            <td>{{ e.id }}</td>
            <td>{{ when(e.atMs) }}</td>
            <td [title]="e.actor">{{ shortId(e.actor) }}</td>
            <td>{{ e.action }}</td>
            <td [title]="e.target">{{ shortId(e.target) }}</td>
            <td>{{ e.detail }}</td>
          </tr>
        } @empty {
          <tr><td colspan="6">{{ loading() ? "Loading…" : "No events." }}</td></tr>
        }
      </tbody>
    </table>
  `,
})
export class AuditView {
  private readonly session = inject(SessionService);
  protected readonly events = signal<AuditInfo[]>([]);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly loading = signal(true);
  protected readonly when = when;
  protected readonly shortId = shortId;

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    const r = await this.session.guard(() => this.session.api.audit());
    this.loading.set(false);
    if (r.ok) {
      this.events.set(r.value);
      this.error.set(undefined);
    } else this.error.set(r.message);
  }
}

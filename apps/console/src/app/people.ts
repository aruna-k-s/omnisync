import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import type { CertInfo, Person } from "./api.js";
import { certState, shortId, when } from "./format.js";
import { SessionService } from "./session.service.js";

@Component({
  selector: "app-people",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>People</h2>
    @if (error()) {
      <p class="error" role="alert" data-testid="error">{{ error() }}</p>
    }
    <table>
      <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th></tr></thead>
      <tbody>
        @for (p of people(); track p.id) {
          <tr [attr.data-testid]="'person-' + p.id" [class.selected]="selected()?.id === p.id" (click)="select(p)" tabindex="0" (keydown.enter)="select(p)">
            <td>{{ p.email }}</td>
            <td>{{ p.displayName }}</td>
            <td>{{ p.orgRole }}</td>
            <td>{{ p.disabledAtMs === undefined ? "active" : "disabled " + when(p.disabledAtMs) }}</td>
          </tr>
        } @empty {
          <tr><td colspan="4">{{ loading() ? "Loading…" : "Nobody has signed in yet." }}</td></tr>
        }
      </tbody>
    </table>

    @if (selected(); as p) {
      <section class="panel" data-testid="person-detail">
        <h3>{{ p.email }}</h3>
        <p class="muted">Id {{ p.id }}</p>
        <h4>Certificates (devices)</h4>
        <table>
          <thead><tr><th>Serial</th><th>Issued</th><th>Expires</th><th>State</th><th></th></tr></thead>
          <tbody>
            @for (c of certs(); track c.serial) {
              <tr [attr.data-testid]="'cert-' + c.serial">
                <td [title]="c.serial">{{ shortId(c.serial) }}</td>
                <td>{{ when(c.issuedAtMs) }}</td>
                <td>{{ when(c.notAfterMs) }}</td>
                <td [attr.data-state]="state(c)">{{ state(c) }}{{ c.revokeReason ? " (" + c.revokeReason + ")" : "" }}</td>
                <td>
                  @if (state(c) === "active" || state(c) === "not yet valid") {
                    <button class="danger" [attr.data-testid]="'revoke-' + c.serial" (click)="revoke(c)">Revoke</button>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="5">No devices enrolled.</td></tr>
            }
          </tbody>
        </table>
        @if (p.disabledAtMs === undefined && p.id !== session.me()?.id) {
          <p><button class="danger" [attr.data-testid]="'disable-' + p.id" (click)="disable(p)">Disable account and revoke every device</button></p>
        }
      </section>
    }
  `,
})
export class PeopleView {
  protected readonly session = inject(SessionService);
  protected readonly people = signal<Person[]>([]);
  protected readonly selected = signal<Person | undefined>(undefined);
  protected readonly certs = signal<CertInfo[]>([]);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly loading = signal(true);
  protected readonly when = when;
  protected readonly shortId = shortId;

  constructor() {
    void this.load();
  }

  protected state(c: CertInfo): string {
    return certState(c, Date.now());
  }

  async load(): Promise<void> {
    this.loading.set(true);
    const r = await this.session.guard(() => this.session.api.people());
    this.loading.set(false);
    if (r.ok) {
      this.people.set(r.value);
      this.error.set(undefined);
      const sel = this.selected();
      if (sel) this.selected.set(r.value.find((p) => p.id === sel.id));
    } else this.error.set(r.message);
  }

  async select(p: Person): Promise<void> {
    this.selected.set(p);
    await this.loadCerts(p);
  }

  async loadCerts(p: Person): Promise<void> {
    const r = await this.session.guard(() => this.session.api.certificates(p.id));
    if (r.ok) this.certs.set(r.value);
    else this.error.set(r.message);
  }

  async revoke(c: CertInfo): Promise<void> {
    const p = this.selected();
    if (!p) return;
    const r = await this.session.guard(() => this.session.api.revoke(c.serial, "revoked in console"));
    this.error.set(r.ok ? undefined : r.message);
    await this.loadCerts(p);
  }

  async disable(p: Person): Promise<void> {
    const r = await this.session.guard(() => this.session.api.disable(p.id));
    this.error.set(r.ok ? undefined : r.message);
    await this.load();
    await this.loadCerts(p);
  }
}

import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { ROLES, type DocInfo, type GrantInfo, type Person, type Role } from "./api.js";
import { shortId, when } from "./format.js";
import { SessionService } from "./session.service.js";

@Component({
  selector: "app-documents",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Documents</h2>
    @if (error()) {
      <p class="error" role="alert" data-testid="error">{{ error() }}</p>
    }
    <table>
      <thead><tr><th>Id</th><th>Created by</th><th>Created</th></tr></thead>
      <tbody>
        @for (d of docs(); track d.id) {
          <tr [attr.data-testid]="'doc-' + d.id" [class.selected]="selected()?.id === d.id" (click)="select(d)" tabindex="0" (keydown.enter)="select(d)">
            <td [title]="d.id">{{ shortId(d.id) }}</td>
            <td>{{ name(d.createdBy) }}</td>
            <td>{{ when(d.createdAtMs) }}</td>
          </tr>
        } @empty {
          <tr><td colspan="3">{{ loading() ? "Loading…" : "No documents yet." }}</td></tr>
        }
      </tbody>
    </table>

    @if (selected(); as d) {
      <section class="panel" data-testid="doc-detail">
        <h3>Access to {{ shortId(d.id) }}</h3>
        <table>
          <thead><tr><th>Person</th><th>Role</th><th>Granted by</th><th></th></tr></thead>
          <tbody>
            @for (g of grants(); track g.principalId) {
              <tr [attr.data-testid]="'grant-' + g.principalId">
                <td>{{ name(g.principalId) }}</td>
                <td>
                  <select [attr.data-testid]="'role-' + g.principalId" [value]="g.role" (change)="setRole(g.principalId, $any($event.target).value, $any($event.target))">
                    @for (r of roles; track r) {
                      <option [value]="r" [selected]="r === g.role">{{ r }}</option>
                    }
                  </select>
                </td>
                <td>{{ name(g.grantedBy) }}</td>
                <td><button class="danger" [attr.data-testid]="'remove-' + g.principalId" (click)="remove(g.principalId)">Remove</button></td>
              </tr>
            }
          </tbody>
        </table>
        <p class="row">
          <select #who data-testid="add-who" aria-label="Person">
            @for (p of people(); track p.id) {
              <option [value]="p.id">{{ p.email }}</option>
            }
          </select>
          <select #role data-testid="add-role" aria-label="Role">
            @for (r of roles; track r) {
              <option [value]="r">{{ r }}</option>
            }
          </select>
          <button data-testid="add-grant" (click)="setRole(who.value, $any(role.value))">Grant</button>
        </p>
      </section>
    }
  `,
})
export class DocumentsView {
  private readonly session = inject(SessionService);
  protected readonly docs = signal<DocInfo[]>([]);
  protected readonly people = signal<Person[]>([]);
  protected readonly grants = signal<GrantInfo[]>([]);
  protected readonly selected = signal<DocInfo | undefined>(undefined);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly loading = signal(true);
  protected readonly roles = ROLES;
  protected readonly when = when;
  protected readonly shortId = shortId;

  constructor() {
    void this.load();
  }

  protected name(id: string): string {
    return this.people().find((p) => p.id === id)?.email ?? shortId(id);
  }

  async load(): Promise<void> {
    const [d, p] = await Promise.all([this.session.guard(() => this.session.api.documents()), this.session.guard(() => this.session.api.people())]);
    this.loading.set(false);
    if (d.ok && p.ok) {
      this.docs.set(d.value);
      this.people.set(p.value);
      this.error.set(undefined);
    } else this.error.set(!d.ok ? d.message : !p.ok ? p.message : undefined);
  }

  async select(d: DocInfo): Promise<void> {
    this.selected.set(d);
    await this.loadGrants(d);
  }

  async loadGrants(d: DocInfo): Promise<void> {
    const r = await this.session.guard(() => this.session.api.grants(d.id));
    if (r.ok) this.grants.set(r.value);
    else this.error.set(r.message);
  }

  async setRole(principalId: string, role: Role, control?: { value: string }): Promise<void> {
    const d = this.selected();
    if (!d) return;
    const r = await this.session.guard(() => this.session.api.setGrant(d.id, principalId, role));
    this.error.set(r.ok ? undefined : r.message);
    await this.loadGrants(d);
    // The dropdown already shows what the person picked; if the server refused, put back what is true.
    const actual = this.grants().find((g) => g.principalId === principalId)?.role;
    if (control && actual !== undefined) control.value = actual;
  }

  async remove(principalId: string): Promise<void> {
    const d = this.selected();
    if (!d) return;
    const r = await this.session.guard(() => this.session.api.removeGrant(d.id, principalId));
    this.error.set(r.ok ? undefined : r.message);
    await this.loadGrants(d);
  }
}

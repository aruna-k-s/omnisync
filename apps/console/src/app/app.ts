import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { AuditView } from "./audit.js";
import { DocumentsView } from "./documents.js";
import { LedgerPage } from "./ledger-page.js";
import { PeopleView } from "./people.js";
import { SessionService } from "./session.service.js";

type View = "people" | "documents" | "ledger" | "audit";
const VIEWS: readonly { id: View; label: string }[] = [
  { id: "people", label: "People" },
  { id: "documents", label: "Documents" },
  { id: "ledger", label: "Ledger" },
  { id: "audit", label: "Audit" },
];

@Component({
  selector: "app-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PeopleView, DocumentsView, LedgerPage, AuditView],
  template: `
    <header>
      <h1>OmniSync console</h1>
      @if (session.me(); as me) {
        <nav aria-label="Sections">
          @for (v of views; track v.id) {
            <button [attr.data-testid]="'nav-' + v.id" [class.active]="view() === v.id" (click)="view.set(v.id)">{{ v.label }}</button>
          }
        </nav>
        <span class="who" data-testid="whoami">{{ me.email }}</span>
        <button data-testid="signout" (click)="session.signOut()">Sign out</button>
      }
    </header>
    <main>
      @if (!session.ready()) {
        <p>Loading…</p>
      } @else if (session.me()) {
        @switch (view()) {
          @case ("people") { <app-people /> }
          @case ("documents") { <app-documents /> }
          @case ("ledger") { <app-ledger /> }
          @case ("audit") { <app-audit /> }
        }
      } @else {
        <section class="panel signin">
          <p>Sign in with your company account. Only organisation admins can use this console.</p>
          @if (session.notice()) {
            <p class="error" role="alert" data-testid="notice">{{ session.notice() }}</p>
          }
          <button data-testid="signin" (click)="session.signIn()">Sign in</button>
        </section>
      }
    </main>
  `,
})
export class App {
  protected readonly session = inject(SessionService);
  protected readonly view = signal<View>("people");
  protected readonly views = VIEWS;

  constructor() {
    void this.session.start();
  }
}

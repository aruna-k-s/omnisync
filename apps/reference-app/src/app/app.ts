import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { AppSession } from "./auth.service.js";
import { Home } from "./home.js";
import { WorkbookPage } from "./workbook-view.js";

@Component({
  selector: "app-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Home, WorkbookPage],
  template: `
    <header>
      <h1>OmniSync workbook</h1>
      <span class="spacer"></span>
      @if (session.me(); as me) {
        <span class="who" data-testid="whoami">{{ me.email }}</span>
        <button data-testid="signout" (click)="signOut()">Sign out</button>
      }
    </header>
    <main>
      @if (!session.ready()) {
        <p>Loading…</p>
      } @else if (session.me()) {
        @if (doc(); as id) {
          <app-workbook [docId]="id" (close)="doc.set(undefined)" />
        } @else {
          <app-home (open)="doc.set($event)" />
        }
      } @else {
        <section class="panel signin">
          <p>Sign in with your company account to open or create workbooks. Every edit you make is signed on this device.</p>
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
  protected readonly session = inject(AppSession);
  protected readonly doc = signal<string | undefined>(undefined);

  constructor() {
    void this.session.start();
  }

  protected async signOut(): Promise<void> {
    this.doc.set(undefined);
    await this.session.signOut();
  }
}

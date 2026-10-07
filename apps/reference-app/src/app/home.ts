import { ChangeDetectionStrategy, Component, inject, output, signal } from "@angular/core";
import { DOC_ID } from "./recent.js";
import { AppSession } from "./auth.service.js";

@Component({
  selector: "app-home",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Your workbooks</h2>
    @if (error()) {
      <p class="error" role="alert" data-testid="error">{{ error() }}</p>
    }
    <p class="row">
      <button data-testid="new-workbook" [disabled]="busy()" (click)="create()">New workbook</button>
    </p>
    <ul class="recent">
      @for (r of session.recent.list(); track r.id) {
        <li>
          <button class="link" [attr.data-testid]="'recent-' + r.id" (click)="open.emit(r.id)">{{ r.title }}</button>
          <span class="muted"> {{ r.id.slice(0, 8) }}…</span>
        </li>
      } @empty {
        <li class="muted">Nothing opened in this browser yet.</li>
      }
    </ul>
    <h3>Open a shared workbook</h3>
    <p class="muted">Ask the person who owns it for its id; an organisation admin grants your access in the console.</p>
    <p class="row">
      <input #id data-testid="open-id" placeholder="Workbook id" size="40" autocomplete="off" (keydown.enter)="go(id.value)" />
      <button data-testid="open-go" (click)="go(id.value)">Open</button>
    </p>
  `,
})
export class Home {
  protected readonly session = inject(AppSession);
  readonly open = output<string>();
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly busy = signal(false);

  async create(): Promise<void> {
    this.busy.set(true);
    try {
      this.open.emit(await this.session.createDocument());
      this.error.set(undefined);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }

  go(raw: string): void {
    const id = raw.trim().toLowerCase();
    if (!DOC_ID.test(id)) return void this.error.set("That is not a workbook id.");
    this.error.set(undefined);
    this.open.emit(id);
  }
}

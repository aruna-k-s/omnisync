import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from "@angular/core";
import { DeviceLoginError, type DeviceRequestInfo } from "@omnisync/sdk";
import { AppSession } from "./auth.service.js";

/** Approve or deny a device (a command line, a build agent) that asked to be signed in as this person. */
@Component({
  selector: "app-device-approval",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel" data-testid="device-approval">
      <h2>Sign in a device?</h2>
      @if (result(); as r) {
        <p data-testid="device-result">{{ r === "approved" ? "Approved. You can go back to the device." : "Denied. The device was not signed in." }}</p>
        <button data-testid="device-close" (click)="done.emit()">Close</button>
      } @else if (info(); as i) {
        @if (i.status !== "pending") {
          <p data-testid="device-error">This request was already decided.</p>
          <button data-testid="device-close" (click)="done.emit()">Close</button>
        } @else {
          <p>A device is asking to sign in as <strong>{{ session.me()?.email }}</strong>.</p>
          <dl>
            <dt>Name it gave</dt>
            <dd data-testid="device-label">{{ i.label || "(none)" }}</dd>
            <dt>Code it shows</dt>
            <dd data-testid="device-code">{{ code() }}</dd>
            <dt>Asked at</dt>
            <dd>{{ asked(i) }}</dd>
          </dl>
          <p class="muted">Approve only if you just started this on a machine you control and its screen shows the same code. It will get a certificate that acts as you for up to 12 hours.</p>
          @if (error()) {
            <p class="error" role="alert" data-testid="device-error">{{ error() }}</p>
          }
          <p class="row">
            <button data-testid="device-approve" [disabled]="busy()" (click)="decide('approve')">Approve</button>
            <button data-testid="device-deny" [disabled]="busy()" (click)="decide('deny')">Deny</button>
            <button class="link" data-testid="device-later" [disabled]="busy()" (click)="done.emit()">Not now</button>
          </p>
        }
      } @else if (error()) {
        <p class="error" role="alert" data-testid="device-error">{{ error() }}</p>
        <button data-testid="device-close" (click)="done.emit()">Close</button>
      } @else {
        <p>Looking up the request…</p>
      }
    </section>
  `,
})
export class DeviceApproval {
  protected readonly session = inject(AppSession);
  readonly code = input.required<string>();
  readonly done = output();
  protected readonly info = signal<DeviceRequestInfo | undefined>(undefined);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly result = signal<"approved" | "denied" | undefined>(undefined);
  protected readonly busy = signal(false);

  constructor() {
    effect(() => {
      void this.#load(this.code());
    });
  }

  async #load(code: string): Promise<void> {
    this.info.set(undefined);
    this.error.set(undefined);
    try {
      this.info.set(await this.session.describeDevice(code));
    } catch (e) {
      this.error.set(this.#why(e, "This request was not found. It may have expired: start the sign-in on the device again."));
    }
  }

  protected asked(i: DeviceRequestInfo): string {
    return new Date(i.createdAtMs).toLocaleString();
  }

  protected async decide(decision: "approve" | "deny"): Promise<void> {
    this.busy.set(true);
    this.error.set(undefined);
    try {
      await this.session.decideDevice(this.code(), decision);
      this.result.set(decision === "approve" ? "approved" : "denied");
    } catch (e) {
      this.error.set(this.#why(e, "That did not work."));
    } finally {
      this.busy.set(false);
    }
  }

  #why(e: unknown, notFound: string): string {
    if (e instanceof DeviceLoginError) {
      if (e.status === 404) return notFound;
      if (e.status === 409) return "This request was already decided.";
      if (e.status === 429) return "Too many tries. Wait a minute and try again.";
      return e.message;
    }
    return e instanceof Error ? e.message : String(e);
  }
}

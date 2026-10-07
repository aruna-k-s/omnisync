import { Injectable, signal } from "@angular/core";
import { AdminApi, ApiError } from "./api.js";
import { loginUrl, returnToOf, sessionFromHash } from "@omnisync/sdk/session";
import { parseConfig, type ConsoleConfig } from "./session.js";

export interface Me {
  id: string;
  email: string;
  displayName: string;
  orgRole: string;
}

/** The signed-in state of this page. The token is never written anywhere: a reload signs in again. */
@Injectable({ providedIn: "root" })
export class SessionService {
  readonly ready = signal(false);
  readonly me = signal<Me | undefined>(undefined);
  /** Why the page is signed out, when it is not simply new. */
  readonly notice = signal<string | undefined>(undefined);
  #config: ConsoleConfig = { controlPlane: "" };
  #token: string | undefined;
  readonly api = new AdminApi(
    "",
    () => this.#token,
    (input, init) => globalThis.fetch(`${this.#config.controlPlane}${String(input)}`, init),
  );

  async start(): Promise<void> {
    try {
      const res = await fetch("config.json", { cache: "no-store" });
      if (res.ok) this.#config = parseConfig(await res.json());
    } catch (e) {
      this.notice.set(`Configuration error: ${e instanceof Error ? e.message : String(e)}`);
      this.ready.set(true);
      return;
    }
    const token = sessionFromHash(location.hash);
    if (token) {
      // Out of the address bar and the history before anything else can read or copy it.
      history.replaceState(null, "", location.pathname + location.search);
      this.#token = token;
      await this.#loadMe();
    }
    this.ready.set(true);
  }

  signIn(): void {
    location.assign(loginUrl(this.#config.controlPlane, { returnTo: returnToOf(location) }));
  }

  signOut(message?: string): void {
    this.#token = undefined;
    this.me.set(undefined);
    this.notice.set(message);
  }

  /** Runs an API call; a 401 signs out, anything else is returned as a message for the page to show. */
  async guard<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
    try {
      return { ok: true, value: await run() };
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        this.signOut("Your session ended. Sign in again.");
        return { ok: false, message: "signed out" };
      }
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  async #loadMe(): Promise<void> {
    const r = await this.guard(() => this.api.me());
    if (!r.ok) return void this.notice.set(r.message === "signed out" ? this.notice() : `Sign-in failed: ${r.message}`);
    if (r.value.orgRole !== "admin") {
      this.signOut(`${r.value.email} is not an organisation admin. Ask an admin for access.`);
      return;
    }
    this.me.set(r.value);
  }
}

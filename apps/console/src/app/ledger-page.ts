import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { when } from "./format.js";
import { MAX_ENTRIES_SHOWN, verifyExport, type LedgerView } from "./ledger.js";
import { SessionService } from "./session.service.js";

@Component({
  selector: "app-ledger",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Ledger</h2>
    <p class="muted">
      Downloads the tenant's export and runs the verifier in this page. The keys come from the same server, so a pass means
      <em>consistent</em>, never <em>anchored</em>. For an audit, download the export and run <code>omnisync verify</code> with
      keys you hold and the locked checkpoints.
    </p>
    <p class="row">
      <button data-testid="verify" [disabled]="busy()" (click)="verify()">{{ busy() ? "Verifying…" : "Verify ledger" }}</button>
      <button data-testid="download" [disabled]="busy()" (click)="download()">Download export</button>
    </p>
    @if (error()) {
      <p class="error" role="alert" data-testid="error">{{ error() }}</p>
    }
    @if (view(); as v) {
      <section class="panel" [class.ok]="v.status === 'consistent'" [class.bad]="v.status !== 'consistent'">
        <p data-testid="ledger-status" [attr.data-status]="v.status"><strong>{{ v.status === "consistent" ? "Consistent" : v.status === "failed" ? "Failed" : "Unreadable" }}</strong> — {{ v.headline }}</p>
        @if (v.report; as r) {
          <p data-testid="ledger-counts">
            Tenant {{ r.tenant }} · {{ r.counts.documents }} {{ r.counts.documents === 1 ? "document" : "documents" }} · {{ r.counts.entries }} {{ r.counts.entries === 1 ? "entry" : "entries" }} · {{ r.counts.certificates }} {{ r.counts.certificates === 1 ? "certificate" : "certificates" }} ·
            {{ r.counts.checkpoints }} {{ r.counts.checkpoints === 1 ? "checkpoint" : "checkpoints" }} · {{ r.counts.entriesAfterLastCheckpoint }} not yet covered by a checkpoint · not anchored
          </p>
          @for (x of r.violations; track $index) {
            <p class="error" data-testid="violation">{{ x.code }}: {{ x.message }}</p>
          }
        }
        @if (v.entries.length > 0) {
          <table>
            <thead><tr><th></th><th>Document</th><th>#</th><th>Received</th><th>Signed by</th><th>Entry hash</th></tr></thead>
            <tbody>
              @for (e of v.entries; track e.doc + ":" + e.seq) {
                <tr [attr.data-testid]="'entry-' + e.doc + '-' + e.seq" [attr.data-verified]="e.verified" [title]="e.problem ?? ''">
                  <td>{{ e.verified ? "✓" : "✗" }}</td>
                  <td>{{ e.doc.slice(0, 8) }}…</td>
                  <td>{{ e.seq }}</td>
                  <td>{{ when(e.receivedAtMs) }}</td>
                  <td>{{ e.signer ?? "unknown" }}</td>
                  <td [title]="e.entryHash"><code>{{ e.hashShort }}</code></td>
                </tr>
              }
            </tbody>
          </table>
          @if (v.total > v.entries.length) {
            <p class="muted">Showing the first {{ max }} of {{ v.total }} entries. All were verified.</p>
          }
        }
      </section>
    }
  `,
})
export class LedgerPage {
  private readonly session = inject(SessionService);
  protected readonly view = signal<LedgerView | undefined>(undefined);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly max = MAX_ENTRIES_SHOWN;
  protected readonly when = when;
  #text: string | undefined;

  async verify(): Promise<void> {
    this.busy.set(true);
    this.error.set(undefined);
    try {
      const r = await this.session.guard(async () => ({ trust: await this.session.api.trust(), text: await this.session.api.exportText() }));
      if (!r.ok) return void this.error.set(r.message);
      this.#text = r.value.text;
      this.view.set(await verifyExport(r.value.text, r.value.trust));
    } finally {
      this.busy.set(false);
    }
  }

  async download(): Promise<void> {
    if (this.#text === undefined) {
      const r = await this.session.guard(() => this.session.api.exportText());
      if (!r.ok) return void this.error.set(r.message);
      this.#text = r.value;
    }
    const url = URL.createObjectURL(new Blob([this.#text], { type: "application/x-ndjson" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "ledger.ndjson";
    a.click();
    URL.revokeObjectURL(url);
  }
}

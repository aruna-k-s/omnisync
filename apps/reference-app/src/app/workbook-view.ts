import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, viewChild, type ElementRef, type OnDestroy } from "@angular/core";
import type { SyncDocument } from "@omnisync/sdk";
import { AppSession } from "./auth.service.js";
import { applyChange, diffText, shiftCaret } from "./text-diff.js";
import { Workbook, columnTotal, fromSyncDocument, type SheetView, type WorkbookView } from "./workbook.js";

@Component({
  selector: "app-workbook",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="row">
      <button data-testid="back" (click)="close.emit()">← Workbooks</button>
      <span class="muted">Id <code data-testid="doc-id">{{ docId() }}</code></span>
    </p>
    @if (loadError()) {
      <p class="error" role="alert" data-testid="error">{{ loadError() }}</p>
    }
    <p class="status" data-testid="status" [attr.data-state]="state()" [attr.data-pending]="pending()">
      <span class="dot" [class.on]="state() === 'online'"></span>
      <span data-testid="status-state">{{ stateText() }}</span>
      @if (pending() > 0) {
        · <span data-testid="pending">{{ pending() }} {{ pending() === 1 ? "edit" : "edits" }} saved on this device, not yet confirmed</span>
      }
      @if (readOnly()) {
        · <strong data-testid="read-only">read only</strong>
      }
      @if (session.keyExtractable() === false) {
        · <span data-testid="key-badge" title="Every edit is signed with a key no script on this page can read">device key protected</span>
      } @else if (session.keyExtractable() === true) {
        · <span data-testid="key-badge" title="This browser cannot hold a protected key; the key lives in memory for this page only">device key in memory</span>
      }
    </p>
    @for (w of session.warnings(); track w) {
      <p class="muted" data-testid="warning">{{ w }}</p>
    }

    @if (view(); as v) {
      <input class="title" data-testid="title" aria-label="Workbook title" [value]="v.title" [disabled]="readOnly()" (change)="wb()?.setTitle($any($event.target).value)" />
      <nav class="tabs" aria-label="Sheets">
        @for (s of v.sheets; track s.id; let i = $index) {
          <button [attr.data-testid]="'sheet-tab-' + i" [class.active]="s.id === sheet()?.id" (click)="selected.set(s.id)">{{ s.name }}</button>
        }
        @if (!readOnly()) {
          <button data-testid="add-sheet" (click)="addSheet()">+ Sheet</button>
        }
      </nav>
      @if (sheet(); as s) {
        @if (!readOnly()) {
          <p class="row">
            <input data-testid="sheet-name" aria-label="Sheet name" [value]="s.name" (change)="wb()?.renameSheet(s.id, $any($event.target).value)" />
            @if (v.sheets.length > 1) {
              <button class="danger" data-testid="delete-sheet" (click)="wb()?.deleteSheet(s.id)">Delete sheet</button>
            }
          </p>
        }
        <div class="grid">
          <table data-testid="grid">
            <thead>
              <tr>
                <th class="idx"></th>
                @for (c of s.columns; track c.id; let ci = $index) {
                  <th><input [attr.data-testid]="'col-name-' + ci" aria-label="Column name" [value]="c.name" [disabled]="readOnly()" (change)="wb()?.renameColumn(s.id, c.id, $any($event.target).value)" /></th>
                }
                @if (!readOnly()) {
                  <th><button data-testid="add-col" (click)="wb()?.addColumn(s.id, '')">+ Column</button></th>
                }
              </tr>
            </thead>
            <tbody>
              @for (r of s.rows; track r.id; let ri = $index) {
                <tr [attr.data-testid]="'row-' + ri">
                  <td class="idx">{{ ri + 1 }}</td>
                  @for (c of s.columns; track c.id; let ci = $index) {
                    <td>
                      <input
                        [attr.data-testid]="'cell-' + ri + '-' + ci"
                        [attr.aria-label]="c.name + ' row ' + (ri + 1)"
                        [value]="r.cells[ci]"
                        [disabled]="readOnly()"
                        (change)="wb()?.setCell(s.id, r.id, c.id, $any($event.target).value)"
                        (keydown.enter)="$any($event.target).blur()"
                      />
                    </td>
                  }
                  @if (!readOnly()) {
                    <td><button class="danger" [attr.data-testid]="'del-row-' + ri" aria-label="Delete row" (click)="wb()?.deleteRow(s.id, r.id)">×</button></td>
                  }
                </tr>
              }
            </tbody>
            <tfoot>
              <tr>
                <td class="idx">Σ</td>
                @for (c of s.columns; track c.id; let ci = $index) {
                  <td [attr.data-testid]="'total-' + ci">{{ total(s, ci) }}</td>
                }
                @if (!readOnly()) {
                  <td></td>
                }
              </tr>
            </tfoot>
          </table>
        </div>
        @if (!readOnly()) {
          <p><button data-testid="add-row" (click)="wb()?.addRow(s.id)">+ Row</button></p>
        }
      }
    } @else if (loaded()) {
      <section class="panel" data-testid="empty-workbook">
        <p>This document has no workbook yet.</p>
        @if (!readOnly()) {
          <button data-testid="start-workbook" (click)="wb()?.start()">Start a workbook</button>
        }
      </section>
    }

    <h3>Notes</h3>
    <textarea
      #notes
      data-testid="notes"
      rows="8"
      aria-label="Shared notes"
      placeholder="Everyone with access can type here at the same time."
      [disabled]="readOnly()"
      (input)="onNotesInput()"
      (compositionstart)="composing = true"
      (compositionend)="composing = false; onNotesInput()"
    ></textarea>
  `,
})
export class WorkbookPage implements OnDestroy {
  protected readonly session = inject(AppSession);
  readonly docId = input.required<string>();
  readonly close = output<void>();

  protected readonly loaded = signal(false);
  protected readonly loadError = signal<string | undefined>(undefined);
  protected readonly view = signal<WorkbookView | undefined>(undefined);
  protected readonly state = signal("connecting");
  protected readonly pending = signal(0);
  protected readonly role = signal<string | undefined>(undefined);
  protected readonly selected = signal<string | undefined>(undefined);
  protected readonly wb = signal<Workbook | undefined>(undefined);
  protected readonly readOnly = computed(() => this.role() === "read");
  protected readonly sheet = computed<SheetView | undefined>(() => {
    const v = this.view();
    return v?.sheets.find((s) => s.id === this.selected()) ?? v?.sheets[0];
  });
  protected readonly stateText = computed(() => {
    switch (this.state()) {
      case "online": return "Online";
      case "offline": return "Offline: edits are saved on this device and sync when you reconnect";
      case "closed": return "Closed";
      case "error": return "Problem";
      default: return "Connecting…";
    }
  });
  protected composing = false;
  private readonly notes = viewChild<ElementRef<HTMLTextAreaElement>>("notes");
  #doc: SyncDocument | undefined;
  #lastText = "";
  #unsubscribe: (() => void)[] = [];
  #opened = 0;

  constructor() {
    effect(() => {
      const id = this.docId();
      void this.#open(id);
    });
  }

  ngOnDestroy(): void {
    this.#release();
  }

  #release(): void {
    for (const u of this.#unsubscribe.splice(0)) u();
    const d = this.#doc;
    this.#doc = undefined;
    if (d) void d.close();
  }

  async #open(id: string): Promise<void> {
    this.#release();
    const ticket = ++this.#opened;
    this.loaded.set(false);
    this.loadError.set(undefined);
    try {
      const doc = await this.session.open(id);
      if (ticket !== this.#opened) return void doc.close();
      this.#doc = doc;
      this.wb.set(new Workbook(fromSyncDocument(doc)));
      this.#unsubscribe.push(
        doc.onChange(() => this.#refresh()),
        doc.onStatus((s) => {
          this.state.set(s.state);
          this.role.set(doc.role);
          if (s.state === "closed" && s.reason) this.loadError.set(`This workbook closed: ${s.reason}`);
        }),
        doc.onPending((n) => this.pending.set(n)),
        doc.onError((m) => this.loadError.set(m)),
      );
      this.state.set(doc.status.state);
      this.pending.set(doc.pending);
      this.role.set(doc.role);
      this.#refresh();
      this.loaded.set(true);
      // The workbook shows what is on this device at once; once the gateway has answered, an empty document says so.
      void doc.online().then(() => {
        this.role.set(doc.role);
        this.#refresh();
      }, () => undefined);
    } catch (e) {
      if (ticket === this.#opened) this.loadError.set(e instanceof Error ? e.message : String(e));
    }
  }

  #refresh(): void {
    const doc = this.#doc;
    if (!doc) return;
    const v = this.wb()?.view;
    this.view.set(v);
    if (v) this.session.recent.remember(this.docId(), v.title);
    this.#syncNotes(doc.text);
  }

  /** Brings the textarea to the shared text, keeping the caret and selection where they were relative to the words. */
  #syncNotes(text: string): void {
    const el = this.notes()?.nativeElement;
    if (!el) {
      this.#lastText = text;
      return;
    }
    if (el.value === text) return void (this.#lastText = text);
    if (this.composing) return; // never rewrite text under an input method; the next event catches up
    const change = diffText(el.value, text);
    const start = shiftCaret(el.selectionStart, change);
    const end = shiftCaret(el.selectionEnd, change);
    el.value = applyChange(el.value, change);
    el.setSelectionRange(start, end);
    this.#lastText = text;
  }

  protected onNotesInput(): void {
    const el = this.notes()?.nativeElement;
    const doc = this.#doc;
    if (!el || !doc || this.composing) return;
    const c = diffText(this.#lastText, el.value);
    this.#lastText = el.value;
    if (c.remove > 0) doc.deleteText(c.index, c.remove);
    if (c.insert !== "") doc.insertText(c.index, c.insert);
  }

  protected addSheet(): void {
    const id = this.wb()?.addSheet("");
    if (id) this.selected.set(id);
  }

  protected total(s: SheetView, ci: number): string {
    const t = columnTotal(s, ci);
    return t === undefined ? "" : String(Math.round(t * 1e6) / 1e6);
  }
}

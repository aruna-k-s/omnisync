/**
 * The workbook data model, on top of a shared JSON tree (maps and arrays). Framework-free, and written against a
 * tiny interface so it runs on an SDK document in the app and on a bare engine document in tests.
 *
 * ```
 * { title: "Q3 plan",
 *   sheets: [ { id, name, columns: [ { id, name } ], rows: [ { id, cells: { [columnId]: "text" } } ] } ] }
 * ```
 *
 * Cells are map entries keyed by column id, so two people editing different cells never conflict, and the same cell
 * resolves to the last writer. Rows, columns and sheets are array items found by id at the moment of the edit, so a
 * remote insert or delete cannot make an edit land on the wrong row.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Path = readonly (string | number)[];

/** What the model needs from a document. An SDK `SyncDocument` fits through `fromSyncDocument`; a bare engine doc fits as is. */
export interface WorkbookDoc {
  getData(): { [key: string]: Json };
  mapSet(path: Path, key: string, value: Json): unknown;
  mapDelete(path: Path, key: string): unknown;
  arrayInsert(path: Path, index: number, values: readonly Json[]): unknown;
  arrayDelete(path: Path, index: number, count: number): unknown;
}

export interface SyncLike {
  readonly data: { [key: string]: Json };
  mapSet(path: Path, key: string, value: Json): void;
  mapDelete(path: Path, key: string): void;
  arrayInsert(path: Path, index: number, values: readonly Json[]): void;
  arrayDelete(path: Path, index: number, count: number): void;
}

export const fromSyncDocument = (d: SyncLike): WorkbookDoc => ({
  getData: () => d.data,
  mapSet: (p, k, v) => d.mapSet(p, k, v),
  mapDelete: (p, k) => d.mapDelete(p, k),
  arrayInsert: (p, i, v) => d.arrayInsert(p, i, v),
  arrayDelete: (p, i, n) => d.arrayDelete(p, i, n),
});

export interface ColumnView {
  id: string;
  name: string;
}
export interface RowView {
  id: string;
  /** One entry per column, in column order; empty string where the row has no value. */
  cells: string[];
}
export interface SheetView {
  id: string;
  name: string;
  columns: ColumnView[];
  rows: RowView[];
}
export interface WorkbookView {
  title: string;
  sheets: SheetView[];
}

export const LIMITS = { name: 100, cell: 4000, sheets: 50, columns: 50, rows: 5000 } as const;

const isObj = (v: unknown): v is { [key: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Reads whatever is in the document into a view. Another client, or a hostile one, may have written anything: a
 * malformed sheet, row or cell is skipped, never thrown on. `undefined` means the document holds no workbook yet.
 */
export function readWorkbook(data: { [key: string]: Json }): WorkbookView | undefined {
  const raw = data["sheets"];
  if (!Array.isArray(raw)) return undefined;
  const sheets: SheetView[] = [];
  for (const s of raw) {
    if (!isObj(s) || typeof s["id"] !== "string" || typeof s["name"] !== "string") continue;
    const columns: ColumnView[] = [];
    for (const c of Array.isArray(s["columns"]) ? s["columns"] : []) {
      if (isObj(c) && typeof c["id"] === "string" && typeof c["name"] === "string") columns.push({ id: c["id"], name: c["name"] });
    }
    const rows: RowView[] = [];
    for (const r of Array.isArray(s["rows"]) ? s["rows"] : []) {
      if (!isObj(r) || typeof r["id"] !== "string") continue;
      const cells = isObj(r["cells"]) ? r["cells"] : {};
      rows.push({ id: r["id"], cells: columns.map((c) => (typeof cells[c.id] === "string" ? (cells[c.id] as string) : "")) });
    }
    sheets.push({ id: s["id"], name: s["name"], columns, rows });
  }
  return { title: typeof data["title"] === "string" ? data["title"] : "Untitled workbook", sheets };
}

/** Sum of a column when every non-empty cell is a finite number and there is at least one; otherwise undefined. */
export function columnTotal(sheet: SheetView, columnIndex: number): number | undefined {
  let sum = 0;
  let seen = 0;
  for (const r of sheet.rows) {
    const v = (r.cells[columnIndex] ?? "").trim();
    if (v === "") continue;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(v)) return undefined;
    sum += Number(v);
    seen++;
  }
  return seen === 0 || !Number.isFinite(sum) ? undefined : sum;
}

type IdMaker = () => string;
const defaultId: IdMaker = () => globalThis.crypto.randomUUID().slice(0, 8);

/** Edits. Each returns false, changing nothing, when its target is gone (someone else deleted it) or a limit is hit. */
export class Workbook {
  constructor(
    private readonly doc: WorkbookDoc,
    private readonly newId: IdMaker = defaultId,
  ) {}

  get view(): WorkbookView | undefined {
    return readWorkbook(this.doc.getData());
  }

  #sheets(): Json[] {
    const s = this.doc.getData()["sheets"];
    return Array.isArray(s) ? s : [];
  }

  #find(list: readonly Json[], id: string): number {
    return list.findIndex((x) => isObj(x) && x["id"] === id);
  }

  #sheet(sheetId: string): { index: number; sheet: { [key: string]: Json } } | undefined {
    const sheets = this.#sheets();
    const index = this.#find(sheets, sheetId);
    const sheet = sheets[index];
    return isObj(sheet) ? { index, sheet } : undefined;
  }

  #clean(s: string, max: number): string {
    return s.slice(0, max);
  }

  /** Creates the first sheet. Refuses when the document already holds a workbook, so two people starting at once cannot overwrite each other. */
  start(title = "Untitled workbook"): boolean {
    if (Array.isArray(this.doc.getData()["sheets"])) return false;
    this.doc.mapSet([], "title", this.#clean(title, LIMITS.name));
    this.doc.mapSet([], "sheets", [this.#newSheet("Sheet 1", ["Item", "Owner", "Amount"])]);
    return true;
  }

  #newSheet(name: string, columns: readonly string[]): Json {
    return { id: this.newId(), name: this.#clean(name, LIMITS.name), columns: columns.map((n) => ({ id: this.newId(), name: n })), rows: [] };
  }

  setTitle(title: string): boolean {
    if (!Array.isArray(this.doc.getData()["sheets"])) return false;
    this.doc.mapSet([], "title", this.#clean(title, LIMITS.name));
    return true;
  }

  addSheet(name: string): string | undefined {
    const sheets = this.#sheets();
    if (!Array.isArray(this.doc.getData()["sheets"]) || sheets.length >= LIMITS.sheets) return undefined;
    const sheet = this.#newSheet(name || `Sheet ${sheets.length + 1}`, ["Column 1"]);
    this.doc.arrayInsert(["sheets"], sheets.length, [sheet]);
    return (sheet as { id: string }).id;
  }

  renameSheet(sheetId: string, name: string): boolean {
    const s = this.#sheet(sheetId);
    if (!s) return false;
    this.doc.mapSet(["sheets", s.index], "name", this.#clean(name, LIMITS.name));
    return true;
  }

  /** The last sheet cannot be deleted: a workbook always has one. */
  deleteSheet(sheetId: string): boolean {
    const s = this.#sheet(sheetId);
    if (!s || this.#sheets().length <= 1) return false;
    this.doc.arrayDelete(["sheets"], s.index, 1);
    return true;
  }

  addColumn(sheetId: string, name: string): string | undefined {
    const s = this.#sheet(sheetId);
    const cols = s && Array.isArray(s.sheet["columns"]) ? s.sheet["columns"] : undefined;
    if (!s || !cols || cols.length >= LIMITS.columns) return undefined;
    const id = this.newId();
    this.doc.arrayInsert(["sheets", s.index, "columns"], cols.length, [{ id, name: this.#clean(name || `Column ${cols.length + 1}`, LIMITS.name) }]);
    return id;
  }

  renameColumn(sheetId: string, columnId: string, name: string): boolean {
    const s = this.#sheet(sheetId);
    const cols = s && Array.isArray(s.sheet["columns"]) ? s.sheet["columns"] : undefined;
    if (!s || !cols) return false;
    const c = this.#find(cols, columnId);
    if (c < 0) return false;
    this.doc.mapSet(["sheets", s.index, "columns", c], "name", this.#clean(name, LIMITS.name));
    return true;
  }

  addRow(sheetId: string): string | undefined {
    const s = this.#sheet(sheetId);
    const rows = s && Array.isArray(s.sheet["rows"]) ? s.sheet["rows"] : undefined;
    if (!s || !rows || rows.length >= LIMITS.rows) return undefined;
    const id = this.newId();
    this.doc.arrayInsert(["sheets", s.index, "rows"], rows.length, [{ id, cells: {} }]);
    return id;
  }

  deleteRow(sheetId: string, rowId: string): boolean {
    const s = this.#sheet(sheetId);
    const rows = s && Array.isArray(s.sheet["rows"]) ? s.sheet["rows"] : undefined;
    if (!s || !rows) return false;
    const r = this.#find(rows, rowId);
    if (r < 0) return false;
    this.doc.arrayDelete(["sheets", s.index, "rows"], r, 1);
    return true;
  }

  /** An empty value clears the cell. */
  setCell(sheetId: string, rowId: string, columnId: string, value: string): boolean {
    const s = this.#sheet(sheetId);
    const rows = s && Array.isArray(s.sheet["rows"]) ? s.sheet["rows"] : undefined;
    const cols = s && Array.isArray(s.sheet["columns"]) ? s.sheet["columns"] : undefined;
    if (!s || !rows || !cols || this.#find(cols, columnId) < 0) return false;
    const r = this.#find(rows, rowId);
    const row = rows[r];
    if (!isObj(row)) return false;
    const path = ["sheets", s.index, "rows", r, "cells"] as const;
    if (!isObj(row["cells"])) {
      this.doc.mapSet(["sheets", s.index, "rows", r], "cells", {});
    }
    if (value === "") {
      if (isObj(row["cells"]) && columnId in row["cells"]) this.doc.mapDelete(path, columnId);
      return true;
    }
    this.doc.mapSet(path, columnId, this.#clean(value, LIMITS.cell));
    return true;
  }
}

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { yjsEngine } from "@omnisync/engine/yjs";
import { LIMITS, Workbook, columnTotal, readWorkbook, type SheetView } from "../src/app/workbook.js";

const counter = () => {
  let n = 0;
  return () => `id${++n}`;
};
const replica = (actor: number, prefix = "") => {
  const d = yjsEngine.create(actor);
  let n = 0;
  return { d, wb: new Workbook(d, () => `${prefix}${++n}`) };
};
const sync = (a: ReturnType<typeof replica>, b: ReturnType<typeof replica>) => {
  a.d.applyUpdate(b.d.encodeDiff(a.d.encodeStateVector()));
  b.d.applyUpdate(a.d.encodeDiff(b.d.encodeStateVector()));
};

describe("workbook model", () => {
  it("starts once, with one sheet and default columns, and refuses a second start", () => {
    const d = yjsEngine.create(1);
    const wb = new Workbook(d, counter());
    expect(wb.view).toBeUndefined();
    expect(wb.start("Q3 plan")).toBe(true);
    expect(wb.view).toEqual({ title: "Q3 plan", sheets: [{ id: "id1", name: "Sheet 1", columns: [{ id: "id2", name: "Item" }, { id: "id3", name: "Owner" }, { id: "id4", name: "Amount" }], rows: [] }] });
    expect(wb.start("Other")).toBe(false);
    expect(wb.view?.title).toBe("Q3 plan");
  });

  it("edits cells, rows, columns, sheets and titles by id", () => {
    const d = yjsEngine.create(1);
    const wb = new Workbook(d, counter());
    wb.start("T");
    const sheet = (wb.view as { sheets: SheetView[] }).sheets[0] as SheetView;
    const [item, owner, amount] = sheet.columns.map((c) => c.id) as [string, string, string];
    const r1 = wb.addRow(sheet.id) as string;
    const r2 = wb.addRow(sheet.id) as string;
    expect(wb.setCell(sheet.id, r1, item, "Licences")).toBe(true);
    expect(wb.setCell(sheet.id, r1, amount, "1200.50")).toBe(true);
    expect(wb.setCell(sheet.id, r2, item, "Hosting")).toBe(true);
    expect(wb.setCell(sheet.id, r2, amount, "300")).toBe(true);
    expect(wb.setCell(sheet.id, r2, owner, "Dana")).toBe(true);
    let s = (wb.view as { sheets: SheetView[] }).sheets[0] as SheetView;
    expect(s.rows.map((r) => r.cells)).toEqual([["Licences", "", "1200.50"], ["Hosting", "Dana", "300"]]);
    expect(columnTotal(s, 2)).toBeCloseTo(1500.5);
    expect(columnTotal(s, 0)).toBeUndefined(); // text
    expect(columnTotal(s, 1)).toBeUndefined(); // text in one cell

    wb.setCell(sheet.id, r2, owner, ""); // clears
    wb.renameColumn(sheet.id, owner, "Lead");
    const col = wb.addColumn(sheet.id, "Notes") as string;
    wb.setCell(sheet.id, r1, col, "renew in May");
    wb.deleteRow(sheet.id, r2);
    wb.renameSheet(sheet.id, "Budget");
    const second = wb.addSheet("Plan") as string;
    wb.setTitle("Q3 budget");
    const v = wb.view as { title: string; sheets: SheetView[] };
    s = v.sheets[0] as SheetView;
    expect(v.title).toBe("Q3 budget");
    expect(v.sheets.map((x) => x.name)).toEqual(["Budget", "Plan"]);
    expect(s.columns.map((c) => c.name)).toEqual(["Item", "Lead", "Amount", "Notes"]);
    expect(s.rows).toEqual([{ id: r1, cells: ["Licences", "", "1200.50", "renew in May"] }]);
    expect(wb.deleteSheet(second)).toBe(true);
    expect(wb.deleteSheet(sheet.id)).toBe(false); // the last sheet stays
    expect(wb.view?.sheets).toHaveLength(1);
  });

  it("returns false and changes nothing when the target is gone, the document has no workbook, or a limit is hit", () => {
    const empty = new Workbook(yjsEngine.create(1), counter());
    expect(empty.setTitle("x")).toBe(false);
    expect(empty.addSheet("x")).toBeUndefined();
    expect(empty.setCell("s", "r", "c", "v")).toBe(false);

    const d = yjsEngine.create(1);
    const wb = new Workbook(d, counter());
    wb.start();
    const s = (wb.view as { sheets: SheetView[] }).sheets[0] as SheetView;
    const before = JSON.stringify(d.getData());
    expect(wb.setCell("nope", "r", "c", "v")).toBe(false);
    expect(wb.setCell(s.id, "nope", s.columns[0]?.id ?? "", "v")).toBe(false);
    const row = wb.addRow(s.id) as string;
    expect(wb.setCell(s.id, row, "nope", "v")).toBe(false);
    expect(wb.renameSheet("nope", "x")).toBe(false);
    expect(wb.renameColumn(s.id, "nope", "x")).toBe(false);
    expect(wb.renameColumn("nope", "nope", "x")).toBe(false);
    expect(wb.deleteRow(s.id, "nope")).toBe(false);
    expect(wb.deleteRow("nope", "nope")).toBe(false);
    expect(wb.addRow("nope")).toBeUndefined();
    expect(wb.addColumn("nope", "x")).toBeUndefined();
    expect(wb.deleteSheet("nope")).toBe(false);
    wb.deleteRow(s.id, row);
    expect(JSON.stringify(d.getData())).toBe(before);

    // Limits.
    for (let i = 0; i < LIMITS.columns; i++) wb.addColumn(s.id, `c${i}`);
    expect(wb.addColumn(s.id, "one too many")).toBeUndefined();
    expect((wb.view as { sheets: SheetView[] }).sheets[0]?.columns).toHaveLength(LIMITS.columns);
    wb.setTitle("t".repeat(LIMITS.name + 50));
    expect(wb.view?.title).toHaveLength(LIMITS.name);
    const r = wb.addRow(s.id) as string;
    const c0 = (wb.view as { sheets: SheetView[] }).sheets[0]?.columns[0]?.id as string;
    wb.setCell(s.id, r, c0, "x".repeat(LIMITS.cell + 10));
    expect((wb.view as { sheets: SheetView[] }).sheets[0]?.rows[0]?.cells[0]).toHaveLength(LIMITS.cell);
  });

  it("limits sheets and rows", () => {
    const wb = new Workbook(yjsEngine.create(1), counter());
    wb.start();
    for (let i = 1; i < LIMITS.sheets; i++) expect(wb.addSheet(`s${i}`)).toBeDefined();
    expect(wb.addSheet("too many")).toBeUndefined();
    const id = (wb.view as { sheets: SheetView[] }).sheets[0]?.id as string;
    for (let i = 0; i < LIMITS.rows; i++) wb.addRow(id);
    expect(wb.addRow(id)).toBeUndefined();
  }, 60_000);

  it("reads hostile or half-written data without throwing, skipping what it cannot use", () => {
    const hostile = {
      title: 42,
      sheets: [
        null,
        "x",
        { id: 1, name: "bad id" },
        { id: "named wrongly", name: 5 },
        { id: "a", name: "ok", columns: [{ id: "c1", name: "A" }, { id: 5 }, null, { id: "c2", name: "B" }], rows: [{ id: "r1", cells: { c1: "x", c2: 7, zzz: "orphan" } }, { cells: {} }, { id: "r2", cells: [] }, { id: "r3" }, "row"] },
        { id: "b", name: "no arrays", columns: "nope", rows: 3 },
      ],
    };
    expect(readWorkbook(hostile as never)).toEqual({
      title: "Untitled workbook",
      sheets: [
        { id: "a", name: "ok", columns: [{ id: "c1", name: "A" }, { id: "c2", name: "B" }], rows: [{ id: "r1", cells: ["x", ""] }, { id: "r2", cells: ["", ""] }, { id: "r3", cells: ["", ""] }] },
        { id: "b", name: "no arrays", columns: [], rows: [] },
      ],
    });
    expect(readWorkbook({})).toBeUndefined();
    expect(readWorkbook({ sheets: "x" } as never)).toBeUndefined();
    expect(readWorkbook({ sheets: [] })).toEqual({ title: "Untitled workbook", sheets: [] });
  });

  it("names new sheets and columns when no name is given, clamps renames, and clears an emptied cell", () => {
    const d = yjsEngine.create(1);
    const wb = new Workbook(d, counter());
    wb.start("T");
    const first = (wb.view as { sheets: SheetView[] }).sheets[0] as SheetView;
    const second = wb.addSheet("") as string;
    const col = wb.addColumn(second, "") as string;
    const view = wb.view as { sheets: SheetView[] };
    expect(view.sheets[1]?.name).toBe("Sheet 2");
    expect(view.sheets[1]?.columns.map((c) => c.name)).toEqual(["Column 1", "Column 2"]);
    expect(wb.renameSheet(second, "s".repeat(500))).toBe(true);
    expect((wb.view as { sheets: SheetView[] }).sheets[1]?.name).toHaveLength(LIMITS.name);
    // an emptied cell leaves no entry behind, not an empty string
    const row = wb.addRow(first.id) as string;
    const c0 = first.columns[0]?.id as string;
    wb.setCell(first.id, row, c0, "x");
    wb.setCell(first.id, row, c0, "");
    const rows = ((d.getData()["sheets"] as { rows: { cells: object }[] }[])[0] as { rows: { cells: object }[] }).rows;
    expect(Object.keys(rows[0]?.cells ?? { none: 1 })).toEqual([]);
    expect(col).toBeTruthy();
  });

  it("can fill a cell in a row another client wrote without a cells map", () => {
    const d = yjsEngine.create(1);
    const wb = new Workbook(d, counter());
    wb.start("T");
    const sheet = (wb.view as { sheets: SheetView[] }).sheets[0] as SheetView;
    d.arrayInsert(["sheets", 0, "rows"], 0, [{ id: "bare" }]);
    const c0 = sheet.columns[0]?.id as string;
    expect(wb.setCell(sheet.id, "bare", c0, "filled")).toBe(true);
    expect((wb.view as { sheets: SheetView[] }).sheets[0]?.rows[0]?.cells[0]).toBe("filled");
  });

  it("totals only columns of numbers", () => {
    const sheet = (cells: string[]): SheetView => ({ id: "s", name: "s", columns: [{ id: "c", name: "c" }], rows: cells.map((c, i) => ({ id: `r${i}`, cells: [c] })) });
    expect(columnTotal(sheet(["1", "2", "3.5"]), 0)).toBe(6.5);
    expect(columnTotal(sheet([" 4 ", "", "-1", "+2", ".5", "3."]), 0)).toBe(8.5);
    expect(columnTotal(sheet([]), 0)).toBeUndefined();
    expect(columnTotal(sheet(["", " "]), 0)).toBeUndefined();
    for (const bad of ["1,5", "1e3", "0x10", "abc", "1 2", "Infinity", "NaN", "--1", "$5"]) expect(columnTotal(sheet(["1", bad]), 0), bad).toBeUndefined();
    expect(columnTotal(sheet(["1e308", "1e308"].map((x) => x.replace("e308", "0".repeat(308)))), 0)).toBeUndefined(); // overflows to Infinity
    expect(columnTotal(sheet(["1"]), 5)).toBeUndefined(); // no such column
  });

  it("merges concurrent edits by two people: different cells both survive, the same cell has one winner, and a row deleted elsewhere is not resurrected", () => {
    const a = replica(1, "a");
    const b = replica(2, "b");
    a.wb.start("Shared");
    sync(a, b);
    const s = (a.wb.view as { sheets: SheetView[] }).sheets[0] as SheetView;
    const [c0, c1] = s.columns.map((c) => c.id) as [string, string];
    const row = a.wb.addRow(s.id) as string;
    sync(a, b);

    a.wb.setCell(s.id, row, c0, "from A");
    b.wb.setCell(s.id, row, c1, "from B");
    const rowB = b.wb.addRow(s.id) as string; // both add rows at once
    const rowA = a.wb.addRow(s.id) as string;
    sync(a, b);
    for (const r of [a, b]) {
      const v = (r.wb.view as { sheets: SheetView[] }).sheets[0] as SheetView;
      expect(v.rows.map((x) => x.id).sort()).toEqual([row, rowA, rowB].sort());
      expect(v.rows.find((x) => x.id === row)?.cells.slice(0, 2)).toEqual(["from A", "from B"]);
    }
    expect(a.d.getData()).toEqual(b.d.getData());

    a.wb.setCell(s.id, row, c0, "A wins?");
    b.wb.setCell(s.id, row, c0, "B wins?");
    sync(a, b);
    const winner = (a.wb.view as { sheets: SheetView[] }).sheets[0]?.rows.find((x) => x.id === row)?.cells[0];
    expect(["A wins?", "B wins?"]).toContain(winner);
    expect((b.wb.view as { sheets: SheetView[] }).sheets[0]?.rows.find((x) => x.id === row)?.cells[0]).toBe(winner);

    // B deletes a row while A edits a cell in it: after the merge the row is gone and A's later edits to it are refused.
    b.wb.deleteRow(s.id, rowB);
    sync(a, b);
    expect(a.wb.setCell(s.id, rowB, c0, "ghost")).toBe(false);
    expect((a.wb.view as { sheets: SheetView[] }).sheets[0]?.rows.map((x) => x.id)).not.toContain(rowB);
  });

  it("two people starting the same empty document at once end with one workbook and no lost sheets after the first sync", () => {
    // The app only offers "start" when the synced document is empty, but two people can still do it together.
    const a = replica(1, "a");
    const b = replica(2, "b");
    a.wb.start("A's");
    b.wb.start("B's");
    sync(a, b);
    expect(a.d.getData()).toEqual(b.d.getData());
    const v = a.wb.view as { title: string; sheets: SheetView[] };
    expect(["A's", "B's"]).toContain(v.title);
    expect(v.sheets).toHaveLength(1); // one of the two initial arrays won whole; the other is discarded, not interleaved
  });

  it("property: any interleaving of edits on two replicas converges to the same workbook", () => {
    type Op = { who: 0 | 1; kind: "row" | "cell" | "delrow" | "col" | "sheet" | "rename" | "sync"; pick: number; text: string };
    const op = fc.record({
      who: fc.constantFrom<0 | 1>(0, 1),
      kind: fc.constantFrom<Op["kind"]>("row", "cell", "delrow", "col", "sheet", "rename", "sync"),
      pick: fc.nat(20),
      text: fc.string({ maxLength: 8 }),
    });
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 60 }), (ops) => {
        const r = [replica(1, "a"), replica(2, "b")] as const;
        r[0].wb.start("P");
        sync(r[0], r[1]);
        for (const o of ops) {
          const me = r[o.who];
          const v = me.wb.view;
          const sheet = v?.sheets[o.pick % Math.max(1, v.sheets.length)];
          if (o.kind === "sync") sync(r[0], r[1]);
          else if (!sheet) continue;
          else if (o.kind === "row") me.wb.addRow(sheet.id);
          else if (o.kind === "col") me.wb.addColumn(sheet.id, o.text);
          else if (o.kind === "sheet") me.wb.addSheet(o.text);
          else if (o.kind === "rename") me.wb.renameSheet(sheet.id, o.text);
          else if (o.kind === "delrow") {
            const row = sheet.rows[o.pick % Math.max(1, sheet.rows.length)];
            if (row) me.wb.deleteRow(sheet.id, row.id);
          } else {
            const row = sheet.rows[o.pick % Math.max(1, sheet.rows.length)];
            const col = sheet.columns[o.pick % Math.max(1, sheet.columns.length)];
            if (row && col) me.wb.setCell(sheet.id, row.id, col.id, o.text);
          }
        }
        sync(r[0], r[1]);
        const [x, y] = [JSON.stringify(r[0].wb.view), JSON.stringify(r[1].wb.view)];
        expect(x).toBe(y);
        // Every row id and sheet id is unique after the merge.
        const view = r[0].wb.view as { sheets: SheetView[] };
        expect(new Set(view.sheets.map((s) => s.id)).size).toBe(view.sheets.length);
        for (const s of view.sheets) expect(new Set(s.rows.map((q) => q.id)).size).toBe(s.rows.length);
      }),
      { numRuns: 150 },
    );
  }, 60_000);
});

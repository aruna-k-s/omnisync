/** The workbooks this browser has opened. Non-admins cannot list documents, so the app remembers the ones it knows. */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RecentItem {
  id: string;
  title: string;
}

const KEY = "omnisync-reference-recent";
const MAX = 20;
export const DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class Recent {
  constructor(private readonly storage: StorageLike | undefined) {}

  list(): RecentItem[] {
    try {
      const raw: unknown = JSON.parse(this.storage?.getItem(KEY) ?? "[]");
      if (!Array.isArray(raw)) return [];
      const out: RecentItem[] = [];
      for (const x of raw) {
        const o = x as { id?: unknown; title?: unknown };
        if (typeof o?.id === "string" && DOC_ID.test(o.id) && typeof o.title === "string") out.push({ id: o.id, title: o.title.slice(0, 100) });
      }
      return out.slice(0, MAX);
    } catch {
      return [];
    }
  }

  /** Puts the workbook first, replacing an older entry for the same id. */
  remember(id: string, title: string): void {
    if (!DOC_ID.test(id)) return;
    const next = [{ id, title: title.slice(0, 100) }, ...this.list().filter((x) => x.id !== id)].slice(0, MAX);
    try {
      this.storage?.setItem(KEY, JSON.stringify(next));
    } catch {
      // storage full or blocked: the list is a convenience
    }
  }

  forget(id: string): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.list().filter((x) => x.id !== id)));
    } catch {
      // see above
    }
  }
}

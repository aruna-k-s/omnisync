import { createContext, createElement, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Json, Path } from "@omnisync/engine";
import type { ChangeSource, OmniSyncClient, Status, SyncDocument } from "@omnisync/sdk";

const ClientContext = createContext<OmniSyncClient | undefined>(undefined);

/** Holds the client for the hooks below. The only component this package ships. */
export function OmniSyncProvider(props: { client: OmniSyncClient; children?: ReactNode }): ReactNode {
  return createElement(ClientContext.Provider, { value: props.client }, props.children);
}

export function useOmniSyncClient(): OmniSyncClient {
  const c = useContext(ClientContext);
  if (!c) throw new Error("wrap the tree in <OmniSyncProvider client={...}>");
  return c;
}

/** What a component renders from. A new object whenever anything in it changes, the same object otherwise. */
export interface DocumentView {
  readonly text: string;
  readonly data: { [key: string]: Json };
  readonly status: Status;
  /** Edits made here that the gateway has not yet confirmed. */
  readonly pending: number;
}

const EMPTY_STATUS: Status = { state: "idle", mode: "full" };
const LOADING: DocumentView = { text: "", data: {}, status: EMPTY_STATUS, pending: 0 };

class Store {
  #view: DocumentView;
  readonly #fns = new Set<() => void>();
  readonly #off: (() => void)[];

  constructor(readonly doc: SyncDocument) {
    this.#view = this.#read();
    const refresh = (): void => {
      this.#view = this.#read();
      for (const fn of this.#fns) fn();
    };
    this.#off = [doc.onChange((_s: ChangeSource) => refresh()), doc.onStatus(refresh), doc.onPending(refresh)];
  }

  #read(): DocumentView {
    return { text: this.doc.text, data: this.doc.data, status: this.doc.status, pending: this.doc.pending };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  };
  snapshot = (): DocumentView => this.#view;
  dispose(): void {
    for (const off of this.#off) off();
    this.#fns.clear();
  }
}

/** Documents are shared between components and closed shortly after the last one lets go (so a remount does not reconnect). */
interface Entry {
  count: number;
  open: Promise<SyncDocument>;
  closeTimer: ReturnType<typeof setTimeout> | undefined;
}
const registry = new WeakMap<OmniSyncClient, Map<string, Entry>>();
const CLOSE_DELAY_MS = 1000;

function acquire(client: OmniSyncClient, docId: string): Entry {
  let docs = registry.get(client);
  if (!docs) registry.set(client, (docs = new Map()));
  let e = docs.get(docId);
  if (!e) {
    e = { count: 0, open: client.open(docId), closeTimer: undefined };
    docs.set(docId, e);
  }
  clearTimeout(e.closeTimer);
  e.count++;
  return e;
}

function release(client: OmniSyncClient, docId: string, entry: Entry): void {
  entry.count--;
  if (entry.count > 0) return;
  entry.closeTimer = setTimeout(() => {
    const docs = registry.get(client);
    if (entry.count > 0 || docs?.get(docId) !== entry) return;
    docs.delete(docId);
    void entry.open.then((d) => d.close()).catch(() => {});
  }, CLOSE_DELAY_MS);
}

export interface UseDocument extends DocumentView {
  /** The open document, for edits (`doc.insertText(...)`). Undefined until it has opened. */
  readonly doc: SyncDocument | undefined;
  /** Set if the document could not be opened. */
  readonly error: Error | undefined;
}

export function useDocument(docId: string): UseDocument;
export function useDocument(client: OmniSyncClient, docId: string): UseDocument;
export function useDocument(a: string | OmniSyncClient, b?: string): UseDocument {
  const fromContext = useContext(ClientContext);
  const client = typeof a === "string" ? fromContext : a;
  const docId = typeof a === "string" ? a : (b as string);
  if (!client) throw new Error("wrap the tree in <OmniSyncProvider client={...}> or pass the client");

  const [store, setStore] = useState<Store | undefined>();
  const [error, setError] = useState<Error | undefined>();
  useEffect(() => {
    let live = true;
    const entry = acquire(client, docId);
    let made: Store | undefined;
    entry.open.then(
      (doc) => {
        if (!live) return;
        made = new Store(doc);
        setStore(made);
        setError(undefined);
      },
      (e: unknown) => live && setError(e instanceof Error ? e : new Error(String(e))),
    );
    return () => {
      live = false;
      made?.dispose();
      setStore(undefined);
      release(client, docId, entry);
    };
  }, [client, docId]);

  const view = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.snapshot ?? loading, loading);
  return { ...view, doc: store?.doc, error };
}

const noSubscribe = (): (() => void) => () => {};
const loading = (): DocumentView => LOADING;

/** Connection state only, for a banner. */
export function useStatus(client: OmniSyncClient, docId: string): Status;
export function useStatus(docId: string): Status;
export function useStatus(a: string | OmniSyncClient, b?: string): Status {
  return useDocument(a as OmniSyncClient, b as string).status;
}

/** How many of this user's edits the gateway has not yet confirmed. */
export function usePending(client: OmniSyncClient, docId: string): number;
export function usePending(docId: string): number;
export function usePending(a: string | OmniSyncClient, b?: string): number {
  return useDocument(a as OmniSyncClient, b as string).pending;
}

export type { Json, Path, Status, SyncDocument };

# Spec: reference app, a shared workbook (Phase 1, week 8c)

**Purpose.** A small but real application on the SDK that a design partner can open, edit with a colleague, take offline, and then audit. It shows what the product does without a slide: sign in with the company's IdP, edit tables and text together, keep working with the network cut, and see every edit end up in a ledger the verifier accepts. It is also the template for an integration: the SDK calls are in two files (`auth.service.ts`, `workbook-view.ts`).

**Stack.** Angular 21 (see `console.md` for why not 22), standalone components, signals, no router, no UI kit. The workbook model and the text-diff are plain TypeScript with Vitest and fast-check tests; the framework layer only renders and forwards events.

## What the user sees

| Part | Behaviour |
| --- | --- |
| Sign in | One button: OIDC login at the control plane with `return_to` = this page. The session token comes back in the URL fragment, is read once, removed from the address bar and kept in memory only |
| Device | On first sign-in the app creates a **non-extractable** WebCrypto device key (stored in IndexedDB), proves possession to the control plane and receives a certificate. The certificate is cached in `localStorage` per principal (it is not secret) and renewed in the last 15 minutes of its life. A reload therefore re-signs in but keeps the same device identity and its unsent edits |
| Home | "New workbook" and a list of recently opened workbooks (ids only, per principal, in `localStorage`). Opening a document the person has no grant for shows the gateway's refusal. Sharing is a grant by an organisation admin in the console (`console.md`); a non-admin cannot list documents, so the app asks for the id |
| Workbook | Sheets (tabs), a grid of text cells with add/remove row, add/remove column, rename column and sheet, a **sum** under each column whose cells are all numbers, a title, and a shared **notes** pane |
| Status bar | `online / syncing / offline`, the number of edits waiting to be sent, and "read only" for a reader |
| Offline | Edits are written to the IndexedDB outbox before they are shown as sent. A reload while offline keeps them; they are sent, in order, when the gateway is reachable and the certificate still valid |

## Data model

One JSON tree on the SDK's maps and arrays:

```
{ title, notes?, sheets: [ { id, name, columns: [ {id, name} ], rows: [ {id, cells: { [columnId]: string }} ] } ] }
```

- Cells are map entries keyed by **column id**, not by position, so two people inserting a column or row concurrently never shift each other's values.
- Sheets, columns and rows are found by **id at edit time**, never by an index held across an await. An edit to a row another person deleted is dropped.
- The notes pane is one shared text edited through `diffText` (smallest single replacement between the old and new value, surrogate-pair safe) and `shiftCaret` (moves the local caret when a remote edit lands before it).
- Limits: names 100 characters, cell 4000, 50 sheets, 50 columns, 5000 rows per sheet. Longer names and cell text are truncated locally; adding a sheet, column or row past its limit is refused (the edit returns false and nothing changes). Remote data above a limit or of the wrong shape is **skipped, never thrown on**: the read model returns what it can understand and ignores the rest.
- A column's sum is shown when every non-empty cell is a plain decimal number (`-12.5`, `.5`, `+3`; `1,200.50` and `1e3` are not numbers) and there is at least one; empty cells are ignored, any other cell hides the sum. It is ordinary floating point, a convenience and not accounting. Totals are computed locally and are not part of the document.

## Invariants (tests)

1. **Convergence** (fast-check): any interleaving of edits from two replicas, applied in any order, gives the same workbook (`toEqual`, not key order).
2. **Hostile shape**: arbitrary JSON in place of the workbook never throws and yields a valid (possibly empty) model.
3. **Text diff**: `applyChange(old, diffText(old, new)) === new` for all strings including surrogate pairs; the change never splits a pair; `shiftCaret` keeps a caret after the change at the same character.
4. **Config**: `config.json` is parsed strictly (origins only, ws/wss for the gateway).
5. **Browser, two real Chromium contexts, real control plane and gateway** (`test/e2e.test.ts`):
   - sign-in lands on the home page with the token out of the URL; the device key is non-extractable and survives a reload;
   - Alice creates a workbook, an admin grants Bob access through the admin API, Bob opens it and edits live while Alice sees the change; totals update;
   - concurrent typing in the notes pane converges and a remote edit before the caret does not move the caret relative to the text;
   - **offline**: the network is cut with a TCP relay, edits continue, the page is reloaded while offline, the network returns, and both replicas converge with nothing lost;
   - a reader sees the workbook read-only and cannot edit;
   - **the ledger verifies**: after the above, the export contains entries signed by both devices and the verifier accepts it (consistent; not anchored).
   - No uncaught page error in any test.

## Known limits (deliberate)

- Edits made within one batching window (at most 250 ms) before an instant page unload can be lost: the outbox is written when the batch is flushed. The status bar's pending count shows when there is nothing waiting.
- No cell formulas, formatting, cursors of other people, comments or history view. The ledger is the history.
- Sharing relies on an organisation admin; a per-document share dialog needs a control-plane route for document admins to list principals, which is a protected-path change left for later.
- The device certificate lives in `localStorage` per principal; clearing site data forgets it and the next sign-in enrols a new device (the old certificate expires on its own, and the console can revoke it).

## Demo

`pnpm --filter @omnisync/reference-app demo` starts, in one process and in memory: a fake IdP, the control plane, the gateway, and both built apps (reference app on :4300, console on :4301). `http://127.0.0.1:4300/demo/as?u=alice|bob|carol|admin` chooses who the next sign-in is. Nothing is persisted; this is for demonstrations, never a deployment. The demo needs `pnpm build` of both apps first.

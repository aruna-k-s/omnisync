# Spec: the TypeScript SDK (Phase 1, week 7b to 7d)

Status: written before code. Decisions D6 (browser key storage) and D7 (structured data) accepted as recommended.
Protected paths touched, all additive and with no wire or certificate format change: `packages/protocol/src/signing.ts` (an async signing variant of `signUpdate`), `packages/crypto/src/auth.ts` (async variants of the AUTH response and the enrollment proof). Frozen vectors must still pass unchanged.

## Purpose

A browser or Node program can open a document, edit it offline or online, and have every edit signed with a key the page cannot export, queued durably until the gateway acknowledges it, and replayed in order after any disconnect. The SDK is framework-free (`@omnisync/sdk`); React hooks live in `@omnisync/sdk-react`.

It re-implements the connection logic of the Node test client (`apps/gateway/src/client.ts`) for a browser: no `ws` import, no `node:crypto`, signing is asynchronous, and the outbox survives a page reload.

## Parts

### 1. Device key (D6)

```ts
interface DeviceKey {
  readonly keyId: Uint8Array;       // 8 bytes, as everywhere
  readonly publicKey: Uint8Array;   // 32 bytes
  readonly extractable: boolean;    // false when the secret never enters JavaScript memory
  sign(message: Uint8Array): Promise<Uint8Array>;
}
```

- `createDeviceKey({ vault, webCrypto? })` returns the stored key if the vault has one, else generates one. It prefers a WebCrypto Ed25519 key created with `extractable: false`; the private half then cannot be read by any script on the page, only used to sign. Where the browser lacks Ed25519 in WebCrypto it falls back to a noble key held in memory (`extractable: true`) and says so in `DeviceKey.extractable`. Callers can refuse the fallback (`requireNonExtractable: true`).
- The `KeyVault` interface (`load()`, `store(record)`, `clear()`) hides where the key lives. `IndexedDbKeyVault` stores the `CryptoKey` object itself (structured clone), never raw bytes. `MemoryKeyVault` is for tests and the fallback. A fallback noble key is never written to disk by the SDK: it lives for the page's lifetime, and the next page load enrolls a new certificate.
- Ed25519 is deterministic, so a WebCrypto signature and a noble signature over the same bytes are identical and verify the same way at the gateway (tested against the frozen vectors).
- The certificate format needs an algorithm field before Phase 2 (the P-256 fallback in the key hierarchy). That is a certificate change and is not part of week 7: today a browser without WebCrypto Ed25519 uses the noble fallback, which stays inside the current format.

### 2. Enrollment

`enroll({ controlPlaneUrl, sessionToken, principalId, deviceKey, fetch? })` posts the public key and an enrollment proof (a signature over the principal id and public key, made with the device key) to `POST /v1/certificates` and returns the signed certificate bytes and its window. The SDK does not drive the OIDC redirect (an app concern: `GET /v1/auth/login` then the callback returns a session token); `loginUrl(controlPlaneUrl)` returns the URL to send the browser to. The certificate is kept in the page's storage next to the vault; it expires in 12 hours by default and the SDK refuses to connect with an expired one (`onCertificateExpiring` fires 10 minutes before).

CLI and native-app login handoff are not in this week: they need a control-plane flow (device code or loopback redirect) that touches the protected session code, and wait for week 8 with the console.

### 3. Outbox

Every local edit becomes one signed UPDATE frame, stored in the outbox before it is sent and deleted only when the gateway ACKs that exact frame. `Outbox`:

```ts
interface Outbox {
  /** Stores frames in one atomic write. Throws if any (sessionId, seq) is already present with different bytes. */
  append(frames: readonly OutboxFrame[]): Promise<void>;
  /** Everything not yet acknowledged, ordered by seq. */
  pending(): Promise<OutboxFrame[]>;
  /** Removes an acknowledged frame. Unknown seq is a no-op. */
  ack(sessionId: number, seq: number): Promise<void>;
  /** The highest seq ever stored for this session (acknowledged or not), so numbering never restarts. */
  highestSeq(sessionId: number): Promise<number>;
  close(): Promise<void>;
}
```

`MemoryOutbox` and `IndexedDbOutbox` pass one shared contract test. A frame is `{ sessionId, seq, bytes, claimedAtMs }`.

Session numbering: a session id is chosen once per page load, unique per device key and never reused (random 32-bit with the stored highest used per key, so a reload cannot repeat a `(session, seq)` pair that the gateway has already seen, which would be rejected as a replay).

Idempotency: the gateway already answers a repeated `(key, session, clientSeq)` that it stored with "duplicate" and ACKs it, and rejects one that is older than the newest stored for that session as a replay. The SDK treats an ACK or a duplicate answer as success, and a replay rejection of a frame it still holds as success too, because the frame can only be refused as a replay if a newer one from the same session was stored, which means this one was.

### 4. Batching

Local edits apply to the in-memory document at once (the UI never waits). Signing, the outbox write and the send happen once per window: the first edit starts a timer of `batchMinMs` (default 50), further edits within the window join the same flush, and a flush never waits longer than `batchMaxMs` (default 250) from the first unflushed edit. One flush is one outbox transaction and one burst of frames, in edit order. `claimedAtMs` is the time of the edit, captured when it is made, not when it is signed. `flush()` forces it; the SDK flushes on `pagehide` and `visibilitychange` to hidden.

Known limit: an edit made less than one window before a crash or a killed tab is lost, because it has not reached the outbox yet. Merging several edits into one frame is a later optimisation (it needs an engine-level update merge).

### 5. Connection

States: `idle`, `connecting`, `authenticating`, `syncing`, `online`, `offline`, `closed`. On open the SDK answers the gateway's AUTH challenge with the certificate and a possession proof (async signing), runs SYNC_1 and SYNC_2 as the Node client does, then replays the outbox in order. Edits made while offline are signed, queued and resolved when acknowledged.

Reconnect: exponential backoff with full jitter (`baseMs` 250, `maxMs` 30,000), reset after a connection stays up for 10 seconds. A `busy;retry_after_ms=N` error from admission control is honoured as a minimum wait. Close codes that mean "do not retry" (certificate revoked, expired beyond grace, no access) stop the loop and surface `status: "closed"` with a reason. A lapsed certificate within the 72-hour grace connects upload-only: the outbox drains, nothing new is read, and the status says `upload-only`.

The SDK never applies an update it cannot account for: remote updates are applied to the engine and relayed to listeners only after the gateway sent them over the authenticated connection.

### 6. Document API

```ts
const doc = await client.open("doc-id");    // engine "yjs" by default
doc.text; doc.insertText(0, "hi"); doc.deleteText(0, 2);
doc.data; doc.mapSet([], "title", "Q3"); doc.arrayInsert(["rows"], 0, [{...}]);
doc.onChange(fn); doc.status; doc.pending; await doc.synced(); doc.close();
```

Edits return when applied locally (synchronous for the UI); `doc.synced()` resolves when the outbox is empty and the gateway has ACKed everything made so far. Validation errors from the engine (bad path, non-JSON value) throw from the edit call and sign nothing.

### 7. React (`@omnisync/sdk-react`)

`useDocument(client, docId)` returns `{ doc, text, data, status, pending }` and re-renders on change; `useStatus`, `usePending` for banners. Hooks only: no components, no providers beyond a `OmniSyncProvider` that holds the client. Peer dependency on React 18 or 19.

## Invariants

1. A frame is in the outbox before it is on the wire; it leaves the outbox only on its own ACK (or duplicate).
2. `(sessionId, seq)` pairs are never reused across page loads for one key.
3. Order: frames reach the gateway in the order they were made, per session, including after any number of reconnects.
4. A failed or refused edit signs nothing, queues nothing and leaves the document unchanged.
5. The device key's secret is never serialised, logged or sent. A non-extractable key cannot be exported through any SDK call.
6. Nothing in the SDK trusts a frame from the network before the gateway's authenticated session says so; the SDK does not verify peers' signatures itself in this release (the gateway has, and the ledger records it).
7. Two replicas that exchange all frames converge, whatever the connection did (property test over random disconnects).

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Gateway unreachable | Status `offline`, backoff, edits keep applying locally and queue |
| Certificate expired and grace over | Status `closed (certificate expired)`; outbox kept for a new certificate from the same key |
| Certificate revoked | Status `closed (revoked)`; outbox kept but never sent with that certificate |
| Gateway restarts mid-batch | Unacked frames replay; stored ones answer duplicate and are cleared |
| Outbox storage full or blocked | `status: "error"`, edit call rejects, document unchanged (the edit is rolled back from the engine only if the engine supports it; otherwise the SDK marks the document `dirty` and refuses further edits until reload) |
| IndexedDB unavailable (private window) | `MemoryOutbox` with a visible warning: edits survive a reconnect but not a reload |
| WebCrypto Ed25519 missing | Noble fallback, `extractable: true`, reported |
| Page reload with pending edits | Frames reload from the outbox and replay; the in-memory document is rebuilt by SYNC_2 from the gateway plus a local replay of pending frames' updates |

## Tests (written first)

- Device key: WebCrypto and noble signatures over the frozen vectors verify identically; a non-extractable key rejects export; vault round trip; fallback path.
- Outbox contract on memory and IndexedDB (fake in Node, real in the browser test): ordering, atomic append, duplicate with different bytes rejected, ack, highest seq, reload.
- Session numbering never repeats across reloads.
- Batching with a fake clock: min and max windows, ordering, one outbox write per flush, `claimedAtMs` is the edit time.
- Connection against the real gateway: handshake, sync, edit, ACK; reconnect with backoff and jitter; busy retry-after; terminal close codes; upload-only grace.
- Property: random edits, random disconnects and reloads on two SDK clients; both converge and the gateway log has no gaps and no duplicate frames.
- Browser (Playwright, two real Chromium contexts): edit through a real gateway, one goes offline (`context.setOffline`), edits, reloads the page, returns; both converge; the offline replica's key was never extractable.

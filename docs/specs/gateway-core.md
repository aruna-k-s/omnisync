# Spec: gateway core (Phase 1, week 4)

**Purpose.** A gateway that survives restarts and flaky networks: no acknowledged edit is ever lost, a cold document loads fast, and clients that drop come back and converge without help.

## Storage model

Source of truth is an **append-only update log** in PostgreSQL. Snapshots in object storage are a cache that bounds load time; losing one never loses data.

| Table | Purpose |
| --- | --- |
| `documents(id, head_seq, created_at)` | One row per document. `head_seq` allocates gapless per-document sequence numbers and serialises writers on the row lock |
| `document_updates(document_id, seq, key_id, session_id, client_seq, frame, received_at)` | Every verified UPDATE frame, byte for byte. Never updated, never deleted, never compacted. Week 6 adds hash-chain columns and turns this into the ledger |
| `update_sessions(document_id, key_id, session_id, last_seq)` | Replay high-water mark per signer session. Survives restarts |
| `snapshots(document_id, version, object_key, sha256, up_to_seq, state_vector, size_bytes)` | Metadata for a full-state copy held in object storage |

Interfaces (package `@omnisync/store`): `DocumentStore` (Postgres, plus an in-memory twin for tests) and `ObjectStore` (filesystem for dev, memory for tests; the S3 adapter with Object Lock arrived in week 9, see `s3-object-store.md`). Document ids stay text in week 4; the control plane moves them to uuids in week 5.

## Write path

1. Verify signature, size and key (as in Phase 0).
2. Enqueue on the document's serial queue. The queue drains in batches: one `appendUpdates` transaction per batch (group commit).
3. Per entry the store answers `appended(seq)`, `duplicate` or `replay`.
4. Only after the transaction commits: apply to the in-memory document, relay to peers, ACK the sender.
5. `duplicate` (same signer, session and client seq already stored) is ACKed again without relaying, so a client retrying after a lost ACK converges. `replay` (client seq not above the stored high-water mark and not stored) is rejected.

If the store fails, no entry in the batch is applied or ACKed. The sender gets `ERROR unavailable`, the gateway reports degraded in `/healthz` and `/readyz` fails, and reads (sync, relay of already-committed edits) continue. Clients keep the update queued and retry.

## Compaction

A snapshot is taken after `compactEveryUpdates` (default 500) updates or `compactEveryMs` (default 5 min) with at least one new update, and when an idle document is evicted. The snapshot bytes and `head_seq` are captured in one synchronous step, so the snapshot covers exactly the updates up to that seq. Upload and metadata insert happen outside the queue; editing never waits on object storage. If object storage is down the snapshot is skipped, a counter rises, and the next trigger retries.

## Cold load

Newest snapshot first: fetch, check SHA-256 against metadata, load. A missing or corrupt object falls back to the next older snapshot, and finally to replaying the whole log from seq 1. Then page through updates with `seq > up_to_seq` (1,000 per page) and apply them. Connections to a loading document wait; other documents are unaffected.

## Eviction

A document with no clients for `idleEvictMs` (default 60 s) is snapshotted if dirty, removed from memory and destroyed. The next connection cold-loads it.

## Reconnect

Client side: exponential backoff with full jitter, capped at 30 s. Server hints (`busy;retry_after_ms=N`) override the computed delay when larger. After connecting the client runs SYNC_1/SYNC_2, then resends every unacknowledged signed frame in client-seq order. Edits made while offline are signed immediately and queued, so they survive.

Server side: at most `maxConcurrentCatchUps` (default 16) SYNC_1 responses may be in flight, meaning not yet flushed to the socket. Others receive `ERROR busy;retry_after_ms=N` with jitter. Large-backlog chunking at about 1 MB is deferred (see out of scope).

## Invariants (property or crash tests)

1. **Durability:** every update that was ACKed is present after a gateway restart, with the same text.
2. **No phantom state:** an update whose append failed is neither applied, relayed nor ACKed.
3. **Log completeness:** deleting every snapshot object and reloading yields the same document.
4. **Snapshot cut:** snapshot at `up_to_seq = n` plus updates `> n` equals replaying updates `1..n+k`.
5. **Idempotent retry:** sending the same signed frame any number of times yields one log row and one effect.
6. **Replay survives restart:** a frame accepted before a restart is not accepted as new after it.
7. **Convergence after partition:** clients that edit offline and reconnect end with identical text equal to the gateway's.

## Failure modes

| Fault | Behaviour |
| --- | --- |
| PostgreSQL down or timing out | Writes refused with `unavailable`, reads continue, `/readyz` 503, recovery is automatic on the next successful call |
| Object storage down | Snapshots lag, `snapshotFailures` counter rises, editing continues |
| Corrupt or missing snapshot object | Fall back to older snapshot or full log replay, counted in `snapshotFallbacks` |
| Gateway killed mid-batch | Uncommitted batch is lost but was never ACKed, so clients resend it |
| Catch-up stampede | Excess SYNC_1 answered `busy` with a retry delay |

## Known limits

- A validly signed update whose payload the engine cannot apply is stored (it is signed evidence), answered `engine_rejected`, and skipped deterministically on every load (`poisonUpdates` counter). Pre-validating payloads against a scratch document is a Phase 2 hardening item.
- One writer replica per document. The `documents.head_seq` row lock keeps the log gapless even if two replicas collide, but in-memory state is not shared until Redis fan-out and routing arrive (Phase 4).
- Group commit batches by queue depth, not by timer. Under low load every update is its own transaction (one round trip).
- Catch-up admission counts in-flight sends, not bytes. A multi-megabyte diff holds a slot until flushed; chunked catch-up is out of scope.

## Security notes

Protected path touched: `apps/gateway/src/gateway.ts`. The write path keeps verify-before-anything. The store holds raw frames, so Phase 1 week 6 can recompute and verify signatures and the hash chain from the log alone. Payload encryption at rest and `payload_ref` to object storage arrive with the key hierarchy.

## Out of scope

Redis fan-out between replicas and document-ID routing (a document has one writer replica until Phase 4), ledger hash chain and checkpoints (week 6), certificate-based keys (week 5), S3 adapter (week 9), chunked catch-up for multi-megabyte backlogs.

# Spec: ledger, checkpoints and the verifier (Phase 1, week 6)

Status: implemented in week 6. Decisions D3, D4, D5 from the project plan are settled as written here.
Protected paths: `packages/crypto/src/ledger.ts`, `packages/verifier/**`, `packages/store/src/{pg,memory}.ts`, migration `003`, `apps/gateway/src/checkpoint.ts`.

## Purpose

The update log already stores every signed frame and never changes (a database trigger forbids UPDATE and DELETE). Week 6 makes it a **ledger**: tamper-evident to someone who does not trust the database. After this week an auditor with an export, the public keys of the certificate issuer and the ledger key, and the verifier can prove four things with no database access: nothing in the export was altered, removed from the middle, reordered or swapped; every entry was signed by a certificate that a trusted issuer issued and that was valid when the entry arrived; the export matches the signed checkpoints the gateway wrote to a separate store; and how many entries are newer than the last checkpoint.

It cannot prove the content is correct, that the gateway told the truth about receive time, or that nothing was deleted after the last checkpoint (see Known limits).

## Decisions applied

- **D3, per-document chains plus a signed tenant checkpoint.** Each document has its own gapless chain, built under the row lock the log already takes. A tenant checkpoint is one signed statement over the heads of every document that changed since the previous checkpoint. Checkpoints themselves form a chain (each carries the hash of the previous one), so an auditor gets one signed history per tenant.
- **D4, reserved fields.** Every entry carries `key_epoch` (always 0 until Phase 2 encryption) and a `payload_hash` next to the `frame_hash`. When Phase 2 encrypts payloads at rest and destroys keys to erase data, the entry format does not change: the hashes stay, the bytes may go, and the chain still verifies.
- **D5, separate ledger key.** Checkpoints are signed by a ledger key that is not the certificate issuing key. Compromising certificate issuance cannot forge history. Both keys come from a signer callback (`LedgerSigner`), the same seam the KMS adapters use in Phase 2.

## Entry

One row in `document_updates` per accepted update. New columns, all set inside the append transaction while the document row is locked:

| Column | Meaning |
| --- | --- |
| `received_at_ms` | Gateway receive time in ms. Authoritative; the signer's claimed time is inside the signed frame |
| `prev_hash` | `entry_hash` of seq-1, or 32 zero bytes for seq 1 |
| `entry_hash` | Hash below |
| `frame_hash` | SHA-256 of the stored frame, signature included |
| `payload_hash` | SHA-256 of the stored payload bytes (today the frame payload; ciphertext once encrypted) |
| `key_epoch` | 0 |

`cert_serial` (week 5) is covered by the hash.

```
entry_hash = SHA-256(
  "omnisync/v1/ledger-entry\0"
  || 0x01                                   version
  || varint len(docId) || utf8(docId)
  || u64be seq || prev_hash (32)
  || u64be received_at_ms || u32be key_epoch
  || 0x00                                  (no certificate)   or   0x01 || cert_serial (16)
  || frame_hash (32) || payload_hash (32) )
```

The hash does not include the database's own timestamps or row ids. Anything that decides what an entry means is in the preimage, so a change to any of it changes the hash.

## Documents and the registry

`document_registry(id, created_by, created_at_ms)` is written by the control plane in the same transaction as the creator's admin grant and the audit event. New document ids are canonical lowercase UUIDv4 strings. The control plane refuses grant operations on any other shape. The store itself still accepts any text id (tests and tools use short ids); the gateway admits a connection only if a grant exists, and grants exist only for registered documents.

## Checkpoint

Canonical binary, signed with the ledger key:

```
"OK" 2B | version 1B | n varint | created_at_ms varint | prev_checkpoint_hash 32 | tenant varint-len utf8
| count varint | count x { docId varint-len utf8 | seq varint | head_hash 32 } sorted strictly ascending by docId bytes
| ledger key id 8B | signature 64B
```

The signature covers `"omnisync/v1/checkpoint\0"` plus every byte before it. `checkpoint_hash` is SHA-256 of the whole object, signature included. `n` starts at 1 and has no gaps; `prev_checkpoint_hash` for n=1 is 32 zero bytes. An entry list is a **delta**: only documents whose head moved since checkpoint n-1. A document's attested head at checkpoint n is therefore the last delta that named it.

### Writing

The `CheckpointWriter` (gateway) runs every 5 minutes or after 1,000 persisted entries, whichever comes first, and once more on clean shutdown.

1. Read up to `maxDocs` pending heads (`head_seq > checkpoint_seq`) and the last checkpoint.
2. Build and sign the body.
3. **Reserve n in the database first** (`ledger_checkpoints` is append-only and `n` is its primary key), advancing each document's `checkpoint_seq` in the same transaction. A concurrent writer loses on the primary key and retries.
4. Upload the exact bytes to the object store at `checkpoints/<tenant>/<n, 12 digits>.ckpt`.
5. Record the upload.

Because step 3 precedes step 4, the object store never holds two different objects for one `n`. Every tick first re-uploads any reserved checkpoint without a recorded upload (the same bytes to the same key), so a crash between 3 and 4 heals itself. With S3 Object Lock in compliance mode (week 9), the upload is the part that cannot be rewritten later.

## Export and verification

`pnpm --filter @omnisync/gateway export` writes newline-delimited JSON, in this order, which the verifier requires so it can run in constant memory per document:

1. `{"t":"meta", "version":1, "tenant", "exportedAtMs"}`
2. `{"t":"cert", "serial", "certificate"}` for every certificate with stored bytes
3. `{"t":"checkpoint", "bytes"}` in `n` order
4. `{"t":"entry", ...}` per document, ascending seq: `doc, seq, receivedAtMs, certSerial?, keyEpoch, prevHash, entryHash, frameHash, payloadHash, frame` (`frame` may be absent after erasure; every hash stays)

`omnisync verify <export> --issuer <hex pubkey>... --ledger-key <hex pubkey>... [--locked <dir>] [--grace-ms 259200000] [--json]` reads the export and the trust inputs only. `--locked` is a directory holding the copies fetched from the locked bucket. Exit code 0 means no violation; 1 means at least one; 2 means unusable input.

Checks, with the violation code each raises:

| Check | Code |
| --- | --- |
| Recomputed `entry_hash` equals the stored one | `entry_hash_mismatch` |
| seq starts at 1 and has no gap or repeat; `prev_hash` equals the previous `entry_hash` (zeros for seq 1) | `chain_gap`, `chain_break` |
| `frame_hash` and `payload_hash` match the frame when present; the frame decodes | `frame_hash_mismatch`, `payload_hash_mismatch`, `frame_malformed` |
| The frame's document, key id and the entry match | `frame_binding` |
| A certificate with that serial is in the export, is signed by a trusted issuer and decodes | `cert_missing`, `cert_untrusted`, `cert_malformed` |
| The certificate's key is the frame's `keyId` and verifies the frame signature (strict) | `cert_key_mismatch`, `bad_signature` |
| `received_at_ms` is not before `not_before` and not after `not_after` plus the upload-only grace | `cert_window` |
| Every checkpoint is signed by a trusted ledger key, `n` is gapless, `prev_checkpoint_hash` links, `created_at_ms` does not go backwards | `checkpoint_signature`, `checkpoint_gap`, `checkpoint_chain`, `checkpoint_time` |
| Each attested `(doc, seq, head_hash)` equals the export's entry; the export reaches that seq | `checkpoint_head_mismatch`, `truncated` |
| With `--locked`: every locked checkpoint equals the export's copy, and the export has none the locked store lacks beyond the newest | `locked_mismatch`, `locked_missing`, `locked_extra` |
| Entries with no frame must be explainable: allowed, reported as `erased` count | (info) |

`received_at_ms` going backwards within a document is reported as a warning, not a violation: a gateway clock can step.

The report lists totals (documents, entries, certificates, checkpoints, `entriesAfterLastCheckpoint`, `lastCheckpointAtMs`), every violation (capped at 1,000 with a count of the rest) and every warning.

## Invariants

1. For every document, `entry_hash` is a pure function of the entry fields and `prev_hash`; the chain from seq 1 is the only valid ordering.
2. Chain fields are set in the same transaction that inserts the row, under the document lock. A failed append leaves no chain state.
3. A duplicate or replayed append does not change any chain state.
4. The verifier never trusts a field it can recompute.
5. Changing any single byte of an export, deleting a row, reordering rows or swapping a certificate produces at least one violation (property tested).
6. A checkpoint never attests a head the database did not hold when it was built, and `n` is never reused.
7. The object store never holds two different objects for one `n`.
8. The ledger signing key never signs a certificate and the issuing key never signs a checkpoint (separate key ids; the verifier takes them as separate trust inputs).

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Object store down at checkpoint time | Checkpoint stays reserved; retried each tick; the checkpoint-age stat grows; editing continues |
| Crash between reserve and upload | Re-uploaded on the next tick, same bytes, same key |
| Two checkpoint writers | One wins `n`; the loser re-reads and retries; no duplicate objects |
| Signer throws | No row is reserved; counted; retried next tick |
| Database administrator edits or deletes entries | Verifier fails (hash, chain, checkpoint head or truncation) unless the edit is after the last checkpoint |
| Database administrator replaces the whole database | Verifier fails against `--locked` copies |
| Export with entries but no checkpoints | Passes chain and signature checks; reported with `checkpoints: 0` and every entry counted in `entriesAfterLastCheckpoint` |
| Migration 003 on a database that already has log rows | Refuses with an explanation (pre-release only; there is no pre-ledger production data) |

## Known limits

- Entries newer than the last checkpoint can be removed together by a database administrator and nothing detects it. The window is the checkpoint interval (5 minutes or 1,000 entries). Customers who need less can lower the interval or send checkpoints to their SIEM.
- Receive time is the gateway's clock. A compromised gateway can lie about it. Checkpoint times from a second source (the locked bucket's own object timestamps) bound the lie.
- Revocation after the fact does not invalidate old entries: the question the ledger answers is "was this certificate valid when the entry arrived".
- One checkpoint writer per tenant per install. Phase 4 adds a lease.
- The store accepts non-UUID document ids; only the control plane enforces UUIDs (see above).

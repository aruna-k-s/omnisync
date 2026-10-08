# Spec: S3 object store with Object Lock (Phase 1, week 9a)

**Purpose.** Snapshots and ledger checkpoints move from a local directory to an S3-compatible bucket (decision D8: the S3 API, MinIO in the chart, any S3 bucket accepted). The checkpoint bucket is the ledger's out-of-band anchor, so it gets what a directory cannot give: objects that **nobody can rewrite or delete during their retention period**, and an upload that **cannot overwrite** an existing object even when two writers race. This closes the check-then-upload gap recorded in `ledger.md`.

Non-goals: multipart upload (objects are small: snapshots are capped by the room, checkpoints by `maxDocs`), listing, lifecycle rules, server-side encryption configuration (the bucket's own policy), cross-region replication, a custom signer (requests are signed by the AWS SDK; we write no signing code).

## Interface change

`ObjectStore` gains one method:

```ts
/** Writes `bytes` only when nothing is stored under `key`. true = created, false = something was already there (it is left untouched). */
putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean>;
```

It is atomic in every implementation: memory (single-threaded check and set), filesystem (temp file, then `link(2)` which fails with `EEXIST`, then remove the temp file), S3 (conditional write `If-None-Match: *`; `412 PreconditionFailed` and `409 ConditionalRequestConflict` both mean "already there" after a read-back, see below). `put` keeps its overwrite semantics for snapshots, which are content-addressed and idempotent.

### Checkpoint writer (protected path `apps/gateway/src/checkpoint.ts`)

`#upload(n, bytes)` becomes: `created = putIfAbsent(key, bytes)`; if not created, `get(key)`: equal bytes means an earlier attempt already uploaded this checkpoint (success, idempotent); different bytes means a conflict (`uploadConflicts++`, log, stop, exactly as today); a vanished object (get returns undefined after a refusal) is a failure to retry. Invariant 7 of `ledger.md` ("the object store never holds two different objects for one `n`") now holds without relying on the writer's own ordering. No other change to the writer.

## `S3ObjectStore` (`@omnisync/store/s3`)

A subpath export, so the AWS SDK is loaded only when S3 is configured. Dependency: `@aws-sdk/client-s3` (v3). Why: S3 request signing (SigV4), credential discovery (environment, web identity, instance roles) and retries must not be hand-written (see "Never invent cryptography"); this is the supported client and a small, tree-shaken subset (`S3Client`, `GetObjectCommand`, `PutObjectCommand`, `DeleteObjectCommand`, `GetObjectLockConfigurationCommand`, `GetBucketVersioningCommand`).

```ts
new S3ObjectStore({
  bucket, endpoint?, region = "us-east-1", forcePathStyle = false, prefix = "",
  lock?: { mode: "COMPLIANCE" | "GOVERNANCE", retainDays: number },
  requestTimeoutMs = 10_000, maxObjectBytes = 64 MiB,
  client?  // for tests
})
```

- **Keys.** `prefix + key`. A key must be 1-1024 bytes of well-formed text, must not start with `/`, contain `..` as a path segment, a NUL or a backslash. Anything else is rejected before any request (same spirit as the filesystem store's path-escape check).
- **`get`** returns the bytes, or `undefined` on `NoSuchKey`/404. An object larger than `maxObjectBytes` is an error, never read into memory. The body is read fully; a short read is an error.
- **`put`, unlocked store.** Overwrites (plain `PutObject`).
- **`put` and `putIfAbsent`, locked store.** Every write sends `ObjectLockMode` and `ObjectLockRetainUntilDate = now + retainDays` and the `If-None-Match: *` condition; on a locked store `put` therefore behaves as `putIfAbsent` that **throws `ObjectExistsError`** when the key exists with different bytes and returns quietly when it holds the same bytes (so a retried upload is idempotent).
- **`delete`, locked store.** Throws `ObjectLockedError` without sending a request: nothing in OmniSync deletes a checkpoint, and a bug that tried must not reach the bucket. On an unlocked store it deletes.
- **Integrity.** Requests carry a SHA-256 checksum (`ChecksumSHA256`); the bucket rejects a body that does not match.
- **Timeouts.** Every call aborts after `requestTimeoutMs`; the gateway's own deadline (`objectTimeoutMs`) still applies on top.
- **`verifyBucket()`**, called once at start when `lock` is set: the bucket must have Object Lock enabled (`GetObjectLockConfiguration` says `Enabled`) and versioning enabled (Object Lock requires it). Otherwise it throws a message naming the bucket and the missing property, and the gateway does not start. When the bucket has a default retention rule that is **shorter** than `retainDays`, the per-object retention (which we send) still wins; nothing to check. A bucket that cannot be reached at start is also a start failure: a deployment that cannot anchor its ledger must not look healthy.
- **Errors never contain credentials, signed URLs or object bytes.** Messages carry the operation, the bucket and the key.

## Gateway configuration (`apps/gateway/src/serve.ts`, `ledger-config.ts`)

| Variable | Meaning |
| --- | --- |
| `OMNISYNC_S3_ENDPOINT` | endpoint URL for MinIO or another S3-compatible service; omit for AWS |
| `OMNISYNC_S3_REGION` | default `us-east-1` |
| `OMNISYNC_S3_PATH_STYLE` | `1` for MinIO |
| `OMNISYNC_SNAPSHOT_S3_BUCKET` | snapshots go to this bucket instead of `OMNISYNC_DATA_DIR` (setting both is a start error) |
| `OMNISYNC_CHECKPOINT_S3_BUCKET` | checkpoints go to this bucket instead of `OMNISYNC_CHECKPOINT_DIR` (setting both is a start error; one of the two is required) |
| `OMNISYNC_CHECKPOINT_RETAIN_DAYS` | required with the checkpoint bucket; integer 1-36500. No default: a compliance-mode retention cannot be shortened later, so the operator chooses it |
| `OMNISYNC_CHECKPOINT_LOCK_MODE` | `COMPLIANCE` (default) or `GOVERNANCE` |

Credentials come from the AWS SDK's default chain (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, web identity, instance role); OmniSync reads, logs and stores none. The snapshot bucket and the checkpoint bucket must differ (start error), because they need different locking and a different blast radius.

## Failure modes

| Situation | Result |
| --- | --- |
| Two writers upload checkpoint `n` at once with the same bytes | One creates, the other sees `exists` and finds equal bytes: both succeed, one object |
| ...with different bytes | The loser gets `exists`, reads different bytes, counts a conflict and stops reserving numbers; the bucket keeps the first |
| Upload retried after a crash between upload and `markCheckpointUploaded` | `exists` with equal bytes: marked uploaded |
| Bucket without Object Lock or versioning, with `lock` configured | Start refused, message names the missing property |
| Delete of a locked object | `ObjectLockedError`, no request sent |
| Bucket unreachable at start | Start refused |
| Bucket unreachable later | Checkpoint stays reserved and retried; editing continues (as before) |
| Credentials missing or wrong | Request error without secrets; same handling as an outage |
| Object larger than the cap | Error, not read |
| Hostile key | Rejected before any request |

## Tests

1. **Object store contract**, run against memory, filesystem and S3: put/get/delete round trip; missing object is `undefined`; `putIfAbsent` creates once and leaves the first bytes in place; 20 parallel `putIfAbsent` calls on one key yield exactly one `true` and the stored bytes are the winner's (property over random byte strings); hostile keys rejected.
2. **S3 specifics** (a local S3-compatible server with Object Lock, `moto`, started by the test; skipped without it unless `OMNISYNC_REQUIRE_S3=1`, which CI sets): a locked store refuses overwrite with different bytes, accepts the same bytes, refuses delete without a request (counted with a request-counting client), sends mode and retain-until in the future by `retainDays`; `verifyBucket` rejects a bucket without lock and one without versioning and accepts a proper one; a body larger than the cap is refused; an unreachable endpoint times out within the configured time; error messages contain no secret key (the test uses a recognisable one).
3. **Checkpoint writer**: the existing tests pass unchanged; new: a writer whose `putIfAbsent` reports `exists` with equal bytes marks uploaded; with different bytes counts a conflict and does not mark; two writers racing on a real S3 store write one object; the fault wrapper's outage and hang still stop uploads.
4. **Configuration**: every row of the variable table (both set, neither set, missing retain days, bad lock mode, same bucket twice) gives its message; no message contains a key.
5. **End to end** (S3 server + gateway + control plane): checkpoints land in a locked bucket, the export plus the copies fetched from the bucket verify as **anchored** with `omnisync verify`, and a direct attempt to delete a checkpoint object from the bucket fails while it is retained.

## Protected paths touched

`apps/gateway/src/checkpoint.ts` (upload step only), `apps/gateway/src/serve.ts` and `ledger-config.ts` (configuration; ledger code by the AGENTS.md rule), `packages/store/src/types.ts` (interface), `packages/store/src/{memory,fs-object-store,testing}.ts` (the new method). They wait for the 24-hour human review.

## Known limits

On a versioned bucket, a plain `DeleteObject` adds a delete marker that makes the key look absent even though the locked version remains, and a later conditional write would then succeed as a new version. The adapter never deletes locked keys, but a stolen credential could. The gateway's credentials therefore must not carry `s3:DeleteObject` or `s3:DeleteObjectVersion` on the checkpoint bucket (the chart's bucket policy and the install runbook say so), and the verifier's `--locked` comparison reports a hidden checkpoint as `locked_missing` or a divergent one as `locked_mismatch`.


Object Lock in compliance mode cannot be shortened or removed by anyone, the account owner included: a wrong `retainDays` costs storage until it expires. MinIO's S3 conditional write and Object Lock are exercised here against `moto`, not against MinIO itself (its binary is not reachable from the build environment); the chart's smoke test and the first real install must confirm MinIO.

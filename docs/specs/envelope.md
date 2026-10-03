# Spec: signed update envelope (wire format v2)

**Purpose.** Every edit that reaches a document is attributable to one key and tamper-evident, so the ledger (Phase 1) can prove who changed what.

## Inputs and outputs

```
| magic 0x4F | version 0x02 | type 1B | flags 1B | session id varint | seq varint |
| claimed-at ms varint | payload length varint | payload | key id 8B | signature 64B |
```

- Varints: unsigned LEB128, minimal encoding, at most 2^53-1.
- Types: `SYNC_1`=1 state vector, `SYNC_2`=2 diff, `UPDATE`=3 signed edit batch, `AWARENESS`=4 presence, `ACK`=5, `ERROR`=6, `AUTH_CHALLENGE`=7, `AUTH_RESPONSE`=8, `AUTH_RESULT`=9 (handshake, see identity.md).
- `claimed-at ms`: when the edit was made on the device, in milliseconds since the epoch. It is inside the signed bytes, so it cannot be altered in transit. 0 on frames that do not use it. The gateway checks it against the signer's certificate window (identity.md); the ledger records the gateway's own `received_at` beside it.
- v2 replaced v1 outright (pre-release, no installed base); `version 0x01` frames are rejected with `bad_version`. Vectors were regenerated.
- Flags: bit 0 `SIGNED`. All other bits must be zero. `UPDATE` must be signed; the trailer exists only when `SIGNED` is set.
- Key id: first 8 bytes of SHA-256(Ed25519 public key).
- Signed message: `"omnisync/v1/update\0" || varint(len(docId)) || utf8(docId) || frame bytes up to and including key id`.
- Signature: Ed25519 (RFC 8032), strict verification (no ZIP-215 leniency).
- Payload cap: 1 MiB by default, checked before reading the payload.

## Invariants (each is a property test)

1. `decode(encode(f)) == f` for every valid frame.
2. `verify(sign(x)) == ok` for every payload and document id.
3. Flipping any single bit of a signed frame makes verification fail.
4. A frame signed for document A never verifies for document B.
5. Decoding random bytes either succeeds or throws `FrameError`; nothing else escapes.
6. `node:crypto` and `@noble/ed25519` produce byte-identical frames (test vectors).

## Failure modes

| Input | Behaviour |
| --- | --- |
| Truncated, overlong, unknown type or flag, trailing bytes | `FrameError` with a code; gateway replies `ERROR malformed` and counts it |
| Unknown or revoked key id | `unknown_key` |
| Signature mismatch, wrong document | `bad_signature` |
| Same key, session and an already stored client seq | gateway ACKs again without re-applying (idempotent retry) |
| Client seq not above the stored high-water mark and never stored | gateway rejects `replay` |

## Security notes

The gateway never accepts `SYNC_2` from clients, so no unsigned state can enter a document. Protected paths: `packages/protocol/src/frame.ts`, `signing.ts`, `test/vectors.json`.

## Out of scope (Phase 1)

Session certificates and their validity windows replace the static keyring; client-side verification of relayed peer updates; batching every 50-250 ms in the browser SDK.

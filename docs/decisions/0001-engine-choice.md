# ADR 0001: Collaboration engine

- Status: **Proposed** (the founder decides at the Phase 0 gate)
- Date: 2026-10-01
- Data: `pnpm bench`, Node 22, one shared cloud container. Re-run on your own machine before deciding; absolute numbers will move, ratios less so.

## Measured

Typing trace (mostly appends at a moving cursor, about 10% deletes), one author and one replica that applies every update.

| Engine | Ops | Local op (µs) | Avg update (bytes) | Apply all (ms) | Snapshot (KB) | Cold load p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| Yjs 13.6 | 100,000 | 47 | 27 | 1,001 | 202 | 121 |
| Loro 1.16 | 100,000 | 37 | 91 | 3,833 | 311 | 11 |
| Automerge 3.5 | 20,000 | 192 | 127 | 103,219 | 33 | 161 |

End to end through the gateway prototype, 100 editors, sequential signed edits, one observer: Yjs p50 2.1 ms / p99 8.8 ms, Loro p50 3.6 ms / p99 14.9 ms. Every run converged. Target is p99 under 100 ms.

Signed envelope: 56 µs to sign, 158 µs to verify (native Ed25519 via node:crypto), 80 bytes of overhead per frame. Pure-JS noble was about 15x slower to verify, so the gateway uses node:crypto and browsers use noble; shared test vectors prove both produce identical bytes.

## Reading

- **Automerge** spends about 5 ms applying each remote keystroke once history reaches 20,000 ops, so one replica falls minutes behind a fast typist. Out unless batching changes this by an order of magnitude.
- **Yjs** has the smallest updates (27 bytes, so the 80-byte signature dominates and per-batch signing matters) and the fastest remote apply. Its cold load is the slowest of the two leaders but far inside the 500 ms target at this size.
- **Loro** loads snapshots 10x faster and is close on everything else. It is the fallback if 10 MB snapshots miss the cold-load target with Yjs.

## Proposed decision

Choose **Yjs** for Phase 1, behind the `packages/engine` interface. Keep the Loro adapter compiling and in the benchmark so the switch stays cheap.

## Still to measure before the gate

- Cold load with a real 10 MB snapshot (target p95 under 500 ms).
- Gateway memory per document at 100,000 ops, measured in the gateway process alone (this harness also counts the trace held in memory).
- Batched signing every 50-250 ms instead of per keystroke.

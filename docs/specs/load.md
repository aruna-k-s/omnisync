# Spec: load harness and measured numbers (Phase 1, week 10c)

**Purpose.** `benchmarks.md` states four targets. Until now two were checked only by proxies (an engine table measuring two replicas in one process, and a sequential end-to-end run with one edit in flight). This spec defines a harness that measures them through the real gateway, a real PostgreSQL and real WebSocket connections, with the load generator and the gateway in separate processes, records the numbers with the conditions they were measured under, and turns every miss into a ticket. It also adds a k6 script for the control plane's HTTP surface, validated in CI and not run here.

Non-goals: a capacity plan (one box, two cores, loopback network), a Kubernetes or multi-node run, browser rendering cost, authentication cost (the gateway runs in its static-key mode, as the existing bench does; the certificate handshake is not in these numbers), a soak test.

## Rules

1. **Numbers are recorded, not argued with.** Targets in `benchmarks.md` are not edited to fit a result. A result is `met`, `missed` or `not measured`, and every `missed` and `not measured` becomes a ticket in the table at the end of this spec before week 11 starts.
2. **Conditions travel with the number.** Every result file records the machine (CPU count and model, memory, kernel), Node version, store (PostgreSQL version, local socket or TCP), engine, and every parameter. A number without them is not cited.
3. **The harness cannot flatter.** Latency is measured from just before the sender's local edit to just after a *different* client has applied the update to its own document (the first moment it could render it), on one clock. A dropped or never-delivered edit is a failure of the scenario, not a missing sample: every sent edit must reach every probe, and the run fails if one does not. Percentiles are computed over all samples, never averaged across runs. Warm-up samples (the first 10% of the run, at least 2 seconds) are discarded and said so.
4. **Honest about the box.** Load generator and gateway run on the same two cores. The harness reports the generator's own event-loop delay (p99) alongside each latency; when it exceeds 10 ms the latency result is marked `generator-bound` and is an upper bound on what the gateway alone would show, not a pass or a fail.
5. **No test-only paths in the gateway.** The gateway child process is the real `Gateway` class with the real store, real metrics (the 10a telemetry, scraped from its own `/metrics`) and a file-system object store. Nothing in `apps/` changes for this week.
6. **Small runs are tests, large runs are measurements.** The test suite runs every scenario at toy scale (a handful of clients, hundreds of operations) to prove the harness measures what it says; the measurements are produced by `pnpm load` with the default sizes below and are not part of `pnpm check`.

## Scenarios

| Scenario | Target (`benchmarks.md`) | What runs | Result |
| --- | --- | --- | --- |
| `edit-latency` | Keystroke to remote render, p99 under 100 ms, 100 editors on one document | 100 connections on one document, in two profiles: **typical** (10 typists at 5 edits/s each, 90 readers) and **worst case** (all 100 type at 2 edits/s each). Edits arrive as a Poisson process per typist. Duration 60 s after warm-up. 5 probe clients are full `GatewayClient`s that apply every update; the rest of the readers are raw sockets that do the handshake and count frames (applying 100 x 99 updates per second in one Node thread would measure the generator). The gateway fans out to all 100 either way | p50, p95, p99, max over all probe samples; edits per second achieved; server-side p99 of `omnisync_update_apply_seconds`, `omnisync_ledger_append_seconds` and `omnisync_fanout_seconds` from the scrape; generator event-loop p99 |
| `memory` | Gateway memory per active document under 50 MB at 100,000 operations of history | One document is filled with 100,000 typing operations through a client (the same deterministic trace as the engine bench), then the gateway is idle; its resident memory is read after a forced GC and compared with the same process before the document was opened | Resident-set growth in MB; heap used growth; operations; snapshot size; how long the fill took |
| `cold-load` | Cold document load, p95 under 500 ms, 10 MB snapshot | A document whose snapshot is about 10 MB is written and a snapshot cut. For 20 rounds the room is evicted (gateway child restarted against the same database and object store) and one client connects and syncs. Time is measured **at the client**, from opening the socket to the end of the first sync, with a decoder that accepts large frames (`coldSync`, 512 MiB cap), because the stock decoder dropped a SYNC_2 over 1 MiB when this was first run (ticket L1, since fixed). The harness then also tries the **stock `GatewayClient`** on the same document and checks that it holds the whole text; the verdict is `missed` when it cannot load it. The result records `loadedFrom` (snapshot version and replayed updates) and `roomLoads` from the scrape, so a run that silently replayed the log or never evicted cannot pass | p50, p95, max of the gateway-side sync; the time for a fresh process; snapshot bytes; whether the stock client loaded it |
| `reconnect-storm` | 200 clients back within 60 s, no live-edit stall, after a 30-minute partition | 200 clients on one document through a TCP proxy; each types a small offline edit during the partition; the proxy drops every connection and refuses new ones for the partition window, then accepts again. A live editor, connected directly to the gateway (not through the proxy), types 10 edits/s throughout and a probe applies them. Two profiles: **small** document and **large** (`LOAD_STORM_DOC_KB`, default 800 KiB, chosen when the client could not open anything over 1 MiB; since the L1 fix any size up to `LOAD_STORM_DOC_KB` 16000 can be used) | time from healing to the last client synced with its offline edit acknowledged (and p50/p95 per client); live-edit latency p99 and max before and during the storm; connections that never returned; busy and rate-limit counters from the scrape; generator event-loop p99. "No stall" means no live edit took longer than 1000 ms during the storm |

The partition window is **not** 30 minutes: the harness uses 10 seconds by default. What a long partition changes for a reconnecting client is the size of its backlog and how far its certificate and clocks have moved, and the backlog is set by the offline edits (a parameter); certificate expiry and the clock skew limit are covered by the identity tests. The result says "10 s partition, N offline edits per client" and does not claim the 30-minute figure.

## Default sizes (`pnpm load`)

| Parameter | Default | Variable |
| --- | --- | --- |
| Editors on the document | 100 | `LOAD_EDITORS` |
| Run length after warm-up | 60 s | `LOAD_SECONDS` |
| Operations for the memory run | 100,000 | `LOAD_OPS` |
| Cold-load snapshot size | 10 MB | `LOAD_SNAPSHOT_MB` |
| Cold-load rounds | 20 | `LOAD_ROUNDS` |
| Storm clients | 200 | `LOAD_STORM_CLIENTS` |
| Storm document size (large profile) | 800 KiB | `LOAD_STORM_DOC_KB` |
| Storm partition | 10 s | `LOAD_PARTITION_S` |
| Offline edits per storm client | 5 | `LOAD_OFFLINE_EDITS` |
| Engine | `yjs` | `LOAD_ENGINE` |
| Scenarios | all | `LOAD_ONLY` (comma list) |
| Database | `OMNISYNC_TEST_DATABASE_URL` or `BENCH_DATABASE_URL`; required | |

Results are written to `bench/results/load-<timestamp>.json` and summarised in a table with `met` / `missed` / `generator-bound` / `not measured` against each target.

## k6 script (`deploy/load/control-plane.k6.js`)

HTTP only, against a control plane the operator points it at (`K6_BASE_URL`); it never opens a WebSocket. Scenarios: `health` (unauthenticated `GET /healthz`, constant arrival rate), `me` (`GET /v1/me` with a session token from `K6_SESSION_TOKEN`), and `admin-lists` (`GET /v1/admin/documents` and `/v1/admin/principals`, admin token). Thresholds: `http_req_failed < 1%` and `http_req_duration p(95) < 300 ms` per scenario, with the 429 rate reported separately because the control plane's own rate limits are expected to answer some of a flood. The token is read from the environment and never printed or tagged. It issues no certificates, creates no documents, changes no grants and does not call the OIDC or device-login routes (those create state or depend on an identity provider). Proven here: the file parses, declares the three scenarios and thresholds, reads its inputs from the environment and contains no literal credential (`deploy/tests/test_load_script.py`). CI additionally runs `k6 inspect`. **Not proven**: that it passes against a real deployment; nothing has run it.

## Tests

- Statistics: percentile on known sequences (nearest rank, including one sample, two, and ties), summary of an empty list refuses, warm-up trimming, verdicts at, just under and just over a target, `generator-bound` marking.
- Poisson schedule: mean inter-arrival close to the rate, deterministic for a seed, never negative.
- Proxy: forwards bytes both ways, partition kills open connections and refuses new ones, heal accepts again, counts.
- Child gateway: starts, reports its port and metrics port, serves an edit, reports memory, restarts against the same store.
- Each scenario at toy scale against the in-memory store and, when `OMNISYNC_TEST_DATABASE_URL` is set, PostgreSQL: it converges, produces the result fields, fails when an edit is lost (a probe that is cut off), and the memory scenario reports growth that increases with the operations.
- k6 script structure (Python, with the other deploy tests).
- Mutation checks on the statistics, the verdicts, the latency timestamps (sender before, receiver after apply), the discarded warm-up, the lost-edit failure, the proxy's partition and the memory difference.

## New dependencies

No new third-party package. `bench/package.json` gains `ws` and `@types/ws` (the harness opens raw WebSocket peers; both are already in the lockfile for the gateway, so the lockfile changes by nine lines) and the workspace package `@omnisync/telemetry` (to read the gateway's real `/metrics`). `pg` was already a bench dependency; the rest is Node's `child_process`, `net` and `perf_hooks`. `vitest` is the repository's existing test runner. The restart measurement in the cold-load scenario is PostgreSQL-only (the in-memory store loses its data with the process).

## Known limits

One machine, loopback, two cores: the gateway, the load generator and PostgreSQL compete, which makes latency pessimistic and throughput optimistic about the network. A run is minutes, not hours: leaks and GC drift that need a day are not visible. Authentication is off. The k6 script has never been executed. Raw peers do not apply relayed updates, so client-side CPU of 95 of the 100 editors is not in the numbers.

## Results

Run on 2026-10-08, `pnpm load` with the defaults, raw file `bench/results/load-2026-10-08T16-43-11-155Z.json` (gitignored; the numbers below are copied from it). Every number carries the conditions in the next section.

| Scenario | Target | Measured | Verdict |
| --- | --- | --- | --- |
| Edit latency, typical (10 of 100 type, 5 edits/s) | p99 < 100 ms | p99 12.63 ms (p50 3.17, p95 6.77, max 71.73); 50.7 edits/s; generator loop p99 1.26 ms | met |
| Edit latency, worst case (all 100 type, 2 edits/s) | p99 < 100 ms | p99 15.98 ms (p50 3.73, p95 9.69, max 65.63); 204.8 edits/s; generator loop p99 2.41 ms. Server-side p99 bucket upper bounds: apply 25 ms, ledger append 10 ms, fan-out 2.5 ms | met |
| Memory at 100,000 operations | < 50 MB per document | RSS growth 34.89 MB (145.84 to 180.72 MB), heap growth 5.81 MB, 199 snapshots, fill 2136 ops/s. An earlier identical run gave 46.51 MB | met, with variance (L3) |
| Cold load, 10 MB snapshot | p95 < 500 ms | First run (2026-10-08): gateway side p95 103.2 ms, but the stock client and SDK could not load the document at all (L1), so **missed**. After the L1 fix (`docs/specs/large-sync.md`), rerun 2026-10-09 (`load-2026-10-09T13-35-35-659Z.json`, cold-load only): p95 146.4 ms (p50 136.1, max 152.3) over 20 rounds, fresh process 167.3 ms, and the stock client loads the full document. The two runs differ by about 40 ms on the same code path (different machine state), so cite the range 103 to 146 ms | met after L1 |
| Reconnect storm, small document | 200 clients back in 60 s, no stall | All back in 28.96 s (client p50 4.1 s, p95 21.1 s); live edits p99 20.5 ms before, 91 ms during (max 104.8); busy 0, rate-limited 0, converged; generator loop p99 19.35 ms | met, upper bound (L5) |
| Reconnect storm, 800 KiB document | same | All back in 28.52 s; live p99 52 ms during (max 69.8); busy 0; generator loop p99 21.4 ms | met, upper bound (L5) |

Warm-up (first 10%, at least 2 s) is discarded in the latency scenarios. Percentiles are nearest-rank over all probe samples. Recovery time in the storm is set by the client's reconnect back-off (250 ms base, 30 s cap, full jitter), not by the gateway: it is about half the target, but a 30 s cap means a client that draws a long wait is already half way through the allowance.

### Conditions

2 cores (Intel Xeon 2.1 GHz), 8 GB RAM, Linux 6.18, Node 22.22.2, PostgreSQL 16.13 on the same machine (fsync on, synchronous commit on, `fdatasync`), engine `yjs`, gateway in static-key mode, snapshots in a file-system object store, loopback network. The generator, the gateway child and PostgreSQL share the two cores. An 8 KB fsync costs p50 75 microseconds and p99 160 microseconds here, which is far faster than a networked production volume, so the ledger append and the whole edit path are optimistic about storage.

### What these numbers do not show

They are not a capacity statement. They say nothing about certificate authentication, a network between the gateway and its database, several documents at once, a 30-minute partition, a day of runtime, or browser rendering.

## Tickets from this run

Every `missed` and `not measured` result, and every caveat that limits a `met`, is a ticket. They are triaged before week 11 starts.

| Id | Priority | Finding | What to do |
| --- | --- | --- | --- |
| L1 | high | **Fixed** (`docs/specs/large-sync.md`). `decodeFrame` capped a payload at 1 MiB and `GatewayClient` and the SDK swallowed the error, so no stock client could open a document whose state exceeded 1 MiB. Clients now decode what the gateway sends with a 64 MiB cap (`maxInboundBytes`, default and maximum), and a dropped frame is counted (`decodeErrors`, `lastDecodeError`, `onDecodeError`) instead of silent. `frame.ts` is unchanged | Done. Cold load rerun above |
| L7 | medium | The gateway still sends a SYNC_2 larger than 64 MiB that no client will accept, and a client that sets a smaller cap sees it dropped and retries | A gateway-side ERROR naming the limit instead of sending the frame, in `gateway.ts` (protected: 24-hour review); decide whether 64 MiB is the right bound or SYNC_2 should be chunked (wire change) |
| L8 | medium | Memory and time of opening a 10 MB to 64 MiB document in a real browser (frame buffered, then decoded, then applied) were not measured; the cold-load numbers are Node to Node | Measure in the Playwright browser test with a large document |
| L2 | medium | Single box, loopback, very fast disk, no authentication in the numbers | Repeat on production-class storage and network with certificate auth, in a cluster |
| L3 | medium | Memory growth varies between identical runs (34.9 to 46.5 MB), close to the 50 MB limit | Repeat at least five times, decide the metric (RSS or heap), measure several documents in one process |
| L4 | medium | The storm used a 10 s partition and 5 offline edits per client, not 30 minutes; recovery (about 29 s) is dominated by the client back-off cap of 30 s; certificate expiry and grace after a long partition were not exercised | Run a long partition with a large backlog and expiring certificates; review the back-off cap against the 60 s target |
| L5 | medium | In the storm the generator's own loop p99 is 19 to 21 ms (above the 10 ms rule), so live-edit latencies during the storm are upper bounds | Move the storm clients to a separate process or worker thread and rerun |
| L6 | low | Trace overhead at 1% and 100% sampling is not measured; the k6 script has never been executed | Run the edit-latency scenario with tracing on; run k6 against a real deployment |

## Mutation checks (10c)

The statistics, verdicts, latency timestamps, warm-up trimming, lost-edit failure, proxy partition, scrape parsing, memory difference and the cold-load and storm checks were mutated (`mutate10c`). Seventeen survivors were closed with tests (test-only hooks `drainMs`, `afterFill` and `afterHeal`; `gatewayLatencies` and `memoryGrowth` made pure; the result fields `roomLoads`, `loadedFrom`, `docChars` and `server.persisted`). One equivalent mutant remains: skipping the wait for the cold snapshot. It is harmless because eviction snapshots a dirty room anyway, and `loadedFrom.replayed` would show a replay.

# Spec: metrics and traces (Phase 1, week 10a)

**Purpose.** An operator should be able to answer "is it healthy, is it keeping up, is the evidence log protected" from a Prometheus scrape, and a developer should be able to follow one edit through the gateway when something is slow. This spec covers the telemetry package, what the gateway and control plane report, the endpoint, and the rules that keep telemetry from becoming a leak or a new way to fail. Dashboards, alert rules and chart wiring are 10b; load numbers are 10c.

Non-goals: logs (the structured `log` callback stays as is), per-document or per-user metrics, branch metrics (week 11, with branches), a metrics store, an OpenTelemetry Collector.

## Rules

1. **Observer only.** Telemetry never changes what the gateway or control plane does. Every call into it is wrapped so that an exception is swallowed; a broken exporter, a throwing instrument or a full scrape queue cannot reject an edit, delay an acknowledgement beyond the cost of one function call, or crash a process. A test injects a meter and tracer that throw on every call and runs the normal edit path.
2. **Nothing sensitive.** No document content, no payload bytes, no key, key id, certificate serial, token, email or principal id, and no document id, appears in a metric name, label value, span name or span attribute. Labels come from closed sets written in code; a value outside its set is reported as `other`, so a hostile client cannot create series. Span attributes pass through an allowlist (`omnisync.update.bytes`, `omnisync.outcome`, `omnisync.batch`, `omnisync.checkpoint.n`, `omnisync.checkpoint.documents`); anything else is dropped.
3. **Off unless asked, and cheap when off.** Without `OMNISYNC_METRICS_PORT` no listener opens and the SDK is never loaded: instruments come from the OpenTelemetry API's no-op meter. Traces are off unless `OMNISYNC_TRACES_ENABLED=1`.
4. **Separate port.** `/metrics` is served on its own port, never on the application port, so an ingress can never route to it. It binds `127.0.0.1` unless `OMNISYNC_METRICS_HOST` says otherwise (the chart sets `0.0.0.0` and a network policy admits only the Prometheus namespace). The port must differ from `PORT`; equal values refuse to start. Any path other than `/metrics` answers 404.
5. **Bounded.** Series count does not grow with traffic: no label takes more than 12 values, none is derived from client input without the closed-set mapping above.

## Configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `OMNISYNC_METRICS_PORT` | Port for `/metrics` (1024-65535). Unset: no endpoint. | unset |
| `OMNISYNC_METRICS_HOST` | Bind address for it. | `127.0.0.1` |
| `OMNISYNC_TRACES_ENABLED` | `1` turns tracing on, `0` is an explicit off. Anything else (including `true`) is a refusal to start, so a typo cannot silently mean "off". | off |
| `OMNISYNC_TRACE_SAMPLE_RATIO` | Fraction of edits traced, 0 to 1. | `0.01` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Where spans go (OTLP/HTTP). Required when traces are on; a URL with `http:` or `https:`. | none |

Invalid values refuse to start with a message naming the variable, like every other setting. Credentials for an OTLP endpoint are the SDK's standard `OTEL_EXPORTER_OTLP_HEADERS`; they are never logged.

## Gateway metrics

Histogram buckets (seconds): 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `omnisync_update_apply_seconds` | histogram | `outcome` = ok, rejected | Frame arrival to the point the sender is acknowledged or refused (verify, queue, ledger append, apply) |
| `omnisync_ledger_append_seconds` | histogram | `outcome` = ok, error | One group-commit call to the store |
| `omnisync_fanout_seconds` | histogram | none | Relaying one accepted edit to its peers |
| `omnisync_append_queue_depth` | gauge | none | Verified updates waiting for the store, all documents |
| `omnisync_connections_active` | gauge | none | Open WebSocket connections |
| `omnisync_documents_active` | gauge | none | Documents resident in memory |
| `omnisync_connections_total` | counter | `outcome` = ok, failed | Authentication results |
| `omnisync_signature_failures_total` | counter | `reason` = unknown_key, bad_signature, not_update | Updates refused by signature verification. An undecodable frame is `malformed` under admission rejections |
| `omnisync_admission_rejections_total` | counter | `reason` = rate_limited, busy, forbidden, upload_only, malformed, claimed_time, store_error, other | Frames and updates refused: by the rate limit, the catch-up limit, a role, a malformed frame, an edit time outside the certificate's life, a store failure (`unavailable`, `internal`), or anything else. Signature failures are counted under their own name, not here |
| `omnisync_updates_total` | counter | `outcome` = persisted, duplicate | Updates made durable |
| `omnisync_checkpoint_age_seconds` | gauge | none | Seconds since the checkpoint writer last knew everything acknowledged was covered by an uploaded checkpoint |
| `omnisync_checkpoints_total` | counter | none | Checkpoints uploaded |
| `omnisync_checkpoint_failures_total` | counter | `kind` = sign, store, upload, conflict | Failed checkpoint steps. `conflict` means different bytes already exist under a number and needs a person |
| `omnisync_snapshot_failures_total` | counter | none | Failed document snapshots |
| `omnisync_store_degraded` | gauge | none | 1 while the last store call failed |

The gauges and the totals that already exist as counters in `stats` are read at scrape time (observable instruments); only the four timings and the signature counter are recorded on the edit path. Scraping reads memory and does not query the database.

`omnisync_checkpoint_age_seconds` is the one number an auditor-facing alert needs, so its definition is exact. The writer records `stats.lastCaughtUpAtMs` whenever a pass finds nothing pending and nothing awaiting upload, or finishes writing and uploading everything it found. The gauge is `now - lastCaughtUpAtMs`, starting at process start. With the default five-minute trigger it normally stays under about five minutes plus one poll; above 15 minutes the writer is stuck, failing or the bucket is unreachable.

## Control plane metrics

All are derived in one Fastify `onResponse` hook, so no controller changes.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `omnisync_http_request_seconds` | histogram | `route` (the route template, or `unmatched`), `method`, `status_class` (2xx, 3xx, 4xx, 5xx) | Request time |
| `omnisync_logins_total` | counter | `outcome` = ok, failed | Results of the OIDC callback route |
| `omnisync_certificates_issued_total` | counter | none | Successful `POST /v1/certificates` |
| `omnisync_rate_limited_total` | counter | `route` | 429 responses |

`route` is Fastify's route template (`/v1/documents/:id/grants`), never the URL, so identifiers and query strings cannot enter a label. Methods outside GET, POST, PUT, DELETE, OPTIONS, HEAD report as `other`.

## Traces

One root span `omnisync.edit` per received UPDATE with children `verify`, `append` (queue wait plus store call) and `fanout`, so a slow edit shows which stage. Checkpoint writing has its own root span `omnisync.checkpoint` (reserve, upload), because it is not part of any one edit. Sampling is parent-based with a ratio; an unsampled edit costs a no-op span object. Span status is set to error only for server-side failures (store unavailable, internal), not for refusals of bad input.

## Edit points (protected paths)

Passive additions only; control flow is unchanged. `apps/gateway/src/gateway.ts` (timers around verify, accepted and relay; no change to authorization, handshake or replay checks), `room.ts` (a timer around `appendUpdates`, a `pendingCount` getter; no change to the write path, snapshot cut or cold load), `checkpoint.ts` (one stats field, `behindMs()`, one span per checkpoint; the loop body is re-indented inside a `try`/`finally` that ends the span, so review it with `git diff -w`), `serve.ts` (start and stop of telemetry), control plane `app.ts` and `main.ts` (the hook and setup). Existing behaviour tests must pass unchanged.

## Tests

- Names, types, labels and bucket boundaries of every metric above, read from a real scrape of the Prometheus endpoint.
- Counters move on the matching event: bad signature, rate limit, busy, forbidden, authenticated and failed connections, duplicate and persisted updates, checkpoint success and each failure kind, control plane success, failure, 429 and certificate issue.
- Gauges: connections and documents rise and fall; queue depth is non-zero while the store is held and zero after; checkpoint age grows with an injected clock and resets when caught up.
- Rule 1: throwing meter and tracer, edit path still acknowledged; a scrape that fails to bind does not stop the gateway from serving, and says so in the log.
- Rule 2: after a run with a hostile client (random reasons, huge route-like strings, ids in URLs), no series label outside its closed set, no series count above the bound, and the scrape text contains none of the document id, principal id, key hex or token used in the run.
- Rule 3/4: no listener without the port; equal ports, bad ports and bad switches refuse; `/metrics` on the metrics port only, 404 elsewhere, and the application port answers 404 for `/metrics`.
- Traces: with an in-memory exporter, one edit yields the expected tree; attributes are within the allowlist; ratio 0 yields none.
- Mutation checks on: the label closed sets, the `other` fallback, the attribute allowlist, the port refusal, the exact-`1` switch, the age formula, and the swallow wrapper.

## New dependencies (and why)

`@opentelemetry/api` (the vendor-neutral instrument interface, no-op by default, so instrumented code costs nothing when disabled), `@opentelemetry/sdk-metrics` and `@opentelemetry/exporter-prometheus` (the Prometheus text endpoint; writing our own would mean hand-rolling histogram exposition), `@opentelemetry/sdk-trace-base` and `@opentelemetry/exporter-trace-otlp-http` (sampling and OTLP export), `@opentelemetry/resources` (service name on exported data). All are Apache-2.0 and maintained by the OpenTelemetry project. The SDK and exporters are loaded by dynamic import only when enabled.

## Test support

`@omnisync/telemetry/testing` exports `testMeter()` (a real SDK meter read back as the exact Prometheus text a scrape returns), `testTracer()` (finished spans in memory) and `sample()` / `series()` helpers. Nothing outside tests imports it.

## Mutation checks (10a)

About 110 mutations of the telemetry package, the gateway, room, checkpoint writer and control-plane hook; the first run left 31 alive, each closed by a test (negative, NaN and zero durations, repeated `observe`, a rejection bucket named `busy`, the claimed-time and store-error groupings, login and certificate routes by method and status, 429 only, informational statuses, span end-once rules, stage names from the closed set, credentials in the OTLP URL, the degraded gauge and its recovery, duplicate outcome, verify ending before append, in-flight queue depth, clock stepping backwards, upload conflict outcome, seconds not milliseconds). Three remain by design and are equivalent: the sample-ratio regex and its range check each make the other redundant, and `true` as the traces switch is already refused by the check before it.

## Known limits

Metrics are per process: the gateway runs one replica, so there is no aggregation question yet. A scrape every 15 seconds loses the shape of a spike shorter than that; the histograms keep it. Control plane login and certificate counts are HTTP-level, so a request that fails after the response status is chosen is not distinguishable. Nothing here has been scraped by a real Prometheus; the format is the exporter's, tested as text.

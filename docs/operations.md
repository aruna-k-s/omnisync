# Operating OmniSync: metrics, dashboard, alerts and traces

This guide is for the person who is on call for an OmniSync install. It says what to look at, what each alert means, what to check first, and what not to do. Install is `install.md`; what the numbers are and why they are safe is `specs/observability.md`.

## Turning it on

Telemetry is off in a default install. In the chart:

```yaml
monitoring:
  enabled: true
  scrape:
    namespaceLabels:
      kubernetes.io/metadata.name: monitoring   # the namespace your Prometheus runs in
  serviceMonitor: { enabled: true, labels: { release: kube-prometheus-stack } }
  prometheusRule: { enabled: true, labels: { release: kube-prometheus-stack } }
  dashboard: { enabled: true }
```

This opens a `metrics` port (9464 unless you change it) on the gateway and the control plane, adds it to their Services, and admits only the namespace you name to it. The metrics port is never served by the ingress, and `/metrics` answers 404 on the application port. Without the Prometheus Operator, scrape the two Services' `metrics` port yourself and load `deploy/helm/omnisync/files/omnisync-dashboard.json` and the rules from `helm template ... --set monitoring.prometheusRule.enabled=true` by hand.

The thresholds are values under `monitoring.prometheusRule.alerts`. Two alerts exist only when you give them a number: connections near the limit needs `licensedConnections` (OmniSync does not enforce a limit; this is the warning), and replica lag needs `postgresReplicaLagSeconds` and a PostgreSQL exporter that publishes a lag metric.

## The dashboard

`OmniSync overview` has four rows: Health (are we up, degraded, caught up), Edit path (apply time, queue, fan-out, refusals), Evidence log (ledger writes, checkpoints, failures) and Control plane (requests, logins, certificates, 429s). The file is generated; do not edit the JSON by hand. To change it, edit `deploy/monitoring/dashboard.py` and run `python3 deploy/monitoring/dashboard.py --write`; CI runs it with `--check` and fails if the committed file is stale.

## Alerts

Every alert carries a `runbook_url` that lands on the matching heading below.

### Checkpoint age

**Alert `OmniSyncCheckpointStale` (critical).** The newest signed checkpoint in the evidence bucket is more than 15 minutes behind what has been acknowledged to editors, for 5 minutes. The ledger itself is intact and still hash-chained; what is missing is the independent witness copy, so for this period an operator with database access could rewrite history without a checkpoint to contradict it. Normal is under about five minutes plus one poll.

Check, in this order: the gateway log for `checkpoint_sign_failed` (the ledger key is unreadable), `checkpoint_store_failed` (the database), `checkpoint_upload_failed` (the bucket or its credential) and `checkpoint_upload_conflict` (different bytes already exist under a number); the same four are the `kind` label of `omnisync_checkpoint_failures_total`; whether the bucket credential has expired or lost `PutObject`; whether the gateway has restarted (the age starts at process start and is expected to reach zero within a minute of a healthy start).

Do not: delete or overwrite anything in the checkpoint bucket, give the checkpoint credential delete permission to "make it work", or restart the gateway repeatedly. A `conflict` needs a person to look at both objects; it means two different checkpoints claimed the same number, which is exactly what the ledger exists to expose. Keep both and escalate.

### Signature failures

**Alert `OmniSyncSignatureFailures` (warning).** More than 0.2 updates per second have been refused for their signature for 5 minutes. The `reason` label says which: `unknown_key` (a device whose certificate is not trusted: expired, revoked, issued by a different issuer, or a client from another install), `bad_signature` (the bytes do not match; a client bug or tampering) and `not_update` (wrong frame type).

Check the split by `reason`. A burst of `unknown_key` after a rollout usually means the issuer key or the trust list changed; compare the issuer public key the installer printed with the one in the install's configuration. `bad_signature` from many devices at once points at a client release; from one connection it is a probe. Nothing in the metrics names a device, user or document by design, so go to the gateway log for the connection.

Do not: loosen verification, raise the rate limit to make the number go down, or re-issue every certificate before you know which kind it is.

### Ledger append latency

**Alert `OmniSyncLedgerAppendSlow` (warning).** The 99th percentile of one write to the update log has been above 0.1 seconds for 10 minutes. Edits are acknowledged only after they are durable, so this is felt directly as typing lag and as a growing `omnisync_append_queue_depth`.

Check the database first: CPU and IOPS, connection count, long-running transactions, a vacuum or a backup competing for the disk, replication to a synchronous standby that has stalled. Then `omnisync_store_degraded`: 1 means the last call failed outright, which is a different problem (the database is unreachable). Edits are not lost while this is slow; they are held, and clients will show them as not yet saved.

Do not: turn off synchronous commit or point the gateway at a faster but non-durable store; the acknowledgement is a promise.

### Connections near the limit

**Alert `OmniSyncConnectionsNearLimit` (warning, only if `licensedConnections` is set).** Open connections have been above the configured share (default 80%) of your contractual limit for 5 minutes. OmniSync does not enforce the limit; the alert is the warning so that the conversation with us happens before an audit does.

Check whether the number is real (a client reconnect loop inflates it; compare `omnisync_connections_total` by outcome and the rate of new connections) and whether it is a lasting rise or a daily peak. Contact your account owner if it is lasting.

Do not: drop connections to get under the line. Editors reconnect and the number comes back.

### PostgreSQL replica lag

**Alert `OmniSyncPostgresReplicaLag` (warning, only if `postgresReplicaLagSeconds` is set).** The replica has been behind by more than the configured seconds for 5 minutes. A failover now would lose the acknowledged edits the replica has not received, and the ledger would then be shorter than what some clients, and possibly an uploaded checkpoint, have already seen.

This metric is not produced by OmniSync. It comes from your PostgreSQL exporter (`pg_replication_lag_seconds` from postgres_exporter by default; set `postgresReplicaLagMetric` for another name, for example `cnpg_pg_replication_lag` on CloudNativePG). If the metric does not exist the alert never fires; confirm it by querying the metric once.

Check the replica's network, disk and replay settings. Do not promote a lagging replica unless the primary is gone and you have decided to accept the loss.

### Metrics missing

**Alert `OmniSyncMetricsMissing` (warning).** Prometheus has had no `omnisync_connections_active` for 10 minutes. Until this clears, none of the other alerts can fire. Either the gateway is down (that has its own symptoms: the Kubernetes events, `kubectl get pods`) or the scrape is broken: the ServiceMonitor labels do not match what your Prometheus selects, the NetworkPolicy does not admit your Prometheus namespace, or the port was changed on one side.

Check the Prometheus Targets page for the two OmniSync targets and its error, then `kubectl -n <ns> get networkpolicy` for the policy named `<release>-from-prometheus` and its namespace labels.

## What these alerts cannot tell you

- **They are silent when the data is absent.** Only the meta alert above covers that, and it covers the gateway only.
- **The expressions were parsed and checked against the metric catalogue in CI, not evaluated against data.** CI proves the names, labels and functions are right; it does not prove the thresholds suit your load. Treat the defaults as a starting point and watch the first two weeks.
- **Nothing here has been scraped by a real Prometheus or loaded into a real Grafana.** The first install is the proof.
- **The replica-lag metric is external.** The alert is only as good as your exporter.
- **Metrics are per process.** The gateway runs one replica, so there is nothing to aggregate yet.

## Traces

Spans follow one edit through verify, append and fan-out, and a checkpoint through reserve and upload. They are off by default and cost nothing when off. To turn them on:

```yaml
monitoring:
  tracing:
    enabled: true
    endpoint: https://otel-collector.observability.svc:4318
    sampleRatio: 0.01
    egress: { cidrs: [10.40.0.0/24], port: 4318 }
```

Credentials for the collector go in the install's Secret under the key `otlp-headers` (the SDK's `OTEL_EXPORTER_OTLP_HEADERS` format); they never appear in the values file or the logs. Only the gateway exports spans, only to the collector range you list, and spans carry byte counts, stage names and outcomes, never document content, identifiers or keys. If a trace is wanted for one slow edit, raise `sampleRatio` for a while and lower it again; at 1 every edit is traced and the collector becomes part of the cost of typing.

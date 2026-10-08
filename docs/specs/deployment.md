# Spec: container images and the Helm chart (Phase 1, week 9b)

**Purpose.** A customer's platform team installs OmniSync on a Kubernetes cluster they own, from files they can read, in about 30 minutes. This spec covers what runs (images), how it is wired (chart), what is locked down (pods, network, secrets), and what is proven here versus what only a real cluster can prove. The release pipeline (signed images, SBOM) and the install runbook are `release.md` (9c).

Non-goals: multi-replica gateway (a document has one writer replica until Phase 4), Redis fan-out, a managed database, an operator, Windows nodes, OpenShift security constraints beyond what "restricted" Pod Security already implies.

## What runs

| Workload | Image target | Port | Replicas | Notes |
| --- | --- | --- | --- | --- |
| `gateway` | `omnisync-gateway` | 8080 (HTTP + WebSocket) | **1**, strategy `Recreate` | One writer per document. `Recreate` stops the old pod (which drains and writes a final checkpoint) before the new one starts. `terminationGracePeriodSeconds: 60` |
| `control-plane` | `omnisync-control-plane` | 8081 | 1 (2 allowed) | Rate limits are per process, so two replicas double the budget; the chart notes it |
| `web` | `omnisync-web` | 8080 | 1 | nginx (unprivileged) serving the console and the reference app from one image; one Deployment per app, chosen by an environment variable; `config.json` comes from a ConfigMap |
| `postgresql` | upstream `postgres:16` | 5432 | 1 | **Evaluation only**, off by default. A real install points at the customer's PostgreSQL |
| `minio` | upstream `minio/minio`, `minio/mc` | 9000 | 1 | Optional. Off when the customer supplies an S3 service. A Job creates the two buckets (versioned; the checkpoint bucket with Object Lock) and the gateway user (the Secret's `s3-access-key-id`) with a policy that has no delete action. The Job is an ordinary resource named with a hash of its inputs, not a Helm hook: a post-install hook runs only after `--wait` has seen every pod ready, and the gateway cannot be ready before the Job has run |

Images are built by `deploy/docker/Dockerfile` (multi-stage, one `target` per image): `pnpm deploy --prod` makes a self-contained directory per app, the runtime stage is `node:22-slim` with `NODE_ENV=production`, runs as UID 10001, has no package manager state and no build tools. The web image builds both Angular apps and copies only their `dist/`. The base image is a build argument (`BASE_IMAGE`) so the release pipeline can pin it by digest; the Dockerfile default is a tag.

## Pod hardening (every OmniSync pod)

`runAsNonRoot: true`, UID/GID 10001, `fsGroup: 10001`, `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`, `automountServiceAccountToken: false` (no OmniSync pod talks to the Kubernetes API), a dedicated ServiceAccount per workload, CPU and memory requests and limits, `/tmp` as a size-limited `emptyDir`. The namespace should enforce Pod Security `restricted`; the chart's pods satisfy it (the optional PostgreSQL and MinIO pods too: both run non-root with a writable data volume). The install script labels the namespace.

## Secrets

The chart never contains a secret value. It references one Kubernetes Secret (`secrets.existingSecret`, default `omnisync-secrets`) with these keys, or creates that Secret through the External Secrets Operator (`secrets.externalSecret.enabled`, with the store name and the remote keys in values):

| Key | Used by | Content |
| --- | --- | --- |
| `issuer-key` | control plane | certificate issuer seed, 64 hex characters, as a file |
| `ledger-key` | gateway | ledger signing seed, 64 hex characters, as a file. Different key from the issuer, enforced at start |
| `session-secret` | control plane | at least 32 random bytes, hex |
| `database-url` | gateway, control plane | `postgres://...` |
| `oidc-client-secret` | control plane | optional (public client) |
| `s3-access-key-id`, `s3-secret-access-key` | gateway | credentials of a principal that **cannot delete** |
| `otlp-headers` | gateway | optional; only read while `monitoring.tracing.enabled`: the SDK's `OTEL_EXPORTER_OTLP_HEADERS` value (for example `authorization=Bearer ...`) for the trace collector |

Files are mounted read-only. The gateway refuses a ledger key file that group or others can read, and Kubernetes gives secret files to the pod's group; so an init container (same non-root user, `umask 077`) copies `ledger-key` into a memory-backed `emptyDir` as a private file, and only the gateway container mounts that copy. Public keys (issuer public key for the gateway's trust, ledger public key for the control plane) are plain values, not secrets.

## Network

Services are `ClusterIP`. A single `Ingress` (class, annotations, TLS secret names in values) exposes four hosts: `hosts.api` (control plane), `hosts.gateway` (WebSocket; long read and send timeouts), `hosts.console`, `hosts.app`. TLS certificates come from cert-manager through the ingress annotation `cert-manager.io/cluster-issuer` (name in values; the chart does not create issuers). **Per-IP throttling** is ingress configuration: default annotations for ingress-nginx (`limit-rps`, `limit-burst-multiplier`, `limit-connections`), overridable for other controllers; the application's own rate limits stay on.

`NetworkPolicy` (on by default): the namespace's OmniSync pods get default-deny ingress and egress, then only:

| From | To | Port |
| --- | --- | --- |
| ingress controller namespace (label selector in values) | gateway, control plane, web | 8080, 8081, 8080 |
| gateway | PostgreSQL (bundled pod, or the CIDRs in values) | 5432 |
| gateway | MinIO (bundled) or the S3 CIDRs in values | 9000 / 443 |
| control plane | PostgreSQL | 5432 |
| control plane | the identity provider (CIDRs in values; default any `:443`) | 443 |
| MinIO setup Job | MinIO | 9000 |
| the Prometheus namespace (`monitoring.scrape.namespaceLabels`; optionally only pods with `podLabels`), only while `monitoring.enabled` | gateway, control plane | `monitoring.port` (9464) |
| gateway, only while `monitoring.tracing.enabled` | the collector CIDRs in `monitoring.tracing.egress` | 4318 |
| all | cluster DNS (kube-system, UDP/TCP 53) | 53 |

Nothing else, including no pod-to-pod traffic between gateway and control plane (they share the database, not a socket) and no web egress.

## Monitoring (week 10b)

Off by default. With `monitoring.enabled` the gateway and control plane get `OMNISYNC_METRICS_PORT` and `OMNISYNC_METRICS_HOST=0.0.0.0`, a `metrics` container port and Service port, and the NetworkPolicy row above; the ingress never routes to it. Optional objects, each behind its own switch: a `ServiceMonitor` (one for both Services), a `PrometheusRule` (six alerts; two only when given a number), a ConfigMap with the Grafana dashboard (`files/omnisync-dashboard.json`, generated by `deploy/monitoring/dashboard.py`), and gateway tracing (`monitoring.tracing`, with collector egress). The switches under `monitoring` do nothing unless `monitoring.enabled` is true. Alert thresholds are numbers checked by `values.schema.json`, and a replica-lag metric name must look like a metric name, so a value cannot inject query text. What each alert means is `docs/operations.md`; the metric names are `specs/observability.md`.

What is proven here: the objects render and validate (kubeconform with the CRD schemas), every alert expression parses and uses only catalogue metrics and labels, `rate()` only on counters, `histogram_quantile()` only on rated buckets that keep `le`, and every dashboard query is held to the same catalogue. What is not: the expressions were never evaluated against data, nothing was scraped by a real Prometheus or loaded into Grafana, and the replica-lag metric belongs to the customer's PostgreSQL exporter.

## Configuration wiring

Chart values map one to one onto the environment documented at the top of `apps/gateway/src/serve.ts` and `apps/control-plane/src/main.ts`. `values.schema.json` (draft 7, and only RE2-compatible patterns: Helm validates with Go's regexp, which has no lookahead) makes `helm install` fail early with a readable message when something required is missing or malformed: the four hosts, `tenant`, `oidc.issuer`, `oidc.clientId`, `adminEmails`, the two public keys, `storage.checkpoint.retainDays` (an integer, **no default**), at least one egress CIDR for an external PostgreSQL or S3 service while network policies are on (an empty list would silently cut the gateway off), image references with a tag or digest and never `:latest`, and exactly one of bundled/external for PostgreSQL and S3. Derived values: `OMNISYNC_RETURN_TO` is the console and app origins; `OMNISYNC_DEVICE_VERIFICATION_URL` is the app origin; `OMNISYNC_ALLOWED_ORIGINS` (gateway) is the same two origins; the OIDC redirect URI is `https://<hosts.api>/v1/auth/callback`; the web `config.json` files point at `https://<hosts.api>` and `wss://<hosts.gateway>`.

Rollout: a `checksum/config` annotation restarts pods when their ConfigMap changes. `helm upgrade` runs no database migration of its own: the gateway and the control plane apply migrations at start (existing behaviour), and a failed migration keeps the pod from becoming ready.

## What is proven where

| Check | Where | Status in this build |
| --- | --- | --- |
| Chart templates render to valid Kubernetes YAML for the minimal, evaluation and production-style values (`deploy/tests/values`) | `deploy/tools/render_chart.py` (a renderer for the Go-template subset the chart restricts itself to) + `kubeconform` with the Kubernetes and cert-manager/External Secrets schemas | `deploy/tests/test_chart.py`, runs here |
| Security rules hold in every rendered pod (non-root, read-only root with the writable paths each program needs, no capabilities, no token, limits, probes, own service account), no Secret object and no secret literal, each seed reaches only the service that needs it, and every row in the network table is present and nothing else | the same tests, on the rendered documents | runs here |
| The schema refuses what the spec says it refuses (no retention default, gateway replicas above 1, malformed keys, external services without egress CIDRs, floating image tags) | the same tests | runs here |
| `helm lint --strict`, `helm template | kubeconform`, and Helm and the renderer produce the same objects (`deploy/tools/compare_manifests.py`) | CI job `deploy` (real Helm) | **not run here**: Helm's download host is blocked in the build environment. CI is the gate |
| The web image's Content-Security-Policy, taken from the rendered nginx configuration, lets the real console and reference app start and render without a violation in Chromium, and blocks an injected script and a foreign image | `deploy/tests/test_web_csp.py` | runs here |
| Dockerfile lints | `hadolint` | runs here |
| The image contents work: the deployed (pruned) gateway and control plane start from a directory containing nothing else, using only the chart's environment variables, and the gateway refuses a group-readable ledger key, a checkpoint bucket without Object Lock, a missing retention period and a ledger key used as an issuer | `deploy/tests/test_deployed_apps.py` runs `pnpm deploy --prod --legacy` as the Dockerfile does and starts both against PostgreSQL and S3 | runs here |
| Images build, scan clean, are signed | CI release workflow (9c) | not run here (no container runtime) |
| An install on a clean cluster in 30 minutes by someone other than the author | the week 9 gate | **open**: needs a cluster and a person |

The renderer is a preflight, not a replacement for Helm: where they could differ (whitespace trimming, scoping of `with` and `range`) the chart avoids the construct, and CI compares nothing against it. If real Helm and the renderer ever disagree, Helm is right and the chart is fixed.

## Failure modes

| Situation | Result |
| --- | --- |
| Required value missing or malformed | `helm install` refuses with the schema message |
| Checkpoint retention not set | refused by the schema (never defaulted) |
| Bucket without Object Lock for checkpoints | gateway refuses to start (`openStorage`); the pod crash-loops with the message; the control plane and web keep running |
| Database down | gateway not ready (`/readyz`), control plane `/healthz` stays up but logins fail; no data loss |
| Secret missing | pod stuck in `CreateContainerConfigError`; named in the event |
| Bundled MinIO setup Job has not run yet | the gateway fails its start check and restarts until the buckets exist (about a minute) |
| Ledger key readable by others | gateway start refused; the init container's copy prevents this by construction |
| Two gateway pods during a rollout | prevented by `Recreate`; if someone sets replicas above 1 the schema refuses (maximum 1) until Phase 4 |
| Ingress controller without the throttling annotations | no per-IP throttling at the edge; application limits still apply; values document the equivalent |

## Known limits

The chart has not been run by Helm or on a cluster in this build; see the table. Single gateway means a restart interrupts editing for the drain period (clients reconnect and replay from their outbox). The bundled PostgreSQL is not backed up, not tuned and not highly available; it exists so the 30-minute install has a database. The bundled MinIO is a single node. Both bundled services are not a deployment.

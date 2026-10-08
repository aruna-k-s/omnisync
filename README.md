# OmniSync

Self-hosted collaboration gateway for regulated teams: every edit is a signed envelope, and AI agents edit only on branches a human merges.

**Status: Phase 1, week 10 (install path built but not yet run on a real cluster; metrics, traces, dashboard and alert rules; load numbers measured on one machine, with open tickets).** What exists today:

| Package | What it does |
| --- | --- |
| `packages/protocol` | Wire frames, varints, Ed25519-signed update envelopes, keyring, frozen test vectors |
| `packages/engine` | One engine interface with Yjs, Automerge and Loro adapters: shared text plus a JSON tree of maps and arrays, property-tested for convergence |
| `packages/crypto` | Short-lived Ed25519 session certificates, AUTH possession proof, enrollment proof, trust anchors |
| `packages/verifier` | `omnisync verify`: checks an export offline (hash chain, signatures, certificates, signed checkpoints, locked-bucket copies). Apache-2.0 |
| `packages/sdk` | Browser and Node SDK: non-extractable device key, durable outbox (IndexedDB), 50-250 ms batching, offline-first documents with reconnect, enrollment helper. Apache-2.0 |
| `packages/sdk-react` | React hooks over the SDK (`useDocument`, `useStatus`, `usePending`) |
| `packages/store` | Append-only update log and identity store (principals, certificates, grants, audit) in PostgreSQL, snapshot metadata, object storage, migrations |
| `packages/telemetry` | Metrics (Prometheus endpoint on its own port) and sampled traces for the gateway and control plane: observer-only, closed label sets, off unless configured |
| `apps/gateway` | WebSocket gateway: authenticates connections with certificates, enforces roles, verifies every update, commits it to the log before ACK, snapshots, cold-loads, evicts idle documents; reconnecting client |
| `apps/control-plane` | NestJS service: OIDC login (JSON or browser redirect), device-code login, certificate issuance, grants, revocation, audit log, admin API (people, documents, grants, audit, ledger trust keys and export) |
| `apps/console` | Angular admin console: people and devices (one-click revoke), documents and grants, audit trail, in-browser ledger verification (labelled "consistent", never "anchored") |
| `apps/reference-app` | Angular shared workbook (tables and text) on the SDK: sign-in, non-extractable device key, live editing, offline edits, read-only mode, and the page where a person approves a command-line sign-in. `pnpm --filter @omnisync/reference-app demo` runs a whole in-memory deployment to show it |
| `apps/cli` | `omnisync-cli login / whoami / logout`: device-code sign-in for terminals and build agents; keeps a device key (private file) and certificate |
| `deploy` | Dockerfile (three images), Helm chart (hardened pods, default-deny network policy, ingress throttling, optional bundled PostgreSQL and MinIO), `install/install.sh`, and the tests and preflight renderer behind them |
| `bench` | Engine spike, signing cost and end-to-end latency, raw results as JSON |

## Quick start

```bash
corepack enable          # pnpm 10
pnpm install
pnpm check               # lint, build, typecheck, test (Postgres suites need OMNISYNC_TEST_DATABASE_URL)
pnpm --filter @omnisync/gateway dev    # two clients editing through the gateway
pnpm bench               # writes bench/results/<timestamp>.json

# a whole deployment in one process (in memory, fake IdP) to click through
pnpm --filter @omnisync/console build && pnpm --filter @omnisync/reference-app build
pnpm --filter @omnisync/reference-app demo     # prints the app and console URLs
```

Gateway design: [docs/specs/gateway-core.md](docs/specs/gateway-core.md). Identity and certificates: [docs/specs/identity.md](docs/specs/identity.md). Ledger, checkpoints and the verifier: [docs/specs/ledger.md](docs/specs/ledger.md). Structured data in the engine: [docs/specs/engine-structured.md](docs/specs/engine-structured.md). SDK and offline mode: [docs/specs/sdk.md](docs/specs/sdk.md). Admin API and browser login: [docs/specs/admin-api.md](docs/specs/admin-api.md). Console: [docs/specs/console.md](docs/specs/console.md). Reference app: [docs/specs/reference-app.md](docs/specs/reference-app.md). Device-code login and the CLI: [docs/specs/device-login.md](docs/specs/device-login.md). S3 storage with Object Lock: [docs/specs/s3-object-store.md](docs/specs/s3-object-store.md). Images and Helm chart: [docs/specs/deployment.md](docs/specs/deployment.md). Signed releases and the installer: [docs/specs/release.md](docs/specs/release.md). Metrics, traces and alerts: [docs/specs/observability.md](docs/specs/observability.md), and what to do when an alert fires: [docs/operations.md](docs/operations.md). Load numbers: [docs/specs/load.md](docs/specs/load.md). **Installing: [docs/install.md](docs/install.md).** Engine decision draft: [docs/decisions/0001-engine-choice.md](docs/decisions/0001-engine-choice.md). Specs live in `docs/specs/`. Working with AI assistants: [AGENTS.md](AGENTS.md).

## License

`packages/protocol`, `packages/verifier` and `packages/sdk` are Apache-2.0 so customers and auditors can verify, and integrators can embed, independently. Everything else is proprietary until decided otherwise.

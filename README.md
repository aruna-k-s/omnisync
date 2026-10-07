# OmniSync

Self-hosted collaboration gateway for regulated teams: every edit is a signed envelope, and AI agents edit only on branches a human merges.

**Status: Phase 1, week 7 (SDK and offline done).** What exists today:

| Package | What it does |
| --- | --- |
| `packages/protocol` | Wire frames, varints, Ed25519-signed update envelopes, keyring, frozen test vectors |
| `packages/engine` | One engine interface with Yjs, Automerge and Loro adapters: shared text plus a JSON tree of maps and arrays, property-tested for convergence |
| `packages/crypto` | Short-lived Ed25519 session certificates, AUTH possession proof, enrollment proof, trust anchors |
| `packages/verifier` | `omnisync verify`: checks an export offline (hash chain, signatures, certificates, signed checkpoints, locked-bucket copies). Apache-2.0 |
| `packages/sdk` | Browser and Node SDK: non-extractable device key, durable outbox (IndexedDB), 50-250 ms batching, offline-first documents with reconnect, enrollment helper. Apache-2.0 |
| `packages/sdk-react` | React hooks over the SDK (`useDocument`, `useStatus`, `usePending`) |
| `packages/store` | Append-only update log and identity store (principals, certificates, grants, audit) in PostgreSQL, snapshot metadata, object storage, migrations |
| `apps/gateway` | WebSocket gateway: authenticates connections with certificates, enforces roles, verifies every update, commits it to the log before ACK, snapshots, cold-loads, evicts idle documents; reconnecting client |
| `apps/control-plane` | NestJS service: OIDC login, certificate issuance, grants, revocation, audit log |
| `bench` | Engine spike, signing cost and end-to-end latency, raw results as JSON |

## Quick start

```bash
corepack enable          # pnpm 10
pnpm install
pnpm check               # lint, build, typecheck, test (Postgres suites need OMNISYNC_TEST_DATABASE_URL)
pnpm --filter @omnisync/gateway dev    # two clients editing through the gateway
pnpm bench               # writes bench/results/<timestamp>.json
```

Gateway design: [docs/specs/gateway-core.md](docs/specs/gateway-core.md). Identity and certificates: [docs/specs/identity.md](docs/specs/identity.md). Ledger, checkpoints and the verifier: [docs/specs/ledger.md](docs/specs/ledger.md). Structured data in the engine: [docs/specs/engine-structured.md](docs/specs/engine-structured.md). SDK and offline mode: [docs/specs/sdk.md](docs/specs/sdk.md). Engine decision draft: [docs/decisions/0001-engine-choice.md](docs/decisions/0001-engine-choice.md). Specs live in `docs/specs/`. Working with AI assistants: [AGENTS.md](AGENTS.md).

## License

`packages/protocol`, `packages/verifier` and `packages/sdk` are Apache-2.0 so customers and auditors can verify, and integrators can embed, independently. Everything else is proprietary until decided otherwise.

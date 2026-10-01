# OmniSync

Self-hosted collaboration gateway for regulated teams: every edit is a signed envelope, and AI agents edit only on branches a human merges.

**Status: Phase 1, week 4 (gateway core).** What exists today:

| Package | What it does |
| --- | --- |
| `packages/protocol` | Wire frames, varints, Ed25519-signed update envelopes, keyring, frozen test vectors |
| `packages/engine` | One engine interface with Yjs, Automerge and Loro adapters, property-tested for convergence |
| `packages/store` | Append-only update log in PostgreSQL, snapshot metadata, object storage, migrations |
| `apps/gateway` | WebSocket gateway: verifies every update, commits it to the log before ACK, snapshots, cold-loads, evicts idle documents; reconnecting client |
| `bench` | Engine spike, signing cost and end-to-end latency, raw results as JSON |

## Quick start

```bash
corepack enable          # pnpm 10
pnpm install
pnpm check               # lint, build, typecheck, test (Postgres suites need OMNISYNC_TEST_DATABASE_URL)
pnpm --filter @omnisync/gateway dev    # two clients editing through the gateway
pnpm bench               # writes bench/results/<timestamp>.json
```

Gateway design: [docs/specs/gateway-core.md](docs/specs/gateway-core.md). Engine decision draft: [docs/decisions/0001-engine-choice.md](docs/decisions/0001-engine-choice.md). Specs live in `docs/specs/`. Working with AI assistants: [AGENTS.md](AGENTS.md).

## License

`packages/protocol` is Apache-2.0 so customers and auditors can verify independently. Everything else is proprietary until decided otherwise.

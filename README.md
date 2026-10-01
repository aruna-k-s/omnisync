# OmniSync

Self-hosted collaboration gateway for regulated teams: every edit is a signed envelope, and AI agents edit only on branches a human merges.

**Status: Phase 0 (validate and spike).** What exists today:

| Package | What it does |
| --- | --- |
| `packages/protocol` | Wire frames, varints, Ed25519-signed update envelopes, keyring, frozen test vectors |
| `packages/engine` | One engine interface with Yjs, Automerge and Loro adapters, property-tested for convergence |
| `apps/gateway` | WebSocket gateway prototype: verifies every update, rejects replays and unsigned state, relays to peers |
| `bench` | Engine spike, signing cost and end-to-end latency, raw results as JSON |

## Quick start

```bash
corepack enable          # pnpm 10
pnpm install
pnpm check               # lint, build, typecheck, test
pnpm --filter @omnisync/gateway dev    # two clients editing through the gateway
pnpm bench               # writes bench/results/<timestamp>.json
```

Engine decision draft: [docs/decisions/0001-engine-choice.md](docs/decisions/0001-engine-choice.md). Specs live in `docs/specs/`. Working with AI assistants: [AGENTS.md](AGENTS.md).

## License

`packages/protocol` is Apache-2.0 so customers and auditors can verify independently. Everything else is proprietary until decided otherwise.

# AGENTS.md

Shared instructions for every AI coding assistant working in this repo (Claude Code reads it through `CLAUDE.md`).

## What this is

OmniSync Enterprise: a self-hosted collaboration gateway for regulated companies. Every edit is a signed envelope, every accepted edit is verifiable, and AI agents edit only on shadow branches that a human merges. Product spec and build plan: the "OmniSync Enterprise - Final Product Specification and Build Plan (v4)" doc.

Current phase: **Phase 1 - MVP, week 5 done (identity)**. Phase 0 exit gate (design-partner commitment, engine chosen) is the founder's call: see `docs/decisions/0001-engine-choice.md`. Next: week 6 (documents, tenancy, binary doc ids, engine structured types). Phase-by-phase plan and decision register D1-D11: the OmniSync project Doc and `docs/specs/identity.md` for what week 5 fixed.

## Commands

| Task | Command |
| --- | --- |
| Install | `pnpm install` |
| Everything CI runs | `pnpm check` |
| Build | `pnpm build` |
| Test all | `pnpm test` |
| Test one package | `pnpm --filter @omnisync/protocol test` |
| Tests with PostgreSQL | `OMNISYNC_TEST_DATABASE_URL=postgres://user@localhost/omnisync_test pnpm test` (Postgres suites are skipped without it; CI always sets it) |
| Lint | `pnpm lint` |
| Typecheck | `pnpm typecheck` |
| Benchmark | `pnpm bench` (env: `BENCH_OPS`, `BENCH_EDITORS`, `BENCH_ENGINES`) |
| Gateway demo | `pnpm --filter @omnisync/gateway dev` |
| Run gateway / control plane | `pnpm --filter @omnisync/gateway serve` / `pnpm --filter @omnisync/control-plane start` (config via env, see `apps/control-plane/src/config.ts`) |
| Regenerate protocol vectors | `pnpm --filter @omnisync/protocol vectors` (wire-format break: bump `PROTOCOL_VERSION`) |

Node 22.12+, pnpm 10.

## Layout

```
apps/gateway/        gateway (AUTH handshake, roles, revocation polling, rate limits, persist-before-ACK, group commit, snapshots, cold load, eviction) + reconnecting Node client
apps/control-plane/  NestJS 12 + Fastify: OIDC login (PKCE), session JWT, certificate issuance, grants, revocation, audit. Tests use a SWC plugin for decorators and a fake IdP (jose)
packages/crypto/     Ed25519 session certificates, AUTH possession proof, enrollment proof, trust anchors
packages/protocol/   frames, varints, signed envelopes, keyring, test vectors (Apache-2.0)
packages/engine/     engine interface + Yjs, Automerge, Loro adapters
packages/store/      update log, identity store (principals, certificates, grants, audit), snapshot metadata (PostgreSQL + in-memory), object storage (filesystem + memory), SQL migrations, fault injection (`@omnisync/store/testing`)
packages/config/     shared tsconfig
bench/               benchmark harness; raw results in bench/results/
docs/specs/          one spec per feature, written before code
docs/decisions/      architecture decision records
```

Planned (Phase 1): `apps/console`, `apps/reference-app`, `packages/sdk`, `packages/sdk-react`, `packages/agent-sdk`, `packages/verifier`, `deploy/`.

## Conventions

- TypeScript strict everywhere, ESM, `.js` suffix on relative imports.
- Spec first: `docs/specs/<feature>.md` (inputs, outputs, invariants, failure modes) before code.
- Invariants are property-based tests with fast-check: convergence, envelope round-trips, tamper detection, replay rejection.
- Diffs under about 300 lines, one pull request each. CI must be green.
- Hostile input never throws past a boundary: decoders return typed errors, the gateway counts and drops.
- Updates and state vectors are opaque bytes above `packages/engine`. Nothing else imports `yjs`, `@automerge/automerge` or `loro-crdt` directly, except the gateway's Node test client via the engine package.

## Protected paths

Changes here are never merged on AI review alone. Ask before editing, and the human reviews after a 24-hour gap:

- `packages/protocol/src/signing.ts`, `packages/protocol/src/frame.ts`, `packages/protocol/test/vectors.json` (wire format is v2: frames carry sessionId, seq, claimedAtMs and a cert-bound signature)
- `packages/crypto/**`, `packages/verifier/**`, any ledger code (Phase 1)
- Gateway authorization, handshake and replay checks in `apps/gateway/src/gateway.ts`
- `apps/control-plane/src/{service,tokens,oidc,session}.ts`: login, certificate issuance and revocation
- Durability logic in `apps/gateway/src/room.ts` (write path, snapshot cut, cold load)
- `packages/store/migrations/**` and `packages/store/src/pg.ts`: the append-only log. Never edit an applied migration; add a new one

## Never do

- Never invent cryptography. Ed25519 via node:crypto or `@noble/ed25519`, hashes via `@noble/hashes`, nothing hand-rolled.
- Never log secrets, secret keys, tokens or document payloads.
- Never disable certificate or signature verification, even in tests; use test keys instead.
- Never issue a certificate longer than 24h (default 12h) or without an enrollment proof of key possession.
- Never skip the `email_verified` check or the login CSRF cookie binding in the OIDC flow.
- Never accept unsigned state from a client into a document (no client-sent SYNC_2).
- Never ACK, apply or relay an update before `appendUpdates` has committed it.
- Never update or delete rows in `document_updates` (a trigger enforces it); snapshots are a cache, the log is the truth.
- Never edit an already-applied SQL migration.
- Never change `vectors.json` without bumping the protocol version.
- Never add a dependency without saying why in the pull request.

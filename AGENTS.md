# AGENTS.md

Shared instructions for every AI coding assistant working in this repo (Claude Code reads it through `CLAUDE.md`).

## What this is

OmniSync Enterprise: a self-hosted collaboration gateway for regulated companies. Every edit is a signed envelope, every accepted edit is verifiable, and AI agents edit only on shadow branches that a human merges. Product spec and build plan: the "OmniSync Enterprise - Final Product Specification and Build Plan (v4)" doc.

Current phase: **Phase 1 - MVP, week 10 built (metrics, traces, dashboard, alerts, load numbers); the real-cluster install, the first signed release and the open load tickets in `docs/specs/load.md` (L1, clients opening documents over 1 MiB, is fixed; L2-L8 remain) are still open**. Phase 0 exit gate (design-partner commitment, engine chosen) is the founder's call: see `docs/decisions/0001-engine-choice.md`. Next: week 11 (see the plan): agents and shadow branches; a draft spec and failing tests wait for review on the branch `week11-shadow-branch` (`docs/specs/shadow-branch.md`, decisions D12-D14). Phase-by-phase plan and decision register D1-D11: the OmniSync project Doc. Specs for what is built: `docs/specs/identity.md` (week 5), `docs/specs/ledger.md` (week 6), `docs/specs/engine-structured.md` and `docs/specs/sdk.md` (week 7), `docs/specs/admin-api.md`, `docs/specs/console.md`, `docs/specs/reference-app.md` and `docs/specs/device-login.md` (week 8), `docs/specs/s3-object-store.md` (week 9a), `docs/specs/deployment.md` (week 9b: images and Helm chart), `docs/specs/release.md` and `docs/install.md` (week 9c: signed releases, installer, runbook), `docs/specs/observability.md` and `docs/operations.md` (week 10a/10b: metrics, traces, dashboard, alert rules, what to do when one fires), `docs/specs/load.md` (week 10c: load harness, measured numbers, tickets), `docs/specs/large-sync.md` (ticket L1: clients open documents over 1 MiB).

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
| Export the ledger | `DATABASE_URL=... OMNISYNC_TENANT=acme pnpm --filter @omnisync/gateway export ledger.ndjson` |
| Verify an export (no database) | `node packages/verifier/dist/cli.js verify ledger.ndjson --issuer <hex> --ledger-key <hex> --tenant acme --locked dir` (exit 0 anchored, 1 violations, 2 bad input, 3 consistent but not anchored) |
| Browser test (two real Chromium contexts) | `pnpm --filter @omnisync/sdk test` (needs Chromium: set `PLAYWRIGHT_BROWSERS_PATH`; without it the test is skipped unless `OMNISYNC_REQUIRE_BROWSER=1`, which CI sets) |
| Build the web apps | `pnpm --filter @omnisync/console build` and `pnpm --filter @omnisync/reference-app build` (Angular 21; `ng build`, output in each app's `dist/`) |
| Browser tests for the apps and the CLI | `pnpm --filter @omnisync/console test`, `... reference-app test`, `... cli test` (need Chromium via `PLAYWRIGHT_BROWSERS_PATH` and fresh builds of the apps and of `@omnisync/cli`; `OMNISYNC_REQUIRE_BROWSER=1` makes a missing browser or build fail instead of skip, CI sets it) |
| Demo deployment (in memory, fake IdP) | `pnpm --filter @omnisync/reference-app demo` after building both apps; `/demo/as?u=alice|bob|carol|admin` picks who signs in next |
| Command-line client | `node apps/cli/dist/main.js login --server <url>` (`whoami`, `logout`); state in `$OMNISYNC_HOME` or `~/.omnisync` |
| S3 and Object Lock tests | start an S3-compatible server (CI uses `pip install 'moto[server]'; moto_server -p 54330`) and set `OMNISYNC_TEST_S3_ENDPOINT=http://127.0.0.1:54330`; the suites are skipped without it unless `OMNISYNC_REQUIRE_S3=1` (CI sets it) |
| Chart, images and install-path checks | `pnpm test:deploy` (Python: `pip install pyyaml jsonschema boto3 playwright`; renders `deploy/helm/omnisync` with `deploy/tools/render_chart.py`, runs kubeconform, the pruned-app start test and the web CSP test in Chromium; each skips when its tool or service is missing unless `OMNISYNC_REQUIRE_KUBECONFORM` / `OMNISYNC_REQUIRE_DEPLOYED` / `OMNISYNC_REQUIRE_BROWSER` is `1`, CI sets them and runs real `helm lint` and `helm template` too) |
| Regenerate protocol vectors | `pnpm --filter @omnisync/protocol vectors` (wire-format break: bump `PROTOCOL_VERSION`) |

Node 22.12+, pnpm 10.

## Layout

```
apps/gateway/        gateway (AUTH handshake, roles, revocation polling, rate limits, persist-before-ACK, group commit, snapshots, cold load, eviction, checkpoint writer, ledger export) + reconnecting Node client
apps/control-plane/  NestJS 12 + Fastify: OIDC login (PKCE; JSON or `return_to` redirect), device-code login, session JWT, certificate issuance, grants, revocation, audit, admin API (`/v1/admin/**`), CORS for the `returnTo` origins. Tests use a SWC plugin for decorators and a fake IdP (jose); `test/stack.ts` is the whole-stack harness the browser tests share
apps/console/        Angular 21 admin console (people, documents, grants, audit, in-browser ledger verification). Admin API only, no state of its own
apps/reference-app/  Angular 21 shared workbook on the SDK, the device-approval page, and `demo/serve.ts` (in-memory demonstration deployment)
apps/cli/            `omnisync-cli`: device-code login, device key in a private file, `whoami`, `logout`
packages/crypto/     Ed25519 session certificates, AUTH possession proof, enrollment proof, trust anchors, ledger entry hash, signed checkpoints
packages/verifier/   offline ledger verifier and the `omnisync` command (Apache-2.0). Reads an export and public keys, never a database
packages/protocol/   frames, varints, signed envelopes, keyring, test vectors (Apache-2.0)
packages/engine/     engine interface (text + JSON tree of maps and arrays) + Yjs, Automerge, Loro adapters. `@omnisync/engine/yjs` is a subpath so a browser bundle can omit the other two
packages/telemetry/  metrics and traces (OpenTelemetry API, Prometheus endpoint on its own port): observer-only, closed label sets, off unless configured. `@omnisync/telemetry/testing` reads a real scrape back as text
packages/store/      hash-chained update log, checkpoints, identity store (principals, certificates with their signed bytes, grants, document registry, audit), snapshot metadata (PostgreSQL + in-memory), object storage (filesystem, memory, and the S3 adapter with Object Lock at `@omnisync/store/s3`), SQL migrations, fault injection (`@omnisync/store/testing`)
packages/sdk/        browser and Node SDK (Apache-2.0): device key (WebCrypto, non-extractable), outbox (memory, IndexedDB), batching, SyncDocument, enrollment. Test page and Playwright test under browser/ and test/browser.test.ts
packages/sdk-react/  React hooks only (peer: React 18 or 19)
packages/config/     shared tsconfig
bench/               engine and end-to-end benchmark (`pnpm bench`) and the load harness (`pnpm load`: separate-process gateway on PostgreSQL; raw results in bench/results/)
docs/specs/          one spec per feature, written before code
docs/decisions/      architecture decision records
```

`deploy/` holds the Dockerfile (`deploy/docker`), the Helm chart (`deploy/helm/omnisync`), the installer (`deploy/install/install.sh`), the preflight renderer and manifest comparison (`deploy/tools`) and their tests with four values files (`deploy/tests`), the Grafana dashboard generator (`deploy/monitoring`) and the k6 script for the control plane (`deploy/load`). Planned (Phase 1): `packages/agent-sdk`. `packages/sdk-react` is unused by the apps (the UI stack is Angular).

## Conventions

- TypeScript strict everywhere, ESM, `.js` suffix on relative imports.
- Spec first: `docs/specs/<feature>.md` (inputs, outputs, invariants, failure modes) before code.
- Invariants are property-based tests with fast-check: convergence, envelope round-trips, tamper detection, replay rejection.
- Diffs under about 300 lines, one pull request each. CI must be green.
- Hostile input never throws past a boundary: decoders return typed errors, the gateway counts and drops.
- Updates and state vectors are opaque bytes above `packages/engine`. Nothing else imports `yjs`, `@automerge/automerge` or `loro-crdt` directly; the gateway's Node client and the SDK go through `@omnisync/engine`.
- The SDK is browser-first: no `node:*` imports, no `ws`, signing is asynchronous. The device key signs through a callback so a non-extractable WebCrypto key works.

## Protected paths

Changes here are never merged on AI review alone. Ask before editing, and the human reviews after a 24-hour gap:

- `packages/protocol/src/signing.ts`, `packages/protocol/src/frame.ts`, `packages/protocol/test/vectors.json` (wire format is v2: frames carry sessionId, seq, claimedAtMs and a cert-bound signature)
- `packages/crypto/**`, `packages/verifier/**`, any ledger code: `packages/store/src/ledger.ts`, `apps/gateway/src/{checkpoint,export}.ts`, migration `003`
- Gateway authorization, handshake and replay checks in `apps/gateway/src/gateway.ts`
- `apps/control-plane/src/{service,tokens,oidc,session,config,http,admin,device,app,main}.ts`: login (including the `return_to` redirect and the CORS hook in `app.ts`), device-code login, certificate issuance and revocation, admin authorization
- `packages/store/src/identity*.ts` and migrations `002` and `004` (identity and device-code tables)
- Durability logic in `apps/gateway/src/room.ts` (write path, snapshot cut, cold load)
- `apps/gateway/src/{storage-config,ledger-config,serve}.ts`, `packages/store/src/{s3,object-key,fs-object-store,types}.ts`: where checkpoints are written and how they are locked
- `deploy/install/install.sh` (key generation and the Secret), `.github/workflows/release.yml` (signing and publishing)
- `deploy/helm/omnisync/**` (what is mounted where, which secrets reach which pod, network policy, pod hardening, the MinIO delete-free policy) and `deploy/docker/Dockerfile`
- `packages/store/migrations/**` and `packages/store/src/pg.ts`: the append-only log. Never edit an applied migration; add a new one

## Never do

- Never invent cryptography. Ed25519 via node:crypto or `@noble/ed25519`, hashes via `@noble/hashes`, nothing hand-rolled.
- Never log secrets, secret keys, tokens or document payloads.
- Never put a document id, principal, key, token, email or payload in a metric name, label value, span name or span attribute. Labels come from closed sets written in code; telemetry never changes what the gateway or control plane does (`docs/specs/observability.md`).
- Never disable certificate or signature verification, even in tests; use test keys instead.
- Never sign a checkpoint with the certificate issuing key, or a certificate with the ledger key (separate keys, separate trust inputs).
- Never upload a checkpoint before it is reserved in the database, never reuse a checkpoint number, and never overwrite a bucket object that holds different bytes.
- Never report a ledger as verified without saying whether it was anchored to locked checkpoints.
- Never add a field to the entry hash, or reorder its inputs, without a new `LEDGER_ENTRY_VERSION` and regenerated frozen vectors.
- Never issue a certificate longer than 24h (default 12h) or without an enrollment proof of key possession.
- Never skip the `email_verified` check or the login CSRF cookie binding in the OIDC flow.
- Never accept unsigned state from a client into a document (no client-sent SYNC_2).
- Never ACK, apply or relay an update before `appendUpdates` has committed it.
- Never update or delete rows in `document_updates` (a trigger enforces it); snapshots are a cache, the log is the truth.
- Never edit an already-applied SQL migration.
- Never change `vectors.json` without bumping the protocol version.
- Never let the device key's secret out: never export, serialise, log or send it, and never make the SDK's default path use an extractable key when WebCrypto can hold a non-extractable one.
- Never delete a frame from the SDK outbox before the gateway acknowledged that exact frame (or answered duplicate or replay for it).
- Never add a dependency without saying why in the pull request.
- Never put a session token where a page or a terminal can leak it: not in a URL query, `localStorage`, a cookie, a log, a file or command output. The browser gets it once in the URL fragment and keeps it in memory; the CLI uses it once to enrol and drops it.
- Never let a browser say "anchored" about a ledger it verified with keys from the same server (say "consistent"); only `omnisync verify` with out-of-band keys and locked checkpoints can.
- Never write a device private key to disk except the CLI's private key file (0600, created exclusively, never overwritten, refused when readable by others); browsers keep a non-extractable key.
- Never store a device code: only its SHA-256; never put a user code or device code in the audit trail or a log.
- Never give the gateway's S3 credentials `s3:DeleteObject` or `s3:DeleteObjectVersion` on the checkpoint bucket, never let `S3ObjectStore` delete or overwrite a locked key, and never default the checkpoint retention (an operator chooses it; compliance mode cannot be shortened).
- Never put a secret value on a command line, in an environment variable or in a values file in the installer or the release workflow (files and the Kubernetes Secret only), and never overwrite an existing Secret.
- Never remove the login/lookup rate limits on the device routes, and never make a wrong user code distinguishable from an unknown one.

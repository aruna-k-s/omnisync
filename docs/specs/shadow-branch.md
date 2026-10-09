# Spec: Shadow-Branch prototype (Phase 1, week 11)

**Status: draft for your review. Nothing in this spec is built.** The tests that accompany it (`packages/branches/test/`) are written and fail, on purpose, until you have read this and answered the decisions at the end.

Product definition: the "Shadow-Branch AI collaboration" section of the plan. An agent edits its own fork of a document; nothing it writes reaches the main document until a human approves a reviewed diff. Phase 1 ships a **scripted prototype for demos**; the production protocol is Phase 3 (and only when a design partner asks). This spec says what the prototype is, what it deliberately is not, and what it must never do.

## Findings that shape the design

1. **A signed update is bound to its document.** `signedMessage(docId, ...)` (`packages/protocol/src/signing.ts`) puts the document id into what the signature covers, and the gateway verifies against the connection's document. The plan's sentence "the gateway replays the agent's original signed updates into main, so their signatures stay valid" is therefore **not possible** with today's wire format: a frame signed for the branch fails verification on main. Making it possible means a protocol change in a protected file (a new frame type that embeds the agent's frames and names the branch as their document, plus verifier support).
2. **Roles, grants, ledger, rate limits, revocation and persist-before-ACK already exist per document.** If a branch is simply another document, the agent gets every one of them for free, and its containment is an authorization fact (it holds `write` on the branch and nothing on main) rather than new code in the write path.
3. **The engine interface has no "what changed" API.** Classifying a change as Clean or Overlap needs a three-way comparison of base, branch and main. The prototype does it on the readable views (`getText()`, `getData()`), not on engine internals.

## What the prototype is

- **A branch is a document** with id `<main>~b~<branchId>`, registered like any document. Fork = a user with `merge` on main requests it; the base state of main at head `H0` is written into the branch document as one update signed by that user (so the first ledger entry of the branch names a human and the base). The record keeps `H0` (main's head seq and entry hash) and main's state vector at `H0`.
- **The agent is a principal with its own certificate.** It is granted `write` on the branch document and nothing on main. It cannot read or write main, so it cannot merge, because it holds no role there at all. Revoking the agent's certificate (existing revocation) stops it writing; the branch record is marked `frozen` by the kill switch so its proposals cannot be approved either.
- **A pure library**, `packages/branches` (no I/O, no gateway import), holds the logic that must be right: change classification, the branch state machine, approval rules and the merge plan. It is built test-first against real engine documents.
- **An Agent SDK** (`packages/agent-sdk`, later in the week, after the library is accepted) is a thin wrapper over the existing Node client: connect to the branch with the agent's certificate, apply edits, `propose`. It never calls a model.
- **A scripted demo** (`apps/reference-app/demo` or a bench-style script) forks, lets a scripted "agent" edit, proposes, and merges through a human with the `merge` role, then runs `omnisync verify` on both ledgers.

## Merge model (Decision D12)

- **Option A, recommended for the prototype: human-signed replay.** On approval the merging user's client applies the agent's engine updates to main as ordinary UPDATE frames **signed by the human** (each payload is exactly the agent's payload, in branch order, so the engine result is identical), followed by any overlap resolutions as separate human-signed edits. The agent's own signatures remain valid in the **branch's** ledger. A merge record cites the proposal, the branch id, the branch entry hashes `from..to`, the main head before and after, the approvers and the resolutions, and is written to the audit trail (`appendAudit`) in the same call. Limitation, stated plainly: main's own hash chain shows human-signed edits and does not itself contain the link to the agent's entries; the link lives in the audit trail and the branch ledger. An auditor can follow it, but it is two ledgers and a record, not one chain.
- **Option B, Phase 3: a merge frame.** A new frame type, signed by the human, embedding the agent's signed frames and the branch id they were signed for. Main's chain then contains the full evidence. Needs a protocol version bump, `signing.ts` and `frame.ts`, the verifier and vectors (all protected, all 24-hour reviews). Not in this week.

## Lifecycle and state machine

States: `open`, `proposed`, `merged`, `rejected`, `archived`, `frozen`.

| From | Event | Who | To | Rule |
| --- | --- | --- | --- | --- |
| (none) | `fork` | user with `merge` on main | `open` | Records `H0`, agent, scope, purpose, `expiresAt` (default fork time + 24 h, never more than a configured maximum) |
| `open` | `propose` | the branch's agent (or the forking user) | `proposed` | The branch must differ from its base ("nothing to propose" otherwise). Classifies changes (below). Proposals are numbered; a new one supersedes the last |
| `proposed` | `return` | reviewer with `merge` | `open` | Comments recorded; the agent keeps working in the same branch |
| `proposed` | `reject` | reviewer with `merge` | `rejected` | Terminal. Kept, not deleted |
| `proposed` | `approve` | reviewer with `merge` | `merged` | Only if every Overlap has a reviewer-chosen value, every Policy change has a second approver (below), and the reviewer is not the agent. Whole proposal only |
| `open`, `proposed` | `expire` | time | `archived` | When `expiresAt` passes. Archived means kept, not deleted; an archived branch cannot be proposed or approved |
| `open`, `proposed` | `freeze` | agent key revoked (kill switch) | `frozen` | No proposal, no approval; a reviewer can still `reject` |

Any other combination is refused with a typed `BranchError` whose `code` is one of `wrong_state`, `not_agent`, `not_authorized`, `self_merge`, `unresolved_overlap`, `not_an_overlap`, `second_approver_required`, `policy_role_unconfigured`, `nothing_to_propose`, `expired`, `frozen`, `ttl_too_long`, `bad_id` or `bad_path`. A branch id is 1 to 64 characters from letters, digits, `-` and `_`, so `<main>~b~<id>` is unambiguous. The agent can never fork its own branch (`self_merge`). Partial approval does not exist in v1: Yjs updates depend on earlier ones, so a reviewer approves the whole proposal or returns it. "Approve and then edit" is a separate human edit afterwards.

## Change classification

Input: the base view (main at `H0`), the branch view now and main now, each as `{ text, data }` (`getText()`, `getData()`), and a list of review-required path prefixes. Output: a list of changes, each `{ path, change: "added" | "removed" | "changed", class: "clean" | "overlap", policy: boolean }`.

- Paths are JSON-pointer style: `/sections/title`, with object keys as segments. The document text is the single path `$text`. **Arrays are leaves**: an array that differs is one change at its path, because index positions are not stable when both sides insert. This is conservative, and it is stated so.
- A path is a change if the branch value differs from base. It is **Overlap** if main's value at that path also differs from base (and the two differ from each other); if main made the identical change, it is Clean (nothing to resolve). Otherwise Clean.
- `policy` is true when the path is at or below any review-required prefix, independent of Clean or Overlap.
- Text is compared as a whole: if both sides changed the text, `$text` is an Overlap even if they edited different places. Finer text ranges need engine support and are Phase 3.
- Schema violations are rejected at write time, before any proposal. The prototype has no schema layer, so nothing is rejected on schema grounds yet.

## Approval rules

- The approver needs role `merge` on the **main** document and must not be the branch's agent.
- Every Overlap path needs a `resolutions[path]` value chosen by the reviewer; a resolution for a path that is not an Overlap is refused.
- If any change is `policy`, a second approver is required: a different principal, with `merge` on main, holding the named policy role. The prototype takes the named role as a string from configuration and checks it against the roles it is given; mapping it to real grants is control-plane work (protected files) and is Phase 3.
- Passkey step-up for approvals is out of scope for the prototype and is recorded as such in the merge record (`stepUp: "none"`).

## Containment, as built and as deferred

| Control | In the prototype |
| --- | --- |
| Scope | The agent holds a grant on the branch document only. Finer namespaces inside a document are not enforced |
| Limits | The existing per-connection token bucket and payload cap. A branch-size cap and per-agent budgets are not built |
| Time limit | `expiresAt` in the record, enforced by the library; the grant itself is not revoked at expiry (control plane) |
| No self-merge | The agent has no role on main; the library also refuses the agent as approver |
| Kill switch | The record is frozen; the agent's certificate is revoked by the existing path |
| Untrusted input | Unchanged: the human gate and the write scope are the defence. The SDK never calls a model |

## What is not in the prototype

Control-plane endpoints, console review screen, passkey step-up, schema validation, per-namespace scopes, branch-size caps, branch metrics (open branches, proposal outcomes, concurrent overwrites; deferred from week 10), evaluation tracking, and Option B.

## Tests (written first, in `packages/branches/test/`)

- **Classification:** disjoint changes are Clean; same path changed on both sides is Overlap; identical change on both sides is Clean; added and removed keys; nested paths; arrays as leaves; `$text` changed on one side is Clean, on both is Overlap; policy flag by prefix (and not by a sibling that shares a string prefix); nothing changed gives an empty list. Property tests: classification never invents a path; if main equals base every change is Clean; if the changed path sets are disjoint nothing is Overlap; swapping branch and main swaps nothing about which paths are Overlap.
- **State machine:** every row of the table above, every refusal code, expiry exactly at `expiresAt`, a superseding proposal, a frozen branch that can still be rejected, and the agent never approving.
- **Approval:** unresolved overlap refused, resolution for a non-overlap refused, second approver (same person refused, missing role refused), non-`merge` approver refused.
- **Merge plan:** from real Yjs documents: base, a branch edited by an "agent", main edited meanwhile. The plan's updates, applied to a copy of main, produce main plus the agent's changes; overlap resolutions applied afterwards give the reviewer's value; the plan is deterministic and cites the branch entry hashes in order; a plan for a rejected or unapproved proposal is refused.

## Library surface the tests pin down

`classifyChanges`, `fork`, `propose`, `returnToAgent`, `reject`, `approve`, `tick`, `freeze`, `planMerge`, `applyResolutions`, `BranchError`, and the types `View`, `Change`, `Actor` (`principalId`, `mainRole` of `none|read|write|merge|admin` on the main document, `policyRoles`), `BranchRecord`, `BranchEntry` (`seq`, `entryHash`, `payload`). Records are plain values: every transition returns a new record and leaves its input unchanged. `approve` takes the policy role name as `policyRole`. A `planMerge` takes the branch's entries after the seeding update (seq 1 is the forking human's base update), requires them to be gap-free and in seq order whatever order they are given in, and returns the agent's payloads in order, the resolutions, and the merge record to write to the audit trail.

## Dependencies

New workspace package `@omnisync/branches` with `@omnisync/engine` (workspace) as a dev dependency for tests, `vitest` (the repository's runner) and `fast-check` (already used by the SDK; this is a second package using it). No new third-party package.

## Protected paths

None touched by the prototype as specified: no gateway change, no migration, no control-plane change, no `frame.ts` or `signing.ts` change. The things this design chooses **not** to do because they would touch protected paths are listed above (Option B, a branches table in a migration, control-plane endpoints, a gateway-side refusal at the merge permission). If you choose Option B, or want the branch record in PostgreSQL, those become 24-hour reviews.

## Decisions I need from you

- **D12, merge model:** Option A for the prototype (human-signed replay plus an audit-trail merge record, two ledgers and a record) with Option B as the Phase 3 target, or Option B now (protocol change, protected review, longer).
- **D13, where the branch record lives:** the prototype keeps it behind a small storage interface with in-memory and file implementations, and writes events to the existing audit trail. A PostgreSQL table (migration `005`, protected) can follow in Phase 3. Agree?
- **D14, text granularity:** whole-text overlap (conservative, simple) for the prototype, finer ranges later. Agree?

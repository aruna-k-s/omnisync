# Spec: admin console (Phase 1, week 8b)

**Purpose.** A web console for organisation admins: see who has signed in and which devices they hold, revoke a device or an account in one click, manage who can open each document, read the audit trail, and check the ledger in the browser. It is a client of the admin API (`admin-api.md`) and holds no state of its own.

**Stack.** Angular 21 (LTS), standalone components and signals, no router, no forms module, no UI kit. Why 21 and not 22: Angular 22 requires TypeScript 6 and a newer Node patch release than this repo supports (Node 22.12+, TypeScript 5.9). The user chose Angular; the framework-free parts (API client, ledger view, session handling) are plain TypeScript with Vitest tests, so the framework layer stays thin and replaceable.

## Pages

| Page | What it does | API |
| --- | --- | --- |
| Sign in | One button. Starts the OIDC login with `return_to` = this page | `GET /v1/auth/login?return_to=` |
| People | All principals; select one for their certificates (serial, issued, expires, state). **Revoke** on an active certificate; **Disable account** (revokes every device). No disable button on your own row or on a disabled account | `/v1/admin/principals`, `.../certificates`, `POST /v1/certificates/:serial/revoke`, `POST /v1/principals/:id/disable` |
| Documents | All registered documents; select one for its grants; change a role, remove a grant, add a grant. The server's last-admin rule (409) is shown as the error | `/v1/admin/documents`, `.../grants` |
| Ledger | **Verify ledger** downloads the trust inputs and the export, runs `@omnisync/verifier` in the page, and shows the verdict, the counts and every entry (document, number, time, signer, hash) with a tick or a cross. **Download export** saves the NDJSON | `/v1/admin/ledger/trust`, `/v1/admin/ledger/export` |
| Audit | The audit trail, newest first | `/v1/admin/audit` |

## Session

- The token arrives as `#session=<jwt>` after the IdP round trip, is read once, and removed from the address bar and history (`history.replaceState`) before any other code runs.
- It lives in a JavaScript variable only: never `localStorage`, `sessionStorage`, a cookie or the DOM. A reload signs in again (one redirect while the IdP session lasts). Tested in the browser.
- A 401 from any call signs out with "Your session ended". A signed-in non-admin (`orgRole` not `admin`) is signed out with a message saying so, and sees nothing. The server enforces the same rule on every route; the check here is for the person's benefit, not security.
- Configuration is `config.json` next to `index.html`: `{"controlPlane": "https://cp.example.com"}` (an origin only; empty means same origin). It is parsed strictly: a path, user info or another scheme is refused. The control plane must list the console's URL in `returnTo` (which also sets its CORS allowlist).

## The ledger view: what it may claim

- The keys and the export come from the same server. A pass therefore means **consistent**: hash chains, certificate and update signatures, certificates and checkpoints agree with each other and with those keys. It never says "anchored", and the page says so in words next to the verdict, with the way to get a real one (`omnisync verify` with keys the auditor holds and the locked checkpoints).
- The tenant is pinned to the one the server reports, so an export for another tenant fails.
- Ticks: every entry is ticked only if the whole report has no violation. On a failed report no entry is ticked; entries named by a violation show its message on hover. A violation that names no entry (a bad checkpoint) therefore cannot be missed by looking only at ticks.
- Lines that are not JSON, an empty export, and a keys-in-both-roles setup are shown as failed or unreadable, never as an empty pass.
- At most 500 entries are listed; all are verified and counted. The page says how many are shown.
- The signer is the principal id named by the certificate in the export, not the person's email: the export deliberately carries no personal data.

## Known limits (deliberate, for week 8)

- The verifier core calls Node's `Buffer` (in `verify.ts`, `records.ts`, `crypto/ledger.ts`). The console bundle supplies the `buffer` package as a polyfill (a new dependency, justified here); making the verifier platform-independent is a protected-path change left for review.
- The export is buffered in the browser and the control plane (cap 64 MiB). Large tenants use the export command and the CLI verifier.
- No paging in the UI: lists load fully (people and documents up to 200 per request, 200 requests). Search and sorting come later.
- Not a design system: one stylesheet, light and dark by `prefers-color-scheme`.

## Tests

1. Unit (Vitest, no browser): session fragment parsing (exact match, bounds, decoding), login URL, config parsing; API client (bearer, paging, page cap, error mapping, id encoding, bodies, audit order); formatting and certificate state; ledger view against the verifier's independent fixture builder (consistent, rewritten entry, wrong key, other tenant, empty, malformed line, cap, missing certificate).
2. End to end in real Chromium (`test/e2e.test.ts`): fake IdP, **real control plane, real gateway**, memory stores, the built console served as static files. SSO login as an admin lands on the console with the session out of the URL, history and storage; a member is refused with a reason; **Verify ledger shows both entries ticked with their signers, and a rewritten entry as failed**; revoke a device in one click and the gateway cuts the connection; disable an account (devices revoked, session dead, no button for yourself); change a grant from the page (audited as the org admin) and see the last-admin error; the audit page lists the export. `OMNISYNC_REQUIRE_BROWSER=1` (set in CI) makes a missing Chromium or missing build a failure, not a skip.
3. Screenshots of each page: `CONSOLE_SHOTS=<dir> pnpm --filter @omnisync/console test`.

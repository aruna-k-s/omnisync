# Spec: admin API and browser login (Phase 1, week 8a)

**Purpose.** Give the console (week 8b) and the CLI (8d) what they need from the control plane: list people, documents, certificates and audit events; change grants on any document; revoke in one call; download a ledger export; and let a single-page app finish an OIDC login without a custom server. Everything here is for **organisation admins** (`orgRole = admin`). Document-level admins keep the existing `/v1/documents/:id/grants` routes.

Non-goals: pagination by arbitrary sort, search, per-field filtering (the console filters what it has loaded), streaming exports (the export is buffered and capped, see below), editing principals.

## Access rules

- Every `/v1/admin/**` route passes `SessionGuard` (401 without a valid, unexpired session of an enabled principal) and then `AdminGuard`: 403 `organisation admin only` for a member.
- `orgRole` is read from the store on every request, so demoting or disabling an admin takes effect on their next request, not when their session expires. (The role itself is refreshed from the IdP's verified email at login, as before.)
- A disabled principal is refused by `SessionGuard` before `AdminGuard` runs.
- A malformed id (document ids are UUID v4, principal ids `[A-Za-z0-9._:@-]`, at most 128 characters) answers 400; a well-formed id that does not exist answers 404.

## Store additions (`IdentityStore`, memory and PostgreSQL, one contract suite)

| Method | Meaning |
| --- | --- |
| `listPrincipals(after: string \| undefined, limit)` | ascending by id, id > `after` |
| `listDocumentRecords(after: string \| undefined, limit)` | ascending by id, id > `after` |
| `listCertificatesOf(principalId)` | all of one principal's certificates, newest `issuedAt` first (a principal holds few; capped at 500) |
| `appendAudit(audit)` | one audit event with no other change, for read actions worth recording (ledger export) |

No migration is needed. `listGrantsOf(principalId)` is deliberately not added: the console shows grants per document.

## Endpoints

Pagination: `?limit=` (1..500, default 100; anything else is 400) and `?after=` (opaque, the previous page's `next`). A response has `next` only when the page was full. Clients stop when `next` is absent.

| Route | Result |
| --- | --- |
| `GET /v1/admin/principals` | `{principals: [{id, email, displayName, orgRole, disabledAtMs?}], next?}` |
| `GET /v1/admin/principals/:id/certificates` | `{certificates: [{serial, keyId, issuedAtMs, notBeforeMs, notAfterMs, revokedAtMs?, revokeReason?}]}`, serial and keyId as hex. Never the signed bytes or the public key |
| `GET /v1/admin/documents` | `{documents: [{id, createdBy, createdAtMs}], next?}` |
| `GET /v1/admin/documents/:id/grants` | `{grants: [...]}` as the existing route; 404 if the document is not registered |
| `PUT /v1/admin/documents/:id/grants/:principalId` | body `{role}`; as the existing route but the actor needs the org role, not a document role. The `keepOneAdmin` guard still applies (409) |
| `DELETE /v1/admin/documents/:id/grants/:principalId` | same |
| `GET /v1/admin/audit` | `{events: [{id, atMs, actor, action, target, detail}], next?}` oldest first; `after` is an event id. Use `after` of the last event to follow new ones |
| `GET /v1/admin/ledger/trust` | `{tenant, issuers: [hex], ledgerKeys: [hex], anchored: false}` |
| `GET /v1/admin/ledger/export` | `application/x-ndjson`, the export of `docs/specs/ledger.md` for the whole tenant |

One-click revoke needs no new route: `POST /v1/certificates/:serial/revoke` already lets an org admin revoke anyone's certificate, and `POST /v1/principals/:id/disable` revokes all of a person's certificates. Both already write audit events.

### Ledger export

- Configured with `ledger: {tenant, issuers, ledgerKeys, export(write), maxExportBytes?}`. Without it the two ledger routes answer 404 `ledger not configured`, so a control plane without access to the log does not pretend to have one.
- `export` is injected (in `main.ts` it is the gateway's `exportLedger` over the same database). The control plane never reads the log tables itself.
- The export is buffered up to `maxExportBytes` (default 64 MiB). Past the cap the request fails with 413 `export too large; use the export command` and nothing is sent. A truncated export is never produced: it would verify as "truncated" at best and look complete at worst.
- At most one export runs at a time; a second request gets 429 with `retry-after`. The export is read-only but heavy.
- An audit event `ledger.export` (actor = admin, target = tenant) is written **before** the export starts, so a failed or interrupted export is still recorded. If the audit write fails the export is refused (503); reading the log must not be possible without a trace.
- Response headers: `cache-control: no-store`, `content-disposition: attachment; filename="<tenant>-ledger.ndjson"` (tenant restricted to `[A-Za-z0-9._-]`, else `ledger`).

### Trust inputs and what a browser may claim

`/ledger/trust` returns the keys **this server** holds. A verifier that takes keys and export from the same server proves consistency (hash chains, signatures, certificates and checkpoints agree with each other and with these keys). It does not prove that the server did not rewrite everything, which is what the locked bucket comparison adds. So:

- The response says `anchored: false` and the console must label the result "consistent, keys supplied by this server", never "anchored".
- For a result worth showing an auditor, download the export and run `omnisync verify` with keys obtained out of band (spec `ledger.md`). The console says so next to the result.

## Browser login (`return_to`)

A single-page app cannot read the JSON the callback returns, so the callback can redirect instead.

- `GET /v1/auth/login?return_to=<url>`: `return_to` must equal, character for character, an entry of `config.returnTo` (an allowlist of absolute URLs; `https:` or `http://localhost`/`127.0.0.1` only). Anything else is 400 and no cookie is set. No allowlist entries means the parameter is always refused and the JSON flow stays the only one.
- The accepted value is stored in a second cookie `omnisync_return` (same flags and path as the login cookie, 10 minutes).
- `GET /v1/auth/callback`: after the existing state/cookie check and token exchange, if the cookie is present and **still** on the allowlist, answer `302 <return_to>#session=<jwt>`; otherwise JSON as before. Both cookies are cleared. The token goes in the URL fragment: it never reaches a server log, a `Referer` header or the control plane again. Responses carry `cache-control: no-store`.
- The SPA reads the fragment, removes it with `history.replaceState`, and keeps the token in memory only (a reload logs in again; the IdP session makes that one redirect).
- An attacker who can set the cookie from a sibling subdomain still cannot redirect to a non-allowlisted URL, because the callback re-checks.

## Audit

New action names: `ledger.export`. Existing `grant.set`, `grant.remove`, `cert.revoke`, `principal.disable` are written by the same service methods the admin routes call, so an admin change looks the same in the audit trail as a document admin's, with the actor's id.

## Failure modes

| Situation | Result |
| --- | --- |
| No/expired/invalid session | 401 |
| Member calls an admin route | 403, no data |
| Store down | 503 `storage unavailable` (existing mapping) |
| `limit` or `after` malformed | 400 |
| Unknown document / principal | 404 |
| Export over the cap | 413, nothing sent |
| Export running | 429 + `retry-after` |
| Audit write fails before export | 503, export not started |
| `return_to` not allowlisted | 400 at login; JSON at callback if the cookie later fails the check |

## Tests

1. Store contract (memory + Postgres): paging is ascending and gap-free over more rows than a page; `after` is exclusive; per-principal certificates newest first and only that principal's; `appendAudit` appears in `listAudit`.
2. Access: each admin route is 401 without a token, 403 for a member, 200 for an admin; a demoted or disabled admin is refused on the very next request.
3. Listings: pages follow `next` until absent; the certificate listing carries no key material; revoked state is visible after `POST /v1/certificates/:serial/revoke`.
4. Grants: an org admin who holds no grant sets, changes and removes grants on any document; the last-admin guard returns 409; each change has an audit event naming the admin.
5. Export: content equals what the injected function wrote; audit event exists before the first byte; cap exceeded gives 413 and no body; concurrent request gets 429; export failure leaves the audit event; unconfigured gives 404; trust output matches the config and says `anchored: false`.
6. Login redirect: allowlisted `return_to` ends in `302 <url>#session=<jwt>` and the token works on `/v1/me`; a non-allowlisted value is 400; a forged `omnisync_return` cookie pointing elsewhere falls back to JSON; state binding still enforced.
7. End to end (week 8b): fake IdP, real control plane, real gateway and database, real Chromium: SSO login to a verified ledger entry on screen.

## Protected paths touched

`apps/control-plane/src/{service,http,config}.ts` and the login code in `http.ts` (login, session, redirect). They wait for the 24-hour human review like the rest of the identity code. No change to token format, certificate issuance or the OIDC exchange itself.

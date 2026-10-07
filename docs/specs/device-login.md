# Spec: device-code login and the command-line client (Phase 1, week 8d)

**Purpose.** Sign in from a place that has no browser to redirect: a terminal, a headless build agent, a native app. The user starts the login on the device, finishes it in a browser where they are already signed in with the company IdP, and the device ends up with a certificate for its own key, exactly as a browser device would. This is the OAuth device authorization pattern (RFC 8628) adapted to OmniSync: the browser approves with its normal OmniSync session, the device then enrols a key.

Non-goals: refresh tokens (the device renews by logging in again, or later by presenting its still-valid certificate), approving from a phone camera/QR flow, push approval.

## Flow

1. Device: `POST /v1/auth/device {label}` returns `{deviceCode, userCode, verificationUri, verificationUriComplete, expiresInS, intervalS}`.
2. Device shows `userCode` and `verificationUri` and polls `POST /v1/auth/device/token {deviceCode}` every `intervalS`.
3. Person opens `verificationUriComplete` (the reference app, or any app that implements the two calls below with the SDK), signs in as usual, sees **who is asking** (the label, the time, the code) and presses Approve or Deny: `GET /v1/auth/device/:userCode` (shows the request) then `POST /v1/auth/device/:userCode/approve` or `/deny`, both with the person's session bearer token. The reference app does this on `/?device=<code>`: it keeps the code through the sign-in redirect (session storage, removed from the address bar), shows the label and the code to compare, and decides on a click.
4. The next poll returns `{sessionToken}` once. The device creates an Ed25519 key, proves possession and enrols (`POST /v1/certificates`, unchanged), then **drops the session token**: the certificate is the credential.

## Endpoints

| Route | Auth | Result |
| --- | --- | --- |
| `POST /v1/auth/device` | none; rate limited per IP like login | 200 as above. `label` is optional text (at most 64 characters, shown to the approver, control characters removed) |
| `POST /v1/auth/device/token` | none | `200 {sessionToken}` once; or `400 {error}` with `authorization_pending`, `slow_down`, `access_denied`, `expired_token` (RFC 8628 names); an unknown or already consumed code is `expired_token` too, so a probe learns nothing |
| `GET /v1/auth/device/:userCode` | session | `{label, createdAtMs, expiresAtMs, status}`; 404 unknown or expired |
| `POST /v1/auth/device/:userCode/approve` | session | `200 {approved: true}`; 404 unknown/expired; 409 already decided |
| `POST /v1/auth/device/:userCode/deny` | session | same, status becomes denied |

`verificationUri` comes from configuration (`deviceVerificationUrl`, which must be an entry of `returnTo` so CORS and the allowlist cover it; without it the device endpoints answer 404 `device login not configured`). `verificationUriComplete` is that URL with `?device=<userCode>` appended.

## Codes

- `deviceCode`: 32 random bytes, base64url. Held only by the device. The server stores **only its SHA-256**, so a database reader cannot poll as the device.
- `userCode`: 8 letters from `BCDFGHJKLMNPQRSTVWXZ` (no vowels, no look-alikes), shown as `XXXX-XXXX`, case-insensitive, hyphen optional on input, normalised to the 8 letters. 20^8 is about 34 bits; it lives 10 minutes and is single use. Guessing is bounded by rate limits (below) and by the fact that approval needs a signed-in person, who then sees the label and must click.
- Lifetime 600 seconds, polling interval 5 seconds. A poll sooner than the interval gets `slow_down` and **counts**: the device must wait `intervalS + 5` after one (the server also returns the new `intervalS` in the error body).

## Rules and failure modes

| Situation | Result |
| --- | --- |
| Approve by a disabled principal or an invalid session | 401 (the usual session guard) |
| Approve twice, or after deny | 409; the first decision stands |
| Approve after expiry | 404 |
| Token request before approval | `authorization_pending` (and `slow_down` if too fast) |
| Token request after deny | `access_denied`, once; then `expired_token` |
| Token request after expiry | `expired_token` |
| Token returned | the row is deleted in the same transaction: a second poll is `expired_token` |
| The approver's account is disabled between approval and the poll | the poll answers `access_denied`; no session is issued |
| Many guesses of `userCode` | looking up or deciding is limited per signed-in person (the login rate limit, 20 a minute by default), then 429; a wrong code and a malformed one are both 404. Starting is limited per client IP like login; polling per IP at 60 burst, 120 a minute |
| Store down | 503 `storage unavailable` |

Every step is audited with the label as detail: `device.start` (actor `system`), `device.approve` and `device.deny` (actor the approver), `device.token` (actor the principal; written before the session is issued, so a failed audit write refuses the token with 503 and the request is already consumed). The audit target is `device:` plus the first 8 hex characters of the SHA-256 of the normalised user code, never the code itself.

## Storage

One table `device_auths` (migration `004_device_auth.sql`, additive): `device_hash bytea primary key (32)`, `user_code text unique`, `label text`, `created_at`, `expires_at`, `last_poll_at`, `status text in (pending, approved, denied)`, `principal_id text null`. Expired rows are deleted when a new request is created (bounded work, at most 100 rows per call). `IdentityStore` gains: `createDeviceAuth`, `getDeviceAuth(userCode)`, `decideDeviceAuth(userCode, decision, principalId, atMs, audit)`, `pollDeviceAuth(deviceHash, atMs, minIntervalMs)`. Poll is atomic: it records the poll time, returns the state, and deletes the row when it hands over an approval.

## SDK (browser and Node)

`packages/sdk/src/device-login.ts`, exported from the SDK index and as the subpath `@omnisync/sdk/device-login` (only `fetch`, so it runs in Node and in browsers):

- `startDeviceLogin(controlPlaneUrl, {label?, fetch?})` returns the response of step 1;
- `pollDeviceLogin(controlPlaneUrl, start, {fetch?, sleep?, now?, signal?})` waits one interval before the first poll, honours the interval and `slow_down` (the larger of the server's interval and the old one plus five seconds), `retry-after` on 429, rides out up to four network or server failures in a row (the fifth ends it), stops at expiry and returns `{sessionToken}` or throws `DeviceLoginError` with `code` (`access_denied`, `expired_token`, `aborted`, `network`, `refused`, `unexpected`) and the HTTP `status` where there is one;
- `describeDeviceRequest(cp, token, userCode)`, `decideDeviceRequest(cp, token, userCode, "approve" | "deny")` for the approving page.

## Command line (`apps/cli`, command `omnisync-cli`)

| Command | Behaviour |
| --- | --- |
| `login --server <url> [--gateway <ws-url>] [--label <text>]` | runs the flow; prints the code and URL; creates (or reuses) the device key; enrols; writes the profile; prints who it is and when the certificate expires |
| `whoami` | reads the profile, prints principal, certificate serial, expiry; exit 1 when expired or absent |
| `logout` | deletes the profile and the key file. The certificate stays valid until it expires (12 hours by default); an admin can revoke it at once in the console (People page). Revoking from the CLI needs a session, which the CLI deliberately does not keep |

The profile directory is `$OMNISYNC_HOME` or `~/.omnisync`, mode 0700; files `key.json` (private key, mode 0600) and `profile.json` (server, principal, serial, expiry, certificate; mode 0600).

**The device key is a file.** A Node process has no non-extractable key store, so unlike the browser SDK the CLI persists the Ed25519 secret in a 0600 file, written atomically, never printed, never sent, never in `profile.json`, and refused if the file is group- or world-readable. This is a deliberate exception to the browser rule in AGENTS.md ("never serialise the device key's secret") for an environment that has no better place, and is called out for review. An OS keychain backend is the follow-up. The session token is never written to disk.

## Protected paths touched

`apps/control-plane/src/{service,http,config}.ts` (a new controller and service methods; no change to login, session or certificate issuance), `packages/store/migrations/004_device_auth.sql` (new), `packages/store/src/{identity,identity-memory,identity-pg}.ts`. They wait for the 24-hour human review.

## Tests

1. Store contract (memory and Postgres): create/lookup by user code; approve and deny once; poll returns pending, then approved and consumes; `slow_down` when polled early; expiry; a second create purges expired rows; unknown code.
2. Control plane: the whole flow with the fake IdP; only the hash of the device code is stored (inspect the store); code alphabet and format; wrong, expired, consumed and denied codes; approval needs a session; a disabled approver is refused; an approved-then-disabled person gets no session; rate limits (429); audit events for every decision and none containing the code; `slow_down` interval grows; label sanitised; unconfigured gives 404; no `Cache-Control` omissions (`no-store` on all).
3. SDK: poll loop with a fake clock (interval, slow_down, expiry, abort, denial); URL building.
4. CLI: key file mode, refusal of a permissive key file, atomic write, profile parse, expired profile, argument parsing.
5. End to end (real control plane, gateway and Chromium, CLI as a child process): `omnisync-cli login` prints a code; the reference app, signed in as Alice in a real browser, shows the request with the CLI's label and approves; the CLI exits 0 with a profile; the certificate it holds connects to the gateway and a signed edit lands in the ledger and verifies; a denied request makes the CLI exit non-zero.

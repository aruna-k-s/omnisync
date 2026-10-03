# Spec: identity, certificates and access control (Phase 1, week 5)

**Purpose.** Replace the static keyring with real identities. A person signs in through the company's OIDC provider, receives a short-lived certificate for a device key, and the gateway admits only holders of a valid certificate whose principal has a role on the document. Every stored update names the certificate that signed it, so the ledger (week 6) can answer "who wrote this, under which authority".

## Trust model

```
 OIDC provider ──id_token──▶ control plane ──certificate──▶ device (holds secret key, never sends it)
                                  │                              │ AUTH proof + signed UPDATEs
                                  ▼                              ▼
                           identity tables  ◀──authorize──── gateway
```

- **Issuer key.** The control plane holds one Ed25519 issuing key. Its public key (or several, during rotation) is configured in every gateway as a trust anchor. Compromise of the issuing key compromises everything, so the production home for it is a KMS/HSM (Phase 2 key hierarchy; the interface already takes a signing callback shape, see `issueCertificate`).
- **Device key.** Generated on the client. Only the public key reaches the control plane. The certificate binds it to a principal for a bounded time.
- **Gateway.** Trusts issuer public keys, not the control plane's network location. It asks the identity store two questions per connection: is this certificate revoked, and what role does this principal hold on this document.
- **Not in scope of the trust model yet:** a malicious gateway (the verifier in week 6 addresses it), hardware-backed device keys (Phase 2), cross-organisation federation (Phase 3).

## Certificate format (`packages/crypto`)

Binary, canonical, no optional fields, so there is exactly one encoding of a given certificate.

| Field | Encoding |
| --- | --- |
| magic, version | `0x4F 0x43` ("OC"), `0x01` |
| serial | 16 random bytes |
| subject (principal id) | varint length (1..128) + UTF-8, charset `[A-Za-z0-9._:@-]` |
| subject public key | 32 bytes Ed25519 |
| issued at, not before, not after | 3 varints, milliseconds since epoch |
| issuer key id | 8 bytes (first 8 of SHA-256 of the issuer public key) |
| signature | 64 bytes Ed25519 over `"omnisync/v1/cert\0" ‖ everything before the signature` |

Decoding rejects: bad magic or version, truncation, trailing bytes, non-minimal varints, subjects outside the charset, `notAfter <= notBefore`, `notBefore < issuedAt`. Verification additionally requires a trusted issuer key id and a valid strict (non-ZIP-215) signature. Time is **not** checked by `verifyCertificate`; the caller decides what a clock reading means (gateway rules below).

`keyId` of the subject key (used in UPDATE frames) is derived exactly as in Phase 0, so an UPDATE names its signer by key id and the certificate by serial in the log.

## Protocol v2 (breaking change to the wire format, `PROTOCOL_VERSION = 2`)

Pre-release, so v1 is not supported alongside. Changes, all in the frame header:

1. **`claimedAtMs` varint** added after `seq`. It is covered by the signature. For UPDATE it is the time the edit was made on the device. AUTH_CHALLENGE uses it for the server clock so clients can detect large skew. Other frames carry 0.
2. **New frame types**: `AUTH_CHALLENGE = 7` (gateway to client, 32-byte nonce), `AUTH_RESPONSE = 8` (client to gateway, certificate and proof), `AUTH_RESULT = 9` (gateway to client, `[role, mode]`).
3. Vectors are regenerated; the old vectors are deleted, not kept. Cross-backend (node and noble) agreement is still asserted.

### Handshake

1. Client opens `/doc/<id>`. The gateway immediately sends `AUTH_CHALLENGE(nonce)`.
2. Client sends `AUTH_RESPONSE`: payload is `varint(len(cert)) ‖ cert ‖ proof`, where `proof` is an Ed25519 signature by the certificate's subject key over `"omnisync/v1/auth\0" ‖ varint(len(docId)) ‖ docId ‖ nonce ‖ SHA-256(cert)`. The proof binds the certificate, the document and this connection's nonce, so a captured response cannot be replayed on another connection or document.
3. Gateway verifies, in order: frame decode; certificate structure; issuer trusted; issuer signature; proof; time window (below); identity store authorization (not revoked, principal enabled, role on the document at least `read`).
4. Success: `AUTH_RESULT [role, mode]`, after which SYNC_1/UPDATE/AWARENESS are accepted. Failure: `ERROR auth_failed;<reason>` and close code 4401 (4403 for `no_access`, 1013 for `unavailable`). Reasons: `unauthenticated`, `malformed`, `timeout`, `untrusted_issuer`, `bad_certificate`, `bad_proof`, `expired`, `not_yet_valid`, `revoked`, `no_access`, `unavailable`.
5. Until step 4 succeeds the only accepted frame is one AUTH_RESPONSE, within `authTimeoutMs` (5 s). Any other frame, any text frame and any undecodable frame close the socket. After success a further AUTH frame is answered `ERROR type_not_allowed` and ignored.
6. **No room is loaded before step 4 succeeds**, so strangers cannot make the gateway cold-load documents.
7. Once the gateway closes a connection (any reason) it processes nothing more from it, even though the WebSocket may stay in CLOSING until the peer answers the close handshake.

## Authorization

Roles are ordered `read < write < merge < admin`. The hierarchy is enforced as a total order, not as independent flags, so no combination can be mis-set.

| Action | Needs |
| --- | --- |
| SYNC_1, receive relayed updates, AWARENESS | `read` |
| UPDATE | `write` |
| Merge shadow branch (Phase 2) | `merge` |
| Change grants on the document | `admin` (control plane) |

Checks in the gateway's UPDATE path, all before the update reaches the store:

- the UPDATE `keyId` equals the authenticated certificate's key id (a connection can only sign as itself);
- role at least `write`; otherwise `ERROR forbidden`, the connection stays open for reading;
- `claimedAtMs` within `[notBefore, notAfter]` of the certificate, and not more than `maxClockSkewMs` (5 min) ahead of the gateway clock;
- per-connection token bucket over **all** frames, taken before any signature work: UPDATE costs 1, AWARENESS 4, SYNC_1 10 (it makes the gateway encode a diff), anything else 1. Defaults 200 tokens/s, burst 400; the burst must be at least 10 or no client could ever sync. Excess is answered `ERROR rate_limited;retry_after_ms=N`, retryable by the client; undecodable junk over the limit is dropped without a reply. A clock that steps backwards never drains the bucket.

The log row stores the certificate serial next to the key id (migration `002`).

## Expiry and offline grace

Certificates are short lived (default 24 h, control plane maximum 7 d). People edit offline, so:

| Gateway clock vs certificate | Mode |
| --- | --- |
| `now < notBefore - maxClockSkewMs` | refused `not_yet_valid` (a device whose clock runs a little ahead of the gateway is tolerated up to the skew) |
| `now <= notAfter` | `full`: read and write per role |
| `notAfter < now <= notAfter + graceMs` (default 72 h) | `upload_only`: UPDATEs whose `claimedAtMs <= notAfter` are accepted and ACKed. SYNC_1 and relays are refused, so a lapsed device can hand in what it wrote but cannot read anything new |
| beyond grace | refused at handshake with `expired` |

A connection that crosses `notAfter` while open is downgraded to `upload_only`, not dropped, and told with `AUTH_RESULT`. The downgrade is applied when the next frame arrives, when the poll runs, and **at the moment of relay**, so an expired peer stops receiving edits at once, not at the next poll. Grace never extends past revocation: a revoked certificate is refused in every mode.

Limit, stated plainly: `claimedAtMs` is asserted by the signer. A stolen key can backdate. The mitigations are revocation (immediate), the gateway's own `received_at` in the log, and the week 6 ledger that makes backdating visible to a verifier.

## Revocation and access changes

The gateway re-authorizes every connection each `revocationPollMs` (default 5 s) with one batched identity-store query. Revoked certificate, disabled principal or lost role closes the socket (4401/4403) or downgrades the role in place. Worst-case latency from revocation to enforcement is therefore one poll interval, and it is a test assertion, not a hope.

If the identity store is unreachable, new connections are refused (`unavailable`, fail closed). Existing connections keep their last known role for at most `revocationMaxStaleMs` (default 60 s) and are closed after that. Three details make this hold under a *hung* database, not just a failing one: every identity call is abandoned after `identityTimeoutMs` (5 s) and counts as unavailable; staleness is checked **before** the query is issued, so it fires whether the query fails, hangs or never returns; and polls never overlap, so a stalled database cannot pile up connections.

## Identity store (`@omnisync/store`)

Migration `002_identity.sql`:

| Table | Purpose |
| --- | --- |
| `principals(id, oidc_issuer, oidc_subject, email, display_name, org_role, disabled_at)` | One row per person; unique on issuer+subject. `org_role` is `member` or `admin` |
| `certificates(serial, principal_id, key_id, public_key, not_before, not_after, issued_at, revoked_at, revoke_reason)` | Every issued certificate; revocation is the only update |
| `document_grants(document_id, principal_id, role, granted_by, granted_at)` | ACL; revocation of a grant deletes the row and writes an audit event |
| `audit_events(id, at, actor, action, target, detail)` | Append-only (trigger, like the update log): sign-in, issuance, revocation, grant changes |
| `document_updates.cert_serial` | Serial of the certificate that signed the update (nullable for pre-identity rows) |

`IdentityStore` has an in-memory twin; both pass the same contract tests. `authorize(items)` is the single hot-path call and is batched.

## Control plane (`apps/control-plane`)

NestJS on Fastify. OIDC authorization-code flow with PKCE, state and nonce via `openid-client`; ID token validated against the IdP's JWKS. The session after login is a short-lived (1 h) token signed by the control plane. Endpoints:

| Endpoint | Rule |
| --- | --- |
| `GET /v1/auth/login`, `GET /v1/auth/callback` | OIDC code flow; callback upserts the principal, audits the sign-in, returns the session token |
| `POST /v1/certificates` | Session required. Body: `publicKey` (base64url), `proof` (enrollment proof), optional `lifetimeMs`. Issues a certificate of `min(requested, maxLifetime)`, at least 60 s. Returns 201 |
| `POST /v1/certificates/:serial/revoke` | Owner of the certificate or org admin |
| `POST /v1/principals/:id/disable` | Org admin; revokes every certificate of the principal |
| `POST /v1/documents` | Any member; creator becomes `admin` of the new document |
| `GET/PUT/DELETE /v1/documents/:id/grants[/:principalId]` | Document `admin`. Not-admin and no-such-document look identical (404). Demoting or removing the last *enabled* admin is refused (409), atomically in the store, so two admins demoting each other at once cannot both succeed |
| `GET /healthz` | Liveness |

**Enrollment proof.** The device signs `"omnisync/v1/enroll\0" ‖ varint(len(principalId)) ‖ principalId ‖ publicKey` with the key being certified. The control plane refuses issuance without it, so nobody can obtain a certificate that binds their identity to someone else's public key.

**Login hardening.**

- The `state` value is also set in an `HttpOnly; SameSite=Lax` cookie (`Secure` when the redirect URI is https) and the callback requires both to match, so a callback URL handed to a different browser (login CSRF / session fixation) is refused. The cookie is cleared after success.
- Each state is single use and expires after 10 minutes.
- Organisation-admin matching by email requires `email_verified = true` in the ID token; an unverified address proves nothing. The role is refreshed at every login.
- `GET /v1/auth/login` is throttled per client IP (default burst 20, 20 per minute; `trustProxy` honours `X-Forwarded-For` behind a reverse proxy). The pending-login table is capped; when full it evicts the oldest entry instead of locking everyone out.

Pending login state (state, nonce, PKCE verifier) lives in memory with a 10-minute TTL, which is correct for one replica. Multi-replica deployment moves it to PostgreSQL (Phase 4, listed in the roadmap).

Tests use an in-process fake IdP built with `jose` (discovery, JWKS, authorize, token with PKCE check) so the whole flow runs in CI with no external service.

## Known limits

- `claimedAtMs` is asserted by the signer (stated above). Revocation, `received_at` and the week 6 ledger bound the damage.
- `audit_events.id` is a `bigserial`, so a consumer that tails by `id > last` can skip a row that commits out of order. Week 6 replaces tailing with a hash-chained, sequence-locked ledger; until then audit readers must read by time range or re-scan.
- `document_updates.cert_serial` has no foreign key: the update log must stay appendable and restorable independently of the identity tables. Invariant 8 is enforced by tests now and by the verifier (week 6) offline.
- The login session token is returned as JSON to the page that completes the redirect. Native and CLI clients need a device-authorization or loopback handoff; that is week 8 (SDK). A per-principal cap on active certificates is also a week 8 item.
- One writer replica, one control-plane replica (pending logins in memory), both lifted in Phase 4.

## Invariants (tests)

1. A certificate that decodes and verifies re-encodes to the identical bytes.
2. Any single-byte change to a certificate makes it fail decode or verify.
3. An AUTH proof for (cert, doc A, nonce N) is rejected for any other cert, doc or nonce.
4. No frame other than AUTH_RESPONSE changes document state before authentication.
5. A connection can never store an UPDATE signed by a key other than its certificate's.
6. A `read` principal never causes a log row; a revoked certificate never does after the next poll, **including frames it sends while its socket is still closing**.
7. `upload_only` accepts only edits claimed before `notAfter` and never sends document content.
8. Every stored row written under auth carries a `cert_serial` that resolves to a certificate row whose key id matches the row's key id.
9. Two concurrent grant changes can never leave a document without an enabled admin.
10. A login callback is accepted only from the browser that started it, once, within 10 minutes.

## Failure modes

| Fault | Behaviour |
| --- | --- |
| Identity store down at connect | `ERROR auth_failed;unavailable`, close |
| Identity store down mid-session | Serve last known role up to `revocationMaxStaleMs`, then close with 1013 |
| IdP down | No new logins or certificates; existing certificates keep working until expiry |
| Control plane down | Same as IdP down for editing; ACL changes unavailable |
| Clock skew on the client | AUTH_CHALLENGE carries server time; SDK warns above 2 min; gateway rejects claimed times more than 5 min in the future |
| Issuer key rotation | Gateways accept several issuer keys; rotate by adding the new key, switching the control plane, removing the old key after the longest certificate lifetime |

## Security notes

Protected paths touched: `packages/protocol/src/{frame,signing}.ts`, `packages/protocol/test/vectors.json` (v2), `packages/crypto/**` (new), `packages/store/migrations/002_identity.sql` and `pg.ts`, gateway authorization in `gateway.ts`. Human review after the 24-hour gap, per AGENTS.md. No new cryptographic primitives: Ed25519 and SHA-256 only, through the existing backends.

## Out of scope

Groups and role inheritance from folders (Phase 2), SCIM provisioning and SAML (Phase 3), hardware-backed device keys and key transparency (Phase 2/3), IP-level throttling of failed handshakes (ingress layer, `deploy/` in week 9), uuid document ids and the document registry table (week 6, with the ledger).

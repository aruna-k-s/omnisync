# Installing OmniSync

This is the runbook for a platform engineer who has not seen the code. The target is a working evaluation in about 30 minutes and a production install in an afternoon. The 30-minute figure is a target we have not yet had someone else measure; if it takes you longer, that is a bug in this document, so please tell us where it did.

## What you need

- A Kubernetes cluster, version 1.28 or newer, that enforces Pod Security `restricted` (the installer labels the namespace; the pods satisfy it) and an ingress controller (ingress-nginx is the default; see "Other ingress controllers").
- [cert-manager](https://cert-manager.io) with a `ClusterIssuer` that can issue certificates for four host names (default name `letsencrypt-prod`).
- Four DNS names pointing at the ingress controller, for example `api.example.com`, `sync.example.com`, `console.example.com`, `app.example.com`.
- An OpenID Connect identity provider and a client for OmniSync (see "Register the OIDC client").
- On your laptop or jump host: `kubectl` (logged in to the cluster), `helm` 3.14 or newer, `openssl` 1.1.1 or newer.
- For production: a PostgreSQL 14+ database and an S3-compatible bucket pair (see "Production").

## Check what you are installing

Every image and the chart are signed by the release workflow. Verify them before the cluster runs them:

```
cosign verify ghcr.io/omnisync/omnisync-gateway@sha256:<digest> \
  --certificate-identity-regexp '^https://github.com/omnisync/omnisync/.github/workflows/release.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Do the same for `omnisync-control-plane`, `omnisync-web` and the chart `ghcr.io/omnisync/charts/omnisync`. The digests are in the release notes. Each release also carries an SBOM per image (SPDX JSON, also attached to the image as a signed attestation, `cosign verify-attestation --type spdxjson`) and the vulnerability scan report. For production, mirror the verified images into your own registry under the release tag and pass `image.registry` (the installer's values file is yours to edit).

## Register the OIDC client

In your identity provider create a public client (authorization code with PKCE; no client secret is required) with the redirect URI `https://<api-host>/v1/auth/callback`. Scopes `openid email profile`. OmniSync refuses users whose email is not verified. Note the issuer URL and client id.

## Evaluation: everything bundled

```
./deploy/install/install.sh \
  --tenant acme \
  --api-host api.example.com --gateway-host sync.example.com \
  --console-host console.example.com --app-host app.example.com \
  --admin-email you@example.com \
  --oidc-issuer https://idp.example.com --oidc-client-id omnisync \
  --retain-days 1 --lock-mode GOVERNANCE \
  --evaluation --keys-out ./omnisync-keys \
  --chart oci://ghcr.io/omnisync/charts/omnisync --version <release>
```

Add `--dry-run` first to see everything the script would do and the values file it would write; it creates nothing. The script then:

1. checks `kubectl`, `helm`, `openssl` and the cluster;
2. creates the namespace and labels it Pod Security `restricted`;
3. generates the certificate-issuer seed, the ledger seed and the session secret, and the bundled database and object-store credentials, and stores them in one Kubernetes Secret (`omnisync-secrets`). It never prints them, never passes them on a command line, and never overwrites an existing Secret;
4. writes `omnisync-values.yaml` (no secrets in it) and runs `helm upgrade --install --wait`.

It ends by printing the console and app URLs, and the **issuer and ledger public keys**. Keep those: auditors use them (out of band) to verify exports.

`--retain-days` is deliberately required with no default. It is how long every ledger checkpoint is locked in the object store. In `COMPLIANCE` mode (the default) nobody, including you and your cloud provider's root account, can shorten or remove the lock before it expires. Use `--lock-mode GOVERNANCE` and a short period for an evaluation; choose the real period for production with your auditors.

The bundled PostgreSQL and MinIO are single pods with no backups. They exist so the evaluation has a database; do not keep anything you care about in them. The gateway restarts for the first minute until the bundled MinIO setup job has created the buckets: that is expected.

## Production

Differences from the evaluation:

- **Database.** Create a PostgreSQL 14+ database and a role that can create tables in it (the gateway and the control plane run their own migrations at start). Put the URL in a file readable only by you: `printf 'postgres://omnisync:...@db.example.com:5432/omnisync' > db-url; chmod 600 db-url`.
- **Buckets.** Create two buckets in an S3-compatible service: one for snapshots, one for checkpoints. The checkpoint bucket **must be created with Object Lock enabled** (this also turns on versioning). Pass `--s3-endpoint`/`--s3-region` for non-AWS services (`--s3-path-style` for most self-hosted ones). The gateway refuses to start against a checkpoint bucket without Object Lock.
- **The S3 credential must not be able to delete.** Give the gateway a user that can get, put, list and read bucket settings and retention, but has no `s3:DeleteObject` or `s3:DeleteObjectVersion` on either bucket. With versioning a plain delete only adds a marker, but the point of the lock is that nothing the gateway can do removes a checkpoint. Put the access key id and secret in two files (mode 600).
- **Network policy.** The chart denies everything except the listed flows. Tell it where your database and object store live: `--postgres-cidr 10.20.0.0/24 --s3-cidr 10.30.0.0/24` (repeat for more ranges), and `--idp-cidr` to narrow the control plane's access to your identity provider (default: any address on port 443).

```
./deploy/install/install.sh ...same required flags... \
  --retain-days 2555 --keys-out ./omnisync-keys \
  --database-url-file db-url --s3-access-key-id-file s3-id --s3-secret-access-key-file s3-secret \
  --s3-endpoint https://s3.example.com --s3-path-style \
  --postgres-cidr 10.20.0.0/24 --s3-cidr 10.30.0.0/24 \
  --chart oci://ghcr.io/omnisync/charts/omnisync --version <release>
```

To keep secrets out of the script entirely, create the Secret yourself (or with the External Secrets Operator: `secrets.externalSecret.enabled`, see the chart's `values.yaml`) with the keys listed in `docs/specs/deployment.md`, and the script will reuse it. Edit `omnisync-values.yaml` for anything the script has no flag for (resources, node selectors, an ingress controller other than ingress-nginx) and run `helm upgrade --install` yourself with it.

### Other ingress controllers

`ingress.className` selects the class. Per-IP throttling at the edge is set with ingress annotations in `ingress.annotations`; the defaults are for ingress-nginx (50 requests per second per IP with a burst factor of 5, 200 connections). They are sized for an office behind one NAT address; raise them if one address carries many people. For another controller replace the annotations with its equivalent. The application's own rate limits stay on either way. Set `networkPolicy.ingressController.namespaceLabels` to the label of the namespace your controller runs in.

## First sign-in

Open `https://<console-host>/` and sign in with the identity provider. A person whose email is in `--admin-email` is an organisation admin on first sign-in. The console lists people, documents, grants and the audit trail. Open `https://<app-host>/` for the reference workbook and try two browsers editing together.

## What to back up

| What | Why |
| --- | --- |
| The **ledger seed** (`ledger-key` in the Secret, or your `--keys-out` copy) | Signs every checkpoint. Lost: cannot be recovered; a new key means a new trust anchor for auditors |
| The **issuer seed** (`issuer-key`) | Signs device certificates. Lost: every device must enrol again |
| The PostgreSQL database | The update log and identity data |
| Both buckets | Snapshots are a cache; checkpoints are the anchors for audits |

Store the seeds offline and separately from the cluster. The two are different keys on purpose.

## Verify your first export

```
# 1. export the ledger from the gateway pod (it already has the database URL and tenant), then copy it out
kubectl -n omnisync exec deploy/omnisync-gateway -c gateway -- node dist/export-cli.js /tmp/ledger.ndjson
kubectl -n omnisync cp omnisync/$(kubectl -n omnisync get pod -l app.kubernetes.io/component=gateway -o name | cut -d/ -f2):/tmp/ledger.ndjson ./ledger.ndjson -c gateway
# 2. download the checkpoint objects (files named <12 digits>.ckpt) from the checkpoint bucket with any S3 client and
#    a read-only credential of your own, into one directory per tenant
# 3. verify with the keys the installer printed (the verifier is packages/verifier: `node packages/verifier/dist/cli.js` in a checkout)
omnisync verify ledger.ndjson --issuer <issuer public key> --ledger-key <ledger public key> --tenant acme --locked ./checkpoints
```

Exit code 0 means every entry is consistent **and anchored** to the locked checkpoints. Exit 3 means consistent but not anchored. Use the public keys the installer printed, not keys fetched from the server being audited.

## Upgrade

`helm upgrade omnisync oci://ghcr.io/omnisync/charts/omnisync --version <new> -n omnisync -f omnisync-values.yaml --wait`. Verify the new signatures first. The gateway is one pod and is replaced with `Recreate`: clients reconnect and replay from their outbox, and the old pod drains and writes a final checkpoint before the new one starts, so expect a short interruption to editing. Migrations run at start; a failed migration keeps the pod from becoming ready.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Pod in `CreateContainerConfigError` | The Secret or a key in it is missing; the event names it. Compare with the key list in `docs/specs/deployment.md` |
| Gateway restarts, log says Object Lock or versioning is required | The checkpoint bucket was not created with Object Lock. Create a new bucket with it enabled; an existing bucket cannot be converted on all services |
| Gateway restarts, log names `OMNISYNC_CHECKPOINT_RETAIN_DAYS` | The retention is missing or out of range (1-36500) |
| Gateway restarts, log mentions the ledger key being readable by others | Only possible if you changed the chart's init container; the key must be mode 0600 |
| Gateway not ready (`/readyz`) | The database or object store is unreachable. Check the network policy CIDRs and credentials |
| Console shows a login redirect error | The redirect URI at the identity provider must be exactly `https://<api-host>/v1/auth/callback`; the console and app origins are the `returnTo` list |
| Sign-in loops or all users share rate limits | The control plane sees the ingress as the client address. The chart sets `OMNISYNC_TRUST_PROXY=1`; if another proxy sits in front of the ingress, raise the hop count |
| Certificates never become ready | cert-manager cannot solve the challenge, or the `ClusterIssuer` name in `ingress.clusterIssuer` is wrong |
| Editing disconnects every hour | Another proxy between the client and the ingress has a shorter WebSocket timeout than `proxy-read-timeout: 3600` |
| `helm install` refuses with a schema message | A required value is missing or malformed; the message names it |
| Evaluation: gateway restarts for a minute after install | The bundled MinIO setup job has not finished creating the buckets yet |

## Uninstall

`helm uninstall omnisync -n omnisync` removes the workloads. It leaves the Secret, the persistent volumes of the bundled services, and any locked checkpoints (locked objects cannot be deleted before their retention ends, by design). Delete the namespace and the Secret yourself when you are sure.

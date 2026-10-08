# Spec: signed images, SBOM, install script and runbook (Phase 1, week 9c)

**Purpose.** A customer should be able to answer three questions without trusting us: *is this the image you built from this commit* (signature and provenance), *what is in it* (SBOM), and *can I get it running in half an hour* (install script and runbook). This spec covers the release workflow, what it publishes and how a customer verifies it, the install script and its safety rules, and what this build can and cannot prove. Images and chart are `deployment.md`.

Non-goals: an admission policy shipped by us (the runbook shows how to verify; the customer's platform team owns the policy), reproducible builds (images are built from pinned inputs but not bit-for-bit reproducible), air-gapped mirroring tooling (the runbook says what to copy), a hosted registry.

## Release workflow (`.github/workflows/release.yml`)

Runs on a tag `vMAJOR.MINOR.PATCH`, and by hand (`workflow_dispatch`) for a dry run that builds and scans but publishes and signs nothing. Workflow-level permissions are `contents: read`; the publishing job adds `packages: write`, `id-token: write` and `attestations: write`; only the final job adds `contents: write` and it runs no third-party action.

| Step | What | Why |
| --- | --- | --- |
| Gate | Requires the CI jobs `check` and `deploy` (lint, build, typecheck, every test, chart and image checks) to have succeeded on the tagged commit, by reading its check runs | A tag on a red or never-tested commit publishes nothing, and the release does not repeat a 15-minute build to find that out |
| Pin base images | Resolves `node:22.22.2-slim` and `nginxinc/nginx-unprivileged:1.28-alpine` to digests at build time (`docker buildx imagetools inspect`) and passes `BASE_IMAGE` / `NGINX_IMAGE` as `name@sha256:...`; the digests go into the release notes | The tag a base image carries can move; the digest used for this release cannot |
| Build | `docker buildx build --target <gateway or control-plane or web>`, `--provenance=mode=max`, pushed to `ghcr.io/omnisync/omnisync-<name>` by tag, then referred to by digest | One build per image, provenance attached |
| SBOM | `syft` over each pushed digest, SPDX JSON, attached as a signed attestation (`cosign attest --type spdxjson`) and as a release asset | The SBOM is bound to the digest it describes, not to a tag |
| Scan | `trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1` on each digest | A fixable high or critical vulnerability stops the release before anything is signed |
| Sign | `cosign sign` by digest, keyless (the GitHub OIDC identity of this workflow at this tag; the certificate goes to the public transparency log) | No long-lived signing key to steal or lose |
| Chart | `helm package` with `version` and `appVersion` from the tag, pushed to `oci://ghcr.io/omnisync/charts`, signed by digest | The chart that names the images is signed too |
| Release | Release notes with the image digests, base image digests, chart digest, the verification commands, and the SBOM and scan reports as assets | One page to start from |

The workflow never runs on a pull request and uses no secret other than the job token.

## Customer verification

```
cosign verify ghcr.io/omnisync/omnisync-gateway@sha256:<digest> \
  --certificate-identity-regexp '^https://github.com/omnisync/omnisync/.github/workflows/release.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify-attestation --type spdxjson ...    # same flags: the SBOM
```

The runbook gives the commands for all three images and the chart. The recommended production route is to verify the digests, mirror them into the customer's own registry under the version tag, and set `image.registry` to that registry.

## Install script (`deploy/install/install.sh`)

One bash script a platform engineer can read in five minutes. It prints each step before doing it:

1. Checks `kubectl`, `helm` (3.14 or newer), `openssl`, and that the cluster answers. It never installs anything.
2. Creates the namespace if missing and labels it for Pod Security `restricted` (`enforce`, `audit`, `warn`).
3. **Generates keys**, only when the Secret does not exist: the certificate issuer seed, the ledger seed, the session secret (32 random bytes each, `openssl rand`, hex), and for an evaluation the bundled PostgreSQL and MinIO credentials and the database and S3 settings that go with them. The public keys are derived from the seeds with `openssl pkey`. Issuer and ledger seeds differ.
4. Creates the Secret with `kubectl create secret generic --from-file` from files in a `umask 077` temporary directory that is removed on exit, including on error and interrupt. **No secret value appears on a command line, in the environment of a child process, in the values file, or in the script's output.**
5. Writes the values file (`omnisync-values.yaml`; it holds no secret) from the arguments: tenant, four hosts, admin emails, OIDC issuer and client id, checkpoint retention (required, no default), evaluation or external services.
6. Runs `helm upgrade --install --wait --timeout 10m`, then prints the URLs, the redirect URI to register with the identity provider, the issuer and ledger public keys (auditors pin these), and what to back up.

Rules. It **never overwrites an existing Secret**: a re-run reuses it, checks that the expected keys are present, and says so. It refuses, before creating anything, when the retention is missing or outside 1 to 36500, when `--evaluation` is combined with external service flags, when a host is not a DNS name, or when a required argument is missing. `--dry-run` prints what it would run and the values file and creates nothing. `--keys-out DIR` also writes the seeds to `DIR` (created 0700, files 0600, never overwritten) for operators who keep their own escrow, because **a lost ledger seed cannot be recovered, and a lost issuer seed means re-enrolling every device**; without it the seeds exist only in the Secret, and the script says so and asks for `--yes` (or an interactive confirmation) before generating them.

## Runbook (`docs/install.md`)

For someone who has not seen the code: prerequisites; a 30-minute timeline (a target, not a measurement); the evaluation path (everything bundled, one command); the production path (external PostgreSQL and S3 with Object Lock, External Secrets, ingress class and throttling, network-policy CIDRs); registering the OIDC client; first sign-in; what to back up (both seeds, the database, both buckets); verifying an export with `omnisync verify` and out-of-band keys; upgrading; the delete-free S3 credential rule; verifying image signatures; and a troubleshooting table keyed by symptom (`CreateContainerConfigError`, each gateway start refusal, certificate not issued, WebSocket drops, login redirect rejected).

## What is proven where

| Check | Where | Status in this build |
| --- | --- | --- |
| Install script behaviour: valid and different seeds, public keys that match the seeds, an existing Secret is never overwritten, no secret in arguments, environment, values file or output, temporary files removed on success, failure and interrupt, required inputs refused before anything is created, dry run creates nothing, Pod Security labels, `helm` receives the values file and the chart | `deploy/tests/test_install_script.py`, with `kubectl` and `helm` stand-ins that record their arguments, environment, standard input and the files they were given | runs here |
| The generated values file and Secret keys are accepted by the chart (schema) and the chart's pods reference exactly the Secret keys the script creates | the same test, rendering the chart with the script's values file | runs here |
| The workflow file's safety properties: triggers, permissions, no `pull_request`, scan fails the job, signing by digest, publish steps skipped on a dry run | `deploy/tests/test_release_workflow.py` | runs here |
| The release builds, scans clean, signs and verifies | the first tagged release | **open**: no container runtime, registry or signing identity here |
| Base image digests and action commit SHAs committed | follow-up | **open**: registries and the GitHub API are unreachable here; base image digests are resolved at release time instead, and actions are pinned by tag |
| Someone other than the author installs on a clean cluster in 30 minutes using only the runbook | the week 9 gate | **open**: needs a cluster and a person |

## Failure modes

| Situation | Result |
| --- | --- |
| Secret already exists | reused; missing keys are named and the script stops |
| Interrupted before the Secret exists | the trap removes the temporary directory; nothing was created in the cluster except possibly the namespace |
| Interrupted after the Secret exists | the next run reuses it; seeds are not regenerated |
| `helm` fails after the Secret was created | the script prints Helm's error, keeps the Secret and the values file, and says to re-run the same command |
| Retention missing or out of range | refused before anything is created |
| Tag on a commit whose checks fail | nothing is published |
| Scan finds a fixable high or critical vulnerability | nothing is signed or released |

## Known limits

Nothing here has run against a real registry, signing service or cluster. The first tagged release and the first install by someone else are the proofs. Third-party actions are pinned by tag, so a compromised tag of an action would reach a release; pinning by commit SHA, with a Dependabot entry to keep them current, is the first follow-up once the GitHub API is reachable. The SBOM says what is in an image, not whether it is exploitable. Keyless signing ties an image to this workflow's identity, not to a person's approval: the repository's tag protection rules are what make a tag a decision.

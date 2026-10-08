#!/usr/bin/env bash
# OmniSync installer. Spec: docs/specs/release.md ("Install script"). Runbook: docs/install.md.
#
# Creates the namespace (Pod Security "restricted"), generates the signing seeds and the Secret the chart reads (only if
# that Secret does not exist yet), writes a values file, and runs `helm upgrade --install`. It installs nothing else and
# never prints, passes on a command line, or puts into the environment a secret value.
#
#   install.sh --tenant acme --api-host api.example.com --gateway-host sync.example.com \
#              --console-host console.example.com --app-host app.example.com \
#              --admin-email you@example.com --oidc-issuer https://idp.example.com --oidc-client-id omnisync \
#              --retain-days 2555 --evaluation --chart oci://ghcr.io/omnisync/charts/omnisync --version 1.0.0
#
# Run with --help for every option.
set -euo pipefail
umask 077

SELF=$(basename "$0")
TMP=""
cleanup() { [ -n "$TMP" ] && [ -d "$TMP" ] && rm -rf "$TMP"; return 0; }
trap cleanup EXIT
trap 'echo "interrupted" >&2; exit 130' INT TERM HUP

usage() {
  cat <<'EOF'
Required
  --tenant NAME              name written into every ledger checkpoint (auditors pin it)
  --api-host H --gateway-host H --console-host H --app-host H     four DNS names pointing at your ingress controller
  --admin-email E            organisation admin on first sign-in (repeatable)
  --oidc-issuer URL --oidc-client-id ID                           your identity provider (https)
  --retain-days N            days each checkpoint stays locked, 1-36500. No default: compliance mode cannot be shortened
  --evaluation               bundle PostgreSQL and MinIO (single pods, no backups)  --- or, for a real install: ---
  --database-url-file F --s3-access-key-id-file F --s3-secret-access-key-file F   (files, so no secret is on a command line)
  --postgres-cidr C --s3-cidr C   (repeatable; the addresses network policy lets the pods reach; or --no-network-policy)

Optional
  --lock-mode COMPLIANCE|GOVERNANCE     default COMPLIANCE
  --s3-endpoint URL --s3-region R --s3-path-style     for a non-AWS S3 service
  --oidc-client-secret-file F --idp-cidr C
  --ingress-class NAME (nginx)  --cluster-issuer NAME (letsencrypt-prod)
  --namespace NS (omnisync)  --release NAME (omnisync)  --secret-name NAME (omnisync-secrets)
  --chart REF (oci://ghcr.io/omnisync/charts/omnisync)  --version V
  --values-out FILE (./omnisync-values.yaml)
  --keys-out DIR             also write both signing seeds to DIR (0700, files 0600, never overwritten)
  --yes                      do not ask before generating seeds that exist only in the cluster
  --dry-run                  print what would happen and the values file; create nothing
EOF
}

die() { echo "$SELF: $*" >&2; exit 2; }
say() { echo "==> $*"; }

# ---- arguments -------------------------------------------------------------------------------------------------
tenant="" api="" gw="" console="" app="" oidc_issuer="" oidc_client="" retain="" lock="COMPLIANCE"
evaluation=0 db_file="" s3_id_file="" s3_secret_file="" oidc_secret_file="" s3_endpoint="" s3_region="" s3_path=0
netpol=1 ingress_class="nginx" cluster_issuer="letsencrypt-prod" namespace="omnisync" release="omnisync"
secret_name="omnisync-secrets" chart="oci://ghcr.io/omnisync/charts/omnisync" version="" values_out="./omnisync-values.yaml"
keys_out="" yes=0 dry=0
admins=() pg_cidrs=() s3_cidrs=() idp_cidrs=()

need_arg() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --tenant) need_arg "$@"; tenant=$2; shift 2 ;;
    --api-host) need_arg "$@"; api=$2; shift 2 ;;
    --gateway-host) need_arg "$@"; gw=$2; shift 2 ;;
    --console-host) need_arg "$@"; console=$2; shift 2 ;;
    --app-host) need_arg "$@"; app=$2; shift 2 ;;
    --admin-email) need_arg "$@"; admins+=("$2"); shift 2 ;;
    --oidc-issuer) need_arg "$@"; oidc_issuer=$2; shift 2 ;;
    --oidc-client-id) need_arg "$@"; oidc_client=$2; shift 2 ;;
    --oidc-client-secret-file) need_arg "$@"; oidc_secret_file=$2; shift 2 ;;
    --retain-days) need_arg "$@"; retain=$2; shift 2 ;;
    --lock-mode) need_arg "$@"; lock=$2; shift 2 ;;
    --evaluation) evaluation=1; shift ;;
    --database-url-file) need_arg "$@"; db_file=$2; shift 2 ;;
    --s3-access-key-id-file) need_arg "$@"; s3_id_file=$2; shift 2 ;;
    --s3-secret-access-key-file) need_arg "$@"; s3_secret_file=$2; shift 2 ;;
    --s3-endpoint) need_arg "$@"; s3_endpoint=$2; shift 2 ;;
    --s3-region) need_arg "$@"; s3_region=$2; shift 2 ;;
    --s3-path-style) s3_path=1; shift ;;
    --postgres-cidr) need_arg "$@"; pg_cidrs+=("$2"); shift 2 ;;
    --s3-cidr) need_arg "$@"; s3_cidrs+=("$2"); shift 2 ;;
    --idp-cidr) need_arg "$@"; idp_cidrs+=("$2"); shift 2 ;;
    --no-network-policy) netpol=0; shift ;;
    --ingress-class) need_arg "$@"; ingress_class=$2; shift 2 ;;
    --cluster-issuer) need_arg "$@"; cluster_issuer=$2; shift 2 ;;
    --namespace) need_arg "$@"; namespace=$2; shift 2 ;;
    --release) need_arg "$@"; release=$2; shift 2 ;;
    --secret-name) need_arg "$@"; secret_name=$2; shift 2 ;;
    --chart) need_arg "$@"; chart=$2; shift 2 ;;
    --version) need_arg "$@"; version=$2; shift 2 ;;
    --values-out) need_arg "$@"; values_out=$2; shift 2 ;;
    --keys-out) need_arg "$@"; keys_out=$2; shift 2 ;;
    --yes) yes=1; shift ;;
    --dry-run) dry=1; shift ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

# ---- validation: everything is checked before anything is created ---------------------------------------------
HOST_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
DNS1123_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
SAFE_RE='^[^[:space:]"'"'"'\\$`]+$' # no whitespace, quotes, backslash, dollar, backtick: values go into YAML and shell unquoted-safe
CIDR_RE='^[0-9a-fA-F:.]+/[0-9]{1,3}$'

[ -n "$tenant" ] || die "--tenant is required"
[[ $tenant =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "--tenant may contain letters, digits, dot, dash and underscore (1-64)"
for pair in "api:$api" "gateway:$gw" "console:$console" "app:$app"; do
  h=${pair#*:}; n=${pair%%:*}
  [ -n "$h" ] || die "--$n-host is required"
  [ ${#h} -le 253 ] && [[ $h =~ $HOST_RE ]] || die "--$n-host must be a DNS name like $n.example.com"
done
[ "$(printf '%s\n' "$api" "$gw" "$console" "$app" | sort -u | wc -l | tr -d ' ')" = 4 ] || die "the four hosts must be different"
[ "${#admins[@]}" -gt 0 ] || die "at least one --admin-email is required"
for e in "${admins[@]}"; do [[ $e =~ ^[^@[:space:]\"\'\\\$\`]+@[^@[:space:]\"\'\\\$\`]+$ ]] || die "not an email address: $e"; done
[ -n "$oidc_issuer" ] && [[ $oidc_issuer =~ ^https://[^[:space:]\"\'\\\$\`]+$ ]] || die "--oidc-issuer must be an https URL"
[ -n "$oidc_client" ] && [[ $oidc_client =~ $SAFE_RE ]] || die "--oidc-client-id is required (no spaces or quotes)"
[ -n "$retain" ] || die "--retain-days is required: how long each ledger checkpoint stays locked. There is no default because COMPLIANCE mode cannot be shortened by anyone"
[[ $retain =~ ^[1-9][0-9]{0,4}$ ]] && [ "$retain" -le 36500 ] || die "--retain-days must be a whole number from 1 to 36500"
case $lock in COMPLIANCE|GOVERNANCE) ;; *) die "--lock-mode must be COMPLIANCE or GOVERNANCE" ;; esac
[[ $namespace =~ $DNS1123_RE ]] || die "--namespace is not a valid Kubernetes name"
[[ $release =~ $DNS1123_RE ]] || die "--release is not a valid Helm release name"
[[ $secret_name =~ $DNS1123_RE ]] || die "--secret-name is not a valid Kubernetes name"
[[ $ingress_class =~ $DNS1123_RE ]] || die "--ingress-class is not a valid name"
[[ $cluster_issuer =~ $DNS1123_RE ]] || die "--cluster-issuer is not a valid name"
[ -z "$version" ] || [[ $version =~ ^[0-9A-Za-z.+_-]{1,64}$ ]] || die "--version is not a chart version"
[[ $chart =~ ^[^[:space:]]+$ ]] || die "--chart must not contain spaces"
case "$chart" in oci://*) [ -n "$version" ] || die "--version is required with an oci:// chart (so the install is repeatable)" ;; esac
[[ $values_out != -* ]] || die "--values-out must not start with a dash"
for c in ${pg_cidrs[@]+"${pg_cidrs[@]}"} ${s3_cidrs[@]+"${s3_cidrs[@]}"} ${idp_cidrs[@]+"${idp_cidrs[@]}"}; do
  [[ $c =~ $CIDR_RE ]] || die "not a CIDR range: $c"
done

if [ "$evaluation" = 1 ]; then
  [ -z "$db_file$s3_id_file$s3_secret_file$s3_endpoint$s3_region" ] && [ "$s3_path" = 0 ] && [ "${#pg_cidrs[@]}${#s3_cidrs[@]}" = 00 ] \
    || die "--evaluation bundles PostgreSQL and MinIO; it cannot be combined with --database-url-file, --s3-* or --postgres-cidr"
else
  [ -n "$db_file" ] && [ -n "$s3_id_file" ] && [ -n "$s3_secret_file" ] \
    || die "choose --evaluation, or give --database-url-file, --s3-access-key-id-file and --s3-secret-access-key-file"
  if [ "$netpol" = 1 ]; then
    [ "${#pg_cidrs[@]}" -gt 0 ] && [ "${#s3_cidrs[@]}" -gt 0 ] \
      || die "network policies are on: give --postgres-cidr and --s3-cidr (the ranges the pods may reach), or --no-network-policy"
  fi
fi
for f in "$db_file" "$s3_id_file" "$s3_secret_file" "$oidc_secret_file"; do
  [ -z "$f" ] || [ -s "$f" ] || die "cannot read $f (or it is empty)"
done
[ -z "$s3_endpoint" ] || [[ $s3_endpoint =~ ^https?://[^[:space:]\"\'\\\$\`]+$ ]] || die "--s3-endpoint must be an http(s) URL"
[ -z "$s3_region" ] || [[ $s3_region =~ ^[a-z][a-z0-9-]{1,29}$ ]] || die "--s3-region is not a region name"
if [ -e "$values_out" ] && [ -d "$values_out" ]; then die "--values-out is a directory"; fi
if [ -n "$keys_out" ] && [ -e "$keys_out" ]; then die "--keys-out $keys_out exists already; it is never overwritten"; fi

command -v openssl >/dev/null || die "openssl is required"
if [ "$dry" = 0 ]; then
  command -v kubectl >/dev/null || die "kubectl is required"
  command -v helm >/dev/null || die "helm (3.14 or newer) is required"
fi

# The chart names things <release>-omnisync unless the release name already contains "omnisync" (templates/_helpers.tpl).
fullname=$release
case $release in *omnisync*) ;; *) fullname="$release-omnisync" ;; esac
fullname=${fullname:0:40}; fullname=${fullname%-}

# ---- key helpers -----------------------------------------------------------------------------------------------
hex64_to_public() { # stdin: a 64 hex character Ed25519 seed (no newline needed); stdout: the 64 hex character public key
  local seed
  IFS= read -r seed || true # the seed file has no trailing newline
  [[ $seed =~ ^[0-9a-f]{64}$ ]] || return 1
  { printf "$(printf '%s' "302e020100300506032b657004220420$seed" | sed 's/../\\x&/g')" |
      openssl pkey -inform DER -pubout -outform DER 2>/dev/null |
      tail -c 32 | od -An -v -tx1 | tr -d ' \n'; } || return 1
}

# ---- plan ------------------------------------------------------------------------------------------------------
write_values() { # $1: path, $2: issuer public key, $3: ledger public key
  {
    echo "# Generated by $SELF. Holds no secret; the Secret \"$secret_name\" holds the seeds and credentials."
    echo "tenant: \"$tenant\""
    echo "hosts: { api: \"$api\", gateway: \"$gw\", console: \"$console\", app: \"$app\" }"
    printf 'adminEmails:\n'; for e in "${admins[@]}"; do printf '  - "%s"\n' "$e"; done
    echo "oidc: { issuer: \"$oidc_issuer\", clientId: \"$oidc_client\" }"
    echo "publicKeys: { issuer: \"$2\", ledger: \"$3\" }"
    echo "secrets: { existingSecret: \"$secret_name\" }"
    echo "storage:"
    echo "  checkpoint: { retainDays: $retain, lockMode: $lock }"
    if [ "$evaluation" = 0 ]; then
      printf '  s3: { endpoint: "%s", region: "%s", pathStyle: %s }\n' "$s3_endpoint" "${s3_region:-us-east-1}" "$([ "$s3_path" = 1 ] && echo true || echo false)"
    fi
    echo "ingress: { className: \"$ingress_class\", clusterIssuer: \"$cluster_issuer\" }"
    if [ "$evaluation" = 1 ]; then
      echo "postgresql: { bundled: { enabled: true } }"
      echo "minio: { enabled: true }"
    fi
    if [ "$netpol" = 0 ]; then
      echo "networkPolicy: { enabled: false }"
    elif [ "$evaluation" = 0 ] || [ "${#idp_cidrs[@]}" -gt 0 ]; then
      echo "networkPolicy:"
      echo "  egress:"
      if [ "$evaluation" = 0 ]; then
        printf '    postgresql: { cidrs: ['; printf '"%s",' "${pg_cidrs[@]}" | sed 's/,$//'; printf '] }\n'
        printf '    s3: { cidrs: ['; printf '"%s",' "${s3_cidrs[@]}" | sed 's/,$//'; printf '] }\n'
      fi
      if [ "${#idp_cidrs[@]}" -gt 0 ]; then
        printf '    idp: { cidrs: ['; printf '"%s",' "${idp_cidrs[@]}" | sed 's/,$//'; printf '] }\n'
      fi
    fi
  } >"$1"
}

if [ "$dry" = 1 ]; then
  say "dry run: nothing will be created"
  say "would label namespace $namespace for Pod Security restricted"
  say "would create Secret $secret_name in $namespace if it does not exist, with: issuer-key ledger-key session-secret database-url s3-access-key-id s3-secret-access-key$([ "$evaluation" = 1 ] && echo ' postgres-password minio-root-user minio-root-password')$([ -n "$oidc_secret_file" ] && echo ' oidc-client-secret')"
  TMP=$(mktemp -d); write_values "$TMP/values.yaml" "<issuer public key, derived from the issuer seed>" "<ledger public key, derived from the ledger seed>"
  say "values file that would be written to $values_out:"; sed 's/^/    /' "$TMP/values.yaml"
  say "would run: helm upgrade --install $release $chart --namespace $namespace -f $values_out --wait --timeout 10m${version:+ --version $version}"
  exit 0
fi

# ---- the cluster -----------------------------------------------------------------------------------------------
say "checking the cluster"
kubectl version >/dev/null 2>&1 || kubectl cluster-info >/dev/null 2>&1 || die "kubectl cannot reach a cluster"
helm_ver=$(helm version --template '{{.Version}}' 2>/dev/null || true)
if [[ $helm_ver =~ ^v3\.([0-9]+)\. ]] && [ "${BASH_REMATCH[1]}" -lt 14 ]; then die "helm $helm_ver is too old (3.14 or newer)"; fi

secret_exists=0
kubectl get secret "$secret_name" -n "$namespace" >/dev/null 2>&1 && secret_exists=1
if [ "$secret_exists" = 0 ] && [ -z "$keys_out" ] && [ "$yes" = 0 ]; then
  if [ -t 0 ]; then
    echo "The signing seeds will exist only in the Secret $secret_name. A lost ledger seed cannot be recovered; a lost issuer seed means re-enrolling every device." >&2
    printf 'Continue without --keys-out? [y/N] ' >&2; read -r ans; case $ans in y|Y|yes) ;; *) die "stopped; re-run with --keys-out DIR to keep a copy" ;; esac
  else
    die "the seeds would exist only in the cluster. Add --keys-out DIR to keep a copy, or --yes to accept that"
  fi
fi

say "namespace $namespace (Pod Security: restricted)"
kubectl get namespace "$namespace" >/dev/null 2>&1 || kubectl create namespace "$namespace" >/dev/null
kubectl label namespace "$namespace" --overwrite \
  pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/audit=restricted pod-security.kubernetes.io/warn=restricted >/dev/null

TMP=$(mktemp -d)
EXPECT="issuer-key ledger-key session-secret database-url s3-access-key-id s3-secret-access-key"
[ "$evaluation" = 1 ] && EXPECT="$EXPECT postgres-password minio-root-user minio-root-password"

if [ "$secret_exists" = 1 ]; then
  say "Secret $secret_name exists: reusing it (never overwritten)"
  [ -z "$keys_out" ] || echo "$SELF: note: --keys-out ignored, the seeds already exist in the cluster and are not read out" >&2
  [ -z "$oidc_secret_file" ] || echo "$SELF: note: --oidc-client-secret-file ignored, the existing Secret is not changed" >&2
  have=$(kubectl get secret "$secret_name" -n "$namespace" -o go-template='{{range $k, $v := .data}}{{$k}} {{end}}')
  missing=""
  for k in $EXPECT; do case " $have " in *" $k "*) ;; *) missing="$missing $k" ;; esac; done
  [ -z "$missing" ] || die "Secret $secret_name lacks:$missing. Add them (kubectl create secret / kubectl patch) or choose another --secret-name"
  issuer_pub=$(kubectl get secret "$secret_name" -n "$namespace" -o jsonpath='{.data.issuer-key}' | base64 -d | hex64_to_public) || die "issuer-key in $secret_name is not a 64 hex character seed"
  ledger_pub=$(kubectl get secret "$secret_name" -n "$namespace" -o jsonpath='{.data.ledger-key}' | base64 -d | hex64_to_public) || die "ledger-key in $secret_name is not a 64 hex character seed"
else
  say "generating keys (nothing is printed)"
  openssl rand -hex 32 | tr -d '\n' >"$TMP/issuer-key"
  openssl rand -hex 32 | tr -d '\n' >"$TMP/ledger-key"
  openssl rand -hex 32 | tr -d '\n' >"$TMP/session-secret"
  [ "$(cat "$TMP/issuer-key")" != "$(cat "$TMP/ledger-key")" ] || die "random generator returned the same seed twice"
  issuer_pub=$(hex64_to_public <"$TMP/issuer-key") || die "this openssl cannot derive Ed25519 public keys (OpenSSL 1.1.1 or newer is needed)"
  ledger_pub=$(hex64_to_public <"$TMP/ledger-key") || die "this openssl cannot derive Ed25519 public keys (OpenSSL 1.1.1 or newer is needed)"
  [ ${#issuer_pub} = 64 ] && [ ${#ledger_pub} = 64 ] || die "this openssl cannot derive Ed25519 public keys (OpenSSL 1.1.1 or newer is needed)"
  if [ "$evaluation" = 1 ]; then
    openssl rand -hex 16 | tr -d '\n' >"$TMP/postgres-password"
    printf 'omnisync-root-%s' "$(openssl rand -hex 4)" >"$TMP/minio-root-user"
    openssl rand -hex 24 | tr -d '\n' >"$TMP/minio-root-password"
    printf 'omnisync-gateway' >"$TMP/s3-access-key-id"
    openssl rand -hex 24 | tr -d '\n' >"$TMP/s3-secret-access-key"
    printf 'postgres://omnisync:%s@%s-postgresql:5432/omnisync' "$(cat "$TMP/postgres-password")" "$fullname" >"$TMP/database-url"
  else
    cp "$db_file" "$TMP/database-url"; cp "$s3_id_file" "$TMP/s3-access-key-id"; cp "$s3_secret_file" "$TMP/s3-secret-access-key"
  fi
  [ -z "$oidc_secret_file" ] || cp "$oidc_secret_file" "$TMP/oidc-client-secret"
  if [ -n "$keys_out" ]; then
    mkdir -m 700 "$keys_out"
    for k in issuer-key ledger-key; do
      [ ! -e "$keys_out/$k" ] || die "$keys_out/$k exists"
      cp "$TMP/$k" "$keys_out/$k"; chmod 600 "$keys_out/$k"
    done
    say "seeds copied to $keys_out (keep them offline and backed up)"
  fi
  args=()
  for f in "$TMP"/*; do args+=("--from-file=$(basename "$f")=$f"); done
  say "creating Secret $secret_name"
  kubectl create secret generic "$secret_name" -n "$namespace" "${args[@]}" >/dev/null
fi

# ---- values and install ----------------------------------------------------------------------------------------
write_values "$TMP/values.yaml" "$issuer_pub" "$ledger_pub"
if [ -e "$values_out" ]; then
  cmp -s "$TMP/values.yaml" "$values_out" || die "$values_out exists and differs from what this run would write; remove it or pass another --values-out"
else
  cp "$TMP/values.yaml" "$values_out"
fi
say "values file: $values_out"

say "helm upgrade --install $release (waiting up to 10 minutes)"
hargs=(upgrade --install "$release" "$chart" --namespace "$namespace" -f "$values_out" --wait --timeout 10m)
[ -z "$version" ] || hargs+=(--version "$version")
if ! helm "${hargs[@]}"; then
  echo >&2
  echo "$SELF: helm failed. The Secret $secret_name and $values_out were kept; fix the cause and re-run the same command." >&2
  exit 1
fi

cat <<EOF

OmniSync is installed (release $release, namespace $namespace).

  Console             https://$console/
  Reference app       https://$app/
  Redirect URI to register with your identity provider (client "$oidc_client"):
                      https://$api/v1/auth/callback

  Certificate issuer public key (auditors pin this):  $issuer_pub
  Ledger public key (auditors pin this):              $ledger_pub

Back up: both seeds (Secret $secret_name: issuer-key, ledger-key), the database, and both buckets.
$([ "$evaluation" = 1 ] && echo "This is an evaluation install: the bundled PostgreSQL and MinIO have no backups. Do not use them for anything you care about.")
Next: docs/install.md ("First sign-in" and "Verify your first export").
EOF

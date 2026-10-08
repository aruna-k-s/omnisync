"""The Helm chart, rendered by deploy/tools/render_chart.py with the three values files in tests/values, checked against
docs/specs/deployment.md: valid Kubernetes objects (kubeconform), the pod hardening rules on every pod, exactly the
network rows of the spec and nothing else, no secret values in manifests, and the schema refusals.

kubeconform is looked for in $OMNISYNC_KUBECONFORM, then PATH. Without it the schema test is skipped unless
OMNISYNC_REQUIRE_KUBECONFORM=1 (CI sets it). Its cert-manager/External Secrets schemas come from the datreeio catalog
over the network."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
from render_chart import TemplateError, manifests, render_chart  # noqa: E402

CHART = os.path.join(HERE, "..", "helm", "omnisync")
VALUES = os.path.join(HERE, "values")
CASES = ["minimal", "evaluation", "production"]
_cache: dict = {}


def render(case, sets=None, release="omnisync"):
    key = (case, tuple(sets or []), release)
    if key not in _cache:
        _cache[key] = render_chart(CHART, [os.path.join(VALUES, case + ".yaml")], list(sets or []), release)
    return _cache[key]


def render_with(case, extra):
    """Render `case` with a further values file made from `extra` (for list and map overrides --set cannot express)."""
    import yaml

    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        yaml.safe_dump(extra, f)
    try:
        return render_chart(CHART, [os.path.join(VALUES, case + ".yaml"), f.name])
    finally:
        os.unlink(f.name)


def docs(case, sets=None, release="omnisync"):
    return manifests(render(case, sets, release))


def pod_specs(ds):
    for d in ds:
        if d["kind"] in ("Deployment", "StatefulSet", "Job"):
            yield d, d["spec"]["template"]["spec"]


def containers(spec):
    return [(c, False) for c in spec.get("containers", [])] + [(c, True) for c in spec.get("initContainers", [])]


class Manifests(unittest.TestCase):
    def test_kubeconform_accepts_every_object(self):
        exe = os.environ.get("OMNISYNC_KUBECONFORM") or shutil.which("kubeconform")
        if not exe or not os.path.exists(exe):
            if os.environ.get("OMNISYNC_REQUIRE_KUBECONFORM") == "1":
                self.fail("kubeconform not found (OMNISYNC_REQUIRE_KUBECONFORM=1)")
            self.skipTest("kubeconform not installed")
        crds = "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"
        for case in CASES:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as t:
                path = os.path.join(t, "all.yaml")
                import yaml

                with open(path, "w") as f:
                    f.write("---\n".join(yaml.safe_dump({k: v for k, v in d.items() if k != "_source"}) for d in docs(case)))
                r = subprocess.run([exe, "-strict", "-summary", "-kubernetes-version", "1.31.0", "-schema-location", "default", "-schema-location", crds, path], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertRegex(r.stdout, r"Invalid: 0, Errors: 0, Skipped: 0")

    def test_object_count_per_case(self):
        kinds = {c: sorted(d["kind"] for d in docs(c)) for c in CASES}
        self.assertEqual(kinds["minimal"].count("Deployment"), 4)  # gateway, control plane, two web apps
        self.assertNotIn("StatefulSet", kinds["minimal"])
        self.assertEqual(kinds["evaluation"].count("StatefulSet"), 2)
        self.assertEqual(kinds["evaluation"].count("Job"), 1)
        self.assertIn("ExternalSecret", kinds["production"])
        self.assertNotIn("ExternalSecret", kinds["minimal"])

    def test_no_secret_object_and_no_secret_literals(self):
        for case in CASES:
            ds = docs(case)
            self.assertNotIn("Secret", [d["kind"] for d in ds], case)
            for d, spec in pod_specs(ds):
                for c, _ in containers(spec):
                    for e in c.get("env", []):
                        if re.search(r"SECRET|PASSWORD|KEY|DATABASE_URL|TOKEN", e["name"]) and not e["name"].endswith(("_FILE", "_PUBLIC_KEY", "_PUBLIC_KEYS")):  # paths and public keys are not secrets
                            self.assertIn("valueFrom", e, f"{case}: {d['metadata']['name']} {e['name']} must come from a Secret")
                            self.assertNotIn("value", e)

    def test_every_secret_reference_names_the_configured_secret(self):
        for case, name in (("minimal", "omnisync-secrets"), ("production", "omnisync-secrets")):
            for d, spec in pod_specs(docs(case)):
                for c, _ in containers(spec):
                    for e in c.get("env", []):
                        ref = e.get("valueFrom", {}).get("secretKeyRef")
                        if ref:
                            self.assertEqual(ref["name"], name)
                for v in spec.get("volumes", []):
                    if "secret" in v:
                        self.assertEqual(v["secret"]["secretName"], name)
        ds = docs("minimal", ["secrets.existingSecret=my-own"])
        names = {e["valueFrom"]["secretKeyRef"]["name"] for _, s in pod_specs(ds) for c, _ in containers(s) for e in c.get("env", []) if "secretKeyRef" in e.get("valueFrom", {})}
        self.assertEqual(names, {"my-own"})

    def test_external_secret_creates_the_named_secret_from_remote_keys(self):
        es = [d for d in docs("production") if d["kind"] == "ExternalSecret"][0]
        self.assertEqual(es["spec"]["target"]["name"], "omnisync-secrets")
        self.assertEqual(es["spec"]["secretStoreRef"], {"name": "vault", "kind": "ClusterSecretStore"})
        self.assertEqual({x["secretKey"]: x["remoteRef"]["key"] for x in es["spec"]["data"]}["ledger-key"], "omnisync/ledger-key")
        self.assertEqual(len(es["spec"]["data"]), 6)


class PodHardening(unittest.TestCase):
    def test_every_pod_follows_the_hardening_rules(self):
        for case in CASES:
            for d, spec in pod_specs(docs(case)):
                who = f"{case}/{d['kind']}/{d['metadata']['name']}"
                ps = spec["securityContext"]
                self.assertIs(ps["runAsNonRoot"], True, who)
                self.assertGreater(ps["runAsUser"], 0, who)
                self.assertEqual(ps["fsGroup"], ps["runAsUser"], who)
                self.assertEqual(ps["seccompProfile"], {"type": "RuntimeDefault"}, who)
                self.assertIs(spec["automountServiceAccountToken"], False, who)
                self.assertTrue(spec.get("serviceAccountName"), who)
                for k in ("hostNetwork", "hostPID", "hostIPC"):
                    self.assertFalse(spec.get(k), who)
                for v in spec.get("volumes", []):
                    self.assertNotIn("hostPath", v, who)
                for c, init in containers(spec):
                    cw = f"{who}/{c['name']}"
                    sc = c["securityContext"]
                    self.assertIs(sc["allowPrivilegeEscalation"], False, cw)
                    self.assertIs(sc["readOnlyRootFilesystem"], True, cw)
                    self.assertEqual(sc["capabilities"], {"drop": ["ALL"]}, cw)
                    self.assertNotIn("privileged", sc, cw)
                    for side in ("requests", "limits"):
                        self.assertIn("cpu", c["resources"][side], cw)
                        self.assertIn("memory", c["resources"][side], cw)
                    self.assertNotRegex(c["image"], r":latest$", cw)
                    self.assertRegex(c["image"], r":[^/:]+$", cw)  # always a tag

    def test_long_running_containers_have_probes(self):
        for case in CASES:
            for d, spec in pod_specs(docs(case)):
                if d["kind"] == "Job":
                    continue
                for c in spec["containers"]:
                    for p in ("livenessProbe", "readinessProbe"):
                        self.assertIn(p, c, f"{case}/{d['metadata']['name']}")

    def test_every_service_account_is_its_own_and_tokenless(self):
        for case in CASES:
            ds = docs(case)
            sas = {d["metadata"]["name"]: d for d in ds if d["kind"] == "ServiceAccount"}
            used = [spec["serviceAccountName"] for _, spec in pod_specs(ds)]
            self.assertEqual(sorted(used), sorted(set(used)), "two workloads share a service account")
            for n in used:
                self.assertIs(sas[n]["automountServiceAccountToken"], False)

    def test_read_only_root_filesystems_have_the_writable_paths_the_programs_need(self):
        need = {"postgresql": {"/var/lib/postgresql/data", "/var/run/postgresql", "/tmp"}, "minio": {"/data", "/tmp"}, "gateway": {"/tmp"}, "control-plane": {"/tmp"}, "web-console": {"/tmp"}, "web-app": {"/tmp"}}
        for d, spec in pod_specs(docs("evaluation")):
            comp = d["spec"]["template"]["metadata"]["labels"]["app.kubernetes.io/component"]
            if comp == "minio-setup":
                comp = None
                need_here = {"/tmp"}
            else:
                need_here = need[comp]
            mounts = {m["mountPath"]: m for c in spec["containers"] for m in c.get("volumeMounts", [])}
            for path in need_here:
                self.assertIn(path, mounts, f"{d['metadata']['name']} has no writable {path}")
                self.assertFalse(mounts[path].get("readOnly"), path)
            declared = {v["name"] for v in spec.get("volumes", [])} | {c["metadata"]["name"] for c in d["spec"].get("volumeClaimTemplates", [])}
            for c, _ in containers(spec):
                for m in c.get("volumeMounts", []):
                    self.assertIn(m["name"], declared, f"{d['metadata']['name']} mounts undeclared volume {m['name']}")

    def test_gateway_is_single_writer_with_recreate(self):
        g = [d for d in docs("minimal") if d["kind"] == "Deployment" and d["metadata"]["name"].endswith("-gateway")][0]
        self.assertEqual(g["spec"]["replicas"], 1)
        self.assertEqual(g["spec"]["strategy"], {"type": "Recreate"})
        self.assertEqual(g["spec"]["template"]["spec"]["terminationGracePeriodSeconds"], 60)

    def test_ledger_key_is_copied_to_a_private_memory_file_only_the_gateway_container_mounts(self):
        g = [s for d, s in pod_specs(docs("minimal")) if d["metadata"]["name"].endswith("-gateway")][0]
        init = g["initContainers"][0]
        self.assertIn("umask 077", init["command"][-1])
        main = g["containers"][0]
        mounts = {m["name"]: m for m in main["volumeMounts"]}
        self.assertNotIn("secrets", mounts)  # the group-readable secret volume is not visible to the gateway itself
        keys = [v for v in g["volumes"] if v["name"] == "keys"][0]
        self.assertEqual(keys["emptyDir"]["medium"], "Memory")
        env = {e["name"]: e.get("value") for e in main["env"]}
        self.assertEqual(env["OMNISYNC_LEDGER_KEY_FILE"], "/keys/ledger-key")

    def test_control_plane_does_not_get_the_ledger_seed_and_gateway_does_not_get_the_issuer_seed(self):
        for d, spec in pod_specs(docs("minimal")):
            n = d["metadata"]["name"]
            items = [i["key"] for v in spec.get("volumes", []) if "secret" in v for i in v["secret"].get("items", [])]
            if n.endswith("-gateway"):
                self.assertEqual(items, ["ledger-key"])
            if n.endswith("-control-plane"):
                self.assertEqual(items, ["issuer-key"])
            if n.endswith("-web-console") or n.endswith("-web-app"):
                self.assertEqual(items, [])
                self.assertFalse(any("secret" in v for v in spec.get("volumes", [])))


class Wiring(unittest.TestCase):
    def env(self, case, suffix, sets=None):
        for d, spec in pod_specs(docs(case, sets)):
            if d["metadata"]["name"].endswith(suffix):
                return {e["name"]: e.get("value") for e in spec["containers"][0]["env"] if "value" in e}
        self.fail(suffix)

    def test_gateway_environment(self):
        e = self.env("minimal", "-gateway")
        self.assertEqual(e["OMNISYNC_TENANT"], "acme")
        self.assertEqual(e["OMNISYNC_ISSUER_PUBLIC_KEYS"], "1" * 64)
        self.assertEqual(e["OMNISYNC_ALLOWED_ORIGINS"], "https://console.acme.test,https://app.acme.test")
        self.assertEqual(e["OMNISYNC_CHECKPOINT_RETAIN_DAYS"], "365")
        self.assertEqual(e["OMNISYNC_CHECKPOINT_LOCK_MODE"], "COMPLIANCE")
        self.assertEqual(e["OMNISYNC_CHECKPOINT_S3_BUCKET"], "omnisync-checkpoints")
        self.assertEqual(e["OMNISYNC_SNAPSHOT_S3_BUCKET"], "omnisync-snapshots")
        self.assertNotIn("OMNISYNC_DATA_DIR", e)
        self.assertNotIn("OMNISYNC_CHECKPOINT_DIR", e)
        self.assertEqual(e["OMNISYNC_S3_PATH_STYLE"], "0")
        self.assertNotIn("OMNISYNC_S3_ENDPOINT", e)  # empty means AWS
        self.assertEqual(e["AWS_EC2_METADATA_DISABLED"], "true")

    def test_gateway_uses_the_bundled_minio_with_path_style(self):
        e = self.env("evaluation", "-gateway")
        self.assertEqual(e["OMNISYNC_S3_ENDPOINT"], "http://omnisync-minio:9000")
        self.assertEqual(e["OMNISYNC_S3_PATH_STYLE"], "1")
        self.assertEqual(e["OMNISYNC_CHECKPOINT_LOCK_MODE"], "GOVERNANCE")
        self.assertEqual(e["OMNISYNC_CHECKPOINT_RETAIN_DAYS"], "1")

    def test_gateway_custom_endpoint_and_names_in_production(self):
        e = self.env("production", "-gateway")
        self.assertEqual(e["OMNISYNC_S3_ENDPOINT"], "https://s3.acme.test")
        self.assertEqual(e["OMNISYNC_S3_REGION"], "eu-central-1")
        self.assertEqual(e["OMNISYNC_S3_PATH_STYLE"], "1")
        self.assertEqual(e["OMNISYNC_CHECKPOINT_RETAIN_DAYS"], "2555")
        self.assertEqual(e["OMNISYNC_ENGINE"], "loro")

    def test_control_plane_environment(self):
        e = self.env("minimal", "-control-plane")
        self.assertEqual(e["OMNISYNC_RETURN_TO"], "https://console.acme.test/,https://app.acme.test/")
        self.assertEqual(e["OMNISYNC_DEVICE_VERIFICATION_URL"], "https://app.acme.test/")
        self.assertIn(e["OMNISYNC_DEVICE_VERIFICATION_URL"], e["OMNISYNC_RETURN_TO"].split(","))
        self.assertEqual(e["OMNISYNC_TRUST_PROXY"], "1")

    def test_web_config_points_at_the_api_and_gateway(self):
        cms = [d for d in docs("minimal") if d["kind"] == "ConfigMap"]
        text = json.dumps(cms)
        self.assertIn("https://api.acme.test", text)
        self.assertIn("wss://sync.acme.test", text)

    def test_csp_allows_only_the_configured_api_and_gateway(self):
        text = json.dumps([d for d in docs("minimal") if d["kind"] == "ConfigMap"])
        m = re.search(r"Content-Security-Policy \\\"([^\"\\]*)\\\"", text)
        self.assertTrue(m, "no CSP header in the web ConfigMap")
        csp = m.group(1)
        self.assertIn("connect-src 'self' https://api.acme.test wss://sync.acme.test", csp)
        self.assertIn("script-src 'self';", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertIn("object-src 'none'", csp)
        self.assertNotIn("unsafe-eval", csp)
        self.assertNotRegex(csp, r"script-src[^;]*unsafe-inline")

    def test_configuration_change_restarts_pods(self):
        def templates(sets=None):
            return {d["metadata"]["name"]: d["spec"]["template"] for d in docs("minimal", sets) if d["kind"] == "Deployment"}

        base = templates()
        # web apps read a mounted ConfigMap, which does not restart a pod by itself: the checksum annotation does
        web = templates(["hosts.api=other-api.acme.test"])
        for n in ("omnisync-web-console", "omnisync-web-app"):
            self.assertTrue(base[n]["metadata"]["annotations"]["checksum/config"], n)
            self.assertNotEqual(base[n]["metadata"]["annotations"]["checksum/config"], web[n]["metadata"]["annotations"]["checksum/config"], n)
        # the gateway and the control plane take their configuration from environment variables in the pod template
        env = templates(["oidc.clientId=another-client"])
        self.assertNotEqual(base["omnisync-control-plane"], env["omnisync-control-plane"])
        self.assertEqual(base["omnisync-gateway"], env["omnisync-gateway"])

    def test_release_name_prefixes_everything(self):
        ds = docs("minimal", release="acme-prod")
        for d in ds:
            self.assertTrue(d["metadata"]["name"].startswith("acme-prod"), d["metadata"]["name"])

    def test_pull_secrets_and_registry_in_production(self):
        for d, spec in pod_specs(docs("production")):
            self.assertEqual(spec["imagePullSecrets"], [{"name": "regcred"}])
            for c, _ in containers(spec):
                self.assertTrue(c["image"].startswith("registry.acme.test/omnisync/"), c["image"])
                self.assertTrue(c["image"].endswith(":1.2.3"), c["image"])
            self.assertEqual(spec["nodeSelector"], {"disktype": "ssd"})

    def test_minio_job_is_not_a_hook_and_changes_name_with_its_inputs(self):
        def job(sets=None):
            return [d for d in docs("evaluation", sets) if d["kind"] == "Job"][0]

        j = job()
        self.assertNotIn("helm.sh/hook", j["metadata"].get("annotations", {}))
        self.assertRegex(j["metadata"]["name"], r"^omnisync-minio-setup-[0-9a-f]{8}$")
        self.assertNotEqual(j["metadata"]["name"], job(["storage.checkpoint.bucket=other"])["metadata"]["name"])
        self.assertEqual(j["metadata"]["name"], job()["metadata"]["name"])

    def test_minio_policy_has_no_delete_action(self):
        cm = [d for d in docs("evaluation") if d["kind"] == "ConfigMap" and d["metadata"]["name"].endswith("minio-policy")][0]
        pol = json.loads(cm["data"]["gateway-policy.json"])
        actions = [a for s in pol["Statement"] for a in s["Action"]]
        self.assertFalse([a for a in actions if "Delete" in a or a == "s3:*"], actions)
        self.assertIn("s3:PutObjectRetention", actions)
        res = [r for s in pol["Statement"] for r in s["Resource"]]
        self.assertIn("arn:aws:s3:::omnisync-checkpoints/*", res)
        script = "\n".join([c for d, s in pod_specs(docs("evaluation")) if d["kind"] == "Job" for c in s["containers"][0]["args"]])
        self.assertIn("--with-lock local/omnisync-checkpoints", script)
        self.assertNotIn("--with-lock local/omnisync-snapshots", script)

    def test_ingress_hosts_tls_and_throttling(self):
        ings = [d for d in docs("minimal") if d["kind"] == "Ingress"]
        hosts = sorted(r["host"] for i in ings for r in i["spec"]["rules"])
        self.assertEqual(hosts, ["api.acme.test", "app.acme.test", "console.acme.test", "sync.acme.test"])
        for i in ings:
            a = i["metadata"]["annotations"]
            self.assertEqual(a["cert-manager.io/cluster-issuer"], "letsencrypt-prod")
            self.assertEqual(a["nginx.ingress.kubernetes.io/limit-rps"], "50")
            self.assertEqual(i["spec"]["ingressClassName"], "nginx")
            self.assertTrue(i["spec"]["tls"])
        gw = [i for i in ings if i["spec"]["rules"][0]["host"] == "sync.acme.test"][0]
        self.assertEqual(gw["metadata"]["annotations"]["nginx.ingress.kubernetes.io/proxy-read-timeout"], "3600")
        api = [i for i in ings if i["spec"]["rules"][0]["host"] == "api.acme.test"][0]
        self.assertNotIn("nginx.ingress.kubernetes.io/proxy-read-timeout", api["metadata"]["annotations"])

    def test_ingress_overrides_in_production(self):
        ings = [d for d in docs("production") if d["kind"] == "Ingress"]
        self.assertTrue(all(i["spec"]["ingressClassName"] == "traefik" for i in ings))
        self.assertTrue(all(i["metadata"]["annotations"]["cert-manager.io/cluster-issuer"] == "acme-ca" for i in ings))
        api = [i for i in ings if i["spec"]["rules"][0]["host"] == "api.acme.test"][0]
        self.assertEqual(api["spec"]["tls"][0]["secretName"], "acme-api-tls")


def peer(p):
    if "ipBlock" in p:
        return "cidr " + p["ipBlock"]["cidr"]
    parts = []
    if "namespaceSelector" in p:
        parts.append("ns " + ",".join(f"{k}={v}" for k, v in p["namespaceSelector"]["matchLabels"].items()))
    if "podSelector" in p:
        ps = p["podSelector"]
        if "matchLabels" in ps:
            parts.append("pods " + ",".join(f"{k.split('/')[-1]}={v}" for k, v in sorted(ps["matchLabels"].items()) if not k.endswith("instance")))
        else:
            parts.append("pods " + ",".join(f"{e['key'].split('/')[-1]} in {'|'.join(e['values'])}" for e in ps["matchExpressions"] if not e["key"].endswith("instance")))
    return " ".join(parts)


def rows(ds):
    out = set()
    for d in ds:
        if d["kind"] != "NetworkPolicy":
            continue
        s = d["spec"]
        sel = s["podSelector"]
        if "matchLabels" in sel:
            sel_s = ",".join(f"{k.split('/')[-1]}={v}" for k, v in sorted(sel["matchLabels"].items()) if not k.endswith("instance"))
        else:
            sel_s = ",".join(f"{e['key'].split('/')[-1]} in {'|'.join(e['values'])}" for e in sel["matchExpressions"] if not e["key"].endswith("instance"))
        if s["policyTypes"] == ["Ingress", "Egress"] and not s.get("ingress") and not s.get("egress"):
            out.add(f"[{sel_s}] deny all")
        for direction in ("ingress", "egress"):
            for r in s.get(direction, []):
                for p in r.get("from" if direction == "ingress" else "to", []):
                    for port in r["ports"]:
                        out.add(f"[{sel_s}] {direction} {peer(p)} {port['protocol']}/{port['port']}")
    return out


DENY = "[part-of=omnisync] deny all"
DNS = "[part-of=omnisync] egress ns kubernetes.io/metadata.name=kube-system pods k8s-app=kube-dns "
WEB = "[component in gateway|control-plane|web-console|web-app] ingress ns kubernetes.io/metadata.name=ingress-nginx "


class Network(unittest.TestCase):
    def test_minimal_has_exactly_the_spec_rows(self):
        self.assertEqual(
            rows(docs("minimal")),
            {
                DENY,
                DNS + "UDP/53",
                DNS + "TCP/53",
                WEB + "TCP/8080",
                WEB + "TCP/8081",
                "[component=gateway] egress cidr 10.20.0.0/24 TCP/5432",
                "[component=gateway] egress cidr 10.30.0.0/24 TCP/443",
                "[component=control-plane] egress cidr 10.20.0.0/24 TCP/5432",
                "[component=control-plane] egress cidr 0.0.0.0/0 TCP/443",
            },
        )

    def test_evaluation_has_exactly_the_spec_rows(self):
        self.assertEqual(
            rows(docs("evaluation")),
            {
                DENY,
                DNS + "UDP/53",
                DNS + "TCP/53",
                WEB + "TCP/8080",
                WEB + "TCP/8081",
                "[component=gateway] egress pods component=postgresql TCP/5432",
                "[component=gateway] egress pods component=minio TCP/9000",
                "[component=control-plane] egress pods component=postgresql TCP/5432",
                "[component=control-plane] egress cidr 0.0.0.0/0 TCP/443",
                "[component=postgresql] ingress pods component in gateway|control-plane TCP/5432",
                "[component=minio] ingress pods component in gateway|minio-setup TCP/9000",
                "[component=minio-setup] egress pods component=minio TCP/9000",
            },
        )

    def test_nothing_reaches_the_web_pods_except_the_ingress_controller_and_they_have_no_egress(self):
        for case in CASES:
            r = rows(docs(case))
            self.assertFalse([x for x in r if x.startswith("[component=web")], case)
            self.assertFalse([x for x in r if "component=gateway] ingress" in x or "component=control-plane] ingress" in x])
            # no gateway <-> control plane traffic
            self.assertFalse([x for x in r if "egress pods component=control-plane" in x or "egress pods component=gateway" in x])

    def test_production_idp_and_ingress_controller_overrides(self):
        r = rows(docs("production"))
        self.assertIn("[component=control-plane] egress cidr 192.0.2.0/24 TCP/443", r)
        self.assertNotIn("[component=control-plane] egress cidr 0.0.0.0/0 TCP/443", r)
        self.assertTrue([x for x in r if "kubernetes.io/metadata.name=traefik" in x])

    def test_policies_can_be_switched_off(self):
        self.assertEqual([d for d in docs("minimal", ["networkPolicy.enabled=false"]) if d["kind"] == "NetworkPolicy"], [])

    def test_every_workload_pod_is_covered_by_the_default_deny(self):
        for case in CASES:
            for d, spec in pod_specs(docs(case)):
                labels = d["spec"]["template"]["metadata"]["labels"]
                self.assertEqual(labels["app.kubernetes.io/part-of"], "omnisync")
                self.assertEqual(labels["app.kubernetes.io/instance"], "omnisync")


class Schema(unittest.TestCase):
    def refused(self, sets, text, case="minimal"):
        with self.assertRaises(TemplateError) as cm:
            render_chart(CHART, [os.path.join(VALUES, case + ".yaml")], sets)
        self.assertIn(text, str(cm.exception))

    def test_the_checkpoint_retention_has_no_default(self):
        self.refused(["storage.checkpoint.retainDays=null"], "retainDays")

    def test_retention_bounds(self):
        self.refused(["storage.checkpoint.retainDays=0"], "retainDays")
        self.refused(["storage.checkpoint.retainDays=36501"], "retainDays")
        self.refused(["storage.checkpoint.retainDays=abc"], "retainDays")
        render_chart(CHART, [os.path.join(VALUES, "minimal.yaml")], ["storage.checkpoint.retainDays=36500"])

    def test_gateway_replicas_above_one_is_refused(self):
        self.refused(["gateway.replicas=2"], "replicas")

    def test_control_plane_replicas_bounds(self):
        render_chart(CHART, [os.path.join(VALUES, "minimal.yaml")], ["controlPlane.replicas=2"])
        self.refused(["controlPlane.replicas=3"], "replicas")
        self.refused(["controlPlane.replicas=0"], "replicas")

    def test_required_strings_missing(self):
        for s in ("tenant", "hosts.api", "hosts.gateway", "hosts.console", "hosts.app", "oidc.issuer", "oidc.clientId", "publicKeys.issuer", "publicKeys.ledger"):
            with self.subTest(s=s):
                self.refused([f"{s}="], s.split(".")[-1])

    def test_admin_emails_required(self):
        with self.assertRaises(TemplateError) as cm:
            render_with("minimal", {"adminEmails": []})
        self.assertIn("adminEmails", str(cm.exception))

    def test_public_keys_must_be_64_hex(self):
        self.refused(["publicKeys.issuer=abc"], "issuer")
        self.refused(["publicKeys.ledger=" + "g" * 64], "ledger")

    def test_lock_mode_and_engine_enumerations(self):
        self.refused(["storage.checkpoint.lockMode=NONE"], "lockMode")
        self.refused(["engine=sqlite"], "engine")

    def test_unknown_top_level_value_is_refused(self):
        self.refused(["gatway.replicas=1"], "gatway")

    def test_external_services_need_cidrs_when_policies_are_on(self):
        for svc in ("postgresql", "s3"):
            with self.subTest(svc=svc), self.assertRaises(TemplateError) as cm:
                render_with("minimal", {"networkPolicy": {"egress": {svc: {"cidrs": []}}}})
            self.assertIn("cidrs", str(cm.exception))
        # not needed when the service is bundled, or when the policies are off
        render_with("evaluation", {})
        render_with("minimal", {"networkPolicy": {"enabled": False, "egress": {"s3": {"cidrs": []}, "postgresql": {"cidrs": []}}}})

    def test_bundled_service_images_must_carry_a_tag_or_digest(self):
        for img in ("minio/minio:latest", "minio/minio", "postgres"):
            with self.subTest(img=img):
                self.refused([f"minio.image={img}"], "image")
        self.refused(["postgresql.bundled.image=postgres:latest"], "image")
        render_chart(CHART, [os.path.join(VALUES, "minimal.yaml")], ["minio.image=minio/minio@sha256:" + "a" * 64])

    def test_host_names_are_dns_names_and_the_pattern_has_no_lookahead(self):
        # Helm validates with Go's regexp (RE2), which has no lookahead: a pattern that needs one fails every install
        self.assertNotIn("(?", open(os.path.join(CHART, "values.schema.json")).read())
        self.refused(["hosts.api=Not_A_Host"], "api")
        self.refused(["hosts.api=localhost"], "api")
        self.refused(["hosts.api=" + "a" * 250 + ".example.com"], "api")


if __name__ == "__main__":
    unittest.main()

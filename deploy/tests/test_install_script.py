"""deploy/install/install.sh, run for real against stand-ins for kubectl and helm (tests/fakes) that keep Secrets in a
directory and log every argument and environment they are given. Spec: docs/specs/release.md ("Install script")."""
import base64
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
from render_chart import manifests, render_chart  # noqa: E402

SCRIPT = os.path.join(HERE, "..", "install", "install.sh")
CHART = os.path.join(HERE, "..", "helm", "omnisync")
FAKES = os.path.join(HERE, "fakes")

BASE = [
    "--tenant", "acme",
    "--api-host", "api.acme.test", "--gateway-host", "sync.acme.test", "--console-host", "console.acme.test", "--app-host", "app.acme.test",
    "--admin-email", "admin@acme.test",
    "--oidc-issuer", "https://idp.acme.test", "--oidc-client-id", "omnisync",
    "--retain-days", "365",
    "--chart", CHART,
]


def node_public(seed_hex):
    js = "import {createPrivateKey,createPublicKey} from 'node:crypto';const k=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(process.argv[1],'hex')]),format:'der',type:'pkcs8'});console.log(createPublicKey(k).export({format:'der',type:'spki'}).subarray(-32).toString('hex'))"
    return subprocess.run(["node", "--input-type=module", "-e", js, seed_hex], capture_output=True, text=True, check=True).stdout.strip()


class Install(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="install-test-")
        self.addCleanup(shutil.rmtree, self.d, ignore_errors=True)
        self.state = os.path.join(self.d, "state")
        self.tmpdir = os.path.join(self.d, "tmp")
        self.work = os.path.join(self.d, "work")
        for p in (self.state, self.tmpdir, self.work):
            os.mkdir(p)
        self.values = os.path.join(self.work, "omnisync-values.yaml")

    def env(self, **extra):
        e = {"PATH": FAKES + os.pathsep + os.environ["PATH"], "HOME": self.d, "TMPDIR": self.tmpdir, "FAKE_STATE": self.state}
        e.update(extra)
        return e

    def run_script(self, *args, base=True, env=None, stdin=subprocess.DEVNULL):
        argv = ["bash", SCRIPT, *(BASE if base else []), "--values-out", self.values, *args]
        return subprocess.run(argv, capture_output=True, text=True, env=env or self.env(), cwd=self.work, stdin=stdin)

    def calls(self):
        p = os.path.join(self.state, "calls.jsonl")
        return [json.loads(l) for l in open(p)] if os.path.exists(p) else []

    def secret(self, name="omnisync-secrets", ns="omnisync"):
        d = os.path.join(self.state, "secrets", f"{ns}-{name}")
        return {k: open(os.path.join(d, k)).read() for k in os.listdir(d)} if os.path.isdir(d) else None

    def mutating(self):
        return [c for c in self.calls() if c["tool"] == "helm" and c["argv"][:1] == ["upgrade"] or c["tool"] == "kubectl" and c["argv"][:1] in (["create"], ["label"])]

    def assert_no_secret_leaked(self, result, extra=()):
        sec = self.secret() or {}
        values = [v for v in sec.values() if len(v) >= 8] + list(extra)
        self.assertTrue(values)
        haystacks = {"stdout": result.stdout, "stderr": result.stderr}
        if os.path.exists(self.values):
            haystacks["values file"] = open(self.values).read()
        for i, c in enumerate(self.calls()):
            haystacks[f"{c['tool']} argv #{i}"] = " ".join(c["argv"])
            haystacks[f"{c['tool']} env #{i}"] = json.dumps(c["env"])
        for name, text in haystacks.items():
            for v in values:
                self.assertNotIn(v, text, f"a secret value reached {name}")

    # ----------------------------------------------------------------------------------------------------------------
    def test_evaluation_install_creates_everything_and_leaks_nothing(self):
        r = self.run_script("--evaluation", "--yes")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        sec = self.secret()
        self.assertEqual(set(sec), {"issuer-key", "ledger-key", "session-secret", "database-url", "s3-access-key-id", "s3-secret-access-key", "postgres-password", "minio-root-user", "minio-root-password"})
        for k in ("issuer-key", "ledger-key"):
            self.assertRegex(sec[k], r"^[0-9a-f]{64}$")
        self.assertRegex(sec["session-secret"], r"^[0-9a-f]{64}$")
        self.assertNotEqual(sec["issuer-key"], sec["ledger-key"])
        self.assertEqual(len({sec["issuer-key"], sec["ledger-key"], sec["session-secret"]}), 3)
        v = yaml.safe_load(open(self.values))
        self.assertEqual(v["publicKeys"], {"issuer": node_public(sec["issuer-key"]), "ledger": node_public(sec["ledger-key"])})
        self.assertIn(v["publicKeys"]["issuer"], r.stdout)
        self.assertIn(v["publicKeys"]["ledger"], r.stdout)
        self.assertIn("https://api.acme.test/v1/auth/callback", r.stdout)
        self.assert_no_secret_leaked(r)
        labels = json.load(open(os.path.join(self.state, "labels-omnisync")))
        self.assertEqual(sorted(labels), sorted(f"pod-security.kubernetes.io/{m}=restricted" for m in ("enforce", "audit", "warn")))
        helm = [c for c in self.calls() if c["tool"] == "helm" and c["argv"][:1] == ["upgrade"]][0]["argv"]
        self.assertEqual(helm[:3], ["upgrade", "--install", "omnisync"])
        self.assertIn("--wait", helm)
        self.assertEqual(helm[helm.index("--namespace") + 1], "omnisync")
        self.assertEqual(os.listdir(self.tmpdir), [], "temporary files were left behind")

    def test_files_a_secret_is_made_from_are_private(self):
        r = self.run_script("--evaluation", "--yes")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        modes = [json.loads(l) for l in open(os.path.join(self.state, "modes.jsonl"))]
        self.assertEqual(len(modes), 9)
        for m in modes:
            self.assertEqual(m["file"], "0o600", m)
            self.assertEqual(m["dir"], "0o700", m)

    def test_values_file_is_accepted_by_the_chart_and_the_chart_reads_only_keys_the_script_created(self):
        for extra, label in ((["--evaluation", "--yes"], "evaluation"), (None, "external")):
            with self.subTest(label), tempfile.TemporaryDirectory() as t:
                self.setUp()
                if extra is None:
                    for n, c in (("db", "postgres://u:pw@db.acme.test:5432/omnisync"), ("id", "AKIAEXAMPLE0000000"), ("sk", "s3-secret-value-0000")):
                        open(os.path.join(self.work, n), "w").write(c)
                    extra = ["--database-url-file", "db", "--s3-access-key-id-file", "id", "--s3-secret-access-key-file", "sk", "--postgres-cidr", "10.20.0.0/24", "--s3-cidr", "10.30.0.0/24", "--s3-endpoint", "https://s3.acme.test", "--s3-path-style", "--yes"]
                r = self.run_script(*extra)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                created = set(self.secret())
                docs = manifests(render_chart(CHART, [self.values]))
                referenced = set()
                for d in docs:
                    if d["kind"] in ("Deployment", "StatefulSet", "Job"):
                        spec = d["spec"]["template"]["spec"]
                        for c in spec.get("containers", []) + spec.get("initContainers", []):
                            for e in c.get("env", []):
                                ref = e.get("valueFrom", {}).get("secretKeyRef")
                                if ref and not ref.get("optional"):
                                    referenced.add(ref["key"])
                        for vol in spec.get("volumes", []):
                            for it in vol.get("secret", {}).get("items", []):
                                referenced.add(it["key"])
                self.assertEqual(referenced - created, set(), "the chart reads Secret keys the script did not create")
                if label == "evaluation":
                    self.assertEqual(created - referenced, set())

    def test_bundled_database_url_names_the_service_the_chart_creates_for_any_release_name(self):
        for release in ("omnisync", "prod", "acme-omnisync-eu", "a" * 45):
            with self.subTest(release=release):
                self.setUp()
                r = self.run_script("--evaluation", "--yes", "--release", release)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                host = re.search(r"@([^:]+):5432", self.secret()["database-url"]).group(1)
                svc = [d["metadata"]["name"] for d in manifests(render_chart(CHART, [self.values], release=release)) if d["kind"] == "Service" and d["metadata"]["name"].endswith("postgresql")]
                self.assertEqual(svc, [host])

    def test_external_services_come_from_files_and_never_from_the_command_line(self):
        open(os.path.join(self.work, "db"), "w").write("postgres://app:sup3rsecretpw@db.acme.test:5432/omnisync")
        open(os.path.join(self.work, "id"), "w").write("AKIAEXAMPLEKEYID1234")
        open(os.path.join(self.work, "sk"), "w").write("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
        r = self.run_script("--database-url-file", "db", "--s3-access-key-id-file", "id", "--s3-secret-access-key-file", "sk", "--postgres-cidr", "10.20.0.0/24", "--s3-cidr", "10.30.0.0/24", "--yes")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        sec = self.secret()
        self.assertEqual(sec["database-url"], "postgres://app:sup3rsecretpw@db.acme.test:5432/omnisync")
        self.assertNotIn("postgres-password", sec)
        v = yaml.safe_load(open(self.values))
        self.assertEqual(v["networkPolicy"]["egress"]["postgresql"]["cidrs"], ["10.20.0.0/24"])
        self.assertNotIn("postgresql", v)
        self.assert_no_secret_leaked(r, extra=["sup3rsecretpw", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"])

    def test_an_existing_secret_is_never_overwritten_and_the_public_keys_come_from_it(self):
        self.assertEqual(self.run_script("--evaluation", "--yes").returncode, 0)
        before = self.secret()
        first_values = open(self.values).read()
        n_create = sum(1 for c in self.calls() if c["argv"][:3] == ["create", "secret", "generic"])
        r = self.run_script("--evaluation", "--yes")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.secret(), before)
        self.assertEqual(sum(1 for c in self.calls() if c["argv"][:3] == ["create", "secret", "generic"]), n_create)
        self.assertEqual(open(self.values).read(), first_values)
        self.assertIn("reusing", r.stdout)
        self.assert_no_secret_leaked(r)

    def test_an_existing_secret_with_missing_keys_stops_and_names_them(self):
        d = os.path.join(self.state, "secrets", "omnisync-omnisync-secrets")
        os.makedirs(d)
        open(os.path.join(d, "issuer-key"), "w").write("0" * 64)
        os.makedirs(os.path.join(self.state, "ns", "omnisync"))
        r = self.run_script("--evaluation", "--yes")
        self.assertEqual(r.returncode, 2)
        for k in ("ledger-key", "session-secret", "database-url"):
            self.assertIn(k, r.stderr)
        self.assertEqual([c for c in self.calls() if c["tool"] == "helm"][:1], [c for c in self.calls() if c["tool"] == "helm" and c["argv"][:1] == ["version"]][:1])
        self.assertFalse([c for c in self.calls() if c["tool"] == "helm" and c["argv"][:1] == ["upgrade"]])

    def test_dry_run_creates_nothing_and_needs_no_cluster(self):
        env = {"PATH": "/usr/bin:/bin", "HOME": self.d, "TMPDIR": self.tmpdir}  # no kubectl, no helm
        r = self.run_script("--evaluation", "--dry-run", env=env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("nothing will be created", r.stdout)
        self.assertIn("helm upgrade --install omnisync", r.stdout)
        self.assertIn('tenant: "acme"', r.stdout)
        self.assertFalse(os.path.exists(self.values))
        self.assertEqual(os.listdir(self.state), [])
        self.assertEqual(os.listdir(self.tmpdir), [])

    def test_required_inputs_are_refused_before_anything_is_created(self):
        cases = {
            "no retention": (["--evaluation", "--yes"], {"drop": "--retain-days"}, "retain-days is required"),
            "retention zero": (["--evaluation", "--yes", "--retain-days", "0"], {"drop": "--retain-days"}, "1 to 36500"),
            "retention too long": (["--evaluation", "--yes", "--retain-days", "36501"], {"drop": "--retain-days"}, "1 to 36500"),
            "retention not a number": (["--evaluation", "--yes", "--retain-days", "30d"], {"drop": "--retain-days"}, "1 to 36500"),
            "bad lock mode": (["--evaluation", "--yes", "--lock-mode", "NONE"], {}, "COMPLIANCE or GOVERNANCE"),
            "no tenant": (["--evaluation", "--yes"], {"drop": "--tenant"}, "--tenant is required"),
            "bad host": (["--evaluation", "--yes"], {"swap": ("--api-host", "Not_A_Host")}, "DNS name"),
            "duplicate hosts": (["--evaluation", "--yes"], {"swap": ("--app-host", "api.acme.test")}, "must be different"),
            "no admin": (["--evaluation", "--yes"], {"drop": "--admin-email"}, "--admin-email"),
            "bad email": (["--evaluation", "--yes"], {"swap": ("--admin-email", "nobody")}, "not an email"),
            "http issuer": (["--evaluation", "--yes"], {"swap": ("--oidc-issuer", "http://idp.acme.test")}, "https"),
            "quote in client id": (["--evaluation", "--yes"], {"swap": ("--oidc-client-id", 'a"b')}, "client-id"),
            "neither evaluation nor external": (["--yes"], {}, "--evaluation, or give"),
            "evaluation with external flag": (["--evaluation", "--yes", "--postgres-cidr", "10.0.0.0/8"], {}, "cannot be combined"),
            "external without cidrs": (["--yes", "--database-url-file", "x", "--s3-access-key-id-file", "x", "--s3-secret-access-key-file", "x"], {}, "--postgres-cidr and --s3-cidr"),
            "bad cidr": (["--evaluation", "--yes", "--idp-cidr", "everyone"], {}, "not a CIDR"),
            "unreadable file": (["--yes", "--database-url-file", "/nonexistent", "--s3-access-key-id-file", "/nonexistent", "--s3-secret-access-key-file", "/nonexistent", "--no-network-policy"], {}, "cannot read"),
            "oci chart without version": (["--evaluation", "--yes", "--chart", "oci://ghcr.io/omnisync/charts/omnisync"], {}, "--version is required"),
            "unknown option": (["--evaluation", "--yes", "--frobnicate"], {}, "unknown option"),
            "seeds only in the cluster, not confirmed": (["--evaluation"], {}, "--keys-out"),
        }
        for name, (extra, mod, msg) in cases.items():
            with self.subTest(name):
                self.setUp()
                base = list(BASE)
                if "drop" in mod:
                    i = base.index(mod["drop"])
                    del base[i : i + 2]
                if "swap" in mod:
                    i = base.index(mod["swap"][0])
                    base[i + 1] = mod["swap"][1]
                chart_i = base.index("--chart")
                if "--chart" in extra:
                    del base[chart_i : chart_i + 2]
                r = subprocess.run(["bash", SCRIPT, *base, "--values-out", self.values, *extra], capture_output=True, text=True, env=self.env(), cwd=self.work, stdin=subprocess.DEVNULL)
                self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
                self.assertIn(msg, r.stderr)
                self.assertEqual(self.mutating(), [], "something was created before the refusal")
                self.assertFalse(os.path.exists(self.values))
                self.assertEqual(os.listdir(self.tmpdir), [])

    def test_keys_out_writes_private_copies_and_never_overwrites(self):
        out = os.path.join(self.work, "escrow")
        r = self.run_script("--evaluation", "--keys-out", out)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(oct(os.stat(out).st_mode & 0o777), "0o700")
        sec = self.secret()
        for k in ("issuer-key", "ledger-key"):
            p = os.path.join(out, k)
            self.assertEqual(oct(os.stat(p).st_mode & 0o777), "0o600")
            self.assertEqual(open(p).read(), sec[k])
        self.assertEqual(sorted(os.listdir(out)), ["issuer-key", "ledger-key"])
        r2 = self.run_script("--evaluation", "--keys-out", out)
        self.assertEqual(r2.returncode, 2)
        self.assertIn("never overwritten", r2.stderr)

    def test_a_different_values_file_is_not_overwritten(self):
        open(self.values, "w").write("# mine\n")
        r = self.run_script("--evaluation", "--yes")
        self.assertEqual(r.returncode, 2)
        self.assertEqual(open(self.values).read(), "# mine\n")
        self.assertFalse([c for c in self.calls() if c["tool"] == "helm" and c["argv"][:1] == ["upgrade"]])

    def test_helm_failure_keeps_the_secret_and_says_how_to_resume(self):
        r = self.run_script("--evaluation", "--yes", env=self.env(FAKE_HELM_FAIL="1"))
        self.assertEqual(r.returncode, 1)
        self.assertIn("re-run the same command", r.stderr)
        self.assertIsNotNone(self.secret())
        self.assertTrue(os.path.exists(self.values))
        self.assertEqual(os.listdir(self.tmpdir), [])
        ok = self.run_script("--evaluation", "--yes")
        self.assertEqual(ok.returncode, 0, ok.stderr)

    def test_an_unreachable_cluster_is_refused_before_anything_is_created(self):
        r = self.run_script("--evaluation", "--yes", env=self.env(FAKE_KUBECTL_DOWN="1"))
        self.assertEqual(r.returncode, 2)
        self.assertIn("cannot reach a cluster", r.stderr)
        self.assertEqual(self.mutating(), [])

    def test_old_helm_is_refused(self):
        r = self.run_script("--evaluation", "--yes", env=self.env(FAKE_HELM_VERSION="v3.9.0"))
        self.assertEqual(r.returncode, 2)
        self.assertIn("too old", r.stderr)
        self.assertEqual(self.mutating(), [])

    def test_interrupt_removes_temporary_files(self):
        p = subprocess.Popen(["bash", SCRIPT, *BASE, "--values-out", self.values, "--evaluation", "--yes"], env=self.env(FAKE_HELM_SLEEP="30"), cwd=self.work, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, start_new_session=True)
        for _ in range(100):
            if os.path.exists(os.path.join(self.state, "helm-running")):
                break
            time.sleep(0.1)
        self.assertTrue(os.path.exists(os.path.join(self.state, "helm-running")), "helm stand-in never started")
        os.killpg(p.pid, signal.SIGTERM)
        p.communicate(timeout=20)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(os.listdir(self.tmpdir), [], "temporary files survived an interrupt")

    def test_the_script_never_prints_or_traces_secrets_by_construction(self):
        src = open(SCRIPT).read()
        self.assertNotRegex(src, r"set -[a-z]*x")
        self.assertNotIn("--from-literal", src)
        self.assertNotRegex(src, r"\bexport\s+\w*(KEY|SECRET|PASSWORD)")
        self.assertNotRegex(src, r"echo[^\n]*\$\(cat")


if __name__ == "__main__":
    unittest.main()

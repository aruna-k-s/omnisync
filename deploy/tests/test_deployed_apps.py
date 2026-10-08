"""What the images contain: the gateway and the control plane, pruned the way deploy/docker/Dockerfile prunes them
(`pnpm deploy --prod --legacy`, then the sources and tests removed), start from a directory that holds nothing else, using
only the environment variables the chart sets, and refuse the unsafe configurations the chart's docs promise they refuse.

Needs the apps built (`pnpm build`), PostgreSQL (OMNISYNC_TEST_DATABASE_URL, any database on that server) and an
S3-compatible server (OMNISYNC_TEST_S3_ENDPOINT; boto3 creates the buckets). Skipped without them unless
OMNISYNC_REQUIRE_DEPLOYED=1 (CI sets it)."""
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from urllib.parse import urlparse

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DB = os.environ.get("OMNISYNC_TEST_DATABASE_URL")
S3 = os.environ.get("OMNISYNC_TEST_S3_ENDPOINT")
REQUIRE = os.environ.get("OMNISYNC_REQUIRE_DEPLOYED") == "1"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get(url, timeout=2):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
        return None, ""


def missing():
    why = []
    if not DB:
        why.append("OMNISYNC_TEST_DATABASE_URL")
    if not S3:
        why.append("OMNISYNC_TEST_S3_ENDPOINT")
    for p in ("apps/gateway/dist/serve.js", "apps/control-plane/dist/main.js"):
        if not os.path.exists(os.path.join(ROOT, p)):
            why.append(p + " (run pnpm build)")
    try:
        import boto3  # noqa: F401
    except ImportError:
        why.append("boto3")
    if not shutil.which("psql"):
        why.append("psql")
    return why


class Deployed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        why = missing()
        if why:
            if REQUIRE:
                raise AssertionError("OMNISYNC_REQUIRE_DEPLOYED=1 but missing: " + ", ".join(why))
            raise unittest.SkipTest("missing: " + ", ".join(why))
        cls.tmp = tempfile.mkdtemp(prefix="omnisync-deployed-")
        cls.dirs = {}
        for name, pkg, extra in (("gateway", "@omnisync/gateway", []), ("control-plane", "@omnisync/control-plane", ["vitest.config.ts"])):
            out = os.path.join(cls.tmp, name)
            subprocess.run(["pnpm", "--filter", pkg, "--prod", "deploy", "--legacy", out], cwd=ROOT, check=True, capture_output=True, text=True, env=dict(os.environ, CI="true"))
            for junk in ["src", "test", "tsconfig.json", "tsconfig.test.json", *extra]:
                shutil.rmtree(os.path.join(out, junk), ignore_errors=True) if os.path.isdir(os.path.join(out, junk)) else (os.path.exists(os.path.join(out, junk)) and os.unlink(os.path.join(out, junk)))
            cls.dirs[name] = out
        # a database of our own on the given server, so the suites that share OMNISYNC_TEST_DATABASE_URL are not disturbed
        u = urlparse(DB)
        cls.dbname = "omnisync_deployed_" + secrets.token_hex(4)
        cls.admin = DB
        subprocess.run(["psql", DB, "-v", "ON_ERROR_STOP=1", "-qc", f"CREATE DATABASE {cls.dbname}"], check=True, capture_output=True)
        cls.db_url = u._replace(path="/" + cls.dbname).geturl()
        import boto3

        cls.s3env = {"AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test", "AWS_EC2_METADATA_DISABLED": "true"}
        cls.s3 = boto3.client("s3", endpoint_url=S3, region_name="us-east-1", aws_access_key_id="test", aws_secret_access_key="test")
        cls.buckets = {k: f"omnisync-{k}-{secrets.token_hex(4)}" for k in ("snap", "locked", "plain")}
        cls.s3.create_bucket(Bucket=cls.buckets["snap"])
        cls.s3.create_bucket(Bucket=cls.buckets["locked"], ObjectLockEnabledForBucket=True)
        cls.s3.create_bucket(Bucket=cls.buckets["plain"])
        cls.issuer_seed, cls.ledger_seed = secrets.token_hex(32), secrets.token_hex(32)
        cls.issuer_pub = cls._pub(cls.issuer_seed)
        cls.ledger_pub = cls._pub(cls.ledger_seed)
        cls.key_dir = os.path.join(cls.tmp, "keys")
        os.mkdir(cls.key_dir, 0o700)
        for n, v in (("ledger-key", cls.ledger_seed), ("issuer-key", cls.issuer_seed)):
            fd = os.open(os.path.join(cls.key_dir, n), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.write(fd, v.encode())
            os.close(fd)

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "tmp", None):
            shutil.rmtree(cls.tmp, ignore_errors=True)
        if getattr(cls, "dbname", None):
            subprocess.run(["psql", cls.admin, "-qc", f"DROP DATABASE IF EXISTS {cls.dbname} WITH (FORCE)"], capture_output=True)

    @staticmethod
    def _pub(seed):
        out = subprocess.run(
            ["node", "--input-type=module", "-e", "import {createPrivateKey,createPublicKey} from 'node:crypto';const k=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(process.argv[1],'hex')]),format:'der',type:'pkcs8'});console.log(createPublicKey(k).export({format:'der',type:'spki'}).subarray(-32).toString('hex'))", seed],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()

    # ---------------------------------------------------------------------------------------------------------------
    def env(self, **kw):
        base = {"PATH": os.environ["PATH"], "HOME": self.tmp, "NODE_ENV": "production", **self.s3env}
        base.update({k: v for k, v in kw.items() if v is not None})
        return base

    def gateway_env(self, port, **over):
        e = {
            "PORT": str(port),
            "DATABASE_URL": self.db_url,
            "OMNISYNC_TENANT": "acme",
            "OMNISYNC_ISSUER_PUBLIC_KEYS": self.issuer_pub,
            "OMNISYNC_LEDGER_KEY_FILE": os.path.join(self.key_dir, "ledger-key"),
            "OMNISYNC_ALLOWED_ORIGINS": "https://console.acme.test,https://app.acme.test",
            "OMNISYNC_SNAPSHOT_S3_BUCKET": self.buckets["snap"],
            "OMNISYNC_CHECKPOINT_S3_BUCKET": self.buckets["locked"],
            "OMNISYNC_CHECKPOINT_RETAIN_DAYS": "1",
            "OMNISYNC_CHECKPOINT_LOCK_MODE": "GOVERNANCE",
            "OMNISYNC_S3_ENDPOINT": S3,
            "OMNISYNC_S3_REGION": "us-east-1",
            "OMNISYNC_S3_PATH_STYLE": "1",
        }
        e.update(over)
        return self.env(**e)

    def run_until(self, name, entry, env, ready_url=None, timeout=25):
        p = subprocess.Popen(["node", entry], cwd=self.dirs[name], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        deadline = time.time() + timeout
        status = None
        while time.time() < deadline:
            if p.poll() is not None:
                break
            if ready_url:
                status, _ = get(ready_url)
                if status == 200:
                    break
            time.sleep(0.2)
        return p, status

    def refused(self, p):
        """The process must have exited on its own with an error; one that is still running (and is killed by stop) refused nothing."""
        exited_by_itself = p.poll() is not None
        out = self.stop(p)
        self.assertTrue(exited_by_itself, "the process kept running instead of refusing the configuration:\n" + out)
        self.assertNotEqual(p.returncode, 0, out)
        return out

    def stop(self, p):
        if p.poll() is None:
            p.send_signal(signal.SIGTERM)
            try:
                p.wait(timeout=15)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
        return p.stdout.read()

    # ---------------------------------------------------------------------------------------------------------------
    def test_pruned_directories_hold_production_dependencies_and_no_sources(self):
        for name, d in self.dirs.items():
            self.assertTrue(os.path.isdir(os.path.join(d, "dist")), name)
            self.assertFalse(os.path.exists(os.path.join(d, "src")), name)
            self.assertFalse(os.path.exists(os.path.join(d, "test")), name)
            store = os.path.realpath(os.path.join(d, "node_modules", "@omnisync", "store"))
            self.assertTrue(store.startswith(os.path.realpath(d)), f"{name}: @omnisync/store resolves outside the deployed directory: {store}")
            self.assertTrue(os.path.exists(os.path.join(store, "dist", "index.js")))
            installed = set(os.listdir(os.path.join(d, "node_modules", ".pnpm"))) if os.path.isdir(os.path.join(d, "node_modules", ".pnpm")) else set()
            joined = " ".join(installed)
            for dev in ("vitest@", "typescript@", "eslint@", "fast-check@", "@swc+core@"):
                self.assertNotIn(dev, joined, f"{name} ships dev dependency {dev}")

    def test_gateway_starts_from_the_pruned_directory_and_becomes_ready(self):
        port = free_port()
        p, status = self.run_until("gateway", "dist/serve.js", self.gateway_env(port), f"http://127.0.0.1:{port}/readyz")
        try:
            self.assertEqual(status, 200, "gateway never became ready")
            self.assertEqual(get(f"http://127.0.0.1:{port}/healthz")[0], 200)
        finally:
            out = self.stop(p)
        self.assertEqual(p.returncode, 0, out)
        for secret in (self.ledger_seed, self.issuer_seed):
            self.assertNotIn(secret, out)

    def test_the_export_command_the_runbook_uses_works_from_the_deployed_directory(self):
        out = os.path.join(self.tmp, "ledger-export.ndjson")
        env = self.gateway_env(free_port())
        r = subprocess.run(["node", "dist/export-cli.js", out], cwd=self.dirs["gateway"], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("exported", r.stderr)
        self.assertEqual(oct(os.stat(out).st_mode & 0o777), "0o600")

    def test_gateway_refuses_a_ledger_key_others_can_read(self):
        bad = os.path.join(self.key_dir, "ledger-readable")
        with open(bad, "w") as f:
            f.write(self.ledger_seed)
        os.chmod(bad, 0o640)
        port = free_port()
        p, _ = self.run_until("gateway", "dist/serve.js", self.gateway_env(port, OMNISYNC_LEDGER_KEY_FILE=bad), None, timeout=10)
        out = self.refused(p)
        self.assertRegex(out, r"(?i)group|other|readable|permission")
        self.assertNotIn(self.ledger_seed, out)

    def test_gateway_refuses_a_checkpoint_bucket_without_object_lock(self):
        port = free_port()
        p, _ = self.run_until("gateway", "dist/serve.js", self.gateway_env(port, OMNISYNC_CHECKPOINT_S3_BUCKET=self.buckets["plain"]), None, timeout=15)
        out = self.refused(p)
        self.assertRegex(out, r"(?i)object lock")

    def test_gateway_refuses_to_start_without_a_retention_period(self):
        port = free_port()
        env = self.gateway_env(port)
        del env["OMNISYNC_CHECKPOINT_RETAIN_DAYS"]
        p, _ = self.run_until("gateway", "dist/serve.js", env, None, timeout=10)
        out = self.refused(p)
        self.assertRegex(out, r"RETAIN_DAYS")

    def test_gateway_refuses_the_same_key_as_issuer_and_ledger(self):
        port = free_port()
        p, _ = self.run_until("gateway", "dist/serve.js", self.gateway_env(port, OMNISYNC_ISSUER_PUBLIC_KEYS=self.ledger_pub), None, timeout=10)
        out = self.refused(p)
        self.assertRegex(out, r"(?i)issuer|ledger|same|differ")

    def test_control_plane_starts_from_the_pruned_directory(self):
        port = free_port()
        env = self.env(
            PORT=str(port),
            DATABASE_URL=self.db_url,
            OMNISYNC_TENANT="acme",
            OMNISYNC_LEDGER_PUBLIC_KEY=self.ledger_pub,
            OMNISYNC_ISSUER_KEY_FILE=os.path.join(self.key_dir, "issuer-key"),
            OMNISYNC_SESSION_SECRET=secrets.token_hex(32),
            OMNISYNC_OIDC_ISSUER="http://127.0.0.1:9",
            OMNISYNC_OIDC_CLIENT_ID="omnisync",
            OMNISYNC_OIDC_REDIRECT_URI="https://api.acme.test/v1/auth/callback",
            OMNISYNC_ADMIN_EMAILS="admin@acme.test",
            OMNISYNC_RETURN_TO="https://console.acme.test/,https://app.acme.test/",
            OMNISYNC_DEVICE_VERIFICATION_URL="https://app.acme.test/",
            OMNISYNC_TRUST_PROXY="1",
        )
        p, status = self.run_until("control-plane", "dist/main.js", env, f"http://127.0.0.1:{port}/healthz")
        try:
            self.assertEqual(status, 200, "control plane never answered /healthz")
            # the admin API is closed to anonymous callers
            code, _ = get(f"http://127.0.0.1:{port}/v1/admin/principals")
            self.assertIn(code, (401, 403))
        finally:
            out = self.stop(p)
        self.assertNotIn(self.issuer_seed, out)

    def test_control_plane_refuses_a_malformed_trust_proxy(self):
        port = free_port()
        env = self.env(PORT=str(port), OMNISYNC_ISSUER_KEY_FILE=os.path.join(self.key_dir, "issuer-key"), OMNISYNC_SESSION_SECRET=secrets.token_hex(32),
                       OMNISYNC_OIDC_ISSUER="http://127.0.0.1:9", OMNISYNC_OIDC_CLIENT_ID="x", OMNISYNC_OIDC_REDIRECT_URI="https://x.test/cb", OMNISYNC_TRUST_PROXY="true")
        p, _ = self.run_until("control-plane", "dist/main.js", env, None, timeout=10)
        out = self.refused(p)
        self.assertRegex(out, r"TRUST_PROXY")


if __name__ == "__main__":
    unittest.main()

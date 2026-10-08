"""The k6 script for the control plane (docs/specs/load.md). Nothing here runs k6: it holds the script to the rules the spec
states, so an edit that adds a write route, a literal credential or drops a threshold fails. CI also runs `k6 inspect`."""
import os
import re
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "load", "control-plane.k6.js")
TEXT = open(SCRIPT).read()
CODE = "\n".join(l for l in TEXT.splitlines() if not l.lstrip().startswith("//"))


class Shape(unittest.TestCase):
    def test_declares_the_three_scenarios_of_the_spec(self):
        for name in ("health", "me", "admin_lists"):
            self.assertRegex(CODE, rf"\b{name}: scenario\(")
        self.assertEqual(len(re.findall(r"executor: \"constant-arrival-rate\"", CODE)), 1)  # in the one helper all three share

    def test_every_scenario_has_a_failure_and_a_latency_threshold(self):
        for scenario in ("health", "me", "admin_lists"):
            self.assertIn(f'"http_req_failed{{scenario:{scenario}}}": ["rate<0.01"]', CODE)
            self.assertIn(f'"http_req_duration{{scenario:{scenario}}}": ["p(95)<300"]', CODE)

    def test_429_is_expected_and_reported_apart_from_failures(self):
        self.assertIn("http.expectedStatuses({ min: 200, max: 299 }, 429)", CODE)

    def test_only_reads(self):
        self.assertEqual(sorted(set(re.findall(r"http\.(\w+)\(", CODE))), ["expectedStatuses", "get"])
        self.assertEqual(sorted(set(re.findall(r'"(/(?:healthz|v1/[^"]*))"', CODE))), ["/healthz", "/v1/admin/documents", "/v1/admin/principals", "/v1/me"])
        for forbidden in ("certificates", "/grants", "/revoke", "/disable", "auth/device", "auth/login", "auth/callback"):
            self.assertNotIn(forbidden, CODE)

    def test_no_websocket(self):
        self.assertNotIn("k6/ws", CODE)
        self.assertNotIn("k6/experimental/websockets", CODE)


class Secrets(unittest.TestCase):
    def test_tokens_come_from_the_environment_and_nothing_literal_is_present(self):
        self.assertIn("__ENV.K6_SESSION_TOKEN", CODE)
        self.assertIn("__ENV.K6_ADMIN_TOKEN", CODE)
        self.assertNotRegex(CODE, r"Bearer [A-Za-z0-9_\-\.]{12,}")
        self.assertNotRegex(CODE, r"[A-Fa-f0-9]{40,}")
        self.assertNotRegex(CODE, r"https?://(?!\$)[a-z0-9.\-]+\.[a-z]{2,}", "no literal host: the base URL is an input")

    def test_tokens_are_not_logged_tagged_or_summarised(self):
        self.assertNotIn("console.", CODE)
        self.assertNotRegex(CODE, r"tags:\s*\{[^}]*(SESSION|ADMIN|token)")
        self.assertNotIn("handleSummary", CODE)
        self.assertIn('systemTags: ["scenario", "status", "method", "name"]', CODE)  # no url tag, so no identifiers in the output

    def test_refuses_to_start_without_its_inputs(self):
        for var in ("K6_BASE_URL", "K6_SESSION_TOKEN", "K6_ADMIN_TOKEN"):
            self.assertRegex(CODE, rf"throw new Error\(\"set {var}")


@unittest.skipUnless(shutil.which("node"), "node not installed")
class Parses(unittest.TestCase):
    def test_the_file_is_valid_javascript_module_syntax(self):
        r = subprocess.run(["node", "--check", "--input-type=module"], input=TEXT, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    @unittest.skipUnless(shutil.which("k6"), "k6 not installed (CI runs k6 inspect)")
    def test_k6_inspect_accepts_it(self):
        r = subprocess.run(["k6", "inspect", SCRIPT], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == "__main__":
    unittest.main()

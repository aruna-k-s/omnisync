"""The web image's Content-Security-Policy, taken from the rendered chart (the nginx configuration in the web ConfigMaps),
applied to the real built console and reference app in a real Chromium: both must start and render with no policy
violation, and the policy must actually be enforced (an inline script a page injects is blocked).

Needs both apps built (`pnpm --filter @omnisync/console build`, same for reference-app) and Chromium
(PLAYWRIGHT_BROWSERS_PATH). Skipped without them unless OMNISYNC_REQUIRE_BROWSER=1 (CI sets it)."""
import http.server
import json
import mimetypes
import os
import re
import socketserver
import sys
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import yaml  # noqa: E402
from render_chart import render_chart  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
CHART = os.path.join(ROOT, "deploy", "helm", "omnisync")
REQUIRE = os.environ.get("OMNISYNC_REQUIRE_BROWSER") == "1"
APPS = {"console": os.path.join(ROOT, "apps", "console", "dist"), "app": os.path.join(ROOT, "apps", "reference-app", "dist")}


def web_configs():
    out = {}
    rendered = render_chart(CHART, [os.path.join(HERE, "values", "minimal.yaml")])
    for d in yaml.safe_load_all(rendered["web.yaml"]):
        if d and d["kind"] == "ConfigMap":
            out[d["metadata"]["name"].removeprefix("omnisync-web-")] = d["data"]
    return out


def csp_of(conf):
    m = re.search(r'location / \{.*?add_header Content-Security-Policy "([^"]+)" always;', conf, re.S)
    assert m, "no Content-Security-Policy on the app location"
    return m.group(1)


def serve(dist, csp, config_json):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=dist, **k)

        def log_message(self, *a):
            pass

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/config.json":
                body, ctype = config_json.encode(), "application/json"
            else:
                f = os.path.join(dist, path.lstrip("/"))
                if not os.path.isfile(f):
                    f = os.path.join(dist, "index.html")  # nginx: try_files $uri /index.html
                body, ctype = open(f, "rb").read(), mimetypes.guess_type(f)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Security-Policy", csp)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    srv = socketserver.TCPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class WebCsp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        why = [f"{n} dist" for n, d in APPS.items() if not os.path.exists(os.path.join(d, "index.html"))]
        try:
            from playwright.sync_api import sync_playwright

            cls.pw = sync_playwright().start()
            cls.browser = cls.pw.chromium.launch()
        except Exception as e:  # noqa: BLE001 - any failure to get a browser is "no browser"
            why.append(f"chromium ({type(e).__name__})")
        if why:
            if REQUIRE:
                raise AssertionError("OMNISYNC_REQUIRE_BROWSER=1 but missing: " + ", ".join(why))
            raise unittest.SkipTest("missing: " + ", ".join(why))
        cls.cfg = web_configs()

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "browser", None):
            cls.browser.close()
            cls.pw.stop()

    def load(self, name):
        data = self.cfg["console" if name == "console" else "app"]
        csp = csp_of(data["default.conf"])
        srv = serve(APPS[name], csp, data["config.json"])
        self.addCleanup(srv.shutdown)
        page = self.browser.new_page()
        self.addCleanup(page.close)
        violations: list[str] = []
        page.add_init_script("document.addEventListener('securitypolicyviolation', e => (window.__csp = window.__csp || []).push(e.violatedDirective + ' ' + e.blockedURI));")
        page.on("console", lambda m: violations.append(m.text) if "Content Security Policy" in m.text or "Refused to" in m.text else None)
        page.goto(f"http://127.0.0.1:{srv.server_address[1]}/", wait_until="networkidle")
        return page, violations, csp

    def test_both_apps_render_under_the_policy_with_no_violation(self):
        for name in APPS:
            with self.subTest(app=name):
                page, violations, _ = self.load(name)
                page.wait_for_selector("app-root > *", timeout=15000)
                self.assertEqual(page.evaluate("window.__csp || []"), [])
                self.assertEqual(violations, [])

    def test_the_policy_is_enforced(self):
        for name in APPS:
            with self.subTest(app=name):
                page, violations, _ = self.load(name)
                page.wait_for_selector("app-root > *", timeout=15000)
                ran = page.evaluate("() => { window.__ran = false; const s = document.createElement('script'); s.textContent = 'window.__ran = true'; document.body.appendChild(s); return window.__ran; }")
                self.assertFalse(ran, "an injected inline script ran: the policy is not enforced")
                self.assertTrue(any("script-src" in v for v in page.evaluate("window.__csp || []")))
                page.evaluate("() => { const i = document.createElement('img'); i.src = 'https://evil.example/x.png'; document.body.appendChild(i); }")
                page.wait_for_timeout(300)
                self.assertTrue(any("img-src" in v for v in page.evaluate("window.__csp || []")))

    def test_the_policy_lets_the_apps_reach_only_their_api_and_gateway(self):
        for name in APPS:
            _, _, csp = self.load(name)
            self.assertIn("connect-src 'self' https://api.acme.test wss://sync.acme.test;", csp)
            self.assertEqual(re.findall(r"https?://[^\s;]+|wss?://[^\s;]+", csp), ["https://api.acme.test", "wss://sync.acme.test"])


if __name__ == "__main__":
    unittest.main()

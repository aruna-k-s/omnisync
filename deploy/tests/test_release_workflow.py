"""Safety properties of .github/workflows/release.yml that a reviewer must not have to re-check by eye on every change.
Spec: docs/specs/release.md. The first real release is the proof that it builds, scans, signs and verifies."""
import os
import re
import subprocess
import tempfile
import unittest

import yaml

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".github", "workflows", "release.yml")
TEXT = open(PATH).read()
WF = yaml.safe_load(TEXT)
JOBS = WF["jobs"]
ON = WF.get(True) or WF.get("on")  # YAML 1.1 reads the key `on` as true


def steps(job):
    return JOBS[job]["steps"]


def runs(job=None):
    for name, j in JOBS.items():
        if job and name != job:
            continue
        for s in j["steps"]:
            if "run" in s:
                yield name, s


class Release(unittest.TestCase):
    def test_triggers_are_a_version_tag_and_a_manual_rehearsal_only(self):
        self.assertEqual(set(ON), {"push", "workflow_dispatch"})
        self.assertEqual(ON["push"], {"tags": ["v[0-9]+.[0-9]+.[0-9]+"]})
        self.assertNotIn("branches", ON["push"])

    def test_default_permissions_are_read_only(self):
        self.assertEqual(WF["permissions"], {"contents": "read"})

    def test_only_the_release_job_can_write_to_the_repository(self):
        for name, j in JOBS.items():
            perms = j.get("permissions", {})
            if name == "release":
                self.assertEqual(perms, {"contents": "write"})
            else:
                self.assertNotEqual(perms.get("contents"), "write", name)
        for name in ("gate", "release"):
            self.assertNotIn("id-token", JOBS[name].get("permissions", {}))
            self.assertNotIn("packages", JOBS[name].get("permissions", {}))

    def test_the_release_job_runs_only_actions_published_by_github(self):
        for s in steps("release"):
            if "uses" in s:
                self.assertTrue(s["uses"].startswith("actions/"), s["uses"])

    def test_jobs_run_in_order_and_publish_nothing_before_the_gate(self):
        self.assertEqual(JOBS["publish"]["needs"], "gate")
        self.assertEqual(set(JOBS["chart"]["needs"]), {"gate", "publish"})
        self.assertEqual(set(JOBS["release"]["needs"]), {"gate", "publish", "chart"})
        self.assertEqual(JOBS["release"]["if"], "github.event_name == 'push'")

    def test_gate_demands_the_ci_jobs_on_the_tagged_commit(self):
        gate = "\n".join(s["run"] for _, s in runs("gate"))
        self.assertIn("check-runs", gate)
        self.assertRegex(gate, r"for job in check deploy")
        self.assertRegex(gate, r"\^v\[0-9\]\+")  # the tag shape is validated
        self.assertIn("exit 1", gate)

    def test_nothing_is_pushed_or_signed_in_a_rehearsal(self):
        build = [s for s in steps("publish") if s.get("id") == "build"][0]
        self.assertEqual(build["with"]["push"], "${{ env.PUSH == 'true' }}")
        for job in ("publish", "chart"):
            for s in steps(job):
                text = s.get("run", "")
                if "cosign sign" in text or "cosign attest" in text or "helm push" in text:
                    self.assertEqual(s.get("if"), "env.PUSH == 'true'", f"{job}: {s.get('name')}")
        self.assertEqual(JOBS["publish"]["env"]["PUSH"], "${{ github.event_name == 'push' && 'true' || 'false' }}")
        login = [s for s in steps("publish") if str(s.get("uses", "")).startswith("docker/login-action")][0]
        self.assertEqual(login["if"], "env.PUSH == 'true'")

    def test_base_images_are_pinned_by_digest_and_the_build_uses_them(self):
        pin = [s for s in steps("publish") if s.get("id") == "base"][0]["run"]
        self.assertIn("imagetools inspect", pin)
        self.assertRegex(pin, r"sha256:\[0-9a-f\]\{64\}")
        args = [s for s in steps("publish") if s.get("id") == "build"][0]["with"]["build-args"]
        self.assertRegex(args, r"BASE_IMAGE=\$\{\{ steps\.base\.outputs\.base \}\}")
        self.assertRegex(args, r"NGINX_IMAGE=\$\{\{ steps\.base\.outputs\.nginx \}\}")
        dockerfile = open(os.path.join(os.path.dirname(PATH), "..", "..", "deploy", "docker", "Dockerfile")).read()
        for arg in ("BASE_IMAGE", "NGINX_IMAGE"):
            self.assertRegex(dockerfile, rf"(?m)^ARG {arg}=\S+")

    def test_every_image_is_built_with_provenance_and_the_three_targets(self):
        self.assertEqual(JOBS["publish"]["strategy"]["matrix"]["image"], ["gateway", "control-plane", "web"])
        build = [s for s in steps("publish") if s.get("id") == "build"][0]["with"]
        self.assertIn("mode=max", build["provenance"])
        self.assertEqual(build["target"], "${{ matrix.image }}")

    def test_the_scan_fails_the_release_on_fixable_high_or_critical_findings_before_signing(self):
        names = [s.get("name", "") for s in steps("publish")]
        scan = [s for s in steps("publish") if str(s.get("uses", "")).startswith("aquasecurity/trivy-action")][0]
        self.assertEqual(scan["with"]["exit-code"], "1")
        self.assertEqual(scan["with"]["severity"], "HIGH,CRITICAL")
        self.assertIs(scan["with"]["ignore-unfixed"], True)
        self.assertLess(steps("publish").index(scan), next(i for i, s in enumerate(steps("publish")) if "cosign sign" in s.get("run", "")))
        self.assertNotIn("continue-on-error", scan)
        self.assertTrue(names)

    def test_signing_is_keyless_and_by_digest(self):
        self.assertNotRegex(TEXT, r"(?i)--key\b|COSIGN_PRIVATE_KEY|COSIGN_PASSWORD|cosign generate-key")
        for job, s in runs():
            for line in s["run"].splitlines():
                m = re.search(r"cosign (sign|attest)\b.*", line)
                if m:
                    ref = line.split()[-1]
                    if ref == '"$REF"':  # a variable: the script must check it is name@digest before using it
                        self.assertIn("@sha256:[0-9a-f]{64}$ ]]", s["run"].split("cosign sign")[0], f"{job}: unchecked reference")
                    else:
                        self.assertIn("@", ref, f"{job}: cosign must be given name@digest, got {ref}")
        self.assertIn("id-token", JOBS["publish"]["permissions"])
        self.assertIn("id-token", JOBS["chart"]["permissions"])
        # the SBOM is attested to the digest, as SPDX
        self.assertTrue([s for _, s in runs("publish") if "--type spdxjson" in s["run"]])

    def test_no_secret_but_the_job_token(self):
        for m in re.finditer(r"secrets\.([A-Za-z0-9_]+)", TEXT):
            self.assertEqual(m.group(1), "GITHUB_TOKEN")
        self.assertNotIn("pull_request", TEXT.replace("workflow_dispatch", ""))

    def test_no_untrusted_expression_is_spliced_into_a_script(self):
        # inputs, refs, titles and the like reach scripts through the environment, never inside the script text
        bad = re.compile(r"\$\{\{\s*(inputs\.|github\.(event|head_ref|ref_name|ref\b|actor)|matrix\.)")
        for job, s in runs():
            self.assertNotRegex(s["run"], bad, f"{job}: {s.get('name')}")

    def test_every_action_is_versioned_and_none_floats_on_a_branch(self):
        uses = re.findall(r"uses:\s*(\S+)", TEXT)
        self.assertTrue(uses)
        for u in uses:
            self.assertRegex(u, r"@(v?\d[\w.]*|[0-9a-f]{40})$", u)

    def test_run_blocks_are_valid_shell(self):
        for job, s in runs():
            script = re.sub(r"\$\{\{[^}]*\}\}", "X", s["run"])
            with tempfile.NamedTemporaryFile("w", suffix=".sh") as f:
                f.write(script)
                f.flush()
                r = subprocess.run(["bash", "-n", f.name], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f"{job}: {s.get('name')}\n{r.stderr}")

    def test_the_chart_is_packaged_with_the_tag_version_and_signed_by_digest(self):
        text = "\n".join(s["run"] for _, s in runs("chart"))
        self.assertIn('--version "$VERSION" --app-version "$VERSION"', text)
        self.assertIn("--strict", text)
        self.assertRegex(text, r'cosign sign --yes "\$REGISTRY_CHARTS/omnisync@\$digest"')
        self.assertIn("password-stdin", text)


if __name__ == "__main__":
    unittest.main()

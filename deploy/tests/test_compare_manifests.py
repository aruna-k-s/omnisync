import os
import subprocess
import sys
import tempfile
import unittest

TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools", "compare_manifests.py")


def run(a, b):
    with tempfile.TemporaryDirectory() as t:
        pa, pb = os.path.join(t, "a.yaml"), os.path.join(t, "b.yaml")
        open(pa, "w").write(a)
        open(pb, "w").write(b)
        return subprocess.run([sys.executable, TOOL, pa, pb], capture_output=True, text=True)


CM = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {n}\ndata:\n  k: {v}\n"


class Compare(unittest.TestCase):
    def test_same_objects_in_any_order_with_comments_are_equal(self):
        a = "---\n# Source: x\n" + CM.format(n="a", v="1") + "---\n" + CM.format(n="b", v="2")
        b = "---\n" + CM.format(n="b", v="2") + "---\n# Source: y\ndata:\n  k: 1\nmetadata:\n  name: a\nkind: ConfigMap\napiVersion: v1\n"
        r = run(a, b)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "same 2 objects"))

    def test_a_changed_value_is_reported_with_a_diff(self):
        r = run(CM.format(n="a", v="1"), CM.format(n="a", v="2"))
        self.assertEqual(r.returncode, 1)
        self.assertIn("differs: ConfigMap/a", r.stdout)
        self.assertRegex(r.stdout, r"(?m)^-  k: .?1.?$")
        self.assertRegex(r.stdout, r"(?m)^\+  k: .?2.?$")

    def test_a_missing_object_is_reported_on_both_sides(self):
        r = run(CM.format(n="a", v="1"), CM.format(n="b", v="1"))
        self.assertEqual(r.returncode, 1)
        self.assertIn("ConfigMap/a", r.stdout)
        self.assertIn("ConfigMap/b", r.stdout)

    def test_a_duplicate_object_is_an_error(self):
        r = run(CM.format(n="a", v="1") + "---\n" + CM.format(n="a", v="1"), CM.format(n="a", v="1"))
        self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()

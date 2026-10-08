#!/usr/bin/env python3
"""Compare two multi-document manifest streams (Helm's `helm template` and tools/render_chart.py) object by object.

    compare_manifests.py HELM.yaml RENDERER.yaml

Exit 0 when both hold the same objects (order, comments and key order do not matter), 1 with a readable diff when not.
Where they differ Helm is right and the chart or the renderer is fixed (docs/specs/deployment.md)."""
import difflib
import sys

import yaml


def load(path):
    out = {}
    with open(path) as f:
        for d in yaml.safe_load_all(f):
            if d:
                key = f"{d['kind']}/{d['metadata']['name']}"
                if key in out:
                    raise SystemExit(f"{path}: {key} appears twice")
                out[key] = d
    return out


def dump(d):
    return yaml.safe_dump(d, default_flow_style=False, sort_keys=True, width=100000).splitlines()


def main(a, b):
    left, right = load(a), load(b)
    bad = False
    for k in sorted(left.keys() - right.keys()):
        print(f"only in {a}: {k}")
        bad = True
    for k in sorted(right.keys() - left.keys()):
        print(f"only in {b}: {k}")
        bad = True
    for k in sorted(left.keys() & right.keys()):
        if left[k] != right[k]:
            bad = True
            print(f"differs: {k}")
            print("\n".join(difflib.unified_diff(dump(left[k]), dump(right[k]), a, b, lineterm="", n=2)))
    if not bad:
        print(f"same {len(left)} objects")
    return 1 if bad else 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    sys.exit(main(sys.argv[1], sys.argv[2]))

"""Helpers for checking PromQL and the metric catalogue without a Prometheus.

`catalogue()` reads the tables of docs/specs/observability.md: that document is the contract, and
packages/telemetry/test/catalogue.test.ts proves it matches what the code really exposes. `selectors()` parses an
expression with a real PromQL parser (the `promql-parser` package; the Rust parser the Prometheus project's grammar is
ported to) and reports what it reads, so dashboards and alerts can be held to the catalogue.

Needs `pip install promql-parser`. Without it the tests that use it are skipped unless OMNISYNC_REQUIRE_PROMQL=1 (CI sets it)."""
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = os.path.join(HERE, "..", "..", "docs", "specs", "observability.md")

try:
    import promql_parser as pp
except ImportError:  # pragma: no cover
    pp = None

# Series that are not ours but that the alert rules are documented to use, and the labels the scraper adds to everything.
EXTERNAL_METRICS = {"pg_replication_lag_seconds"}
TARGET_LABELS = {"job", "instance", "namespace", "pod", "service", "container", "endpoint", "prometheus"}


def require():
    if pp is None:
        if os.environ.get("OMNISYNC_REQUIRE_PROMQL") == "1":
            raise AssertionError("OMNISYNC_REQUIRE_PROMQL=1 but promql-parser is not installed (pip install promql-parser)")
        raise unittest.SkipTest("promql-parser not installed")


def catalogue():
    """{series name: {"labels": set, "family": metric family, "kind": gauge|counter|histogram|bucket|sum|count}}"""
    out = {}
    in_table = False
    for line in open(SPEC).read().splitlines():
        m = re.match(r"^\| `(omnisync_[a-z_]+)` \| (gauge|counter|histogram) \| (.*?) \| .* \|$", line)
        if not m:
            continue
        name, kind, labels_cell = m.groups()
        cell = re.sub(r"\([^)]*\)", "", labels_cell)  # drop parenthesised explanations
        labels = set() if cell.strip() == "none" else set(re.findall(r"`([a-z_]+)`", cell))
        if kind == "histogram":
            out[name + "_bucket"] = {"labels": labels | {"le"}, "family": name, "kind": "bucket"}
            out[name + "_sum"] = {"labels": labels, "family": name, "kind": "sum"}
            out[name + "_count"] = {"labels": labels, "family": name, "kind": "count"}
        else:
            out[name] = {"labels": labels, "family": name, "kind": kind}
        in_table = True
    assert in_table, "no metric tables found in " + SPEC
    return out


class Reading:
    def __init__(self):
        self.series = []  # (name, matcher labels, enclosing function or None)
        self.aggs = []  # {"op", "kind": "By"|"Without"|None, "labels": [...], "series": [names]}
        self.calls = []  # (function name, args)
        self.numbers = []


def read_node(node) -> Reading:
    r = Reading()

    def walk(n, fn=None):
        t = type(n).__name__
        if t == "BinaryExpr":
            walk(n.lhs, fn)
            walk(n.rhs, fn)
        elif t in ("ParenExpr", "UnaryExpr", "SubqueryExpr"):
            walk(n.expr, fn)
        elif t == "Call":
            r.calls.append((n.func.name, n.args))
            for a in n.args:
                walk(a, n.func.name)
        elif t == "AggregateExpr":
            mod = n.modifier
            kind = None if mod is None else str(mod.type).split(".")[-1]
            inner = read_node(n.expr)
            r.aggs.append({"op": str(n.op), "kind": kind, "labels": list(mod.labels) if mod is not None else [], "series": [x[0] for x in inner.series]})
            if n.param is not None:
                walk(n.param, fn)
            walk(n.expr, fn)
        elif t == "MatrixSelector":
            walk(n.vector_selector, fn)
        elif t == "VectorSelector":
            r.series.append((n.name, {m.name for m in n.matchers.matchers}, fn))
        elif t == "NumberLiteral":
            r.numbers.append(n.val)

    walk(node)
    return r


def read(expr: str) -> Reading:
    require()
    return read_node(pp.parse(expr))

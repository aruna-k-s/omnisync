"""Dashboards and alert rules (docs/specs/observability.md, week 10b). Nothing here queries a Prometheus or renders a
Grafana: the expressions are parsed with a real PromQL parser and held to the metric catalogue (names, labels, and that
rate() is only taken of counters), the dashboard JSON is checked against a schema and its layout, and the alert rules are
read from the chart's own output. See "What is proven where" in the spec."""
import json
import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
sys.path.insert(0, os.path.join(HERE, "..", "monitoring"))
import promql_util as pq  # noqa: E402
from render_chart import manifests, render_chart  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
CHART = os.path.join(ROOT, "deploy", "helm", "omnisync")
VALUES = os.path.join(HERE, "values")
DASHBOARD = os.path.join(CHART, "files", "omnisync-dashboard.json")
SCHEMA = os.path.join(ROOT, "deploy", "monitoring", "dashboard.schema.json")
OPERATIONS = os.path.join(ROOT, "docs", "operations.md")

ALWAYS = ["OmniSyncCheckpointStale", "OmniSyncLedgerAppendSlow", "OmniSyncMetricsMissing", "OmniSyncSignatureFailures"]
ALL = sorted(ALWAYS + ["OmniSyncConnectionsNearLimit", "OmniSyncPostgresReplicaLag"])
FULL = {"monitoring": {"prometheusRule": {"alerts": {"licensedConnections": 500, "postgresReplicaLagSeconds": 45}}}}


def render(extra=None):
    import yaml

    vals = [os.path.join(VALUES, "monitoring.yaml")]
    tmp = None
    if extra:
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
            yaml.safe_dump(extra, f)
        tmp = f.name
        vals.append(tmp)
    try:
        return manifests(render_chart(CHART, vals, [], "omnisync"))
    finally:
        if tmp:
            os.unlink(tmp)


def alerts(extra=None):
    found = [d for d in render(extra) if d["kind"] == "PrometheusRule"]
    return {r["alert"]: r for d in found for g in d["spec"]["groups"] for r in g["rules"]}


def slug(heading):
    """GitHub's anchor for a heading."""
    s = re.sub(r"[^\w\- ]", "", heading.strip().lower()).replace(" ", "-")
    return s


def anchors():
    return {slug(m.group(1)) for m in re.finditer(r"^#{1,4} (.+)$", open(OPERATIONS).read(), re.M)}


def duration_seconds(d):
    m = re.fullmatch(r"(\d+)([smh])", d)
    assert m, d
    return int(m.group(1)) * {"s": 1, "m": 60, "h": 3600}[m.group(2)]


def check_expr(test, expr, where):
    """Parses the expression and holds it to the catalogue: known series, known labels, rate() only of counters,
    histogram_quantile() only of rated buckets that keep `le`."""
    cat = pq.catalogue()
    r = pq.read(expr)
    test.assertTrue(r.series, f"{where}: reads no series")
    for name, matchers, fn in r.series:
        if name in pq.EXTERNAL_METRICS:
            continue
        known = cat.get(name)
        test.assertIsNotNone(known, f"{where}: {name} is not a metric this release exposes")
        for label in matchers:
            test.assertIn(label, known["labels"] | pq.TARGET_LABELS, f"{where}: {name} has no label {label}")
        if fn in ("rate", "irate", "increase"):
            test.assertIn(known["kind"], ("counter", "bucket", "sum", "count"), f"{where}: {fn}() of {name}, which is a {known['kind']}")
        test.assertNotEqual(fn, "histogram_quantile", f"{where}: histogram_quantile takes a rate of buckets, not {name}")
    for agg in r.aggs:
        have = set()
        for n in agg["series"]:
            have |= cat[n]["labels"] if n in cat else set()
        for label in agg["labels"]:
            test.assertIn(label, have | pq.TARGET_LABELS, f"{where}: {agg['op']} {agg['kind']} ({label}) groups by a label its series do not have")
    for fn, args in r.calls:
        if fn != "histogram_quantile":
            continue
        inner = pq.read_node(args[1])
        test.assertTrue(inner.series, where)
        for name, _, _ in inner.series:
            test.assertEqual(cat.get(name, {}).get("kind"), "bucket", f"{where}: histogram_quantile of {name}, which is not a histogram bucket")
        for agg in inner.aggs:
            if agg["kind"] == "By":
                test.assertIn("le", agg["labels"], f"{where}: the aggregation drops `le`, so the quantile is meaningless")
            if agg["kind"] == "Without":
                test.assertNotIn("le", agg["labels"], f"{where}: the aggregation drops `le`")
            if agg["kind"] is None:
                test.fail(f"{where}: an aggregation without by/without drops `le`")
    return r


class Catalogue(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        pq.require()

    def test_the_catalogue_reads_every_metric_family_in_the_spec(self):
        cat = pq.catalogue()
        families = {v["family"] for v in cat.values()}
        self.assertEqual(len(families), 19)
        self.assertEqual(cat["omnisync_update_apply_seconds_bucket"]["labels"], {"outcome", "le"})
        self.assertEqual(cat["omnisync_fanout_seconds_bucket"]["labels"], {"le"})
        self.assertEqual(cat["omnisync_http_request_seconds_count"]["labels"], {"route", "method", "status_class"})
        self.assertEqual(cat["omnisync_connections_active"], {"labels": set(), "family": "omnisync_connections_active", "kind": "gauge"})
        self.assertEqual(cat["omnisync_admission_rejections_total"]["kind"], "counter")

    def test_the_checker_itself_refuses_what_it_exists_to_refuse(self):
        bad = {
            "omnisync_nope": "unknown series",
            "rate(omnisync_connections_active[5m])": "rate of a gauge",
            "sum by (nope) (rate(omnisync_updates_total[5m]))": "label the series lacks",
            'omnisync_updates_total{nope="x"}': "matcher label the series lacks",
            "histogram_quantile(0.99, sum by (outcome) (rate(omnisync_ledger_append_seconds_bucket[5m])))": "drops le",
            "histogram_quantile(0.99, sum(rate(omnisync_ledger_append_seconds_bucket[5m])))": "drops le",
            "histogram_quantile(0.99, rate(omnisync_updates_total[5m]))": "not buckets",
            "histogram_quantile(0.99, omnisync_ledger_append_seconds_bucket)": "no rate",
            "histogram_quantile(0.99, sum without (le) (rate(omnisync_ledger_append_seconds_bucket[5m])))": "without le",
        }
        for expr, why in bad.items():
            with self.subTest(why), self.assertRaises(AssertionError):
                check_expr(self, expr, why)
        good = [
            "histogram_quantile(0.99, sum by (le) (rate(omnisync_ledger_append_seconds_bucket[5m])))",
            "histogram_quantile(0.95, sum by (le, route) (rate(omnisync_http_request_seconds_bucket[5m])))",
            'sum by (reason) (rate(omnisync_admission_rejections_total{reason!="busy"}[5m]))',
            "max(pg_replication_lag_seconds) > 30",
            'sum(omnisync_connections_active{job="x"})',
        ]
        for expr in good:
            with self.subTest(expr):
                check_expr(self, expr, expr)


class Alerts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        pq.require()

    def test_the_documented_alerts_exist(self):
        self.assertEqual(sorted(alerts(FULL)), ALL)

    def test_without_a_licensed_limit_or_a_lag_metric_only_the_always_meaningful_ones(self):
        self.assertEqual(sorted(alerts()), ALWAYS)

    def test_no_rule_object_unless_asked(self):
        self.assertEqual([d for d in render({"monitoring": {"prometheusRule": {"enabled": False}}}) if d["kind"] == "PrometheusRule"], [])

    def test_every_alert_is_complete_and_its_expression_is_held_to_the_catalogue(self):
        known_anchors = anchors()
        for name, r in alerts(FULL).items():
            with self.subTest(alert=name):
                check_expr(self, r["expr"], name)
                self.assertNotIn("{{", r["expr"])
                self.assertGreaterEqual(duration_seconds(r["for"]), 60, "an alert that fires on one scrape flaps")
                self.assertIn(r["labels"]["severity"], ("warning", "critical"))
                for a in ("summary", "description", "runbook_url"):
                    self.assertTrue(r["annotations"].get(a), f"{name} has no {a}")
                url, _, anchor = r["annotations"]["runbook_url"].partition("#")
                self.assertTrue(url.endswith("docs/operations.md"))
                self.assertIn(anchor, known_anchors, f"{name}: runbook anchor #{anchor} is not a heading in docs/operations.md")
                self.assertNotIn(".Values", json.dumps(r["annotations"]), "an unrendered chart expression")

    def test_each_alert_waits_and_looks_back_as_long_as_the_runbook_says(self):
        found = alerts(FULL)
        self.assertEqual(
            {n: r["for"] for n, r in found.items()},
            {"OmniSyncCheckpointStale": "5m", "OmniSyncSignatureFailures": "5m", "OmniSyncLedgerAppendSlow": "10m", "OmniSyncConnectionsNearLimit": "5m", "OmniSyncPostgresReplicaLag": "5m", "OmniSyncMetricsMissing": "10m"},
        )
        self.assertEqual(re.findall(r"\[(\w+)\]", found["OmniSyncSignatureFailures"]["expr"]), ["5m"])
        self.assertEqual(re.findall(r"\[(\w+)\]", found["OmniSyncLedgerAppendSlow"]["expr"]), ["5m"])
        for n, r in found.items():  # the text people read says the same as the rule
            minutes = duration_seconds(r["for"]) // 60
            self.assertRegex(r["annotations"]["description"], rf"\b{minutes} minutes\b" if n != "OmniSyncCheckpointStale" else r"more than 900 seconds", n)

    def test_checkpoint_stale_takes_the_oldest_gauge_so_a_stale_series_cannot_hide(self):
        read = pq.read(alerts()["OmniSyncCheckpointStale"]["expr"])
        self.assertEqual([a["op"] for a in read.aggs], ["max"])

    def test_checkpoint_stale_reads_the_age_gauge_and_fires_at_fifteen_minutes(self):
        r = alerts()["OmniSyncCheckpointStale"]
        read = pq.read(r["expr"])
        self.assertEqual([s[0] for s in read.series], ["omnisync_checkpoint_age_seconds"])
        self.assertEqual(read.numbers, [900.0])
        self.assertEqual(r["labels"]["severity"], "critical")
        self.assertRegex(r["expr"], r">\s*900$")
        self.assertEqual(alerts({"monitoring": {"prometheusRule": {"alerts": {"checkpointAgeSeconds": 600}}}})["OmniSyncCheckpointStale"]["expr"].split(">")[-1].strip(), "600")

    def test_signature_failures_is_a_rate_of_the_counter_summed_over_reasons(self):
        r = alerts()["OmniSyncSignatureFailures"]
        read = pq.read(r["expr"])
        self.assertEqual([(s[0], s[2]) for s in read.series], [("omnisync_signature_failures_total", "rate")])
        self.assertEqual(read.aggs[0]["op"], "sum")
        self.assertEqual(read.numbers, [0.2])
        changed = alerts({"monitoring": {"prometheusRule": {"alerts": {"signatureFailuresPerSecond": 1.5}}}})["OmniSyncSignatureFailures"]
        self.assertEqual(pq.read(changed["expr"]).numbers, [1.5])

    def test_ledger_append_is_the_p99_of_rated_buckets_over_a_tenth_of_a_second(self):
        r = alerts()["OmniSyncLedgerAppendSlow"]
        read = pq.read(r["expr"])
        self.assertEqual([s[0] for s in read.series], ["omnisync_ledger_append_seconds_bucket"])
        self.assertEqual(read.numbers, [0.99, 0.1])
        self.assertEqual([c[0] for c in read.calls], ["histogram_quantile", "rate"])
        self.assertGreaterEqual(duration_seconds(r["for"]), 300, "a p99 over a few requests is noise")
        changed = alerts({"monitoring": {"prometheusRule": {"alerts": {"ledgerAppendP99Seconds": 0.25}}}})["OmniSyncLedgerAppendSlow"]
        self.assertEqual(pq.read(changed["expr"]).numbers, [0.99, 0.25])

    def test_connections_alert_compares_with_eighty_percent_of_the_limit(self):
        r = alerts(FULL)["OmniSyncConnectionsNearLimit"]
        read = pq.read(r["expr"])
        self.assertEqual([s[0] for s in read.series], ["omnisync_connections_active"])
        self.assertEqual(read.numbers, [0.8, 500.0])
        changed = alerts({"monitoring": {"prometheusRule": {"alerts": {"licensedConnections": 1000, "connectionsWarnRatio": 0.9}}}})["OmniSyncConnectionsNearLimit"]
        self.assertEqual(pq.read(changed["expr"]).numbers, [0.9, 1000.0])

    def test_replica_lag_reads_the_configured_metric_which_is_not_ours(self):
        r = alerts(FULL)["OmniSyncPostgresReplicaLag"]
        read = pq.read(r["expr"])
        self.assertEqual([s[0] for s in read.series], ["pg_replication_lag_seconds"])
        self.assertEqual(read.numbers, [45.0])
        other = alerts({"monitoring": {"prometheusRule": {"alerts": {"postgresReplicaLagSeconds": 5, "postgresReplicaLagMetric": "cnpg_pg_replication_lag"}}}})["OmniSyncPostgresReplicaLag"]
        self.assertEqual([s[0] for s in pq.read(other["expr"]).series], ["cnpg_pg_replication_lag"])

    def test_metrics_missing_watches_the_series_all_the_others_depend_on(self):
        r = alerts()["OmniSyncMetricsMissing"]
        read = pq.read(r["expr"])
        self.assertEqual([(s[0], s[2]) for s in read.series], [("omnisync_connections_active", "absent")])
        self.assertGreaterEqual(duration_seconds(r["for"]), 300)

    def test_rule_object_carries_the_configured_labels_and_a_single_group(self):
        pr = [d for d in render({"monitoring": {"prometheusRule": {"labels": {"release": "kube-prometheus-stack"}}}}) if d["kind"] == "PrometheusRule"][0]
        self.assertEqual(pr["metadata"]["labels"]["release"], "kube-prometheus-stack")
        self.assertEqual(len(pr["spec"]["groups"]), 1)
        self.assertEqual(pr["spec"]["groups"][0]["name"], "omnisync")


class Dashboard(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        pq.require()
        cls.dash = json.load(open(DASHBOARD))

    def panels(self):
        return [p for p in self.dash["panels"] if p["type"] != "row"]

    def test_the_committed_file_is_what_the_generator_produces(self):
        import dashboard

        self.assertEqual(open(DASHBOARD).read(), dashboard.render())

    def test_it_meets_the_schema_we_rely_on(self):
        import jsonschema

        errors = sorted(jsonschema.Draft7Validator(json.load(open(SCHEMA))).iter_errors(self.dash), key=lambda e: list(e.path))
        self.assertEqual([f"{'/'.join(map(str, e.path))}: {e.message}" for e in errors], [])

    def test_layout_is_a_clean_grid(self):
        seen = []
        for p in self.dash["panels"]:
            g = p["gridPos"]
            self.assertLessEqual(g["x"] + g["w"], 24, p["title"])
            self.assertGreaterEqual(g["x"], 0)
            for q in seen:
                h = q["gridPos"]
                overlap = g["x"] < h["x"] + h["w"] and h["x"] < g["x"] + g["w"] and g["y"] < h["y"] + h["h"] and h["y"] < g["y"] + g["h"]
                self.assertFalse(overlap, f"{p['title']} overlaps {q['title']}")
            seen.append(p)

    def test_ids_titles_and_uid_are_unique_and_set(self):
        ids = [p["id"] for p in self.dash["panels"]]
        self.assertEqual(len(ids), len(set(ids)))
        titles = [p["title"] for p in self.dash["panels"]]
        self.assertEqual(len(titles), len(set(titles)))
        self.assertTrue(all(titles))
        self.assertEqual(self.dash["uid"], "omnisync-overview")
        self.assertLessEqual(len(open(DASHBOARD).read()), 200_000)

    def test_every_panel_reads_through_the_datasource_variable(self):
        names = {v["name"] for v in self.dash["templating"]["list"]}
        self.assertIn("datasource", names)
        for p in self.panels():
            self.assertEqual(p["datasource"], {"type": "prometheus", "uid": "${datasource}"}, p["title"])
            for t in p["targets"]:
                self.assertEqual(t["datasource"], p["datasource"])

    def test_every_expression_is_held_to_the_catalogue(self):
        count = 0
        for p in self.panels():
            refs = [t["refId"] for t in p["targets"]]
            self.assertEqual(len(refs), len(set(refs)), p["title"])
            for t in p["targets"]:
                check_expr(self, t["expr"], f"{p['title']} / {t['refId']}")
                self.assertNotIn("{{", t["expr"])
                count += 1
        self.assertGreaterEqual(count, 25)

    def test_no_metric_family_is_left_off_the_dashboard(self):
        shown = set()
        for p in self.panels():
            for t in p["targets"]:
                for name, _, _ in pq.read(t["expr"]).series:
                    shown.add(pq.catalogue()[name]["family"])
        families = {v["family"] for v in pq.catalogue().values()}
        self.assertEqual(sorted(families - shown), [])

    def test_every_stat_shows_what_its_title_says(self):
        want = {
            "Open connections": "omnisync_connections_active",
            "Documents in memory": "omnisync_documents_active",
            "Edits waiting for the database": "omnisync_append_queue_depth",
            "Checkpoint age": "omnisync_checkpoint_age_seconds",
            "Update log": "omnisync_store_degraded",
            "Signature failures per second": "omnisync_signature_failures_total",
        }
        stats = {p["title"]: p for p in self.panels() if p["type"] == "stat" and p["title"] in want}
        self.assertEqual(sorted(stats), sorted(want))
        for title, p in stats.items():
            self.assertEqual([n for n, _, _ in pq.read(p["targets"][0]["expr"]).series], [want[title]], title)

    def test_latency_panels_show_the_median_the_95th_and_the_99th_percentile(self):
        for title in ("Edit latency: arrival to acknowledgement", "Update log write latency", "Fan-out latency"):
            p = [q for q in self.panels() if q["title"] == title][0]
            asked = sorted({n for t in p["targets"] for n in pq.read(t["expr"]).numbers if n < 1})
            self.assertIn(0.99, asked, title)
            self.assertIn(0.5, asked, title)

    def test_panels_that_show_an_alerting_number_mark_the_same_threshold_the_chart_alerts_at(self):
        import yaml

        defaults = yaml.safe_load(open(os.path.join(CHART, "values.yaml")))["monitoring"]["prometheusRule"]["alerts"]
        marks = {
            "omnisync_checkpoint_age_seconds": defaults["checkpointAgeSeconds"],
            "omnisync_ledger_append_seconds_bucket": defaults["ledgerAppendP99Seconds"],
        }
        seen = set()
        for p in self.panels():
            for metric, threshold in marks.items():
                if any(metric in t["expr"] for t in p["targets"]):
                    seen.add(metric)
                    steps = [s["value"] for s in p["fieldConfig"]["defaults"]["thresholds"]["steps"] if s["value"] is not None]
                    self.assertIn(threshold, steps, f"{p['title']} does not mark the alert threshold of {metric}")
        self.assertEqual(seen, set(marks))
        sig = [p for p in self.panels() if p["type"] == "stat" and "omnisync_signature_failures_total" in p["targets"][0]["expr"]][0]
        self.assertIn(defaults["signatureFailuresPerSecond"], [s["value"] for s in sig["fieldConfig"]["defaults"]["thresholds"]["steps"]])

    def test_the_alerting_metrics_are_on_it_with_the_alert_thresholds(self):
        text = json.dumps(self.dash)
        self.assertIn("omnisync_checkpoint_age_seconds", text)
        age = [p for p in self.panels() if any("omnisync_checkpoint_age_seconds" in t["expr"] for t in p["targets"])]
        steps = [s["value"] for p in age for s in p["fieldConfig"]["defaults"]["thresholds"]["steps"] if s["value"] is not None]
        self.assertIn(900, steps, "the checkpoint age panel marks the alert threshold")

    def test_legend_templates_use_only_labels_the_query_keeps(self):
        for p in self.panels():
            for t in p["targets"]:
                legend = t.get("legendFormat", "")
                used = set(re.findall(r"\{\{\s*([a-z_]+)\s*\}\}", legend))
                if not used:
                    continue
                kept = set()
                for agg in pq.read(t["expr"]).aggs:
                    if agg["kind"] == "By":
                        kept |= set(agg["labels"])
                self.assertLessEqual(used, kept, f"{p['title']}: legend {legend!r} names labels the query aggregated away")

    def test_stat_panels_show_one_number(self):
        for p in self.panels():
            if p["type"] == "stat":
                self.assertEqual(len(p["targets"]), 1, p["title"])


if __name__ == "__main__":
    unittest.main()

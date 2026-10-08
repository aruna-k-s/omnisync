"""The chart's monitoring switches (docs/specs/observability.md, week 10b): what is added when they are on, and that
nothing changes when they are off. Reuses the helpers of test_chart.py."""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import test_chart as tc  # noqa: E402
from render_chart import TemplateError, manifests, render_chart  # noqa: E402

CHART = tc.CHART


def on(extra=None, case="minimal"):
    base = {"monitoring": {"enabled": True}}
    for k, v in (extra or {}).items():
        base.setdefault(k, {})
        base[k] = {**base[k], **v} if isinstance(v, dict) else v
    return manifests(tc.render_with(case, base))


def monitoring(extra=None):
    """Monitoring values merged over tests/values/monitoring.yaml."""
    import yaml

    base = yaml.safe_load(open(os.path.join(tc.VALUES, "monitoring.yaml")))
    return base["monitoring"], extra or {}


def kinds(ds):
    return sorted(d["kind"] for d in ds)


def env(container):
    return {e["name"]: e for e in container.get("env", [])}


def component(ds, kind, name_suffix):
    return [d for d in ds if d["kind"] == kind and d["metadata"]["name"].endswith(name_suffix)][0]


def main_container(ds, suffix):
    return component(ds, "Deployment", suffix)["spec"]["template"]["spec"]["containers"][0]


class Off(unittest.TestCase):
    def test_default_adds_no_object_no_port_and_no_environment(self):
        for case in ("minimal", "evaluation", "production"):
            with self.subTest(case=case):
                ds = tc.docs(case)
                self.assertEqual([d for d in ds if d["kind"] in ("ServiceMonitor", "PrometheusRule")], [])
                self.assertEqual([d for d in ds if d["kind"] == "ConfigMap" and "dashboard" in d["metadata"]["name"]], [])
                text = json.dumps(ds)
                for needle in ("OMNISYNC_METRICS", "OMNISYNC_TRACES", "OTEL_", "9464", '"metrics"'):
                    self.assertNotIn(needle, text, case)

    def test_each_switch_alone_does_nothing_without_monitoring_enabled(self):
        ds = manifests(tc.render_with("minimal", {"monitoring": {"serviceMonitor": {"enabled": True}, "prometheusRule": {"enabled": True}, "dashboard": {"enabled": True}}}))
        self.assertEqual([d for d in ds if d["kind"] in ("ServiceMonitor", "PrometheusRule")], [])
        self.assertNotIn("OMNISYNC_METRICS_PORT", json.dumps(ds))


class Endpoint(unittest.TestCase):
    def test_gateway_and_control_plane_serve_metrics_on_their_own_port(self):
        ds = on()
        for suffix in ("gateway", "control-plane"):
            c = main_container(ds, "-" + suffix)
            e = env(c)
            self.assertEqual(e["OMNISYNC_METRICS_PORT"]["value"], "9464", suffix)
            self.assertEqual(e["OMNISYNC_METRICS_HOST"]["value"], "0.0.0.0", suffix)
            ports = {p["name"]: p["containerPort"] for p in c["ports"]}
            self.assertEqual(ports["metrics"], 9464)
            self.assertNotEqual(ports["metrics"], ports["http"])

    def test_the_web_pods_get_nothing(self):
        for d in on():
            if d["kind"] == "Deployment" and "web" in d["metadata"]["name"]:
                self.assertNotIn("OMNISYNC_METRICS", json.dumps(d))
                self.assertNotIn("metrics", json.dumps(d["spec"]["template"]["spec"]["containers"][0]["ports"]))

    def test_services_expose_a_metrics_port_beside_http(self):
        ds = on()
        for suffix in ("gateway", "control-plane"):
            svc = component(ds, "Service", "-" + suffix)
            ports = {p["name"]: p for p in svc["spec"]["ports"]}
            self.assertEqual(sorted(ports), ["http", "metrics"])
            self.assertEqual(ports["metrics"]["port"], 9464)
            self.assertEqual(ports["metrics"]["targetPort"], "metrics")
        for d in ds:
            if d["kind"] == "Service" and "web" in d["metadata"]["name"]:
                self.assertEqual([p["name"] for p in d["spec"]["ports"]], ["http"])

    def test_the_ingress_never_routes_to_the_metrics_port(self):
        ing = [d for d in on() if d["kind"] == "Ingress"]
        self.assertTrue(ing)
        text = json.dumps(ing)
        self.assertNotIn("9464", text)
        self.assertNotIn("metrics", text)

    def test_probes_do_not_use_the_metrics_port(self):
        for d in on():
            if d["kind"] != "Deployment":
                continue
            for c in d["spec"]["template"]["spec"]["containers"]:
                for probe in ("livenessProbe", "readinessProbe", "startupProbe"):
                    self.assertNotEqual(c.get(probe, {}).get("httpGet", {}).get("port"), "metrics")

    def test_the_port_can_be_changed_and_stays_consistent(self):
        ds = on({"monitoring": {"port": 9100}})
        for suffix in ("gateway", "control-plane"):
            c = main_container(ds, "-" + suffix)
            self.assertEqual(env(c)["OMNISYNC_METRICS_PORT"]["value"], "9100")
            self.assertEqual({p["name"]: p["containerPort"] for p in c["ports"]}["metrics"], 9100)
            self.assertEqual({p["name"]: p["port"] for p in component(ds, "Service", "-" + suffix)["spec"]["ports"]}["metrics"], 9100)
        self.assertIn("TCP/9100", " ".join(tc.rows(ds)))
        self.assertNotIn("9464", json.dumps(ds))

    def test_the_hardening_rules_still_hold(self):
        for d, spec in tc.pod_specs(on()):
            for c, _ in tc.containers(spec):
                self.assertTrue(c["securityContext"]["readOnlyRootFilesystem"])
                self.assertFalse(c["securityContext"]["allowPrivilegeEscalation"])
                self.assertNotIn("hostPort", json.dumps(c.get("ports", [])))


class Network(unittest.TestCase):
    PROM = "[component in gateway|control-plane] ingress ns kubernetes.io/metadata.name=monitoring TCP/9464"

    def test_only_the_prometheus_namespace_reaches_the_metrics_port(self):
        before = tc.rows(tc.docs("minimal"))
        after = tc.rows(on())
        self.assertEqual(after - before, {self.PROM})
        self.assertEqual(before - after, set())

    def test_pod_labels_narrow_it_further(self):
        ds = manifests(tc.render_with("minimal", {"monitoring": {"enabled": True, "scrape": {"podLabels": {"app.kubernetes.io/name": "prometheus"}}}}))
        np = component(ds, "NetworkPolicy", "-from-prometheus")
        peer = np["spec"]["ingress"][0]["from"][0]
        self.assertEqual(peer["namespaceSelector"]["matchLabels"], {"kubernetes.io/metadata.name": "monitoring"})
        self.assertEqual(peer["podSelector"]["matchLabels"], {"app.kubernetes.io/name": "prometheus"})
        self.assertEqual(np["spec"]["ingress"][0]["ports"], [{"protocol": "TCP", "port": 9464}])

    def test_without_pod_labels_any_pod_in_that_namespace_may_scrape(self):
        np = component(on(), "NetworkPolicy", "-from-prometheus")
        self.assertNotIn("podSelector", np["spec"]["ingress"][0]["from"][0])

    def test_the_scrape_namespace_can_be_changed(self):
        ds = manifests(tc.render_with("minimal", {"monitoring": {"enabled": True, "scrape": {"namespaceLabels": {"kubernetes.io/metadata.name": "observability"}}}}))
        rows = tc.rows(ds)
        self.assertIn("[component in gateway|control-plane] ingress ns kubernetes.io/metadata.name=observability TCP/9464", rows)
        self.assertFalse([r for r in rows if "metadata.name=monitoring" in r], "the default namespace must be replaced, not kept beside the new one")

    def test_no_policy_object_when_policies_are_off(self):
        ds = manifests(tc.render_with("minimal", {"networkPolicy": {"enabled": False, "egress": {"s3": {"cidrs": []}, "postgresql": {"cidrs": []}}}, "monitoring": {"enabled": True}}))
        self.assertEqual([d for d in ds if d["kind"] == "NetworkPolicy"], [])


class ServiceMonitorAndDashboard(unittest.TestCase):
    def setUp(self):
        self.ds = manifests(tc.render_with("minimal", {"monitoring": monitoring()[0]}))

    def test_service_monitor_selects_exactly_the_two_services_and_their_metrics_port(self):
        sm = component(self.ds, "ServiceMonitor", "")
        self.assertEqual(sm["apiVersion"], "monitoring.coreos.com/v1")
        self.assertEqual(sm["metadata"]["labels"]["release"], "prometheus")
        self.assertEqual(sm["spec"]["endpoints"], [{"port": "metrics", "path": "/metrics", "interval": "30s", "scheme": "http"}])
        self.assertEqual(sm["spec"]["namespaceSelector"], {"matchNames": ["omnisync"]})
        sel = sm["spec"]["selector"]
        want = {}
        for d in self.ds:
            if d["kind"] != "Service":
                continue
            labels = d["metadata"]["labels"]
            ok = all(labels.get(k) == v for k, v in sel.get("matchLabels", {}).items())
            for e in sel.get("matchExpressions", []):
                ok = ok and e["operator"] == "In" and labels.get(e["key"]) in e["values"]
            want[d["metadata"]["name"]] = ok
        self.assertEqual(sorted(k.split("omnisync-")[-1] for k, v in want.items() if v), ["control-plane", "gateway"])
        for d in self.ds:
            if d["kind"] == "Service" and want[d["metadata"]["name"]]:
                self.assertIn("metrics", [p["name"] for p in d["spec"]["ports"]])

    def test_service_monitor_follows_the_release_namespace_and_interval(self):
        ds = manifests(render_chart(CHART, [os.path.join(tc.VALUES, "monitoring.yaml")], ["monitoring.serviceMonitor.interval=1m"], "prod", "team-a"))
        sm = component(ds, "ServiceMonitor", "")
        self.assertEqual(sm["spec"]["namespaceSelector"], {"matchNames": ["team-a"]})
        self.assertEqual(sm["spec"]["endpoints"][0]["interval"], "1m")
        self.assertIn("prod", json.dumps(sm["spec"]["selector"]))

    def test_dashboard_config_map_carries_the_file_unchanged_with_the_sidecar_label(self):
        cm = component(self.ds, "ConfigMap", "-dashboard")
        self.assertEqual(cm["metadata"]["labels"]["grafana_dashboard"], "1")
        self.assertEqual(list(cm["data"]), ["omnisync.json"])
        self.assertEqual(cm["data"]["omnisync.json"], open(os.path.join(CHART, "files", "omnisync-dashboard.json")).read().rstrip("\n"))
        self.assertEqual(json.loads(cm["data"]["omnisync.json"])["uid"], "omnisync-overview")
        self.assertLess(len(cm["data"]["omnisync.json"]), 900_000, "a ConfigMap is limited to 1 MiB")

    def test_dashboard_labels_are_configurable(self):
        ds = manifests(tc.render_with("minimal", {"monitoring": {"enabled": True, "dashboard": {"enabled": True, "labels": {"grafana_dashboard": "yes", "team": "sre"}}}}))
        labels = component(ds, "ConfigMap", "-dashboard")["metadata"]["labels"]
        self.assertEqual((labels["grafana_dashboard"], labels["team"]), ("yes", "sre"))

    def test_each_optional_object_follows_its_own_switch(self):
        for switch, kind in (("serviceMonitor", "ServiceMonitor"), ("prometheusRule", "PrometheusRule"), ("dashboard", "ConfigMap")):
            m = {**monitoring()[0]}
            m[switch] = {**m[switch], "enabled": False}
            ds = manifests(tc.render_with("minimal", {"monitoring": m}))
            names = [d["metadata"]["name"] for d in ds if d["kind"] == kind]
            if kind == "ConfigMap":
                self.assertFalse([n for n in names if n.endswith("-dashboard")])
            else:
                self.assertEqual(names, [], switch)


class Tracing(unittest.TestCase):
    def setUp(self):
        self.ds = manifests(tc.render_with("minimal", {"monitoring": monitoring()[0]}))

    def test_only_the_gateway_traces(self):
        e = env(main_container(self.ds, "-gateway"))
        self.assertEqual(e["OMNISYNC_TRACES_ENABLED"]["value"], "1")
        self.assertEqual(e["OTEL_EXPORTER_OTLP_ENDPOINT"]["value"], "https://otel.acme.test:4318")
        self.assertEqual(e["OMNISYNC_TRACE_SAMPLE_RATIO"]["value"], "0.05")
        cp = env(main_container(self.ds, "-control-plane"))
        for k in ("OMNISYNC_TRACES_ENABLED", "OTEL_EXPORTER_OTLP_ENDPOINT", "OMNISYNC_TRACE_SAMPLE_RATIO", "OTEL_EXPORTER_OTLP_HEADERS"):
            self.assertNotIn(k, cp)

    def test_collector_credentials_come_from_the_secret_and_are_optional(self):
        h = env(main_container(self.ds, "-gateway"))["OTEL_EXPORTER_OTLP_HEADERS"]
        self.assertEqual(h["valueFrom"]["secretKeyRef"], {"name": "omnisync-secrets", "key": "otlp-headers", "optional": True})
        self.assertNotIn("value", h)

    def test_the_collector_is_reachable_from_the_gateway_only_and_only_on_its_port(self):
        rows = tc.rows(self.ds) - tc.rows(tc.docs("minimal"))
        self.assertIn("[component=gateway] egress cidr 10.40.0.0/24 TCP/4318", rows)
        self.assertEqual([r for r in rows if "4318" in r], ["[component=gateway] egress cidr 10.40.0.0/24 TCP/4318"])

    def test_the_sample_ratio_defaults_to_one_in_a_hundred_and_the_collector_port_is_configurable(self):
        ds = on({"monitoring": {"tracing": {"enabled": True, "endpoint": "https://otel.acme.test:4317", "egress": {"cidrs": ["10.40.0.0/24"], "port": 4317}}}})
        self.assertEqual(env(main_container(ds, "-gateway"))["OMNISYNC_TRACE_SAMPLE_RATIO"]["value"], "0.01")
        self.assertIn("[component=gateway] egress cidr 10.40.0.0/24 TCP/4317", tc.rows(ds))
        self.assertEqual([r for r in tc.rows(ds) if "4318" in r], [])

    def test_collector_ranges_open_nothing_while_tracing_is_off(self):
        ds = on({"monitoring": {"tracing": {"enabled": False, "egress": {"cidrs": ["10.40.0.0/24"], "port": 4318}}}})
        self.assertEqual([r for r in tc.rows(ds) if "10.40.0.0" in r], [])

    def test_tracing_is_off_unless_asked_even_with_monitoring_on(self):
        e = env(main_container(on(), "-gateway"))
        self.assertNotIn("OMNISYNC_TRACES_ENABLED", e)
        self.assertNotIn("OTEL_EXPORTER_OTLP_ENDPOINT", e)
        self.assertEqual([r for r in tc.rows(on()) if "4318" in r], [])


class Schema(unittest.TestCase):
    def refused(self, patch, text):
        base = monitoring()[0]
        merged = {**base, **{k: ({**base.get(k, {}), **v} if isinstance(v, dict) and isinstance(base.get(k), dict) else v) for k, v in patch.items()}}
        with self.assertRaises(TemplateError) as cm:
            tc.render_with("minimal", {"monitoring": merged})
        self.assertIn(text, str(cm.exception))

    def ok(self, patch):
        base = monitoring()[0]
        merged = {**base, **{k: ({**base.get(k, {}), **v} if isinstance(v, dict) and isinstance(base.get(k), dict) else v) for k, v in patch.items()}}
        tc.render_with("minimal", {"monitoring": merged})

    def test_port_bounds_and_the_application_ports(self):
        for port in (0, 80, 1023, 65536, 8080, 8081, "9464"):
            with self.subTest(port=port):
                self.refused({"port": port}, "port")
        self.ok({"port": 1024})
        self.ok({"port": 65535})

    def test_unknown_keys_are_refused_everywhere_below_monitoring(self):
        self.refused({"nope": 1}, "nope")
        self.refused({"prometheusRule": {"nope": 1}}, "nope")
        self.refused({"prometheusRule": {"alerts": {"nope": 1}}}, "nope")
        self.refused({"tracing": {"nope": 1}}, "nope")

    def test_values_cannot_smuggle_promql_into_a_rule(self):
        for patch in (
            {"prometheusRule": {"alerts": {"postgresReplicaLagSeconds": 30, "postgresReplicaLagMetric": "up) or vector(1) #"}}},
            {"prometheusRule": {"alerts": {"postgresReplicaLagSeconds": 30, "postgresReplicaLagMetric": "a b"}}},
            {"prometheusRule": {"alerts": {"postgresReplicaLagSeconds": 30, "postgresReplicaLagMetric": ""}}},
            {"prometheusRule": {"alerts": {"checkpointAgeSeconds": "900) or vector(1) #"}}},
            {"prometheusRule": {"alerts": {"signatureFailuresPerSecond": "0.2 or vector(1)"}}},
            {"prometheusRule": {"alerts": {"licensedConnections": "5 or vector(1)"}}},
        ):
            with self.subTest(patch=patch), self.assertRaises(TemplateError):
                base = monitoring()[0]
                tc.render_with("minimal", {"monitoring": {**base, "prometheusRule": {**base["prometheusRule"], "alerts": patch["prometheusRule"]["alerts"]}}})

    def test_threshold_bounds(self):
        for key, bad in (("checkpointAgeSeconds", 0), ("checkpointAgeSeconds", -1), ("signatureFailuresPerSecond", 0), ("ledgerAppendP99Seconds", 0), ("connectionsWarnRatio", 0), ("connectionsWarnRatio", 1.01), ("connectionsWarnRatio", 1.5), ("licensedConnections", -1), ("postgresReplicaLagSeconds", -1)):
            with self.subTest(key=key, bad=bad):
                self.refused({"prometheusRule": {"alerts": {key: bad}}}, key)

    def test_tracing_needs_an_http_endpoint_without_credentials_and_a_ratio_in_range(self):
        for endpoint in ("", "otel.acme.test:4318", "ftp://x", "https://user:pw@otel.acme.test", "https://user@otel.acme.test", "javascript:1", "https://a b"):
            with self.subTest(endpoint=endpoint):
                self.refused({"tracing": {"endpoint": endpoint}}, "endpoint")
        for ratio in (-0.1, 1.1, "0.5"):
            with self.subTest(ratio=ratio):
                self.refused({"tracing": {"sampleRatio": ratio}}, "sampleRatio")
        self.ok({"tracing": {"endpoint": "http://otel-collector.observability.svc:4318/", "sampleRatio": 0}})
        self.ok({"tracing": {"sampleRatio": 0.0001}})
        self.ok({"tracing": {"sampleRatio": 1}})
        self.refused({"tracing": {"sampleRatio": 0.00001}}, "sampleRatio")  # below one in ten thousand and not zero: a typo, not a choice

    def test_tracing_needs_egress_cidrs_when_policies_are_on(self):
        self.refused({"tracing": {"egress": {"cidrs": []}}}, "cidrs")
        base = monitoring()[0]
        tc.render_with("minimal", {"networkPolicy": {"enabled": False, "egress": {"s3": {"cidrs": []}, "postgresql": {"cidrs": []}}}, "monitoring": {**base, "tracing": {**base["tracing"], "egress": {"cidrs": [], "port": 4318}}}})

    def test_scrape_selector_labels_must_be_strings(self):
        self.refused({"scrape": {"namespaceLabels": {"a": 1}}}, "namespaceLabels")


if __name__ == "__main__":
    unittest.main()

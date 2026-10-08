#!/usr/bin/env python3
"""Builds the Grafana dashboard shipped in the chart (deploy/helm/omnisync/files/omnisync-dashboard.json).

The JSON is generated, not hand-edited, so panels stay consistent and the tests can compare the committed file with this
script's output:

    python3 deploy/monitoring/dashboard.py --write     # regenerate the file
    python3 deploy/monitoring/dashboard.py --check     # exit 1 when the committed file is stale

Every expression reads a metric listed in docs/specs/observability.md; deploy/tests/test_monitoring.py holds them to
that list (names, labels, rate() only of counters, `le` kept for quantiles) and requires every metric to appear."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "..", "helm", "omnisync", "files", "omnisync-dashboard.json")

DS = {"type": "prometheus", "uid": "${datasource}"}
CHECKPOINT_ALERT_SECONDS = 900  # the default of monitoring.prometheusRule.alerts.checkpointAgeSeconds
APPEND_ALERT_SECONDS = 0.1  # the default of monitoring.prometheusRule.alerts.ledgerAppendP99Seconds

GREEN, ORANGE, RED = "green", "orange", "red"


def steps(*pairs):
    """Threshold steps from (value, color) pairs; the first is the base."""
    out = [{"color": pairs[0][1], "value": None}]
    out += [{"color": c, "value": v} for v, c in pairs[1:]]
    return {"mode": "absolute", "steps": out}


class Builder:
    def __init__(self):
        self.panels = []
        self._id = 0

    def _next(self):
        self._id += 1
        return self._id

    def row(self, title, y):
        self.panels.append({"id": self._next(), "type": "row", "title": title, "collapsed": False, "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}, "panels": []})

    def stat(self, title, expr, x, y, w=4, h=4, unit="short", thresholds=None, mappings=None, description=""):
        self.panels.append(
            {
                "id": self._next(),
                "type": "stat",
                "title": title,
                "description": description,
                "datasource": DS,
                "gridPos": {"x": x, "y": y, "w": w, "h": h},
                "targets": [target(expr, "", "A", instant=True)],
                "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}, "colorMode": "background", "graphMode": "area", "textMode": "auto"},
                "fieldConfig": {"defaults": {"unit": unit, "thresholds": thresholds or steps((None, GREEN)), "mappings": mappings or []}, "overrides": []},
            }
        )

    def series(self, title, targets, x, y, w, h=8, unit="short", description="", threshold=None, stack=False):
        custom = {"drawStyle": "line", "lineWidth": 1, "fillOpacity": 10 if stack else 0, "showPoints": "never", "spanNulls": False}
        if stack:
            custom["stacking"] = {"mode": "normal", "group": "A"}
        defaults = {"unit": unit, "custom": custom}
        if threshold is not None:
            defaults["custom"]["thresholdsStyle"] = {"mode": "line"}
            defaults["thresholds"] = steps((None, GREEN), (threshold, RED))
        else:
            defaults["thresholds"] = steps((None, GREEN))
        self.panels.append(
            {
                "id": self._next(),
                "type": "timeseries",
                "title": title,
                "description": description,
                "datasource": DS,
                "gridPos": {"x": x, "y": y, "w": w, "h": h},
                "targets": [target(e, legend, chr(ord("A") + i)) for i, (e, legend) in enumerate(targets)],
                "options": {"legend": {"displayMode": "list", "placement": "bottom", "showLegend": True}, "tooltip": {"mode": "multi", "sort": "desc"}},
                "fieldConfig": {"defaults": defaults, "overrides": []},
            }
        )


def target(expr, legend, ref, instant=False):
    t = {"datasource": DS, "editorMode": "code", "expr": expr, "legendFormat": legend, "refId": ref}
    if instant:
        t["instant"] = True
        t["range"] = False
    else:
        t["range"] = True
    return t


def quantiles(metric, qs=(0.5, 0.95, 0.99), by="le"):
    return [(f"histogram_quantile({q}, sum by ({by}) (rate({metric}_bucket[5m])))", f"p{int(q * 100)}") for q in qs]


def build():
    b = Builder()

    # ---- health at a glance ------------------------------------------------------------------------------------------
    b.row("Health", 0)
    b.stat("Open connections", "sum(omnisync_connections_active)", 0, 1, description="WebSocket connections open on the gateway right now.")
    b.stat("Documents in memory", "sum(omnisync_documents_active)", 4, 1, description="Documents the gateway holds in memory; idle ones are evicted after a minute.")
    b.stat("Edits waiting for the database", "sum(omnisync_append_queue_depth)", 8, 1, thresholds=steps((None, GREEN), (100, ORANGE), (1000, RED)), description="Verified updates queued for or being written to the update log. Should sit near zero.")
    b.stat(
        "Checkpoint age",
        "max(omnisync_checkpoint_age_seconds)",
        12,
        1,
        unit="s",
        thresholds=steps((None, GREEN), (300, ORANGE), (CHECKPOINT_ALERT_SECONDS, RED)),
        description="Time since everything acknowledged was last covered by an uploaded signed checkpoint. The alert fires at 15 minutes.",
    )
    b.stat(
        "Update log",
        "max(omnisync_store_degraded)",
        16,
        1,
        thresholds=steps((None, GREEN), (1, RED)),
        mappings=[{"type": "value", "options": {"0": {"text": "OK", "color": GREEN}, "1": {"text": "FAILING", "color": RED}}}],
        description="FAILING while the last write to PostgreSQL failed; edits cannot be made durable until a write succeeds.",
    )
    b.stat("Signature failures per second", "sum(rate(omnisync_signature_failures_total[5m]))", 20, 1, unit="ops", thresholds=steps((None, GREEN), (0.2, RED)), description="Updates refused for an unknown key, a bad signature or a wrong frame type.")

    # ---- the edit path -----------------------------------------------------------------------------------------------
    b.row("Edit path", 5)
    b.series("Edit latency: arrival to acknowledgement", quantiles("omnisync_update_apply_seconds"), 0, 6, 12, unit="s", description="Verification, queueing, the update log write and applying the edit, for edits the gateway accepted or refused.")
    b.series("Update log write latency", quantiles("omnisync_ledger_append_seconds"), 12, 6, 12, unit="s", threshold=APPEND_ALERT_SECONDS, description="One group-commit call to PostgreSQL. The line is the alert threshold for p99.")
    b.series("Fan-out latency", quantiles("omnisync_fanout_seconds", qs=(0.5, 0.99)), 0, 14, 8, unit="s", description="Relaying one accepted edit to the other connections on the document.")
    b.series("Updates made durable per second", [("sum by (outcome) (rate(omnisync_updates_total[5m]))", "{{outcome}}")], 8, 14, 8, unit="ops", stack=True, description="persisted = a new edit; duplicate = a client retry of an edit already stored.")
    b.series(
        "Connections and documents",
        [("sum(omnisync_connections_active)", "connections"), ("sum(omnisync_documents_active)", "documents")],
        16,
        14,
        8,
        description="Open connections and documents resident in memory.",
    )
    b.series("Refused for their signature, per second", [("sum by (reason) (rate(omnisync_signature_failures_total[5m]))", "{{reason}}")], 0, 22, 8, unit="ops", stack=True, description="Updates the gateway refused before they reached the log.")
    b.series("Refused at admission, per second", [("sum by (reason) (rate(omnisync_admission_rejections_total[5m]))", "{{reason}}")], 8, 22, 8, unit="ops", stack=True, description="Rate limits, the catch-up limit, roles, malformed frames, edit times outside a certificate's life and store failures.")
    b.series("Connection results, per second", [("sum by (outcome) (rate(omnisync_connections_total[5m]))", "{{outcome}}")], 16, 22, 8, unit="ops", stack=True, description="Authentication results: ok, or failed for any reason.")
    b.series(
        "Update log queue and state",
        [("sum(omnisync_append_queue_depth)", "waiting edits"), ("max(omnisync_store_degraded)", "log failing (1)")],
        0,
        30,
        12,
        description="Edits waiting for PostgreSQL, and whether the last write failed.",
    )
    b.series("Document snapshot failures (15 minutes)", [("sum(increase(omnisync_snapshot_failures_total[15m]))", "failures")], 12, 30, 12, description="Snapshots are a cache over the log; a failure costs a slower cold load, not data.")

    # ---- the evidence log --------------------------------------------------------------------------------------------
    b.row("Evidence log", 38)
    b.series("Checkpoint age over time", [("max(omnisync_checkpoint_age_seconds)", "age")], 0, 39, 12, unit="s", threshold=CHECKPOINT_ALERT_SECONDS, description="Normally under about 5 minutes plus one poll. The line is the alert threshold.")
    b.series("Checkpoints uploaded per hour", [("sum(increase(omnisync_checkpoints_total[1h]))", "checkpoints")], 12, 39, 6, description="Zero while nothing is edited is normal.")
    b.series(
        "Checkpoint failures (15 minutes)",
        [("sum by (kind) (increase(omnisync_checkpoint_failures_total[15m]))", "{{kind}}")],
        18,
        39,
        6,
        stack=True,
        description="sign, store, upload, or conflict. A conflict means different bytes already exist under a checkpoint number and needs a person.",
    )

    # ---- the control plane -------------------------------------------------------------------------------------------
    b.row("Control plane", 47)
    b.series("Requests per second by status class", [("sum by (status_class) (rate(omnisync_http_request_seconds_count[5m]))", "{{status_class}}")], 0, 48, 8, unit="reqps", stack=True, description="All control plane routes.")
    b.series("Latency by route, p95", [(quantiles("omnisync_http_request_seconds", qs=(0.95,), by="le, route")[0][0], "{{route}}")], 8, 48, 8, unit="s", description="95th percentile of request time per route template.")
    b.series("Logins per hour", [("sum by (outcome) (increase(omnisync_logins_total[1h]))", "{{outcome}}")], 16, 48, 4, stack=True, description="Results of the identity provider callback.")
    b.series("Certificates issued per hour", [("sum(increase(omnisync_certificates_issued_total[1h]))", "issued")], 20, 48, 4, description="Device certificates the control plane signed.")
    b.series("Throttled requests per second", [("sum by (route) (rate(omnisync_rate_limited_total[5m]))", "{{route}}")], 0, 56, 12, unit="reqps", description="Requests answered 429 by the control plane's own limits (the ingress has its own).")

    return {
        "uid": "omnisync-overview",
        "title": "OmniSync overview",
        "description": "Health, edit path, evidence log and control plane of an OmniSync installation. Generated by deploy/monitoring/dashboard.py.",
        "tags": ["omnisync"],
        "schemaVersion": 39,
        "version": 1,
        "editable": True,
        "graphTooltip": 1,
        "refresh": "30s",
        "time": {"from": "now-6h", "to": "now"},
        "timezone": "browser",
        "templating": {"list": [{"name": "datasource", "label": "Prometheus", "type": "datasource", "query": "prometheus", "current": {}, "hide": 0, "refresh": 1, "regex": ""}]},
        "annotations": {"list": []},
        "links": [],
        "panels": b.panels,
    }


def render():
    return json.dumps(build(), indent=2) + "\n"


def main(argv):
    if "--write" in argv:
        with open(TARGET, "w") as f:
            f.write(render())
        print("wrote", os.path.relpath(TARGET))
        return 0
    if "--check" in argv:
        try:
            current = open(TARGET).read()
        except FileNotFoundError:
            current = ""
        if current != render():
            print("omnisync-dashboard.json is stale: run python3 deploy/monitoring/dashboard.py --write", file=sys.stderr)
            return 1
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

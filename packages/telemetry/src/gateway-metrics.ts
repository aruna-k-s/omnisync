import { metrics, type Attributes, type Histogram, type Meter, type ObservableResult } from "@opentelemetry/api";
import { SECONDS_BUCKETS, pick, safely, validSeconds } from "./safe.js";

/** What the gateway lets telemetry read. Everything is read at scrape time; nothing here touches the database. */
export interface GatewayCounters {
  persisted: number;
  duplicates: number;
  snapshotFailures: number;
  authenticated: number;
  busyRejections: number;
  /** Reason to count. Reasons come from code, but are never trusted as label values. */
  authFailures: Record<string, number>;
  rejected: Record<string, number>;
}

export interface GatewaySource {
  connections(): number;
  documents(): number;
  appendQueueDepth(): number;
  degraded(): boolean;
  stats(): GatewayCounters;
}

export interface CheckpointSource {
  stats(): { uploaded: number; signFailures: number; storeFailures: number; uploadFailures: number; uploadConflicts: number };
  /** Seconds since the writer last knew everything acknowledged was covered by an uploaded checkpoint. */
  behindSeconds(): number;
}

const SIGNATURE_REASONS = ["unknown_key", "bad_signature", "not_update"] as const;
const ADMISSION_REASONS = ["rate_limited", "busy", "forbidden", "upload_only", "malformed", "claimed_time", "store_error", "other"] as const;
type AdmissionReason = (typeof ADMISSION_REASONS)[number];
const UPDATE_OUTCOMES = ["ok", "rejected"] as const;
const APPEND_OUTCOMES = ["ok", "error"] as const;

/** Maps a rejection bucket onto the closed admission set. Signature failures are counted under their own name. */
function admissionReason(bucket: string): AdmissionReason | undefined {
  if ((SIGNATURE_REASONS as readonly string[]).includes(bucket)) return undefined;
  switch (bucket) {
    case "rate_limited":
    case "forbidden":
    case "upload_only":
    case "malformed":
      return bucket;
    case "claimed_before_validity":
    case "claimed_after_expiry":
    case "claimed_in_future":
      return "claimed_time";
    case "unavailable":
    case "internal":
      return "store_error";
    default:
      return "other"; // includes "busy": that count comes from busyRejections, so a bucket of that name cannot double it
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export class GatewayMetrics {
  readonly #meter: Meter;
  #update: Histogram | undefined;
  #append: Histogram | undefined;
  #fanout: Histogram | undefined;
  #observed = false;
  #checkpointsObserved = false;

  constructor(meter?: Meter) {
    this.#meter = meter ?? metrics.getMeter("omnisync");
    safely(() => {
      const advice = { explicitBucketBoundaries: SECONDS_BUCKETS };
      this.#update = this.#meter.createHistogram("omnisync_update_apply_seconds", {
        description: "Seconds from an edit arriving to its sender being acknowledged or refused",
        advice,
      });
    });
    safely(() => {
      this.#append = this.#meter.createHistogram("omnisync_ledger_append_seconds", {
        description: "Seconds for one group-commit call to the update log",
        advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
      });
    });
    safely(() => {
      this.#fanout = this.#meter.createHistogram("omnisync_fanout_seconds", {
        description: "Seconds to relay one accepted edit to its peers",
        advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
      });
    });
  }

  updateFinished(seconds: number, outcome: (typeof UPDATE_OUTCOMES)[number]): void {
    if (!validSeconds(seconds)) return;
    safely(() => this.#update?.record(seconds, { outcome: pick(UPDATE_OUTCOMES, outcome) }));
  }

  ledgerAppend(seconds: number, outcome: (typeof APPEND_OUTCOMES)[number]): void {
    if (!validSeconds(seconds)) return;
    safely(() => this.#append?.record(seconds, { outcome: pick(APPEND_OUTCOMES, outcome) }));
  }

  fanout(seconds: number): void {
    if (!validSeconds(seconds)) return;
    safely(() => this.#fanout?.record(seconds));
  }

  /** Binds the gauges and the counters the gateway already keeps. Call once. */
  observe(src: GatewaySource): void {
    if (this.#observed) return;
    this.#observed = true;
    const m = this.#meter;
    const gauge = (name: string, description: string, read: () => number): void =>
      safely(() => {
        m.createObservableGauge(name, { description }).addCallback((r) => safely(() => r.observe(num(read()))));
      });
    gauge("omnisync_connections_active", "Open WebSocket connections", () => src.connections());
    gauge("omnisync_documents_active", "Documents resident in memory", () => src.documents());
    gauge("omnisync_append_queue_depth", "Verified updates waiting for the update log, all documents", () => src.appendQueueDepth());
    gauge("omnisync_store_degraded", "1 while the last update log call failed", () => (src.degraded() ? 1 : 0));

    const counter = (name: string, description: string, read: (r: ObservableResult<Attributes>, s: GatewayCounters) => void): void =>
      safely(() => {
        m.createObservableCounter(name, { description }).addCallback((r) => safely(() => read(r, src.stats())));
      });
    counter("omnisync_updates_total", "Updates made durable", (r, s) => {
      r.observe(num(s.persisted), { outcome: "persisted" });
      r.observe(num(s.duplicates), { outcome: "duplicate" });
    });
    counter("omnisync_connections_total", "Connection authentication results", (r, s) => {
      let failed = 0;
      for (const v of Object.values(s.authFailures)) failed += num(v);
      r.observe(num(s.authenticated), { outcome: "ok" });
      r.observe(failed, { outcome: "failed" });
    });
    counter("omnisync_signature_failures_total", "Updates refused by signature verification", (r, s) => {
      for (const reason of SIGNATURE_REASONS) r.observe(num(s.rejected[reason]), { reason });
    });
    counter("omnisync_admission_rejections_total", "Frames refused before reaching the update log", (r, s) => {
      const sums = Object.fromEntries(ADMISSION_REASONS.map((k) => [k, 0])) as Record<AdmissionReason, number>;
      for (const [bucket, count] of Object.entries(s.rejected)) {
        const reason = admissionReason(bucket);
        if (reason !== undefined) sums[reason] += num(count);
      }
      sums.busy += num(s.busyRejections);
      for (const reason of ADMISSION_REASONS) r.observe(sums[reason], { reason });
    });
    counter("omnisync_snapshot_failures_total", "Failed document snapshots", (r, s) => r.observe(num(s.snapshotFailures)));
  }

  /** Binds the checkpoint writer's counters and its age. Call once. */
  observeCheckpoints(src: CheckpointSource): void {
    if (this.#checkpointsObserved) return;
    this.#checkpointsObserved = true;
    const m = this.#meter;
    safely(() => {
      m.createObservableGauge("omnisync_checkpoint_age_seconds", {
        description: "Seconds since the checkpoint writer last knew everything acknowledged was covered by an uploaded checkpoint",
      }).addCallback((r) => safely(() => r.observe(num(src.behindSeconds()))));
    });
    safely(() => {
      m.createObservableCounter("omnisync_checkpoints_total", { description: "Checkpoints uploaded" }).addCallback((r) =>
        safely(() => r.observe(num(src.stats().uploaded))),
      );
    });
    safely(() => {
      m.createObservableCounter("omnisync_checkpoint_failures_total", {
        description: "Failed checkpoint steps; conflict means different bytes already exist under a number and needs a person",
      }).addCallback((r) =>
        safely(() => {
          const s = src.stats();
          r.observe(num(s.signFailures), { kind: "sign" });
          r.observe(num(s.storeFailures), { kind: "store" });
          r.observe(num(s.uploadFailures), { kind: "upload" });
          r.observe(num(s.uploadConflicts), { kind: "conflict" });
        }),
      );
    });
  }
}

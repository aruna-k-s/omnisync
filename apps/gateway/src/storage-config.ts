import { resolve } from "node:path";
import { FsObjectStore, type ObjectStore } from "@omnisync/store";
import type { S3ObjectStore } from "@omnisync/store/s3";

/** Where snapshots and ledger checkpoints live. Pure description; `openStorage` builds the stores. Spec: docs/specs/s3-object-store.md. */
export interface StorageConfig {
  snapshots: { kind: "fs"; dir: string } | { kind: "s3"; bucket: string };
  checkpoints: { kind: "fs"; dir: string } | { kind: "s3"; bucket: string; retainDays: number; mode: "COMPLIANCE" | "GOVERNANCE" };
  /** Present when either location is a bucket. */
  s3?: { endpoint?: string; region: string; forcePathStyle: boolean };
}

type Env = Record<string, string | undefined>;

// Every message names the variable and never repeats its value: a value may carry a secret by mistake.
const BUCKET = /^(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function bucketName(env: Env, name: string): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  if (!BUCKET.test(v) || IPV4.test(v)) throw new Error(`${name} is not a valid S3 bucket name (3-63 lowercase letters, digits, hyphens, dots)`);
  return v;
}

export function parseStorageConfig(env: Env): StorageConfig {
  const dataDir = env["OMNISYNC_DATA_DIR"];
  const ckptDir = env["OMNISYNC_CHECKPOINT_DIR"];
  const snapBucket = bucketName(env, "OMNISYNC_SNAPSHOT_S3_BUCKET");
  const ckptBucket = bucketName(env, "OMNISYNC_CHECKPOINT_S3_BUCKET");

  if (dataDir !== undefined && snapBucket !== undefined) throw new Error("set only one of OMNISYNC_DATA_DIR and OMNISYNC_SNAPSHOT_S3_BUCKET");
  if (ckptDir !== undefined && ckptBucket !== undefined) throw new Error("set only one of OMNISYNC_CHECKPOINT_DIR and OMNISYNC_CHECKPOINT_S3_BUCKET");
  if (ckptDir === undefined && ckptBucket === undefined) throw new Error("missing environment variable OMNISYNC_CHECKPOINT_DIR or OMNISYNC_CHECKPOINT_S3_BUCKET");
  if (snapBucket !== undefined && snapBucket === ckptBucket) throw new Error("OMNISYNC_SNAPSHOT_S3_BUCKET and OMNISYNC_CHECKPOINT_S3_BUCKET must differ: checkpoints need Object Lock and snapshots do not");

  const snapshots: StorageConfig["snapshots"] = snapBucket !== undefined ? { kind: "s3", bucket: snapBucket } : { kind: "fs", dir: dataDir ?? "./.omnisync-data" };

  let checkpoints: StorageConfig["checkpoints"];
  if (ckptBucket !== undefined) {
    const days = env["OMNISYNC_CHECKPOINT_RETAIN_DAYS"];
    if (days === undefined) throw new Error("missing environment variable OMNISYNC_CHECKPOINT_RETAIN_DAYS (days to keep each checkpoint locked; it cannot be shortened later)");
    if (!/^[1-9][0-9]{0,4}$/.test(days) || Number(days) > 36_500) throw new Error("OMNISYNC_CHECKPOINT_RETAIN_DAYS must be a whole number of days from 1 to 36500");
    const mode = env["OMNISYNC_CHECKPOINT_LOCK_MODE"] ?? "COMPLIANCE";
    if (mode !== "COMPLIANCE" && mode !== "GOVERNANCE") throw new Error("OMNISYNC_CHECKPOINT_LOCK_MODE must be COMPLIANCE or GOVERNANCE");
    checkpoints = { kind: "s3", bucket: ckptBucket, retainDays: Number(days), mode };
  } else {
    if (env["OMNISYNC_CHECKPOINT_RETAIN_DAYS"] !== undefined || env["OMNISYNC_CHECKPOINT_LOCK_MODE"] !== undefined) {
      throw new Error("OMNISYNC_CHECKPOINT_RETAIN_DAYS and OMNISYNC_CHECKPOINT_LOCK_MODE only apply with OMNISYNC_CHECKPOINT_S3_BUCKET");
    }
    checkpoints = { kind: "fs", dir: ckptDir as string };
  }

  if (snapshots.kind === "fs" && checkpoints.kind === "fs" && resolve(snapshots.dir) === resolve(checkpoints.dir)) {
    throw new Error("OMNISYNC_CHECKPOINT_DIR must not be the snapshot directory: checkpoints belong in the locked bucket");
  }

  if (snapshots.kind === "fs" && checkpoints.kind === "fs") {
    for (const n of ["OMNISYNC_S3_ENDPOINT", "OMNISYNC_S3_REGION", "OMNISYNC_S3_PATH_STYLE"]) {
      if (env[n] !== undefined) throw new Error(`${n} only applies with an S3 bucket`);
    }
    return { snapshots, checkpoints };
  }
  return { snapshots, checkpoints, s3: parseS3(env) };
}

function parseS3(env: Env): NonNullable<StorageConfig["s3"]> {
  const out: NonNullable<StorageConfig["s3"]> = { region: "us-east-1", forcePathStyle: false };
  const endpoint = env["OMNISYNC_S3_ENDPOINT"];
  if (endpoint !== undefined) {
    let u: URL | undefined;
    try {
      u = new URL(endpoint);
    } catch {
      u = undefined;
    }
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || u.hostname === "") throw new Error("OMNISYNC_S3_ENDPOINT must be an http or https URL");
    if (u.username !== "" || u.password !== "") throw new Error("OMNISYNC_S3_ENDPOINT must not contain credentials; use the AWS_* environment variables");
    out.endpoint = endpoint;
  }
  const region = env["OMNISYNC_S3_REGION"];
  if (region !== undefined) {
    if (!/^[a-z][a-z0-9-]{1,29}$/.test(region)) throw new Error("OMNISYNC_S3_REGION must look like us-east-1");
    out.region = region;
  }
  const style = env["OMNISYNC_S3_PATH_STYLE"];
  if (style !== undefined) {
    if (style !== "0" && style !== "1") throw new Error("OMNISYNC_S3_PATH_STYLE must be 0 or 1");
    out.forcePathStyle = style === "1";
  }
  return out;
}

export interface OpenedStorage {
  snapshots: ObjectStore;
  checkpoints: ObjectStore;
}

/**
 * Builds the stores and, for buckets, checks them before anything listens: the checkpoint bucket must have Object
 * Lock and versioning, the snapshot bucket must exist. The AWS SDK is imported only when a bucket is configured.
 */
export async function openStorage(cfg: StorageConfig): Promise<OpenedStorage> {
  const s3 = cfg.s3;
  const mod = s3 ? await import("@omnisync/store/s3") : undefined;
  const open = (extra: { bucket: string; lock?: { mode: "COMPLIANCE" | "GOVERNANCE"; retainDays: number } }): S3ObjectStore => {
    if (!mod || !s3) throw new Error("storage: an S3 location needs the S3 settings");
    return new mod.S3ObjectStore({ region: s3.region, forcePathStyle: s3.forcePathStyle, ...(s3.endpoint ? { endpoint: s3.endpoint } : {}), ...extra });
  };

  let snapshots: ObjectStore;
  if (cfg.snapshots.kind === "fs") snapshots = new FsObjectStore(cfg.snapshots.dir);
  else {
    const store = open({ bucket: cfg.snapshots.bucket });
    await store.verifyBucket();
    snapshots = store;
  }

  let checkpoints: ObjectStore;
  if (cfg.checkpoints.kind === "fs") checkpoints = new FsObjectStore(cfg.checkpoints.dir);
  else {
    const store = open({ bucket: cfg.checkpoints.bucket, lock: { mode: cfg.checkpoints.mode, retainDays: cfg.checkpoints.retainDays } });
    await store.verifyBucket();
    checkpoints = store;
  }
  return { snapshots, checkpoints };
}

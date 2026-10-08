import { describe, expect, it } from "vitest";
import { parseStorageConfig } from "../src/index.js";

const fsEnv = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  OMNISYNC_DATA_DIR: "/var/data",
  OMNISYNC_CHECKPOINT_DIR: "/var/locked",
  ...over,
});
const s3Env = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  OMNISYNC_SNAPSHOT_S3_BUCKET: "omni-snapshots",
  OMNISYNC_CHECKPOINT_S3_BUCKET: "omni-checkpoints",
  OMNISYNC_CHECKPOINT_RETAIN_DAYS: "2555",
  OMNISYNC_S3_ENDPOINT: "http://minio:9000",
  OMNISYNC_S3_PATH_STYLE: "1",
  ...over,
});

describe("parseStorageConfig", () => {
  it("accepts directories for both, as before", () => {
    const c = parseStorageConfig(fsEnv());
    expect(c.snapshots).toEqual({ kind: "fs", dir: "/var/data" });
    expect(c.checkpoints).toEqual({ kind: "fs", dir: "/var/locked" });
    expect(c.s3).toBeUndefined();
  });

  it("defaults the snapshot directory but never the checkpoint location", () => {
    expect(parseStorageConfig(fsEnv({ OMNISYNC_DATA_DIR: undefined })).snapshots).toEqual({ kind: "fs", dir: "./.omnisync-data" });
    expect(() => parseStorageConfig(fsEnv({ OMNISYNC_CHECKPOINT_DIR: undefined }))).toThrow(/OMNISYNC_CHECKPOINT_DIR or OMNISYNC_CHECKPOINT_S3_BUCKET/);
  });

  it("accepts buckets for both, with the endpoint settings", () => {
    const c = parseStorageConfig(s3Env());
    expect(c.snapshots).toEqual({ kind: "s3", bucket: "omni-snapshots" });
    expect(c.checkpoints).toEqual({ kind: "s3", bucket: "omni-checkpoints", retainDays: 2555, mode: "COMPLIANCE" });
    expect(c.s3).toEqual({ endpoint: "http://minio:9000", region: "us-east-1", forcePathStyle: true });
  });

  it("mixes a snapshot directory with a checkpoint bucket", () => {
    const c = parseStorageConfig(s3Env({ OMNISYNC_SNAPSHOT_S3_BUCKET: undefined, OMNISYNC_DATA_DIR: "/d" }));
    expect(c.snapshots).toEqual({ kind: "fs", dir: "/d" });
    expect(c.checkpoints.kind).toBe("s3");
  });

  it("refuses a directory and a bucket for the same purpose", () => {
    expect(() => parseStorageConfig(s3Env({ OMNISYNC_DATA_DIR: "/d" }))).toThrow(/OMNISYNC_DATA_DIR and OMNISYNC_SNAPSHOT_S3_BUCKET/);
    expect(() => parseStorageConfig(s3Env({ OMNISYNC_CHECKPOINT_DIR: "/c" }))).toThrow(/OMNISYNC_CHECKPOINT_DIR and OMNISYNC_CHECKPOINT_S3_BUCKET/);
  });

  it("refuses the same bucket for snapshots and checkpoints, and the same directory", () => {
    expect(() => parseStorageConfig(s3Env({ OMNISYNC_SNAPSHOT_S3_BUCKET: "omni-checkpoints" }))).toThrow(/must differ/);
    expect(() => parseStorageConfig(fsEnv({ OMNISYNC_CHECKPOINT_DIR: "/var/data" }))).toThrow(/snapshot directory/);
    expect(() => parseStorageConfig(fsEnv({ OMNISYNC_CHECKPOINT_DIR: "/var/data/../data" }))).toThrow(/snapshot directory/);
  });

  it("requires the retention for a checkpoint bucket, as a whole number of days from 1 to 36500", () => {
    expect(() => parseStorageConfig(s3Env({ OMNISYNC_CHECKPOINT_RETAIN_DAYS: undefined }))).toThrow(/missing environment variable OMNISYNC_CHECKPOINT_RETAIN_DAYS/);
    for (const bad of ["0", "-1", "1.5", "36501", "abc", "", " 30", "30 ", "0x10", "1e3", "007"]) {
      expect(() => parseStorageConfig(s3Env({ OMNISYNC_CHECKPOINT_RETAIN_DAYS: bad })), bad).toThrow(/OMNISYNC_CHECKPOINT_RETAIN_DAYS/);
    }
    expect(parseStorageConfig(s3Env({ OMNISYNC_CHECKPOINT_RETAIN_DAYS: "36500" })).checkpoints).toMatchObject({ retainDays: 36500 });
    expect(parseStorageConfig(s3Env({ OMNISYNC_CHECKPOINT_RETAIN_DAYS: "1" })).checkpoints).toMatchObject({ retainDays: 1 });
  });

  it("takes the lock mode from the environment, COMPLIANCE by default, and refuses anything else", () => {
    expect(parseStorageConfig(s3Env({ OMNISYNC_CHECKPOINT_LOCK_MODE: "GOVERNANCE" })).checkpoints).toMatchObject({ mode: "GOVERNANCE" });
    expect(parseStorageConfig(s3Env({ OMNISYNC_CHECKPOINT_LOCK_MODE: "COMPLIANCE" })).checkpoints).toMatchObject({ mode: "COMPLIANCE" });
    for (const bad of ["compliance", "NONE", "", "GOVERNANCE "]) {
      expect(() => parseStorageConfig(s3Env({ OMNISYNC_CHECKPOINT_LOCK_MODE: bad })), bad).toThrow(/OMNISYNC_CHECKPOINT_LOCK_MODE/);
    }
  });

  it("refuses retention settings that would have no effect", () => {
    expect(() => parseStorageConfig(fsEnv({ OMNISYNC_CHECKPOINT_RETAIN_DAYS: "30" }))).toThrow(/only apply with OMNISYNC_CHECKPOINT_S3_BUCKET/);
    expect(() => parseStorageConfig(fsEnv({ OMNISYNC_CHECKPOINT_LOCK_MODE: "COMPLIANCE" }))).toThrow(/only apply with OMNISYNC_CHECKPOINT_S3_BUCKET/);
  });

  it("validates the endpoint, region and path style", () => {
    for (const bad of ["minio:9000", "ftp://x", "not a url", "http://", ""]) {
      expect(() => parseStorageConfig(s3Env({ OMNISYNC_S3_ENDPOINT: bad })), bad).toThrow(/OMNISYNC_S3_ENDPOINT/);
    }
    for (const bad of ["US East", "x", "a".repeat(31), ""]) {
      expect(() => parseStorageConfig(s3Env({ OMNISYNC_S3_REGION: bad })), bad).toThrow(/OMNISYNC_S3_REGION/);
    }
    for (const bad of ["yes", "true", "2", ""]) {
      expect(() => parseStorageConfig(s3Env({ OMNISYNC_S3_PATH_STYLE: bad })), bad).toThrow(/OMNISYNC_S3_PATH_STYLE/);
    }
    expect(parseStorageConfig(s3Env({ OMNISYNC_S3_PATH_STYLE: "0", OMNISYNC_S3_REGION: "eu-west-1", OMNISYNC_S3_ENDPOINT: undefined })).s3).toEqual({ region: "eu-west-1", forcePathStyle: false });
  });

  it("refuses bucket names S3 would not accept", () => {
    for (const bad of ["UPPER", "a", "has space", "-lead", "trail-", "a..b", "x".repeat(64), "192.168.0.1"]) {
      expect(() => parseStorageConfig(s3Env({ OMNISYNC_CHECKPOINT_S3_BUCKET: bad })), bad).toThrow(/OMNISYNC_CHECKPOINT_S3_BUCKET/);
      expect(() => parseStorageConfig(s3Env({ OMNISYNC_SNAPSHOT_S3_BUCKET: bad })), bad).toThrow(/OMNISYNC_SNAPSHOT_S3_BUCKET/);
    }
  });

  it("refuses S3 settings when nothing uses S3", () => {
    for (const n of ["OMNISYNC_S3_ENDPOINT", "OMNISYNC_S3_REGION", "OMNISYNC_S3_PATH_STYLE"]) {
      expect(() => parseStorageConfig(fsEnv({ [n]: n === "OMNISYNC_S3_ENDPOINT" ? "http://x:9000" : "1" })), n).toThrow(new RegExp(`${n} only applies with an S3 bucket`));
    }
  });

  it("refuses credentials in the endpoint on their own", () => {
    for (const bad of ["http://user:pw@host:9000", "https://user@host", "http://:pw@host"]) {
      expect(() => parseStorageConfig(s3Env({ OMNISYNC_S3_ENDPOINT: bad })), bad).toThrow(/must not contain credentials/);
    }
  });

  it("never puts credentials or the variable's value into an error", () => {
    const err = (() => {
      try {
        parseStorageConfig(s3Env({ OMNISYNC_S3_ENDPOINT: "http://user:hunter2@host/", OMNISYNC_S3_REGION: "bad region" }));
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(err?.message).not.toContain("hunter2");
  });
});

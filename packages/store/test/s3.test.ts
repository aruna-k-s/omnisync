/**
 * Runs against any S3-compatible server that implements Object Lock and conditional writes (CI starts `moto_server`;
 * MinIO and AWS behave the same on the calls used here). Set OMNISYNC_TEST_S3_ENDPOINT, for example
 * http://127.0.0.1:54330. Without it the suite is skipped unless OMNISYNC_REQUIRE_S3=1.
 */
import { CreateBucketCommand, GetObjectCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import { createServer, type Server } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObjectExistsError, ObjectLockedError, S3ObjectStore, type S3ObjectStoreOptions } from "../src/s3.js";
import { objectStoreContract } from "./object-contract.js";

const endpoint = process.env["OMNISYNC_TEST_S3_ENDPOINT"];
if (!endpoint && process.env["OMNISYNC_REQUIRE_S3"] === "1") throw new Error("OMNISYNC_REQUIRE_S3=1 but OMNISYNC_TEST_S3_ENDPOINT is not set");
const SECRET = "SECRET-KEY-do-not-leak-0123456789";
const credentials = { accessKeyId: "AKIATESTONLY", secretAccessKey: SECRET };

const mkClient = (): S3Client => new S3Client({ endpoint: endpoint as string, region: "us-east-1", forcePathStyle: true, credentials });
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let n = 0;
const bucketName = (what: string) => `omni-${what}-${run}-${n++}`;

async function makeBucket(client: S3Client, opts: { lock: boolean; versioning?: boolean }): Promise<string> {
  const name = bucketName(opts.lock ? "lock" : "plain");
  await client.send(new CreateBucketCommand({ Bucket: name, ...(opts.lock ? { ObjectLockEnabledForBucket: true } : {}) }));
  if (opts.versioning) await client.send(new PutBucketVersioningCommand({ Bucket: name, VersioningConfiguration: { Status: "Enabled" } }));
  return name;
}

/** Counts the operations a store sends, so a test can prove that something was never requested. */
function counting(client: S3Client): string[] {
  const seen: string[] = [];
  client.middlewareStack.add(
    (next, ctx) => async (args) => {
      seen.push(String(ctx.commandName));
      return next(args);
    },
    { step: "initialize", name: "count" },
  );
  return seen;
}

const base = (bucket: string, client: S3Client): S3ObjectStoreOptions => ({ bucket, client, requestTimeoutMs: 5_000 });

describe.skipIf(!endpoint)("S3 object store", () => {
  let client: S3Client;
  let plain: string;
  let locked: string;
  beforeAll(async () => {
    client = mkClient();
    plain = await makeBucket(client, { lock: false });
    locked = await makeBucket(client, { lock: true });
  });
  afterAll(() => client.destroy());

  objectStoreContract("s3 (unlocked)", async () => new S3ObjectStore(base(plain, client)));
  objectStoreContract("s3 (prefix)", async () => new S3ObjectStore({ ...base(plain, client), prefix: `tenant-${run}/` }));

  it("keeps a prefix apart from other prefixes in the same bucket", async () => {
    const a = new S3ObjectStore({ ...base(plain, client), prefix: "a/" });
    const b = new S3ObjectStore({ ...base(plain, client), prefix: "b/" });
    await a.put("snapshots/k", new Uint8Array([1]));
    expect(await b.get("snapshots/k")).toBeUndefined();
    expect([...((await a.get("snapshots/k")) ?? [])]).toEqual([1]);
  });

  describe("with Object Lock", () => {
    const lockOpts = (bucket: string, c: S3Client, retainDays = 3): S3ObjectStoreOptions => ({ ...base(bucket, c), lock: { mode: "COMPLIANCE", retainDays } });

    it("accepts the same bytes again, refuses different bytes, and never changes the first object", async () => {
      const o = new S3ObjectStore(lockOpts(locked, client));
      const key = `checkpoints/${run}/000000000001.ckpt`;
      await o.put(key, new Uint8Array([1, 2, 3]));
      await o.put(key, new Uint8Array([1, 2, 3]));
      await expect(o.put(key, new Uint8Array([9]))).rejects.toBeInstanceOf(ObjectExistsError);
      expect(await o.putIfAbsent(key, new Uint8Array([9]))).toBe(false);
      expect([...((await o.get(key)) ?? [])]).toEqual([1, 2, 3]);
    });

    it("refuses to delete without sending a request", async () => {
      const c = mkClient();
      const seen = counting(c);
      const o = new S3ObjectStore(lockOpts(locked, c));
      await expect(o.delete(`checkpoints/${run}/x.ckpt`)).rejects.toBeInstanceOf(ObjectLockedError);
      expect(seen).toEqual([]);
      c.destroy();
    });

    it("asks the bucket for compliance retention of retainDays, counted from now", async () => {
      const key = `checkpoints/${run}/retention.ckpt`;
      const before = Date.now();
      await new S3ObjectStore(lockOpts(locked, client, 3)).put(key, new Uint8Array([4]));
      const head = await client.send(new GetObjectCommand({ Bucket: locked, Key: key }));
      expect(head.ObjectLockMode).toBe("COMPLIANCE");
      const until = (head.ObjectLockRetainUntilDate as Date).getTime();
      expect(until).toBeGreaterThanOrEqual(before + 3 * 86_400_000 - 2_000);
      expect(until).toBeLessThanOrEqual(Date.now() + 3 * 86_400_000 + 2_000);
    });

    it("supports governance mode", async () => {
      const key = `checkpoints/${run}/gov.ckpt`;
      await new S3ObjectStore({ ...base(locked, client), lock: { mode: "GOVERNANCE", retainDays: 1 } }).put(key, new Uint8Array([5]));
      const head = await client.send(new GetObjectCommand({ Bucket: locked, Key: key }));
      expect(head.ObjectLockMode).toBe("GOVERNANCE");
    });

    it("verifyBucket accepts a bucket with Object Lock and versioning", async () => {
      await expect(new S3ObjectStore(lockOpts(locked, client)).verifyBucket()).resolves.toBeUndefined();
    });

    it("verifyBucket refuses a bucket without Object Lock and names it", async () => {
      await expect(new S3ObjectStore(lockOpts(plain, client)).verifyBucket()).rejects.toThrow(new RegExp(`${plain} does not have Object Lock enabled`));
    });

    it("verifyBucket refuses a missing bucket", async () => {
      await expect(new S3ObjectStore(lockOpts(bucketName("absent"), client)).verifyBucket()).rejects.toThrow(/cannot be reached|does not exist/);
    });

    it("verifyBucket on an unlocked store only checks that the bucket exists", async () => {
      await expect(new S3ObjectStore(base(plain, client)).verifyBucket()).resolves.toBeUndefined();
    });
  });

  it("refuses to read an object larger than the cap", async () => {
    const o = new S3ObjectStore({ ...base(plain, client), maxObjectBytes: 8 });
    const key = `snapshots/${run}/big.bin`;
    await expect(o.put(key, new Uint8Array(9))).rejects.toThrow(/larger than/);
    await new S3ObjectStore(base(plain, client)).put(key, new Uint8Array(9));
    await expect(o.get(key)).rejects.toThrow(/larger than/);
  });

  it("gives up on an unreachable endpoint within the timeout and never prints the secret", async () => {
    const dead = new S3Client({ endpoint: "http://127.0.0.1:1", region: "us-east-1", forcePathStyle: true, credentials, maxAttempts: 1 });
    const o = new S3ObjectStore({ bucket: "x", client: dead, requestTimeoutMs: 800 });
    const t0 = Date.now();
    const err = await o.get("snapshots/k").then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(String(err?.message) + String(err?.stack)).not.toContain(SECRET);
    expect(String(err?.message)).toContain("snapshots/k");
    dead.destroy();
  });

  it("two stores racing on one checkpoint key leave exactly one object", async () => {
    const key = `checkpoints/${run}/race.ckpt`;
    const stores = Array.from({ length: 6 }, () => new S3ObjectStore({ ...base(locked, client), lock: { mode: "COMPLIANCE", retainDays: 1 } }));
    const results = await Promise.all(stores.map((s, i) => s.putIfAbsent(key, new Uint8Array([i + 1]))));
    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = (await stores[0]?.get(key)) as Uint8Array;
    expect(stored[0]).toBe(results.indexOf(true) + 1);
  });

  it("rejects an invalid configuration", () => {
    const c = mkClient();
    expect(() => new S3ObjectStore({ ...base("b", c), lock: { mode: "COMPLIANCE", retainDays: 0 } })).toThrow(/retainDays/);
    expect(() => new S3ObjectStore({ ...base("b", c), lock: { mode: "COMPLIANCE", retainDays: 36_501 } })).toThrow(/retainDays/);
    expect(() => new S3ObjectStore({ ...base("b", c), lock: { mode: "COMPLIANCE", retainDays: 1.5 } })).toThrow(/retainDays/);
    expect(() => new S3ObjectStore({ ...base("b", c), lock: { mode: "NOPE" as "COMPLIANCE", retainDays: 1 } })).toThrow(/mode/);
    expect(() => new S3ObjectStore({ ...base("", c) })).toThrow(/bucket/);
    expect(() => new S3ObjectStore({ ...base("b", c), prefix: "/x/" })).toThrow(/prefix/);
    expect(() => new S3ObjectStore({ ...base("b", c), requestTimeoutMs: 0 })).toThrow(/requestTimeoutMs/);
    c.destroy();
  });
});

type Handler = (command: string, input: Record<string, unknown>) => unknown;
/** A client that answers from a function, to produce the answers a real server rarely gives. Records every call. */
function stubClient(handler: Handler): { client: S3Client; calls: Array<{ command: string; input: Record<string, unknown> }> } {
  const calls: Array<{ command: string; input: Record<string, unknown> }> = [];
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ command: cmd.constructor.name, input: cmd.input });
      const out = handler(cmd.constructor.name, cmd.input);
      if (out instanceof Error) throw out;
      return out;
    },
    destroy: () => {},
  } as unknown as S3Client;
  return { client, calls };
}
const awsError = (name: string, status: number, message = name): Error => Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
const bodyOf = (bytes: Uint8Array) => ({ transformToByteArray: async () => bytes, destroy: () => {} });

describe("S3 object store against a scripted server", () => {
  const locked = { mode: "COMPLIANCE", retainDays: 1 } as const;

  it("treats HTTP 412 and 409 as 'already there' whatever the error is called, and any other failure as a failure", async () => {
    for (const status of [412, 409]) {
      const { client } = stubClient((c) => (c === "PutObjectCommand" ? awsError("SomethingElse", status) : {}));
      expect(await new S3ObjectStore({ bucket: "b", client }).putIfAbsent("snapshots/k", new Uint8Array([1])), String(status)).toBe(false);
    }
    for (const status of [500, 403, 400, 503]) {
      const { client } = stubClient((c) => (c === "PutObjectCommand" ? awsError("AccessDenied", status) : {}));
      await expect(new S3ObjectStore({ bucket: "b", client }).putIfAbsent("snapshots/k", new Uint8Array([1])), String(status)).rejects.toThrow(/failed: AccessDenied/);
      await expect(new S3ObjectStore({ bucket: "b", client, lock: locked }).put("snapshots/k", new Uint8Array([1])), String(status)).rejects.toThrow(/failed/);
    }
  });

  it("a plain put on an unlocked store is not conditional and a failure on it is reported", async () => {
    const { client, calls } = stubClient((c) => (c === "PutObjectCommand" ? awsError("SlowDown", 503) : {}));
    await expect(new S3ObjectStore({ bucket: "b", client }).put("snapshots/k", new Uint8Array([1]))).rejects.toThrow(/SlowDown \(HTTP 503\)/);
    expect(calls[0]?.input["IfNoneMatch"]).toBeUndefined();
    expect(calls[0]?.input["ObjectLockMode"]).toBeUndefined();
  });

  it("reads a missing object as undefined by name or by HTTP 404, and fails on other errors", async () => {
    for (const e of [awsError("NoSuchKey", 404), awsError("NotFound", 404), awsError("Whatever", 404)]) {
      expect(await new S3ObjectStore({ bucket: "b", client: stubClient(() => e).client }).get("snapshots/k")).toBeUndefined();
    }
    await expect(new S3ObjectStore({ bucket: "b", client: stubClient(() => awsError("AccessDenied", 403)).client }).get("snapshots/k")).rejects.toThrow(/AccessDenied/);
  });

  it("a write-once store whose object vanished between refusal and read reports the conflict instead of success", async () => {
    const { client } = stubClient((c) => (c === "PutObjectCommand" ? awsError("PreconditionFailed", 412) : awsError("NoSuchKey", 404)));
    await expect(new S3ObjectStore({ bucket: "b", client, lock: locked }).put("checkpoints/k", new Uint8Array([1]))).rejects.toBeInstanceOf(ObjectExistsError);
  });

  it("does not read an object whose declared size is over the cap, and also refuses one that lies about its size", async () => {
    let read = 0;
    let hungUp = 0;
    const big = { transformToByteArray: async () => (read++, new Uint8Array(100)), destroy: () => void hungUp++ };
    const { client } = stubClient(() => ({ ContentLength: 100, Body: big }));
    await expect(new S3ObjectStore({ bucket: "b", client, maxObjectBytes: 10 }).get("snapshots/k")).rejects.toThrow(/larger than/);
    expect(read).toBe(0);
    expect(hungUp).toBe(1);
    const liar = stubClient(() => ({ Body: bodyOf(new Uint8Array(100)) })).client; // no ContentLength at all
    await expect(new S3ObjectStore({ bucket: "b", client: liar, maxObjectBytes: 10 }).get("snapshots/k")).rejects.toThrow(/larger than/);
    const ok = stubClient(() => ({ ContentLength: 10, Body: bodyOf(new Uint8Array(10)) })).client; // exactly the cap is allowed
    expect((await new S3ObjectStore({ bucket: "b", client: ok, maxObjectBytes: 10 }).get("snapshots/k"))?.length).toBe(10);
  });

  it("refuses a short read", async () => {
    const { client } = stubClient(() => ({ ContentLength: 5, Body: bodyOf(new Uint8Array(3)) }));
    await expect(new S3ObjectStore({ bucket: "b", client }).get("snapshots/k")).rejects.toThrow(/cut short \(3 of 5 bytes\)/);
  });

  it("sends a SHA-256 checksum, the condition and the retention exactly as configured, even if the caller later changes the options", async () => {
    const opts = { mode: "GOVERNANCE", retainDays: 2 } as { mode: "GOVERNANCE" | "COMPLIANCE"; retainDays: number };
    const { client, calls } = stubClient(() => ({}));
    const store = new S3ObjectStore({ bucket: "b", client, lock: opts });
    opts.retainDays = 30_000;
    opts.mode = "COMPLIANCE";
    const before = Date.now();
    await store.putIfAbsent("checkpoints/k", new Uint8Array([1]));
    const put = calls[0]?.input as { ChecksumAlgorithm: string; IfNoneMatch: string; ObjectLockMode: string; ObjectLockRetainUntilDate: Date };
    expect(put.ChecksumAlgorithm).toBe("SHA256");
    expect(put.IfNoneMatch).toBe("*");
    expect(put.ObjectLockMode).toBe("GOVERNANCE");
    expect(put.ObjectLockRetainUntilDate.getTime() - before).toBeGreaterThanOrEqual(2 * 86_400_000 - 1000);
    expect(put.ObjectLockRetainUntilDate.getTime() - before).toBeLessThan(2 * 86_400_000 + 5000);
  });

  it("an unlocked putIfAbsent is conditional but carries no retention", async () => {
    const { client, calls } = stubClient(() => ({}));
    await new S3ObjectStore({ bucket: "b", client }).putIfAbsent("snapshots/k", new Uint8Array([1]));
    expect(calls[0]?.input["IfNoneMatch"]).toBe("*");
    expect(calls[0]?.input["ObjectLockMode"]).toBeUndefined();
    expect(calls[0]?.input["ObjectLockRetainUntilDate"]).toBeUndefined();
  });

  it("verifyBucket names exactly what is missing", async () => {
    const noLock = stubClient((c) => (c === "GetObjectLockConfigurationCommand" ? { ObjectLockConfiguration: {} } : { Status: "Enabled" })).client;
    await expect(new S3ObjectStore({ bucket: "bkt", client: noLock, lock: locked }).verifyBucket()).rejects.toThrow(/bkt does not have Object Lock enabled/);
    const noVersioning = stubClient((c) => (c === "GetObjectLockConfigurationCommand" ? { ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } } : { Status: "Suspended" })).client;
    await expect(new S3ObjectStore({ bucket: "bkt", client: noVersioning, lock: locked }).verifyBucket()).rejects.toThrow(/bkt does not have versioning enabled/);
    const unset = stubClient((c) => (c === "GetObjectLockConfigurationCommand" ? { ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } } : {})).client;
    await expect(new S3ObjectStore({ bucket: "bkt", client: unset, lock: locked }).verifyBucket()).rejects.toThrow(/versioning/);
    const denied = stubClient((c) => (c === "GetObjectLockConfigurationCommand" ? awsError("AccessDenied", 403) : {})).client;
    await expect(new S3ObjectStore({ bucket: "bkt", client: denied, lock: locked }).verifyBucket()).rejects.toThrow(/bkt cannot be reached or does not exist \(AccessDenied\)/);
    const good = stubClient((c) => (c === "GetObjectLockConfigurationCommand" ? { ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } } : { Status: "Enabled" })).client;
    await expect(new S3ObjectStore({ bucket: "bkt", client: good, lock: locked }).verifyBucket()).resolves.toBeUndefined();
  });

  it("an unlocked store's verifyBucket fails when the bucket is missing", async () => {
    const missing = stubClient(() => awsError("NotFound", 404)).client;
    await expect(new S3ObjectStore({ bucket: "bkt", client: missing }).verifyBucket()).rejects.toThrow(/bkt cannot be reached or does not exist/);
  });

  it("error messages carry the operation, bucket, key, error name and status, and nothing the server said", async () => {
    const leaky = awsError("InternalError", 500, `boom ${SECRET} https://x/?X-Amz-Signature=abc`);
    const store = new S3ObjectStore({ bucket: "bkt", client: stubClient(() => leaky).client });
    for (const op of [() => store.get("snapshots/k"), () => store.put("snapshots/k", new Uint8Array([1])), () => store.delete("snapshots/k"), () => store.verifyBucket()]) {
      const err = await op().then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toBeDefined();
      expect(err?.message).not.toContain(SECRET);
      expect(err?.message).not.toContain("X-Amz");
      expect(err?.message).toMatch(/bkt/);
    }
    await expect(store.get("snapshots/k")).rejects.toThrow("object store: get snapshots/k in bkt failed: InternalError (HTTP 500)");
  });

  describe("a server that accepts connections and never answers", () => {
    let hang: Server;
    let url: string;
    beforeAll(async () => {
      hang = createServer(() => {});
      await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${(hang.address() as { port: number }).port}`;
    });
    afterAll(() => void hang.close());

    it("every operation gives up at the timeout", async () => {
      const mk = (lock?: { mode: "COMPLIANCE"; retainDays: number }) =>
        new S3ObjectStore({
          bucket: "b",
          requestTimeoutMs: 400,
          client: new S3Client({ endpoint: url, region: "us-east-1", forcePathStyle: true, credentials, maxAttempts: 1 }),
          ...(lock ? { lock } : {}),
        });
      const ops: Array<[string, () => Promise<unknown>]> = [
        ["get", () => mk().get("snapshots/k")],
        ["put", () => mk().put("snapshots/k", new Uint8Array([1]))],
        ["putIfAbsent", () => mk().putIfAbsent("snapshots/k", new Uint8Array([1]))],
        ["delete", () => mk().delete("snapshots/k")],
        ["verify unlocked", () => mk().verifyBucket()],
        ["verify locked", () => mk({ mode: "COMPLIANCE", retainDays: 1 }).verifyBucket()],
      ];
      for (const [name, op] of ops) {
        const t0 = Date.now();
        await expect(op(), name).rejects.toThrow();
        expect(Date.now() - t0, name).toBeLessThan(3_000);
      }
    }, 30_000);
  });

  it("a prefix must end with a slash", () => {
    expect(() => new S3ObjectStore({ bucket: "b", client: stubClient(() => ({})).client, prefix: "tenant" })).toThrow(/prefix must end with/);
    expect(() => new S3ObjectStore({ bucket: "b", client: stubClient(() => ({})).client, prefix: "a/../b/" })).toThrow(/prefix/);
  });
});

describe("filesystem putIfAbsent leaves no temporary files", () => {
  it("whether it creates or finds the object", async () => {
    const { FsObjectStore } = await import("../src/index.js");
    const dir = await mkdtemp(join(tmpdir(), "omnisync-fs-tmp-"));
    try {
      const o = new FsObjectStore(dir);
      expect(await o.putIfAbsent("checkpoints/a/1.ckpt", new Uint8Array([1]))).toBe(true);
      expect(await o.putIfAbsent("checkpoints/a/1.ckpt", new Uint8Array([2]))).toBe(false);
      await o.put("checkpoints/a/2.ckpt", new Uint8Array([3]));
      expect((await readdir(join(dir, "checkpoints/a"))).sort()).toEqual(["1.ckpt", "2.ckpt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

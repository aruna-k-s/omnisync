/**
 * The ledger anchored in a real Object Lock bucket. Needs an S3-compatible server (see packages/store/test/s3.test.ts):
 * OMNISYNC_TEST_S3_ENDPOINT, required by OMNISYNC_REQUIRE_S3=1.
 */
import { CreateBucketCommand, DeleteObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkpointObjectKey, ledgerSignerFromKeyPair } from "@omnisync/crypto";
import type { LedgerStore } from "@omnisync/store";
import { verifyLedger, type TrustInputs } from "@omnisync/verifier";
import { CheckpointWriter, exportLedger, openStorage, parseStorageConfig, type GatewayClient } from "../src/index.js";
import { TestClock, TestIdentity, connectAs, issuerKey, ledgerKey, makeWorld, startGateway, type Running, type World } from "./harness.js";

const endpoint = process.env["OMNISYNC_TEST_S3_ENDPOINT"];
if (!endpoint && process.env["OMNISYNC_REQUIRE_S3"] === "1") throw new Error("OMNISYNC_REQUIRE_S3=1 but OMNISYNC_TEST_S3_ENDPOINT is not set");
const trust: TrustInputs = { issuers: [issuerKey.publicKey], ledgerKeys: [ledgerKey.publicKey] };
const signer = ledgerSignerFromKeyPair(ledgerKey);
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe.skipIf(!endpoint)("checkpoints in an Object Lock bucket", () => {
  let s3: S3Client;
  let world: World;
  const running: Running[] = [];
  const clients: GatewayClient[] = [];
  const env = (over: Record<string, string | undefined> = {}) => ({
    OMNISYNC_SNAPSHOT_S3_BUCKET: `snap-${run}`,
    OMNISYNC_CHECKPOINT_S3_BUCKET: `ckpt-${run}`,
    OMNISYNC_CHECKPOINT_RETAIN_DAYS: "2",
    OMNISYNC_S3_ENDPOINT: endpoint,
    OMNISYNC_S3_PATH_STYLE: "1",
    ...over,
  });

  beforeAll(async () => {
    process.env["AWS_ACCESS_KEY_ID"] = "AKIATESTONLY";
    process.env["AWS_SECRET_ACCESS_KEY"] = "test-secret-not-real";
    s3 = new S3Client({ endpoint: endpoint as string, region: "us-east-1", forcePathStyle: true });
    await s3.send(new CreateBucketCommand({ Bucket: `snap-${run}` }));
    await s3.send(new CreateBucketCommand({ Bucket: `ckpt-${run}`, ObjectLockEnabledForBucket: true }));
    await s3.send(new CreateBucketCommand({ Bucket: `plain-${run}` }));
  });
  afterAll(() => s3?.destroy());
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    for (const r of running.splice(0)) await r.gateway.close().catch(() => {});
    await world?.cleanup();
  });

  it("an export verifies as anchored against copies fetched from the bucket, and the bucket refuses to lose them", async () => {
    const { checkpoints } = await openStorage(parseStorageConfig(env()));
    world = await makeWorld("memory");
    const clock = new TestClock();
    const ids = new TestIdentity(world.identity, clock);
    const alice = await ids.enroll("alice", { "doc-1": "write" });
    const r = await startGateway(world, { auth: { issuers: [issuerKey.publicKey], identity: world.identity, now: clock.now, revocationPollMs: 3_600_000 } });
    running.push(r);
    const c = await connectAs(r.url, alice, clock, { docId: "doc-1" });
    clients.push(c);
    clock.advance(1000);
    await c.insert(0, "hello ");
    clock.advance(1000);
    await c.insert(0, "again ");

    const w = new CheckpointWriter({ store: world.rawStore as unknown as LedgerStore, objects: checkpoints, tenant: "acme", signer, now: clock.now });
    expect(await w.flush()).toBe(1);
    expect(w.stats.uploaded).toBe(1);
    // A second writer racing on the same number leaves the same single object.
    const again = new CheckpointWriter({ store: world.rawStore as unknown as LedgerStore, objects: checkpoints, tenant: "acme", signer, now: clock.now });
    await again.flush();
    expect(again.stats.uploadConflicts).toBe(0);

    const lines: string[] = [];
    await exportLedger({ docs: world.rawStore as never, identity: world.identity, tenant: "acme", now: clock.now }, (l) => void lines.push(l));
    const copy = await checkpoints.get(checkpointObjectKey("acme", 1));
    expect(copy).toBeDefined();
    const report = await verifyLedger(lines.map((l) => JSON.parse(l) as unknown), trust, { locked: new Map([[1, copy as Uint8Array]]) });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);

    // The bucket itself refuses to remove the locked version, even for a caller with delete rights.
    const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: `ckpt-${run}` }));
    expect(versions.Versions).toHaveLength(1);
    const v = versions.Versions?.[0];
    await expect(s3.send(new DeleteObjectCommand({ Bucket: `ckpt-${run}`, Key: v?.Key as string, VersionId: v?.VersionId as string }))).rejects.toThrow();
    expect(await checkpoints.get(checkpointObjectKey("acme", 1))).toBeDefined();
    await expect(checkpoints.delete(checkpointObjectKey("acme", 1))).rejects.toThrow(/Object Lock/);
  });

  it("refuses to start with a checkpoint bucket that has no Object Lock, naming the bucket", async () => {
    await expect(openStorage(parseStorageConfig(env({ OMNISYNC_CHECKPOINT_S3_BUCKET: `plain-${run}` })))).rejects.toThrow(new RegExp(`plain-${run}.*Object Lock`));
  });

  it("refuses to start when a bucket does not exist", async () => {
    await expect(openStorage(parseStorageConfig(env({ OMNISYNC_SNAPSHOT_S3_BUCKET: `absent-${run}` })))).rejects.toThrow(/absent-.*(cannot be reached|does not exist)/);
    await expect(openStorage(parseStorageConfig(env({ OMNISYNC_CHECKPOINT_S3_BUCKET: `absent-${run}` })))).rejects.toThrow(/absent-.*(cannot be reached|does not exist)/);
  });

  it("serves snapshots from a bucket that needs no lock", async () => {
    const { snapshots } = await openStorage(parseStorageConfig(env()));
    await snapshots.put("snapshots/6162/000000000001-aaaaaaaaaaaaaaaa.bin", new Uint8Array([1, 2]));
    await snapshots.put("snapshots/6162/000000000001-aaaaaaaaaaaaaaaa.bin", new Uint8Array([3]));
    expect([...((await snapshots.get("snapshots/6162/000000000001-aaaaaaaaaaaaaaaa.bin")) ?? [])]).toEqual([3]);
  });
});

/**
 * ObjectStore on an S3-compatible bucket (AWS S3, MinIO, ...), with optional Object Lock. Spec: docs/specs/s3-object-store.md.
 *
 * Requests are signed and retried by the AWS SDK; this file contains no signing code. Error messages carry the
 * operation, bucket, key and the SDK's error name, never credentials, signed URLs or object bytes.
 */
import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type ObjectLockMode,
} from "@aws-sdk/client-s3";
import { assertObjectKey } from "./object-key.js";
import type { ObjectStore } from "./types.js";

export interface S3LockOptions {
  mode: "COMPLIANCE" | "GOVERNANCE";
  /** Retention of every object this store writes, counted from the write. Whole days, 1 to 36500. */
  retainDays: number;
}

export interface S3ObjectStoreOptions {
  bucket: string;
  /** Endpoint URL for MinIO or another S3-compatible service; leave out for AWS. */
  endpoint?: string;
  region?: string;
  forcePathStyle?: boolean;
  /** Prepended to every key; empty or ending in "/". */
  prefix?: string;
  /** Makes this a write-once store: objects are locked, never overwritten, never deleted. */
  lock?: S3LockOptions;
  requestTimeoutMs?: number;
  maxObjectBytes?: number;
  /** For tests and for callers that share a client. When given, endpoint, region and forcePathStyle are ignored. */
  client?: S3Client;
}

/** A write-once store was asked to replace an object with different bytes. */
export class ObjectExistsError extends Error {
  constructor(bucket: string, key: string) {
    super(`object store: ${key} already exists in ${bucket} with different bytes and is write-once`);
    this.name = "ObjectExistsError";
  }
}

/** A write-once store was asked to delete. Nothing is sent to the bucket. */
export class ObjectLockedError extends Error {
  constructor(bucket: string, key: string) {
    super(`object store: ${key} in ${bucket} is under Object Lock and is never deleted by OmniSync`);
    this.name = "ObjectLockedError";
  }
}

const DAY_MS = 86_400_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export class S3ObjectStore implements ObjectStore {
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #lock: S3LockOptions | undefined;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #client: S3Client;

  constructor(o: S3ObjectStoreOptions) {
    if (typeof o.bucket !== "string" || o.bucket.length === 0) throw new Error("S3ObjectStore: bucket is required");
    const prefix = o.prefix ?? "";
    if (prefix !== "") {
      if (!prefix.endsWith("/")) throw new Error("S3ObjectStore: prefix must end with /");
      try {
        assertObjectKey(prefix.slice(0, -1));
      } catch {
        throw new Error("S3ObjectStore: prefix must be a relative path without .. segments");
      }
    }
    const timeout = o.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1) throw new Error("S3ObjectStore: requestTimeoutMs must be a positive integer");
    const max = o.maxObjectBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isInteger(max) || max < 1) throw new Error("S3ObjectStore: maxObjectBytes must be a positive integer");
    if (o.lock) {
      if (o.lock.mode !== "COMPLIANCE" && o.lock.mode !== "GOVERNANCE") throw new Error("S3ObjectStore: lock mode must be COMPLIANCE or GOVERNANCE");
      if (!Number.isInteger(o.lock.retainDays) || o.lock.retainDays < 1 || o.lock.retainDays > 36_500) {
        throw new Error("S3ObjectStore: lock retainDays must be a whole number from 1 to 36500");
      }
    }
    this.#bucket = o.bucket;
    this.#prefix = prefix;
    this.#lock = o.lock ? { ...o.lock } : undefined;
    this.#timeoutMs = timeout;
    this.#maxBytes = max;
    this.#client =
      o.client ??
      new S3Client({
        region: o.region ?? "us-east-1",
        ...(o.endpoint ? { endpoint: o.endpoint } : {}),
        forcePathStyle: o.forcePathStyle ?? false,
        maxAttempts: 3,
      });
  }

  /** The bucket is reachable and, for a write-once store, has Object Lock and versioning. Call once at start. */
  async verifyBucket(): Promise<void> {
    const b = this.#bucket;
    if (!this.#lock) {
      try {
        await this.#client.send(new HeadBucketCommand({ Bucket: b }), { abortSignal: AbortSignal.timeout(this.#timeoutMs) });
      } catch (e) {
        // eslint-disable-next-line preserve-caught-error -- the SDK's error can carry request details; only its name is kept
        throw new Error(`object store: bucket ${b} cannot be reached or does not exist (${errName(e)})`);
      }
      return;
    }
    let enabled = false;
    try {
      const cfg = await this.#client.send(new GetObjectLockConfigurationCommand({ Bucket: b }), { abortSignal: AbortSignal.timeout(this.#timeoutMs) });
      enabled = cfg.ObjectLockConfiguration?.ObjectLockEnabled === "Enabled";
    } catch (e) {
      const name = errName(e);
      // eslint-disable-next-line preserve-caught-error -- the SDK's error can carry request details; only its name is kept
      if (name !== "ObjectLockConfigurationNotFoundError") throw new Error(`object store: bucket ${b} cannot be reached or does not exist (${name})`);
    }
    if (!enabled) throw new Error(`object store: bucket ${b} does not have Object Lock enabled; it can only be turned on when the bucket is created`);
    let versioning: string | undefined;
    try {
      versioning = (await this.#client.send(new GetBucketVersioningCommand({ Bucket: b }), { abortSignal: AbortSignal.timeout(this.#timeoutMs) })).Status;
    } catch (e) {
      throw this.#fail("verify", "", e);
    }
    if (versioning !== "Enabled") throw new Error(`object store: bucket ${b} does not have versioning enabled, which Object Lock requires`);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const k = this.#key(key);
    let res;
    try {
      res = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: k }), { abortSignal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (e) {
      if (isMissing(e)) return undefined;
      throw this.#fail("get", key, e);
    }
    const declared = res.ContentLength;
    if (declared !== undefined && declared > this.#maxBytes) {
      // Do not read it: hang up on the stream instead of pulling an oversized object into memory.
      (res.Body as { destroy?: () => void } | undefined)?.destroy?.();
      throw new Error(`object store: ${key} in ${this.#bucket} is larger than the ${this.#maxBytes} byte limit`);
    }
    let bytes: Uint8Array | undefined;
    try {
      bytes = await res.Body?.transformToByteArray();
    } catch (e) {
      throw this.#fail("get", key, e);
    }
    if (!bytes) throw new Error(`object store: get ${key} in ${this.#bucket} returned no body`);
    if (bytes.length > this.#maxBytes) throw new Error(`object store: ${key} in ${this.#bucket} is larger than the ${this.#maxBytes} byte limit`);
    if (declared !== undefined && bytes.length !== declared) throw new Error(`object store: get ${key} in ${this.#bucket} was cut short (${bytes.length} of ${declared} bytes)`);
    return bytes;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (!this.#lock) {
      await this.#write(key, bytes, false);
      return;
    }
    // Write-once: a retried upload of the same bytes is fine, anything else is refused and the first object stays.
    if (await this.putIfAbsent(key, bytes)) return;
    const existing = await this.get(key);
    if (existing === undefined || Buffer.compare(existing, bytes) !== 0) throw new ObjectExistsError(this.#bucket, key);
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    return this.#write(key, bytes, true);
  }

  async delete(key: string): Promise<void> {
    const k = this.#key(key);
    if (this.#lock) throw new ObjectLockedError(this.#bucket, key);
    try {
      await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: k }), { abortSignal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (e) {
      throw this.#fail("delete", key, e);
    }
  }

  async #write(key: string, bytes: Uint8Array, onlyIfAbsent: boolean): Promise<boolean> {
    const k = this.#key(key);
    if (bytes.length > this.#maxBytes) throw new Error(`object store: ${key} for ${this.#bucket} is larger than the ${this.#maxBytes} byte limit`);
    const lock = this.#lock;
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: k,
          Body: bytes,
          ChecksumAlgorithm: "SHA256",
          ...(onlyIfAbsent || lock ? { IfNoneMatch: "*" } : {}),
          ...(lock ? { ObjectLockMode: lock.mode as ObjectLockMode, ObjectLockRetainUntilDate: new Date(Date.now() + lock.retainDays * DAY_MS) } : {}),
        }),
        { abortSignal: AbortSignal.timeout(this.#timeoutMs) },
      );
      return true;
    } catch (e) {
      if (isExists(e) && (onlyIfAbsent || lock)) return false;
      throw this.#fail("put", key, e);
    }
  }

  #key(key: string): string {
    assertObjectKey(key);
    return this.#prefix + key;
  }

  #fail(op: string, key: string, e: unknown): Error {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    return new Error(`object store: ${op} ${key || "(bucket)"} in ${this.#bucket} failed: ${errName(e)}${status ? ` (HTTP ${status})` : ""}`);
  }
}

function errName(e: unknown): string {
  const n = (e as { name?: unknown }).name;
  return typeof n === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(n) ? n : "Error";
}

function status(e: unknown): number | undefined {
  return (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

function isMissing(e: unknown): boolean {
  return errName(e) === "NoSuchKey" || status(e) === 404;
}

/** 412 is S3's answer to a failed If-None-Match; 409 is a concurrent conditional write on the same key. */
function isExists(e: unknown): boolean {
  const s = status(e);
  return s === 412 || s === 409 || errName(e) === "PreconditionFailed" || errName(e) === "ConditionalRequestConflict";
}

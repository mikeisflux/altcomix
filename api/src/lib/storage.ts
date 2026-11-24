import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand,
  HeadBucketCommand, PutObjectCommand, S3Client, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { config } from '../config.ts';
import { getSetting } from './settings.ts';

/**
 * Object storage behind one interface: local disk in development, Cloudflare R2
 * (S3 API) once configured in /admin. Keys are forward-slash paths.
 *
 * Key layout:
 *   public/...   covers, avatars, banners, free-page variants: world-readable
 *   private/...  paid pages, originals, archives: only served through /media
 */
export type StoredObject = { stream: Readable; contentType: string; size?: number };

type Driver = {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /**
   * Store an object from a file path or a readable stream without holding it
   * in memory (archives, originals). Returns the number of bytes stored.
   */
  putStream(key: string, source: string | Readable, contentType: string): Promise<number>;
  get(key: string): Promise<StoredObject | null>;
  read(key: string): Promise<Buffer | null>;
  del(key: string): Promise<void>;
  /** Direct browser URL for a public/ key, or null if it must go through the API. */
  publicUrl(key: string): string | null;
};

const TYPES: Record<string, string> = {
  webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', avif: 'image/avif',
  pdf: 'application/pdf', zip: 'application/zip', cbz: 'application/vnd.comicbook+zip', json: 'application/json',
};

export function contentTypeFor(key: string): string {
  return TYPES[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

function safeKey(key: string): string {
  const k = normalize(key).replace(/\\/g, '/');
  if (k.startsWith('..') || k.startsWith('/') || k.includes('/../')) throw new Error('Invalid storage key');
  return k;
}

function localDriver(): Driver {
  const root = config.storageDir;
  const path = (key: string) => join(root, safeKey(key));
  return {
    async put(key, body) {
      await mkdir(dirname(path(key)), { recursive: true });
      await writeFile(path(key), body);
    },
    async putStream(key, source) {
      const dest = path(key);
      await mkdir(dirname(dest), { recursive: true });
      // Written beside the target and renamed, so a reader never sees half a file.
      const tmp = `${dest}.${randomBytes(6).toString('hex')}.part`;
      try {
        await pipeline(typeof source === 'string' ? createReadStream(source) : source, createWriteStream(tmp));
        const { size } = await stat(tmp);
        await rename(tmp, dest);
        return size;
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    },
    async get(key) {
      try {
        const s = await stat(path(key));
        return { stream: createReadStream(path(key)), contentType: contentTypeFor(key), size: s.size };
      } catch {
        return null;
      }
    },
    async read(key) {
      return readFile(path(key)).catch(() => null);
    },
    async del(key) {
      await rm(path(key), { force: true });
    },
    publicUrl: () => null,
  };
}

type R2Config = { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string; publicUrl: string };

function r2Client(c: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${c.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  });
}

/** Objects up to this size go up in one request; larger ones as a multipart upload in parts of this size. */
export const MULTIPART_PART_BYTES = 16 * 1024 * 1024;

/** Re-chunk a stream into buffers of exactly `size` bytes (the last one may be smaller). */
export async function* inParts(source: AsyncIterable<Buffer | Uint8Array | string>, size: number): AsyncGenerator<Buffer> {
  let held: Buffer[] = [];
  let n = 0;
  for await (const raw of source) {
    let chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    while (n + chunk.length >= size) {
      const take = size - n;
      held.push(chunk.subarray(0, take));
      yield Buffer.concat(held, size);
      held = [];
      n = 0;
      chunk = chunk.subarray(take);
    }
    if (chunk.length) {
      held.push(chunk);
      n += chunk.length;
    }
  }
  if (n) yield Buffer.concat(held, n);
}

function r2Driver(c: R2Config): Driver {
  const client = r2Client(c);
  const base = c.publicUrl.replace(/\/$/, '');
  const cacheControl = (key: string) => (key.startsWith('public/') ? 'public, max-age=31536000, immutable' : 'private, max-age=0');
  return {
    async putStream(key, source, contentType) {
      const Key = safeKey(key);
      const stream = typeof source === 'string' ? createReadStream(source, { highWaterMark: 1 << 20 }) : source;
      const parts = inParts(stream, MULTIPART_PART_BYTES);
      const first = await parts.next();
      const second = first.done ? first : await parts.next();
      // Small enough for one request: no multipart bookkeeping.
      if (first.done || second.done) {
        const body = first.done ? Buffer.alloc(0) : first.value;
        await client.send(new PutObjectCommand({ Bucket: c.bucket, Key, Body: body, ContentType: contentType, CacheControl: cacheControl(key) }));
        return body.length;
      }
      const { UploadId } = await client.send(
        new CreateMultipartUploadCommand({ Bucket: c.bucket, Key, ContentType: contentType, CacheControl: cacheControl(key) }),
      );
      if (!UploadId) throw new Error('R2 did not start the multipart upload');
      try {
        const done: { ETag: string | undefined; PartNumber: number }[] = [];
        let bytes = 0;
        const send = async (body: Buffer) => {
          const PartNumber = done.length + 1;
          const r = await client.send(new UploadPartCommand({ Bucket: c.bucket, Key, UploadId, PartNumber, Body: body }));
          done.push({ ETag: r.ETag, PartNumber });
          bytes += body.length;
        };
        await send(first.value);
        await send(second.value);
        for await (const part of parts) await send(part);
        await client.send(new CompleteMultipartUploadCommand({ Bucket: c.bucket, Key, UploadId, MultipartUpload: { Parts: done } }));
        return bytes;
      } catch (e) {
        // Leave nothing half-uploaded (and billed) behind.
        await client.send(new AbortMultipartUploadCommand({ Bucket: c.bucket, Key, UploadId })).catch(() => {});
        if (typeof source !== 'string') source.destroy();
        throw e;
      }
    },
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: c.bucket,
          Key: safeKey(key),
          Body: body,
          ContentType: contentType,
          CacheControl: cacheControl(key),
        }),
      );
    },
    async get(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: c.bucket, Key: safeKey(key) }));
        if (!r.Body) return null;
        return { stream: r.Body as Readable, contentType: r.ContentType ?? contentTypeFor(key), size: r.ContentLength };
      } catch {
        return null;
      }
    },
    async read(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: c.bucket, Key: safeKey(key) }));
        return r.Body ? Buffer.from(await r.Body.transformToByteArray()) : null;
      } catch {
        return null;
      }
    },
    async del(key) {
      await client.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: safeKey(key) }));
    },
    publicUrl: (key) => (base && key.startsWith('public/') ? `${base}/${safeKey(key)}` : null),
  };
}

let cached: { driver: Driver; fingerprint: string } | null = null;

export async function storage(): Promise<Driver> {
  const s = await getSetting('storage');
  const useR2 = s.driver === 'r2' && s.r2_account_id && s.r2_bucket && s.r2_access_key_id && s.r2_secret_access_key;
  const fingerprint = useR2 ? `r2:${s.r2_account_id}:${s.r2_bucket}:${s.r2_access_key_id}:${s.r2_public_url}` : 'local';
  if (cached?.fingerprint === fingerprint) return cached.driver;
  const driver = useR2
    ? r2Driver({
        accountId: s.r2_account_id,
        bucket: s.r2_bucket,
        accessKeyId: s.r2_access_key_id,
        secretAccessKey: s.r2_secret_access_key,
        publicUrl: s.r2_public_url,
      })
    : localDriver();
  cached = { driver, fingerprint };
  return driver;
}

/**
 * A sentence an admin can act on from an S3 client failure. A HEAD request has
 * no response body, so the SDK reports rejected credentials or a missing bucket
 * as the useless "Unknown: UnknownError"; the HTTP status says what happened.
 */
export function describeR2Error(e: unknown): string {
  const err = (e ?? {}) as { name?: string; message?: string; code?: string; cause?: unknown; $metadata?: { httpStatusCode?: number } };
  const status = err.$metadata?.httpStatusCode;
  if (status === 401 || status === 403) {
    return `R2 refused these credentials (HTTP ${status}). Check the access key ID and secret, and that the API token is allowed to read and write this bucket.`;
  }
  if (status === 404) return 'R2 answered, but there is no bucket with that name in this account (HTTP 404). Check the bucket name and the account ID.';
  if (status === 301 || status === 400) return `R2 rejected the request (HTTP ${status}). Check the account ID and the bucket name.`;
  if (status && status >= 500) return `R2 is having trouble right now (HTTP ${status}). Try again in a minute.`;
  // No HTTP answer at all: DNS, TLS, refused or timed-out connection. The useful part is the innermost cause.
  let cause: unknown = err;
  const seen = new Set<unknown>();
  while (cause && typeof cause === 'object' && (cause as { cause?: unknown }).cause && !seen.has(cause)) {
    seen.add(cause);
    cause = (cause as { cause?: unknown }).cause;
  }
  const inner = (cause ?? {}) as { code?: string; message?: string; name?: string };
  const code = inner.code ?? err.code;
  const known: Record<string, string> = {
    ENOTFOUND: 'the R2 address for that account ID does not exist (check the account ID)',
    EAI_AGAIN: 'the server could not look up the R2 address (DNS is not answering)',
    ECONNREFUSED: 'the connection was refused',
    ECONNRESET: 'the connection was closed before R2 answered',
    ETIMEDOUT: 'the connection timed out',
    UND_ERR_CONNECT_TIMEOUT: 'the connection timed out',
  };
  const text = [inner.message, err.message].find((m) => m && m !== 'UnknownError' && m !== 'Unknown');
  const detail = (code && known[code]) || text || code || [err.name, inner.name].find((n) => n && n !== 'Unknown' && n !== 'Error') || 'no response from the server';
  return `Could not reach R2: ${detail}${code && known[code] ? ` (${code})` : ''}`;
}

/** Used by the /admin "Test connection" button. */
export async function testR2(c: R2Config): Promise<{ ok: boolean; error?: string }> {
  try {
    await r2Client(c).send(new HeadBucketCommand({ Bucket: c.bucket }));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describeR2Error(e) };
  }
}

/** URL the browser should use for a public/ key. */
export async function publicUrl(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  const direct = (await storage()).publicUrl(key);
  return direct ?? `/media/${key}`;
}

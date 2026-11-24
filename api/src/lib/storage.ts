import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import type { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

function r2Driver(c: R2Config): Driver {
  const client = r2Client(c);
  const base = c.publicUrl.replace(/\/$/, '');
  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: c.bucket,
          Key: safeKey(key),
          Body: body,
          ContentType: contentType,
          CacheControl: key.startsWith('public/') ? 'public, max-age=31536000, immutable' : 'private, max-age=0',
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

/** Used by the /admin "Test connection" button. */
export async function testR2(c: R2Config): Promise<{ ok: boolean; error?: string }> {
  try {
    await r2Client(c).send(new HeadBucketCommand({ Bucket: c.bucket }));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).name + ': ' + (e as Error).message };
  }
}

/** URL the browser should use for a public/ key. */
export async function publicUrl(key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  const direct = (await storage()).publicUrl(key);
  return direct ?? `/media/${key}`;
}

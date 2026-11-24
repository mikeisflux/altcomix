import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { describeR2Error, inParts, storage } from './storage.ts';

async function collect(chunks: Buffer[], size: number): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const p of inParts(Readable.from(chunks), size)) out.push(p);
  return out;
}

test('inParts re-chunks a stream into equal parts with a smaller last one', async () => {
  const data = Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 251));
  const chunks = [data.subarray(0, 7), data.subarray(7, 1300), data.subarray(1300, 1301), data.subarray(1301)];
  const parts = await collect(chunks, 1000);
  assert.deepEqual(parts.map((p) => p.length), [1000, 1000, 500]);
  assert.ok(Buffer.concat(parts).equals(data));
});

test('inParts: exact multiple, one big chunk, and an empty stream', async () => {
  assert.deepEqual((await collect([Buffer.alloc(3000, 1)], 1000)).map((p) => p.length), [1000, 1000, 1000]);
  assert.deepEqual((await collect([Buffer.alloc(10, 1)], 1000)).map((p) => p.length), [10]);
  assert.deepEqual(await collect([], 1000), []);
});

test('local driver: putStream stores a file path and a stream without changing the bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'altcomix-storage-test-'));
  const store = await storage();
  const key = `private/staging/storage-test-${Date.now()}`;
  try {
    const data = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 31) % 256));
    const file = join(dir, 'in.bin');
    await writeFile(file, data);
    assert.equal(await store.putStream(`${key}/a.bin`, file, 'application/octet-stream'), data.length);
    assert.equal(await store.putStream(`${key}/b.bin`, Readable.from([data.subarray(0, 1000), data.subarray(1000)]), 'application/octet-stream'), data.length);
    assert.ok((await store.read(`${key}/a.bin`))!.equals(data));
    assert.ok((await store.read(`${key}/b.bin`))!.equals(data));
    // The Buffer put still works for existing callers.
    await store.put(`${key}/c.bin`, data.subarray(0, 10), 'application/octet-stream');
    assert.equal((await store.read(`${key}/c.bin`))!.length, 10);
    assert.ok((await readFile(file)).equals(data));
  } finally {
    for (const n of ['a', 'b', 'c']) await store.del(`${key}/${n}.bin`);
    await rm(dir, { recursive: true, force: true });
  }
});

test('describeR2Error turns the SDK\'s "Unknown: UnknownError" into something an admin can act on', () => {
  const sdk = (status: number) => Object.assign(new Error('UnknownError'), { name: 'Unknown', $metadata: { httpStatusCode: status } });
  assert.match(describeR2Error(sdk(403)), /refused these credentials \(HTTP 403\)/);
  assert.match(describeR2Error(sdk(404)), /no bucket with that name/);
  assert.match(describeR2Error(sdk(503)), /having trouble/);
  const dns = Object.assign(new Error('getaddrinfo ENOTFOUND abc.r2.cloudflarestorage.com'), { code: 'ENOTFOUND' });
  assert.equal(describeR2Error(dns), 'Could not reach R2: the R2 address for that account ID does not exist (check the account ID) (ENOTFOUND)');
  const wrapped = Object.assign(new Error('UnknownError'), { name: 'Unknown', cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }) });
  assert.equal(describeR2Error(wrapped), 'Could not reach R2: the connection was refused (ECONNREFUSED)');
  assert.equal(describeR2Error(new Error('socket hang up')), 'Could not reach R2: socket hang up');
  assert.doesNotMatch(describeR2Error(Object.assign(new Error('UnknownError'), { name: 'Unknown' })), /Unknown/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canView } from './access.ts';

const series = (over: Record<string, unknown> = {}) => ({ visibility: 'public', deleted_at: null, takedown_at: null, takedown_purge: false, mature: false, ...over });
const release = (over: Record<string, unknown> = {}) => ({ status: 'published', deleted_at: null, mature: false, ...over });
const down = { takedown_at: '2026-01-01T00:00:00Z' };
const purged = { ...down, takedown_purge: true };

test('a public, published release is open to everyone', () => {
  assert.deepEqual(canView(series(), release(), false, false), { ok: true });
  assert.deepEqual(canView(series(), null, false, false), { ok: true });
});

test('drafts and unpublished releases are closed to the public and open to the brand', () => {
  assert.equal(canView(series({ visibility: 'draft' }), null, false, false).ok, false);
  assert.equal(canView(series(), release({ status: 'draft' }), false, false).ok, false);
  assert.equal(canView(series({ visibility: 'draft' }), release({ status: 'draft' }), false, true).ok, true);
});

test('a taken-down series is gone for visitors without an entitlement', () => {
  assert.deepEqual(canView(series(down), release(), true, false), { ok: false, reason: 'This title is not available' });
  // The series page (no release) has nothing to be entitled to.
  assert.equal(canView(series(down), null, true, false).ok, false);
  assert.equal(canView(series(down), null, true, false, { entitled: true }).ok, false);
});

test('a taken-down release stays open to the reader who owns it', () => {
  assert.deepEqual(canView(series(down), release(), false, false, { entitled: true }), { ok: true });
});

test('owning one release does not open an unpublished or deleted one', () => {
  assert.equal(canView(series(down), release({ status: 'draft' }), false, false, { entitled: true }).ok, false);
  assert.equal(canView(series(down), release({ deleted_at: '2026-01-02T00:00:00Z' }), false, false, { entitled: true }).ok, false);
  assert.equal(canView(series({ ...down, deleted_at: '2026-01-02T00:00:00Z' }), release(), false, false, { entitled: true }).ok, false);
});

test('the mature gate still applies to an owned, taken-down release', () => {
  assert.deepEqual(canView(series({ ...down, mature: true }), release(), false, false, { entitled: true }), { ok: false, reason: 'mature' });
  assert.equal(canView(series({ ...down, mature: true }), release(), true, false, { entitled: true }).ok, true);
});

test('a purged takedown is closed to buyers and to the brand, open to platform admins only', () => {
  assert.deepEqual(canView(series(purged), release(), true, false, { entitled: true }), { ok: false, reason: 'This title has been removed' });
  assert.equal(canView(series(purged), release(), true, true).ok, false);
  assert.equal(canView(series(purged), release(), true, true, { admin: true }).ok, true);
  assert.equal(canView(series(purged), null, false, false, { admin: true }).ok, true);
});

test('the purge flag does nothing until the series is actually taken down', () => {
  assert.equal(canView(series({ takedown_purge: true }), release(), false, false).ok, true);
});

test('the brand can still open its own taken-down (not purged) series', () => {
  assert.equal(canView(series(down), release(), false, true).ok, true);
});

test('mature titles need the reader to have confirmed they are an adult', () => {
  assert.deepEqual(canView(series({ mature: true }), null, false, false), { ok: false, reason: 'mature' });
  assert.deepEqual(canView(series(), release({ mature: true }), false, false), { ok: false, reason: 'mature' });
  assert.equal(canView(series({ mature: true }), release(), true, false).ok, true);
});

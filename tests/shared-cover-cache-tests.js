import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedCoverLoader, sharedCoverCacheKey, SHARED_COVER_MAX_ENTRIES, SHARED_COVER_MAX_BYTES } from '../js/shared-cover-cache.js';

test('shared cover cache keys include the owner and book IDs', () => {
  assert.notEqual(sharedCoverCacheKey('friend-a', 'book-1'), sharedCoverCacheKey('friend-b', 'book-1'));
  assert.notEqual(sharedCoverCacheKey('friend-a', 'book-1'), sharedCoverCacheKey('friend-a', 'book-2'));
});

test('shared cover is extracted once and reused while modifiedTime is unchanged', async () => {
  const entries = new Map();
  let extractions = 0;
  const load = createSharedCoverLoader({
    get: async (key) => entries.get(key) || null,
    set: async (entry) => { entries.set(entry.key, entry); },
    extract: async () => { extractions += 1; return { cover: { bytes: new Uint8Array([1, 2]), mimeType: 'image/jpeg' } }; },
    resize: async () => new Blob(['small-webp'], { type: 'image/webp' }),
    now: () => 123,
  });
  const book = { id: 'book-1', modifiedTime: '2026-01-01T00:00:00Z', sourceType: 'fb2' };
  const first = await load('friend-a', book);
  const second = await load('friend-a', book);
  assert.equal(first, second);
  assert.equal(extractions, 1);
  assert.equal(entries.size, 1);
});

test('shared cover is refreshed when the source book changes', async () => {
  const entries = new Map();
  let extractions = 0;
  const load = createSharedCoverLoader({
    get: async (key) => entries.get(key) || null,
    set: async (entry) => { entries.set(entry.key, entry); },
    extract: async () => { extractions += 1; return { cover: { bytes: new Uint8Array([extractions]), mimeType: 'image/jpeg' } }; },
    resize: async (cover) => new Blob([cover.bytes]),
  });
  await load('friend-a', { id: 'book-1', modifiedTime: 'v1' });
  await load('friend-a', { id: 'book-1', modifiedTime: 'v2' });
  assert.equal(extractions, 2);
  assert.equal(entries.get('friend-a:book-1').modifiedTime, 'v2');
});

test('missing or unsupported cover does not fail the shared book view', async () => {
  const load = createSharedCoverLoader({
    get: async () => null,
    set: async () => {},
    extract: async () => ({ title: 'Book without cover' }),
  });
  assert.equal(await load('friend-a', { id: 'book-1', modifiedTime: 'v1' }), null);
  assert.equal(SHARED_COVER_MAX_ENTRIES, 80);
  assert.equal(SHARED_COVER_MAX_BYTES, 15 * 1024 * 1024);
});

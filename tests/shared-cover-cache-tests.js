import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedCoverLoader, sharedCoverCacheKey, SHARED_COVER_CACHE_PREFIX } from '../js/shared-cover-cache.js';

test('shared cover cache keys include the owner and book IDs', () => {
  assert.notEqual(sharedCoverCacheKey('friend-a', 'book-1'), sharedCoverCacheKey('friend-b', 'book-1'));
  assert.notEqual(sharedCoverCacheKey('friend-a', 'book-1'), sharedCoverCacheKey('friend-a', 'book-2'));
});

test('shared cover is stored on the viewer Drive and reused without re-extracting the book', async () => {
  const files = [];
  const blobs = new Map();
  let extractions = 0;
  let creates = 0;
  const load = createSharedCoverLoader({
    list: async (prefix) => files.filter((file) => file.name.startsWith(prefix)),
    download: async (id) => blobs.get(id),
    create: async (name, blob) => {
      creates += 1;
      const file = { id: 'drive-cache-' + creates, name };
      files.push(file); blobs.set(file.id, blob); return file;
    },
    remove: async (id) => { const index = files.findIndex((file) => file.id === id); if (index >= 0) files.splice(index, 1); blobs.delete(id); },
    extract: async () => { extractions += 1; return { cover: { bytes: new Uint8Array([1, 2]), mimeType: 'image/jpeg' } }; },
    resize: async () => new Blob(['small-webp'], { type: 'image/webp' }),
  });
  const book = { id: 'book-1', modifiedTime: '2026-01-01T00:00:00Z', sourceType: 'fb2' };
  const first = await load('friend-a', book);
  const second = await load('friend-a', book);
  assert.equal(await first.text(), 'small-webp');
  assert.equal(await second.text(), 'small-webp');
  assert.equal(extractions, 1);
  assert.equal(creates, 1);
  assert.equal(files[0].name.startsWith(SHARED_COVER_CACHE_PREFIX + 'friend-a-book-1-'), true);
});

test('shared cover refreshes on Drive when source modifiedTime changes', async () => {
  const files = [];
  const blobs = new Map();
  let extractions = 0;
  const load = createSharedCoverLoader({
    list: async (prefix) => files.filter((file) => file.name.startsWith(prefix)),
    download: async (id) => blobs.get(id),
    create: async (name, blob) => { const file = { id: 'id-' + files.length, name }; files.push(file); blobs.set(file.id, blob); return file; },
    remove: async (id) => { const index = files.findIndex((file) => file.id === id); if (index >= 0) files.splice(index, 1); blobs.delete(id); },
    extract: async () => ({ cover: { bytes: new Uint8Array([++extractions]), mimeType: 'image/jpeg' } }),
    resize: async (cover) => new Blob([cover.bytes]),
  });
  await load('friend-a', { id: 'book-1', modifiedTime: 'v1' });
  await load('friend-a', { id: 'book-1', modifiedTime: 'v2' });
  assert.equal(extractions, 2);
  assert.equal(files.length, 1);
  assert.match(files[0].name, /v2/);
});

test('missing or unsupported cover does not fail the shared book view', async () => {
  const load = createSharedCoverLoader({
    list: async () => [],
    extract: async () => ({ title: 'Book without cover' }),
  });
  assert.equal(await load('friend-a', { id: 'book-1', modifiedTime: 'v1' }), null);
});

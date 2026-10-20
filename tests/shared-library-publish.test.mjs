import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createSharedLibraryStore } from '../js/shared-library.js';
import { socialError } from '../js/social-runtime.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

test('server manifest read failure aborts publication without cache fallback or writes and can be retried', async () => {
  let offline = true;
  const reads = [];
  const writes = [];
  const sdk = {
    doc: (_db, collection, id) => ({ path: `${collection}/${id}` }),
    collection: (_db, ...parts) => ({ path: parts.join('/') }),
    getDocFromServer: async (ref) => {
      reads.push(ref.path);
      if (offline) throw Object.assign(new Error('Cached document exists, server unavailable'), { code: 'unavailable' });
      return { exists: () => false, data: () => undefined };
    },
    writeBatch: () => ({
      set(ref, value) { writes.push(['set', ref.path, value]); },
      delete(ref) { writes.push(['delete', ref.path]); },
      commit: async () => {},
    }),
    setDoc: async (ref, value) => { writes.push(['manifest', ref.path, value]); },
    deleteDoc: async () => {},
  };
  const store = createSharedLibraryStore({ db: {}, sdk, user: { uid: 'owner' } });
  const index = { version: 4, rootFolderId: 'root', folders: [
    { id: 'root', parentId: null, name: 'Root' }, { id: 'shelf', parentId: 'root', name: 'Shelf' },
  ], books: [{ id: 'book-id', parentId: 'shelf', title: 'Book', authors: ['Author'] }] };
  const settings = { sharing: { excludedFolderIds: [] } };

  await assert.rejects(store.publish(index, settings), (error) => error.code === 'unavailable');
  assert.deepEqual(reads, ['sharedLibraries/owner']);
  assert.deepEqual(writes, [], 'no chunks or manifest writes before server revision is known');
  assert.equal(index.books[0].title, 'Book', 'failed publication does not mutate the owner index');
  assert.match(socialError(Object.assign(new Error('offline'), { code: 'unavailable' })), /Firebase/,
    'offline server failure gets a readable retryable connection message');

  offline = false;
  await store.publish(index, settings);
  assert.deepEqual(reads, ['sharedLibraries/owner', 'sharedLibraries/owner'], 'retry performs a fresh server read');
  assert(writes.some(([kind, path]) => kind === 'manifest' && path === 'sharedLibraries/owner'), 'retry publishes after server read succeeds');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createSharedLibraryStore, sharedLibraryIndex } from '../js/shared-library.js';
import { socialError } from '../js/social-runtime.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

test('excluded nested folders and all their descendants stay out of the shared catalog', () => {
  const index = {
    version: 4, rootFolderId: 'root', folders: [
      { id: 'root', parentId: null, name: 'Root' },
      { id: 'public', parentId: 'root', name: 'Public' },
      { id: 'private', parentId: 'public', name: 'Private' },
      { id: 'private-child', parentId: 'private', name: 'Private child' },
      { id: 'public-child', parentId: 'public', name: 'Public child' },
    ],
    books: [
      { id: 'public-book', parentId: 'public', title: 'Public book' },
      { id: 'private-book', parentId: 'private', title: 'Private book' },
      { id: 'private-child-book', parentId: 'private-child', title: 'Private child book' },
      { id: 'public-child-book', parentId: 'public-child', title: 'Public child book' },
    ],
  };
  const projection = sharedLibraryIndex(index, {
    sharing: { excludedFolderIds: ['private'] },
    folderNotes: { private: 'private note', 'private-child': 'child note', public: 'public note' },
  });
  assert.deepEqual(projection.folders.map(({ id }) => id), ['root', 'public', 'public-child']);
  assert.deepEqual(projection.books.map(({ id }) => id), ['public-book', 'public-child-book']);
  assert.deepEqual(projection.folderNotes, { public: 'public note' });
});

test('shared catalog traversal includes deep folders regardless of index order', () => {
  const index = {
    version: 4, rootFolderId: 'root', folders: [
      { id: 'deep', parentId: 'middle', name: 'Deep' },
      { id: 'hidden-child', parentId: 'hidden', name: 'Hidden child' },
      { id: 'middle', parentId: 'public', name: 'Middle' },
      { id: 'hidden', parentId: 'root', name: 'Hidden' },
      { id: 'public', parentId: 'root', name: 'Public' },
      { id: 'root', parentId: null, name: 'Root' },
    ],
    books: [
      { id: 'deep-book', parentId: 'deep', title: 'Deep book' },
      { id: 'hidden-book', parentId: 'hidden-child', title: 'Hidden book' },
    ],
  };
  const projection = sharedLibraryIndex(index, { sharing: { excludedFolderIds: ['hidden'] } });
  assert.deepEqual(projection.folders.map(({ id }) => id), ['deep', 'middle', 'public', 'root']);
  assert.deepEqual(projection.books.map(({ id }) => id), ['deep-book']);
});

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
    getDocsFromServer: async () => ({ docs: [] }),
    writeBatch: () => ({
      set(ref, value) { writes.push(['set', ref.path, value]); },
      delete(ref) { writes.push(['delete', ref.path]); },
      commit: async () => {},
    }),
    setDoc: async (ref, value) => { writes.push(['manifest', ref.path, value]); },
    deleteDoc: async () => {},
  };
  const store = createSharedLibraryStore({ db: {}, sdk, user: { uid: 'owner' }, authorizeItem: async () => true, rememberAuthorization: () => {} });
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

test('failed cover sync preserves old covers and retry completes publication', async () => {
  const documents = new Map([
    ['sharedLibraries/owner', { revision: 'old-revision', signature: 'old-signature', chunkCount: 1, coversSignature: 'old-covers' }],
    ['sharedLibraries/owner/covers/removed-book', { sourceKey: 'old-source', mimeType: 'image/webp', data: 'b2xk' }],
    ['sharedLibraries/owner/versions/old-revision/chunks/0', { position: 0, json: '{"books":[],"folders":[],"rootFolderId":"root"}' }],
  ]);
  const pathOf = (ref) => ref.path;
  const sdk = {
    doc: (first, ...parts) => ({ path: first?.path ? [first.path, ...parts].join('/') : parts.join('/') }),
    collection: (_db, ...parts) => ({ path: parts.join('/') }),
    getDocFromServer: async (ref) => { const value = documents.get(pathOf(ref)); return { exists: () => value !== undefined, data: () => value }; },
    getDocsFromServer: async (ref) => ({ docs: [...documents.entries()].filter(([path]) => path.startsWith(ref.path + '/'))
      .map(([path, data]) => ({ id: path.slice(ref.path.length + 1), ref: { path }, data: () => data })) }),
    writeBatch: () => {
      const pending = [];
      return { set(ref, value) { pending.push([ref.path, value]); }, delete(ref) { pending.push([ref.path, null]); },
        commit: async () => { for (const [path, value] of pending) { if (value === null) documents.delete(path); else documents.set(path, value); } } };
    },
    setDoc: async (ref, value) => { documents.set(ref.path, value); },
    deleteDoc: async (ref) => { documents.delete(ref.path); },
  };
  let failDownload = true;
  let failDelete = false;
  const deleteDoc = sdk.deleteDoc;
  sdk.deleteDoc = async (ref) => {
    if (failDelete && ref.path === 'sharedLibraries/owner/covers/removed-book') throw new Error('temporary delete failure');
    return deleteDoc(ref);
  };
  const store = createSharedLibraryStore({ db: {}, sdk, user: { uid: 'owner' }, authorizeItem: async () => true, rememberAuthorization: () => {},
    downloadCover: async () => {
      if (failDownload) throw new Error('temporary Drive failure');
      return new Blob(['new-cover'], { type: 'image/webp' });
    } });
  const index = { version: 4, rootFolderId: 'root', folders: [{ id: 'root', parentId: null, name: 'Root' }],
    books: [{ id: 'new-book', parentId: 'root', title: 'New book', coverFileId: 'new-drive-cover', modifiedTime: 'v1' }] };
  const settings = { sharing: { excludedFolderIds: [] } };

  await assert.rejects(store.publish(index, settings), /temporary Drive failure/);
  assert.equal(documents.get('sharedLibraries/owner').revision, 'old-revision', 'failed publish keeps the old catalog revision');
  assert.equal(documents.has('sharedLibraries/owner/covers/removed-book'), true,
    'failed cover sync must not delete covers still needed by the currently published catalog');

  failDownload = false;
  failDelete = true;
  await assert.rejects(store.publish(index, settings), /temporary delete failure/);
  assert.notEqual(documents.get('sharedLibraries/owner').revision, 'old-revision', 'catalog revision is published before stale-cover cleanup');
  assert.equal(documents.has('sharedLibraries/owner/covers/removed-book'), true, 'failed cleanup does not undo the new catalog');

  failDelete = false;
  await store.publish(index, settings);
  assert.equal(documents.has('sharedLibraries/owner/covers/removed-book'), false, 'a later retry cleans stale covers even when the catalog signature is unchanged');
});

test('shared book covers are copied to Firebase and loaded without access to the owner Drive', async () => {
  const documents = new Map();
  const writes = [];
  let downloads = 0;
  const pathOf = (ref) => ref.path;
  const sdk = {
    doc: (first, ...parts) => ({ path: first?.path ? [first.path, ...parts].join('/') : parts.join('/') }),
    collection: (_db, ...parts) => ({ path: parts.join('/') }),
    getDocFromServer: async (ref) => { const exists = documents.has(pathOf(ref)); const value = documents.get(pathOf(ref)); return { exists: () => exists, data: () => value }; },
    getDocsFromServer: async (ref) => ({ docs: [...documents.entries()].filter(([path]) => path.startsWith(ref.path + '/'))
      .map(([path, data]) => ({ id: path.slice(ref.path.length + 1), ref: { path }, data: () => data })) }),
    writeBatch: () => {
      const pending = [];
      return { set(ref, value) { pending.push([ref.path, value]); }, delete(ref) { pending.push([ref.path, null]); },
        commit: async () => { for (const [path, value] of pending) { if (value === null) documents.delete(path); else documents.set(path, value); writes.push(path); } } };
    },
    setDoc: async (ref, value) => { documents.set(ref.path, value); writes.push(ref.path); },
    deleteDoc: async (ref) => { documents.delete(ref.path); },
  };
  const store = createSharedLibraryStore({ db: {}, sdk, user: { uid: 'owner' }, authorizeItem: async () => true, rememberAuthorization: () => {},
    downloadCover: async (id) => { downloads++; assert.equal(id, 'private-drive-cover-id'); return new Blob(['tiny-webp'], { type: 'image/webp' }); } });
  const index = { version: 4, rootFolderId: 'root', folders: [{ id: 'root', parentId: null, name: 'Root' }],
    books: [{ id: 'book-id', parentId: 'root', title: 'Book', fileName: 'book.fb2', coverFileId: 'private-drive-cover-id', modifiedTime: 'v1' }] };
  const settings = { sharing: { excludedFolderIds: [] } };

  await store.publish(index, settings);
  const coverPath = 'sharedLibraries/owner/covers/book-id';
  assert.equal(documents.has(coverPath), true);
  assert.equal(documents.get(coverPath).data, Buffer.from('tiny-webp').toString('base64'));
  const cover = await store.loadCover('owner', 'book-id');
  assert.equal(await cover.text(), 'tiny-webp');
  await store.publish(index, settings);
  assert.equal(downloads, 1, 'unchanged cover is not uploaded again on each publish');
  const catalogChunk = [...documents.values()].find((value) => typeof value.json === 'string');
  assert.ok(catalogChunk, `shared catalog chunks were written: ${[...documents.keys()].join(', ')}`);
  assert.equal('coverFileId' in JSON.parse(catalogChunk.json).books[0], false,
    'private Drive cover IDs are not exposed in the shared catalog');
});

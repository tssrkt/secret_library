import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createSharedLibraryStore, sharedLibraryIndex } from '../js/shared-library.js';
import { AUTH_SESSION_KEY, restoreAuthSession } from '../js/auth.js?v=20261108-drive-file-picker-folder-fix';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

// These tests exercise Firebase publication logic, not real Google OAuth or Drive.
// Keep the Drive boundary deterministic and provide a valid in-memory session.
beforeEach(() => {
  restoreAuthSession({
    session: {
      getItem: (key) => key === AUTH_SESSION_KEY
        ? JSON.stringify({ accessToken: 'test-drive-token', expiresAt: Date.now() + 3600000, user: { emailAddress: 'owner@example.test' } })
        : null,
      removeItem: () => {},
    },
  });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    let payload = {};
    if (url.pathname === '/upload/drive/v3/files' && options.method === 'POST') {
      payload = { id: 'mock-drive-catalog-id', name: 'secret-library-catalog.json', mimeType: 'application/json', parents: ['root'] };
    } else if (url.pathname.startsWith('/upload/drive/v3/files/') && options.method === 'PATCH') {
      payload = { id: url.pathname.split('/').pop() };
    } else if (url.pathname === '/drive/v3/files') {
      payload = { files: [] };
    } else {
      payload = { id: 'mock-drive-catalog-id' };
    }
    return {
      ok: true, status: 200,
      json: async () => payload,
      clone() { return { json: async () => payload }; },
    };
  };
});

test('shared catalog lifecycle never deletes Drive files and uses a tombstone when unpublished', async () => {
  const { readFile } = await import('node:fs/promises');
  const driveSource = await readFile(new URL('../js/drive.js', import.meta.url), 'utf8');
  const sharedSource = await readFile(new URL('../js/shared-library.js', import.meta.url), 'utf8');
  const deleteImplementation = driveSource.match(/export async function deleteDriveFile\(fileId\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(deleteImplementation, /drive_file_deletion_blocked/);
  assert.doesNotMatch(deleteImplementation, /driveFetch|method:\s*['"]DELETE['"]/);
  assert.doesNotMatch(sharedSource, /deleteDriveFile\s*\(/);
  assert.match(sharedSource, /existing = null;/);
  assert.match(driveSource, /unpublishedCatalog \|\| inaccessibleMarkedCatalog \|\| null/);
  assert.match(sharedSource, /published:\s*false/);
  assert.match(sharedSource, /index\.published === false/);
});

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

test('Drive catalog lookup failure aborts publication before any catalog write', async () => {
  let creates = 0;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/drive/v3/files' && options.method !== 'POST') {
      const body = { error: { message: 'Access denied' } };
      return { ok: false, status: 403, headers: { get: () => null }, json: async () => body, clone() { return { json: async () => body }; } };
    }
    if (url.pathname === '/upload/drive/v3/files' && options.method === 'POST') creates++;
    throw new Error('Unexpected Drive request');
  };
  const store = createSharedLibraryStore({ user: { uid: 'owner' } });
  const index = { version: 4, rootFolderId: 'root', folders: [{ id: 'root', parentId: null, name: 'Root' }], books: [] };
  await assert.rejects(store.publish(index, { sharing: { excludedFolderIds: [] } }), (error) => error.status === 403);
  assert.equal(creates, 0, 'catalog is not created when the existing-catalog lookup fails');
});

test('failed Drive catalog creation can be retried successfully', async () => {
  let creates = 0;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/drive/v3/files') return { ok: true, status: 200, json: async () => ({ files: [] }), clone() { return { json: async () => ({ files: [] }) }; } };
    if (url.pathname === '/upload/drive/v3/files' && options.method === 'POST') {
      creates++;
      if (creates === 1) {
        const body = { error: { message: 'Temporary create failure' } };
        return { ok: false, status: 400, headers: { get: () => null }, json: async () => body, clone() { return { json: async () => body }; } };
      }
      const body = { id: 'created-catalog', name: 'secret-library-catalog.json', mimeType: 'application/json', parents: ['root'] };
      return { ok: true, status: 200, json: async () => body, clone() { return { json: async () => body }; } };
    }
    throw new Error('Unexpected Drive request: ' + url.pathname);
  };
  const store = createSharedLibraryStore({ user: { uid: 'owner' } });
  const index = { version: 4, rootFolderId: 'root', folders: [{ id: 'root', parentId: null, name: 'Root' }], books: [] };
  const settings = { sharing: { excludedFolderIds: [] } };
  await assert.rejects(store.publish(index, settings), /Temporary create failure/);
  const result = await store.publish(index, settings);
  assert.equal(result.fileId, 'created-catalog');
  assert.equal(creates, 2, 'retry performs a new create attempt after the failed request');
});

test('changing the root tombstones the old catalog and creates a new one without moving or deleting files', async () => {
  const oldCatalog = {
    version: 4, rootFolderId: 'old-root', folders: [{ id: 'old-root', parentId: null, name: 'Old root' }],
    books: [], folderNotes: {}, ownerUid: 'owner', ownerDisplayName: 'Owner', signature: 'old-signature', published: true,
  };
  let tombstoneBody = '';
  let createBody = '';
  let deleteCalls = 0;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/drive/v3/files') {
      const body = { files: [{ id: 'old-catalog', name: 'secret-library-catalog.json', mimeType: 'application/json',
        parents: ['old-root'], appProperties: { secretLibraryOwnerUid: 'owner' } }] };
      return { ok: true, status: 200, json: async () => body, clone() { return { json: async () => body }; } };
    }
    if (url.pathname === '/drive/v3/files/old-catalog' && url.searchParams.get('alt') === 'media') {
      return { ok: true, status: 200, json: async () => oldCatalog, clone() { return { json: async () => oldCatalog }; } };
    }
    if (url.pathname === '/upload/drive/v3/files/old-catalog' && options.method === 'PATCH') {
      tombstoneBody = String(options.body);
      const body = { id: 'old-catalog' };
      return { ok: true, status: 200, json: async () => body, clone() { return { json: async () => body }; } };
    }
    if (url.pathname === '/upload/drive/v3/files' && options.method === 'POST') {
      createBody = String(options.body);
      const body = { id: 'new-catalog', name: 'secret-library-catalog.json', mimeType: 'application/json', parents: ['new-root'] };
      return { ok: true, status: 200, json: async () => body, clone() { return { json: async () => body }; } };
    }
    if (options.method === 'DELETE') deleteCalls++;
    const body = { error: { message: 'Unexpected Drive request: ' + options.method + ' ' + url.pathname } };
    return { ok: false, status: 400, headers: { get: () => null }, json: async () => body, clone() { return { json: async () => body }; } };
  };
  const store = createSharedLibraryStore({ user: { uid: 'owner', displayName: 'Owner' }, authorizeItem: async () => true, rememberAuthorization: () => {}, forgetAuthorization: () => {} });
  const index = { version: 4, rootFolderId: 'new-root', folders: [{ id: 'new-root', parentId: null, name: 'New root' }], books: [] };
  const result = await store.publish(index, { sharing: { excludedFolderIds: [] } });
  assert.equal(result.fileId, 'new-catalog');
  assert.match(tombstoneBody, /"published":false/);
  assert.match(tombstoneBody, /"rootFolderId":"old-root"/);
  assert.match(createBody, /"parents":\["new-root"\]/);
  assert.equal(deleteCalls, 0, 'root changes do not delete either the old catalog or ordinary Drive files');
});

test('published Drive catalog is created in the selected root without exposing private cover IDs', async () => {
  let requestBody = '';
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/drive/v3/files') return { ok: true, status: 200, json: async () => ({ files: [] }), clone() { return { json: async () => ({ files: [] }) }; } };
    if (url.pathname === '/upload/drive/v3/files' && options.method === 'POST') {
      requestBody = String(options.body);
      const body = { id: 'published-catalog', name: 'secret-library-catalog.json', mimeType: 'application/json', parents: ['root'] };
      return { ok: true, status: 200, json: async () => body, clone() { return { json: async () => body }; } };
    }
    throw new Error('Unexpected Drive request: ' + url.pathname);
  };
  const store = createSharedLibraryStore({ user: { uid: 'owner', displayName: 'Owner' } });
  const index = { version: 4, rootFolderId: 'root', folders: [{ id: 'root', parentId: null, name: 'Root' }],
    books: [{ id: 'book-id', parentId: 'root', title: 'Book', fileName: 'book.fb2', coverFileId: 'private-drive-cover-id', modifiedTime: 'v1' }] };
  const result = await store.publish(index, { sharing: { excludedFolderIds: [] } });
  assert.equal(result.fileId, 'published-catalog');
  assert.match(requestBody, /"parents":\["root"\]/);
  assert.match(requestBody, /"title":"Book"/);
  assert.doesNotMatch(requestBody, /private-drive-cover-id|coverFileId/,
    'private Drive cover IDs are not included in the published catalog');
});

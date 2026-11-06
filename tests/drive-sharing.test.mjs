import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverDriveFriends } from '../js/drive-sharing.js';

test('Drive permissions define one-way and mutual friend access independently', async () => {
  const request = async (path) => {
    const url = new URL(path, 'https://drive.googleapis.com');
    const q = url.searchParams.get('q') || '';
    if (url.pathname === '/files' && q.includes('sharedWithMe = true')) return { files: [] };
    if (url.pathname === '/files' && q.includes("'alice@example.com' in owners")) return { files: [{ id: 'root-alice', name: 'Alice Library', mimeType: 'application/vnd.google-apps.folder', owners: [{ displayName: 'Alice Example', emailAddress: 'alice@example.com' }] }] };
    if (url.pathname === '/files' && q.includes("'root-alice' in parents")) {
      return { files: [{ id: 'catalog-alice', name: '.secret-library-catalog.json', mimeType: 'application/json' }] };
    }
    if (url.pathname === '/files' && q.includes("name = '.secret-library-catalog.json'")) {
      return { files: [{ id: 'catalog-alice', name: '.secret-library-catalog.json', mimeType: 'application/json', parents: ['root-alice'] }] };
    }
    if (url.pathname === '/files/root-alice') return { id: 'root-alice', name: 'Alice Library', mimeType: 'application/vnd.google-apps.folder', owners: [{ displayName: 'Alice Example', emailAddress: 'alice@example.com' }] };
    if (url.pathname === '/files/root-me') {
      return { id: 'root-me', mimeType: 'application/vnd.google-apps.folder' };
    }
    if (url.pathname === '/files/root-me/permissions') {
      return { permissions: [
        { type: 'user', emailAddress: 'owner@example.com', role: 'owner', displayName: 'Owner' },
        { type: 'user', emailAddress: 'alice@example.com', role: 'reader', displayName: 'Alice Example' },
        { type: 'user', emailAddress: 'bob@example.com', role: 'writer', displayName: 'Bob Example' },
      ] };
    }
    throw new Error(`Unexpected Drive request: ${path}`);
  };
  const download = async (id) => {
    if (id === 'catalog-owner') return { ownerUid: 'owner-uid', rootFolderId: 'root-me' };
    if (id === 'catalog-alice') return { ownerUid: 'alice-uid', rootFolderId: 'root-alice' };
    throw new Error(`Unexpected catalog id: ${id}`);
  };
  const result = await discoverDriveFriends(
    { uid: 'owner-uid', email: 'owner@example.com' },
    '',
    { driveFetch: request, downloadDriveJsonFile: download, findDriveCatalogFile: async () => ({ id: 'catalog-owner' }) },
  );
  assert.equal(result.rootFolderId, 'root-me');
  assert.deepEqual(result.friends.map(({ uid, email, inbound, outbound }) => ({ uid, email, inbound, outbound })), [
    { uid: 'alice-uid', email: 'alice@example.com', inbound: true, outbound: true },
    { uid: 'email:bob@example.com', email: 'bob@example.com', inbound: false, outbound: true },
  ]);
});


test('reports shared Drive folders whose owners have not published a library catalog', async () => {
  const request = async (path) => {
    const url = new URL(path, 'https://drive.googleapis.com');
    const q = url.searchParams.get('q') || '';
    if (url.pathname === '/files' && q.includes('sharedWithMe = true')) {
      return { files: [{ id: 'root-friend', name: 'Friend Library', owners: [{ emailAddress: 'friend@example.com' }] }] };
    }
    if (url.pathname === '/files' && q.includes("'root-friend' in parents")) return { files: [] };
    if (url.pathname === '/files' && q.includes("name = '.secret-library-catalog.json'")) return { files: [] };
    if (url.pathname === '/files/root-me') return { id: 'root-me', mimeType: 'application/vnd.google-apps.folder' };
    if (url.pathname === '/files/root-me/permissions') return { permissions: [] };
    throw new Error(`Unexpected Drive request: ${path}`);
  };
  const result = await discoverDriveFriends({ uid: 'me', email: 'me@example.com' }, 'root-me', { driveFetch: request });
  assert.deepEqual(result.friends, []);
  assert.match(result.errors.join(' '), /Friend Library/);
  assert.match(result.errors.join(' '), /каталог не найден/);
});

test('finds a friend library by known email without requiring reciprocal sharing', async () => {
  const request = async (path) => {
    const url = new URL(path, 'https://drive.googleapis.com');
    const q = url.searchParams.get('q') || '';
    if (url.pathname === '/files' && q.includes('sharedWithMe = true')) return { files: [] };
    if (url.pathname === '/files' && q.includes("'olya@example.com' in owners")) {
      return { files: [{ id: 'root-olya', name: 'Olya Library', mimeType: 'application/vnd.google-apps.folder', owners: [{ displayName: 'Olya', emailAddress: 'olya@example.com' }] }] };
    }
    if (url.pathname === '/files' && q.includes("'root-olya' in parents")) {
      return { files: [{ id: 'catalog-olya', name: '.secret-library-catalog.json', mimeType: 'application/json' }] };
    }
    if (url.pathname === '/files' && q.includes("name = '.secret-library-catalog.json'")) {
      return { files: [{ id: 'catalog-olya', name: '.secret-library-catalog.json', mimeType: 'application/json', parents: ['root-olya'] }] };
    }
    if (url.pathname === '/files/root-me') return { id: 'root-me', mimeType: 'application/vnd.google-apps.folder' };
    if (url.pathname === '/files/root-me/permissions') return { permissions: [] };
    if (url.pathname === '/files/root-olya') { const error = new Error('metadata not available'); error.status = 404; throw error; }
    throw new Error(`Unexpected Drive request: ${path}`);
  };
  const result = await discoverDriveFriends(
    { uid: 'me-uid', email: 'me@example.com' },
    'root-me',
    {
      driveFetch: request,
      downloadDriveJsonFile: async (id) => {
        assert.equal(id, 'catalog-olya');
        return { ownerUid: 'olya-uid', rootFolderId: 'root-olya' };
      },
    },
    [{ uid: 'olya-uid', email: 'olya@example.com', displayName: 'Olya' }],
  );
  assert.ok(result.friends.some((friend) => friend.uid === 'olya-uid' && friend.inbound && friend.email === 'olya@example.com'));
  assert.match(result.errors.join(' '), /olya@example.com: Drive вернул 1 папок/);
  assert.match(result.errors.join(' '), /метаданные корневой папки root-olya недоступны/);
});

test('invitation grants root-folder reader permission to the invited Google account', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.includes('/permissions?') && options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.deepEqual(body, { type: 'user', role: 'reader', emailAddress: 'friend@example.com' });
      assert.equal(new URL(path, 'https://drive.googleapis.com').searchParams.get('sendNotificationEmail'), 'false');
      return { id: 'permission-created' };
    }
    if (path.endsWith('/permissions?fields=nextPageToken%2Cpermissions%28id%2Ctype%2CemailAddress%2CdisplayName%2Crole%2Cdeleted%29&pageSize=100&supportsAllDrives=true')) return { permissions: [] };
    throw new Error(`Unexpected Drive request: ${path}`);
  };
  const { grantRootFolderAccess } = await import('../js/drive-sharing.js');
  const result = await grantRootFolderAccess('my-root', ' Friend@Example.com ', { driveFetch: request });
  assert.deepEqual(result, { permissionId: 'permission-created', created: true, email: 'friend@example.com' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'POST');
});

test('invitation does not create a duplicate Drive permission when access already exists', async () => {
  let created = false;
  const request = async (path, options = {}) => {
    if (options.method === 'POST') { created = true; throw new Error('Should not create a duplicate permission'); }
    return { permissions: [{ id: 'existing-permission', type: 'user', emailAddress: 'friend@example.com', role: 'reader' }] };
  };
  const { grantRootFolderAccess } = await import('../js/drive-sharing.js');
  const result = await grantRootFolderAccess('my-root', 'friend@example.com', { driveFetch: request });
  assert.deepEqual(result, { permissionId: 'existing-permission', created: false, email: 'friend@example.com' });
  assert.equal(created, false);
});

test('matches a published catalog to the known friend email when Drive omits root owner details', async () => {
  const request = async (path) => {
    const url = new URL(path, 'https://drive.googleapis.com');
    const q = url.searchParams.get('q') || '';
    if (url.pathname === '/files' && q.includes('sharedWithMe = true')) return { files: [] };
    if (url.pathname === '/files' && q.includes("'olya@example.com' in owners")) {
      return { files: [{ id: 'root-olya', name: 'Secret_Library', mimeType: 'application/vnd.google-apps.folder' }] };
    }
    if (url.pathname === '/files' && q.includes("'root-olya' in parents")) {
      return { files: [{ id: 'catalog-olya', name: '.secret-library-catalog.json', mimeType: 'application/json' }] };
    }
    if (url.pathname === '/files' && q.includes("name = '.secret-library-catalog.json'")) {
      return { files: [{ id: 'catalog-olya', name: '.secret-library-catalog.json', mimeType: 'application/json', parents: ['root-olya'] }] };
    }
    if (url.pathname === '/files/root-me') return { id: 'root-me', mimeType: 'application/vnd.google-apps.folder' };
    if (url.pathname === '/files/root-me/permissions') return { permissions: [] };
    if (url.pathname === '/files/root-olya') return { id: 'root-olya', name: 'Secret_Library', mimeType: 'application/vnd.google-apps.folder' };
    throw new Error(`Unexpected Drive request: ${path}`);
  };
  const result = await discoverDriveFriends(
    { uid: 'me-uid', email: 'me@example.com' },
    'root-me',
    {
      driveFetch: request,
      downloadDriveJsonFile: async (id) => {
        assert.equal(id, 'catalog-olya');
        return { ownerUid: 'olya-uid', rootFolderId: 'root-olya', signature: 'test', books: [], folders: [] };
      },
    },
    [{ uid: 'unmatched-firebase-uid', email: 'olya@example.com', displayName: 'Olya' }],
  );
  const friend = result.friends.find((item) => item.uid === 'olya-uid');
  assert.ok(friend);
  assert.equal(friend.email, 'olya@example.com');
  assert.equal(friend.inbound, true);
  assert.equal(friend.catalogId, 'catalog-olya');
});

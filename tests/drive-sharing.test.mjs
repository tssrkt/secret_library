import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverDriveFriends } from '../js/drive-sharing.js';

test('retains outbound access for a registered friend who has not shared their own library', async () => {
  const request = async (path) => {
    const url = new URL(path, 'https://drive.googleapis.com');
    const q = url.searchParams.get('q') || '';
    if (url.pathname === '/files' && q.includes("name = '.secret-library-catalog.json'")) return { files: [] };
    if (url.pathname === '/files/root-me') return { id: 'root-me', mimeType: 'application/vnd.google-apps.folder' };
    if (url.pathname === '/files/root-me/permissions') return { permissions: [
      { type: 'user', emailAddress: 'owner@example.com', role: 'owner' },
      { type: 'user', emailAddress: 'ada@example.com', role: 'reader', displayName: 'Ada King' },
    ] };
    throw new Error(`Unexpected Drive request: ${path}`);
  };
  const result = await discoverDriveFriends(
    { uid: 'tara-uid', email: 'tara@example.com' },
    'root-me',
    { driveFetch: request },
    [{ uid: 'ada-uid', email: 'ada@example.com', displayName: 'Ada King', inbound: false, outbound: false }],
  );
  assert.deepEqual(result.friends.map(({ uid, email, inbound, outbound }) => ({ uid, email, inbound, outbound })), [
    { uid: 'ada-uid', email: 'ada@example.com', inbound: false, outbound: true },
  ]);
});

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
    if (id === 'catalog-alice') return { ownerUid: 'alice-uid', ownerDisplayName: 'alice', rootFolderId: 'root-alice' };
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
  ]);
  assert.equal(result.friends[0].displayName, 'Alice Example');
});


test('does not enumerate shared folders without a published catalog', async () => {
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
  assert.match(result.errors.join(' '), /catalog-search/);
  assert.equal(result.errors.join(' ').includes('shared-folder-no-catalog'), false);
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
      return { files: [{ id: 'catalog-olya', name: '.secret-library-catalog.json', mimeType: 'application/json', parents: ['root-olya'], owners: [{ displayName: 'Olya', emailAddress: 'olya@example.com' }] }] };
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
  assert.match(result.errors.join(' '), /catalog-search/);
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
    if (path.includes('/permissions?fields=nextPageToken%2Cpermissions%28id%2Ctype%2CemailAddress%2CdisplayName%2Crole%2Cdeleted%2CpermissionDetails%28inherited%2Crole%2CpermissionType%29%29')) return { permissions: [] };
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

test('invitation downgrades an existing direct editor permission to reader', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (options.method === 'PATCH') {
      assert.deepEqual(JSON.parse(options.body), { role: 'reader' });
      return { id: 'existing-permission', role: 'reader' };
    }
    return { permissions: [{ id: 'existing-permission', type: 'user', emailAddress: 'friend@example.com', role: 'writer', permissionDetails: [{ inherited: false, role: 'writer', permissionType: 'user' }] }] };
  };
  const { grantRootFolderAccess } = await import('../js/drive-sharing.js');
  const result = await grantRootFolderAccess('my-root', 'friend@example.com', { driveFetch: request });
  assert.deepEqual(result, { permissionId: 'existing-permission', created: false, email: 'friend@example.com' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'PATCH');
});

test('inherited editor permissions are not silently accepted as read-only', async () => {
  const request = async () => ({ permissions: [{ id: 'inherited-permission', type: 'user', emailAddress: 'friend@example.com', role: 'writer', permissionDetails: [{ inherited: true, role: 'writer', permissionType: 'user' }] }] });
  const { grantRootFolderAccess } = await import('../js/drive-sharing.js');
  await assert.rejects(() => grantRootFolderAccess('my-root', 'friend@example.com', { driveFetch: request }), /унаследованы права редактирования/);
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
      return { files: [{ id: 'catalog-olya', name: '.secret-library-catalog.json', mimeType: 'application/json', parents: ['root-olya'], owners: [{ displayName: 'Olya', emailAddress: 'olya@example.com' }] }] };
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

test('discovers a shared catalog from Drive owner metadata without Firebase UID or contact list', async () => {
  const request = async (path) => {
    const url = new URL(path, 'https://drive.googleapis.com');
    const q = url.searchParams.get('q') || '';
    if (url.pathname === '/files' && q.includes('sharedWithMe = true')) {
      return { files: [{ id: 'root-friend', name: 'Friend Library', owners: [{ emailAddress: 'friend@example.com', displayName: 'Friend' }] }] };
    }
    if (url.pathname === '/files' && q.includes("'root-friend' in parents")) {
      return { files: [{ id: 'catalog-friend', name: '.secret-library-catalog.json', mimeType: 'application/json' }] };
    }
    if (url.pathname === '/files' && q.includes("name = '.secret-library-catalog.json'")) {
      return { files: [{ id: 'catalog-friend', name: '.secret-library-catalog.json', mimeType: 'application/json', parents: ['root-friend'], owners: [{ displayName: 'Friend', emailAddress: 'friend@example.com' }] }] };
    }
    if (url.pathname === '/files/root-friend') { const error = new Error('metadata unavailable'); error.status = 404; throw error; }
    throw new Error(`Unexpected Drive request: ${path}`);
  };
  const result = await discoverDriveFriends(
    { emailAddress: 'me@example.com', displayName: 'Me' },
    '',
    { driveFetch: request, downloadDriveJsonFile: async () => ({ ownerUid: 'friend-uid', ownerDisplayName: 'Olya Shustrik', rootFolderId: 'root-friend', signature: 'sig', books: [], folders: [] }) },
    [],
  );
  assert.ok(result.friends.some((friend) => friend.uid === 'friend-uid' && friend.inbound && friend.email === 'friend@example.com' && friend.displayName === 'Olya Shustrik'));
  assert.match(result.errors.join(' '), /владелец сопоставлен по данным Google Drive/);
});

test('folder sharing settings enable and disable real Drive limited access', async () => {
  const calls = [];
  const state = new Map([
    ['private-folder', { id: 'private-folder', mimeType: 'application/vnd.google-apps.folder', inheritedPermissionsDisabled: false, capabilities: { canDisableInheritedPermissions: true, canEnableInheritedPermissions: true } }],
    ['public-folder', { id: 'public-folder', mimeType: 'application/vnd.google-apps.folder', inheritedPermissionsDisabled: true, capabilities: { canDisableInheritedPermissions: true, canEnableInheritedPermissions: true } }],
  ]);
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    const id = decodeURIComponent(path.match(/\/files\/([^/?]+)/)?.[1] || '');
    if (options.method === 'PATCH') {
      const patch = JSON.parse(options.body);
      state.get(id).inheritedPermissionsDisabled = patch.inheritedPermissionsDisabled;
      return { id, ...patch };
    }
    return state.get(id);
  };
  const { syncFolderSharingAccess } = await import('../js/drive-sharing.js');
  const authorizedFolders = [];
  const authorizeFolder = async (folder) => { authorizedFolders.push(folder); return true; };
  const index = { rootFolderId: 'root', folders: [
    { id: 'root', parentId: null, name: 'Root' },
    { id: 'private-folder', parentId: 'root', name: 'Private' },
    { id: 'public-folder', parentId: 'root', name: 'Public' },
    { id: 'nested', parentId: 'private-folder', name: 'Nested' },
  ] };
  await syncFolderSharingAccess(index, { sharing: { excludedFolderIds: ['private-folder'] } }, { driveFetch: request, authorizeFolder });
  assert.deepEqual(authorizedFolders.map(({ id, mimeType, isFolder }) => ({ id, mimeType, isFolder })), [
    { id: 'private-folder', mimeType: 'application/vnd.google-apps.folder', isFolder: true },
    { id: 'public-folder', mimeType: 'application/vnd.google-apps.folder', isFolder: true },
  ]);
  assert.equal(state.get('private-folder').inheritedPermissionsDisabled, true);
  assert.equal(state.get('public-folder').inheritedPermissionsDisabled, false);
  assert.equal(calls.filter((call) => call.options.method === 'PATCH').length, 2);
  await syncFolderSharingAccess(index, { sharing: { excludedFolderIds: [] } }, { driveFetch: request, authorizeFolder: async () => true });
  assert.equal(state.get('private-folder').inheritedPermissionsDisabled, false);
});

test('closeRootFolderAccess revokes only the matching direct Google Drive permission', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.includes('/permissions?')) return { permissions: [
      { id: 'friend-permission', type: 'user', emailAddress: 'friend@example.com', role: 'reader', permissionDetails: [{ inherited: false }] },
      { id: 'other-permission', type: 'user', emailAddress: 'other@example.com', role: 'reader', permissionDetails: [{ inherited: false }] },
    ] };
    return {};
  };
  const { closeRootFolderAccess } = await import('../js/drive-sharing.js');
  const result = await closeRootFolderAccess('root-id', 'Friend@Example.com', { driveFetch: request });
  assert.equal(result.revoked, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].path, /permissions\/friend-permission/);
  assert.equal(calls[1].options.method, 'DELETE');
});

test('closeRootFolderAccess refuses to remove inherited permission', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    return { permissions: [{ id: 'inherited-permission', type: 'user', emailAddress: 'friend@example.com', role: 'reader', permissionDetails: [{ inherited: true }] }] };
  };
  const { closeRootFolderAccess } = await import('../js/drive-sharing.js');
  await assert.rejects(closeRootFolderAccess('root-id', 'friend@example.com', { driveFetch: request }), /наследуется/);
  assert.equal(calls.length, 1);
});

test('authorizes a folder in Picker and retries metadata after an initial 403', async () => {
  const calls = [];
  const state = { id: 'folder-403', mimeType: 'application/vnd.google-apps.folder', inheritedPermissionsDisabled: false, capabilities: { canDisableInheritedPermissions: true, canEnableInheritedPermissions: true } };
  let pickerAuthorized = false;
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (!options.method && !pickerAuthorized) {
      const error = new Error('No access before Picker authorization');
      error.status = 403;
      throw error;
    }
    if (options.method === 'PATCH') {
      const patch = JSON.parse(options.body);
      state.inheritedPermissionsDisabled = patch.inheritedPermissionsDisabled;
      return { id: state.id, ...patch };
    }
    return state;
  };
  const { syncFolderSharingAccess } = await import('../js/drive-sharing.js');
  const pickerCalls = [];
  const authorizeFolder = async (folder) => {
    if (pickerAuthorized) return true;
    pickerCalls.push(folder);
    pickerAuthorized = true;
    return true;
  };
  await syncFolderSharingAccess({ rootFolderId: 'root', folders: [
    { id: 'root', parentId: null, name: 'Root' },
    { id: state.id, parentId: 'root', name: 'Private' },
  ] }, { sharing: { excludedFolderIds: [state.id] } }, { driveFetch: request, authorizeFolder });
  assert.equal(pickerCalls.length, 1);
  assert.equal(calls.filter((call) => !call.options.method).length, 2);
  assert.equal(state.inheritedPermissionsDisabled, true);
  assert.equal(calls.at(-1).options.method, 'PATCH');
});

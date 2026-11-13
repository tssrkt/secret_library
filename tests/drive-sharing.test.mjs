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

test('getRootFolderAccessState verifies reader access read-only without mutating permissions', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.includes('/permissions?')) return { permissions: [
      { id: 'owner-permission', type: 'user', emailAddress: 'Owner@Example.com', role: 'owner' },
      { id: 'friend-permission', type: 'user', emailAddress: 'friend@example.com', role: 'reader', permissionDetails: [{ inherited: false, role: 'reader', permissionType: 'user' }] },
    ] };
    throw new Error(`Unexpected Drive request: ${path}`);
  };
  const { getRootFolderAccessState } = await import('../js/drive-sharing.js');
  const result = await getRootFolderAccessState('my-root', ' Friend@Example.com ', { driveFetch: request });
  assert.deepEqual(result, { granted: true, role: 'reader', inherited: false, email: 'friend@example.com' });
  assert.equal(calls.length, 1, 'verification is a single read-only permissions list');
  assert.ok(!calls[0].options.method, 'no permission mutations are ever attempted');
});

test('getRootFolderAccessState reports absent access', async () => {
  const request = async () => ({ permissions: [{ type: 'user', emailAddress: 'other@example.com', role: 'reader' }] });
  const { getRootFolderAccessState } = await import('../js/drive-sharing.js');
  const result = await getRootFolderAccessState('my-root', 'friend@example.com', { driveFetch: request });
  assert.deepEqual(result, { granted: false, role: '', inherited: false, email: 'friend@example.com' });
});

test('getRootFolderAccessState reports a stronger role honestly instead of hiding it', async () => {
  const request = async () => ({ permissions: [{ type: 'user', emailAddress: 'friend@example.com', role: 'writer', permissionDetails: [{ inherited: false }] }] });
  const { getRootFolderAccessState } = await import('../js/drive-sharing.js');
  const result = await getRootFolderAccessState('my-root', 'friend@example.com', { driveFetch: request });
  assert.deepEqual(result, { granted: true, role: 'writer', inherited: false, email: 'friend@example.com' });
});

test('getRootFolderAccessState flags inherited permissions and ignores deleted ones', async () => {
  const request = async () => ({ permissions: [
    { type: 'user', emailAddress: 'friend@example.com', role: 'reader', deleted: true },
    { type: 'user', emailAddress: 'friend@example.com', role: 'reader', permissionDetails: [{ inherited: true, role: 'reader', permissionType: 'user' }] },
  ] });
  const { getRootFolderAccessState } = await import('../js/drive-sharing.js');
  const result = await getRootFolderAccessState('my-root', 'friend@example.com', { driveFetch: request });
  assert.deepEqual(result, { granted: true, role: 'reader', inherited: true, email: 'friend@example.com' });
});

test('getRootFolderAccessState treats an owner permission as full access', async () => {
  const request = async () => ({ permissions: [{ type: 'user', emailAddress: 'friend@example.com', role: 'owner' }] });
  const { getRootFolderAccessState } = await import('../js/drive-sharing.js');
  const result = await getRootFolderAccessState('my-root', 'friend@example.com', { driveFetch: request });
  assert.deepEqual(result, { granted: true, role: 'owner', inherited: false, email: 'friend@example.com' });
});

test('getRootFolderAccessState rejects an unknown root or participant email', async () => {
  const { getRootFolderAccessState } = await import('../js/drive-sharing.js');
  await assert.rejects(getRootFolderAccessState('', 'friend@example.com', { driveFetch: async () => ({ permissions: [] }) }), /корневую папку/);
  await assert.rejects(getRootFolderAccessState('my-root', '  ', { driveFetch: async () => ({ permissions: [] }) }), /email/);
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
  assert.deepEqual(authorizedFolders, [], 'saving folder settings must not open Google Picker');
  assert.equal(state.get('private-folder').inheritedPermissionsDisabled, true);
  assert.equal(state.get('public-folder').inheritedPermissionsDisabled, false);
  assert.equal(calls.filter((call) => call.options.method === 'PATCH').length, 2);
  await syncFolderSharingAccess(index, { sharing: { excludedFolderIds: [] } }, { driveFetch: request, authorizeFolder: async () => true });
  assert.equal(state.get('private-folder').inheritedPermissionsDisabled, false);
});

test('folder settings save never opens Picker when folder metadata is forbidden', async () => {
  let pickerCalls = 0;
  const request = async () => { const error = new Error('Access denied'); error.status = 403; throw error; };
  const { syncFolderSharingAccess } = await import('../js/drive-sharing.js');
  await assert.rejects(syncFolderSharingAccess({ rootFolderId: 'root', folders: [
    { id: 'root', parentId: null, name: 'Root' },
    { id: 'private-folder', parentId: 'root', name: 'Private' },
  ] }, { sharing: { excludedFolderIds: ['private-folder'] } }, {
    driveFetch: request,
    authorizeFolder: async () => { pickerCalls += 1; return true; },
  }));
  assert.equal(pickerCalls, 0);
});

test('does not open Picker when folder metadata is forbidden during settings save', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    const error = new Error('No access'); error.status = 403; error.stage = 'folder-sharing-metadata'; throw error;
  };
  const { syncFolderSharingAccess } = await import('../js/drive-sharing.js');
  let pickerCalls = 0;
  await assert.rejects(syncFolderSharingAccess({ rootFolderId: 'root', folders: [
    { id: 'root', parentId: null, name: 'Root' },
    { id: 'folder-403', parentId: 'root', name: 'Private' },
  ] }, { sharing: { excludedFolderIds: ['folder-403'] } }, {
    driveFetch: request,
    authorizeFolder: async () => { pickerCalls += 1; return true; },
  }), /folder-sharing-metadata.*HTTP 403/);
  assert.equal(pickerCalls, 0);
  assert.equal(calls.length, 1);
});


test('preserves Google API diagnostics without retrying metadata or opening Picker', async () => {
  let calls = 0;
  let pickerCalls = 0;
  const request = async () => {
    calls += 1;
    const error = new Error('Forbidden');
    error.status = 403;
    error.stage = 'folder-sharing-metadata';
    error.reason = 'insufficientFilePermissions';
    error.apiMessage = 'The user does not have sufficient permissions for this file.';
    throw error;
  };
  const { syncFolderSharingAccess } = await import('../js/drive-sharing.js');
  await assert.rejects(
    syncFolderSharingAccess({ rootFolderId: 'root', folders: [
      { id: 'root', parentId: null, name: 'Root' },
      { id: 'private-folder', parentId: 'root', name: 'Private folder' },
    ] }, { sharing: { excludedFolderIds: ['private-folder'] } }, {
      driveFetch: request,
      authorizeFolder: async () => { pickerCalls += 1; return true; },
    }),
    (error) => {
      assert.match(error.message, /folder-sharing-metadata/);
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /insufficientFilePermissions/);
      assert.match(error.message, /The user does not have sufficient permissions/);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(pickerCalls, 0);
});


test('does not invalidate Picker state or open Picker when a folder update is rejected with 403', async () => {
  const forgotten = [];
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (options.method === 'PATCH') {
      const error = new Error('appNotAuthorizedToFile');
      error.status = 403;
      error.stage = 'folder-sharing-update';
      error.reason = 'appNotAuthorizedToFile';
      throw error;
    }
    return { id: 'folder-patch-403', mimeType: 'application/vnd.google-apps.folder', inheritedPermissionsDisabled: false,
      capabilities: { canDisableInheritedPermissions: true, canEnableInheritedPermissions: true } };
  };
  const { syncFolderSharingAccess } = await import('../js/drive-sharing.js');
  await assert.rejects(syncFolderSharingAccess({ rootFolderId: 'root', folders: [
    { id: 'root', parentId: null, name: 'Root' },
    { id: 'folder-patch-403', parentId: 'root', name: 'Private folder' },
  ] }, { sharing: { excludedFolderIds: ['folder-patch-403'] } }, {
    driveFetch: request,
    authorizeFolder: async () => true,
    forgetFolderAuthorization: (id) => forgotten.push(id),
  }), /folder-sharing-update.*appNotAuthorizedToFile|appNotAuthorizedToFile.*folder-sharing-update/);
  assert.deepEqual(forgotten, []);
  assert.equal(calls.at(-1).options.method, 'PATCH');
});

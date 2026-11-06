import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverDriveFriends } from '../js/drive-sharing.js';

test('Drive permissions define one-way and mutual friend access independently', async () => {
  const request = async (path) => {
    const url = new URL(path, 'https://drive.googleapis.com');
    const q = url.searchParams.get('q') || '';
    if (url.pathname === '/files' && q.includes('sharedWithMe = true')) {
      return { files: [
        { id: 'root-alice', name: 'Alice Library', owners: [{ displayName: 'Alice Example', emailAddress: 'alice@example.com' }] },
      ] };
    }
    if (url.pathname === '/files' && q.includes("'root-alice' in parents")) {
      return { files: [{ id: 'catalog-alice', name: '.secret-library-catalog.json', mimeType: 'application/json' }] };
    }
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

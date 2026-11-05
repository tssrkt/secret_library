import test from 'node:test';
import assert from 'node:assert/strict';
import { canRestoreAdminRights, isValidLibraryShareId, isValidUid, projectDashboardAdmin, projectDashboardBan, projectDashboardEvent, projectDashboardInvitation, projectDashboardShare, projectDashboardUser } from '../functions/admin-security.js';

test('restoring a banned moderator restores admin rights only with explicit admins permission', () => {
  assert.equal(canRestoreAdminRights({ role: 'moderator', permissions: { banned: true } }, true, true), false);
  assert.equal(canRestoreAdminRights({ role: 'moderator', permissions: { admins: true, banned: true } }, true, true), true);
  assert.equal(canRestoreAdminRights({ role: 'superadmin', permissions: {} }, true, true), true);
  assert.equal(canRestoreAdminRights({ role: 'moderator', permissions: { admins: true } }, false, true), false);
  assert.equal(canRestoreAdminRights({ role: 'moderator', permissions: { admins: true } }, true, false), false);
});

test('Firestore document identifiers reject path traversal while accepting Google Firebase UIDs', () => {
  assert.equal(isValidUid('aA89pCYsKNbWWePmAveUVrG34F82'), true);
  assert.equal(isValidUid('target-uid_2'), true);
  assert.equal(isValidUid('target/../../adminUsers/root'), false);
  assert.equal(isValidUid(''), false);
  assert.equal(isValidLibraryShareId('owner-uid__viewer-uid'), true);
  assert.equal(isValidLibraryShareId('target/../../adminUsers/root'), false);
  assert.equal(isValidLibraryShareId('owner-uid__viewer-uid__extra'), false);
});

test('relationship-only dashboard profiles never expose email or unknown legacy fields', () => {
  const row = projectDashboardUser('uid-1', {
    displayName: 'Reader', photoURL: '', createdAt: 'date', invitedByUid: 'uid-0', isAdmin: false,
    email: 'private@example.com', privateNote: 'must not leak', accessToken: 'secret'
  }, { includeEmail: false, banned: false, admin: false });
  assert.deepEqual(row, {
    uid: 'uid-1', displayName: 'Reader', photoURL: '', createdAt: 'date',
    invitedByUid: 'uid-0', isAdmin: false, banned: false, admin: false
  });
  assert.equal(JSON.stringify(row).includes('private@example.com'), false);
  assert.equal(JSON.stringify(row).includes('must not leak'), false);
  assert.equal(JSON.stringify(row).includes('secret'), false);
});

test('user-directory email is included only when the caller has users permission', () => {
  const profile = { displayName: 'Reader', email: 'legacy@example.com', privateNote: 'hidden' };
  const allowed = projectDashboardUser('uid-1', profile, { includeEmail: true, email: 'directory@example.com' });
  const denied = projectDashboardUser('uid-1', profile, { includeEmail: false, email: 'directory@example.com' });
  assert.equal(allowed.email, 'directory@example.com');
  assert.equal(Object.hasOwn(denied, 'email'), false);
  assert.equal(Object.hasOwn(allowed, 'privateNote'), false);
});

test('invitation rows retain the recipient address but omit owner email and unknown fields', () => {
  const row = projectDashboardInvitation('owner-uid', 'recipient@example.com', {
    ownerUid: 'owner-uid', active: true, ownerEmail: 'owner@example.com', inviteeEmail: 'recipient@example.com',
    privateNote: 'hidden', accessToken: 'secret'
  });
  assert.equal(row.email, 'recipient@example.com');
  assert.equal(row.ownerUid, 'owner-uid');
  assert.equal(Object.hasOwn(row, 'ownerEmail'), false);
  assert.equal(Object.hasOwn(row, 'inviteeEmail'), false);
  assert.equal(Object.hasOwn(row, 'privateNote'), false);
  assert.equal(Object.hasOwn(row, 'accessToken'), false);
});

test('relationship-only share rows omit owner email and unknown fields', () => {
  const row = projectDashboardShare('share-id', {
    ownerUid: 'owner', viewerUid: 'viewer', active: true, ownerEmail: 'private@example.com', privateNote: 'hidden'
  });
  assert.deepEqual(row, { id: 'share-id', ownerUid: 'owner', viewerUid: 'viewer', active: true });
  assert.equal(JSON.stringify(row).includes('private@example.com'), false);
  assert.equal(JSON.stringify(row).includes('hidden'), false);
});

test('admin email is omitted unless the caller has users permission', () => {
  const admin = { role: 'moderator', active: true, email: 'admin@example.com', privateNote: 'hidden', permissions: { relationships: true, email: 'nested@example.com', privateNote: 'hidden' } };
  const denied = projectDashboardAdmin('uid-admin', admin);
  const allowed = projectDashboardAdmin('uid-admin', admin, { includeEmail: true });
  assert.equal(Object.hasOwn(denied, 'email'), false);
  assert.equal(allowed.email, 'admin@example.com');
  assert.equal(Object.hasOwn(denied, 'privateNote'), false);
  assert.deepEqual(denied.permissions, { relationships: true });
});

test('ban email and display name are omitted unless the caller has users permission', () => {
  const ban = { email: 'banned@example.com', displayName: 'Reader', reason: 'contact banned@example.com', bannedBy: 'admin', privateNote: 'hidden' };
  const denied = projectDashboardBan('uid-banned', ban);
  const allowed = projectDashboardBan('uid-banned', ban, { includeUserDetails: true });
  assert.deepEqual(denied, { uid: 'uid-banned', reason: 'contact [скрыто]', bannedBy: 'admin' });
  assert.equal(allowed.email, 'banned@example.com');
  assert.equal(Object.hasOwn(denied, 'privateNote'), false);
});

test('event details redact email-bearing fields for moderators without users permission', () => {
  const event = { actorUid: 'admin', action: 'revoke-invitation', details: { email: 'invitee@example.com', ownerUid: 'owner', reason: 'contact invitee@example.com', permissions: { users: true, email: 'nested@example.com', privateNote: 'hidden' }, nested: { recipientEmail: 'nested@example.com', reason: 'requested' } }, secretToken: 'not returned' };
  const denied = projectDashboardEvent('event-1', event);
  const allowed = projectDashboardEvent('event-1', event, { includeUserDetails: true });
  assert.equal(JSON.stringify(denied).includes('@example.com'), false);
  assert.equal(denied.details.ownerUid, 'owner');
  assert.equal(denied.details.reason, 'contact [скрыто]');
  assert.deepEqual(denied.details.permissions, { users: true });
  assert.equal(Object.hasOwn(denied.details, 'nested'), false);
  assert.equal(JSON.stringify(allowed).includes('invitee@example.com'), true);
  assert.equal(Object.hasOwn(denied, 'secretToken'), false);
});

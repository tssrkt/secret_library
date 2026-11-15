import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';

const source = readFileSync(new URL('../apps-script-invite/Code.gs', import.meta.url), 'utf8');

function createHarness(inviteeEmail = 'reader@example.com') {
  const values = new Map();
  const sent = [];
  let uuid = 0;
  const context = {
    console,
    Date,
    JSON,
    String,
    Number,
    Array,
    Map,
    Error,
    encodeURIComponent,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(String(value)).digest()],
      getUuid: () => (++uuid).toString(16).padStart(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => values.has(key) ? values.get(key) : null,
        getProperties: () => Object.fromEntries(values),
        setProperty: (key, value) => { values.set(key, String(value)); return this; },
        deleteProperty: (key) => values.delete(key),
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    MailApp: { sendEmail: (message) => sent.push(message) },
  };
  runInNewContext(source, context);
  const documents = new Map([
    ['users/owner-1-uid', { id: 'owner-1-uid', displayName: 'Inviter One', photoURL: '', invitedByUid: null }],
    ['users/owner-2-uid', { id: 'owner-2-uid', displayName: 'Inviter Two', photoURL: '', invitedByUid: null }],
  ]);
  const writes = [];
  context.fsGet = (path) => documents.has(path) ? { ...documents.get(path) } : null;
  context.fsSet = (path, value) => {
    documents.set(path, { ...(documents.get(path) || {}), ...value });
    writes.push({ path, value: { ...value } });
  };
  context.fsDelete = (path) => {
    documents.delete(path);
    writes.push({ path, deleted: true });
  };
  context.fsList = (path) => [...documents.entries()]
    .filter(([key]) => key.startsWith(path + '/'))
    .map(([key, value]) => ({ ...value, id: key.slice(path.length + 1) }));
  context.isBlockedInvitationEmail = () => false;
  context.verifyFirebaseUser = (token) => token.startsWith('reader-token')
    ? { localId: 'reader-uid', email: inviteeEmail, emailVerified: true, displayName: 'Reader' }
    : { localId: 'owner-1-uid', email: 'owner1@example.com', emailVerified: true };
  return { context, values, sent, documents, writes };
}

const READER_TOKEN = 'reader-token-'.padEnd(120, 'x');

function seedPendingShare(documents, ownerUid, ownerEmail, inviteeEmail, createdAt, claimed = true) {
  documents.set('pendingInvites/' + encodeURIComponent(inviteeEmail) + '/shares/' + ownerUid, {
    ownerUid, ownerEmail, inviteeEmail, active: true, claimedUid: claimed ? 'reader-uid' : null, createdAt,
  });
}

test('invitation cooldown status reads only script properties, not Firestore invitation records', () => {
  const { context, values } = createHarness();
  const email = 'friend@example.com';
  const key = context.reservationKey('reader-uid', email);
  values.set(key, JSON.stringify({ status: 'sent', at: 123456 }));
  context.readPendingInvitationsMany = () => { throw new Error('Firestore should not be queried'); };
  const statuses = context.handleInvitationStatuses({
    idToken: READER_TOKEN,
    emails: [email],
  });
  assert.equal(statuses[email].lastSentAt, 123456);
  assert.equal(statuses[email].cooldownUntil, 123456 + 60 * 60 * 1000);
});

test('owner invitation registry migrates legacy storage and stores recipients separately', () => {
  const { context, values } = createHarness(); const legacyKey = context.ownerInvitationRegistryKey('owner-uid');
  values.set(legacyKey, JSON.stringify({ 'old@example.com': { ownerUid: 'owner-uid', inviteeEmail: 'old@example.com', status: 'accepted', acceptedUid: 'old-uid' } }));
  assert.equal(context.readOwnerInvitationRegistry('owner-uid')['old@example.com'].acceptedUid, 'old-uid');
  context.saveOwnerInvitationRecord({ ownerUid: 'owner-uid', ownerEmail: 'owner@example.com', inviteeEmail: 'new@example.com', tokenHash: 'hash', status: 'pending', createdAt: 123 });
  assert.equal(values.has(legacyKey), false); assert.equal(context.readOwnerInvitationRegistry('owner-uid')['old@example.com'].acceptedUid, 'old-uid');
  assert.equal(context.readOwnerInvitationRegistry('owner-uid')['new@example.com'].status, 'pending');
  assert(values.has(context.ownerInvitationRecordKey('owner-uid', 'new@example.com')));
});

test('finalize claims the earliest invitation, creates shares and updates every owner registry', () => {
  const { context, documents, writes } = createHarness();
  const email = 'reader@example.com';
  documents.set('userDirectory/' + encodeURIComponent(email), { id: encodeURIComponent(email), uid: 'reader-uid' });
  documents.set('users/reader-uid', { id: 'reader-uid', displayName: 'Reader', invitedByUid: 'owner-1-uid' });
  seedPendingShare(documents, 'owner-2-uid', 'owner2@example.com', email, '2026-01-02T00:00:00Z');
  seedPendingShare(documents, 'owner-1-uid', 'owner1@example.com', email, '2026-01-01T00:00:00Z');
  context.saveOwnerInvitationRecord({ ownerUid: 'owner-1-uid', ownerEmail: 'owner1@example.com', inviteeEmail: email, status: 'pending', createdAt: 1 });
  context.saveOwnerInvitationRecord({ ownerUid: 'owner-2-uid', ownerEmail: 'owner2@example.com', inviteeEmail: email, status: 'pending', createdAt: 2 });

  const result = context.finalizeInviteeRegistration({ idToken: READER_TOKEN });

  assert.equal(result.ok, true);
  assert.equal(result.invitedByUid, 'owner-1-uid', 'the earliest pending inviter wins');
  const share = documents.get('libraryShares/owner-1-uid__reader-uid');
  assert.equal(share.active, true);
  assert.equal(share.ownerUid, 'owner-1-uid');
  assert.equal(share.viewerUid, 'reader-uid');
  assert.equal(share.ownerEmail, 'owner1@example.com');
  assert.equal(documents.get('libraryShares/owner-2-uid__reader-uid').active, true, 'every claimed inviter gains access');
  const accepted = context.readOwnerInvitationRecord('owner-1-uid', email);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.acceptedUid, 'reader-uid');
  assert.equal(accepted.acceptedDisplayName, 'Reader');
  assert.ok(accepted.acceptedAt > 0);
  assert.equal(context.readOwnerInvitationRecord('owner-2-uid', email).status, 'shared');
  assert.equal(writes.filter((item) => item.path === 'libraryShares/owner-1-uid__reader-uid').length, 1, 'the share is written exactly once');
  assert.equal(documents.has('pendingInvites/' + encodeURIComponent(email) + '/shares/owner-1-uid'), false, 'claimed shares are removed');
  assert.equal(documents.has('pendingInvites/' + encodeURIComponent(email)), false, 'the empty pending root is removed');
});

test('finalize without a pending invitation fails for an uninvited email', () => {
  const { context, documents, writes } = createHarness();
  const email = 'reader@example.com';
  documents.set('userDirectory/' + encodeURIComponent(email), { id: encodeURIComponent(email), uid: 'reader-uid' });
  documents.set('users/reader-uid', { id: 'reader-uid', displayName: 'Reader' });
  assert.throws(() => context.finalizeInviteeRegistration({ idToken: READER_TOKEN }), /No active invitation/);
  assert.equal(writes.some((item) => item.path.startsWith('libraryShares/')), false, 'no share is created without an invitation');
});

test('an already registered participant finalizes through the recorded inviter without new shares', () => {
  const { context, documents, writes } = createHarness();
  const email = 'reader@example.com';
  documents.set('userDirectory/' + encodeURIComponent(email), { id: encodeURIComponent(email), uid: 'reader-uid' });
  documents.set('users/reader-uid', { id: 'reader-uid', displayName: 'Reader', invitedByUid: 'owner-1-uid' });
  const result = context.finalizeInviteeRegistration({ idToken: READER_TOKEN });
  assert.deepEqual({ ...result }, { ok: true });
  assert.equal(writes.some((item) => item.path.startsWith('libraryShares/')), false, 'repeat finalization must not duplicate shares');
  documents.delete('users/owner-1-uid');
  assert.throws(() => context.finalizeInviteeRegistration({ idToken: READER_TOKEN }), /no longer exists/);
});

test('the recorded inviter must match the earliest pending invitation', () => {
  const { context, documents } = createHarness();
  const email = 'reader@example.com';
  documents.set('userDirectory/' + encodeURIComponent(email), { id: encodeURIComponent(email), uid: 'reader-uid' });
  documents.set('users/reader-uid', { id: 'reader-uid', displayName: 'Reader', invitedByUid: 'owner-2-uid' });
  seedPendingShare(documents, 'owner-1-uid', 'owner1@example.com', email, '2026-01-01T00:00:00Z');
  seedPendingShare(documents, 'owner-2-uid', 'owner2@example.com', email, '2026-01-02T00:00:00Z');
  assert.throws(() => context.finalizeInviteeRegistration({ idToken: READER_TOKEN }), /earliest active inviter/);
});

test('registration requires the directory entry and profile created by provisioning', () => {
  const { context, documents } = createHarness();
  const email = 'reader@example.com';
  documents.set('users/reader-uid', { id: 'reader-uid', displayName: 'Reader' });
  assert.throws(() => context.finalizeInviteeRegistration({ idToken: READER_TOKEN }), /registration has not completed/);
  documents.set('userDirectory/' + encodeURIComponent(email), { id: encodeURIComponent(email), uid: 'someone-else' });
  assert.throws(() => context.finalizeInviteeRegistration({ idToken: READER_TOKEN }), /registration has not completed/);
});

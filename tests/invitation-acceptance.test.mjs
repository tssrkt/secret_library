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
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA-256' },
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
  const documents = new Map([['users/owner-uid', { displayName: 'Inviter', photoURL: '', invitedByUid: null }]]);
  const writes = [];
  context.fsGet = (path) => documents.has(path) ? { ...documents.get(path) } : null;
  context.fsSet = (path, value) => {
    documents.set(path, { ...(documents.get(path) || {}), ...value });
    writes.push({ path, value: { ...value } });
  };
  context.isBlockedInvitationEmail = () => false;
  context.verifyFirebaseUser = (token) => token === 'owner-token'
    ? { localId: 'owner-uid', email: 'owner@example.com' }
    : { localId: 'reader-uid', email: inviteeEmail, emailVerified: true, displayName: 'Reader', photoUrl: 'https://example.com/reader.png' };
  return { context, values, sent, documents, writes };
}

test('invitation cooldown status reads only script properties, not Firestore invitation records', () => {
  const { context, values } = createHarness();
  const email = 'friend@example.com';
  const key = context.reservationKey('reader-uid', email);
  values.set(key, JSON.stringify({ status: 'sent', at: 123456 }));
  context.readPendingInvitationsMany = () => { throw new Error('Firestore should not be queried'); };
  const statuses = context.handleInvitationStatuses({
    idToken: 'x'.repeat(120),
    emails: [email],
  });
  assert.equal(statuses[email].lastSentAt, 123456);
  assert.equal(statuses[email].cooldownUntil, 123456 + 60 * 60 * 1000);
});


test('empty status request enumerates the owner registry without Firestore invitation reads', () => {
  const { context } = createHarness();
  context.issueInvitationAcceptanceToken('owner-uid', 'owner@example.com', 'reader@example.com');
  context.verifyFirebaseUser = () => ({ localId: 'owner-uid', email: 'owner@example.com', emailVerified: true });
  context.readPendingInvitationsMany = () => { throw new Error('Firestore invitation reads are forbidden'); };
  const statuses = context.handleInvitationStatuses({ idToken: 'x'.repeat(120), emails: [] });
  assert.equal(statuses['reader@example.com'].invitationStatus, 'pending');
  assert.ok(statuses['reader@example.com'].createdAt > 0);
});

test('empty status discovery restores more than one hundred admin invitations', () => {
  const { context } = createHarness();
  for (let i = 0; i < 125; i++) context.issueInvitationAcceptanceToken('owner-uid', 'owner@example.com', 'reader' + i + '@example.com');
  context.verifyFirebaseUser = () => ({ localId: 'owner-uid', email: 'owner@example.com', emailVerified: true });
  const statuses = context.handleInvitationStatuses({ idToken: 'x'.repeat(120), emails: [] });
  assert.equal(Object.keys(statuses).filter((email) => email !== '__quota').length, 125);
  assert.equal(statuses.__quota.limit, 20);
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
test('acceptance token is one-time, email-bound, and notifies the inviter once', () => {
  const { context, sent, documents, writes } = createHarness();
  const issued = context.issueInvitationAcceptanceToken('owner-uid', 'owner@example.com', 'reader@example.com');
  const first = context.handleAcceptInvitation({ token: issued.token, idToken: 'x'.repeat(120) });
  assert.equal(first.accepted, true);
  assert.equal(first.alreadyAccepted, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@example.com');
  assert.equal(documents.get('users/reader-uid').invitedByUid, 'owner-uid');
  assert.equal(documents.get('userDirectory/reader%40example.com').uid, 'reader-uid');
  assert.equal(documents.get('libraryShares/owner-uid__reader-uid').active, true);
  assert.equal(writes.filter((item) => item.path === 'libraryShares/owner-uid__reader-uid').length, 1);
  assert.equal(writes.some((item) => item.path.includes('pendingInvites')), false, 'accepted registration never depends on Firestore invitation records');
  context.isBlockedInvitationEmail = () => { throw new Error('Accepted-token retry must not query the email ban registry'); };
  const repeated = context.handleAcceptInvitation({ token: issued.token, idToken: 'x'.repeat(120) });
  assert.equal(repeated.accepted, true);
  assert.equal(repeated.alreadyAccepted, true);
  assert.equal(sent.length, 1);
  context.verifyFirebaseUser = () => ({ localId: 'owner-uid', email: 'owner@example.com', emailVerified: true });
  const statuses = context.handleInvitationStatuses({ idToken: 'x'.repeat(120), emails: ['reader@example.com'] });
  assert.equal(statuses['reader@example.com'].accepted, true);
  assert.equal(statuses['reader@example.com'].acceptedUid, 'reader-uid');
  assert.equal(statuses['reader@example.com'].acceptedDisplayName, 'Reader');
});

test('a banned inviter cannot have an outstanding invitation accepted', () => {
  const { context, values, documents, writes } = createHarness();
  const issued = context.issueInvitationAcceptanceToken('owner-uid', 'owner@example.com', 'reader@example.com');
  documents.set('bannedUsers/owner-uid', { uid: 'owner-uid' });
  assert.throws(() => context.handleAcceptInvitation({ token: issued.token, idToken: 'x'.repeat(120) }));
  assert.equal(context.readOwnerInvitationRecord('owner-uid', 'reader@example.com').status, 'revoked');
  assert.equal(values.has('invite_accept_' + issued.tokenHash), false);
  assert.equal(writes.some((item) => item.path === 'libraryShares/owner-uid__reader-uid'), false);
});

test('banned invitee cannot accept an invitation or create a library share', () => {
  const { context, documents, writes } = createHarness();
  const issued = context.issueInvitationAcceptanceToken('owner-uid', 'owner@example.com', 'reader@example.com');
  documents.set('bannedUsers/reader-uid', { uid: 'reader-uid' });
  assert.throws(() => context.handleAcceptInvitation({ token: issued.token, idToken: 'x'.repeat(120) }));
  assert.equal(documents.has('libraryShares/owner-uid__reader-uid'), false);
  assert.equal(writes.some((item) => item.path === 'libraryShares/owner-uid__reader-uid'), false);
  assert.equal(context.readOwnerInvitationRecord('owner-uid', 'reader@example.com').status, 'pending');
});

test('ban applied during provisioning revokes the accepted registry entry', () => {
  const { context, values, documents } = createHarness();
  const record = { ownerUid: 'owner-uid', ownerEmail: 'owner@example.com', inviteeEmail: 'reader@example.com', tokenHash: 'abc123', status: 'accepted', acceptedUid: 'reader-uid', acceptedAt: Date.now() };
  values.set('invite_accept_abc123', JSON.stringify(record));
  documents.set('bannedUsers/reader-uid', { uid: 'reader-uid' });
  assert.throws(() => context.provisionAcceptedInvitee(record, { localId: 'reader-uid', email: 'reader@example.com' }));
  assert.equal(context.readOwnerInvitationRecord('owner-uid', 'reader@example.com').status, 'revoked');
  assert.equal(values.has('invite_accept_abc123'), false);
});

test('legacy email ban prevents invitation acceptance before claiming token', () => {
  const { context, documents, writes } = createHarness();
  const issued = context.issueInvitationAcceptanceToken('owner-uid', 'owner@example.com', 'reader@example.com');
  context.isBlockedInvitationEmail = () => true;
  assert.throws(() => context.handleAcceptInvitation({ token: issued.token, idToken: 'x'.repeat(120) }));
  assert.equal(documents.has('libraryShares/owner-uid__reader-uid'), false);
  assert.equal(writes.some((item) => item.path === 'libraryShares/owner-uid__reader-uid'), false);
  assert.equal(context.readOwnerInvitationRecord('owner-uid', 'reader@example.com').status, 'pending');
});

test('acceptance token cannot be claimed by a different email', () => {
  const { context } = createHarness('other@example.com');
  const issued = context.issueInvitationAcceptanceToken('owner-uid', 'owner@example.com', 'reader@example.com');
  assert.throws(
    () => context.handleAcceptInvitation({ token: issued.token, idToken: 'x'.repeat(120) }),
  );
});

test('a newer invitation invalidates the older token', () => {
  const { context } = createHarness();
  const first = context.issueInvitationAcceptanceToken('owner-uid', 'owner@example.com', 'reader@example.com');
  const second = context.issueInvitationAcceptanceToken('owner-uid', 'owner@example.com', 'reader@example.com');
  assert.throws(
    () => context.handleAcceptInvitation({ token: first.token, idToken: 'x'.repeat(120) }),
    /./
  );
  assert.equal(context.handleAcceptInvitation({ token: second.token, idToken: 'x'.repeat(120) }).accepted, true);
});

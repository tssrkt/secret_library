import { readFile } from 'node:fs/promises';
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import * as sdk from 'firebase/firestore';
import { createSocialStore } from '../js/social-store.js';
import { friendsModel, notificationsModel, validateShareEmail } from '../js/social-model.js';

let env;
const identity = (uid, email = `${uid}@gmail.com`) => ({ uid, email, emailVerified: true, displayName: uid, photoURL: '' });
const client = (uid, email) => {
  const user = identity(uid, email);
  const db = env.authenticatedContext(uid, { email: user.email, email_verified: true, firebase: { sign_in_provider: 'google.com' } }).firestore();
  return { db, user, store: createSocialStore({ db, sdk, user }) };
};
const get = async (db, path) => { const snap = await sdk.getDoc(sdk.doc(db, path)); return snap.exists() ? snap.data() : null; };
before(async () => { env = await initializeTestEnvironment({ projectId: 'demo-secret-library', firestore: { rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
beforeEach(async () => { await env.clearFirestore(); });
after(async () => { await env.cleanup(); });

test('verified Google registration creates safe profile, exact email directory and immutable attribution', async () => {
  const anna = client('anna'); const boris = client('boris');
  await anna.store.register(); await boris.store.register();
  assert.deepEqual((await get(anna.db, 'userDirectory/boris@gmail.com')), { uid: 'boris' });
  assert.deepEqual(Object.keys(await get(anna.db, 'users/boris')).sort(), ['createdAt', 'displayName', 'invitedByUid', 'photoURL']);
  await assertFails(sdk.getDocs(sdk.collection(anna.db, 'userDirectory')));
  await assertFails(sdk.getDocs(sdk.collection(anna.db, 'users')));
  await assertFails(sdk.setDoc(sdk.doc(anna.db, 'userDirectory/victim@gmail.com'), { uid: 'anna' }));
  await assertFails(sdk.updateDoc(sdk.doc(anna.db, 'users/boris'), { displayName: 'forged' }));
  await assertFails(sdk.updateDoc(sdk.doc(anna.db, 'users/anna'), { email: 'leak@gmail.com' }));
  await assertFails(sdk.updateDoc(sdk.doc(anna.db, 'users/anna'), { invitedByUid: 'boris' }));
  const unverified = env.authenticatedContext('unverified', { email: 'unverified@gmail.com', email_verified: false, firebase: { sign_in_provider: 'google.com' } }).firestore();
  await assertFails(sdk.getDoc(sdk.doc(unverified, 'users/anna')));
  await assertFails(sdk.getDoc(sdk.doc(env.unauthenticatedContext().firestore(), 'users/anna')));
});

test('shares are directional, duplicate clicks are idempotent and revoke never changes reverse access', async () => {
  const a = client('a'); const b = client('b'); const c = client('c');
  await a.store.register(); await b.store.register(); await c.store.register();
  const results = await Promise.all([a.store.shareWithEmail(' B@GMAIL.COM '), a.store.shareWithEmail('b@gmail.com')]);
  assert(results.some((result) => result.includes('Доступ предоставлен')));
  const initial = await get(a.db, 'libraryShares/a__b');
  assert.equal(initial.active, true); assert.equal(await get(a.db, 'libraryShares/b__a'), null);
  await a.store.shareWithEmail('b@gmail.com');
  assert.deepEqual((await get(a.db, 'libraryShares/a__b')).sharedAt, initial.sharedAt);
  await b.store.setSharing('a', true);
  await a.store.setSharing('b', false);
  assert.equal((await get(b.db, 'libraryShares/b__a')).active, true);
  assert.equal((await get(b.db, 'libraryShares/a__b')).active, false);
  await a.store.setSharing('b', true);
  assert((await get(a.db, 'libraryShares/a__b')).sharedAt.toMillis() > initial.sharedAt.toMillis());
  await assertFails(sdk.updateDoc(sdk.doc(b.db, 'libraryShares/a__b'), { active: false, revokedAt: sdk.serverTimestamp() }));
  await assertFails(sdk.getDoc(sdk.doc(c.db, 'libraryShares/a__b')));
  await assertFails(sdk.getDocs(sdk.collection(c.db, 'libraryShares')));
  await assertSucceeds(sdk.getDocs(sdk.query(sdk.collection(a.db, 'libraryShares'), sdk.where('ownerUid', '==', 'a'))));
  await assertSucceeds(sdk.getDocs(sdk.query(sdk.collection(b.db, 'libraryShares'), sdk.where('viewerUid', '==', 'b'))));
  await assertFails(sdk.setDoc(sdk.doc(b.db, 'libraryShares/a__b'), { ...initial, sharedAt: sdk.serverTimestamp() }));
  await assertFails(sdk.setDoc(sdk.doc(a.db, 'libraryShares/a__a'), { ownerUid: 'a', viewerUid: 'a', active: true, sharedAt: sdk.serverTimestamp(), revokedAt: null }));
  await assert.rejects(a.store.shareWithEmail(' A@gmail.com '), /самим собой/);
  assert.throws(() => validateShareEmail('', 'a@gmail.com'));
});

test('private known email cannot be read by recipient or third party and never leaks through profiles', async () => {
  const a = client('a'); const b = client('b'); const c = client('c');
  for (const person of [a, b, c]) await person.store.register();
  await a.store.shareWithEmail('b@gmail.com');
  assert.equal((await get(a.db, 'users/a/knownContacts/b')).email, 'b@gmail.com');
  await assertFails(sdk.getDoc(sdk.doc(b.db, 'users/a/knownContacts/b')));
  await assertFails(sdk.getDocs(sdk.collection(c.db, 'users/a/knownContacts')));
  await assertFails(sdk.setDoc(sdk.doc(b.db, 'users/a/knownContacts/b'), { email: 'b@gmail.com' }));
  const shares = [await get(a.db, 'libraryShares/a__b')];
  assert.equal(friendsModel('b', shares, { a: { displayName: 'A', email: 'DO NOT LEAK' } })[0].email, '');
  assert.equal(friendsModel('a', shares, { b: { displayName: 'B' } }, { b: { email: 'b@gmail.com' } })[0].email, 'b@gmail.com');
});

test('pending invites claim atomically for own email; earliest inviter is permanent', async () => {
  const a = client('a'); const c = client('c');
  await a.store.register(); await c.store.register();
  assert.equal(await a.store.shareWithEmail(' New@Gmail.Com '), 'Приглашение сохранено.');
  assert((await a.store.shareWithEmail('new@gmail.com')).includes('уже сохранено'));
  await c.store.shareWithEmail('new@gmail.com');
  await assertFails(sdk.getDocs(sdk.collection(c.db, 'pendingInvites', 'new@gmail.com', 'shares')));
  await assertFails(sdk.getDoc(sdk.doc(c.db, 'pendingInvites/new@gmail.com/shares/a')));
  const n = client('new'); await n.store.register();
  assert.equal((await get(n.db, 'users/new')).invitedByUid, 'a');
  const share = await get(n.db, 'libraryShares/a__new');
  assert.equal(share.active, true);
  const pending = await get(a.db, 'pendingInvites/new@gmail.com/shares/a');
  assert.equal(pending.claimedUid, 'new'); assert(pending.claimedAt);
  await n.store.register();
  assert.deepEqual((await get(n.db, 'libraryShares/a__new')).sharedAt, share.sharedAt);
  await a.store.syncKnownContacts();
  assert.equal((await get(a.db, 'users/a/knownContacts/new')).email, 'new@gmail.com');
  assert(notificationsModel('new', [share])[0].unread);
  await a.store.setSharing('new', false);
  await n.store.register();
  assert.equal((await get(n.db, 'libraryShares/a__new')).active, false, 'consumed pending cannot restore revoked access');
  await assertFails(sdk.setDoc(sdk.doc(n.db, 'libraryShares/a__new'), { ...share, sharedAt: sdk.serverTimestamp() }));
  await assertFails(sdk.updateDoc(sdk.doc(n.db, 'pendingInvites/new@gmail.com/shares/a'), { claimedUid: null, claimedAt: null }));
  await assertFails(sdk.updateDoc(sdk.doc(a.db, 'pendingInvites/new@gmail.com'), { firstOwnerUid: 'c' }));
});

test('read markers are private, reference actual events and regrant becomes unread again', async () => {
  const a = client('a'); const b = client('b'); await a.store.register(); await b.store.register();
  await a.store.setSharing('b');
  let share = await get(b.db, 'libraryShares/a__b');
  let notifications = notificationsModel('b', [share]);
  await b.store.markSeen(notifications);
  const read = await get(b.db, 'users/b/incomingShareReads/a');
  assert.equal(notificationsModel('b', [share], { a: read })[0].unread, false);
  await assertFails(sdk.getDoc(sdk.doc(a.db, 'users/b/incomingShareReads/a')));
  await assertFails(sdk.setDoc(sdk.doc(a.db, 'users/b/incomingShareReads/a'), { seenSharedAt: share.sharedAt }));
  await assertFails(sdk.setDoc(sdk.doc(b.db, 'users/b/incomingShareReads/a'), { seenSharedAt: sdk.Timestamp.fromMillis(Date.now() + 999999) }));
  await a.store.setSharing('b', false); await a.store.setSharing('b', true);
  share = await get(b.db, 'libraryShares/a__b');
  assert(notificationsModel('b', [share], { a: read })[0].unread);
  await b.store.setSharing('a');
  assert(notificationsModel('b', [share, await get(b.db, 'libraryShares/b__a')])[0].mutual);
});

test('50 displayed notifications can be marked without exceeding security rule batch limits', async () => {
  const b = client('b'); await b.store.register();
  const shares = Array.from({ length: 51 }, (_, i) => ({ ownerUid: `owner${i}`, viewerUid: 'b', active: true, sharedAt: sdk.Timestamp.fromMillis(1000 + i), revokedAt: null }));
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore(); const batch = sdk.writeBatch(db);
    for (const share of shares) batch.set(sdk.doc(db, 'libraryShares', `${share.ownerUid}__b`), share);
    await batch.commit();
  });
  await b.store.markSeen(notificationsModel('b', shares));
  const markers = await sdk.getDocs(sdk.collection(b.db, 'users/b/incomingShareReads'));
  assert.equal(markers.size, 50);
  const reads = Object.fromEntries(markers.docs.map((doc) => [doc.id, doc.data()]));
  assert.equal(notificationsModel('b', shares, reads).filter((item) => item.unread).length, 1);
});

test('claim cannot be forged by another email or without a matching atomic share activation', async () => {
  const a = client('a'); const c = client('c'); await a.store.register(); await c.store.register();
  await a.store.shareWithEmail('future@gmail.com');
  await assertFails(sdk.updateDoc(sdk.doc(c.db, 'pendingInvites/future@gmail.com/shares/a'), { claimedUid: 'c', claimedAt: sdk.serverTimestamp() }));
  await assertFails(sdk.setDoc(sdk.doc(c.db, 'libraryShares/a__c'), { ownerUid: 'a', viewerUid: 'c', active: true, sharedAt: sdk.serverTimestamp(), revokedAt: null }));
  await assertFails(sdk.deleteDoc(sdk.doc(a.db, 'pendingInvites/future@gmail.com/shares/a')));
  await assertFails(sdk.getDocs(sdk.collectionGroup(c.db, 'shares')));
});

test('live subscriptions update friends and notifications after reciprocal share and revocation', async () => {
  const a = client('a'); const b = client('b'); await a.store.register(); await b.store.register();
  let state; let failure; const observed = [];
  const stop = b.store.subscribe((next) => { state = next; observed.push(next); }, (error) => { failure = error; });
  const until = async (predicate) => {
    for (let i = 0; i < 150 && !failure && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    if (failure) throw failure;
    assert(predicate());
  };
  try {
    await a.store.setSharing('b');
    await until(() => state?.friends.length === 1 && state.notifications.length === 1);
    assert.equal(state.friends[0].email, '');
    assert.equal(state.friends[0].inbound, true); assert.equal(state.friends[0].outbound, false);
    observed.length = 0;
    await assertFails(sdk.updateDoc(sdk.doc(b.db, 'libraryShares/a__b'), { active: false, revokedAt: sdk.serverTimestamp() }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert(observed.every((value) => value.friends.length === 1 && value.friends[0].inbound), 'denied local writes never become visible successful changes');
    await b.store.setSharing('a');
    await until(() => state?.friends[0]?.outbound && state.notifications[0]?.mutual);
    await b.store.markSeen(state.notifications);
    await until(() => !state?.notifications[0]?.unread);
    await a.store.setSharing('b', false);
    await until(() => state?.friends.length === 1 && !state.friends[0].inbound && state.notifications.length === 0);
    await b.store.setSharing('a', false);
    await until(() => state?.friends.length === 0);
  } finally { stop(); b.store.dispose(); }
});

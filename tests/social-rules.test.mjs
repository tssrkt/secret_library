import { readFile } from 'node:fs/promises';
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import * as sdk from 'firebase/firestore';
import { createSocialStore } from '../js/social-store.js';
import { friendsModel, validateShareEmail } from '../js/social-model.js';
import { createSharedLibraryStore } from '../js/shared-library.js';

let env;
const FOUNDER_UID = 'aA89pCYsKNbWWePmAveUVrG34F82';
const FOUNDER_EMAIL = 'founder@example.com';
const identity = (uid, email = `${uid}@gmail.com`) => ({ uid, email, emailVerified: true, displayName: uid, photoURL: '' });
const client = (uid, email) => {
  const user = identity(uid, email);
  const db = env.authenticatedContext(uid, { email: user.email, email_verified: true, firebase: { sign_in_provider: 'google.com' } }).firestore();
  return { db, user, store: createSocialStore({ db, sdk, user }) };
};
const get = async (db, path) => { const snap = await sdk.getDoc(sdk.doc(db, path)); return snap.exists() ? snap.data() : null; };
async function register(person) {
  if (person.user.uid === FOUNDER_UID) return person.store.register();
  const invitation = await get(person.db, `pendingInvites/${person.user.email.toLowerCase()}`);
  let automaticInviter = null;
  if (!invitation) {
    automaticInviter = client(FOUNDER_UID, FOUNDER_EMAIL);
    await automaticInviter.store.register();
    await automaticInviter.store.shareWithEmail(person.user.email);
  }
  const result = await person.store.register();
  if (automaticInviter) await automaticInviter.store.setSharing(person.user.uid, false);
  return result;
}
before(async () => { env = await initializeTestEnvironment({ projectId: 'demo-secret-library', firestore: { rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
beforeEach(async () => { await env.clearFirestore(); });
after(async () => { await env.cleanup(); });

test('shared catalogs enforce incoming access, exclude private folders and revoke old revisions', { skip: 'requires a live Google Drive OAuth session' }, async () => {
  const a = client('owner'); const b = client('viewer'); const c = client('other');
  for (const person of [a, b, c]) await register(person);
  const sharedA = createSharedLibraryStore({ db: a.db, sdk, user: a.user,
    downloadCover: async () => new Blob(['test-cover'], { type: 'image/webp' }) });
  const sharedB = createSharedLibraryStore({ db: b.db, sdk, user: b.user });
  const index = { version: 4, rootFolderId: 'root', folders: [
    { id: 'root', parentId: null, name: 'Root' }, { id: 'open', parentId: 'root', name: 'Open' },
    { id: 'closed', parentId: 'root', name: 'Private' }, { id: 'nested', parentId: 'closed', name: 'Nested' },
  ], books: [{ id: 'yes', parentId: 'open', title: 'Visible', coverFileId: 'private-appdata', metadataError: 'private diagnostic' },
    { id: 'no', parentId: 'nested', title: 'Secret' }, { id: 'loose', parentId: 'root', title: 'Root file' }] };
  const settings = { sharing: { excludedFolderIds: ['closed'] } };
  await sharedA.publish(index, settings);
  const first = await get(a.db, 'sharedLibraries/owner');
  await assertFails(sdk.getDoc(sdk.doc(b.db, 'sharedLibraries/owner')));
  await assertFails(sdk.getDoc(sdk.doc(b.db, 'sharedLibraries/owner/covers/yes')));
  await b.store.setSharing('owner', true);
  await assert.rejects(sharedB.load('owner'), /permission/i, 'outgoing share does not grant incoming access');
  await a.store.setSharing('viewer', true);
  const visible = await sharedB.load('owner');
  assert.deepEqual(visible.books.map((book) => book.id), ['yes', 'loose'], 'root-level books remain shareable outside excluded folders');
  await sdk.setDoc(sdk.doc(a.db, 'sharedLibraries/owner'), {
    revision: first.revision, signature: first.signature, chunkCount: first.chunkCount,
    coversSignature: first.coversSignature, pendingRevision: 'revision-pending', pendingChunkCount: 1,
  });
  await assertFails(sdk.getDoc(sdk.doc(b.db, 'sharedLibraries/owner/covers/yes')),
    'viewers cannot read covers while a new catalog revision is pending');
  await sdk.setDoc(sdk.doc(a.db, 'sharedLibraries/owner'), {
    revision: first.revision, signature: first.signature, chunkCount: first.chunkCount,
    coversSignature: first.coversSignature,
  });
  await assertSucceeds(sdk.getDoc(sdk.doc(b.db, 'sharedLibraries/owner/covers/yes')));
  await assertFails(sdk.getDoc(sdk.doc(c.db, 'sharedLibraries/owner/covers/yes')));
  assert.equal(await (await sharedB.loadCover('owner', 'yes')).text(), 'test-cover');
  assert(!JSON.stringify(visible).includes('private-appdata'));
  assert(!JSON.stringify(visible).includes('Secret'));
  await assertFails(sdk.getDocs(sdk.collection(c.db, 'sharedLibraries')));
  await assertFails(sdk.getDoc(sdk.doc(c.db, 'sharedLibraries/owner')));
  await assertFails(sdk.setDoc(sdk.doc(b.db, 'sharedLibraries/owner'), first));
  await assertFails(sdk.setDoc(sdk.doc(b.db, `sharedLibraries/owner/versions/${first.revision}/chunks/0`), { position: 0, json: '{}' }));
  await sharedA.publish(index, { sharing: { excludedFolderIds: ['open', 'closed'] } });
  assert.deepEqual((await sharedB.load('owner')).books.map((book) => book.id), ['loose']);
  assert.equal((await sdk.getDocFromServer(sdk.doc(b.db, 'sharedLibraries/owner/covers/yes'))).exists(), false,
    'cover documents for books excluded from the shared catalog are removed');
  await assertFails(sdk.getDocs(sdk.collection(b.db, `sharedLibraries/owner/versions/${first.revision}/chunks`)));
  await sharedA.unpublish();
  await assert.rejects(sharedB.load('owner'), /недоступна/, 'closing catalog before a settings update removes access');
  await sharedA.publish(index, { sharing: { excludedFolderIds: ['open', 'closed'] } });
  await a.store.setSharing('viewer', false);
  await assert.rejects(sharedB.load('owner'), /permission/i);
  await sharedA.unpublish();
  assert.equal(await get(a.db, 'sharedLibraries/owner'), null);
});

test('shared-library chunks and covers require a live manifest and bounded pending revision', async () => {
  const owner = client('orphan-owner'); const stranger = client('orphan-stranger');
  await register(owner); await register(stranger);
  const orphanChunk = sdk.doc(owner.db, 'sharedLibraries/orphan-owner/versions/ghost/chunks/0');
  const orphanCover = sdk.doc(owner.db, 'sharedLibraries/orphan-owner/covers/ghost-book');
  await assertFails(sdk.setDoc(orphanChunk, { position: 0, json: '{}' }));
  await assertFails(sdk.setDoc(orphanCover, { sourceKey: 'a'.repeat(64), mimeType: 'image/webp', data: 'dGlueQ==' }));

  await assertSucceeds(sdk.setDoc(sdk.doc(owner.db, 'sharedLibraries/orphan-owner'), {
    revision: '', signature: '', chunkCount: 0, pendingRevision: 'revision-1', pendingChunkCount: 1,
  }));
  await assertSucceeds(sdk.setDoc(sdk.doc(owner.db, 'sharedLibraries/orphan-owner/versions/revision-1/chunks/0'), {
    position: 0, json: '{}',
  }));
  await assertFails(sdk.setDoc(sdk.doc(owner.db, 'sharedLibraries/orphan-owner/versions/revision-1/chunks/1'), {
    position: 1, json: '{}',
  }));
  await assertSucceeds(sdk.setDoc(sdk.doc(owner.db, 'sharedLibraries/orphan-owner/covers/book-1'), {
    sourceKey: 'b'.repeat(64), mimeType: 'image/webp', data: 'dGlueQ==',
  }));
  await assertFails(sdk.setDoc(sdk.doc(stranger.db, 'sharedLibraries/orphan-owner/versions/revision-1/chunks/0'), {
    position: 0, json: '{}',
  }));

  await assertSucceeds(sdk.deleteDoc(sdk.doc(owner.db, 'sharedLibraries/orphan-owner')));
  await assertFails(sdk.setDoc(sdk.doc(owner.db, 'sharedLibraries/orphan-owner/versions/revision-2/chunks/0'), {
    position: 0, json: '{}',
  }));
  await assertFails(sdk.setDoc(sdk.doc(owner.db, 'sharedLibraries/orphan-owner/covers/book-2'), {
    sourceKey: 'c'.repeat(64), mimeType: 'image/webp', data: 'dGlueQ==',
  }));
});

test('ban marker revokes all client Firestore access without deleting the user profile', async () => {
  const person = client('banned-person');
  await register(person);
  await env.withSecurityRulesDisabled(async (context) => {
    await sdk.setDoc(sdk.doc(context.firestore(), 'bannedUsers/banned-person'), { uid: 'banned-person', reason: 'test' });
  });
  await assertFails(sdk.getDoc(sdk.doc(person.db, 'users/banned-person')));
  await assertFails(sdk.getDoc(sdk.doc(person.db, 'userDirectory/banned-person@gmail.com')));
  await assertFails(sdk.getDoc(sdk.doc(person.db, 'sharedLibraries/banned-person')));
  await env.withSecurityRulesDisabled(async (context) => {
    assert.equal((await sdk.getDoc(sdk.doc(context.firestore(), 'users/banned-person'))).exists(), true);
  });
});

test('verified Google registration with an invitation creates a safe profile and immutable attribution', async () => {
  const anna = client('anna'); const boris = client('boris');
  await register(anna); await register(boris);
  await assertFails(sdk.getDoc(sdk.doc(anna.db, 'userDirectory/boris@gmail.com')));
  assert.deepEqual(await get(boris.db, 'userDirectory/boris@gmail.com'), { uid: 'boris' });
  await assertSucceeds(sdk.getDoc(sdk.doc(boris.db, 'pendingInvites/boris@gmail.com')));
  await assertFails(sdk.getDoc(sdk.doc(anna.db, 'pendingInvites/boris@gmail.com')));
  assert.deepEqual(Object.keys(await get(anna.db, 'users/boris')).sort(), ['createdAt', 'displayName', 'invitedByUid', 'photoURL']);
  assert.equal((await get(anna.db, 'users/anna')).invitedByUid, FOUNDER_UID);
  assert.equal((await get(anna.db, 'users/boris')).invitedByUid, FOUNDER_UID);
  await assertFails(sdk.getDocs(sdk.collection(anna.db, 'userDirectory')));
  await assertFails(sdk.getDocs(sdk.collection(anna.db, 'users')));
  await assertFails(sdk.setDoc(sdk.doc(anna.db, 'userDirectory/victim@gmail.com'), { uid: 'anna' }));
  await assertFails(sdk.updateDoc(sdk.doc(anna.db, 'users/boris'), { displayName: 'forged' }));
  await assertFails(sdk.updateDoc(sdk.doc(anna.db, 'users/anna'), { email: 'leak@gmail.com' }));
  await assertFails(sdk.updateDoc(sdk.doc(anna.db, 'users/anna'), { invitedByUid: 'boris' }));
  await assertFails(sdk.updateDoc(sdk.doc(anna.db, 'users/anna'), { isAdmin: true }), 'ordinary users cannot mark themselves as administrators');
  const unverified = env.authenticatedContext('unverified', { email: 'unverified@gmail.com', email_verified: false, firebase: { sign_in_provider: 'google.com' } }).firestore();
  await assertFails(sdk.getDoc(sdk.doc(unverified, 'users/anna')));
  await assertFails(sdk.getDoc(sdk.doc(env.unauthenticatedContext().firestore(), 'users/anna')));
});

test('legacy profiles containing private fields cannot be read by other participants', async () => {
  const anna = client('legacy-reader'); const boris = client('legacy-profile');
  await register(anna); await register(boris);
  await env.withSecurityRulesDisabled(async (context) => {
    await sdk.setDoc(sdk.doc(context.firestore(), 'users/legacy-profile'), {
      displayName: 'Boris', photoURL: '', createdAt: sdk.Timestamp.now(),
      invitedByUid: FOUNDER_UID, email: 'private@example.com',
    });
  });
  await assertFails(sdk.getDoc(sdk.doc(anna.db, 'users/legacy-profile')),
    'legacy private fields must not be exposed through a full-document profile read');
  assert.equal((await get(boris.db, 'users/legacy-profile')).email, 'private@example.com',
    'the account owner retains access to their own profile');
});

test('legacy profile owner can safely remove private fields so friends regain profile access', async () => {
  const anna = client('legacy-reader'); const boris = client('legacy-profile');
  await register(anna); await register(boris);
  await env.withSecurityRulesDisabled(async (context) => {
    await sdk.setDoc(sdk.doc(context.firestore(), 'users/legacy-profile'), {
      displayName: 'Boris', photoURL: '', createdAt: sdk.Timestamp.fromMillis(1000),
      invitedByUid: FOUNDER_UID, isAdmin: false, email: 'private@example.com', legacySecret: 'must be removed',
    });
  });
  await assertFails(sdk.getDoc(sdk.doc(anna.db, 'users/legacy-profile')));
  await boris.store.register();
  const safe = await get(anna.db, 'users/legacy-profile');
  assert.equal(safe.displayName, boris.user.displayName);
  assert.equal(safe.invitedByUid, FOUNDER_UID);
  assert.equal(safe.isAdmin, false);
  assert.equal('email' in safe, false);
  assert.equal('legacySecret' in safe, false);
});
test('only the fixed founder may create a profile without an invitation', async () => {
  const founder = client(FOUNDER_UID, FOUNDER_EMAIL);
  await founder.store.register();
  assert.equal((await get(founder.db, `users/${FOUNDER_UID}`)).invitedByUid, null);

  const stranger = client('uninvited-person');
  await assert.rejects(stranger.store.register(), /только по приглашению/);
  await assertFails(sdk.getDoc(sdk.doc(stranger.db, `users/${FOUNDER_UID}`)), 'unregistered accounts cannot read other profiles');
  await assertFails(sdk.getDoc(sdk.doc(stranger.db, 'users/someone-else')));
  await assertSucceeds(sdk.getDoc(sdk.doc(stranger.db, 'users/uninvited-person')), 'an account may inspect its own missing profile during registration');
  await assertFails(sdk.setDoc(sdk.doc(stranger.db, 'users/uninvited-person'), {
    displayName: 'Uninvited', photoURL: '', createdAt: sdk.serverTimestamp(), invitedByUid: null,
  }));
  assert.equal(await get(stranger.db, 'users/uninvited-person'), null);

  await founder.store.shareWithEmail(stranger.user.email);
  await stranger.store.register();
  assert.equal((await get(stranger.db, 'users/uninvited-person')).invitedByUid, FOUNDER_UID);
});

test('existing profiles without a real inviter are blocked on every login', async () => {
  const founder = client(FOUNDER_UID, FOUNDER_EMAIL);
  await founder.store.register();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await sdk.setDoc(sdk.doc(db, 'users/no-inviter'), {
      displayName: 'No inviter', photoURL: '', createdAt: sdk.Timestamp.now(), invitedByUid: null,
    });
    await sdk.setDoc(sdk.doc(db, 'users/orphan-inviter'), {
      displayName: 'Orphan inviter', photoURL: '', createdAt: sdk.Timestamp.now(), invitedByUid: 'deleted-inviter',
    });
    await sdk.deleteDoc(sdk.doc(db, 'users/deleted-inviter'));
  });

  const noInviter = client('no-inviter');
  await assert.rejects(noInviter.store.register(), /пригласителя/i);
  await assertFails(sdk.getDoc(sdk.doc(noInviter.db, 'sharedLibraries/no-inviter')));

  const orphanInviter = client('orphan-inviter');
  await assert.rejects(orphanInviter.store.register(), /permission|пригласителя/i);
  await assertFails(sdk.getDoc(sdk.doc(orphanInviter.db, 'sharedLibraries/orphan-inviter')));
});

test('registered recipients are not claimed through legacy Firestore invitation subscriptions', async () => {
  const a = client('live-inviter'); const b = client('live-recipient');
  await register(a); await register(b);
  let state;
  const stop = b.store.subscribe((next) => { state = next; });
  try {
    await a.store.shareWithEmail(b.user.email);
    const invitation = await get(a.db, 'pendingInvites/' + b.user.email + '/shares/' + a.user.uid);
    assert.equal(invitation?.claimedUid, null, 'legacy Firestore invitations are not claimed by client listeners');
    assert.deepEqual(state?.invitations, [], 'invitation management data is provided by Apps Script and the Drive ledger');
    assert.equal('notifications' in (state || {}), false);
  } finally { stop(); b.store.dispose(); }
});

test('shares are directional, duplicate clicks are idempotent and revoke never changes reverse access', async () => {
  const a = client('a'); const b = client('b'); const c = client('c');
  await register(a); await register(b); await register(c);
  await a.store.setSharing('b', true, b.user.email);
  const initial = await get(a.db, 'libraryShares/a__b');
  assert.equal(initial.active, true); assert.equal(initial.ownerEmail, 'a@gmail.com');
  assert.equal(initial.viewerEmail, 'b@gmail.com');
  assert.equal(await get(a.db, 'libraryShares/b__a'), null);
  await a.store.setSharing('b', true);
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
  assert.throws(() => validateShareEmail('', 'a@gmail.com'));
});

test('private known email cannot be read by recipient or third party and never leaks through profiles', async () => {
  const a = client('a'); const b = client('b'); const c = client('c');
  for (const person of [a, b, c]) await register(person);
  await a.store.setSharing('b', true);
  await assertSucceeds(sdk.setDoc(sdk.doc(a.db, 'users/a/knownContacts/b'), { email: 'b@gmail.com' }));
  assert.equal((await get(a.db, 'users/a/knownContacts/b')).email, 'b@gmail.com');
  await assertFails(sdk.getDoc(sdk.doc(b.db, 'users/a/knownContacts/b')));
  await assertFails(sdk.getDocs(sdk.collection(c.db, 'users/a/knownContacts')));
  await assertFails(sdk.setDoc(sdk.doc(b.db, 'users/a/knownContacts/b'), { email: 'b@gmail.com' }));
  const shares = [await get(a.db, 'libraryShares/a__b')];
  assert.equal(friendsModel('b', shares, { a: { displayName: 'A', email: 'DO NOT LEAK' } })[0].email, 'a@gmail.com', 'recipient sees inviter email from their active share only');
  assert.equal(friendsModel('a', shares, { b: { displayName: 'B' } }, { b: { email: 'b@gmail.com' } })[0].email, 'b@gmail.com');
  const adminFriend = friendsModel('viewer', [{ ownerUid: 'admin', viewerUid: 'viewer', active: true }],
    { admin: { displayName: 'Library owner', isAdmin: true, email: 'private-admin@gmail.com' } },
    { admin: { email: 'private-admin@gmail.com' } })[0];
  assert.equal(adminFriend.isAdmin, true);
  assert.equal(adminFriend.email, '', 'admin email is suppressed even when stored in known contacts');
});

test('legacy active shares gain owner email without changing access', async () => {
  const a = client('legacy-owner'); const b = client('legacy-viewer');
  await register(a); await register(b);
  await env.withSecurityRulesDisabled(async (context) => {
    await sdk.setDoc(sdk.doc(context.firestore(), 'libraryShares/legacy-owner__legacy-viewer'), {
      ownerUid: 'legacy-owner', viewerUid: 'legacy-viewer', active: true, sharedAt: sdk.Timestamp.fromMillis(1000), revokedAt: null,
    });
  });
  await a.store.syncShareEmails();
  const share = await get(b.db, 'libraryShares/legacy-owner__legacy-viewer');
  assert.equal(share.ownerEmail, 'legacy-owner@gmail.com');
  assert.equal(friendsModel('legacy-viewer', [share], { 'legacy-owner': { displayName: 'Owner' } })[0].email, 'legacy-owner@gmail.com');
});

test('pending invites claim atomically for own email; earliest inviter is permanent', async () => {
  const a = client('a'); const c = client('c');
  await register(a); await register(c);
  assert.equal(await a.store.shareWithEmail(' New@Gmail.Com '), 'Приглашение сохранено.');
  assert((await a.store.shareWithEmail('new@gmail.com')).includes('уже сохранено'));
  await c.store.shareWithEmail('new@gmail.com');
  await assertFails(sdk.getDocs(sdk.collection(c.db, 'pendingInvites', 'new@gmail.com', 'shares')));
  await assertFails(sdk.getDoc(sdk.doc(c.db, 'pendingInvites/new@gmail.com/shares/a')));
  const n = client('new'); await register(n);
  assert.equal((await get(n.db, 'users/new')).invitedByUid, 'a');
  const share = await get(n.db, 'libraryShares/a__new');
  assert.equal(share.active, true);
  assert.equal(share.ownerEmail, 'a@gmail.com');
  const pending = await get(a.db, 'pendingInvites/new@gmail.com/shares/a');
  assert.equal(pending.claimedUid, 'new'); assert(pending.claimedAt);
  await register(n);
  assert.deepEqual((await get(n.db, 'libraryShares/a__new')).sharedAt, share.sharedAt);
  await a.store.syncKnownContacts();
  assert.equal((await get(a.db, 'users/a/knownContacts/new')).email, 'new@gmail.com');
  await a.store.setSharing('new', false);
  await register(n);
  assert.equal((await get(n.db, 'libraryShares/a__new')).active, false, 'consumed pending cannot restore revoked access');
  await assertFails(sdk.setDoc(sdk.doc(n.db, 'libraryShares/a__new'), { ...share, sharedAt: sdk.serverTimestamp() }));
  await assertFails(sdk.updateDoc(sdk.doc(n.db, 'pendingInvites/new@gmail.com/shares/a'), { claimedUid: null, claimedAt: null }));
  await assertFails(sdk.updateDoc(sdk.doc(a.db, 'pendingInvites/new@gmail.com'), { firstOwnerUid: 'c' }));
});

test('clients cannot forge server-only invitation email delivery status', async () => {
  const a = client('a'); await register(a);
  await a.store.shareWithEmail('future@gmail.com');
  await assertFails(sdk.updateDoc(sdk.doc(a.db, 'pendingInvites/future@gmail.com/shares/a'), {
    emailStatus: 'sent', emailSentAt: sdk.serverTimestamp(),
  }));
  await assertFails(sdk.setDoc(sdk.doc(a.db, 'pendingInvites/other@gmail.com/shares/a'), {
    ownerUid: 'a', inviteeEmail: 'other@gmail.com', active: true, createdAt: sdk.serverTimestamp(),
    claimedUid: null, claimedAt: null, emailStatus: 'sent',
  }));
});



test('claim cannot be forged by another email or without a matching atomic share activation', async () => {
  const a = client('a'); const c = client('c'); await register(a); await register(c);
  await a.store.shareWithEmail('future@gmail.com');
  await assertFails(sdk.updateDoc(sdk.doc(c.db, 'pendingInvites/future@gmail.com/shares/a'), { claimedUid: 'c', claimedAt: sdk.serverTimestamp() }));
  await assertFails(sdk.setDoc(sdk.doc(c.db, 'libraryShares/a__c'), { ownerUid: 'a', viewerUid: 'c', active: true, sharedAt: sdk.serverTimestamp(), revokedAt: null }));
  await assertFails(sdk.deleteDoc(sdk.doc(a.db, 'pendingInvites/future@gmail.com/shares/a')));
  await assertFails(sdk.getDocs(sdk.collectionGroup(c.db, 'shares')));
});

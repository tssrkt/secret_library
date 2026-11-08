import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocialStore } from '../js/social-store.js';

test('notification-related subscriptions do not read Firestore relationships, read markers or profiles', async () => {
  const uid = 'current-user';
  const profileReads = new Map();
  const watchers = [];
  const sdk = {
    doc: (_db, ...path) => ({ path: path.join('/') }),
    collection: (_db, ...path) => ({ path: path.join('/'), kind: 'collection' }),
    collectionGroup: (_db, name) => ({ path: name, kind: 'collectionGroup' }),
    where: (field, op, value) => ({ field, op, value }),
    query: (target, ...filters) => ({ ...target, filters }),
    getDoc: async (reference) => {
      profileReads.set(reference.path, (profileReads.get(reference.path) || 0) + 1);
      if (reference.path === 'users/legacy-friend') {
        const error = new Error('Missing or insufficient permissions.');
        error.code = 'permission-denied';
        throw error;
      }
      return { exists: () => false, data: () => undefined };
    },
    getDocs: async () => ({ docs: [] }),
    runTransaction: async () => {},
    serverTimestamp: () => 1,
    onSnapshot: (target, options, next, error) => {
      if (typeof options === 'function') { error = next; next = options; }
      const filters = target.filters || [];
      let docs = [];
      if (target.path === 'libraryShares' && filters.some((f) => f.field === 'viewerUid' && f.value === uid)) docs = [{ data: () => share }];
      watchers.push({ target, filters, next, docs });
      next({ metadata: { hasPendingWrites: false }, docs });
      return () => {};
    },
    writeBatch: () => ({ set() {}, commit: async () => {} }),
  };
  const store = createSocialStore({ db: {}, sdk, user: { uid, email: 'current@example.com', emailVerified: true } });
  let latest;
  let error;
  store.subscribe((snapshot) => { latest = snapshot; }, (value) => { error = value; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(error, undefined, 'invitation subscription succeeds');
  assert.deepEqual(latest.invitations, [], 'store emits only invitation data to the social runtime');
  assert.equal(profileReads.size, 0, 'notification labels never trigger profile reads');
  assert.equal(watchers.some(({ target }) => target.path === 'libraryShares'), false, 'no relationship subscription for notifications');
  assert.equal(watchers.some(({ target }) => target.path === 'users/current-user/incomingShareReads'), false, 'no read-marker subscription');
});

test('share email migration processes records concurrently in bounded batches', async () => {
  const shares = Array.from({ length: 25 }, (_, index) => ({
    ref: { path: 'libraryShares/share-' + index },
    data: () => ({ ownerUid: 'current-user', viewerUid: 'viewer-' + index, active: true })
  }));
  let active = 0;
  let maxActive = 0;
  let updated = 0;
  const sdk = {
    doc: (_db, ...path) => ({ path: path.join('/') }),
    collection: (_db, ...path) => ({ path: path.join('/'), kind: 'collection' }),
    where: (field, op, value) => ({ field, op, value }),
    query: (target, ...filters) => ({ ...target, filters }),
    getDocs: async () => ({ docs: shares }),
    runTransaction: async (_db, callback) => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return await callback({
          get: async () => ({ exists: () => true, data: () => ({ active: true }) }),
          update: () => { updated++; }
        });
      } finally { active--; }
    },
    serverTimestamp: () => 1,
  };
  const store = createSocialStore({ db: {}, sdk, user: { uid: 'current-user', email: 'current@example.com', emailVerified: true } });
  await store.syncShareEmails();
  assert.equal(updated, 25, 'every active legacy share receives the missing owner email');
  assert.ok(maxActive > 1, 'independent migrations overlap instead of running sequentially');
  assert.ok(maxActive <= 10, 'concurrency is capped to avoid flooding Firestore');
});


test('loadFriends builds registered friends from active one-way and mutual library shares', async () => {
  const uid = 'current-user';
  const shares = [
    { ownerUid: uid, viewerUid: 'outgoing-friend', ownerEmail: 'current@example.com', active: true },
    { ownerUid: 'incoming-friend', viewerUid: uid, ownerEmail: 'incoming@example.com', active: true },
    { ownerUid: uid, viewerUid: 'revoked-friend', active: false },
    { ownerUid: 'incoming-friend', viewerUid: uid, ownerEmail: 'incoming@example.com', active: true },
  ];
  const sdk = {
    doc: (_db, ...path) => ({ path: path.join('/') }),
    collection: (_db, ...path) => ({ path: path.join('/'), kind: 'collection' }),
    collectionGroup: (_db, name) => ({ path: name, kind: 'collectionGroup' }),
    where: (field, op, value) => ({ field, op, value }),
    query: (target, ...filters) => ({ ...target, filters }),
    getDocs: async (target) => {
      if (target.path === 'users/current-user/knownContacts') return { docs: [{ id: 'outgoing-friend', data: () => ({ email: 'outgoing@example.com' }) }] };
      const filter = target.filters?.[0];
      return { docs: shares.filter((share) => share[filter.field] === filter.value).map((share) => ({ data: () => share })) };
    },
    getDoc: async (reference) => {
      const profiles = {
        'users/outgoing-friend': { displayName: 'Outgoing Friend' },
        'users/incoming-friend': { displayName: 'Incoming Friend' },
      };
      const value = profiles[reference.path];
      return { exists: () => Boolean(value), data: () => value };
    },
    runTransaction: async () => {},
    serverTimestamp: () => 1,
  };
  const store = createSocialStore({ db: {}, sdk, user: { uid, email: 'current@example.com', emailVerified: true } });
  const friends = await store.loadFriends();
  assert.deepEqual(friends.map(({ uid: friendUid, inbound, outbound }) => ({ uid: friendUid, inbound, outbound })), [
    { uid: 'incoming-friend', inbound: true, outbound: false },
    { uid: 'outgoing-friend', inbound: false, outbound: true },
  ]);
  assert.equal(friends.find((friend) => friend.uid === 'incoming-friend').email, 'incoming@example.com');
  assert.equal(friends.find((friend) => friend.uid === 'outgoing-friend').email, 'outgoing@example.com');
});

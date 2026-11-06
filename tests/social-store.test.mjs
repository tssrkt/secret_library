import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocialStore } from '../js/social-store.js';

test('a legacy private profile cannot hide an otherwise valid friend relationship', async () => {
  const uid = 'current-user';
  const share = { ownerUid: 'legacy-friend', viewerUid: uid, active: true, sharedAt: 1 };
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
  assert.equal(error, undefined, 'profile-only permission denial is handled locally');
  assert.equal(latest.friends.length, 1, 'friend relationship remains visible');
  assert.equal(latest.friends[0].uid, 'legacy-friend');
  assert.equal(latest.friends[0].displayName, 'Пользователь', 'private legacy name is not leaked');
  assert.equal(profileReads.get('users/legacy-friend'), 1);

  const incoming = watchers.find(({ target, filters }) => target.path === 'libraryShares' &&
    filters.some((filter) => filter.field === 'viewerUid' && filter.value === uid));
  incoming.next({ metadata: { hasPendingWrites: false }, docs: incoming.docs });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(profileReads.get('users/legacy-friend'), 1, 'repeated snapshots reuse the briefly cached denied profile');
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

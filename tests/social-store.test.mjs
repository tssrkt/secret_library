import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocialStore } from '../js/social-store.js';

test('a legacy private profile cannot hide an otherwise valid friend relationship', async () => {
  const uid = 'current-user';
  const share = { ownerUid: 'legacy-friend', viewerUid: uid, active: true, sharedAt: 1 };
  const sdk = {
    doc: (_db, ...path) => ({ path: path.join('/') }),
    collection: (_db, ...path) => ({ path: path.join('/'), kind: 'collection' }),
    collectionGroup: (_db, name) => ({ path: name, kind: 'collectionGroup' }),
    where: (field, op, value) => ({ field, op, value }),
    query: (target, ...filters) => ({ ...target, filters }),
    getDoc: async (reference) => {
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
});
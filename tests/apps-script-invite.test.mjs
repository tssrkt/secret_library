import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const source = await readFile(new URL('../apps-script-invite/Code.gs', import.meta.url), 'utf8');
const adminClientSource = await readFile(new URL('../js/admin.js', import.meta.url), 'utf8');

function harness({ authUser, pendingFields, pendingStatus = 200, profileStatus = 200, blockedEmailUid = null, blockedEmail = false, blockedEmailByField = false, blockOnSecondCheck = false } = {}) {
  const properties = new Map();
  const cacheEntries = new Map();
  const sent = [];
  const calls = [];
  let uuidCounter = 0;
  const user = authUser || {
    localId: 'owner-uid', email: 'owner@gmail.com', emailVerified: true,
    displayName: 'Ада', providerUserInfo: [{ providerId: 'google.com' }]
  };
  const pending = pendingFields || {
    ownerUid: { stringValue: 'owner-uid' },
    inviteeEmail: { stringValue: 'friend@gmail.com' },
    active: { booleanValue: true },
    claimedUid: { nullValue: null }
  };
  const context = {
    console: { error() {} },
    CacheService: {
      getScriptCache() {
        return {
          get(key) { return cacheEntries.has(key) ? cacheEntries.get(key) : null; },
          put(key, value, _ttl) { cacheEntries.set(key, value); },
          remove(key) { cacheEntries.delete(key); }
        };
      }
    },
    Date, JSON, Object, Array, String, Number, Math, RegExp, Error, isFinite,
    encodeURIComponent,
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createHtmlOutput(content) {
        const renderedContent = content.replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
        return { content: renderedContent, setXFrameOptionsMode() { return this; } };
      }
    },
    UrlFetchApp: {
      fetch(url, options = {}) {
        calls.push({ url, options });
        if (url.includes('accounts:lookup')) return response(200, { users: [user] });
        if (url.includes('/users/')) {
          return response(profileStatus, { fields: { displayName: { stringValue: 'Ада' } } });
        }
        if (url.includes('/pendingInvites/')) return response(pendingStatus, { fields: pending });
        throw new Error('Unexpected URL');
      }
    },
    MailApp: {
      getRemainingDailyQuota() { return 100; },
      sendEmail(message) { sent.push(message); }
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) { return properties.get(key) || null; },
          getProperties() { return Object.fromEntries(properties); },
          setProperty(key, value) { properties.set(key, value); },
          deleteProperty(key) { properties.delete(key); }
        };
      }
    },
    LockService: {
      getScriptLock() { return { waitLock() {}, releaseLock() {} }; }
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest(_algorithm, value) { return [...createHash('sha256').update(value).digest()]; },
      getUuid() { return `reservation-${++uuidCounter}`; },
      base64EncodeWebSafe(value) { return Buffer.from(value).toString('base64url'); },
      base64DecodeWebSafe(value) { return [...Buffer.from(value, 'base64url')]; },
      newBlob(bytes) { return { getDataAsString() { return Buffer.from(bytes).toString('utf8'); } }; }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.realFsGet = context.fsGet;
  context.fsGet = (path) => {
    if (blockedEmailUid && path === 'userDirectory/friend%40gmail.com') return { id: 'friend%40gmail.com', uid: blockedEmailUid };
    if (blockedEmail && path === 'bannedUsers/blocked-uid') return { id: 'blocked-uid', uid: 'blocked-uid' };
    if ((blockedEmail || blockOnSecondCheck) && path === 'pendingInvites/friend%40gmail.com/shares/owner-uid') return { ownerUid: 'owner-uid', active: true, claimedUid: null };
    return null;
  };
  let blockedEmailQueryCount = 0;
  context.fsFetch = (_url, _method, body) => {
    if (body?.structuredQuery?.from?.[0]?.collectionId === 'shares') return { code: 200, text: JSON.stringify([]) };
    if (body?.structuredQuery?.from?.[0]?.collectionId === 'bannedUsers') {
      blockedEmailQueryCount++;
      const blocked = blockedEmailByField || (blockOnSecondCheck && blockedEmailQueryCount >= 2);
      const rows = blocked ? [{ document: { name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/bannedUsers/legacy-uid', fields: { email: { stringValue: 'friend@gmail.com' } } } }] : [];
      return { code: 200, text: JSON.stringify(rows) };
    }
    throw new Error('Unexpected Firestore query');
  };
  context.realFsListInviteShares = context.fsListInviteShares;
  context.fsListInviteShares = () => [];
  const payload = {
    requestId: 'request_1234567890',
    email: 'friend@gmail.com',
    idToken: 'firebase-id-token-'.padEnd(500, 'x')
  };
  const invoke = (overrides = {}) => context.doPost({
    parameter: { payload: JSON.stringify({ ...payload, ...overrides }) }
  });
  return { invoke, sent, calls, properties, payload, context };
}

function response(status, body) {
  return {
    getResponseCode() { return status; },
    getContentText() { return JSON.stringify(body); }
  };
}

test('admin document reads use a concurrent Firestore batch and preserve missing records', () => {
  const app = harness();
  const requests = [];
  app.context.ScriptApp = { getOAuthToken: () => 'test-token' };
  app.context.UrlFetchApp.fetchAll = batch => {
    requests.push(...batch);
    return batch.map((request, index) => ({
      getResponseCode: () => index === 1 ? 404 : 200,
      getContentText: () => JSON.stringify(index === 0
        ? { name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/users/inviter-uid', fields: { displayName: { stringValue: 'Inviter' } } }
        : {})
    }));
  };
  const rows = app.context.fsGetMany(['users/inviter-uid', 'bannedUsers/target-uid']);
  assert.equal(requests.length, 2);
  assert.equal(requests.every(request => request.headers.Authorization === 'Bearer test-token'), true);
  assert.equal(rows[0].displayName, 'Inviter');
  assert.equal(rows[0].id, 'inviter-uid');
  assert.equal(rows[1], null);
});

test('invitation status checks use Script Properties and skip the owner email', () => {
  const app = harness();
  app.invoke();
  const before = app.calls.filter(call => call.url.includes('/pendingInvites/')).length;
  const result = app.invoke({ action: 'getInvitationStatuses', emails: ['friend@gmail.com', 'owner@gmail.com', 'other@gmail.com'] });
  assert.equal(app.calls.filter(call => call.url.includes('/pendingInvites/')).length, before);
  assert.match(result.content, /"friend@gmail.com":\{"lastSentAt":\d+,"cooldownUntil":\d+,"invitationStatus":"pending"/);
  assert.doesNotMatch(result.content, /owner@gmail.com/);
});

test('invitation status metadata includes active administrator UIDs and excludes inactive admins', () => {
  const app = harness();
  app.context.fsList = path => path === 'adminUsers' ? [
    { id: 'admin-one', uid: 'admin-one', active: true },
    { id: 'admin-two', uid: 'admin-two', active: false }
  ] : [];
  const result = app.invoke({ action: 'getInvitationStatuses', emails: [] });
  assert.match(result.content, /"adminUids":\["admin-one"\]/);
  assert.match(result.content, /"limit":20/);
  assert.match(result.content, /"used":0/);
});

test('verifyFirebaseUser caches a successful lookup for the same token', () => {
  const app = harness();
  app.context.verifyFirebaseUser(app.payload.idToken);
  app.context.verifyFirebaseUser(app.payload.idToken);
  assert.equal(app.calls.filter(call => call.url.includes('accounts:lookup')).length, 1);
});

test('admin startup uses bounded summary and paginated collection APIs, not the unbounded dashboard', () => {
  assert.match(adminClientSource, /call\('getAdminDashboardSummary'\)/);
  assert.match(adminClientSource, /call\('getAdminCollectionPage'\)/);
  assert.doesNotMatch(adminClientSource, /call\('getAdminDashboard'\)/);
});

test('admin summary batches independent Firestore aggregation counts', () => {
  const app = harness();
  let requests = [];
  app.context.ScriptApp = { getOAuthToken: () => 'test-token' };
  app.context.UrlFetchApp.fetchAll = (batch) => {
    requests = batch;
    return batch.map((_, index) => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify([{ result: { aggregateFields: { total: { integerValue: String((index + 1) * 10) } } } }])
    }));
  };
  const counts = app.context.fsCountMany([
    { key: 'users', collectionId: 'users' },
    { key: 'shares', collectionId: 'libraryShares', filter: { fieldPath: 'active', op: 'EQUAL', value: { booleanValue: true } } },
    { key: 'admins', collectionId: 'adminUsers' }
  ]);
  assert.equal(requests.length, 3);
  assert.equal(counts.users, 10);
  assert.equal(counts.shares, 20);
  assert.equal(counts.admins, 30);
  assert.ok(requests.every(request => request.method === 'post' && request.headers.Authorization.startsWith('Bearer ')));
});

test('admin page requests reuse profiles already loaded by the client', () => {
  assert.match(adminClientSource, /function knownAdminProfileUids\(\)/);
  assert.match(adminClientSource, /adminPageState\.users\?\.pages/);
  assert.match(adminClientSource, /knownProfileUids = knownAdminProfileUids\(\)/);
  assert.match(adminClientSource, /getAdminCollectionPage'\)\(\{ section: key, cursor, knownProfileUids \}\)/);
  const app = harness();
  let request;
  app.context.fsFetch = (url, method, body) => {
    request = { url, method, body };
    return { code: 200, text: JSON.stringify([{ document: {
      name: 'projects/project/databases/(default)/documents/users/viewer-uid',
      fields: { displayName: { stringValue: 'Reader' } }
    } }]) };
  };
  const profiles = app.context.fsQueryUserProfiles(['owner-uid', 'viewer-uid'], ['owner-uid']);
  const values = request.body.structuredQuery.where.fieldFilter.value.arrayValue.values;
  assert.equal(values.length, 1);
  assert.equal(values[0].referenceValue, 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/users/viewer-uid');
  assert.equal(Object.hasOwn(profiles, 'owner-uid'), false);
  assert.equal(profiles['viewer-uid'].displayName, 'Reader');
});

test('admin card batches related document reads and collection queries in one fetchAll', () => {
  const app = harness();
  app.context.ScriptApp = { getOAuthToken: () => 'test-token' };
  let batches = 0;
  let requests = [];
  app.context.UrlFetchApp.fetchAll = batch => {
    batches++;
    requests = batch;
    return batch.map((request, index) => {
      if (request.method === 'get') {
        const path = request.url.split('/documents/')[1];
        return response(200, {
          name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/' + path,
          fields: { displayName: { stringValue: 'Record ' + index } }
        });
      }
      const query = JSON.parse(request.payload).structuredQuery;
      const collection = query.from[0].collectionId;
      const name = collection === 'userDirectory'
        ? 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/userDirectory/target%40example.com'
        : 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/' + collection + '/row-' + index;
      return response(200, [{ document: { name, fields: { uid: { stringValue: 'target-uid' } } } }]);
    });
  };
  const result = app.context.fsGetManyAndQueryGroupByFieldMany(
    ['users/inviter-uid', 'adminUsers/target-uid'],
    [
      { collectionId: 'userDirectory', field: 'uid', value: 'target-uid', limit: 1 },
      { collectionId: 'libraryShares', field: 'ownerUid', value: 'target-uid', limit: 100 }
    ]
  );
  assert.equal(batches, 1);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map(request => request.method), ['get', 'get', 'post', 'post']);
  assert.ok(requests.every(request => request.headers.Authorization === 'Bearer test-token'));
  assert.equal(result.records[0].id, 'inviter-uid');
  assert.equal(result.records[1].id, 'target-uid');
  assert.equal(result.groups[0][0].id, 'target%40example.com');
  assert.equal(result.groups[1][0].id, 'row-3');
});

test('admin history batches independent collection-group queries concurrently', () => {
  const app = harness();
  let requests = [];
  app.context.ScriptApp = { getOAuthToken: () => 'test-token' };
  app.context.UrlFetchApp.fetchAll = batch => {
    requests = batch;
    return batch.map((request, index) => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify([{ document: {
        name: `projects/project/databases/(default)/documents/${JSON.parse(request.payload).structuredQuery.from[0].collectionId}/record-${index}`,
        fields: { action: { stringValue: `result-${index}` } }
      } }])
    }));
  };
  const rows = app.context.fsQueryGroupByFieldMany([
    { collectionId: 'shares', field: 'ownerUid', value: 'user-1', limit: 100, nestedOnly: false },
    { collectionId: 'adminEvents', field: 'targetUid', value: 'user-1', limit: 100 },
    { collectionId: 'libraryShares', field: 'viewerUid', value: 'user-1', limit: 100 }
  ]);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.headers.Authorization === 'Bearer test-token'));
  assert.equal(rows[0][0].action, 'result-0');
  assert.equal(rows[2][0].id, 'record-2');
});

test('admin user flags fetch banned and admin records concurrently', () => {
  const app = harness();
  let requests = [];
  app.context.ScriptApp = { getOAuthToken: () => 'test-token' };
  app.context.UrlFetchApp.fetchAll = batch => {
    requests = batch;
    return batch.map(request => {
      const query = JSON.parse(request.payload).structuredQuery;
      const collectionId = query.from[0].collectionId;
      const document = {
        name: `projects/project/databases/(default)/documents/${collectionId}/${collectionId === 'userDirectory' ? 'reader@example.com' : collectionId === 'adminUsers' ? 'legacy-admin-record' : 'user-1'}`,
        fields: collectionId === 'userDirectory' || collectionId === 'adminUsers' ? { uid: { stringValue: 'user-1' } } : {}
      };
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify([{ document }])
      };
    });
  };
  const flags = app.context.fsGetAdminUserFlags(['user-1', 'user-2']);
  assert.equal(requests.length, 3);
  assert.equal(JSON.parse(requests[1].payload).structuredQuery.where.fieldFilter.field.fieldPath, 'uid');
  assert.equal(flags.banned.has('user-1'), true);
  assert.equal(flags.admins.has('user-1'), true);
  assert.equal(flags.emailByUid.get('user-1'), 'reader@example.com');
  assert.equal(flags.banned.has('user-2'), false);
});

test('admin user flags and related profiles share one concurrent Firestore batch', () => {
  const app = harness();
  let requests = [];
  app.context.ScriptApp = { getOAuthToken: () => 'test-token' };
  app.context.UrlFetchApp.fetchAll = batch => {
    requests = batch;
    return batch.map(request => {
      const query = JSON.parse(request.payload).structuredQuery;
      const collectionId = query.from[0].collectionId;
      const documentId = collectionId === 'users' ? 'inviter-1' : collectionId === 'userDirectory' ? 'reader@example.com' : 'user-1';
      const fields = collectionId === 'users' ? { displayName: { stringValue: 'Inviter' } } : collectionId === 'userDirectory' ? { uid: { stringValue: 'user-1' } } : {};
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify([{ document: {
        name: `projects/project/databases/(default)/documents/${collectionId}/${documentId}`, fields
      } }]) };
    });
  };
  const result = app.context.fsGetAdminUserFlags(['user-1'], ['inviter-1'], []);
  assert.equal(requests.length, 4);
  assert.equal(JSON.stringify(requests.map(request => JSON.parse(request.payload).structuredQuery.from[0].collectionId)), JSON.stringify(['bannedUsers', 'adminUsers', 'userDirectory', 'users']));
  assert.equal(result.emailByUid.get('user-1'), 'reader@example.com');
  assert.equal(result.profiles['inviter-1'].displayName, 'Inviter');
});

test('admin related profiles fetch multiple Firestore batches concurrently', () => {
  const app = harness();
  let requests = [];
  app.context.ScriptApp = { getOAuthToken: () => 'test-token' };
  app.context.UrlFetchApp.fetchAll = batch => {
    requests = batch;
    return batch.map(request => {
      const payload = JSON.parse(request.payload);
      const refs = payload.structuredQuery.where.fieldFilter.value.arrayValue.values;
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify(refs.map(ref => ({ document: {
          name: ref.referenceValue,
          fields: { displayName: { stringValue: ref.referenceValue.split('/').pop() } }
        } })))
      };
    });
  };
  const uids = Array.from({ length: 61 }, (_, index) => `profile-${index}`);
  const profiles = app.context.fsQueryUserProfiles(uids);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.method === 'post' && request.headers.Authorization === 'Bearer test-token'));
  assert.equal(Object.keys(profiles).length, 61);
  assert.equal(profiles['profile-60'].displayName, 'profile-60');
});

test('relationship root page batches users and shared-library reads in one Firestore round trip', () => {
  const app = harness();
  const requests = [];
  app.context.ScriptApp = { getOAuthToken: () => 'test-token' };
  app.context.UrlFetchApp.fetchAll = batch => {
    requests.push(...batch);
    return batch.map((request, index) => {
      const query = JSON.parse(request.payload).structuredQuery;
      const collection = query.from[0].collectionId;
      const id = collection === 'users' ? 'user-1' : 'share-1';
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify([{ document: {
          name: `projects/project/databases/(default)/documents/${collection}/${id}`,
          fields: collection === 'libraryShares' ? { ownerUid: { stringValue: 'owner-uid' } } : { displayName: { stringValue: 'Reader' } }
        } }])
      };
    });
  };
  const pages = app.context.fsQueryPageMany([
    { path: 'users', pageSize: 25, cursor: '' },
    { path: 'libraryShares', pageSize: 100, cursor: '' }
  ]);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.method === 'post' && request.headers.Authorization === 'Bearer test-token'));
  assert.deepEqual(pages.map(page => page.items[0].id), ['user-1', 'share-1']);
  assert.equal(pages[0].items[0].displayName, 'Reader');
});

test('relationship pages fetch shared-library records only on the initial request', () => {
  assert.match(adminClientSource, /relationshipSharesCache = null/);
  assert.match(adminClientSource, /includeShares: !Array\.isArray\(relationshipSharesCache\)/);
  assert.match(adminClientSource, /relationshipSharesCache = null;invalidateAdminPages\('shares', 'relationships'\)/);
  const app = harness();
  let shareReads = 0;
  app.context.requireAdminApi = () => ({ uid: 'root', admin: { role: 'superadmin' } });
  app.context.fsQueryPageMany = specs => {
    if (specs.some(spec => spec.path === 'libraryShares')) shareReads++;
    return specs.map(spec => spec.path === 'libraryShares'
      ? { items: [{ id: 'share-1', ownerUid: 'owner-uid', viewerUid: 'viewer-uid', active: true }] }
      : { items: [{ id: 'user-1', displayName: 'Reader' }], nextCursor: '', hasMore: false });
  };
  app.context.fsQueryUserProfiles = () => ({});
  const actor = { uid: 'root', admin: { role: 'superadmin' } };
  const first = app.context.getAdminRelationshipRootsApi(actor, { includeShares: true });
  const next = app.context.getAdminRelationshipRootsApi(actor, { cursor: 'next', includeShares: false });
  assert.equal(shareReads, 1);
  assert.equal(first.shares.length, 1);
  assert.equal(Object.hasOwn(next, 'shares'), false);
});

test('admin iframe accepts only matching request IDs from allowlisted Apps Script origins', () => {
  assert.match(adminClientSource, /event\.origin === 'https:\/\/script\.google\.com'/);
  assert.match(adminClientSource, /\[a-z0-9-\]\+-script\\\.googleusercontent\\\.com/);
  assert.match(adminClientSource, /event\.data\?\.requestId !== requestId/);
  assert.match(adminClientSource, /event\.data\?\.type !== 'secret-library-admin-result'/);
});
test('admin event history uses a bounded server-side Firestore page', () => {
  const app = harness();
  let requestedUrl = '';
  app.context.fsFetch = (url, method) => {
    requestedUrl = url;
    assert.equal(method, 'get');
    return { code: 200, text: JSON.stringify({ documents: [{
      name: 'projects/project/databases/(default)/documents/adminEvents/event-1',
      fields: { action: { stringValue: 'test' } }
    }] }) };
  };
  const events = app.context.fsListPage('adminEvents', 100, 'createdAt desc');
  assert.match(requestedUrl, /pageSize=100/);
  assert.match(requestedUrl, /orderBy=createdAt%20desc/);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'event-1');
});

test('invitation dashboard reads only nested shares under pendingInvites', () => {
  const app = harness();
  app.context.fsListInviteShares = app.context.realFsListInviteShares;
  const requests = [];
  app.context.fsFetch = (url, method, body) => {
    requests.push({ url, method, body });
    if (url.includes('/pendingInvites?')) return {
      code: 200,
      text: JSON.stringify({ documents: [{
        name: 'projects/project/databases/(default)/documents/pendingInvites/friend@gmail.com', fields: {}
      }] })
    };
    if (url.includes('/pendingInvites/friend%40gmail.com/shares?')) return {
      code: 200,
      text: JSON.stringify({ documents: [{
        name: 'projects/project/databases/(default)/documents/pendingInvites/friend@gmail.com/shares/owner-uid',
        fields: { ownerUid: { stringValue: 'owner-uid' }, claimedUid: { nullValue: null } }
      }] })
    };
    throw new Error('Unexpected Firestore request: ' + url);
  };
  const invites = app.context.fsListInviteShares();
  assert.equal(requests.length, 2);
  assert.ok(requests.every(item => item.method === 'get'));
  assert.ok(requests.every(item => !item.url.endsWith('documents:runQuery')));
  assert.equal(invites.length, 1);
  assert.equal(invites[0].email, 'friend@gmail.com');
  assert.equal(invites[0].id, 'owner-uid');
  assert.equal(invites[0].ownerUid, 'owner-uid');
});

test('admin participant flags are cached briefly and mutations invalidate the participant entry', () => {
  const app = harness();
  let requests = 0;
  app.context.ScriptApp = { getOAuthToken: () => 'test-token' };
  app.context.UrlFetchApp.fetchAll = batch => {
    requests += batch.length;
    return batch.map(() => ({ getResponseCode: () => 200, getContentText: () => '[]' }));
  };
  const uid = 'participant_123';
  const first = app.context.fsGetAdminUserFlags([uid], [], []);
  assert.equal(first.banned.has(uid), false);
  assert.equal(first.admins.has(uid), false);
  assert.equal(requests, 3, 'cold cache should query banned, admin and directory collections');
  app.context.fsGetAdminUserFlags([uid], [], []);
  assert.equal(requests, 3, 'warm cache should skip all three flag queries');
  app.context.fsInvalidateAdminUserFlags(uid);
  app.context.fsGetAdminUserFlags([uid], [], []);
  assert.equal(requests, 6, 'invalidating a participant should force fresh flag queries');
});

test('admin aggregate counts use a 60-second cache and mutation invalidation forces a fresh read', () => {
  assert.match(source, /const ADMIN_COUNT_CACHE_TTL_SECONDS = 60/);
  assert.match(source, /cache\.put\('admin_count_v1_' \+ key, String\(value\), ADMIN_COUNT_CACHE_TTL_SECONDS\)/);
  assert.match(source, /cache\.put\('admin_count_v1_' \+ specs\[index\]\.key, String\(counts\[specs\[index\]\.key\]\), ADMIN_COUNT_CACHE_TTL_SECONDS\)/);
  const app = harness();
  let requests = 0;
  app.context.ScriptApp = { getOAuthToken: () => 'test-token' };
  app.context.UrlFetchApp.fetchAll = batch => {
    requests += batch.length;
    return batch.map((_, index) => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify([{ result: { aggregateFields: { total: { integerValue: String(10 + index) } } } }])
    }));
  };
  app.context.fsCount = collectionId => { requests += 1; return collectionId === 'users' ? 10 : 11; };
  const specs = [
    { key: 'users', collectionId: 'users' },
    { key: 'admins', collectionId: 'adminUsers' }
  ];
  assert.deepEqual({ ...app.context.fsCountMany(specs, false) }, { users: 10, admins: 11 });
  assert.equal(requests, 2);
  assert.deepEqual({ ...app.context.fsCountMany(specs, false) }, { users: 10, admins: 11 });
  assert.equal(requests, 2, 'second read should use cached aggregate counts');
  app.context.fsInvalidateAdminCountCache('users');
  assert.deepEqual({ ...app.context.fsCountMany(specs, false) }, { users: 10, admins: 11 });
  assert.equal(requests, 3, 'invalidated counter should be fetched again');
});

test('admin dashboard summary returns aggregate counts and a superadmin marker without listing user records', () => {
  const app = harness();
  const requests = [];
  app.context.fsFetch = (url, method, body) => {
    requests.push({ url, method, body });
    if (url.includes('runAggregationQuery')) return { code: 200, text: JSON.stringify([{ result: { aggregateFields: { total: { integerValue: '7' } } } }]) };
    return { code: 200, text: JSON.stringify([{ document: {
      name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/adminUsers/root',
      fields: { role: { stringValue: 'superadmin' } }
    } }]) };
  };
  app.context.fsListInviteShares = () => Array.from({ length: 7 }, (_, index) => ({ claimedUid: index < 2 ? `claimed-${index}` : null }));
  const summary = app.context.getAdminDashboardSummaryApi({ uid: 'root', admin: { role: 'superadmin' } });
  assert.equal(summary.counts.users, 7);
  assert.equal(summary.counts.invitations, undefined);
  assert.equal(summary.counts.acceptedInvitations, undefined);
  assert.equal(summary.superAdminUid, 'root');
  assert.equal(requests.filter(request => request.url.includes('runAggregationQuery')).length, 4);
  assert.equal(requests.filter(request => request.url.endsWith('documents:runQuery')).length, 1);
});

test('legacy unbounded dashboard action is not exposed by the admin request router', () => {
  const app = harness();
  app.context.verifyFirebaseUser = () => ({ localId: 'root', email: 'root@example.com' });
  app.context.requireAdminApi = uid => ({ uid, admin: { role: 'superadmin' } });
  assert.throws(() => app.context.handleAdminRequest({ idToken: 'x'.repeat(120), action: 'getAdminDashboard', data: {} }));
});

test('admin summary skips superadmin lookup when the moderator cannot access users or shares', () => {
  const app = harness();
  const requests = [];
  app.context.fsFetch = (url, method, body) => {
    requests.push({ url, method, body });
    return { code: 200, text: '[]' };
  };
  const summary = app.context.getAdminDashboardSummaryApi({
    uid: 'moderator',
    admin: { role: 'moderator', permissions: { invites: true, events: true } }
  });
  assert.equal(summary.superAdminUid, null);
  assert.equal(requests.length, 0);
  assert.equal(summary.counts.users, null);
  assert.equal(summary.counts.shares, null);
});

test('admin dashboard counters use Firestore aggregation without downloading collection documents', () => {
  const app = harness();
  let request;
  app.context.fsFetch = (url, method, body) => {
    request = { url, method, body };
    return { code: 200, text: JSON.stringify([{ result: { aggregateFields: { total: { integerValue: '42' } } } }]) };
  };
  assert.equal(app.context.fsCount('users'), 42);
  assert.equal(request.method, 'post');
  assert.match(request.url, /documents:runAggregationQuery$/);
  assert.deepEqual(JSON.parse(JSON.stringify(request.body.structuredAggregationQuery.aggregations)), [{ count: {}, alias: 'total' }]);
  assert.equal(request.body.structuredAggregationQuery.structuredQuery.from[0].collectionId, 'users');
});

test('aggregate counters can filter active shares and count only accepted invitations', () => {
  const app = harness();
  const requests = [];
  app.context.fsFetch = (_url, _method, body) => {
    requests.push(body.structuredAggregationQuery.structuredQuery);
    return { code: 200, text: JSON.stringify([{ result: { aggregateFields: { total: { integerValue: '3' } } } }]) };
  };
  app.context.fsCount('libraryShares', { fieldPath: 'active', op: 'EQUAL', value: { booleanValue: true } });
  app.context.fsCount('shares', [{ fieldPath: 'inviteeEmail', op: 'NOT_EQUAL', value: { nullValue: null } }, { fieldPath: 'claimedUid', op: 'NOT_EQUAL', value: { nullValue: null } }], true);
  assert.equal(requests[0].where.fieldFilter.field.fieldPath, 'active');
  assert.equal(requests[1].from[0].allDescendants, true);
  assert.equal(requests[1].where.compositeFilter.filters.length, 2);
});
test('admin collection pages use Firestore cursor pagination instead of full collection reads', () => {
  const app = harness();
  const requests = [];
  app.context.fsFetch = (url, method, body) => {
    requests.push({ url, method, body });
    const cursor = body.structuredQuery.startAt?.values?.[0]?.referenceValue;
    const ids = cursor ? ['user-26', 'user-27'] : ['user-01', 'user-02'];
    return { code: 200, text: JSON.stringify(ids.map(id => ({ document: {
      name: `projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/users/${id}`,
      fields: { displayName: { stringValue: id } }
    } }))) };
  };
  const first = app.context.fsQueryPage('users', 1, '');
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].id, 'user-01');
  assert.equal(first.hasMore, true);
  assert(first.nextCursor);
  const second = app.context.fsQueryPage('users', 1, first.nextCursor);
  assert.equal(second.items[0].id, 'user-26');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, 'post');
  assert.equal(requests[0].body.structuredQuery.limit, 2);
  assert.equal(requests[1].body.structuredQuery.startAt.before, false);
  assert.match(requests[1].body.structuredQuery.startAt.values[0].referenceValue, /users\/user-01$/);
});

test('participant name search is executed in Firestore and keeps a stable name-plus-document cursor', () => {
  const app = harness();
  const requests = [];
  app.context.fsFetch = (_url, _method, body) => {
    requests.push(body.structuredQuery);
    const id = requests.length === 1 ? 'user-a' : 'user-b';
    return { code: 200, text: JSON.stringify([
      { document: { name: `projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/users/${id}`, fields: { displayName: { stringValue: 'Ада' } } } },
      { document: { name: `projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/users/${id}-next`, fields: { displayName: { stringValue: 'Ада' } } } }
    ]) };
  };
  const first = app.context.fsQueryUsersSearchPage(1, '', 'Ада');
  assert.equal(first.items[0].displayName, 'Ада');
  assert.equal(requests[0].where.compositeFilter.filters.length, 2);
  assert.equal(requests[0].orderBy[0].field.fieldPath, 'displayName');
  assert.equal(requests[0].orderBy[1].field.fieldPath, '__name__');
  const second = app.context.fsQueryUsersSearchPage(1, first.nextCursor, 'Ада');
  assert.equal(requests[1].startAt.values[0].stringValue, 'Ада');
  assert.match(requests[1].startAt.values[1].referenceValue, /users\/user-a$/);
  assert.equal(second.items.length, 1);
});
test('invitation pages read only pendingInvites roots and their shares, with a stable cursor', () => {
  const app = harness();
  const requests = [];
  app.context.fsFetch = (url, method, body) => {
    requests.push({ url, method, body });
    if (method !== 'get') throw new Error('Invitation paging must not use a global collection-group query');
    if (/pendingInvites\?pageSize=/.test(url)) {
      return { code: 200, text: JSON.stringify({ documents: [
        { name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/pendingInvites/ada@example.com', fields: {} },
        { name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/pendingInvites/bob@example.com', fields: {} }
      ] }) };
    }
    if (/pendingInvites\/ada%40example.com\/shares/.test(url)) return { code: 200, text: JSON.stringify({ documents: [
      { name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/pendingInvites/ada@example.com/shares/owner-1', fields: { ownerUid: { stringValue: 'owner-1' } } }
    ] }) };
    if (/pendingInvites\/bob%40example.com\/shares/.test(url)) return { code: 200, text: JSON.stringify({ documents: [
      { name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/pendingInvites/bob@example.com/shares/owner-2', fields: { ownerUid: { stringValue: 'owner-2' } } }
    ] }) };
    throw new Error('Unexpected invitation query URL: ' + url);
  };
  const first = app.context.fsQueryInvitationPage(1, '');
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].email, 'ada@example.com');
  assert.equal(first.items[0].ownerUid, 'owner-1');
  assert.equal(first.hasMore, true);
  const second = app.context.fsQueryInvitationPage(1, first.nextCursor);
  assert.equal(second.items[0].ownerUid, 'owner-2');
  assert(requests.every(request => request.method === 'get'));
  assert(requests.every(request => !String(request.url).includes(':runQuery')));
});

test('admin relationship branches filter by inviter UID on Firestore before paging', () => {
  const app = harness();
  let query;
  app.context.fsFetch = (_url, method, body) => {
    assert.equal(method, 'post');
    query = body.structuredQuery;
    return { code: 200, text: JSON.stringify([]) };
  };
  const page = app.context.fsQueryFilteredPage('users', 'invitedByUid', 'parent-uid', 25, '');
  assert.deepEqual(JSON.parse(JSON.stringify(query.where)), {
    fieldFilter: { field: { fieldPath: 'invitedByUid' }, op: 'EQUAL', value: { stringValue: 'parent-uid' } }
  });
  assert.equal(page.items.length, 0);
});

test('server-side invitation and share filters are encoded as Firestore field filters', () => {
  const app = harness();
  const queries = [];
  app.context.fsFetch = (_url, _method, body) => {
    queries.push(body.structuredQuery);
    return { code: 200, text: JSON.stringify([]) };
  };
  app.context.fsQueryFilteredPage('libraryShares', 'active', false, 25, '');
  assert.equal(queries[0].where.fieldFilter.field.fieldPath, 'active');
  assert.deepEqual(JSON.parse(JSON.stringify(queries[0].where.fieldFilter.value)), { booleanValue: false });
});
test('participant page status flags and directory emails use three bounded IN queries', () => {
  const app = harness();
  const requests = [];
  app.context.fsFetch = (_url, method, body) => {
    requests.push({ method, body });
    const path = body.structuredQuery.from[0].collectionId;
    return { code: 200, text: JSON.stringify(path === 'bannedUsers' ? [{ document: { name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/bannedUsers/u1' } }] : []) };
  };
  const flags = app.context.fsGetAdminUserFlags(['u1', 'u2', 'u3']);
  assert.equal(requests.length, 3);
  assert(requests.every(request => request.method === 'post'));
  assert(requests.every(request => request.body.structuredQuery.where.fieldFilter.op === 'IN'));
  assert(flags.banned.has('u1'));
  assert.equal(flags.admins.size, 0);
});
test('relationship root pages request only users without an inviter', () => {
  const app = harness();
  let query;
  app.context.fsFetch = (_url, _method, body) => {
    query = body.structuredQuery;
    return { code: 200, text: JSON.stringify([]) };
  };
  app.context.fsQueryFilteredPage('users', 'invitedByUid', null, 25, '');
  assert.equal(query.where.fieldFilter.field.fieldPath, 'invitedByUid');
  assert.equal(query.where.fieldFilter.op, 'EQUAL');
  assert.deepEqual(JSON.parse(JSON.stringify(query.where.fieldFilter.value)), { nullValue: null });
});
test('admin cursor rejects a cursor belonging to another collection', () => {
  const app = harness();
  const cursor = Buffer.from(JSON.stringify({ path: 'adminUsers', id: 'x', name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/adminUsers/x' })).toString('base64url');
  assert.throws(() => app.context.fsQueryPage('users', 25, cursor), /Некорректный курсор страницы/);
});
test('sends after Firebase identity and inviter profile are verified without Firestore invitation reads', () => {
  const app = harness();
  const result = app.invoke();
  assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0].to, 'friend@gmail.com');
  assert.match(result.content, /secret-library-invite-result/);
  assert(app.calls.some(call => call.url.includes('accounts:lookup')));
  assert.equal(app.calls.filter(call => call.url.includes('/pendingInvites/')).length, 0);
});

test('blocked recipient email returns the explicit message and sends no email', () => {
  const app = harness({ blockedEmailUid: 'blocked-uid', blockedEmail: true });
  const writes = [];
  app.context.fsSet = (path, values) => writes.push({ path, values });
  const result = app.invoke();
  assert.equal(app.sent.length, 0, 'blocked recipient must never receive an email');
  assert.match(result.content, /Данный емейл заблокирован/);
  assert.equal(writes.length, 0, 'blocked invitation state is not stored in Firestore');
  assert.equal([...app.properties.keys()].some((key) => key.startsWith('invite:')), false, 'no send reservation is created');
});

test('legacy ban records with a matching email also block delivery without a directory entry', () => {
  const app = harness({ blockedEmail: true, blockedEmailByField: true });
  const writes = [];
  app.context.fsSet = (path, values) => writes.push({ path, values });
  const result = app.invoke();
  assert.equal(app.sent.length, 0);
  assert.match(result.content, /Данный емейл заблокирован/);
  assert.equal(writes.length, 0, 'blocked invitation state is kept out of Firestore');
});

test('recipient blocked during send preparation is rechecked before MailApp is called', () => {
  const app = harness({ blockOnSecondCheck: true });
  const writes = [];
  app.context.fsSet = (path, values) => writes.push({ path, values });
  const result = app.invoke();
  assert.equal(app.sent.length, 0);
  assert.match(result.content, /Данный емейл заблокирован/);
  assert.equal(writes.length, 0, 'blocked invitation state is kept out of Firestore');
  const inviteState = JSON.parse(app.properties.get([...app.properties.keys()].find((key) => key.startsWith('invite:'))));
  assert.equal(inviteState.status, 'failed');
  assert.deepEqual(JSON.parse(app.properties.get('daily:owner-uid')), []);
});

test('daily invitation limit counts in-flight reservations before emails are sent', () => {
  const app = harness();
  const reservations = [];
  for (let i = 0; i < 10; i++) {
    reservations.push(app.context.reserveSend('owner-uid', `friend-${i}@gmail.com`, null));
  }
  assert.equal(reservations.length, 10);
  assert.throws(
    () => app.context.reserveSend('owner-uid', 'friend-11@gmail.com', null),
    /Достигнут дневной лимит приглашений/
  );
  assert.equal(app.sent.length, 0, 'the test fills the quota using reservations without sending mail');
});

test('failed invitation send releases its daily reservation', () => {
  const app = harness();
  const reservation = app.context.reserveSend('owner-uid', 'failed@gmail.com', null);
  app.context.finishSend('owner-uid', 'failed@gmail.com', false, reservation.reservationId);
  const next = app.context.reserveSend('owner-uid', 'next@gmail.com', null);
  assert.equal(next.status, 'reserved');
  const daily = JSON.parse(app.properties.get('daily:owner-uid'));
  assert.equal(daily.length, 1);
  assert.equal(daily[0].id, next.reservationId);
});

test('legacy daily counters remain enforced during reservation migration', () => {
  const app = harness();
  app.properties.set('daily:owner-uid', JSON.stringify(Array.from({ length: 10 }, (_, i) => Date.now() - i * 1000)));
  assert.throws(
    () => app.context.reserveSend('owner-uid', 'friend@gmail.com', null),
    /Достигнут дневной лимит приглашений/
  );
});

test('repeated delivery is blocked for one hour instead of sending a duplicate', () => {
  const app = harness();
  app.invoke();
  const second = app.invoke();
  assert.equal(app.sent.length, 1);
  assert.match(second.content, /Запрос обработан/);
});

test('resends the same pending invitation after one hour', () => {
  const app = harness();
  app.context.fsListInviteShares = () => [{ ownerUid: 'owner-uid' }];
  app.context.fsListInviteSharesByOwner = () => [{ ownerUid: 'owner-uid' }];
  app.invoke();
  const key = [...app.properties.keys()].find((name) => name.startsWith('invite:'));
  const oldTime = 0;
  app.properties.set(key, JSON.stringify({ status: 'sent', at: oldTime, lastSentAt: oldTime }));
  const result = app.invoke();
  assert.equal(app.sent.length, 2);
  assert.match(result.content, /Приглашение отправлено \(1 из 20\)/);
});

test('invitation status endpoint returns the persisted cooldown timestamp for the owner only', () => {
  const app = harness();
  app.invoke();
  const result = app.invoke({ action: 'getInvitationStatuses', emails: ['friend@gmail.com', 'FRIEND@gmail.com', 'someone-else@gmail.com'] });
  assert.equal(app.calls.filter(call => call.url.includes('/pendingInvites/friend%40gmail.com/shares/owner-uid')).length, 0);
  assert.match(result.content, /"lastSentAt":\d+/);
  assert.match(result.content, /"cooldownUntil":\d+/);
  assert.doesNotMatch(result.content, /someone-else@gmail\.com/, 'status endpoint does not reveal invitations not owned by this user');
});

test('invitation status limit counts unique normalized emails rather than duplicate inputs', () => {
  const app = harness();
  app.invoke();
  const emails = Array(100).fill('owner@gmail.com').concat('friend@gmail.com');
  const result = app.invoke({ action: 'getInvitationStatuses', emails });
  assert.match(result.content, /friend@gmail\.com/);
  assert.match(result.content, /\"cooldownUntil\":\d+/);
});

test('does not send when the Firebase account is disabled', () => {
  const app = harness({ authUser: {
    localId: 'owner-uid', email: 'owner@gmail.com', emailVerified: true, disabled: true,
    providerUserInfo: [{ providerId: 'google.com' }]
  } });
  const result = app.invoke();
  assert.equal(app.sent.length, 0);
  assert.match(result.content, /подтверждённый Google-сеанс/);
});

test('does not send when the Firebase email is unverified', () => {
  const app = harness({ authUser: {
    localId: 'owner-uid', email: 'owner@gmail.com', emailVerified: false,
    providerUserInfo: [{ providerId: 'google.com' }]
  } });
  const result = app.invoke();
  assert.equal(app.sent.length, 0);
  assert.match(result.content, /подтверждённый Google-сеанс/);
});

test('does not send when the Firebase account is not linked to Google', () => {
  const app = harness({ authUser: {
    localId: 'owner-uid', email: 'owner@gmail.com', emailVerified: true,
    providerUserInfo: [{ providerId: 'password' }]
  } });
  assert.match(app.invoke().content, /подтверждённый Google-сеанс/);
  assert.equal(app.sent.length, 0);
});

test('invitation sending does not depend on pendingInvites Firestore reads', () => {
  const app = harness({ pendingStatus: 403 });
  const result = app.invoke();
  assert.equal(app.sent.length, 1);
  assert.match(result.content, /secret-library-invite-result/);
  assert.equal(app.calls.filter(call => call.url.includes('/pendingInvites/')).length, 0);
});

test('legacy pendingInvites records do not control the server-owned invitation registry', () => {
  const app = harness({ pendingFields: { ownerUid: { stringValue: 'someone-else' }, inviteeEmail: { stringValue: 'friend@gmail.com' }, active: { booleanValue: true } } });
  app.invoke();
  assert.equal(app.sent.length, 1);
  assert.equal(app.calls.filter(call => call.url.includes('/pendingInvites/')).length, 0);
});

test('invitation delivery does not reveal whether the recipient email is registered', () => {
  const registered = harness();
  const unregistered = harness();
  const registeredResult = registered.invoke();
  const unregisteredResult = unregistered.invoke();
  assert.equal(registered.sent.length, 1);
  assert.equal(unregistered.sent.length, 1);
  assert.equal(registeredResult.content, unregisteredResult.content);
  assert(!registered.calls.some((call) => call.url.includes('/userDirectory/')));
  assert(!unregistered.calls.some((call) => call.url.includes('/userDirectory/')));
  assert.match(registered.sent[0].body, /Если вы уже участвуете в Тайной Библиотеке/);
});

test('does not send if the owner profile cannot be read under Firestore rules', () => {
  const app = harness({ profileStatus: 403 });
  const result = app.invoke();
  assert.equal(app.sent.length, 0);
  assert.match(result.content, /Не удалось проверить профиль владельца/);
});

test('prevents changing a library share involving the superadmin on the server', () => {
  const app = harness();
  app.context.requireAdminApi = () => ({ uid: 'moderator', admin: { role: 'moderator' } });
  app.context.fsGet = path => {
    if (path === 'libraryShares/owner-uid__superadmin-uid') return { id: 'owner-uid__superadmin-uid', ownerUid: 'owner-uid', viewerUid: 'superadmin-uid', active: true };
    if (path === 'adminUsers/superadmin-uid') return { uid: 'superadmin-uid', role: 'superadmin' };
    return null;
  };
  const adminReadPaths = [];
  const originalFsGetMany = app.context.fsGetMany;
  app.context.fsGetMany = paths => {
    adminReadPaths.push(...paths);
    return originalFsGetMany(paths);
  };
  app.context.fsSet = () => assert.fail('must not mutate a protected share');
  app.context.fsAddEvent = () => assert.fail('must not log a blocked mutation as completed');
  assert.throws(() => app.context.setLibraryShareApi({}, { id: 'owner-uid__superadmin-uid', active: false }), /Нельзя изменять доступ/);
  assert.deepEqual(adminReadPaths, ['adminUsers/owner-uid', 'adminUsers/superadmin-uid']);
});


function adminHarness({ permissions = {}, active = true, banned = false, role = 'moderator' } = {}) {
  const app = harness();
  const writes = [];
  const records = new Map([
    ['adminUsers/mod-uid', { uid: 'mod-uid', role, active, permissions }],
    ['users/target-uid', { id: 'target-uid', displayName: 'Участник' }],
  ]);
  if (banned) records.set('bannedUsers/mod-uid', { uid: 'mod-uid' });
  app.context.fsGet = (path) => records.get(path) || null;
  app.context.fsGetMany = paths => paths.map(path => app.context.fsGet(path));
  app.context.fsSet = (path, value) => { writes.push({ path, value }); records.set(path, { ...(records.get(path) || {}), ...value }); };
  app.context.fsDelete = (path) => { writes.push({ path, delete: true }); records.delete(path); };
  app.context.fsAddEvent = (...args) => writes.push({ event: args });
  return { ...app, writes, records };
}

test('relationship-only moderator dashboard does not load the private email directory', () => {
  const app = adminHarness({ permissions: { relationships: true } });
  const loaded = [];
  app.context.fsList = collection => {
    loaded.push(collection);
    if (collection === 'users') return [{ id: 'target-uid', displayName: 'Участник' }];
    return [];
  };
  app.context.fsListPage = () => [];
  app.context.getInvitationEmailTemplate = () => '';
  app.context.getInvitationLimit = () => 20;
  const dashboard = app.context.getAdminDashboardApi({ uid: 'mod-uid', admin: { role: 'moderator', permissions: { relationships: true } } });
  assert.equal(dashboard.users[0].email, '');
  assert.equal(loaded.includes('userDirectory'), false);
});

test('relationship-only moderator card does not query or expose the participant email directory', () => {
  const app = adminHarness({ permissions: { relationships: true } });
  app.records.set('adminUsers/target-uid', { uid: 'target-uid', role: 'moderator', email: 'private-admin@example.com' });
  app.records.set('bannedUsers/target-uid', { uid: 'target-uid', reason: 'private reason', email: 'private-ban@example.com' });
  const reads = [];
  const originalFsGet = app.context.fsGet;
  app.context.fsGet = path => { reads.push(path); return originalFsGet(path); };
  const queried = [];
  app.context.fsQueryGroupByField = (collection, field, value) => {
    queried.push({ collection, field, value });
    if (collection === 'userDirectory') return [{ id: 'private%40example.com', uid: 'target-uid' }];
    return [];
  };
  app.context.fsQueryFilteredPage = () => ({ items: [] });
  const card = app.context.getAdminUserCardApi({ uid: 'mod-uid', admin: { role: 'moderator', permissions: { relationships: true } } }, { uid: 'target-uid' });
  assert.equal(card.user.email, '');
  assert.equal(card.admin, null);
  assert.equal(card.banned, null);
  assert.equal(reads.includes('adminUsers/target-uid'), false);
  assert.equal(reads.includes('bannedUsers/target-uid'), false);
  assert.equal(queried.some(item => item.collection === 'userDirectory'), false);
});

test('non-user moderators do not receive email addresses from admin or ban records', () => {
  const app = adminHarness({ permissions: { relationships: true, admins: true, banned: true } });
  app.records.set('adminUsers/target-uid', { uid: 'target-uid', role: 'moderator', email: 'private-admin@example.com' });
  app.records.set('bannedUsers/target-uid', { uid: 'target-uid', reason: 'private reason', email: 'private-ban@example.com' });
  app.context.fsQueryGroupByField = (collection, field, value) => collection === 'libraryShares' ? [{ id: 'share-1', ownerUid: 'target-uid', viewerUid: 'friend-uid', ownerEmail: 'share-owner@example.com', active: true }] : [];
  app.context.fsQueryFilteredPage = () => ({ items: [] });
  const card = app.context.getAdminUserCardApi({ uid: 'mod-uid', admin: { role: 'moderator', permissions: { relationships: true, admins: true, banned: true } } }, { uid: 'target-uid' });
  assert.equal(card.admin.role, 'moderator');
  assert.equal(card.admin.email, '');
  assert.equal(card.banned.reason, 'private reason');
  assert.equal(card.banned.email, '');
  assert.equal(card.outgoing[0].ownerEmail, '');
});
test('relationship admin page lists all users and resolves names for access-share participants', () => {
  const app = adminHarness({ permissions: { relationships: true } });
  app.context.fsQueryPageMany = specs => specs.map(spec => ({
    items: spec.path === 'users'
      ? [{ id: 'invitee-uid', displayName: 'Invitee', invitedByUid: 'owner-uid', email: 'private@example.com' }]
      : [{ id: 'share-1', ownerUid: 'owner-uid', viewerUid: 'invitee-uid', active: true, ownerEmail: 'private@example.com' }],
    hasMore: false, nextCursor: null
  }));
  app.context.fsQueryUserProfiles = uids => {
    assert(uids.includes('owner-uid'));
    return { 'owner-uid': { uid: 'owner-uid', displayName: 'Owner' } };
  };
  const actor = { uid: 'mod-uid', admin: { role: 'moderator', permissions: { relationships: true } } };
  const page = app.context.getAdminRelationshipRootsApi(actor, { includeShares: true });
  assert.equal(page.items[0].uid, 'invitee-uid');
  assert.equal(page.items[0].invitedByUid, 'owner-uid');
  assert.equal(page.shares[0].ownerUid, 'owner-uid');
  assert.equal(page.shares[0].ownerEmail, '');
  assert.equal(page.userProfiles['owner-uid'].displayName, 'Owner');
});
test('relationship-only APIs redact legacy profile email fields', () => {
  const permissions = { relationships: true };
  const app = adminHarness({ permissions });
  app.records.set('users/target-uid', { id: 'target-uid', displayName: 'Target', invitedByUid: 'inviter-uid', email: 'target-profile@example.com', privateNote: 'must not leak' });
  app.records.set('users/inviter-uid', { id: 'inviter-uid', displayName: 'Inviter', email: 'inviter-profile@example.com', privateNote: 'must not leak' });
  app.context.fsQueryGroupByField = () => [];
  app.context.fsQueryFilteredPage = () => ({ items: [{ id: 'invited-uid', displayName: 'Invited', email: 'invited-profile@example.com', privateNote: 'must not leak' }], hasMore: false, nextCursor: null });
  app.context.fsQueryUserProfiles = () => ({});
  const actor = { uid: 'mod-uid', admin: { role: 'moderator', permissions } };
  const card = app.context.getAdminUserCardApi(actor, { uid: 'target-uid' });
  assert.equal(card.user.email, '');
  assert.equal(card.user.privateNote, undefined);
  assert.equal(card.inviter.email, undefined);
  assert.equal(card.inviter.privateNote, undefined);
  assert.equal(card.invited[0].email, undefined);
  assert.equal(card.invited[0].privateNote, undefined);
  app.context.fsQueryPageMany = () => [{ items: [{ id: 'target-uid', displayName: 'Target', email: 'target-profile@example.com', privateNote: 'must not leak' }], hasMore: false, nextCursor: null }];
  const roots = app.context.getAdminRelationshipRootsApi(actor, {}).items[0];
  assert.equal(roots.email, undefined);
  assert.equal(roots.privateNote, undefined);
  const branch = app.context.getAdminBranchApi(actor, { uid: 'target-uid' }).items[0];
  assert.equal(branch.email, undefined);
  assert.equal(branch.privateNote, undefined);

  app.context.fsList = collection => collection === 'users'
    ? [{ id: 'target-uid', displayName: 'Target', email: 'target-profile@example.com', privateNote: 'must not leak' }]
    : [];
  const dashboard = app.context.getAdminDashboardApi(actor);
  assert.equal(dashboard.users[0].email, '');
  assert.equal(dashboard.users[0].privateNote, undefined);
});
test('users permission reveals the directory email but never arbitrary legacy profile fields', () => {
  const permissions = { users: true };
  const app = adminHarness({ permissions });
  app.context.fsList = collection => ({
    users: [{ id: 'target-uid', displayName: 'Target', email: 'legacy@example.com', accessToken: 'secret', privateNote: 'secret' }],
    userDirectory: [{ id: 'target@example.com', uid: 'target-uid' }]
  }[collection] || []);
  app.context.fsListPage = () => [];
  app.context.fsListInviteShares = () => [];
  app.context.getInvitationEmailTemplate = () => '';
  app.context.getInvitationLimit = () => 20;
  const dashboard = app.context.getAdminDashboardApi({ uid: 'mod-uid', admin: { role: 'moderator', permissions } });
  assert.equal(dashboard.users[0].email, 'target@example.com');
  assert.equal(dashboard.users[0].displayName, 'Target');
  assert.equal(Object.hasOwn(dashboard.users[0], 'accessToken'), false);
  assert.equal(Object.hasOwn(dashboard.users[0], 'privateNote'), false);
  assert.equal(Object.hasOwn(dashboard.users[0], 'emailAddress'), false);

  app.records.set('users/target-uid', { id: 'target-uid', displayName: 'Target', email: 'legacy@example.com', accessToken: 'secret' });
  app.context.fsQueryGroupByField = collection => collection === 'userDirectory' ? [{ id: 'target@example.com', uid: 'target-uid' }] : [];
  app.context.fsQueryFilteredPage = () => ({ items: [] });
  const card = app.context.getAdminUserCardApi({ uid: 'mod-uid', admin: { role: 'moderator', permissions } }, { uid: 'target-uid' });
  assert.equal(card.user.email, 'target@example.com');
  assert.equal(Object.hasOwn(card.user, 'accessToken'), false);
});

test('user collection pages sanitize legacy fields and resolve email from the private directory', () => {
  const app = adminHarness({ permissions: { users: true } });
  app.context.fsQueryPage = () => ({ items: [{ id: 'target-uid', displayName: 'Target', email: 'legacy@example.com', accessToken: 'secret', privateNote: 'secret' }], hasMore: false, nextCursor: null });
  app.context.fsGetAdminUserFlags = () => ({ banned: new Set(), admins: new Set(), emailByUid: new Map([['target-uid', 'target@example.com']]) });
  app.context.fsQueryUserProfiles = () => ({});
  const page = app.context.getAdminCollectionPageApi({ uid: 'mod-uid', admin: { role: 'moderator', permissions: { users: true } } }, { section: 'users' });
  assert.equal(page.items[0].email, 'target@example.com');
  assert.equal(page.items[0].displayName, 'Target');
  assert.equal(Object.hasOwn(page.items[0], 'accessToken'), false);
  assert.equal(Object.hasOwn(page.items[0], 'privateNote'), false);
});

test('legacy document fields cannot override authoritative Firestore document IDs', () => {
  const app = harness();
  const docName = 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/users/real-uid';
  const fields = { id: { stringValue: 'adminUsers/root' }, displayName: { stringValue: 'Target' }, accessToken: { stringValue: 'legacy-secret' } };
  app.context.fsFetch = (url, method, body) => {
    if (method === 'get') return { code: 200, text: JSON.stringify({ name: docName, fields }) };
    return { code: 200, text: JSON.stringify([{ document: { name: docName, fields } }]) };
  };
  assert.equal(app.context.realFsGet('users/real-uid').id, 'real-uid');
  const page = app.context.fsQueryFilteredPage('users', '', '', 25, '');
  assert.equal(page.items[0].id, 'real-uid');
  assert.equal(page.items[0].displayName, 'Target');
});

test('admin related-profile lookup returns only public fields for bounded UID batches', () => {
  const app = harness();
  let query;
  app.context.fsFetch = (_url, method, body) => {
    assert.equal(method, 'post');
    query = body.structuredQuery;
    return { code: 200, text: JSON.stringify([{ document: {
      name: 'projects/project/databases/(default)/documents/users/target-uid',
      fields: { displayName: { stringValue: 'Target' }, photoURL: { stringValue: '' }, email: { stringValue: 'private@example.com' }, privateNote: { stringValue: 'secret' } }
    } }]) };
  };
  const profiles = app.context.fsQueryUserProfiles(['target-uid', 'target-uid', 'bad/uid']);
  assert.equal(query.from[0].collectionId, 'users');
  assert.equal(query.where.fieldFilter.field.fieldPath, '__name__');
  assert.equal(query.where.fieldFilter.op, 'IN');
  assert.equal(query.where.fieldFilter.value.arrayValue.values.length, 1);
  assert.equal(profiles['target-uid'].displayName, 'Target');
  assert.equal(Object.hasOwn(profiles['target-uid'], 'email'), false);
  assert.equal(Object.hasOwn(profiles['target-uid'], 'privateNote'), false);
});

test('admin errors expose safe Firebase HTTP status codes instead of masking them', () => {
  const app = harness();
  const message = 'Не удалось сохранить данные Firebase (HTTP 403).';
  assert.equal(app.context.publicAdminError(new Error(message)), message);
});
test('email directory lookup uses a bounded UID query and rejects unrelated rows', () => {
  const app = harness();
  let query;
  app.context.fsFetch = (_url, method, body) => {
    assert.equal(method, 'post');
    query = body.structuredQuery;
    return { code: 200, text: JSON.stringify([
      { document: { name: 'projects/project/databases/(default)/documents/userDirectory/target@example.com', fields: { uid: { stringValue: 'target-uid' } } } },
      { document: { name: 'projects/project/databases/(default)/documents/userDirectory/other@example.com', fields: { uid: { stringValue: 'other-uid' } } } }
    ]) };
  };
  const result = app.context.fsQueryEmailDirectory(['target-uid', 'target-uid', 'invalid/uid']);
  assert.equal(query.from[0].collectionId, 'userDirectory');
  assert.equal(query.where.fieldFilter.field.fieldPath, 'uid');
  assert.equal(query.where.fieldFilter.op, 'IN');
  assert.equal(query.where.fieldFilter.value.arrayValue.values.length, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].uid, 'target-uid');
});

test('user history API sanitizes profile, share, invitation and event records', () => {
  const app = adminHarness({ permissions: { users: true } });
  app.context.fsQueryGroupByField = (collection, field) => {
    if (collection === 'libraryShares') return [{ id: 'share-1', ownerUid: 'target-uid', viewerUid: 'friend-uid', ownerEmail: 'owner@example.com', active: true, accessToken: 'secret' }];
    if (collection === 'shares') return [{ id: 'invite-1', email: 'friend@example.com', ownerUid: 'target-uid', active: true, accessToken: 'secret' }];
    if (collection === 'adminEvents') return [{ id: 'event-1', actorUid: 'target-uid', action: 'ban-user', details: { reason: 'reason', email: 'target@example.com', privateNote: 'secret' }, privateNote: 'secret', createdAt: '2026-01-01T00:00:00Z' }];
    return [];
  };
  const history = app.context.getAdminUserHistoryApi({ uid: 'mod-uid', admin: { role: 'moderator', permissions: { users: true } } }, { uid: 'target-uid' });
  assert.equal(history.outgoing[0].ownerEmail, 'owner@example.com');
  assert.equal(Object.hasOwn(history.outgoing[0], 'accessToken'), false);
  assert.equal(history.invitations[0].email, 'friend@example.com');
  assert.equal(Object.hasOwn(history.invitations[0], 'accessToken'), false);
  assert.equal(history.events[0].details.email, 'target@example.com');
  assert.equal(Object.hasOwn(history.events[0].details, 'privateNote'), false);
  assert.equal(Object.hasOwn(history.events[0], 'privateNote'), false);
});

test('dashboard and collection pages redact emails outside the users permission', () => {
  const permissions = { relationships: true, shares: true, admins: true, banned: true, events: true };
  const app = adminHarness({ permissions });
  app.context.fsList = collection => ({
    users: [{ id: 'target-uid', displayName: 'Target', email: 'legacy-profile@example.com' }],
    bannedUsers: [{ id: 'banned-uid', email: 'private-ban@example.com', reason: 'reason private-ban@example.com', privateNote: 'ban secret' }],
    adminUsers: [{ id: 'admin-uid', email: 'private-admin@example.com', role: 'moderator', permissions: { relationships: true, email: 'nested@example.com', privateNote: 'admin secret' }, privateNote: 'admin secret' }],
    libraryShares: [{ id: 'share-1', ownerUid: 'owner-uid', viewerUid: 'target-uid', ownerEmail: 'private-share@example.com', active: true, privateNote: 'share secret' }],
  }[collection] || []);
  app.context.fsListPage = () => [{ id: 'event-1', details: { email: 'private-event@example.com', reason: 'contact private-event@example.com', permissions: { users: true, email: 'nested@example.com', privateNote: 'event secret' }, privateNote: 'event secret' }, privateNote: 'event root secret' }];
  app.context.fsListInviteShares = () => [];
  const actor = { uid: 'mod-uid', admin: { role: 'moderator', permissions } };
  const dashboard = app.context.getAdminDashboardApi(actor);
  assert.equal(dashboard.users[0].email, '');
  assert.equal(dashboard.shares[0].ownerEmail, '');
  assert.equal(dashboard.admins[0].email, '');
  assert.equal(dashboard.banned[0].email, '');
  assert.equal(dashboard.events[0].details.email, '');
  assert.equal(dashboard.events[0].details.reason, 'contact [скрыто]');
  assert.equal(dashboard.events[0].details.permissions.users, true);
  assert.equal(Object.keys(dashboard.events[0].details.permissions).length, 1);
  assert.equal(dashboard.admins[0].permissions.relationships, true);
  assert.equal(Object.keys(dashboard.admins[0].permissions).length, 1);
  assert.equal(dashboard.banned[0].reason, 'reason [скрыто]');
  assert.equal(dashboard.shares[0].privateNote, undefined);
  assert.equal(dashboard.admins[0].privateNote, undefined);
  assert.equal(dashboard.banned[0].privateNote, undefined);
  assert.equal(dashboard.events[0].privateNote, undefined);
  assert.equal(dashboard.events[0].details.privateNote, undefined);

  const pageItems = {
    libraryShares: [{ id: 'share-1', ownerEmail: 'private-share@example.com', privateNote: 'share secret' }],
    adminUsers: [{ id: 'admin-uid', email: 'private-admin@example.com', privateNote: 'admin secret' }],
    bannedUsers: [{ id: 'banned-uid', email: 'private-ban@example.com', privateNote: 'ban secret' }],
    adminEvents: [{ id: 'event-1', details: { email: 'private-event@example.com', reason: 'contact private-event@example.com', permissions: { users: true, privateNote: 'secret' }, privateNote: 'event secret' }, privateNote: 'event root secret' }],
  };
  app.context.fsQueryFilteredPage = path => ({ items: pageItems[path] || [], hasMore: false, nextCursor: null });
  app.context.fsQueryUserProfiles = () => ({});
  for (const [section, field] of [['shares', 'ownerEmail'], ['admins', 'email'], ['banned', 'email'], ['events', 'details']]) {
    const page = app.context.getAdminCollectionPageApi(actor, { section });
    if (field === 'details') {
      assert.equal(page.items[0].details.email, '');
      assert.equal(page.items[0].details.privateNote, undefined);
      assert.equal(page.items[0].details.reason, 'contact [скрыто]');
      assert.equal(page.items[0].details.permissions.users, true);
      assert.equal(Object.keys(page.items[0].details.permissions).length, 1);
      assert.equal(page.items[0].privateNote, undefined);
    } else {
      assert.equal(page.items[0][field], '');
      assert.equal(page.items[0].privateNote, undefined);
    }

  }
});
test('invitation-only moderators receive only the invitation fields needed by the admin UI', () => {
  const app = adminHarness({ permissions: { invites: true } });
  const actor = { uid: 'mod-uid', admin: { role: 'moderator', permissions: { invites: true } } };
  const [invite] = app.context.sanitizeInvitationRecords(actor, [{
    id: 'owner-uid', email: 'recipient@example.com', ownerUid: 'owner-uid', claimedUid: null,
    active: true, emailStatus: 'sent', ownerEmail: 'owner@example.com', inviteeEmail: 'recipient@example.com',
    privateNote: 'legacy private data', accessToken: 'secret'
  }]);
  assert.equal(invite.email, 'recipient@example.com');
  assert.equal(invite.ownerUid, 'owner-uid');
  assert.equal(invite.emailStatus, 'sent');
  assert.equal(Object.hasOwn(invite, 'ownerEmail'), false);
  assert.equal(Object.hasOwn(invite, 'inviteeEmail'), false);
  assert.equal(Object.hasOwn(invite, 'privateNote'), false);
  assert.equal(Object.hasOwn(invite, 'accessToken'), false);
});
test('administrators cannot reactivate a revoked library share through the server API', () => {
  const app = adminHarness({ permissions: { shares: true } });
  const actor = { uid: 'mod-uid', admin: { role: 'moderator', active: true, permissions: { shares: true } } };
  assert.throws(() => app.context.setLibraryShareApi(actor, { id: 'owner-uid__viewer-uid', active: true }), /только закрыть доступ/);
  assert.equal(app.writes.length, 0);
});
test('administrative mutations reject path-shaped UIDs and share IDs before reading or writing records', () => {
  const permissions = { admins: true, users: true, banned: true, invites: true, shares: true };
  const app = adminHarness({ permissions });
  const actor = { uid: 'mod-uid', admin: { role: 'moderator', active: true, permissions } };
  assert.throws(() => app.context.setAdminPermissionsApi(actor, { uid: 'target/../../adminUsers/root', permissions: { users: true } }), /Некорректные права администратора/);
  assert.throws(() => app.context.banLibraryUserApi(actor, { uid: 'target/../../adminUsers/root' }), /Нельзя заблокировать/);
  assert.throws(() => app.context.restoreLibraryUserApi(actor, { uid: 'target/../../adminUsers/root' }), /Не указан участник/);
  assert.throws(() => app.context.revokeInvitationApi(actor, { email: 'friend@example.com', ownerUid: 'target/../../adminUsers/root' }), /Некорректное приглашение/);
  assert.throws(() => app.context.setLibraryShareApi(actor, { id: 'target/../../adminUsers/root', active: false }), /Некорректный доступ/);
  assert.equal(app.writes.length, 0);
});
test('an active admin record remains authoritative when a ban record exists', () => {
  const app = adminHarness({ permissions: { users: true }, banned: true });
  assert.doesNotThrow(() => app.context.requireAdminApi('mod-uid', 'users'));
  assert.equal(app.writes.length, 0);
});

test('admin API rejects missing and inactive administrator records', () => {
  const app = adminHarness({ permissions: { users: true }, active: false });
  assert.throws(() => app.context.requireAdminApi('mod-uid', 'users'), /Нет прав администратора/);
  app.context.fsGet = () => null;
  assert.throws(() => app.context.requireAdminApi('mod-uid', 'users'), /Нет прав администратора/);
});

test('each moderator mutation requires its own explicit permission', async (t) => {
  const cases = [
    ['admins', (ctx) => ctx.setAdminPermissionsApi({ uid: 'mod-uid', admin: { role: 'moderator', active: true, permissions: { admins: false } } }, { uid: 'target-uid', permissions: { users: true } })],
    ['users', (ctx) => ctx.banLibraryUserApi({ uid: 'mod-uid', admin: { role: 'moderator', active: true, permissions: { users: false } } }, { uid: 'target-uid' })],
    ['banned', (ctx) => ctx.restoreLibraryUserApi({ uid: 'mod-uid', admin: { role: 'moderator', active: true, permissions: { banned: false } } }, { uid: 'target-uid' })],
    ['invites', (ctx) => ctx.revokeInvitationApi({ uid: 'mod-uid', admin: { role: 'moderator', active: true, permissions: { invites: false } } }, { email: 'friend@gmail.com', ownerUid: 'owner-uid' })],
    ['shares', (ctx) => ctx.setLibraryShareApi({ uid: 'mod-uid', admin: { role: 'moderator', active: true, permissions: { shares: false } } }, { id: 'share-1', active: false })],
  ];
  for (const [permission, invoke] of cases) {
    await t.test(permission, () => {
      const app = adminHarness({ permissions: { [permission]: false } });
      assert.throws(() => invoke(app.context), /Недостаточно прав/);
      assert.equal(app.writes.length, 0, 'denied action must not write data or audit events');
    });
  }
});

test('new ban records batch the email-directory lookup and preserve its email mapping', () => {
  const app = adminHarness({ permissions: { users: true } });
  let batchedPaths;
  let batchedSpecs;
  app.context.fsGetManyAndQueryGroupByFieldMany = (paths, specs) => {
    batchedPaths = paths;
    batchedSpecs = specs;
    return {
      records: [null, app.records.get('users/target-uid')],
      groups: [[{ id: 'target%40example.com', uid: 'target-uid' }]]
    };
  };
  const actor = { uid: 'mod-uid', admin: { role: 'moderator', active: true, permissions: { users: true } } };
  app.context.banLibraryUserApi(actor, { uid: 'target-uid', reason: 'abuse' });
  assert.equal(JSON.stringify(batchedPaths), JSON.stringify(['adminUsers/target-uid', 'users/target-uid']));
  assert.equal(JSON.stringify(batchedSpecs), JSON.stringify([{ collectionId: 'userDirectory', field: 'uid', value: 'target-uid', limit: 1 }]));
  assert.equal(app.records.get('bannedUsers/target-uid').email, 'target@example.com');
});

test('a banned participant cannot be assigned active administrator rights', () => {
  const app = adminHarness({ permissions: { admins: true } });
  app.records.set('bannedUsers/target-uid', { uid: 'target-uid' });
  const actor = { uid: 'mod-uid', admin: { role: 'moderator', active: true, permissions: { admins: true } } };
  assert.throws(() => app.context.setAdminPermissionsApi(actor, { uid: 'target-uid', permissions: { users: true }, active: true }), /Нельзя назначить администратора заблокированному участнику/);
  assert.equal(app.writes.length, 0);
  assert.equal(app.context.publicAdminError(new Error('Нельзя назначить администратора заблокированному участнику.')), 'Нельзя назначить администратора заблокированному участнику.');
});

test('restoring a banned user does not restore their admin rights without admins permission', () => {
  const app = adminHarness({ permissions: { banned: true } });
  app.records.set('bannedUsers/target-uid', { uid: 'target-uid', adminWasActive: true });
  app.records.set('adminUsers/target-uid', { uid: 'target-uid', role: 'moderator', active: false });
  const actor = { uid: 'mod-uid', admin: { role: 'moderator', active: true, permissions: { banned: true } } };

  assert.equal(app.context.restoreLibraryUserApi(actor, { uid: 'target-uid' }).ok, true);
  assert.equal(app.records.has('bannedUsers/target-uid'), false);
  assert.equal(app.records.get('adminUsers/target-uid').active, false);
  assert.notEqual(app.records.get('users/target-uid').isAdmin, true);
  assert.equal(app.writes.find(item => item.event)?.event[3].adminRestored, false);
});

test('restoring a banned user restores prior admin rights only with admins permission', () => {
  const app = adminHarness({ permissions: { banned: true, admins: true } });
  app.records.set('bannedUsers/target-uid', { uid: 'target-uid', adminWasActive: true });
  app.records.set('adminUsers/target-uid', { uid: 'target-uid', role: 'moderator', active: false });
  const actor = { uid: 'mod-uid', admin: { role: 'moderator', active: true, permissions: { banned: true, admins: true } } };

  assert.equal(app.context.restoreLibraryUserApi(actor, { uid: 'target-uid' }).ok, true);
  assert.equal(app.records.has('bannedUsers/target-uid'), false);
  assert.equal(app.records.get('adminUsers/target-uid').active, true);
  assert.equal(app.records.get('users/target-uid').isAdmin, true);
  assert.equal(app.writes.find(item => item.event)?.event[3].adminRestored, true);
});

test('moderator cannot grant themselves privileges or alter the superadmin', () => {
  const app = adminHarness({ permissions: { admins: true } });
  const actor = { uid: 'mod-uid', admin: { role: 'moderator', active: true, permissions: { admins: true } } };
  assert.throws(() => app.context.setAdminPermissionsApi(actor, { uid: 'mod-uid', permissions: { users: true } }), /Некорректные права/);
  app.records.set('adminUsers/super-uid', { uid: 'super-uid', role: 'superadmin' });
  app.records.set('users/super-uid', { id: 'super-uid' });
  assert.throws(() => app.context.setAdminPermissionsApi(actor, { uid: 'super-uid', permissions: { users: false } }), /Нельзя менять права главного администратора/);
  assert.equal(app.writes.length, 0);
});

test('superadmin bootstrap provisions only the email configured in Script Properties', () => {
  const adminUser = {
    localId: 'owner-uid', email: 'admin@example.com', emailVerified: true,
    displayName: 'Администратор', providerUserInfo: [{ providerId: 'google.com' }]
  };
  const unconfigured = harness({ authUser: adminUser });
  assert.throws(() => unconfigured.context.handleAdminRequest({ idToken: 'firebase-id-token-'.padEnd(500, 'x'), action: 'bootstrapAdmin' }), /Первоначальная настройка доступна только владельцу проекта/);

  const app = harness({ authUser: adminUser });
  app.properties.set('BOOTSTRAP_ADMIN_EMAIL', 'admin@example.com');
  const writes = [];
  app.context.fsGet = () => null;
  app.context.fsList = () => [];
  app.context.fsSet = (path, value) => writes.push({ path, value });
  app.context.fsAddEvent = (...args) => writes.push({ event: args });
  const result = app.context.handleAdminRequest({ idToken: 'firebase-id-token-'.padEnd(500, 'x'), action: 'bootstrapAdmin' });
  assert.equal(result.alreadyAdmin, false);
  assert.equal(writes.find((x) => x.path === 'adminUsers/owner-uid').value.email, 'admin@example.com');
  assert.equal(writes.find((x) => x.path === 'adminUsers/owner-uid').value.role, 'superadmin');

  // Existing moderator records must not block recovery when no superadmin exists.
  const recover = harness({ authUser: adminUser });
  recover.properties.set('BOOTSTRAP_ADMIN_EMAIL', 'admin@example.com');
  recover.context.fsGet = () => null;
  recover.context.fsList = () => [{ id: 'moderator-uid', role: 'moderator', active: true }];
  const recoveryWrites = [];
  recover.context.fsSet = (path, value) => recoveryWrites.push({ path, value });
  recover.context.fsAddEvent = () => {};
  assert.equal(recover.context.handleAdminRequest({ idToken: 'firebase-id-token-'.padEnd(500, 'x'), action: 'bootstrapAdmin' }).alreadyAdmin, false);
  assert.equal(recoveryWrites.find(x => x.path === 'adminUsers/owner-uid').value.role, 'superadmin');

  // A different existing superadmin must remain protected from takeover.
  const occupied = harness({ authUser: adminUser });
  occupied.properties.set('BOOTSTRAP_ADMIN_EMAIL', 'admin@example.com');
  occupied.context.fsGet = () => null;
  occupied.context.fsList = () => [{ id: 'other-superadmin-uid', role: 'superadmin', active: true }];
  assert.throws(() => occupied.context.handleAdminRequest({ idToken: 'firebase-id-token-'.padEnd(500, 'x'), action: 'bootstrapAdmin' }), /Главный администратор уже настроен/);

  const wrong = harness({ authUser: { ...adminUser, email: 'other@gmail.com' } });
  assert.throws(() => wrong.context.handleAdminRequest({ idToken: 'firebase-id-token-'.padEnd(500, 'x'), action: 'bootstrapAdmin' }), /Первоначальная настройка доступна только владельцу проекта/);
});


test('unique invitation limit defaults to 20 and permits an existing recipient at the limit', () => {
  const app = harness();
  assert.equal(app.context.getInvitationLimit(), 20);
  app.context.fsGet = () => null;
  app.properties.set(app.context.ownerInvitationRegistryKey('owner-uid'), JSON.stringify(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`friend-${i}@gmail.com`, { status: 'pending', inviteeEmail: `friend-${i}@gmail.com` }]))));
  assert.doesNotThrow(() => app.context.enforceUniqueInvitationLimit('owner-uid', 'friend-0@gmail.com', {}));
});

test('unique invitation limit blocks a new recipient beyond the limit', () => {
  const app = harness();
  app.context.fsGet = () => null;
  app.properties.set(app.context.ownerInvitationRegistryKey('owner-uid'), JSON.stringify(Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['friend-' + i + '@gmail.com', { status: 'pending', inviteeEmail: 'friend-' + i + '@gmail.com' }]))));
  assert.throws(() => app.context.enforceUniqueInvitationLimit('owner-uid', 'new-recipient@gmail.com', null));
});

test('repeated invitation to a previously sent recipient remains allowed beyond the limit', () => {
  const app = harness();
  app.context.fsGet = () => null;
  app.context.fsListInviteShares = () => Array.from({ length: 21 }, (_, i) => ({ ownerUid: 'owner-uid', email: `friend-${i}@gmail.com` }));
  app.context.fsListInviteSharesByOwner = () => app.context.fsListInviteShares();
  assert.doesNotThrow(() => app.context.enforceUniqueInvitationLimit('owner-uid', 'friend-0@gmail.com', {
    emailStatus: 'sent'
  }));
});

test('active administrators are exempt from the unique invitation limit', () => {
  const app = harness();
  app.context.fsGet = (path) => path === 'adminUsers/owner-uid' ? { active: true, role: 'admin' } : null;
  app.context.fsListInviteShares = () => Array.from({ length: 100 }, (_, i) => ({ ownerUid: 'owner-uid', email: `friend-${i}@gmail.com` }));
  app.context.fsListInviteSharesByOwner = () => app.context.fsListInviteShares();
  assert.doesNotThrow(() => app.context.enforceUniqueInvitationLimit('owner-uid', 'friend-100@gmail.com', {}));
});

test('invitation limit setting validates and persists an integer', () => {
  const app = harness();
  const writes = [];
  app.context.requireAdminApi = () => ({ uid: 'admin-uid', admin: { active: true } });
  app.context.fsSet = (path, values) => writes.push({ path, values });
  app.context.fsAddEvent = () => {};
  assert.equal(app.context.setInvitationLimitApi({ uid: 'admin-uid' }, { limit: 35 }).limit, 35);
  assert.equal(writes[0].path, 'systemSettings/invitationLimit');
  assert.equal(writes[0].values.limit, 35);
  assert.throws(() => app.context.setInvitationLimitApi({ uid: 'admin-uid' }, { limit: 1.5 }), /целым числом/);
  assert.throws(() => app.context.setInvitationLimitApi({ uid: 'admin-uid' }, { limit: -1 }), /целым числом/);
  assert.throws(() => app.context.setInvitationLimitApi({ uid: 'admin-uid' }, { limit: '' }), /целым числом/);
});

test('admin user list does not fetch profiles already present on the current page', () => {
  const app = harness();
  assert.equal(JSON.stringify(app.context.adminRelatedUserUids('users', [
    { uid: 'user-1', invitedByUid: 'user-2' },
    { uid: 'user-2', invitedByUid: 'user-3' }
  ])), JSON.stringify(['user-3']));
});


test('admin summary batches cold-cache superadmin lookup with aggregation counts', () => {
  const app = harness();
  const batches = [];
  app.context.ScriptApp = { getOAuthToken: () => 'test-token' };
  app.context.UrlFetchApp.fetchAll = requests => {
    batches.push(requests);
    return requests.map(request => ({
      getResponseCode: () => 200,
      getContentText: () => request.url.includes('runAggregationQuery')
        ? JSON.stringify([{ result: { aggregateFields: { total: { integerValue: '4' } } } }])
        : JSON.stringify([{ document: {
          name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/adminUsers/root',
          fields: { role: { stringValue: 'superadmin' } }
        } }])
    }));
  };
  const summary = app.context.getAdminDashboardSummaryApi({ uid: 'root', admin: { role: 'superadmin' } });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].filter(request => request.url.includes('runAggregationQuery')).length, 4);
  assert.equal(batches[0].filter(request => request.url.endsWith('documents:runQuery')).length, 1);
  assert.equal(summary.counts.users, 4);
  assert.equal(summary.superAdminUid, 'root');
});

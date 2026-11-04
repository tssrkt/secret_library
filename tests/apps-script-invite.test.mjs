import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const source = await readFile(new URL('../apps-script-invite/Code.gs', import.meta.url), 'utf8');

function harness({ authUser, pendingFields, pendingStatus = 200, profileStatus = 200 } = {}) {
  const properties = new Map();
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
    Date, JSON, Object, Array, String, Number, Math, RegExp, Error, isFinite,
    encodeURIComponent,
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createHtmlOutput(content) {
        return { content, setXFrameOptionsMode() { return this; } };
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
          setProperty(key, value) { properties.set(key, value); }
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
  context.fsGet = () => null;
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

test('invitation dashboard reads nested shares with one collection-group query', () => {
  const app = harness();
  let request;
  app.context.fsFetch = (url, method, body) => {
    request = { url, method, body };
    return {
      code: 200,
      text: JSON.stringify([
        { document: {
          name: 'projects/project/databases/(default)/documents/pendingInvites/friend@gmail.com/shares/owner-uid',
          fields: { ownerUid: { stringValue: 'owner-uid' }, claimedUid: { nullValue: null } }
        } },
        { document: {
          name: 'projects/project/databases/(default)/documents/otherCollection/parent/shares/other-uid',
          fields: { ownerUid: { stringValue: 'other-uid' } }
        } },
        { readTime: '2026-11-04T00:00:00Z' }
      ])
    };
  };
  const invites = app.context.fsListInviteShares();
  assert.equal(request.method, 'post');
  assert.match(request.url, /documents:runQuery$/);
  assert.equal(JSON.stringify(request.body.structuredQuery.from), JSON.stringify([{ collectionId: 'shares', allDescendants: true }]));
  assert.equal(invites.length, 1);
  assert.equal(invites[0].email, 'friend@gmail.com');
  assert.equal(invites[0].id, 'owner-uid');
  assert.equal(invites[0].ownerUid, 'owner-uid');
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
  const summary = app.context.getAdminDashboardSummaryApi({ uid: 'root', admin: { role: 'superadmin' } });
  assert.equal(summary.counts.users, 7);
  assert.equal(summary.counts.invitations, 7);
  assert.equal(summary.superAdminUid, 'root');
  assert.equal(requests.filter(request => request.url.includes('runAggregationQuery')).length, 6);
  assert.equal(requests.filter(request => request.url.endsWith('documents:runQuery')).length, 1);
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
test('invitation pages cursor through nested pendingInvites shares and ignore unrelated share subcollections', () => {
  const app = harness();
  const requests = [];
  app.context.fsFetch = (url, method, body) => {
    requests.push({ url, method, body });
    const first = !body.structuredQuery.startAt;
    const docs = first ? [
      { name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/otherCollection/doc/shares/noise', fields: {} },
      { name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/pendingInvites/ada%40example.com/shares/owner-1', fields: { ownerUid: { stringValue: 'owner-1' } } },
      { name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/pendingInvites/bob%40example.com/shares/owner-2', fields: { ownerUid: { stringValue: 'owner-2' } } }
    ] : [
      { name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/pendingInvites/bob%40example.com/shares/owner-2', fields: { ownerUid: { stringValue: 'owner-2' } } }
    ];
    return { code: 200, text: JSON.stringify(docs.map(document => ({ document }))) };
  };
  const first = app.context.fsQueryInvitationPage(1, '');
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].email, 'ada@example.com');
  assert.equal(first.items[0].ownerUid, 'owner-1');
  assert.equal(first.hasMore, true);
  const second = app.context.fsQueryInvitationPage(1, first.nextCursor);
  assert.equal(second.items[0].ownerUid, 'owner-2');
  assert.equal(requests[0].body.structuredQuery.from[0].allDescendants, true);
  assert.equal(requests[0].body.structuredQuery.where.fieldFilter.field.fieldPath, 'inviteeEmail');
  assert.equal(requests[0].body.structuredQuery.where.fieldFilter.op, 'NOT_EQUAL');
  assert.equal(requests[1].body.structuredQuery.startAt.before, false);
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
  app.context.fsQueryInvitationPage(25, '', 'pending');
  app.context.fsQueryFilteredPage('libraryShares', 'active', false, 25, '');
  assert.equal(queries[0].where.fieldFilter.field.fieldPath, 'claimedUid');
  assert.equal(queries[0].where.fieldFilter.op, 'EQUAL');
  assert.deepEqual(JSON.parse(JSON.stringify(queries[0].where.fieldFilter.value)), { nullValue: null });
  assert.equal(queries[1].where.fieldFilter.field.fieldPath, 'active');
  assert.deepEqual(JSON.parse(JSON.stringify(queries[1].where.fieldFilter.value)), { booleanValue: false });
});
test('participant page status flags are fetched in two bounded IN queries, not N+1 reads', () => {
  const app = harness();
  const requests = [];
  app.context.fsFetch = (_url, method, body) => {
    requests.push({ method, body });
    const path = body.structuredQuery.from[0].collectionId;
    return { code: 200, text: JSON.stringify(path === 'bannedUsers' ? [{ document: { name: 'projects/project-071ee00e-4a4a-4a3d-95d/databases/(default)/documents/bannedUsers/u1' } }] : []) };
  };
  const flags = app.context.fsGetAdminUserFlags(['u1', 'u2', 'u3']);
  assert.equal(requests.length, 2);
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
test('sends only after Firebase identity and owner-scoped Firestore reads are valid', () => {
  const app = harness();
  const result = app.invoke();
  assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0].to, 'friend@gmail.com');
  assert.equal(app.sent[0].subject, 'Приглашение в «Тайную Библиотеку»');
  assert.match(app.sent[0].body, /Ада приглашает/);
  assert.match(result.content, /secret-library-invite-result/);
  assert.match(result.content, /Запрос обработан/);
  assert(app.calls.some((call) => call.url.includes('accounts:lookup')));
  assert(app.calls.some((call) => call.options.headers?.Authorization === 'Bearer ' + app.payload.idToken));
  assert.equal(app.calls.length, 3, 'Firebase account, owner profile and owner-scoped invitation are checked; directory lookup stays server-side');
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
  app.invoke();
  const key = [...app.properties.keys()].find((name) => name.startsWith('invite:'));
  const oldTime = Date.now() - 60 * 60 * 1000 - 1000;
  app.properties.set(key, JSON.stringify({ status: 'sent', at: oldTime, lastSentAt: oldTime }));
  const result = app.invoke();
  assert.equal(app.sent.length, 2);
  assert.match(result.content, /Запрос обработан/);
});

test('invitation status endpoint returns the persisted cooldown timestamp for the owner only', () => {
  const app = harness();
  app.invoke();
  const result = app.invoke({ action: 'getInvitationStatuses', emails: ['friend@gmail.com', 'someone-else@gmail.com'] });
  assert.match(result.content, /"lastSentAt":\d+/);
  assert.match(result.content, /"cooldownUntil":\d+/);
  assert.doesNotMatch(result.content, /someone-else@gmail\.com/, 'status endpoint does not reveal invitations not owned by this user');
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

test('does not send if Firestore security rules reject the owner-scoped invitation read', () => {
  const app = harness({ pendingStatus: 403 });
  const result = app.invoke();
  assert.equal(app.sent.length, 0);
  assert.match(result.content, /Не удалось проверить приглашение/);
});

test('does not send if the pending invitation belongs to another owner', () => {
  const app = harness({ pendingFields: {
    ownerUid: { stringValue: 'someone-else' },
    inviteeEmail: { stringValue: 'friend@gmail.com' },
    active: { booleanValue: true },
    claimedUid: { nullValue: null }
  } });
  const result = app.invoke();
  assert.equal(app.sent.length, 0);
  assert.match(result.content, /Приглашение не найдено/);
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
    if (path === 'libraryShares/share-1') return { id: 'share-1', ownerUid: 'owner-uid', viewerUid: 'superadmin-uid', active: true };
    if (path === 'adminUsers/superadmin-uid') return { uid: 'superadmin-uid', role: 'superadmin' };
    return null;
  };
  app.context.fsSet = () => assert.fail('must not mutate a protected share');
  app.context.fsAddEvent = () => assert.fail('must not log a blocked mutation as completed');
  assert.throws(() => app.context.setLibraryShareApi({}, { id: 'share-1', active: false }), /Нельзя изменять доступ/);
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
  app.context.fsSet = (path, value) => { writes.push({ path, value }); records.set(path, { ...(records.get(path) || {}), ...value }); };
  app.context.fsDelete = (path) => { writes.push({ path, delete: true }); records.delete(path); };
  app.context.fsAddEvent = (...args) => writes.push({ event: args });
  return { ...app, writes, records };
}

test('admin API rejects a banned moderator before any administrative operation', () => {
  const app = adminHarness({ permissions: { users: true }, banned: true });
  assert.throws(() => app.context.requireAdminApi('mod-uid', 'users'), /Доступ к Тайной Библиотеке заблокирован/);
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

test('moderator cannot grant themselves privileges or alter the superadmin', () => {
  const app = adminHarness({ permissions: { admins: true } });
  const actor = { uid: 'mod-uid', admin: { role: 'moderator', active: true, permissions: { admins: true } } };
  assert.throws(() => app.context.setAdminPermissionsApi(actor, { uid: 'mod-uid', permissions: { users: true } }), /Некорректные права/);
  app.records.set('adminUsers/super-uid', { uid: 'super-uid', role: 'superadmin' });
  app.records.set('users/super-uid', { id: 'super-uid' });
  assert.throws(() => app.context.setAdminPermissionsApi(actor, { uid: 'super-uid', permissions: { users: false } }), /Нельзя менять права главного администратора/);
  assert.equal(app.writes.length, 0);
});

test('superadmin bootstrap provisions only the configured public project email', () => {
  const adminUser = {
    localId: 'owner-uid', email: 'tssrkt777@gmail.com', emailVerified: true,
    displayName: 'Администратор', providerUserInfo: [{ providerId: 'google.com' }]
  };
  const app = harness({ authUser: adminUser });
  const writes = [];
  app.context.fsGet = () => null;
  app.context.fsList = () => [];
  app.context.fsSet = (path, value) => writes.push({ path, value });
  app.context.fsAddEvent = (...args) => writes.push({ event: args });
  const result = app.context.handleAdminRequest({ idToken: 'firebase-id-token-'.padEnd(500, 'x'), action: 'bootstrapAdmin' });
  assert.equal(result.alreadyAdmin, false);
  assert.equal(writes.find((x) => x.path === 'adminUsers/owner-uid').value.email, 'tssrkt777@gmail.com');
  assert.equal(writes.find((x) => x.path === 'adminUsers/owner-uid').value.role, 'superadmin');

  const wrong = harness({ authUser: { ...adminUser, email: 'other@gmail.com' } });
  assert.throws(() => wrong.context.handleAdminRequest({ idToken: 'firebase-id-token-'.padEnd(500, 'x'), action: 'bootstrapAdmin' }), /Первоначальная настройка доступна только владельцу проекта/);
});

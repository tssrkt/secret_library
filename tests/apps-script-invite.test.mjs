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
      computeDigest(_algorithm, value) { return [...createHash('sha256').update(value).digest()]; }
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

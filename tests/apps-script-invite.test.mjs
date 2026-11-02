import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const source = await readFile(new URL('../apps-script-invite/Code.gs', import.meta.url), 'utf8');

function harness({ authUser, pendingFields, directoryStatus = 404, pendingStatus = 200, profileStatus = 200 } = {}) {
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
        if (url.includes('/userDirectory/')) return response(directoryStatus, {});
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
  const payload = {
    requestId: 'request_1234567890',
    email: 'friend@gmail.com',
    idToken: 'firebase-id-token-'.padEnd(500, 'x')
  };
  const invoke = (overrides = {}) => context.doPost({
    parameter: { payload: JSON.stringify({ ...payload, ...overrides }) }
  });
  return { invoke, sent, calls, properties, payload };
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
  assert.match(result.content, /Приглашение отправлено/);
  assert(app.calls.some((call) => call.url.includes('accounts:lookup')));
  assert(app.calls.some((call) => call.options.headers?.Authorization === 'Bearer ' + app.payload.idToken));
  assert.equal(app.calls.length, 4, 'Firebase account, owner profile, invitation and recipient directory are checked');
});

test('repeated delivery does not send a duplicate message', () => {
  const app = harness();
  app.invoke();
  app.invoke();
  assert.equal(app.sent.length, 1);
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

test('does not send to an already registered recipient', () => {
  const app = harness({ directoryStatus: 200 });
  const result = app.invoke();
  assert.equal(app.sent.length, 0);
  assert.match(result.content, /Пользователь уже зарегистрировался/);
});

test('does not send if the owner profile cannot be read under Firestore rules', () => {
  const app = harness({ profileStatus: 403 });
  const result = app.invoke();
  assert.equal(app.sent.length, 0);
  assert.match(result.content, /Не удалось проверить профиль владельца/);
});

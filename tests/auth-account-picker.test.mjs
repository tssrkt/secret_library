import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeAuth, requestAccessToken, restoreAuthSession, clearAccessToken } from '../js/auth.js';

function setup() {
  const clients = [];
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
  globalThis.window = { sessionStorage: storage, localStorage: storage };
  const oauth2 = { initTokenClient: (options) => {
    const client = { ...options, requests: [], requestAccessToken(request) { this.requests.push(request); } };
    clients.push(client);
    return client;
  } };
  globalThis.google = { accounts: { oauth2 } };
  window.google = globalThis.google;
  return clients;
}

test('explicit account selection omits saved login_hint', async () => {
  const clients = setup();
  await initializeAuth();
  restoreAuthSession({ session: { getItem: () => JSON.stringify({ accessToken: 'saved', expiresAt: Date.now() + 3600000, user: { emailAddress: 'first@example.com' } }), removeItem: () => {} } });
  const pending = requestAccessToken({ prompt: 'select_account' });
  assert.deepEqual(clients[0].requests, [{ prompt: 'consent select_account' }]);
  clients[0].callback({ access_token: 'selected-account-token', expires_in: 3600 });
  assert.equal(await pending, 'selected-account-token');
  clearAccessToken();
});

test('account selection supersedes an in-flight automatic renewal on a fresh client', async () => {
  const clients = setup();
  await initializeAuth();
  restoreAuthSession({ session: { getItem: () => JSON.stringify({ accessToken: 'saved', expiresAt: Date.now() + 3600000, user: { emailAddress: 'first@example.com' } }), removeItem: () => {} } });
  const automatic = requestAccessToken({ prompt: '' });
  assert.deepEqual(clients[0].requests, [{ prompt: 'consent', login_hint: 'first@example.com' }]);
  const rejected = assert.rejects(automatic, { code: 'cancelled' });
  const interactive = requestAccessToken({ prompt: 'select_account' });
  assert.equal(clients.length, 2);
  assert.deepEqual(clients[1].requests, [{ prompt: 'consent select_account' }]);
  clients[0].callback({ access_token: 'stale-token', expires_in: 3600 });
  clients[1].callback({ access_token: 'chosen-token', expires_in: 3600 });
  await rejected;
  assert.equal(await interactive, 'chosen-token');
  clearAccessToken();
});

test('rejects a token response that still includes broad Drive access', async () => {
  const clients = setup();
  await initializeAuth();
  const pending = requestAccessToken();
  clients[0].callback({
    access_token: 'unsafe-token',
    expires_in: 3600,
    scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file',
  });
  await assert.rejects(pending, /old broad Drive permission/);
  assert.equal((await import('../js/auth.js')).getAccessToken(), null);
});

test('rejects partial consent that omits drive.file', async () => {
  const clients = setup();
  await initializeAuth();
  const pending = requestAccessToken();
  clients[0].callback({
    access_token: 'partial-token',
    expires_in: 3600,
    scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata',
  });
  await assert.rejects(pending, /Не все необходимые разрешения/);
  assert.equal((await import('../js/auth.js')).getAccessToken(), null);
});

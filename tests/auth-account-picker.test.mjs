import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeAuth, requestAccessToken, restoreAuthSession, clearAccessToken } from '../js/auth.js';

function setup() {
  const clients = [];
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
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
  assert.deepEqual(clients[0].requests, [{ prompt: 'select_account' }]);
  clients[0].callback({ access_token: 'selected-account-token', expires_in: 3600 });
  assert.equal(await pending, 'selected-account-token');
  clearAccessToken();
});

test('account selection supersedes an in-flight automatic renewal on a fresh client', async () => {
  const clients = setup();
  await initializeAuth();
  restoreAuthSession({ session: { getItem: () => JSON.stringify({ accessToken: 'saved', expiresAt: Date.now() + 3600000, user: { emailAddress: 'first@example.com' } }), removeItem: () => {} } });
  const automatic = requestAccessToken({ prompt: '' });
  assert.deepEqual(clients[0].requests, [{ prompt: '', login_hint: 'first@example.com' }]);
  const rejected = assert.rejects(automatic, { code: 'cancelled' });
  const interactive = requestAccessToken({ prompt: 'select_account' });
  assert.equal(clients.length, 2);
  assert.deepEqual(clients[1].requests, [{ prompt: 'select_account' }]);
  clients[0].callback({ access_token: 'stale-token', expires_in: 3600 });
  clients[1].callback({ access_token: 'chosen-token', expires_in: 3600 });
  await rejected;
  assert.equal(await interactive, 'chosen-token');
  clearAccessToken();
});

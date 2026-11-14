import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeRedirectTokenResponse, initializeAuth, oauthRedirectUri,
  parseRedirectTokenResponse, requestAccessToken, restoreAuthSession,
  clearAccessToken, settleRedirectResponse,
} from '../js/auth.js?v=20261114-brave-redirect-signin';

function setup({ brave = false, search = '', href = 'https://tssrkt.github.io/secret_library/index.html' } = {}) {
  const clients = [];
  const values = new Map();
  const replaceStateCalls = [];
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
  globalThis.window = { sessionStorage: storage, localStorage: storage };
  globalThis.history = { state: null, replaceState: (...args) => replaceStateCalls.push(args) };
  globalThis.location = { href, pathname: '/secret_library/index.html', search, hash: '' };
  if (brave) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { brave: { isBrave: async () => true } }, configurable: true,
    });
  } else {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  }
  const oauth2 = { revoke: (_token, callback) => callback?.(), initTokenClient: (options) => {
    const client = { ...options, requests: [], requestAccessToken(request) { this.requests.push(request); } };
    clients.push(client);
    return client;
  } };
  globalThis.google = { accounts: { oauth2 } };
  window.google = globalThis.google;
  return { clients, replaceStateCalls, storage };
}

test('oauthRedirectUri derives the directory URL with the trailing slash', () => {
  assert.equal(oauthRedirectUri('https://tssrkt.github.io/secret_library/index.html'), 'https://tssrkt.github.io/secret_library/');
  assert.equal(oauthRedirectUri('https://tssrkt.github.io/secret_library/'), 'https://tssrkt.github.io/secret_library/');
  assert.equal(oauthRedirectUri('http://localhost:8000/'), 'http://localhost:8000/');
  assert.equal(oauthRedirectUri('http://localhost:8000/index.html?q=1#h'), 'http://localhost:8000/');
  assert.equal(oauthRedirectUri(undefined), '');
});

test('parses a Google redirect token response from the URL fragment', () => {
  const parsed = parseRedirectTokenResponse('#access_token=ya29.token&token_type=Bearer&expires_in=3599&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.appdata&authuser=0');
  assert.equal(parsed.accessToken, 'ya29.token');
  assert.equal(parsed.expiresIn, 3599);
  assert.match(parsed.scope, /drive\.file/);
  assert.equal(parsed.error, '');
});

test('ignores application fragments and empty hashes', () => {
  assert.equal(parseRedirectTokenResponse('#sign-in'), null);
  assert.equal(parseRedirectTokenResponse(''), null);
  assert.equal(parseRedirectTokenResponse(undefined), null);
  assert.equal(parseRedirectTokenResponse('#error=access_denied')?.error, 'access_denied');
});

test('consumes the redirect response and strips it from the URL', () => {
  const { replaceStateCalls } = setup();
  const parsed = consumeRedirectTokenResponse({ hash: '#access_token=ya29.token&expires_in=3600', pathname: '/secret_library/index.html', search: '?q=1' });
  assert.equal(parsed.accessToken, 'ya29.token');
  assert.deepEqual(replaceStateCalls, [[null, '', '/secret_library/index.html?q=1']]);
  const untouched = consumeRedirectTokenResponse({ hash: '#sign-in', pathname: '/secret_library/index.html', search: '' });
  assert.equal(untouched, null);
  assert.equal(replaceStateCalls.length, 1, 'application fragments must not be rewritten');
});

test('settles a returned redirect token into an active session', async () => {
  setup();
  const scope = encodeURIComponent('https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file');
  const parsed = consumeRedirectTokenResponse({ hash: `#access_token=redirect-token&expires_in=3600&scope=${scope}` });
  assert.ok(parsed);
  assert.equal(await settleRedirectResponse(), 'redirect-token');
  assert.equal(JSON.parse(window.sessionStorage.getItem('secret-library-google-session-v2')).accessToken, 'redirect-token');
  clearAccessToken();
});

test('rejects a redirect return that Google answered with an error', async () => {
  setup();
  consumeRedirectTokenResponse({ hash: '#error=access_denied' });
  await assert.rejects(settleRedirectResponse(), { code: 'redirect_denied' });
});

test('rejects a redirect token that omits the required Drive scopes', async () => {
  setup();
  consumeRedirectTokenResponse({ hash: '#access_token=partial-token&expires_in=3600&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.readonly%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.appdata' });
  await assert.rejects(settleRedirectResponse(), /Не все необходимые разрешения/);
  clearAccessToken();
});

test('Brave explicit sign-in uses the redirect ux mode with the registered redirect URI', async () => {
  const { clients } = setup({ brave: true });
  await initializeAuth();
  const pending = requestAccessToken({ prompt: 'select_account' });
  assert.equal(clients.length, 2);
  assert.equal(clients[0].requests.length, 0, 'the popup client must stay idle during a redirect sign-in');
  assert.equal(clients[1].ux_mode, 'redirect');
  assert.equal(clients[1].redirect_uri, 'https://tssrkt.github.io/secret_library/');
  assert.deepEqual(clients[1].requests, [{ prompt: 'consent select_account' }]);
  clients[1].callback({ access_token: 'redirect-client-token', expires_in: 3600 });
  assert.equal(await pending, 'redirect-client-token');
  clearAccessToken();
});

test('Brave silent renewal keeps using the popup client', async () => {
  const { clients } = setup({ brave: true });
  await initializeAuth();
  // A completed redirect sign-in marks the OAuth scope version as current.
  const first = requestAccessToken({ prompt: 'select_account' });
  clients[1].callback({ access_token: 'redirect-client-token', expires_in: 3600 });
  await first;
  clearAccessToken();
  const pending = requestAccessToken({ prompt: '' });
  assert.equal(clients.length, 2, 'silent renewal must not create a new client');
  assert.deepEqual(clients[0].requests, [{ prompt: '' }]);
  assert.equal(clients[1].requests.length, 1, 'the redirect client must stay idle during silent renewal');
  clients[0].callback({ access_token: 'silent-token', expires_in: 3600 });
  assert.equal(await pending, 'silent-token');
  clearAccessToken();
});

test('oauth_popup=1 forces the popup flow in Brave', async () => {
  const { clients } = setup({ brave: true, search: '?oauth_popup=1' });
  await initializeAuth();
  const pending = requestAccessToken({ prompt: 'select_account' });
  assert.equal(clients.length, 1, 'the override must not create a redirect client');
  assert.deepEqual(clients[0].requests, [{ prompt: 'consent select_account' }]);
  clients[0].callback({ access_token: 'popup-token', expires_in: 3600 });
  assert.equal(await pending, 'popup-token');
  clearAccessToken();
});

test('restored sessions are untouched by the redirect response parsing', async () => {
  setup();
  restoreAuthSession({ session: { getItem: () => JSON.stringify({ accessToken: 'saved', expiresAt: Date.now() + 3600000, user: {} }), removeItem: () => {} } });
  assert.equal(consumeRedirectTokenResponse({ hash: '#sign-in' }), null);
  assert.equal(await settleRedirectResponse(), null);
  clearAccessToken();
});

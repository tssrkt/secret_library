import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeRedirectTokenResponse, initializeAuth, oauthRedirectUri,
  parseRedirectTokenResponse, requestAccessToken, restoreAuthSession,
  clearAccessToken, settleRedirectResponse,
} from '../js/auth.js?v=20261114-brave-oauth2-redirect';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?';
const STATE_KEY = 'secret-library-oauth-state';

function setup({ brave = false, search = '', href = 'https://tssrkt.github.io/secret_library/index.html' } = {}) {
  const clients = [];
  const values = new Map();
  const replaceStateCalls = [];
  const assigns = [];
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
  globalThis.window = { sessionStorage: storage, localStorage: storage };
  globalThis.history = { state: null, replaceState: (...args) => replaceStateCalls.push(args) };
  globalThis.location = { href, pathname: '/secret_library/index.html', search, hash: '', assign: (url) => assigns.push(url) };
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
  return { clients, replaceStateCalls, assigns, storage };
}

function redirectParams(url) {
  return Object.fromEntries(new URLSearchParams(url.slice(AUTH_URL.length)));
}

const FULL_SCOPE = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';

test('oauthRedirectUri derives the directory URL with the trailing slash', () => {
  assert.equal(oauthRedirectUri('https://tssrkt.github.io/secret_library/index.html'), 'https://tssrkt.github.io/secret_library/');
  assert.equal(oauthRedirectUri('https://tssrkt.github.io/secret_library/'), 'https://tssrkt.github.io/secret_library/');
  assert.equal(oauthRedirectUri('http://localhost:8000/'), 'http://localhost:8000/');
  assert.equal(oauthRedirectUri('http://localhost:8000/index.html?q=1#h'), 'http://localhost:8000/');
  assert.equal(oauthRedirectUri(undefined), '');
});

test('parses a Google redirect token response from the URL fragment', () => {
  const parsed = parseRedirectTokenResponse('#access_token=ya29.token&token_type=Bearer&expires_in=3599&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.appdata&authuser=0&state=abc123');
  assert.equal(parsed.accessToken, 'ya29.token');
  assert.equal(parsed.expiresIn, 3599);
  assert.match(parsed.scope, /drive\.file/);
  assert.equal(parsed.state, 'abc123');
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
  assert.equal(parsed.stateValid, true, 'a response without a stored state is accepted to avoid a lockout');
  assert.deepEqual(replaceStateCalls, [[null, '', '/secret_library/index.html?q=1']]);
  const untouched = consumeRedirectTokenResponse({ hash: '#sign-in', pathname: '/secret_library/index.html', search: '' });
  assert.equal(untouched, null);
  assert.equal(replaceStateCalls.length, 1, 'application fragments must not be rewritten');
});

test('settles a returned redirect token into an active session', async () => {
  setup();
  const scope = encodeURIComponent(FULL_SCOPE);
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
  const scope = encodeURIComponent('https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata');
  consumeRedirectTokenResponse({ hash: `#access_token=partial-token&expires_in=3600&scope=${scope}` });
  await assert.rejects(settleRedirectResponse(), /Не все необходимые разрешения/);
  clearAccessToken();
});

test('rejects a redirect response whose state does not match the issued one', async () => {
  const { assigns } = setup({ brave: true });
  await initializeAuth();
  const pending = requestAccessToken({ prompt: 'select_account' });
  assert.equal(assigns.length, 1);
  const issuedState = redirectParams(assigns[0]).state;
  assert.match(issuedState, /^[0-9a-f]{32}$/);
  const scope = encodeURIComponent(FULL_SCOPE);
  consumeRedirectTokenResponse({ hash: `#access_token=forged-token&expires_in=3600&scope=${scope}&state=${issuedState}f` });
  await assert.rejects(settleRedirectResponse(), { code: 'redirect_state_mismatch' });
  clearAccessToken();
});

test('Brave explicit sign-in navigates top-level to the implicit OAuth URL', async () => {
  const { clients, assigns } = setup({ brave: true });
  await initializeAuth();
  const pending = requestAccessToken({ prompt: 'select_account' });
  assert.equal(clients.length, 1, 'no GIS redirect client is created');
  assert.equal(assigns.length, 1, 'a top-level navigation is started');
  const params = redirectParams(assigns[0]);
  assert.ok(assigns[0].startsWith(AUTH_URL));
  assert.equal(params.response_type, 'token');
  assert.equal(params.redirect_uri, 'https://tssrkt.github.io/secret_library/');
  assert.equal(params.prompt, 'consent select_account');
  assert.equal(params.include_granted_scopes, 'true');
  assert.match(params.scope, /drive\.file/);
  assert.ok(params.state, 'a CSRF state token is issued');
  assert.equal(window.sessionStorage.getItem(STATE_KEY), params.state);
  // The page unloads after navigation; the pending promise stays open.
  assert.equal(await Promise.race([pending.then(() => 'resolved', () => 'rejected'), 'pending']), 'pending');
  clearAccessToken();
});

test('redirect sign-in return with the issued state completes the session', async () => {
  const { assigns } = setup({ brave: true });
  await initializeAuth();
  requestAccessToken({ prompt: 'select_account' });
  const state = redirectParams(assigns[0]).state;
  const scope = encodeURIComponent(FULL_SCOPE);
  const parsed = consumeRedirectTokenResponse({ hash: `#access_token=redirect-client-token&expires_in=3600&scope=${scope}&state=${state}` });
  assert.equal(parsed.stateValid, true);
  assert.equal(await settleRedirectResponse(), 'redirect-client-token');
  assert.equal(window.sessionStorage.getItem(STATE_KEY), null, 'the issued state is single-use');
  clearAccessToken();
});

test('Brave silent renewal keeps using the popup client', async () => {
  const { clients, assigns } = setup({ brave: true });
  await initializeAuth();
  // A completed redirect sign-in marks the OAuth scope version as current.
  requestAccessToken({ prompt: 'select_account' });
  assert.equal(assigns.length, 1);
  const state = redirectParams(assigns[0]).state;
  const scope = encodeURIComponent(FULL_SCOPE);
  consumeRedirectTokenResponse({ hash: `#access_token=redirect-client-token&expires_in=3600&scope=${scope}&state=${state}` });
  await settleRedirectResponse();
  clearAccessToken();
  const pending = requestAccessToken({ prompt: '' });
  assert.equal(assigns.length, 1, 'silent renewal must not navigate away');
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0].requests, [{ prompt: '' }]);
  clients[0].callback({ access_token: 'silent-token', expires_in: 3600 });
  assert.equal(await pending, 'silent-token');
  clearAccessToken();
});

test('oauth_popup=1 forces the popup flow in Brave', async () => {
  const { clients, assigns } = setup({ brave: true, search: '?oauth_popup=1' });
  await initializeAuth();
  const pending = requestAccessToken({ prompt: 'select_account' });
  assert.equal(assigns.length, 0, 'the override must not navigate away');
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

import { DRIVE_SCOPES, GOOGLE_CLIENT_ID } from './config.js?v=20261108-drive-file-picker-folder-fix';
import { firebaseConfigured } from './firebase-config.js';

let accessToken = null;
let tokenClient = null;
let tokenExpiresAt = 0;
let pendingToken = null;
let pendingTokenPrompt = null;
let cancelPendingToken = null;
let renewalTimer;
let sessionUser = {};
let interactionRequired = false;
let tokenGeneration = 0;

function scheduleRenewal() {
  clearTimeout(renewalTimer);
  renewalTimer = setTimeout(() => { void renewAccessToken().catch(() => {}); }, Math.max(1000, tokenExpiresAt - Date.now() - 60000));
  renewalTimer.unref?.();
}

export async function renewAccessToken(rejectedToken = null) {
  if (rejectedToken && accessToken && rejectedToken !== accessToken) return accessToken;
  if (interactionRequired) throw Object.assign(new AuthError('Подключите Google снова, чтобы продолжить.', 'unauthorized'), { status: 401 });
  try { return await requestAccessToken({ prompt: '' }); }
  catch (cause) {
    interactionRequired = true;
    const error = Object.assign(new AuthError('Подключите Google снова, чтобы продолжить.', 'unauthorized'), { status: 401, cause });
    globalThis.window?.dispatchEvent(new Event('google-reconnect-required'));
    throw error;
  }
}

export async function ensureAccessToken() {
  if (!accessToken || tokenExpiresAt <= Date.now() + 60000) return renewAccessToken();
  return accessToken;
}

// Bump the session key when OAuth scopes change so a token issued with the old broad scope is never silently reused.
export const AUTH_SESSION_KEY = 'secret-library-google-session-v2';
export const AUTH_SCOPE_VERSION_KEY = 'secret-library-oauth-scope-version';
const CURRENT_AUTH_SCOPE_VERSION = 'drive-file-picker-v1';
export const PREVIOUS_SIGN_IN_KEY = 'secret-library-previous-sign-in';
export const PERSISTED_PROFILE_KEY = 'secret-library-persisted-profile';

function storageOrNull(name) {
  try { return window[name]; } catch { return null; }
}

const LEGACY_AUTH_SESSION_KEY = 'secret-library-google-session';

async function revokeLegacyOAuthGrant() {
  let current = false;
  try { current = storageOrNull('localStorage')?.getItem(AUTH_SCOPE_VERSION_KEY) === CURRENT_AUTH_SCOPE_VERSION; } catch { /* continue conservatively */ }
  if (current) return;
  let saved = null;
  try { saved = JSON.parse(storageOrNull('sessionStorage')?.getItem(LEGACY_AUTH_SESSION_KEY) || 'null'); } catch { /* stale session may be malformed */ }
  if (!saved?.accessToken || !globalThis.google?.accounts?.oauth2?.revoke) return;
  try {
    await new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, 5000);
      globalThis.google.accounts.oauth2.revoke(saved.accessToken, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  } catch { /* a later response.scope check prevents accepting the old broad grant */ }
  try { storageOrNull('sessionStorage')?.removeItem(LEGACY_AUTH_SESSION_KEY); } catch { /* optional cleanup */ }
}

export function persistAuthSession(user = {}, {
  session = storageOrNull('sessionStorage'), local = storageOrNull('localStorage'),
} = {}) {
  sessionUser = user;
  if (!accessToken || tokenExpiresAt <= Date.now()) return false;
  try {
    session?.setItem(AUTH_SESSION_KEY, JSON.stringify({ accessToken, expiresAt: tokenExpiresAt, user }));
    local?.setItem(PREVIOUS_SIGN_IN_KEY, '1');
    local?.setItem(PERSISTED_PROFILE_KEY, JSON.stringify({
      displayName: user.displayName || '',
      emailAddress: user.emailAddress || '',
      photoLink: user.photoLink || '',
    }));
    return true;
  } catch { return false; }
}

export function restoreAuthSession({ session = storageOrNull('sessionStorage'), now = Date.now() } = {}) {
  let saved;
  try { saved = JSON.parse(session?.getItem(AUTH_SESSION_KEY) || 'null'); } catch { saved = null; }
  clearTimeout(renewalTimer);
  sessionUser = saved?.user || {};
  interactionRequired = false;
  if (!saved?.accessToken || !Number.isFinite(saved.expiresAt) || saved.expiresAt <= now) {
    try { session?.removeItem(AUTH_SESSION_KEY); } catch { /* storage may be unavailable */ }
    accessToken = null;
    tokenExpiresAt = 0;
    return null;
  }
  accessToken = saved.accessToken;
  tokenExpiresAt = saved.expiresAt;
  sessionUser = saved.user || {};
  scheduleRenewal();
  return { expiresAt: saved.expiresAt, user: saved.user || {} };
}

export function hadPreviousSignIn({ local = storageOrNull('localStorage') } = {}) {
  try { return local?.getItem(PREVIOUS_SIGN_IN_KEY) === '1'; } catch { return false; }
}

export function clearPersistedAuth({
  forget = false, session = storageOrNull('sessionStorage'), local = storageOrNull('localStorage'),
} = {}) {
  try { session?.removeItem(AUTH_SESSION_KEY); } catch { /* storage may be unavailable */ }
  try {
    if (forget) {
      local?.removeItem(PREVIOUS_SIGN_IN_KEY);
      local?.removeItem(PERSISTED_PROFILE_KEY);
    }
  } catch { /* storage may be unavailable */ }
}

export function createAuthAttemptGuard() {
  let version = 0;
  return {
    begin: () => ++version,
    invalidate: () => { version += 1; },
    isCurrent: (request) => request === version,
  };
}

export async function recoverAuthSession({
  restore = restoreAuthSession,
} = {}) {
  // Never start an OAuth popup/silent request during page initialization.
  // A startup request can remain pending in Google Identity Services and then
  // be accidentally reused by the user's explicit sign-in click.
  const restored = restore();
  return restored ? { mode: 'session', ...restored } : null;
}

export class AuthError extends Error {
  constructor(message, code = 'auth_error', details = null) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    // Diagnostics must never contain OAuth tokens or full provider responses.
    this.details = details && typeof details === 'object' ? {
      provider: 'google-identity-services',
      ...details,
    } : null;
  }
}

function loadGoogleIdentity() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-google-identity]');
    const script = existing || document.createElement('script');
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', () => reject(new AuthError('Не удалось загрузить Google Identity Services.')), { once: true });
    if (!existing) {
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.dataset.googleIdentity = '';
      document.head.append(script);
    }
  });
}

export async function initializeAuth() {
  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.startsWith('PASTE_')) {
    throw new AuthError('Сначала укажите Google OAuth Client ID в js/config.js.', 'missing_client_id');
  }
  await loadGoogleIdentity();
  await revokeLegacyOAuthGrant();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: firebaseConfigured() ? `${DRIVE_SCOPES} openid email profile` : DRIVE_SCOPES,
    callback: () => {},
    error_callback: () => {},
  });
  // Decided once during initialization so requestAccessToken stays synchronous.
  redirectSignInEnabled = (await detectBraveBrowser()) && !popupOverrideRequested();
}

async function revokeOAuthToken(accessToken, timeoutMs = 5000) {
  const revoke = globalThis.google?.accounts?.oauth2?.revoke;
  if (typeof revoke !== 'function') throw new AuthError('Google не предоставил API для отзыва старого разрешения.', 'revoke_unavailable');
  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AuthError('Google не подтвердил отзыв старого разрешения за отведённое время. Повторите вход позже.', 'revoke_timeout'));
    }, timeoutMs);
    try {
      revoke(accessToken, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (response?.successful === false || response?.error) {
          reject(new AuthError('Google не подтвердил отзыв старого разрешения.', 'revoke_failed'));
          return;
        }
        resolve();
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new AuthError('Не удалось отозвать старое разрешение Google. Повторите вход.', 'revoke_failed'));
    }
  });
}

// Shared acceptance path for popup callbacks and redirect returns: validates
// the granted scopes, activates the session and schedules the renewal.
async function acceptTokenResponse(response) {
  if (response.error || !response.access_token) {
    throw new AuthError('Google authorization did not finish. Please try again.', response.error || 'no_token');
  }
  if (typeof response.scope === 'string') {
    const grantedScopes = new Set(response.scope.split(/\s+/));
    if (grantedScopes.has('https://www.googleapis.com/auth/drive')) {
      try {
        await revokeOAuthToken(response.access_token);
      } catch (error) {
        try { storageOrNull('localStorage')?.removeItem(AUTH_SCOPE_VERSION_KEY); } catch { /* consent is still required on the next attempt */ }
        throw new AuthError('Google вернул старое широкое разрешение, но его отзыв не подтверждён. ' + error.message, error.code || 'revoke_failed');
      }
      try { storageOrNull('localStorage')?.removeItem(AUTH_SCOPE_VERSION_KEY); } catch { /* consent is still required on the next attempt */ }
      throw new AuthError('Старое широкое разрешение Google отозвано. Повторите вход, чтобы выдать только необходимые разрешения.', 'broad_scope_revoked');
    }
    const missingScopes = DRIVE_SCOPES.split(/\s+/).filter((scope) => !grantedScopes.has(scope));
    if (missingScopes.length) {
      try { await revokeOAuthToken(response.access_token); }
      catch (error) {
        throw new AuthError('Выданы не все необходимые разрешения Google Drive, а отзыв частичного разрешения не подтверждён. ' + error.message, error.code || 'revoke_failed');
      }
      throw new AuthError('Не все необходимые разрешения Google Drive были предоставлены. Повторите вход и разрешите чтение библиотеки, appData и доступ к выбранным через Picker объектам.', 'missing_scopes');
    }
  }
  accessToken = response.access_token;
  tokenExpiresAt = Date.now() + Math.max(0, Number(response.expires_in) || 3600) * 1000;
  interactionRequired = false;
  try { storageOrNull('localStorage')?.setItem(AUTH_SCOPE_VERSION_KEY, CURRENT_AUTH_SCOPE_VERSION); } catch { /* session still works without persistent storage */ }
  persistAuthSession(sessionUser);
  scheduleRenewal();
  return accessToken;
}

function requestAccessTokenViaRedirect(effectivePrompt, options) {
  if (!tokenClient) return Promise.reject(new AuthError('Google OAuth is not initialized.'));
  // GIS token model (initTokenClient) cannot do a redirect UX: ux_mode and
  // redirect_uri are code-model-only, so the implicit authorization URL is
  // built directly and navigated top-level. A top-level Google page is
  // first-party in Brave and is not isolated in ephemeral storage, unlike the
  // GIS popup.
  const state = randomOAuthState();
  try { storageOrNull('sessionStorage')?.setItem(OAUTH_STATE_KEY, state); } catch { /* the state check degrades gracefully without storage */ }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    response_type: 'token',
    scope: firebaseConfigured() ? `${DRIVE_SCOPES} openid email profile` : DRIVE_SCOPES,
    redirect_uri: oauthRedirectUri(),
    prompt: effectivePrompt,
    include_granted_scopes: 'true',
    state,
  });
  if (options.login_hint) params.set('login_hint', options.login_hint);
  try { globalThis.location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString()); }
  catch (error) { return Promise.reject(error); }
  // The navigation unloads this page, so the promise normally never settles.
  // The timeout only matters when the navigation itself fails to start.
  return new Promise((_resolve, reject) => {
    const startedAt = Date.now();
    const timer = setTimeout(() => reject(new AuthError(
      'Google не завершил вход через перенаправление за 60 секунд (auth_timeout). Проверьте, не осталось ли окно входа открытым, затем повторите попытку.',
      'auth_timeout', { prompt: effectivePrompt, elapsedMs: Date.now() - startedAt, phase: 'redirect' },
    )), 60000);
    timer.unref?.();
  });
}

export function requestAccessToken({ prompt = 'consent' } = {}) {
  if (!tokenClient) return Promise.reject(new AuthError('Google OAuth is not initialized.'));
  let scopeVersionCurrent = false;
  try { scopeVersionCurrent = storageOrNull('localStorage')?.getItem(AUTH_SCOPE_VERSION_KEY) === CURRENT_AUTH_SCOPE_VERSION; } catch { /* require consent when storage is unavailable */ }
  const effectivePrompt = scopeVersionCurrent ? prompt : (prompt === 'select_account' ? 'consent select_account' : 'consent');
  if (pendingToken) {
    // An explicit account choice must not reuse a pending silent renewal.
    if (prompt === 'select_account' && pendingTokenPrompt !== 'select_account') {
      tokenGeneration += 1;
      cancelPendingToken?.(new AuthError('Automatic authorization was replaced by account selection.', 'cancelled'));
      // Isolate the interactive request from late callbacks of the old client.
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: firebaseConfigured() ? `${DRIVE_SCOPES} openid email profile` : DRIVE_SCOPES,
        callback: () => {},
        error_callback: () => {},
      });
      pendingToken = null;
      pendingTokenPrompt = null;
      cancelPendingToken = null;
    } else return pendingToken;
  }
  const options = { prompt: effectivePrompt };
  if (!effectivePrompt.split(/\s+/).includes('select_account') && sessionUser.emailAddress) options.login_hint = sessionUser.emailAddress;
  if (redirectSignInEnabled && isExplicitPrompt(effectivePrompt)) {
    return requestAccessTokenViaRedirect(effectivePrompt, options);
  }
  const generation = tokenGeneration;
  let promise;
  promise = new Promise((resolve, reject) => {
    let settled = false;
    let popupErrorTimer;
    const startedAt = Date.now();
    const timer = setTimeout(() => fail(new AuthError(
      'Google не завершил авторизацию за 60 секунд (auth_timeout). Проверьте, не осталось ли окно входа открытым или заблокированным браузером, затем повторите попытку.',
      'auth_timeout', { prompt: effectivePrompt, elapsedMs: Date.now() - startedAt },
    )), 60000);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(popupErrorTimer);
      reject(error);
    };
    cancelPendingToken = fail;
    tokenClient.callback = async (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(popupErrorTimer);
      if (generation !== tokenGeneration) { reject(new AuthError('Sign-in cancelled.', 'cancelled')); return; }
      try { resolve(await acceptTokenResponse(response)); }
      catch (error) { reject(error); }
    };
    tokenClient.error_callback = (error) => {
      // GIS may report a popup/COOP error just before delivering the token response.
      // Give the success callback a short grace period so a completed consent is not rejected.
      clearTimeout(popupErrorTimer);
      const type = typeof error?.type === 'string' ? error.type.slice(0, 80) : 'unknown';
      popupErrorTimer = setTimeout(() => {
        fail(new AuthError(
          `Google OAuth не вернул токен (popup error: ${type}; code: oauth_popup_error). Проверьте блокировку всплывающих окон и повторите вход в том же окне сайта.`,
          type, { prompt: effectivePrompt, elapsedMs: Date.now() - startedAt, phase: 'oauth_popup' },
        ));
      }, 1500);
    };
    try {
      // login_hint can bypass account selection even with select_account.
      tokenClient.requestAccessToken(options);
    } catch (error) { fail(error); }
  });
  pendingToken = promise;
  pendingTokenPrompt = prompt;
  promise.finally(() => {
    if (pendingToken === promise) {
      pendingToken = null;
      pendingTokenPrompt = null;
      cancelPendingToken = null;
    }
  }).catch(() => {});
  return promise;
}

export function getAccessToken() {
  return accessToken;
}

// Brave blocks third-party cookies and isolates the Google sign-in popup in
// ephemeral storage, so the GIS popup cannot see the Google session and the
// sign-in stalls ("You must sign in to access this content"). A top-level
// redirect to Google is first-party navigation and is not isolated.
let redirectSignInEnabled = false;

async function detectBraveBrowser() {
  try {
    const brave = globalThis.navigator?.brave;
    if (!brave || typeof brave.isBrave !== 'function') return false;
    return Boolean(await brave.isBrave());
  } catch { return false; }
}

// Escape hatch: if Google rejects the redirect configuration, a page URL with
// ?oauth_popup=1 forces the legacy popup flow instead of the redirect.
function popupOverrideRequested(search = globalThis.location?.search) {
  try { return new URLSearchParams(search).get('oauth_popup') === '1'; } catch { return false; }
}

export function oauthRedirectUri(href = globalThis.location?.href) {
  if (!href) return '';
  try { return new URL('.', href).href; } catch { return ''; }
}

function isExplicitPrompt(effectivePrompt) {
  const parts = String(effectivePrompt || '').split(/\s+/);
  return parts.includes('consent') || parts.includes('select_account');
}

const OAUTH_STATE_KEY = 'secret-library-oauth-state';

function randomOAuthState() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Google returns the redirect token response in the URL fragment. Parsing must
// happen before Google Identity Services loads, so Google cannot consume the
// response a second time.
export function parseRedirectTokenResponse(hash) {
  if (typeof hash !== 'string' || !hash) return null;
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const accessToken = params.get('access_token');
  const error = params.get('error');
  if (!accessToken && !error) return null;
  return {
    accessToken,
    expiresIn: Math.max(0, Number(params.get('expires_in')) || 3600),
    scope: params.get('scope') || '',
    state: params.get('state') || '',
    error: error || '',
  };
}

let pendingRedirectResponse = null;

export function consumeRedirectTokenResponse({
  hash = globalThis.location?.hash,
  pathname = globalThis.location?.pathname,
  search = globalThis.location?.search,
  historyObj = globalThis.history,
  session = storageOrNull('sessionStorage'),
} = {}) {
  pendingRedirectResponse = null;
  const parsed = parseRedirectTokenResponse(hash);
  if (!parsed) return null;
  // Strip the OAuth response from the URL immediately; tokens in the
  // address bar must not linger or survive a share/copy.
  try { historyObj?.replaceState(historyObj.state, '', pathname + search); } catch { /* keep the fragment; the app still works */ }
  let storedState = null;
  try { storedState = session?.getItem(OAUTH_STATE_KEY); session?.removeItem(OAUTH_STATE_KEY); } catch { /* state check degrades gracefully */ }
  // A state set by this tab must come back unchanged; without a stored state
  // (cleared storage) the response is still accepted to avoid a lockout.
  parsed.stateValid = !storedState || !parsed.state || parsed.state === storedState;
  pendingRedirectResponse = parsed;
  return parsed;
}

export async function settleRedirectResponse() {
  const parsed = pendingRedirectResponse;
  pendingRedirectResponse = null;
  if (!parsed) return null;
  if (!parsed.stateValid) {
    throw new AuthError(
      'Google вернул вход с неверным идентификатором запроса. Повторите попытку входа.',
      'redirect_state_mismatch',
    );
  }
  if (parsed.error || !parsed.accessToken) {
    throw new AuthError(
      'Google не завершил вход после перенаправления. Повторите попытку входа.',
      parsed.error ? 'redirect_denied' : 'redirect_no_token',
      { code: parsed.error ? parsed.error.slice(0, 80) : 'missing_token' },
    );
  }
  await acceptTokenResponse({ access_token: parsed.accessToken, expires_in: parsed.expiresIn, scope: parsed.scope });
  return getAccessToken();
}

export function getSessionUserEmail() {
  return typeof sessionUser?.emailAddress === 'string' ? sessionUser.emailAddress.trim().toLowerCase() : '';
}

export function clearAccessToken({ revoke = false } = {}) {
  tokenGeneration += 1;
  clearTimeout(renewalTimer);
  interactionRequired = false;
  sessionUser = {};
  const token = accessToken;
  accessToken = null;
  tokenExpiresAt = 0;
  if (revoke && token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token);
}

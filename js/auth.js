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
  constructor(message, code = 'auth_error') {
    super(message);
    this.name = 'AuthError';
    this.code = code;
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
  const generation = tokenGeneration;
  let promise;
  promise = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(new AuthError('Google did not complete authorization.', 'auth_timeout')), 60000);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    cancelPendingToken = fail;
    tokenClient.callback = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (generation !== tokenGeneration) { reject(new AuthError('Sign-in cancelled.', 'cancelled')); return; }
      if (response.error || !response.access_token) {
        reject(new AuthError('Google authorization did not finish. Please try again.', response.error));
        return;
      }
      if (typeof response.scope === 'string') {
        const grantedScopes = new Set(response.scope.split(/\s+/));
        if (grantedScopes.has('https://www.googleapis.com/auth/drive')) {
          try { google.accounts.oauth2.revoke(response.access_token, () => {}); } catch { /* force a fresh consent on the next attempt */ }
          try { storageOrNull('localStorage')?.removeItem(AUTH_SCOPE_VERSION_KEY); } catch { /* consent is still required on the next attempt */ }
          reject(new AuthError('Google still returned the old broad Drive permission. A revocation was requested; sign in again to complete the permission reduction.'));
          return;
        }
        const missingScopes = DRIVE_SCOPES.split(/\s+/).filter((scope) => !grantedScopes.has(scope));
        if (missingScopes.length) {
          try { google.accounts.oauth2.revoke(response.access_token, () => {}); } catch { /* do not retain a partial token */ }
          reject(new AuthError('Не все необходимые разрешения Google Drive были предоставлены. Повторите вход и разрешите чтение библиотеки, appData и доступ к выбранным через Picker объектам.'));
          return;
        }
      }
      accessToken = response.access_token;
      tokenExpiresAt = Date.now() + Math.max(0, Number(response.expires_in) || 3600) * 1000;
      interactionRequired = false;
      try { storageOrNull('localStorage')?.setItem(AUTH_SCOPE_VERSION_KEY, CURRENT_AUTH_SCOPE_VERSION); } catch { /* session still works without persistent storage */ }
      persistAuthSession(sessionUser);
      scheduleRenewal();
      resolve(accessToken);
    };
    tokenClient.error_callback = (error) => fail(new AuthError('The authorization window was closed or sign-in was cancelled.', error?.type || 'popup_closed'));
    try {
      // login_hint can bypass account selection even with select_account.
      const options = { prompt: effectivePrompt };
      if (!effectivePrompt.split(/\s+/).includes('select_account') && sessionUser.emailAddress) options.login_hint = sessionUser.emailAddress;
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

import { DRIVE_SCOPES, GOOGLE_CLIENT_ID } from './config.js';
import { firebaseConfigured } from './firebase-config.js';

let accessToken = null;
let tokenClient = null;
let tokenExpiresAt = 0;
let pendingToken = null;
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

export const AUTH_SESSION_KEY = 'secret-library-google-session';
export const PREVIOUS_SIGN_IN_KEY = 'secret-library-previous-sign-in';

function storageOrNull(name) {
  try { return window[name]; } catch { return null; }
}

export function persistAuthSession(user = {}, {
  session = storageOrNull('sessionStorage'), local = storageOrNull('localStorage'),
} = {}) {
  sessionUser = user;
  if (!accessToken || tokenExpiresAt <= Date.now()) return false;
  try {
    session?.setItem(AUTH_SESSION_KEY, JSON.stringify({ accessToken, expiresAt: tokenExpiresAt, user }));
    local?.setItem(PREVIOUS_SIGN_IN_KEY, '1');
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
  try { if (forget) local?.removeItem(PREVIOUS_SIGN_IN_KEY); } catch { /* storage may be unavailable */ }
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
  previous = hadPreviousSignIn,
  request = requestAccessToken,
} = {}) {
  const restored = restore();
  if (restored) return { mode: 'session', ...restored };
  if (!previous()) return null;
  try {
    await request({ prompt: '' });
    return { mode: 'silent', user: null };
  } catch {
    return null;
  }
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
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: firebaseConfigured() ? `${DRIVE_SCOPES} openid email profile` : DRIVE_SCOPES,
    callback: () => {},
    error_callback: () => {},
  });
}

export function requestAccessToken({ prompt = 'consent' } = {}) {
  if (!tokenClient) return Promise.reject(new AuthError('Google OAuth еще не инициализирован.'));
  if (pendingToken) return pendingToken;
  const generation = tokenGeneration;
  pendingToken = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(new AuthError('Google не завершил подключение.', 'auth_timeout')), 60000);
    const fail = (error) => { settled = true; clearTimeout(timer); reject(error); };
    tokenClient.callback = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (generation !== tokenGeneration) { reject(new AuthError('Вход отменён.', 'cancelled')); return; }
      if (response.error || !response.access_token) {
        reject(new AuthError('Авторизация Google не завершена. Попробуйте войти еще раз.', response.error));
        return;
      }
      accessToken = response.access_token;
      tokenExpiresAt = Date.now() + Math.max(0, Number(response.expires_in) || 3600) * 1000;
      interactionRequired = false;
      persistAuthSession(sessionUser);
      scheduleRenewal();
      resolve(accessToken);
    };
    tokenClient.error_callback = (error) => fail(new AuthError('Окно авторизации было закрыто или вход отменен.', error?.type || 'popup_closed'));
    try { tokenClient.requestAccessToken({ prompt, ...(sessionUser.emailAddress ? { login_hint: sessionUser.emailAddress } : {}) }); }
    catch (error) { fail(error); }
  }).finally(() => { pendingToken = null; });
  return pendingToken;
}

export function getAccessToken() {
  return accessToken;
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

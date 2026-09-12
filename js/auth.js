import { DRIVE_SCOPES, GOOGLE_CLIENT_ID } from './config.js';

let accessToken = null;
let tokenClient = null;

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
    scope: DRIVE_SCOPES,
    callback: () => {},
    error_callback: () => {},
  });
}

export function requestAccessToken({ prompt = 'consent' } = {}) {
  if (!tokenClient) return Promise.reject(new AuthError('Google OAuth еще не инициализирован.'));

  return new Promise((resolve, reject) => {
    tokenClient.callback = (response) => {
      if (response.error) {
        reject(new AuthError('Авторизация Google не завершена. Попробуйте войти еще раз.', response.error));
        return;
      }
      accessToken = response.access_token;
      resolve(accessToken);
    };
    tokenClient.error_callback = () => reject(new AuthError('Окно авторизации было закрыто или вход отменен.', 'popup_closed'));
    tokenClient.requestAccessToken({ prompt });
  });
}

export function getAccessToken() {
  return accessToken;
}

export function clearAccessToken({ revoke = false } = {}) {
  const token = accessToken;
  accessToken = null;
  if (revoke && token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token);
}

import { FOLDER_MIME_TYPE, GOOGLE_CLOUD_PROJECT_NUMBER, GOOGLE_PICKER_API_KEY } from './config.js';
import { ensureAccessToken, getSessionUserEmail } from './auth.js?v=20261114-brave-oauth2-redirect';

let pickerLoadPromise = null;
export const DRIVE_ITEM_AUTHORIZATION_MARKER_PREFIX = 'secret-library-drive-file-authorized-v2:';

// Brave blocks third-party storage for the Google Picker iframe, so the Picker
// shows "Sign in — You must sign in to access this content" instead of files.
// There is no code-side alternative under drive.file: the user must allow
// Google sign-in or all cookies for this site, then retry.
let braveFlag = false;
const bravePromise = (async () => {
  try {
    const brave = globalThis.navigator?.brave;
    if (brave && typeof brave.isBrave === 'function') braveFlag = Boolean(await brave.isBrave());
  } catch { /* non-Brave browsers without navigator.brave */ }
  return braveFlag;
})();

export function isBraveBrowserSync() {
  return braveFlag;
}

export const BRAVE_PICKER_HINT = 'Похоже, Brave блокирует вход Google в этом окне. Щёлкните иконку щита Brave в адресной строке и разрешите «Google Sign-In» или все файлы cookie для этого сайта, затем повторите действие.';

function pickerProviderCode(data) {
  const candidates = [data?.error?.code, data?.error?.status, data?.error?.type, data?.errorCode, data?.code];
  for (const value of candidates) {
    const code = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    if (/^[A-Za-z0-9_.:-]{1,80}$/.test(code)) return code;
  }
  return '';
}

function authorizationMarkerKey(id) {
  return DRIVE_ITEM_AUTHORIZATION_MARKER_PREFIX + encodeURIComponent(getSessionUserEmail()) + ':' + id;
}

function hasAuthorizationMarker(id) {
  try { return Boolean(getSessionUserEmail()) && globalThis.localStorage?.getItem(authorizationMarkerKey(id)) === '1'; } catch { return false; }
}

export function rememberDriveItemAuthorization(id) {
  if (!id || !getSessionUserEmail()) return;
  try { globalThis.localStorage?.setItem(authorizationMarkerKey(id), '1'); } catch { /* marker is only an optimization */ }
}

// A Picker selection is not proof that Drive accepted a later API operation.
// Forget the optimization after a 403 so the next attempt can ask again.
export function forgetDriveItemAuthorization(id) {
  if (!id || !getSessionUserEmail()) return;
  try { globalThis.localStorage?.removeItem(authorizationMarkerKey(id)); } catch { /* marker is only an optimization */ }
}

// Restrict the Picker to the exact item chosen through the app UI. Never expose
// a browseable list of other Drive folders during this authorization step.
export function configureDrivePickerView(view, { id, mimeType = '', isFolder = false, restrictToId = true } = {}) {
  if (!id) throw new Error('Не удалось определить объект Google Drive для авторизации.');
  if (restrictToId) {
    if (typeof view?.setFileIds !== 'function') throw new Error('Google Picker не поддерживает выбор объекта по точному идентификатору.');
    view.setFileIds(id);
  }
  if (isFolder) view.setSelectFolderEnabled(true);
  else if (mimeType) view.setMimeTypes(mimeType);
  return view;
}

export function readPickerResponse(data, picker) {
  const response = picker?.Response || {};
  const rawAction = data?.[response.ACTION || 'action'] ?? data?.action;
  const action = typeof rawAction === 'string' ? rawAction.trim().toLowerCase() : '';
  const rawDocs = data?.[response.DOCUMENTS || 'docs'] ?? data?.docs;
  const docs = Array.isArray(rawDocs) ? rawDocs : [];
  const actionValue = (name) => String(picker?.Action?.[name] ?? name).trim().toLowerCase();
  return {
    action,
    docs,
    picked: action === actionValue('PICKED'),
    cancelled: action === actionValue('CANCEL'),
    failed: action === actionValue('ERROR') || action === 'error',
  };
}

export function assertDrivePickerSelection(selected, expectedId, name = '') {
  if (!selected || selected.id !== expectedId) {
    throw new Error('Выбран другой объект. Закройте окно и выберите «' + (name || 'нужный объект') + '» с тем же идентификатором.');
  }
  return selected;
}

function loadPickerApi() {
  if (globalThis.google?.picker?.PickerBuilder) return Promise.resolve();
  if (pickerLoadPromise) return pickerLoadPromise;
  pickerLoadPromise = new Promise((resolve, reject) => {
    const done = () => {
      if (!globalThis.gapi?.load) {
        reject(new Error('Google Picker API не загрузился.'));
        return;
      }
      globalThis.gapi.load('picker', {
        callback: () => globalThis.google?.picker?.PickerBuilder
          ? resolve()
          : reject(new Error('Google Picker API недоступен.')),
        onerror: () => reject(new Error('Не удалось загрузить Google Picker API.')),
        timeout: 15000,
        ontimeout: () => reject(new Error('Google Picker API не ответил вовремя.')),
      });
    };
    const existing = document.querySelector('script[data-google-picker-api]');
    if (existing) {
      if (globalThis.gapi?.load) done();
      else {
        existing.addEventListener('load', done, { once: true });
        existing.addEventListener('error', () => reject(new Error('Не удалось загрузить Google Picker API.')), { once: true });
      }
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true;
    script.defer = true;
    script.dataset.googlePickerApi = '';
    script.addEventListener('load', done, { once: true });
    script.addEventListener('error', () => reject(new Error('Не удалось загрузить Google Picker API.')), { once: true });
    document.head.append(script);
  }).catch((error) => {
    pickerLoadPromise = null;
    throw error;
  });
  return pickerLoadPromise;
}

/**
 * Authorize one exact Drive item for drive.file by asking the user to select it
 * in Google Picker. This intentionally does not infer access to descendants.
 */
export async function authorizeDriveItem({ id, name = '', mimeType = '', isFolder = false } = {}) {
  if (!id) throw new Error('Не удалось определить объект Google Drive для авторизации.');
  if (!GOOGLE_PICKER_API_KEY) {
    throw new Error('Для безопасной авторизации Google Picker нужно настроить GOOGLE_PICKER_API_KEY в js/config.js. До этого операции изменения файлов отключены.');
  }
  await loadPickerApi();
  const token = await ensureAccessToken();
  const picker = globalThis.google.picker;
  const view = new picker.DocsView(isFolder ? picker.ViewId.FOLDERS : picker.ViewId.DOCS);
  // drive.file does not grant thumbnail access. Google's Picker guidance recommends
  // list mode for this scope; it also avoids preview loading interfering with selection.
  if (picker.DocsViewMode?.LIST && typeof view.setMode === 'function') {
    view.setMode(picker.DocsViewMode.LIST);
  }
  if (isFolder && typeof view.setIncludeFolders === 'function') view.setIncludeFolders(true);
  // Never search by name: duplicate names are common in Drive. Restrict the view
  // to the exact target ID and retain the callback ID check as a second safeguard.
  configureDrivePickerView(view, { id, mimeType, isFolder, restrictToId: true });

  return new Promise((resolve, reject) => {
    let settled = false;
    let selectionTimer;
    let callbackCount = 0;
    let lastAction = 'none';
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(selectionTimer);
      if (error) reject(error); else resolve(value);
    };
    selectionTimer = setTimeout(() => {
      const callbackState = callbackCount ? lastAction : 'no_callback';
      const hint = isBraveBrowserSync() ? ` ${BRAVE_PICKER_HINT}` : '';
      finish(null, Object.assign(new Error(`Google Picker не завершил выбор за 45 секунд (code: picker_selection_timeout; callback: ${callbackState}). Закройте окно, проверьте доступ к Google Drive и попробуйте ещё раз.${hint}`), {
        code: 'picker_selection_timeout', details: { timeoutMs: 45000, isFolder, callbackCount, lastAction },
      }));
    }, 45000);
    const builder = new picker.PickerBuilder()
      .setAppId(GOOGLE_CLOUD_PROJECT_NUMBER)
      .setDeveloperKey(GOOGLE_PICKER_API_KEY)
      .setOAuthToken(token)
      .setOrigin(window.location.protocol + '//' + window.location.host)
      .setTitle(isFolder
        ? 'Подтвердите доступ к выбранной папке'
        : 'Подтвердите доступ к существующему файлу')
      .addView(view)
      .setCallback((data) => {
        callbackCount += 1;
        const response = readPickerResponse(data, picker);
        lastAction = response.action || 'missing_action';
        if (!response.action) {
          finish(null, new Error('Google Picker вернул ответ без действия (code: picker_invalid_response). Повторите выбор папки или файла.'));
          return;
        }
        if (response.cancelled) {
          finish(false);
          return;
        }
        if (response.failed) {
          const providerCode = pickerProviderCode(data);
          // Log only stable error codes, never the full provider payload or OAuth token.
          console.warn('[Secret Library] Google Picker error', {
            action: response.action,
            providerCode: providerCode || 'not-provided',
            isFolder,
          });
          const diagnostic = providerCode ? `; provider: ${providerCode}` : '';
          const hint = isBraveBrowserSync() ? ` ${BRAVE_PICKER_HINT}` : '';
          finish(null, Object.assign(new Error(`Google Picker сообщил об ошибке (code: picker_callback_error${diagnostic}). Проверьте доступ к Google Drive и ограничения API key.${hint}`), {
            code: 'picker_callback_error', details: { action: response.action, providerCode: providerCode || null, isFolder },
          }));
          return;
        }
        // LOADED and other non-terminal lifecycle events are expected; keep waiting for PICKED/CANCEL.
        if (!response.picked) return;
        const selected = response.docs[0];
        if (!selected) {
          finish(false);
          return;
        }
        try { assertDrivePickerSelection(selected, id, name); }
        catch (error) { finish(null, error); return; }
        rememberDriveItemAuthorization(id);
        finish(true);
      });
    try {
      builder.build().setVisible(true);
    } catch (error) {
      const detail = typeof error?.message === 'string' ? error.message.slice(0, 160) : 'unknown';
      finish(null, Object.assign(new Error('Не удалось открыть Google Picker (code: picker_build_failed): ' + detail), {
        code: 'picker_build_failed', details: { isFolder },
      }));
    }
  });
}

export async function ensureDriveItemAuthorized(item = {}) {
  if (hasAuthorizationMarker(item.id)) return true;
  const authorized = await authorizeDriveItem(item);
  if (!authorized) throw new Error('Авторизация объекта отменена. Выберите объект и подтвердите его в Google Picker.');
  return true;
}

export async function authorizeDriveFolder(folder) {
  const authorized = await authorizeDriveItem({
    id: folder?.id, name: folder?.name, mimeType: FOLDER_MIME_TYPE, isFolder: true,
  });
  if (!authorized) throw new Error('Авторизация папки отменена. Выберите папку и подтвердите её в Google Picker.');
  return true;
}

export async function ensureDriveFolderAuthorized(folder) {
  return ensureDriveItemAuthorized({
    id: folder?.id, name: folder?.name, mimeType: FOLDER_MIME_TYPE, isFolder: true,
  });
}

/**
 * Let the user pick any library root folder in one Google Picker window.
 * Unlike authorizeDriveItem, the view starts at My Drive and navigation stays
 * open: eligibility (Drive root parent, minimum books) is validated by the
 * caller after the pick, so the Picker itself needs no fixed target ID.
 */
export async function pickDriveFolder({ title = 'Выберите корневую папку библиотеки' } = {}) {
  if (!GOOGLE_PICKER_API_KEY) {
    throw new Error('Для безопасной авторизации Google Picker нужно настроить GOOGLE_PICKER_API_KEY в js/config.js. До этого операции изменения файлов отключены.');
  }
  await loadPickerApi();
  const token = await ensureAccessToken();
  const picker = globalThis.google.picker;
  const view = new picker.DocsView(picker.ViewId.FOLDERS);
  // drive.file does not grant thumbnail access; keep the same list-mode and
  // folder-inclusion settings as the authorization Picker.
  if (picker.DocsViewMode?.LIST && typeof view.setMode === 'function') {
    view.setMode(picker.DocsViewMode.LIST);
  }
  if (typeof view.setIncludeFolders === 'function') view.setIncludeFolders(true);
  if (typeof view.setSelectFolderEnabled === 'function') view.setSelectFolderEnabled(true);
  // Start inside My Drive; a nested-folder pick is rejected by the caller.
  if (typeof view.setParent === 'function') view.setParent('root');

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    // No selection timeout here: the user may browse Drive for as long as they
    // need. Only terminal callback actions (PICKED/CANCEL/ERROR) end the wait.
    const builder = new picker.PickerBuilder()
      .setAppId(GOOGLE_CLOUD_PROJECT_NUMBER)
      .setDeveloperKey(GOOGLE_PICKER_API_KEY)
      .setOAuthToken(token)
      .setOrigin(window.location.protocol + '//' + window.location.host)
      .setTitle(title)
      .addView(view);
    // Hiding the navigation pane keeps the Picker inside My Drive views.
    if (picker.Feature?.NAV_HIDDEN) builder.enableFeature(picker.Feature.NAV_HIDDEN);
    builder.setCallback((data) => {
      const response = readPickerResponse(data, picker);
      if (!response.action) {
        finish(null, new Error('Google Picker вернул ответ без действия (code: picker_invalid_response). Повторите выбор папки.'));
        return;
      }
      if (response.cancelled) {
        finish(null);
        return;
      }
      if (response.failed) {
        const providerCode = pickerProviderCode(data);
        // Log only stable error codes, never the full provider payload or OAuth token.
        console.warn('[Secret Library] Google Picker error', {
          action: response.action,
          providerCode: providerCode || 'not-provided',
          isFolder: true,
        });
        const diagnostic = providerCode ? `; provider: ${providerCode}` : '';
        const hint = isBraveBrowserSync() ? ` ${BRAVE_PICKER_HINT}` : '';
        finish(null, Object.assign(new Error(`Google Picker сообщил об ошибке (code: picker_callback_error${diagnostic}). Проверьте доступ к Google Drive и ограничения API key.${hint}`), {
          code: 'picker_callback_error', details: { action: response.action, providerCode: providerCode || null, isFolder: true },
        }));
        return;
      }
      // LOADED and other non-terminal lifecycle events are expected; keep waiting for PICKED/CANCEL.
      if (!response.picked) return;
      const selected = response.docs[0];
      if (!selected?.id) {
        finish(null, new Error('Google Picker вернул выбор без идентификатора папки. Повторите выбор.'));
        return;
      }
      rememberDriveItemAuthorization(selected.id);
      finish({ id: selected.id, name: selected.name || '', resourceKey: selected.resourceKey || '' });
    });
    try {
      builder.build().setVisible(true);
    } catch (error) {
      const detail = typeof error?.message === 'string' ? error.message.slice(0, 160) : 'unknown';
      finish(null, Object.assign(new Error('Не удалось открыть Google Picker (code: picker_build_failed): ' + detail), {
        code: 'picker_build_failed', details: { isFolder: true },
      }));
    }
  });
}

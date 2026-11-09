import { FOLDER_MIME_TYPE, GOOGLE_CLOUD_PROJECT_NUMBER, GOOGLE_PICKER_API_KEY } from './config.js';
import { ensureAccessToken, getSessionUserEmail } from './auth.js?v=20261108-drive-file-picker-folder-fix';

let pickerLoadPromise = null;
const AUTHORIZED_ITEM_PREFIX = 'secret-library-drive-file-authorized-v1:';

function authorizationMarkerKey(id) {
  return AUTHORIZED_ITEM_PREFIX + encodeURIComponent(getSessionUserEmail()) + ':' + id;
}

function hasAuthorizationMarker(id) {
  try { return Boolean(getSessionUserEmail()) && globalThis.localStorage?.getItem(authorizationMarkerKey(id)) === '1'; } catch { return false; }
}

export function rememberDriveItemAuthorization(id) {
  if (!id || !getSessionUserEmail()) return;
  try { globalThis.localStorage?.setItem(authorizationMarkerKey(id), '1'); } catch { /* marker is only an optimization */ }
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
  if (isFolder) {
    // ViewId.FOLDERS already filters to folders. Do not override that view with
    // setMimeTypes: Picker can otherwise fall back to ordinary files (for example JSON).
    view.setSelectFolderEnabled(true);
  } else if (mimeType) view.setMimeTypes(mimeType);
  if (name) view.setQuery(name);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
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
        if (data.action === picker.Action.CANCEL) {
          finish(false);
          return;
        }
        if (data.action !== picker.Action.PICKED) return;
        const selected = data.docs?.[0];
        if (!selected) {
          finish(false);
          return;
        }
        if (selected.id !== id) {
          finish(null, new Error('Выбран другой объект. Закройте окно и выберите «' + (name || 'нужный объект') + '» с тем же идентификатором.'));
          return;
        }
        rememberDriveItemAuthorization(id);
        finish(true);
      });
    try {
      builder.build().setVisible(true);
    } catch (error) {
      finish(null, new Error('Не удалось открыть Google Picker: ' + (error?.message || error)));
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { DRIVE_SCOPES, GOOGLE_CLOUD_PROJECT_NUMBER, GOOGLE_CLIENT_ID, GOOGLE_PICKER_API_KEY } from '../js/config.js';
import { deleteDriveFile, driveFetch } from '../js/drive.js';
import { AUTH_SESSION_KEY } from '../js/auth.js';
import { assertDrivePickerSelection, authorizeDriveItem, configureDrivePickerView, DRIVE_ITEM_AUTHORIZATION_MARKER_PREFIX, forgetDriveItemAuthorization, readPickerResponse, rememberDriveItemAuthorization } from '../js/google-picker.js';

test('ordinary Google Drive file deletion is blocked before any API request', async () => {
  await assert.rejects(deleteDriveFile('ordinary-book-id'), (error) => {
    assert.equal(error.code, 'drive_file_deletion_blocked');
    assert.equal(error.fileId, 'ordinary-book-id');
    return /Удаление обычных файлов Google Drive запрещено/.test(error.message);
  });
});

test('appData cleanup verifies the file parent before sending DELETE', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../js/drive.js', import.meta.url), 'utf8');
  const implementation = source.match(/export async function deleteAppDataFile\(fileId\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(implementation, /fields: 'id,parents'/);
  assert.match(implementation, /file\.parents\.includes\('appDataFolder'\)/);
  assert.match(implementation, /appdata_deletion_blocked/);
  assert.match(implementation, /method: 'DELETE'/);
});

test('OAuth scopes keep broad read and appData but remove broad Drive mutation scope', () => {
  const scopes = DRIVE_SCOPES.split(/\s+/);
  assert.ok(scopes.includes('https://www.googleapis.com/auth/drive.readonly'));
  assert.ok(scopes.includes('https://www.googleapis.com/auth/drive.appdata'));
  assert.ok(scopes.includes('https://www.googleapis.com/auth/drive.file'));
  assert.ok(!scopes.includes('https://www.googleapis.com/auth/drive'));
});

test('Drive 403 errors distinguish app authorization from account permissions without logging private data', async () => {
  const auth = await import('../js/auth.js?v=20261114-brave-oauth2-redirect');
  const previousFetch = globalThis.fetch;
  const previousWarn = console.warn;
  const warnings = [];
  auth.restoreAuthSession({ session: {
    getItem: () => JSON.stringify({ accessToken: 'test-token', expiresAt: Date.now() + 3600000, user: { emailAddress: 'private@example.com' } }),
    removeItem: () => {},
  } });
  console.warn = (...args) => warnings.push(args);
  try {
    for (const item of [
      { reason: 'appNotAuthorizedToFile', code: 'app_not_authorized_to_file', message: /не подтвердил разрешение приложения/ },
      { reason: 'appNotAuthorizedToChild', code: 'app_not_authorized_to_child', message: /не разрешил изменить доступ к этому объекту/ },
      { reason: 'insufficientFilePermissions', code: 'insufficient_file_permissions', message: /недостаточно прав/ },
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: {
        code: 403,
        message: item.reason === 'appNotAuthorizedToFile'
          ? 'The user has not granted the app access to the file private-file-id.'
          : 'The user does not have sufficient permissions for this file.',
        errors: [{ reason: item.reason }],
      } }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      await assert.rejects(driveFetch('/files/private-file-id/permissions', { diagnostics: { stage: 'sharing-permissions-list' } }), (error) => {
        assert.equal(error.status, 403);
        assert.equal(error.reason, item.reason);
        assert.equal(error.code, item.code);
        assert.match(error.message, item.message);
        return true;
      });
    }
    assert.equal(warnings.length, 3);
    assert.equal(warnings[0][1].stage, 'sharing-permissions-list');
    assert.equal(warnings[0][1].reason, 'appNotAuthorizedToFile');
    assert.doesNotMatch(JSON.stringify(warnings), /private-file-id|private@example\.com|test-token/);
  } finally {
    auth.clearAccessToken();
    console.warn = previousWarn;
    if (previousFetch === undefined) delete globalThis.fetch; else globalThis.fetch = previousFetch;
  }
});

test('Google Picker app ID matches the OAuth client project number', () => {
  assert.equal(GOOGLE_CLOUD_PROJECT_NUMBER, '194069938786');
  assert.equal(GOOGLE_CLOUD_PROJECT_NUMBER, GOOGLE_CLIENT_ID.split('-')[0]);
});

test('Picker view is restricted to the exact folder ID, not a duplicate-prone name query', () => {
  const calls = [];
  const view = {
    setFileIds: (value) => calls.push(['fileIds', value]),
    setSelectFolderEnabled: (value) => calls.push(['selectFolder', value]),
    setMimeTypes: (value) => calls.push(['mimeTypes', value]),
    setQuery: (value) => calls.push(['query', value]),
  };
  configureDrivePickerView(view, { id: 'exact-folder-id', name: 'Остальное', isFolder: true, restrictToId: true });
  assert.deepEqual(calls, [['fileIds', 'exact-folder-id'], ['selectFolder', true]]);
  assert.ok(!calls.some(([method]) => method === 'query'));
});

test('Picker view is restricted to the exact file ID while retaining the file type filter', () => {
  const calls = [];
  const view = {
    setFileIds: (value) => calls.push(['fileIds', value]),
    setSelectFolderEnabled: (value) => calls.push(['selectFolder', value]),
    setMimeTypes: (value) => calls.push(['mimeTypes', value]),
  };
  configureDrivePickerView(view, { id: 'exact-catalog-id', mimeType: 'application/json', restrictToId: true });
  assert.deepEqual(calls, [['fileIds', 'exact-catalog-id'], ['mimeTypes', 'application/json']]);
});

test('Picker rejects a selected object whose ID differs even if its name matches', () => {
  assert.throws(() => assertDrivePickerSelection({ id: 'wrong-folder-id', name: 'Остальное' }, 'expected-folder-id', 'Остальное'),
    /Выбран другой объект/);
  assert.deepEqual(assertDrivePickerSelection({ id: 'expected-folder-id', name: 'Остальное' }, 'expected-folder-id', 'Остальное'),
    { id: 'expected-folder-id', name: 'Остальное' });
});

test('Picker response accepts documented response keys and normalizes action casing', () => {
  const picker = { Response: { ACTION: 'action', DOCUMENTS: 'docs' }, Action: { PICKED: 'PICKED', CANCEL: 'CANCEL', ERROR: 'ERROR' } };
  const selected = { id: 'folder-1', name: 'Books' };
  assert.deepEqual(readPickerResponse({ action: 'picked', docs: [selected] }, picker), {
    action: 'picked', docs: [selected], picked: true, cancelled: false, failed: false,
  });
  assert.equal(readPickerResponse({ action: 'CANCEL' }, picker).cancelled, true);
  assert.equal(readPickerResponse({ action: 'error' }, picker).failed, true);
});

test('Picker response supports API-defined keys when they differ from shorthand names', () => {
  const picker = { Response: { ACTION: 'responseAction', DOCUMENTS: 'responseDocs' }, Action: { PICKED: 'picked', CANCEL: 'cancel', ERROR: 'error' } };
  const selected = { id: 'folder-2' };
  const response = readPickerResponse({ responseAction: 'PICKED', responseDocs: [selected] }, picker);
  assert.equal(response.picked, true);
  assert.deepEqual(response.docs, [selected]);
});

test('folder authorization configures list mode and accepts the Picker selection callback', async () => {
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  const previousGoogle = globalThis.google;
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const calls = [];
  let callback;
  class DocsView {
    constructor(id) { this.id = id; }
    setMode(value) { calls.push(['mode', value]); return this; }
    setIncludeFolders(value) { calls.push(['includeFolders', value]); return this; }
    setFileIds(value) { calls.push(['fileIds', value]); return this; }
    setSelectFolderEnabled(value) { calls.push(['selectFolder', value]); return this; }
  }
  class PickerBuilder {
    setAppId(value) { calls.push(['appId', value]); return this; }
    setDeveloperKey() { return this; }
    setOAuthToken() { return this; }
    setOrigin() { return this; }
    setTitle() { return this; }
    addView(view) { calls.push(['view', view.id]); return this; }
    setCallback(value) { callback = value; return this; }
    build() { return { setVisible: () => callback({ action: 'picked', docs: [{ id: 'folder-1', name: 'Books' }] }) }; }
  }
  globalThis.localStorage = storage;
  globalThis.window = { localStorage: storage, sessionStorage: storage, location: { protocol: 'http:', host: 'localhost:8000' } };
  globalThis.google = {
    picker: {
      DocsView, PickerBuilder, ViewId: { FOLDERS: 'folders', DOCS: 'docs' },
      DocsViewMode: { LIST: 'list' }, Action: { PICKED: 'PICKED', CANCEL: 'CANCEL', ERROR: 'ERROR' },
      Response: { ACTION: 'action', DOCUMENTS: 'docs' },
    },
  };
  const auth = await import('../js/auth.js?v=20261114-brave-oauth2-redirect');
  auth.restoreAuthSession({ session: {
    getItem: () => JSON.stringify({ accessToken: 'test-token', expiresAt: Date.now() + 3600000, user: { emailAddress: 'picker-test@example.com' } }),
    removeItem: () => {},
  } });
  try {
    assert.equal(await authorizeDriveItem({ id: 'folder-1', name: 'Books', isFolder: true }), true);
    assert.ok(calls.some(([name, value]) => name === 'mode' && value === 'list'));
    assert.ok(calls.some(([name, value]) => name === 'includeFolders' && value === true));
    assert.ok(calls.some(([name, value]) => name === 'selectFolder' && value === true));
    assert.ok(calls.some(([name, value]) => name === 'fileIds' && value === 'folder-1'), 'Picker authorization must show only the exact selected folder');
  } finally {
    auth.clearAccessToken();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousLocalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousLocalStorage;
    if (previousGoogle === undefined) delete globalThis.google; else globalThis.google = previousGoogle;
  }
});

test('Picker authorization marker version invalidates stale v1 selections', () => {
  assert.equal(DRIVE_ITEM_AUTHORIZATION_MARKER_PREFIX, 'secret-library-drive-file-authorized-v2:');
  assert.notEqual(DRIVE_ITEM_AUTHORIZATION_MARKER_PREFIX, 'secret-library-drive-file-authorized-v1:');
});

test('Google Picker selection has a timeout and reports terminal callback errors', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../js/google-picker.js', import.meta.url), 'utf8');
  assert.match(source, /selectionTimer = setTimeout\(\(\) => \{[\s\S]*?Google Picker не завершил выбор за 45 секунд/);
  assert.match(source, /clearTimeout\(selectionTimer\)/);
  assert.match(source, /readPickerResponse\(data, picker\)/);
  assert.match(source, /Google Picker сообщил об ошибке/);
  assert.match(source, /DocsViewMode\?\.LIST/);
  assert.match(source, /callbackState/);
  assert.match(source, /picker_selection_timeout/);
  assert.match(source, /picker_callback_error/);
  assert.match(source, /pickerProviderCode/);
  assert.match(source, /providerCode: providerCode/);
  assert.match(source, /never the full provider payload or OAuth token/);
});

test('old OAuth sessions are not restored after scope migration', () => {
  assert.equal(AUTH_SESSION_KEY, 'secret-library-google-session-v2');
});

test('Picker authorization fails closed when no restricted browser API key is configured', { skip: Boolean(GOOGLE_PICKER_API_KEY) }, async () => {
  await assert.rejects(authorizeDriveItem({ id: 'test-folder', name: 'Test', isFolder: true }),
    /GOOGLE_PICKER_API_KEY/);
});


test('a failed Drive API operation can invalidate the remembered Picker selection', async () => {
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  globalThis.localStorage = storage;
  globalThis.window = { sessionStorage: storage, localStorage: storage };
  const auth = await import('../js/auth.js?v=20261114-brave-oauth2-redirect');
  auth.restoreAuthSession({ session: {
    getItem: () => JSON.stringify({ accessToken: 'test-token', expiresAt: Date.now() + 3600000, user: { emailAddress: 'user@example.com' } }),
    removeItem: () => {},
  } });
  try {
    const key = DRIVE_ITEM_AUTHORIZATION_MARKER_PREFIX + encodeURIComponent('user@example.com') + ':folder-id';
    rememberDriveItemAuthorization('folder-id');
    assert.equal(storage.getItem(key), '1');
    forgetDriveItemAuthorization('folder-id');
    assert.equal(storage.getItem(key), null);
  } finally {
    auth.clearAccessToken();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousLocalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousLocalStorage;
  }
});

test('Picker failure messages carry the Brave storage guidance for Brave users', async () => {
  const { readFile } = await import('node:fs/promises');
  const pickerSource = await readFile(new URL('../js/google-picker.js', import.meta.url), 'utf8');
  assert.match(pickerSource, /isBraveBrowserSync\(\) \? ` \$\{BRAVE_PICKER_HINT\}` : ''/, 'both picker error paths must append the hint');
  assert.match(pickerSource, /Google Sign-In/, 'the hint must name the Brave shields permission');
  const hintLine = pickerSource.split('\n').find((l) => l.includes('BRAVE_PICKER_HINT = ')) || '';
  assert.doesNotMatch(hintLine, /sessionStorage|localStorage|firestore|appData|drive.file/i, 'the hint must not leak infrastructure names');
});

test('The root-folder Picker starts at My Drive with hidden navigation and returns the picked folder', async () => {
  const { readFile } = await import('node:fs/promises');
  const pickerSource = await readFile(new URL('../js/google-picker.js', import.meta.url), 'utf8');
  assert.match(pickerSource, /export async function pickDriveFolder/, 'the free folder Picker must be exported');
  assert.match(pickerSource, /ViewId\.FOLDERS/, 'the free Picker must list folders');
  assert.match(pickerSource, /setParent\('root'\)/, 'the free Picker must start inside My Drive');
  assert.match(pickerSource, /NAV_HIDDEN/, 'the free Picker must hide the navigation pane');
  assert.match(pickerSource, /setSelectFolderEnabled/, 'the free Picker must allow selecting a folder');
  const freeBlock = pickerSource.slice(pickerSource.indexOf('export async function pickDriveFolder'));
  assert.doesNotMatch(freeBlock, /setFileIds/, 'the free Picker must not be locked to a preselected item');
});

test('Every root-folder choice validates the Drive root and minimum books before switching in-page', async () => {
  const { readFile } = await import('node:fs/promises');
  const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /Корневой папкой библиотеки может быть только папка непосредственно в корне Google Диска\. Выберите другую/,
    'the nested-folder rejection must use the approved wording');
  assert.match(appSource, /pickRootFolderWithChecks/, 'all root choices must share the checked Picker flow');
  assert.match(appSource, /countIndexableBooks/, 'the minimum-books check must count indexable formats');
  assert.match(appSource, /switchToRootFolder/, 'the root switch must happen in-page');
  const switchBlock = appSource.slice(appSource.indexOf('async function switchToRootFolder'),
    appSource.indexOf('async function ensureMinimumBookAccess'));
  assert.doesNotMatch(switchBlock, /window\.location\.reload/, 'switching the root must not reload the page');
  assert.doesNotMatch(appSource.slice(appSource.indexOf('async function changeRootFolder')), /window\.confirm/,
    'changing the root must not ask a legacy confirm dialog');
  assert.doesNotMatch(appSource, /root-folder-picker\.js/, 'the legacy folder dialog module must stay removed');
  const checksBlock = appSource.slice(appSource.indexOf('async function pickRootFolderWithChecks'),
    appSource.indexOf('async function switchToRootFolder'));
  assert.doesNotMatch(checksBlock, /ui\.showError/, 'rejections must not use the error line hidden behind the Picker');
  assert.match(appSource, /function showRootFolderPopup/, 'rejections must use the popup modal');
  assert.match(appSource, /ВЫБРАТЬ КОРНЕВУЮ ПАПКУ/, 'the popup button must use the approved label');
  assert.match(appSource, /button\.className = 'settings-save-button'/, 'the popup button must reuse the settings-page button style');
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { DRIVE_SCOPES, GOOGLE_CLOUD_PROJECT_NUMBER, GOOGLE_CLIENT_ID, GOOGLE_PICKER_API_KEY } from '../js/config.js';
import { deleteDriveFile } from '../js/drive.js';
import { AUTH_SESSION_KEY } from '../js/auth.js';
import { assertDrivePickerSelection, authorizeDriveItem, configureDrivePickerView, DRIVE_ITEM_AUTHORIZATION_MARKER_PREFIX, forgetDriveItemAuthorization, rememberDriveItemAuthorization } from '../js/google-picker.js';

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
  configureDrivePickerView(view, { id: 'exact-folder-id', name: 'Остальное', isFolder: true });
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
  configureDrivePickerView(view, { id: 'exact-catalog-id', mimeType: 'application/json' });
  assert.deepEqual(calls, [['fileIds', 'exact-catalog-id'], ['mimeTypes', 'application/json']]);
});

test('Picker rejects a selected object whose ID differs even if its name matches', () => {
  assert.throws(() => assertDrivePickerSelection({ id: 'wrong-folder-id', name: 'Остальное' }, 'expected-folder-id', 'Остальное'),
    /Выбран другой объект/);
  assert.deepEqual(assertDrivePickerSelection({ id: 'expected-folder-id', name: 'Остальное' }, 'expected-folder-id', 'Остальное'),
    { id: 'expected-folder-id', name: 'Остальное' });
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
  assert.match(source, /data\.action === picker\.Action\.ERROR \|\| data\.action === 'error'/);
  assert.match(source, /Google Picker сообщил об ошибке/);
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
  const auth = await import('../js/auth.js?v=20261109-oauth-picker-diagnostics');
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

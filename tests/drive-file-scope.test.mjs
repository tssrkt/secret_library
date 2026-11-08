import test from 'node:test';
import assert from 'node:assert/strict';
import { DRIVE_SCOPES, GOOGLE_PICKER_API_KEY } from '../js/config.js';
import { AUTH_SESSION_KEY } from '../js/auth.js';
import { authorizeDriveItem } from '../js/google-picker.js';

test('OAuth scopes keep broad read and appData but remove broad Drive mutation scope', () => {
  const scopes = DRIVE_SCOPES.split(/\s+/);
  assert.ok(scopes.includes('https://www.googleapis.com/auth/drive.readonly'));
  assert.ok(scopes.includes('https://www.googleapis.com/auth/drive.appdata'));
  assert.ok(scopes.includes('https://www.googleapis.com/auth/drive.file'));
  assert.ok(!scopes.includes('https://www.googleapis.com/auth/drive'));
});

test('old OAuth sessions are not restored after scope migration', () => {
  assert.equal(AUTH_SESSION_KEY, 'secret-library-google-session-v2');
});

test('Picker authorization fails closed when no restricted browser API key is configured', { skip: Boolean(GOOGLE_PICKER_API_KEY) }, async () => {
  await assert.rejects(authorizeDriveItem({ id: 'test-folder', name: 'Test', isFolder: true }),
    /GOOGLE_PICKER_API_KEY/);
});

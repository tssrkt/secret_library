import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('authorization reuses the already loaded Drive profile for social connection', async () => {
  const app = await read('../js/app.js');
  const runtime = await read('../js/social-runtime.js');

  assert.match(app, /social\.connect\(getAccessToken\(\), activeRootFolderId \|\| '', user\)/,
    'the profile loaded during authorization is passed to social.connect');
  assert.match(runtime, /async connect\(token, rootFolderId = '', knownDriveUser = null\)/,
    'social.connect accepts an optional known profile');
  assert.match(runtime, /const driveUser = knownDriveUser \|\| await getCurrentDriveUser\(\)/,
    'the runtime only requests the profile again when no profile was supplied');
  assert.match(runtime, /setTimeout\(\(\) => reject\(new Error\([\s\S]*?\), 25000\)/,
    'Drive friend discovery still has a bounded timeout');
});

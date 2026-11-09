import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('app and settings UI share one social-runtime module instance', async () => {
  const [app, ui, friends] = await Promise.all([
    source('../js/app.js'),
    source('../js/ui.js'),
    source('../js/friends-ui.js'),
  ]);
  const specifier = (text, file) => {
    const match = text.match(/from\s+['"]([^'"]*social-runtime\.js(?:\?[^'"]*)?)['"]/);
    assert.ok(match, `social-runtime import exists in ${file}`);
    return match[1];
  };
  assert.equal(specifier(app, 'app.js'), specifier(ui, 'ui.js'));
  assert.equal(specifier(ui, 'ui.js'), specifier(friends, 'friends-ui.js'));
});

test('invitation status refresh does not block the mandatory registration gate', async () => {
  const runtime = await source('../js/social-runtime.js');
  assert.match(runtime, /void\s*\(async\s*\(\)\s*=>\s*\{[\s\S]*?await syncAcceptedInvitationStatuses\(\[\], current\)/);
  assert.match(runtime, /await retryTransientAuthOperation\(\(\) => store\.register\(\)\)/);
});

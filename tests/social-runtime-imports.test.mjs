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

test('invitation ledger and friend details do not block the mandatory registration gate', async () => {
  const runtime = await source('../js/social-runtime.js');
  assert.match(runtime, /void\s*\(async\s*\(\)\s*=>\s*\{[\s\S]*?await syncAcceptedInvitationStatuses\(\[\], current\)/);
  assert.match(runtime, /await retryTransientAuthOperation\(\(\) => store\.register\(\)\)/);
  assert.match(runtime, /void store\.loadFriends\(\)\.then\(async \(friends\) =>/);
  assert.match(runtime, /async connect\(token, rootFolderId = '', knownDriveUser = null\)/);
  assert.match(runtime, /Promise\.all\(\[driveUserPromise, sessionPromise\]\)/);
});

test('friend list changes trigger a fresh admin metadata check without exposing emails early', async () => {
  const ui = await source('../js/friends-ui.js');
  assert.match(ui, /if \(hadFriendSnapshot && !invitationQuota\)\s*\{\s*quotaMetadataRetryUsed = false;\s*void refreshInvitationStatuses\(\);/);
  assert.match(ui, /else if \(invitationQuota && friendEmail\)/);
});

test('best-effort invitation finalization cannot block the registration gate', async () => {
  const store = await source('../js/social-store.js');
  assert.match(store, /void user\.getIdToken\(\)\.then\(\(idToken\) => finalizeInviteeRegistration\(\{ idToken \}\)\)/);
  assert.doesNotMatch(store, /await finalizeInviteeRegistration\(/);
});

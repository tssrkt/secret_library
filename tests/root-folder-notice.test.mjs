import test from 'node:test';
import assert from 'node:assert/strict';
import { hasOutboundLibraryFriends } from '../js/root-folder-notice.js';

test('root-folder change notice is unnecessary when there are no friends', () => {
  assert.equal(hasOutboundLibraryFriends([]), false);
  assert.equal(hasOutboundLibraryFriends(null), false);
});

test('incoming-only friends do not trigger the root-folder change notice', () => {
  assert.equal(hasOutboundLibraryFriends([{ inbound: true, outbound: false }]), false);
  assert.equal(hasOutboundLibraryFriends([{ inbound: true }, { inbound: true, outbound: false }]), false);
});

test('at least one outgoing library share preserves the root-folder change notice', () => {
  assert.equal(hasOutboundLibraryFriends([{ inbound: true, outbound: true }]), true);
  assert.equal(hasOutboundLibraryFriends([{ inbound: true, outbound: false }, { outbound: true }]), true);
});

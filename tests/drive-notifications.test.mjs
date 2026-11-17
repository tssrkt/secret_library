import test from 'node:test';
import assert from 'node:assert/strict';
import { getDriveNotifications, markDriveNotificationsSeen, syncDriveNotifications } from '../js/drive-notifications.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}
const friend = (uid, { inbound = true, outbound = false, displayName = uid } = {}) => ({
  uid, email: uid + '@gmail.com', displayName, inbound, outbound,
});

test('existing inbound friend does not create a fresh notification when outgoing sharing changes', () => {
  const storage = memoryStorage();
  const baseline = [friend('maria')];
  assert.deepEqual(syncDriveNotifications([friend('maria', { outbound: false })], {
    storage, storageKey: 'smilodon@example.com', baselineFriends: baseline,
  }), []);
  assert.deepEqual(syncDriveNotifications([friend('maria', { outbound: true })], {
    storage, storageKey: 'smilodon@example.com', baselineFriends: [],
  }), [], 'reciprocal sharing does not create a notification for the existing incoming share');
});

test('a newly shared library creates one unread notification and survives refresh', () => {
  const storage = memoryStorage();
  const first = syncDriveNotifications([friend('smilodon')], {
    storage, storageKey: 'maria@example.com', baselineFriends: [],
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].unread, true);
  assert.equal(first[0].displayName, 'smilodon');
  assert.equal(syncDriveNotifications([friend('smilodon')], {
    storage, storageKey: 'maria@example.com', baselineFriends: [],
  }).length, 1, 'refresh preserves the same event instead of duplicating it');
});

test('marking an event read updates badge state without removing it from the list', () => {
  const storage = memoryStorage();
  const notifications = syncDriveNotifications([friend('smilodon')], {
    storage, storageKey: 'maria@example.com', baselineFriends: [],
  });
  markDriveNotificationsSeen(notifications, { storage, storageKey: 'maria@example.com' });
  const refreshed = getDriveNotifications([friend('smilodon')], { storage, storageKey: 'maria@example.com' });
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].unread, false);
});

test('new unread notifications sort ahead of older read events', () => {
  const storage = memoryStorage();
  const oldEvent = syncDriveNotifications([friend('maria')], { storage, storageKey: 'smilodon@example.com' });
  markDriveNotificationsSeen(oldEvent, { storage, storageKey: 'smilodon@example.com' });
  const latest = syncDriveNotifications([friend('maria'), friend('tara')], { storage, storageKey: 'smilodon@example.com' });
  assert.equal(latest[0].ownerUid, 'tara');
  assert.equal(latest[0].unread, true);
  assert.equal(latest[1].unread, false);
});

test('a newly inbound friend is notified even when an older inbound friend is already known', () => {
  const storage = memoryStorage();
  syncDriveNotifications([friend('maria')], {
    storage, storageKey: 'smilodon@example.com', baselineFriends: [friend('maria')],
  });
  const refreshed = syncDriveNotifications([friend('maria'), friend('tara')], {
    storage, storageKey: 'smilodon@example.com', baselineFriends: [friend('maria')],
  });
  assert.deepEqual(refreshed.map((item) => item.ownerUid), ['tara']);
  assert.equal(refreshed[0].unread, true);
});

test('revoking and later restoring inbound access creates a new event', () => {
  const storage = memoryStorage();
  syncDriveNotifications([friend('smilodon')], { storage, storageKey: 'maria@example.com' });
  syncDriveNotifications([], { storage, storageKey: 'maria@example.com' });
  const restored = syncDriveNotifications([friend('smilodon')], { storage, storageKey: 'maria@example.com' });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].unread, true);
});

test('notifications stay aligned with active inbound relationships and omit email-only rows', () => {
  const storage = memoryStorage();
  syncDriveNotifications([friend('smilodon'), { uid: 'email:unknown', email: 'x@gmail.com', inbound: true }], {
    storage, storageKey: 'maria@example.com', baselineFriends: [],
  });
  assert.deepEqual(getDriveNotifications([friend('smilodon', { inbound: false })], {
    storage, storageKey: 'maria@example.com',
  }), []);
});

const STORAGE_PREFIX = 'secret-library-drive-notifications-v2:';

function keyFor(friend) {
  return String(friend?.uid || friend?.email || '').trim().toLowerCase();
}

function inboundFriends(friends) {
  return (Array.isArray(friends) ? friends : []).filter((friend) =>
    friend?.inbound === true && friend.uid && !String(friend.uid).startsWith('email:'));
}

function readRecord(storage, storageKey) {
  if (!storage || !storageKey) return null;
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_PREFIX + storageKey) || 'null');
    if (!parsed || !Array.isArray(parsed.knownInbound) || !Array.isArray(parsed.events)) return null;
    return parsed;
  } catch { return null; }
}

function writeRecord(storage, storageKey, record) {
  if (!storage || !storageKey) return;
  try { storage.setItem(STORAGE_PREFIX + storageKey, JSON.stringify(record)); }
  catch { /* Notifications remain usable for this session if storage is unavailable. */ }
}

function presentEvent(event, friend) {
  return {
    ...event,
    ownerUid: friend.uid,
    email: friend.email || event.email || '',
    displayName: friend.displayName || event.displayName || 'Пользователь',
    mutual: friend.outbound === true,
  };
}

function visibleEvents(record, friends) {
  const current = new Map(inboundFriends(friends).map((friend) => [keyFor(friend), friend]));
  return record.events
    .filter((event) => current.has(event.notificationKey))
    .map((event) => presentEvent(event, current.get(event.notificationKey)))
    .sort((a, b) => Number(b.unread) - Number(a.unread)
      || Number(b.createdAt || 0) - Number(a.createdAt || 0)
      || a.displayName.localeCompare(b.displayName, 'ru'));
}

/**
 * Reconcile a confirmed Drive snapshot with the prior cached friend list.
 * Only an inbound relationship absent from both the saved baseline and the
 * previous notification state creates a new notification event.
 */
export function syncDriveNotifications(friends, { storage = globalThis.localStorage, storageKey, baselineFriends = [] } = {}) {
  if (!storageKey) return [];
  const current = inboundFriends(friends);
  const currentKeys = new Set(current.map(keyFor));
  let record = readRecord(storage, storageKey);
  if (!record) {
    record = {
      knownInbound: inboundFriends(baselineFriends).map(keyFor),
      events: [],
    };
  }
  const known = new Set(record.knownInbound);
  const events = new Map(record.events.map((event) => [event.notificationKey, event]));
  for (const friend of current) {
    const key = keyFor(friend);
    const existing = events.get(key);
    if (!known.has(key)) {
      events.set(key, {
        ownerUid: friend.uid,
        email: friend.email || '',
        displayName: friend.displayName || 'Пользователь',
        unread: true,
        createdAt: Date.now(),
        mutual: friend.outbound === true,
        notificationKey: key,
      });
    } else if (existing) {
      events.set(key, presentEvent(existing, friend));
    }
    known.add(key);
  }
  record = {
    knownInbound: current.map(keyFor).slice(-1000),
    events: [...events.values()].filter((event) => currentKeys.has(event.notificationKey)).slice(-1000),
  };
  writeRecord(storage, storageKey, record);
  return visibleEvents(record, friends);
}

/** Refresh labels and mutual status without creating notification events. */
export function getDriveNotifications(friends, { storage = globalThis.localStorage, storageKey } = {}) {
  const record = readRecord(storage, storageKey);
  if (!record) return [];
  const current = new Map(inboundFriends(friends).map((friend) => [keyFor(friend), friend]));
  record.events = record.events
    .filter((event) => current.has(event.notificationKey))
    .map((event) => presentEvent(event, current.get(event.notificationKey)));
  writeRecord(storage, storageKey, record);
  return visibleEvents(record, friends);
}

export function markDriveNotificationsSeen(items, { storage = globalThis.localStorage, storageKey } = {}) {
  const record = readRecord(storage, storageKey);
  if (!record) return;
  const seen = new Set((Array.isArray(items) ? items : []).map((item) => item?.notificationKey).filter(Boolean));
  record.events = record.events.map((event) => seen.has(event.notificationKey) ? { ...event, unread: false } : event);
  writeRecord(storage, storageKey, record);
}

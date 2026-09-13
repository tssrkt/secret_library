export function normalizeEmail(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
export function validateShareEmail(value, ownEmail) {
  const email = normalizeEmail(value);
  if (!/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(email) || email.length > 254) throw new Error('Введите корректный Gmail.');
  if (email === normalizeEmail(ownEmail)) throw new Error('Нельзя поделиться библиотекой с самим собой.');
  return email;
}
export const shareId = (owner, viewer) => `${owner}__${viewer}`;
export const timestampValue = (value) => value?.toMillis?.() ?? (typeof value === 'number' ? value : 0);
export function friendsModel(uid, shares, profiles = {}, contacts = {}) {
  const friends = new Map();
  for (const share of shares) {
    if (!share.active || (share.ownerUid !== uid && share.viewerUid !== uid)) continue;
    const other = share.ownerUid === uid ? share.viewerUid : share.ownerUid;
    if (other === uid || !profiles[other]) continue;
    const friend = friends.get(other) || { uid: other, displayName: profiles[other].displayName || 'Пользователь',
      email: contacts[other]?.email || '', inbound: false, outbound: false };
    if (share.ownerUid === uid) friend.outbound = true; else friend.inbound = true;
    friends.set(other, friend);
  }
  return [...friends.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru') || a.uid.localeCompare(b.uid));
}
export function notificationsModel(uid, shares, reads = {}, profiles = {}) {
  return shares.filter((share) => share.active && share.viewerUid === uid).map((share) => ({ ...share,
    displayName: profiles[share.ownerUid]?.displayName || 'Пользователь',
    unread: timestampValue(share.sharedAt) > timestampValue(reads[share.ownerUid]?.seenSharedAt),
    mutual: shares.some((other) => other.active && other.ownerUid === uid && other.viewerUid === share.ownerUid),
  })).sort((a, b) => timestampValue(b.sharedAt) - timestampValue(a.sharedAt) || a.ownerUid.localeCompare(b.ownerUid));
}

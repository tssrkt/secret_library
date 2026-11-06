export function normalizeEmail(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
export function validateShareEmail(value, ownEmail) {
  const email = normalizeEmail(value);
  if (!/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(email) || email.length > 254) throw new Error('Введите корректный Gmail.');
  if (email === normalizeEmail(ownEmail)) throw new Error('Нельзя поделиться библиотекой с самим собой.');
  return email;
}
export const shareId = (owner, viewer) => `${owner}__${viewer}`;
export function friendsModel(uid, shares, profiles = {}, contacts = {}) {
  const friends = new Map();
  for (const share of shares) {
    if (!share.active || (share.ownerUid !== uid && share.viewerUid !== uid)) continue;
    const other = share.ownerUid === uid ? share.viewerUid : share.ownerUid;
    if (other === uid || !profiles[other]) continue;
    const isAdmin = profiles[other].isAdmin === true;
    const friend = friends.get(other) || { uid: other, displayName: profiles[other].displayName || 'Пользователь',
      isAdmin, email: isAdmin ? '' : (contacts[other]?.email || (share.ownerUid === other ? share.ownerEmail : '') || ''), inbound: false, outbound: false };
    if (share.ownerUid === uid) friend.outbound = true; else friend.inbound = true;
    if (!isAdmin && share.ownerUid === other && !friend.email) friend.email = contacts[other]?.email || share.ownerEmail || '';
    friends.set(other, friend);
  }
  return [...friends.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru') || a.uid.localeCompare(b.uid));
}

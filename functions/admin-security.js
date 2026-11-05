const PROFILE_FIELDS = ['displayName', 'photoURL', 'createdAt', 'invitedByUid', 'isAdmin'];
const ADMIN_FIELDS = ['role', 'active', 'permissions', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'];
const BAN_FIELDS = ['reason', 'bannedBy', 'adminWasActive', 'bannedAt'];
const SHARE_FIELDS = ['ownerUid', 'viewerUid', 'active', 'sharedAt', 'revokedAt'];
const EVENT_DETAILS_FIELDS = ['permissions', 'active', 'reason', 'ownerUid', 'limit', 'length', 'adminRestored', 'email'];
const PERMISSION_FIELDS = ['overview', 'users', 'relationships', 'invites', 'shares', 'events', 'banned', 'admins', 'texts'];

function sanitizePermissions(value) {
  const safe = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return safe;
  for (const key of PERMISSION_FIELDS) {
    if (typeof value[key] === 'boolean') safe[key] = value[key];
  }
  return safe;
}

function redactEmailAddresses(value) {
  return String(value || '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[скрыто]');
}

export function canRestoreAdminRights(actor, targetAdminExists, adminWasActive) {
  return Boolean(targetAdminExists && adminWasActive && (actor?.role === 'superadmin' || actor?.permissions?.admins === true));
}

export function isValidUid(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function isValidLibraryShareId(value) {
  if (typeof value !== 'string' || value.length > 258) return false;
  const parts = value.split('__');
  return parts.length === 2 && parts.every(isValidUid);
}

export function projectDashboardUser(uid, profile = {}, { includeEmail = false, email = '', banned = false, admin = false } = {}) {
  const row = { uid };
  for (const key of PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(profile, key)) row[key] = profile[key];
  }
  if (includeEmail) row.email = email;
  row.banned = Boolean(banned);
  row.admin = Boolean(admin);
  return row;
}

export function projectDashboardInvitation(id, email, invite = {}) {
  const row = { id, email };
  for (const key of ['ownerUid', 'claimedUid', 'active', 'createdAt', 'claimedAt', 'emailStatus', 'emailSentAt', 'revokedAt', 'revokedBy']) {
    if (Object.prototype.hasOwnProperty.call(invite, key)) row[key] = invite[key];
  }
  return row;
}

export function projectDashboardShare(id, share = {}, { includeOwnerEmail = false } = {}) {
  const row = { id };
  for (const key of SHARE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(share, key)) row[key] = share[key];
  }
  if (includeOwnerEmail && Object.prototype.hasOwnProperty.call(share, 'ownerEmail')) row.ownerEmail = share.ownerEmail;
  return row;
}

export function projectDashboardAdmin(uid, admin = {}, { includeEmail = false } = {}) {
  const row = { uid };
  for (const key of ADMIN_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(admin, key)) continue;
    row[key] = key === 'permissions' ? sanitizePermissions(admin[key]) : admin[key];
  }
  if (includeEmail && typeof admin.email === 'string') row.email = admin.email;
  return row;
}

export function projectDashboardBan(uid, ban = {}, { includeUserDetails = false } = {}) {
  const row = { uid };
  for (const key of BAN_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(ban, key)) continue;
    row[key] = key === 'reason' && !includeUserDetails ? redactEmailAddresses(ban[key]) : ban[key];
  }
  if (includeUserDetails) {
    for (const key of ['email', 'displayName']) {
      if (Object.prototype.hasOwnProperty.call(ban, key)) row[key] = ban[key];
    }
  }
  return row;
}

export function projectDashboardEvent(id, event = {}, { includeUserDetails = false } = {}) {
  const row = { id };
  for (const key of ['actorUid', 'action', 'targetUid', 'createdAt']) {
    if (Object.prototype.hasOwnProperty.call(event, key)) row[key] = event[key];
  }
  if (event.details && typeof event.details === 'object' && !Array.isArray(event.details)) {
    row.details = {};
    for (const key of EVENT_DETAILS_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(event.details, key)) continue;
      if (key === 'email') row.details.email = includeUserDetails ? event.details.email : '';
      else if (key === 'permissions') row.details.permissions = sanitizePermissions(event.details.permissions);
      else if (key === 'reason') row.details.reason = includeUserDetails ? event.details.reason : redactEmailAddresses(event.details.reason);
      else row.details[key] = event.details[key];
    }
  }
  return row;
}

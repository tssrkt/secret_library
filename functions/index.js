import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { canRestoreAdminRights, isBootstrapAdminEmailMatch, isValidLibraryShareId, isValidUid, projectDashboardAdmin, projectDashboardBan, projectDashboardEvent, projectDashboardInvitation, projectDashboardShare, projectDashboardUser } from './admin-security.js';

initializeApp();
const db = getFirestore();
const emailPattern = /^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/;
const normalEmail = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const pendingShare = (email, uid) => db.doc(`pendingInvites/${email}/shares/${uid}`);
const ADMIN_EMAIL = normalEmail(process.env.BOOTSTRAP_ADMIN_EMAIL || '');
const ADMIN_SECTIONS = ['overview', 'users', 'relationships', 'invites', 'shares', 'events', 'banned', 'admins'];
const adminRef = (uid) => db.doc(`adminUsers/${uid}`);
const banRef = (uid) => db.doc(`bannedUsers/${uid}`);
const eventRef = () => db.collection('adminEvents').doc();

async function requireSignedIn(request) {
  if (!request.auth?.uid || request.auth.token.email_verified !== true
      || request.auth.token.firebase?.sign_in_provider !== 'google.com') {
    throw new HttpsError('unauthenticated', 'Войдите через подтверждённый Google-аккаунт.');
  }
  const banned = await banRef(request.auth.uid).get();
  if (banned.exists) throw new HttpsError('permission-denied', 'Доступ к Тайной Библиотеке заблокирован.');
  return request.auth.uid;
}

async function requireAdmin(request, permission = null) {
  const uid = request.auth?.uid;
  if (!uid || request.auth.token.email_verified !== true
      || request.auth.token.firebase?.sign_in_provider !== 'google.com') {
    throw new HttpsError('unauthenticated', 'Войдите через подтверждённый Google-аккаунт.');
  }
  const [banned, snap] = await Promise.all([banRef(uid).get(), adminRef(uid).get()]);
  if (banned.exists) throw new HttpsError('permission-denied', 'Доступ к Тайной Библиотеке заблокирован.');
  if (!snap.exists) throw new HttpsError('permission-denied', 'Нет прав администратора.');
  const admin = snap.data();
  if (admin.active !== true) throw new HttpsError('permission-denied', 'Учётная запись администратора отключена.');
  if (admin.role !== 'superadmin' && permission && admin.permissions?.[permission] !== true) {
    throw new HttpsError('permission-denied', 'Недостаточно прав для этого действия.');
  }
  return { uid, admin };
}

async function logAdminEvent(actorUid, action, targetUid = null, details = {}) {
  await eventRef().set({ actorUid, action, targetUid, details, createdAt: FieldValue.serverTimestamp() });
}

export const checkLibraryAccess = onCall({ region: 'europe-west1', invoker: 'public' }, async (request) => {
  const uid = await requireSignedIn(request);
  const [admin, profile] = await Promise.all([adminRef(uid).get(), db.doc(`users/${uid}`).get()]);
  if (admin.exists && profile.exists) {
    const isAdmin = admin.data()?.active === true;
    if (profile.data()?.isAdmin !== isAdmin) await db.doc(`users/${uid}`).set({ isAdmin }, { merge: true });
  }
  return { allowed: true };
});

export const bootstrapAdmin = onCall({ region: 'europe-west1', invoker: 'public' }, async (request) => {
  const uid = await requireSignedIn(request);
  if (!isBootstrapAdminEmailMatch(ADMIN_EMAIL, request.auth.token.email)) {
    throw new HttpsError('permission-denied', 'Первоначальная настройка доступна только назначенному владельцу.');
  }
  const [existing, current] = await Promise.all([
    db.collection('adminUsers').limit(1).get(),
    adminRef(uid).get()
  ]);
  if (!existing.empty) {
    if (current.exists && current.data().role === 'superadmin') {
      await db.doc(`users/${uid}`).set({ isAdmin: true }, { merge: true });
      return { ok: true, alreadyAdmin: true };
    }
    throw new HttpsError('failed-precondition', 'Главный администратор уже настроен.');
  }
  await adminRef(uid).set({ uid, email: ADMIN_EMAIL, role: 'superadmin', active: true, permissions: Object.fromEntries(ADMIN_SECTIONS.map((key) => [key, true])), createdAt: FieldValue.serverTimestamp(), createdBy: 'bootstrap' });
  await db.doc(`users/${uid}`).set({ isAdmin: true }, { merge: true });
  await logAdminEvent(uid, 'bootstrap-admin');
  return { ok: true };
});

export const getAdminDashboard = onCall({ region: 'europe-west1', invoker: 'public' }, async (request) => {
  const { admin } = await requireAdmin(request);
  const allPermissions = admin.role === 'superadmin'
    ? Object.fromEntries(ADMIN_SECTIONS.map((key) => [key, true]))
    : Object.fromEntries(ADMIN_SECTIONS.filter((key) => typeof admin.permissions?.[key] === 'boolean').map((key) => [key, admin.permissions[key]]));
  if (!Object.values(allPermissions).some(Boolean)) throw new HttpsError('permission-denied', 'Не назначены права для просмотра админки.');

  const needsUsers = Boolean(allPermissions.users || allPermissions.relationships);
  const needsBans = Boolean(allPermissions.banned || allPermissions.users || allPermissions.relationships);
  const needsAdmins = Boolean(allPermissions.admins || allPermissions.users);
  const needsShares = Boolean(allPermissions.shares || allPermissions.relationships);
  const [users, invites, shares, admins, banned, events, directory] = await Promise.all([
    needsUsers ? db.collection('users').get() : Promise.resolve(null),
    allPermissions.invites ? db.collection('pendingInvites').get() : Promise.resolve(null),
    needsShares ? db.collection('libraryShares').get() : Promise.resolve(null),
    needsAdmins ? db.collection('adminUsers').get() : Promise.resolve(null),
    needsBans ? db.collection('bannedUsers').get() : Promise.resolve(null),
    allPermissions.events ? db.collection('adminEvents').orderBy('createdAt', 'desc').limit(100).get() : Promise.resolve(null),
    allPermissions.users ? db.collection('userDirectory').get() : Promise.resolve(null)
  ]);
  const userDocs = users?.docs || [];
  const inviteDocs = invites?.docs || [];
  const shareDocs = shares?.docs || [];
  const adminDocs = admins?.docs || [];
  const bannedDocs = banned?.docs || [];
  const eventDocs = events?.docs || [];
  const emailByUid = new Map((directory?.docs || []).map((d) => [d.data().uid, d.id]));
  const bannedUids = new Set(bannedDocs.map((doc) => doc.id));
  const adminUids = new Set(adminDocs.map((doc) => doc.id));
  const userRows = userDocs.map((d) => projectDashboardUser(d.id, d.data(), {
    includeEmail: Boolean(allPermissions.users),
    email: emailByUid.get(d.id) || '',
    banned: bannedUids.has(d.id),
    admin: adminUids.has(d.id)
  }));
  // Read invitation subcollections concurrently; sequential reads add one network
  // round trip per pending invitation and can make this legacy endpoint time out.
  const inviteSnapshots = await Promise.all(inviteDocs.map((invite) => invite.ref.collection('shares').get()));
  const inviteRows = [];
  inviteSnapshots.forEach((snapshot, index) => {
    for (const item of snapshot.docs) {
      inviteRows.push(projectDashboardInvitation(item.id, inviteDocs[index].id, item.data()));
    }
  });
  return {
    permissions: allPermissions,
    counts: {
      users: allPermissions.users ? userDocs.length : null,
      invitations: allPermissions.invites ? inviteRows.length : null,
      acceptedInvitations: allPermissions.invites ? inviteRows.filter((x) => Boolean(x.claimedUid)).length : null,
      shares: allPermissions.shares ? shareDocs.filter((d) => d.data().active === true).length : null,
      admins: allPermissions.admins ? adminDocs.length : null,
      banned: allPermissions.banned ? bannedDocs.length : null
    },
    users: allPermissions.users || allPermissions.relationships ? userRows : [],
    invitations: allPermissions.invites ? inviteRows : [],
    shares: needsShares ? shareDocs.map((d) => projectDashboardShare(d.id, d.data(), { includeOwnerEmail: Boolean(allPermissions.shares) })) : [],
    admins: allPermissions.admins ? adminDocs.map((d) => projectDashboardAdmin(d.id, d.data(), { includeEmail: Boolean(allPermissions.users) })) : [],
    banned: allPermissions.banned ? bannedDocs.map((d) => projectDashboardBan(d.id, d.data(), { includeUserDetails: Boolean(allPermissions.users) })) : [],
    events: allPermissions.events ? eventDocs.map((d) => projectDashboardEvent(d.id, d.data(), { includeUserDetails: Boolean(allPermissions.users) })) : []
  };
});

export const setAdminPermissions = onCall({ region: 'europe-west1', invoker: 'public' }, async (request) => {
  const { uid } = await requireAdmin(request, 'admins');
  const targetUid = String(request.data?.uid || '');
  const permissions = request.data?.permissions;
  if (!isValidUid(targetUid) || targetUid === uid || !permissions || typeof permissions !== 'object'
      || Object.keys(permissions).some((key) => !ADMIN_SECTIONS.includes(key) || typeof permissions[key] !== 'boolean')) {
    throw new HttpsError('invalid-argument', 'Некорректные права администратора.');
  }
  const [bannedTarget, user, existing] = await Promise.all([
    banRef(targetUid).get(),
    db.doc(`users/${targetUid}`).get(),
    adminRef(targetUid).get()
  ]);
  if (bannedTarget.exists) throw new HttpsError('failed-precondition', 'Нельзя назначить администратора заблокированному участнику.');
  if (!user.exists) throw new HttpsError('not-found', 'Участник не найден.');
  if (existing.data()?.role === 'superadmin') throw new HttpsError('failed-precondition', 'Нельзя менять права главного администратора.');
  const active = request.data?.active !== false;
  await adminRef(targetUid).set({ uid: targetUid, email: normalEmail(existing.data()?.email), role: 'moderator', active, permissions, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }, { merge: true });
  await db.doc(`users/${targetUid}`).set({ isAdmin: active }, { merge: true });
  await logAdminEvent(uid, 'set-admin-permissions', targetUid, { permissions, active });
  return { ok: true };
});

export const banLibraryUser = onCall({ region: 'europe-west1', invoker: 'public' }, async (request) => {
  const { uid } = await requireAdmin(request, 'users');
  const targetUid = String(request.data?.uid || '');
  const reason = typeof request.data?.reason === 'string' ? request.data.reason.trim().slice(0, 500) : '';
  if (!isValidUid(targetUid) || targetUid === uid) throw new HttpsError('invalid-argument', 'Нельзя заблокировать эту учётную запись.');
  const [admin, profile] = await Promise.all([
    adminRef(targetUid).get(),
    db.doc(`users/${targetUid}`).get()
  ]);
  if (admin.data()?.role === 'superadmin') throw new HttpsError('failed-precondition', 'Главного администратора нельзя заблокировать.');
  if (!profile.exists) throw new HttpsError('not-found', 'Участник не найден.');
  const authUser = await getAuth().getUser(targetUid).catch(() => null);
  await banRef(targetUid).set({ uid: targetUid, email: normalEmail(authUser?.email), displayName: profile.data()?.displayName || '', reason, bannedBy: uid, adminWasActive: admin.exists && admin.data()?.active === true, bannedAt: FieldValue.serverTimestamp() });
  if (admin.exists) {
    await adminRef(targetUid).update({ active: false, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    await db.doc(`users/${targetUid}`).set({ isAdmin: false }, { merge: true });
  }
  await getAuth().revokeRefreshTokens(targetUid).catch(() => {});
  await logAdminEvent(uid, 'ban-user', targetUid, { reason });
  return { ok: true };
});

export const restoreLibraryUser = onCall({ region: 'europe-west1', invoker: 'public' }, async (request) => {
  const { uid, admin: actorAdmin } = await requireAdmin(request, 'banned');
  const targetUid = String(request.data?.uid || '');
  if (!isValidUid(targetUid)) throw new HttpsError('invalid-argument', 'Не указан участник.');
  const [banned, targetAdmin] = await Promise.all([
    banRef(targetUid).get(),
    adminRef(targetUid).get()
  ]);
  if (!banned.exists) return { ok: true };
  // Read both records before deleting the ban so a failed admin read cannot
  // leave the participant partially restored.
  await banRef(targetUid).delete();
  if (canRestoreAdminRights(actorAdmin, targetAdmin.exists, banned.data()?.adminWasActive === true)) {
    await adminRef(targetUid).update({ active: true, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    await db.doc(`users/${targetUid}`).set({ isAdmin: true }, { merge: true });
  }
  await logAdminEvent(uid, 'restore-user', targetUid);
  return { ok: true };
});

export const adminRevokeInvitation = onCall({ region: 'europe-west1', invoker: 'public' }, async (request) => {
  const { uid } = await requireAdmin(request, 'invites');
  const email = normalEmail(request.data?.email);
  const ownerUid = String(request.data?.ownerUid || '');
  if (!emailPattern.test(email) || !isValidUid(ownerUid)) throw new HttpsError('invalid-argument', 'Некорректное приглашение.');
  const ref = pendingShare(email, ownerUid);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Приглашение не найдено.');
  if (snapshot.data()?.claimedUid) throw new HttpsError('failed-precondition', 'Приглашение уже принято.');
  await ref.update({ active: false, revokedAt: FieldValue.serverTimestamp(), revokedBy: uid });
  await logAdminEvent(uid, 'revoke-invitation', null, { email, ownerUid });
  return { ok: true };
});

export const adminSetLibraryShare = onCall({ region: 'europe-west1', invoker: 'public' }, async (request) => {
  const { uid } = await requireAdmin(request, 'shares');
  const id = String(request.data?.id || '');
  if (!isValidLibraryShareId(id) || typeof request.data?.active !== 'boolean') throw new HttpsError('invalid-argument', 'Некорректный доступ.');
  if (request.data.active !== false) throw new HttpsError('failed-precondition', 'Администратор может только закрыть доступ; повторное открытие выполняет владелец.');
  const ref = db.doc(`libraryShares/${id}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Связь доступа не найдена.');
  const current = snapshot.data();
  const protectedUids = [...new Set([current.ownerUid, current.viewerUid].filter(Boolean))];
  const protectedAdmins = await Promise.all(protectedUids.map((protectedUid) => adminRef(protectedUid).get()));
  if (protectedAdmins.some((entry) => entry.exists && entry.data()?.role === 'superadmin')) {
    throw new HttpsError('failed-precondition', 'Нельзя изменять доступ, связанный с главным администратором.');
  }
  await ref.update({ active: false, revokedAt: FieldValue.serverTimestamp() });
  await logAdminEvent(uid, request.data.active ? 'admin-open-share' : 'admin-close-share', current.viewerUid, { ownerUid: current.ownerUid });
  return { ok: true };
});

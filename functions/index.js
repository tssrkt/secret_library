import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { invitationMail } from './invitation-mail.js';

initializeApp();
const db = getFirestore();
const SMTP_HOST = defineSecret('SMTP_HOST');
const SMTP_PORT = defineSecret('SMTP_PORT');
const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASSWORD = defineSecret('SMTP_PASSWORD');
const SMTP_FROM = defineSecret('SMTP_FROM');
const secrets = [SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM];
const emailPattern = /^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/;
const normalEmail = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const pendingShare = (email, uid) => db.doc(`pendingInvites/${email}/shares/${uid}`);
const share = (owner, viewer) => db.doc(`libraryShares/${owner}__${viewer}`);
const activeShare = (ownerUid, viewerUid) => ({ ownerUid, viewerUid, active: true,
  sharedAt: FieldValue.serverTimestamp(), revokedAt: null });

function configuration() {
  const host = SMTP_HOST.value(); const port = Number(SMTP_PORT.value());
  const user = SMTP_USER.value(); const pass = SMTP_PASSWORD.value(); const from = SMTP_FROM.value();
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !pass || !from) {
    throw new HttpsError('failed-precondition', 'Отправка приглашений пока не настроена.');
  }
  return { host, port, user, pass, from };
}

const ADMIN_EMAIL = 'tssrkt777@gmail.com';
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
  const uid = await requireSignedIn(request);
  const snap = await adminRef(uid).get();
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
  await requireSignedIn(request);
  return { allowed: true };
});

export const bootstrapAdmin = onCall({ region: 'europe-west1', invoker: 'public' }, async (request) => {
  const uid = await requireSignedIn(request);
  if (normalEmail(request.auth.token.email) !== ADMIN_EMAIL) {
    throw new HttpsError('permission-denied', 'Первоначальная настройка доступна только назначенному владельцу.');
  }
  const existing = await db.collection('adminUsers').limit(1).get();
  if (!existing.empty) {
    const current = await adminRef(uid).get();
    if (current.exists && current.data().role === 'superadmin') return { ok: true, alreadyAdmin: true };
    throw new HttpsError('failed-precondition', 'Главный администратор уже настроен.');
  }
  await adminRef(uid).set({ uid, email: ADMIN_EMAIL, role: 'superadmin', active: true, permissions: Object.fromEntries(ADMIN_SECTIONS.map((key) => [key, true])), createdAt: FieldValue.serverTimestamp(), createdBy: 'bootstrap' });
  await logAdminEvent(uid, 'bootstrap-admin');
  return { ok: true };
});

export const getAdminDashboard = onCall({ region: 'europe-west1', invoker: 'public' }, async (request) => {
  const { uid, admin } = await requireAdmin(request);
  const allPermissions = admin.role === 'superadmin' ? Object.fromEntries(ADMIN_SECTIONS.map((key) => [key, true])) : (admin.permissions || {});
  if (!Object.values(allPermissions).some(Boolean)) throw new HttpsError('permission-denied', 'Не назначены права для просмотра админки.');
  const [users, invites, shares, admins, banned, events] = await Promise.all([
    db.collection('users').get(),
    db.collection('pendingInvites').get(),
    db.collection('libraryShares').get(),
    db.collection('adminUsers').get(),
    db.collection('bannedUsers').get(),
    db.collection('adminEvents').orderBy('createdAt', 'desc').limit(100).get()
  ]);
  const userRows = users.docs.map((d) => ({ uid: d.id, ...d.data(), banned: banned.docs.some((b) => b.id === d.id), admin: admins.docs.some((a) => a.id === d.id) }));
  const inviteRows = [];
  for (const invite of invites.docs) {
    const child = await invite.ref.collection('shares').get();
    for (const item of child.docs) inviteRows.push({ id: item.id, email: invite.id, ...item.data() });
  }
  return {
    permissions: allPermissions,
    counts: { users: allPermissions.users ? users.size : null, invitations: allPermissions.invites ? inviteRows.length : null, acceptedInvitations: allPermissions.invites ? inviteRows.filter((x) => Boolean(x.claimedUid)).length : null, shares: allPermissions.shares ? shares.docs.filter((d) => d.data().active === true).length : null, admins: allPermissions.admins ? admins.size : null, banned: allPermissions.banned ? banned.size : null },
    users: allPermissions.users || allPermissions.relationships ? userRows : [],
    invitations: allPermissions.invites ? inviteRows : [],
    shares: allPermissions.shares || allPermissions.relationships ? shares.docs.map((d) => ({ id: d.id, ...d.data() })) : [],
    admins: allPermissions.admins ? admins.docs.map((d) => ({ uid: d.id, ...d.data() })) : [],
    banned: allPermissions.banned ? banned.docs.map((d) => ({ uid: d.id, ...d.data() })) : [],
    events: allPermissions.events ? events.docs.map((d) => ({ id: d.id, ...d.data() })) : []
  };
});

export const setAdminPermissions = onCall({ region: 'europe-west1', invoker: 'public' }, async (request) => {
  const { uid } = await requireAdmin(request, 'admins');
  const targetUid = String(request.data?.uid || '');
  const permissions = request.data?.permissions;
  if (!targetUid || targetUid === uid || !permissions || typeof permissions !== 'object'
      || Object.keys(permissions).some((key) => !ADMIN_SECTIONS.includes(key) || typeof permissions[key] !== 'boolean')) {
    throw new HttpsError('invalid-argument', 'Некорректные права администратора.');
  }
  const user = await db.doc(`users/${targetUid}`).get();
  if (!user.exists) throw new HttpsError('not-found', 'Участник не найден.');
  const existing = await adminRef(targetUid).get();
  if (existing.data()?.role === 'superadmin') throw new HttpsError('failed-precondition', 'Нельзя менять права главного администратора.');
  await adminRef(targetUid).set({ uid: targetUid, email: normalEmail(request.data?.email) || normalEmail(existing.data()?.email), role: 'moderator', active: request.data?.active !== false, permissions, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid }, { merge: true });
  await logAdminEvent(uid, 'set-admin-permissions', targetUid, { permissions });
  return { ok: true };
});

export const banLibraryUser = onCall({ region: 'europe-west1', invoker: 'public' }, async (request) => {
  const { uid } = await requireAdmin(request, 'users');
  const targetUid = String(request.data?.uid || '');
  const reason = typeof request.data?.reason === 'string' ? request.data.reason.trim().slice(0, 500) : '';
  if (!targetUid || targetUid === uid) throw new HttpsError('invalid-argument', 'Нельзя заблокировать эту учётную запись.');
  const admin = await adminRef(targetUid).get();
  if (admin.data()?.role === 'superadmin') throw new HttpsError('failed-precondition', 'Главного администратора нельзя заблокировать.');
  const profile = await db.doc(`users/${targetUid}`).get();
  if (!profile.exists) throw new HttpsError('not-found', 'Участник не найден.');
  const authUser = await getAuth().getUser(targetUid).catch(() => null);
  await banRef(targetUid).set({ uid: targetUid, email: normalEmail(authUser?.email), displayName: profile.data()?.displayName || '', reason, bannedBy: uid, adminWasActive: admin.exists && admin.data()?.active === true, bannedAt: FieldValue.serverTimestamp() });
  if (admin.exists) await adminRef(targetUid).update({ active: false, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
  await getAuth().revokeRefreshTokens(targetUid).catch(() => {});
  await logAdminEvent(uid, 'ban-user', targetUid, { reason });
  return { ok: true };
});

export const restoreLibraryUser = onCall({ region: 'europe-west1', invoker: 'public' }, async (request) => {
  const { uid } = await requireAdmin(request, 'banned');
  const targetUid = String(request.data?.uid || '');
  if (!targetUid) throw new HttpsError('invalid-argument', 'Не указан участник.');
  const banned = await banRef(targetUid).get();
  if (!banned.exists) return { ok: true };
  await banRef(targetUid).delete();
  const admin = await adminRef(targetUid).get();
  if (admin.exists && banned.data()?.adminWasActive === true) await adminRef(targetUid).update({ active: true, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
  await logAdminEvent(uid, 'restore-user', targetUid);
  return { ok: true };
});

export const adminRevokeInvitation = onCall({ region: 'europe-west1', invoker: 'public' }, async (request) => {
  const { uid } = await requireAdmin(request, 'invites');
  const email = normalEmail(request.data?.email);
  const ownerUid = String(request.data?.ownerUid || '');
  if (!emailPattern.test(email) || !ownerUid) throw new HttpsError('invalid-argument', 'Некорректное приглашение.');
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
  if (!id || typeof request.data?.active !== 'boolean') throw new HttpsError('invalid-argument', 'Некорректный доступ.');
  const ref = db.doc(`libraryShares/${id}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Связь доступа не найдена.');
  const current = snapshot.data();
  await ref.update({ active: request.data.active, revokedAt: request.data.active ? null : FieldValue.serverTimestamp() });
  await logAdminEvent(uid, request.data.active ? 'admin-open-share' : 'admin-close-share', current.viewerUid, { ownerUid: current.ownerUid });
  return { ok: true };
});

export const inviteToLibrary = onCall({
  region: 'europe-west1',
  invoker: 'public',
  secrets,
}, async (request) => {
  const ownerUid = await requireSignedIn(request);
  const ownEmail = normalEmail(request.auth.token.email);
  const email = normalEmail(request.data?.email);
  if (!emailPattern.test(email) || email.length > 254) throw new HttpsError('invalid-argument', 'Введите корректный Gmail.');
  if (!ownEmail || email === ownEmail) throw new HttpsError('invalid-argument', 'Нельзя поделиться библиотекой с самим собой.');
  const profile = await db.doc(`users/${ownerUid}`).get();
  const displayName = String(profile.data()?.displayName || '').trim();
  if (!profile.exists || !displayName) throw new HttpsError('failed-precondition', 'Сначала завершите вход в библиотеку.');

  const directory = await db.doc(`userDirectory/${email}`).get();
  if (directory.exists) {
    const viewerUid = directory.data().uid;
    if (viewerUid === ownerUid) throw new HttpsError('invalid-argument', 'Нельзя поделиться библиотекой с самим собой.');
    await db.runTransaction(async (tx) => {
      const current = await tx.get(share(ownerUid, viewerUid));
      tx.set(db.doc(`users/${ownerUid}/knownContacts/${viewerUid}`), { email });
      if (!current.data()?.active) tx.set(share(ownerUid, viewerUid), activeShare(ownerUid, viewerUid));
    });
    return { kind: 'registered', message: 'Этот пользователь уже зарегистрирован. Доступ предоставлен.' };
  }

  const attemptId = randomUUID();
  const prepared = await db.runTransaction(async (tx) => {
    const current = await tx.get(pendingShare(email, ownerUid));
    if (current.data()?.emailStatus === 'sent') return 'sent';
    if (current.data()?.emailStatus === 'sending') {
      const started = current.data()?.emailAttemptStartedAt?.toMillis?.() || 0;
      if (Date.now() - started < 10 * 60 * 1000) return 'sending';
    }
    const root = db.doc(`pendingInvites/${email}`);
    const first = await tx.get(root);
    if (!current.exists) tx.set(pendingShare(email, ownerUid), { ownerUid, inviteeEmail: email, active: true,
      createdAt: FieldValue.serverTimestamp(), claimedUid: null, claimedAt: null,
      emailStatus: 'sending', emailAttemptId: attemptId, emailAttemptStartedAt: FieldValue.serverTimestamp(),
      emailSentAt: null, emailLastError: null });
    else tx.update(pendingShare(email, ownerUid), { emailStatus: 'sending', emailAttemptId: attemptId,
      emailAttemptStartedAt: FieldValue.serverTimestamp(), emailLastError: null });
    if (!first.exists) tx.set(root, { firstOwnerUid: ownerUid, createdAt: FieldValue.serverTimestamp() });
    return 'send';
  });
  if (prepared === 'sent') return { kind: 'already-sent', message: 'Этот пользователь ещё не зарегистрирован. Приглашение уже отправлено.' };
  if (prepared === 'sending') return { kind: 'sending', message: 'Приглашение уже отправляется.' };

  // The invitee may register after the first directory lookup but before SMTP starts.
  // In that case grant the ordinary share and do not send a stale invitation email.
  const appeared = await db.doc(`userDirectory/${email}`).get();
  if (appeared.exists) {
    const viewerUid = appeared.data().uid;
    await db.runTransaction(async (tx) => {
      const current = await tx.get(share(ownerUid, viewerUid));
      tx.set(db.doc(`users/${ownerUid}/knownContacts/${viewerUid}`), { email });
      if (!current.data()?.active) tx.set(share(ownerUid, viewerUid), activeShare(ownerUid, viewerUid));
      const pending = await tx.get(pendingShare(email, ownerUid));
      if (pending.data()?.emailAttemptId === attemptId) tx.update(pendingShare(email, ownerUid), {
        emailStatus: 'not-needed', emailLastError: null });
    });
    return { kind: 'registered', message: 'Этот пользователь уже зарегистрирован. Доступ предоставлен.' };
  }

  try {
    const config = configuration();
    const transporter = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.port === 465,
      auth: { user: config.user, pass: config.pass } });
    const mail = invitationMail(displayName);
    await transporter.sendMail({ from: config.from, to: email, ...mail });
    await db.runTransaction(async (tx) => {
      const current = await tx.get(pendingShare(email, ownerUid));
      if (current.data()?.emailAttemptId === attemptId) tx.update(pendingShare(email, ownerUid), {
        emailStatus: 'sent', emailSentAt: FieldValue.serverTimestamp(), emailLastError: null });
    });
    return { kind: 'sent', message: 'Приглашение отправлено.' };
  } catch (error) {
    await db.runTransaction(async (tx) => {
      const current = await tx.get(pendingShare(email, ownerUid));
      if (current.data()?.emailAttemptId === attemptId) tx.update(pendingShare(email, ownerUid), {
        emailStatus: 'failed', emailLastError: 'send-failed' });
    }).catch(() => {});
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', 'Не удалось отправить приглашение. Повторите попытку.');
  }
});

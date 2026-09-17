import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
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

export const inviteToLibrary = onCall({
  region: 'europe-west1',
  invoker: 'public',
  secrets,
}, async (request) => {
  if (!request.auth?.uid || request.auth.token.email_verified !== true || request.auth.token.firebase?.sign_in_provider !== 'google.com') {
    throw new HttpsError('unauthenticated', 'Войдите через подтверждённый Google-аккаунт.');
  }
  const ownerUid = request.auth.uid;
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

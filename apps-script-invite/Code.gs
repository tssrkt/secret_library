const FIREBASE_PROJECT_ID = 'project-071ee00e-4a4a-4a3d-95d';
const FIREBASE_API_KEY = 'AIzaSyDXTowpjzrl6_GfzQED9ITjb7mn9Qzs5J4';
const SITE_ORIGIN = 'https://tssrkt.github.io';
const MAX_INVITES_PER_USER_PER_DAY = 10;
const SENDING_LEASE_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 60 * 1000;

function doGet() {
  return HtmlService.createHtmlOutput('Тайная Библиотека: сервис приглашений готов.');
}

function authorizeMailer() {
  MailApp.getRemainingDailyQuota();
  UrlFetchApp.fetch('https://firestore.googleapis.com/', { muteHttpExceptions: true });
}

function doPost(e) {
  let requestId = '';
  let stage = 'parse-request';
  let reservation = null;
  let adminRequest = false;
  try {
    const raw = e && e.parameter && e.parameter.payload;
    if (!raw || raw.length > 12000) throw new Error('Некорректный запрос.');
    const input = JSON.parse(raw);
    requestId = String(input.requestId || '');
    if (!/^[a-zA-Z0-9_-]{12,80}$/.test(requestId)) throw new Error('Некорректный идентификатор запроса.');
    if (input.action === 'getInvitationStatuses') {
      stage = 'invitation-status-request';
      return responsePage(requestId, true, '', handleInvitationStatuses(input));
    }
    if (input.action) {
      adminRequest = true;
      stage = 'admin-request';
      const result = handleAdminRequest(input);
      return adminResponsePage(requestId, true, '', result);
    }
    const email = normalizeEmail(input.email);
    const idToken = String(input.idToken || '');
    if (!isValidEmail(email) || idToken.length < 100 || idToken.length > 5000) {
      throw new Error('Проверьте адрес получателя и повторите попытку.');
    }

    stage = 'verify-firebase-user';
    const user = verifyFirebaseUser(idToken);
    if (email === normalizeEmail(user.email)) throw new Error('Нельзя отправить приглашение самому себе.');

    stage = 'verify-owner-profile';
    user.displayName = readOwnerDisplayName(idToken, user.localId);

    stage = 'verify-pending-invitation';
    const invitation = readPendingInvitation(idToken, email, user.localId);
    if (!invitation) throw new Error('Приглашение не найдено. Повторите попытку из библиотеки.');
    if (invitation.claimedUid) {
      return responsePage(requestId, true, 'Запрос обработан. Если получателю нужно приглашение, письмо отправлено.');
    }
    stage = 'reserve-send';
    reservation = reserveSend(user.localId, email, invitation.emailSentAt || (invitation.emailStatus === 'sent' ? invitation.createdAt : null));
    if (reservation.status === 'cooldown' || reservation.status === 'sending') {
      // Do not reveal whether an address belongs to an existing member.
      return responsePage(requestId, true, 'Запрос обработан. Если получателю нужно приглашение, письмо отправлено.');
    }

    stage = 'send-email';
    const inviterName = String(user.displayName || 'Пользователь').trim().slice(0, 160) || 'Пользователь';
    MailApp.sendEmail({
      to: email,
      subject: 'Приглашение в «Тайную Библиотеку»',
      body: renderInvitationEmailTemplate(inviterName) + '\n\nЕсли вы уже участвуете в Тайной Библиотеке, просто откройте её — приглашение появится автоматически.',
      name: 'Тайная Библиотека'
    });

    stage = 'mark-sent';
    finishSend(user.localId, email, true);
    reservation = null;
    return responsePage(requestId, true, 'Запрос обработан. Если получателю нужно приглашение, письмо отправлено.');
  } catch (error) {
    if (reservation && reservation.status === 'reserved') {
      try { finishSend(reservation.uid, reservation.email, false); } catch (_) {}
    }
    console.error('Invitation mailer failed', {
      stage: stage,
      name: error && error.name ? String(error.name) : 'UnknownError'
    });
    return adminRequest
      ? adminResponsePage(requestId, false, publicAdminError(error), null)
      : responsePage(requestId, false, publicError(error));
  }
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isValidEmail(value) {
  return value.length <= 254 && /^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(value);
}

function verifyFirebaseUser(idToken) {
  const response = UrlFetchApp.fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ idToken: idToken }),
      muteHttpExceptions: true
    }
  );
  if (response.getResponseCode() !== 200) throw new Error('Сеанс Google истёк. Переподключите Google и повторите попытку.');
  const body = JSON.parse(response.getContentText());
  const user = body.users && body.users[0];
  const googleProvider = user && Array.isArray(user.providerUserInfo) &&
    user.providerUserInfo.some(function (provider) { return provider.providerId === 'google.com'; });
  if (!user || !user.localId || user.emailVerified !== true || !googleProvider) {
    throw new Error('Для отправки приглашений нужен подтверждённый Google-сеанс.');
  }
  return user;
}

function readOwnerDisplayName(idToken, uid) {
  const path = '/projects/' + FIREBASE_PROJECT_ID +
    '/databases/(default)/documents/users/' + encodeURIComponent(uid);
  const response = UrlFetchApp.fetch('https://firestore.googleapis.com/v1' + path, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + idToken },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Не удалось проверить профиль владельца в Firebase. Повторите попытку.');
  }
  const fields = JSON.parse(response.getContentText()).fields || {};
  const name = fields.displayName && fields.displayName.stringValue;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Сначала завершите регистрацию в Тайной Библиотеке.');
  }
  return name.trim().slice(0, 160);
}

function readPendingInvitation(idToken, email, uid) {
  const path = '/projects/' + FIREBASE_PROJECT_ID +
    '/databases/(default)/documents/pendingInvites/' + encodeURIComponent(email) +
    '/shares/' + encodeURIComponent(uid);
  const response = UrlFetchApp.fetch('https://firestore.googleapis.com/v1' + path, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + idToken },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() === 404) return null;
  if (response.getResponseCode() !== 200) {
    throw new Error('Не удалось проверить приглашение в Firebase. Повторите попытку.');
  }
  const fields = JSON.parse(response.getContentText()).fields || {};
  const value = function (name, key) {
    return fields[name] && Object.prototype.hasOwnProperty.call(fields[name], key) ? fields[name][key] : null;
  };
  if (value('ownerUid', 'stringValue') !== uid ||
      normalizeEmail(value('inviteeEmail', 'stringValue')) !== email ||
      value('active', 'booleanValue') !== true) return null;
  return {
    claimedUid: value('claimedUid', 'stringValue'),
    emailStatus: value('emailStatus', 'stringValue'),
    emailSentAt: value('emailSentAt', 'timestampValue'),
    createdAt: value('createdAt', 'timestampValue')
  };
}

function handleInvitationStatuses(input) {
  const idToken = String(input.idToken || '');
  const emails = Array.isArray(input.emails) ? input.emails.slice(0, 100).map(normalizeEmail) : [];
  if (idToken.length < 100 || idToken.length > 5000 || !emails.length || emails.some(function (email) { return !isValidEmail(email); })) {
    throw new Error('Не удалось обновить состояние приглашений. Обновите страницу.');
  }
  const user = verifyFirebaseUser(idToken);
  const properties = PropertiesService.getScriptProperties();
  const statuses = {};
  emails.forEach(function (email) {
    if (email === normalizeEmail(user.email)) return;
    const invitation = readPendingInvitation(idToken, email, user.localId);
    if (!invitation || invitation.claimedUid) return;
    const current = JSON.parse(properties.getProperty(reservationKey(user.localId, email)) || 'null');
    let lastSentAt = 0;
    if (current) lastSentAt = current.status === 'sent' ? Number(current.at) || 0 : Number(current.lastSentAt) || 0;
    else if (invitation.emailStatus === 'sent') lastSentAt = Date.parse(invitation.emailSentAt) || Date.parse(invitation.createdAt) || 0;
    statuses[email] = { lastSentAt: lastSentAt, cooldownUntil: lastSentAt ? lastSentAt + RESEND_COOLDOWN_MS : 0 };
  });
  return statuses;
}

function reservationKey(uid, email) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, uid + '\n' + email, Utilities.Charset.UTF_8
  );
  return 'invite:' + digest.map(function (byte) {
    const value = (byte + 256) % 256;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function reserveSend(uid, email, firestoreSentAt) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const properties = PropertiesService.getScriptProperties();
    const key = reservationKey(uid, email);
    const now = Date.now();
    const current = JSON.parse(properties.getProperty(key) || 'null');
    const storedSentAt = current ? (current.status === 'sent' ? Number(current.at) || 0 : Number(current.lastSentAt) || 0) : 0;
    const firestoreTime = typeof firestoreSentAt === 'string' ? Date.parse(firestoreSentAt) || 0 : 0;
    const lastSentAt = Math.max(storedSentAt, firestoreTime);
    if (lastSentAt && now - lastSentAt < RESEND_COOLDOWN_MS) return { status: 'cooldown', remainingMs: RESEND_COOLDOWN_MS - (now - lastSentAt) };
    if (current && current.status === 'sending' && now - current.at < SENDING_LEASE_MS) {
      return { status: 'sending' };
    }
    if (MailApp.getRemainingDailyQuota() < 1) {
      throw new Error('Достигнут бесплатный дневной лимит Gmail. Попробуйте завтра.');
    }
    const dailyKey = 'daily:' + uid;
    const recent = JSON.parse(properties.getProperty(dailyKey) || '[]')
      .filter(function (timestamp) { return Number.isFinite(timestamp) && now - timestamp < 24 * 60 * 60 * 1000; });
    if (recent.length >= MAX_INVITES_PER_USER_PER_DAY) {
      throw new Error('Достигнут дневной лимит приглашений. Попробуйте завтра.');
    }
    properties.setProperty(key, JSON.stringify({ status: 'sending', at: now, lastSentAt: lastSentAt }));
    return { status: 'reserved', uid: uid, email: email, key: key, dailyKey: dailyKey, recent: recent };
  } finally {
    lock.releaseLock();
  }
}

function finishSend(uid, email, success) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const properties = PropertiesService.getScriptProperties();
    const key = reservationKey(uid, email);
    const current = JSON.parse(properties.getProperty(key) || 'null');
    if (success) {
      const sentAt = Date.now();
      properties.setProperty(key, JSON.stringify({ status: 'sent', at: sentAt, lastSentAt: sentAt }));
      const dailyKey = 'daily:' + uid;
      const recent = JSON.parse(properties.getProperty(dailyKey) || '[]')
        .filter(function (timestamp) { return Number.isFinite(timestamp) && Date.now() - timestamp < 24 * 60 * 60 * 1000; });
      recent.push(Date.now());
      properties.setProperty(dailyKey, JSON.stringify(recent));
    } else {
      properties.setProperty(key, JSON.stringify({ status: 'failed', at: Date.now(), lastSentAt: Number(current?.lastSentAt) || 0 }));
    }
  } finally {
    lock.releaseLock();
  }
}

function publicError(error) {
  const message = error && error.message ? String(error.message) : '';
  if (message.indexOf('Достигнут бесплатный дневной лимит') === 0 ||
      message.indexOf('Достигнут дневной лимит') === 0 ||
      message.indexOf('Сеанс Google') === 0 ||
      message.indexOf('Для отправки приглашений') === 0 ||
      message.indexOf('Нельзя отправить') === 0 ||
      message.indexOf('Проверьте адрес') === 0 ||
      message.indexOf('Не удалось обновить состояние приглашений') === 0 ||
      message.indexOf('Приглашение') === 0 ||
      message.indexOf('Не удалось проверить') === 0) return message;
  return 'Не удалось отправить приглашение. Повторите попытку позже.';
}

function responsePage(requestId, ok, message, data) {
  const result = JSON.stringify({
    type: 'secret-library-invite-result',
    requestId: requestId,
    ok: ok,
    message: message,
    data: data === undefined ? null : data
  }).replace(/</g, '\\u003c');
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    '<p>Операция завершена. Вернитесь в Тайную Библиотеку.</p>' +
    '<script>window.top.postMessage(' + result + ', ' + JSON.stringify(SITE_ORIGIN) + ');</script>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

const ADMIN_EMAIL_ADDRESS = 'tssrkt777@gmail.com';
const ADMIN_SECTIONS_API = ['overview', 'users', 'relationships', 'invites', 'shares', 'events', 'banned', 'admins', 'texts'];
const FIRESTORE_REST_ROOT = 'https://firestore.googleapis.com/v1/projects/' +
  FIREBASE_PROJECT_ID + '/databases/(default)/documents/';

function handleAdminRequest(input) {
  const idToken = String(input.idToken || '');
  if (idToken.length < 100 || idToken.length > 5000) throw new Error('Сеанс Google истёк. Войдите снова.');
  const user = verifyFirebaseUser(idToken);
  const action = String(input.action || '');
  const data = input.data && typeof input.data === 'object' ? input.data : {};
  if (action === 'bootstrapAdmin') {
    if (normalizeEmail(user.email) !== ADMIN_EMAIL_ADDRESS) throw new Error('Первоначальная настройка доступна только владельцу проекта.');
    if (fsGet('bannedUsers/' + user.localId)) throw new Error('Доступ к Тайной Библиотеке заблокирован.');
    const admins = fsList('adminUsers');
    const current = fsGet('adminUsers/' + user.localId);
    if (admins.length && current?.role !== 'superadmin') throw new Error('Главный администратор уже настроен.');
    if (current?.role === 'superadmin') {
      fsSet('users/' + user.localId, { isAdmin: true });
      return { ok: true, alreadyAdmin: true };
    }
    fsSet('adminUsers/' + user.localId, {
      uid: user.localId, email: ADMIN_EMAIL_ADDRESS, role: 'superadmin', active: true,
      permissions: Object.fromEntries(ADMIN_SECTIONS_API.map(k => [k, true])),
      createdAt: new Date(), createdBy: 'bootstrap'
    });
    fsSet('users/' + user.localId, { isAdmin: true });
    fsAddEvent(user.localId, 'bootstrap-admin', null, {});
    return { ok: true, alreadyAdmin: false };
  }
  const actor = requireAdminApi(user.localId);
  switch (action) {
    case 'getAdminDashboard': return getAdminDashboardApi(actor);
    case 'setInvitationEmailTemplate': return setInvitationEmailTemplateApi(actor, data);
    case 'setAdminPermissions': return setAdminPermissionsApi(actor, data);
    case 'banLibraryUser': return banLibraryUserApi(actor, data);
    case 'restoreLibraryUser': return restoreLibraryUserApi(actor, data);
    case 'adminRevokeInvitation': return revokeInvitationApi(actor, data);
    case 'adminSetLibraryShare': return setLibraryShareApi(actor, data);
    default: throw new Error('Неизвестная административная операция.');
  }
}

function requireAdminApi(uid, permission) {
  if (fsGet('bannedUsers/' + uid)) throw new Error('Доступ к Тайной Библиотеке заблокирован.');
  const admin = fsGet('adminUsers/' + uid);
  if (!admin || admin.active !== true) throw new Error('Нет прав администратора.');
  if (admin.role !== 'superadmin' && permission && admin.permissions?.[permission] !== true) {
    throw new Error('Недостаточно прав для этого действия.');
  }
  return { uid: uid, admin: admin };
}

function getAdminDashboardApi(actor) {
  const p = actor.admin.role === 'superadmin'
    ? Object.fromEntries(ADMIN_SECTIONS_API.map(k => [k, true])) : (actor.admin.permissions || {});
  if (!Object.values(p).some(Boolean)) throw new Error('Не назначены права для просмотра админки.');
  const users = p.users || p.relationships ? fsList('users') : [];
  const banned = p.banned || p.users || p.relationships ? fsList('bannedUsers') : [];
  const admins = p.admins || p.users ? fsList('adminUsers') : [];
  const invites = p.invites ? fsList('pendingInvites').flatMap(inv => fsList('pendingInvites/' + inv.id + '/shares').map(item => ({
    ...item, email: inv.id
  }))) : [];
  const shares = p.shares || p.relationships ? fsList('libraryShares') : [];
  const directory = p.users || p.relationships ? fsList('userDirectory') : [];
  const emailByUid = new Map(directory.filter(item => item.uid && item.id).map(item => [item.uid, item.id]));
  const events = p.events ? fsList('adminEvents').sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 100) : [];
  const userRows = users.map(u => ({ ...u, uid: u.id, email: emailByUid.get(u.id) || '', banned: banned.some(b => b.id === u.id), admin: admins.some(a => a.id === u.id) }));
  return {
    permissions: p,
    counts: {
      users: p.users ? users.length : null,
      invitations: p.invites ? invites.length : null,
      acceptedInvitations: p.invites ? invites.filter(x => Boolean(x.claimedUid)).length : null,
      shares: p.shares ? shares.filter(x => x.active === true).length : null,
      admins: p.admins ? admins.length : null,
      banned: p.banned ? banned.length : null
    },
    users: p.users || p.relationships ? userRows : [],
    invitations: p.invites ? invites : [],
    shares: p.shares || p.relationships ? shares : [],
    admins: p.admins ? admins : [],
    banned: p.banned ? banned : [],
    events: p.events ? events : [],
    invitationEmailTemplate: p.texts ? getInvitationEmailTemplate() : null
  };
}

function getInvitationEmailTemplate() {
  const saved = fsGet('systemSettings/invitationEmail');
  return typeof saved?.body === 'string' ? saved.body : [
    'Доброго времени суток!',
    '',
    '{{inviterName}} приглашает вас в Тайное Общество Вольных Библиотекарей! О том, как вступить в наш закрытый клуб и какие плюшки вы от этого получите, можно прочитать здесь:',
    '',
    'https://tssrkt.github.io/secret_library/info.html',
    '',
    'Добро пожаловать в Тайную Библиотеку!'
  ].join('\n');
}

function renderInvitationEmailTemplate(inviterName) {
  return getInvitationEmailTemplate().replace(/\{\{\s*inviterName\s*\}\}/g, inviterName);
}

function setInvitationEmailTemplateApi(actor, data) {
  requireAdminApi(actor.uid, 'texts');
  const body = typeof data.body === 'string' ? data.body.trim() : '';
  if (!body || body.length > 10000 || !body.includes('{{inviterName}}')) {
    throw new Error('Текст должен содержать {{inviterName}} — место для имени пригласителя; максимум 10 000 символов.');
  }
  fsSet('systemSettings/invitationEmail', { body, updatedAt: new Date(), updatedBy: actor.uid });
  fsAddEvent(actor.uid, 'update-invitation-email-template', null, { length: body.length });
  return { ok: true, body };
}

function setAdminPermissionsApi(actor, data) {
  requireAdminApi(actor.uid, 'admins');
  const uid = String(data.uid || '');
  const permissions = data.permissions;
  if (!uid || uid === actor.uid || !permissions || typeof permissions !== 'object' ||
      Object.keys(permissions).some(k => !ADMIN_SECTIONS_API.includes(k) || typeof permissions[k] !== 'boolean')) {
    throw new Error('Некорректные права администратора.');
  }
  if (!fsGet('users/' + uid)) throw new Error('Участник не найден.');
  const old = fsGet('adminUsers/' + uid);
  if (old?.role === 'superadmin') throw new Error('Нельзя менять права главного администратора.');
  const active = data.active !== false;
  fsSet('adminUsers/' + uid, {
    uid, email: normalizeEmail(old?.email) || '', role: 'moderator', active, permissions,
    updatedAt: new Date(), updatedBy: actor.uid
  });
  fsSet('users/' + uid, { isAdmin: active });
  fsAddEvent(actor.uid, 'set-admin-permissions', uid, { permissions, active });
  return { ok: true };
}

function banLibraryUserApi(actor, data) {
  requireAdminApi(actor.uid, 'users');
  const uid = String(data.uid || '');
  const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 500) : '';
  if (!uid || uid === actor.uid) throw new Error('Нельзя заблокировать эту учётную запись.');
  const admin = fsGet('adminUsers/' + uid);
  if (admin?.role === 'superadmin') throw new Error('Главного администратора нельзя заблокировать.');
  const profile = fsGet('users/' + uid);
  if (!profile) throw new Error('Участник не найден.');
  fsSet('bannedUsers/' + uid, {
    uid, email: '', displayName: profile.displayName || '', reason, bannedBy: actor.uid,
    adminWasActive: Boolean(admin && admin.active === true), bannedAt: new Date()
  });
  if (admin) {
    fsSet('adminUsers/' + uid, { active: false, updatedAt: new Date(), updatedBy: actor.uid });
    fsSet('users/' + uid, { isAdmin: false });
  }
  fsAddEvent(actor.uid, 'ban-user', uid, { reason });
  return { ok: true };
}

function restoreLibraryUserApi(actor, data) {
  requireAdminApi(actor.uid, 'banned');
  const uid = String(data.uid || '');
  if (!uid) throw new Error('Не указан участник.');
  const banned = fsGet('bannedUsers/' + uid);
  if (!banned) return { ok: true };
  fsDelete('bannedUsers/' + uid);
  const admin = fsGet('adminUsers/' + uid);
  if (admin && banned.adminWasActive === true) {
    fsSet('adminUsers/' + uid, { active: true, updatedAt: new Date(), updatedBy: actor.uid });
    fsSet('users/' + uid, { isAdmin: true });
  }
  fsAddEvent(actor.uid, 'restore-user', uid, {});
  return { ok: true };
}

function revokeInvitationApi(actor, data) {
  requireAdminApi(actor.uid, 'invites');
  const email = normalizeEmail(data.email);
  const ownerUid = String(data.ownerUid || '');
  if (!isValidEmail(email) || !ownerUid) throw new Error('Некорректное приглашение.');
  const path = 'pendingInvites/' + encodeURIComponent(email) + '/shares/' + encodeURIComponent(ownerUid);
  const item = fsGet(path);
  if (!item) throw new Error('Приглашение не найдено.');
  if (item.claimedUid) throw new Error('Приглашение уже принято.');
  fsSet(path, { active: false, revokedAt: new Date(), revokedBy: actor.uid });
  fsAddEvent(actor.uid, 'revoke-invitation', null, { email, ownerUid });
  return { ok: true };
}

function setLibraryShareApi(actor, data) {
  requireAdminApi(actor.uid, 'shares');
  const id = String(data.id || '');
  if (!id || typeof data.active !== 'boolean') throw new Error('Некорректный доступ.');
  const current = fsGet('libraryShares/' + encodeURIComponent(id));
  if (!current) throw new Error('Связь доступа не найдена.');
  const protectedUids = [current.ownerUid, current.viewerUid].filter(Boolean);
  if (protectedUids.some(uid => fsGet('adminUsers/' + uid)?.role === 'superadmin')) {
    throw new Error('Нельзя изменять доступ, связанный с главным администратором.');
  }
  fsSet('libraryShares/' + encodeURIComponent(id), { active: data.active, revokedAt: data.active ? null : new Date() });
  fsAddEvent(actor.uid, data.active ? 'admin-open-share' : 'admin-close-share', current.viewerUid || null, { ownerUid: current.ownerUid || '' });
  return { ok: true };
}

function fsGet(path) {
  const response = fsRequest('get', path);
  return response ? { id: response.name.split('/').pop(), ...fsDecodeFields(response.fields || {}) } : null;
}
function fsList(path) {
  const out = [];
  let token = '';
  do {
    const url = FIRESTORE_REST_ROOT + path + '?pageSize=1000' + (token ? '&pageToken=' + encodeURIComponent(token) : '');
    const response = fsFetch(url, 'get');
    if (response.code !== 200) throw new Error('Не удалось прочитать данные Firebase.');
    const body = JSON.parse(response.text);
    (body.documents || []).forEach(doc => out.push({ id: doc.name.split('/').pop(), ...fsDecodeFields(doc.fields || {}) }));
    token = body.nextPageToken || '';
  } while (token);
  return out;
}
function fsSet(path, values) {
  const fields = fsEncodeFields(values);
  const mask = Object.keys(fields).map(key => 'updateMask.fieldPaths=' + encodeURIComponent(key)).join('&');
  const response = fsFetch(FIRESTORE_REST_ROOT + path + '?' + mask, 'patch', { fields: fields });
  if (response.code < 200 || response.code >= 300) throw new Error('Не удалось сохранить данные Firebase (' + response.code + ').');
}
function fsDelete(path) {
  const response = fsFetch(FIRESTORE_REST_ROOT + path, 'delete');
  if (response.code !== 200 && response.code !== 204 && response.code !== 404) throw new Error('Не удалось удалить запись Firebase.');
}
function fsAddEvent(actorUid, action, targetUid, details) {
  const id = Utilities.getUuid();
  fsSet('adminEvents/' + id, { actorUid, action, targetUid: targetUid || null, details: details || {}, createdAt: new Date() });
}
function fsRequest(method, path, body) {
  const response = fsFetch(FIRESTORE_REST_ROOT + path, method, body);
  if (response.code === 404) return null;
  if (response.code < 200 || response.code >= 300) throw new Error('Операция Firebase не выполнена (' + response.code + ').');
  return response.text ? JSON.parse(response.text) : {};
}
function fsFetch(url, method, body) {
  const options = { method: method, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true };
  if (body !== undefined) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
  const response = UrlFetchApp.fetch(url, options);
  return { code: response.getResponseCode(), text: response.getContentText() };
}
function fsDecodeFields(fields) {
  const out = {};
  Object.keys(fields).forEach(key => { out[key] = fsDecodeValue(fields[key]); });
  return out;
}
function fsDecodeValue(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('mapValue' in value) return fsDecodeFields(value.mapValue.fields || {});
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(fsDecodeValue);
  return null;
}
function fsEncodeFields(values) {
  const out = {};
  Object.keys(values).forEach(key => { out[key] = fsEncodeValue(values[key]); });
  return out;
}
function fsEncodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(fsEncodeValue) } };
  if (typeof value === 'object') return { mapValue: { fields: fsEncodeFields(value) } };
  return { nullValue: null };
}
function publicAdminError(error) {
  const message = error && error.message ? String(error.message) : '';
  if (/^(Сеанс Google|Для отправки приглашений|Нет прав администратора|Доступ к Тайной Библиотеке|Главный администратор|Первоначальная настройка|Учётная запись администратора|Недостаточно прав|Не назначены права|Некорректные права|Нельзя менять права|Участник не найден|Нельзя заблокировать|Главного администратора|Не указан участник|Приглашение не найдено|Приглашение уже принято|Некорректное приглашение|Некорректный доступ|Связь доступа не найдена)/.test(message)) return message;
  return 'Административная операция не выполнена. Проверьте разрешения Apps Script и доступ к Firebase.';
}

function adminResponsePage(requestId, ok, message, result) {
  const payload = JSON.stringify({ type: 'secret-library-admin-result', requestId, ok, message, result })
    .replace(/</g, '\\u003c');
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><script>window.top.postMessage(' +
    payload + ', ' + JSON.stringify(SITE_ORIGIN) + ');</script></body></html>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

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
  let emailSent = false;
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
    emailSent = true;

    stage = 'mark-sent';
    finishSend(user.localId, email, true, reservation.reservationId);
    reservation = null;
    return responsePage(requestId, true, 'Запрос обработан. Если получателю нужно приглашение, письмо отправлено.');
  } catch (error) {
    if (reservation && reservation.status === 'reserved' && !emailSent) {
      try { finishSend(reservation.uid, reservation.email, false, reservation.reservationId); } catch (_) {}
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
      .map(function (entry) {
        return typeof entry === 'number' ? { id: 'legacy:' + entry, at: entry, status: 'sent' } : entry;
      })
      .filter(function (entry) {
        return entry && Number.isFinite(Number(entry.at)) && now - Number(entry.at) < 24 * 60 * 60 * 1000;
      });
    if (recent.length >= MAX_INVITES_PER_USER_PER_DAY) {
      throw new Error('Достигнут дневной лимит приглашений. Попробуйте завтра.');
    }
    const reservationId = Utilities.getUuid();
    recent.push({ id: reservationId, at: now, status: 'reserved' });
    properties.setProperty(dailyKey, JSON.stringify(recent));
    properties.setProperty(key, JSON.stringify({ status: 'sending', at: now, lastSentAt: lastSentAt, reservationId: reservationId }));
    return { status: 'reserved', uid: uid, email: email, key: key, dailyKey: dailyKey, reservationId: reservationId };
  } finally {
    lock.releaseLock();
  }
}

function finishSend(uid, email, success, reservationId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const properties = PropertiesService.getScriptProperties();
    const key = reservationKey(uid, email);
    const current = JSON.parse(properties.getProperty(key) || 'null');
    const dailyKey = 'daily:' + uid;
    const now = Date.now();
    const recent = JSON.parse(properties.getProperty(dailyKey) || '[]')
      .map(function (entry) {
        return typeof entry === 'number' ? { id: 'legacy:' + entry, at: entry, status: 'sent' } : entry;
      })
      .filter(function (entry) {
        return entry && Number.isFinite(Number(entry.at)) && now - Number(entry.at) < 24 * 60 * 60 * 1000;
      });
    if (success) {
      const sentAt = now;
      properties.setProperty(key, JSON.stringify({ status: 'sent', at: sentAt, lastSentAt: sentAt }));
      const reservation = recent.find(function (entry) { return entry.id === reservationId; });
      if (reservation) {
        reservation.at = sentAt;
        reservation.status = 'sent';
      }
    } else {
      properties.setProperty(key, JSON.stringify({ status: 'failed', at: now, lastSentAt: Number(current?.lastSentAt) || 0 }));
      for (let i = recent.length - 1; i >= 0; i--) {
        if (recent[i].id === reservationId) recent.splice(i, 1);
      }
    }
    properties.setProperty(dailyKey, JSON.stringify(recent));
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
    case 'getAdminDashboardSummary': return getAdminDashboardSummaryApi(actor);
    case 'getAdminCollectionPage': return getAdminCollectionPageApi(actor, data);
    case 'getAdminBranch': return getAdminBranchApi(actor, data);
    case 'getAdminRelationshipRoots': return getAdminRelationshipRootsApi(actor, data);
    case 'getAdminUserHistory': return getAdminUserHistoryApi(actor, data);
    case 'getAdminUserCard': return getAdminUserCardApi(actor, data);
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
  const invites = p.invites ? fsListInviteShares() : [];
  const shares = p.shares || p.relationships ? fsList('libraryShares') : [];
  const directory = p.users || p.relationships ? fsList('userDirectory') : [];
  const emailByUid = new Map(directory.filter(item => item.uid && item.id).map(item => [item.uid, item.id]));
  const events = p.events ? fsListPage('adminEvents', 100, 'createdAt desc') : [];
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

function getAdminDashboardSummaryApi(actor) {
  const p = actor.admin.role === 'superadmin'
    ? Object.fromEntries(ADMIN_SECTIONS_API.map(k => [k, true])) : (actor.admin.permissions || {});
  if (!Object.values(p).some(Boolean)) throw new Error('Не назначены права для просмотра админки.');
  const counts = {
    users: p.users ? fsCount('users') : null,
    invitations: p.invites ? fsCount('shares', { fieldPath: 'inviteeEmail', op: 'NOT_EQUAL', value: { nullValue: null } }, true) : null,
    acceptedInvitations: p.invites ? fsCount('shares', { fieldPath: 'claimedUid', op: 'NOT_EQUAL', value: { nullValue: null } }, true) : null,
    shares: p.shares ? fsCount('libraryShares', { fieldPath: 'active', op: 'EQUAL', value: { booleanValue: true } }) : null,
    admins: p.admins ? fsCount('adminUsers') : null,
    banned: p.banned ? fsCount('bannedUsers') : null
  };
  const superadminUid = fsFindSuperAdminUid();
  return { permissions: p, counts, superAdminUid: superadminUid, invitationEmailTemplate: p.texts ? getInvitationEmailTemplate() : null };
}

function fsFindSuperAdminUid() {
  const response = fsFetch(FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery', 'post', {
    structuredQuery: {
      from: [{ collectionId: 'adminUsers' }],
      where: { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: 'superadmin' } } },
      limit: 1
    }
  });
  if (response.code !== 200) throw new Error('Не удалось определить главного администратора.');
  const document = JSON.parse(response.text).find(row => row && row.document)?.document;
  return document ? document.name.split('/').pop() : null;
}
function fsCount(collectionId, filter, allDescendants) {
  const structuredQuery = { from: [{ collectionId, ...(allDescendants ? { allDescendants: true } : {}) }] };
  if (Array.isArray(filter)) structuredQuery.where = { compositeFilter: { op: 'AND', filters: filter.map(item => ({ fieldFilter: { field: { fieldPath: item.fieldPath }, op: item.op, value: item.value } })) } };
  else if (filter) structuredQuery.where = { fieldFilter: { field: { fieldPath: filter.fieldPath }, op: filter.op, value: filter.value } };
  const response = fsFetch(FIRESTORE_REST_ROOT.slice(0, -1) + ':runAggregationQuery', 'post', {
    structuredAggregationQuery: { structuredQuery, aggregations: [{ count: {}, alias: 'total' }] }
  });
  if (response.code !== 200) throw new Error('Не удалось получить счётчики Firebase (' + response.code + ').');
  const rows = JSON.parse(response.text);
  const value = rows.find(row => row && row.result)?.result?.aggregateFields?.total?.integerValue;
  return Number(value || 0);
}
function getAdminCollectionPageApi(actor, data) {
  const config = {
    users: ['users', 'users'], invites: ['invites', 'pendingInvites'],
    shares: ['shares', 'libraryShares'], events: ['events', 'adminEvents'],
    banned: ['banned', 'bannedUsers'], admins: ['admins', 'adminUsers']
  };
  const section = String(data.section || '');
  if (!config[section]) throw new Error('Неизвестный раздел админки.');
  requireAdminApi(actor.uid, config[section][0]);
  let page;
  if (section === 'invites') page = fsQueryInvitationPage(25, data.cursor || '', data.filter || '');
  else if (section === 'users' && String(data.search || '').trim()) page = fsQueryUsersSearchPage(25, data.cursor || '', String(data.search).trim());
  else if ((section === 'shares' || section === 'admins') && ['active', 'inactive'].includes(data.filter)) {
    page = fsQueryFilteredPage(config[section][1], 'active', data.filter === 'active', 25, data.cursor || '');
  } else page = fsQueryPage(config[section][1], 25, data.cursor || '');
  if (section === 'users') {
    const flags = fsGetAdminUserFlags(page.items.map(user => user.id));
    page.items = page.items.map(user => ({ ...user, uid: user.id, banned: flags.banned.has(user.id), admin: flags.admins.has(user.id) }));
  }
  return page;
}

function fsGetAdminUserFlags(uids) {
  const result = { banned: new Set(), admins: new Set() };
  if (!uids.length) return result;
  fsQueryDocumentIds('bannedUsers', uids).forEach(uid => result.banned.add(uid));
  fsQueryDocumentIds('adminUsers', uids).forEach(uid => result.admins.add(uid));
  return result;
}
function fsQueryDocumentIds(collectionId, ids) {
  const values = ids.slice(0, 30).map(uid => ({ referenceValue: 'projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents/' + collectionId + '/' + uid }));
  if (!values.length) return [];
  const response = fsFetch(FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery', 'post', {
    structuredQuery: { from: [{ collectionId }], where: { fieldFilter: { field: { fieldPath: '__name__' }, op: 'IN', value: { arrayValue: { values } } } }, limit: values.length }
  });
  if (response.code !== 200) throw new Error('Не удалось получить статусы участников.');
  return JSON.parse(response.text).filter(row => row && row.document).map(row => row.document.name.split('/').pop());
}
function getAdminRelationshipRootsApi(actor, data) {
  requireAdminApi(actor.uid, 'relationships');
  return fsQueryFilteredPage('users', 'invitedByUid', null, 25, data.cursor || '');
}
function getAdminBranchApi(actor, data) {
  requireAdminApi(actor.uid, 'relationships');
  const uid = String(data.uid || '');
  if (!uid || uid.length > 128) throw new Error('Некорректный UID участника.');
  return fsQueryFilteredPage('users', 'invitedByUid', uid, 25, data.cursor || '');
}

function getAdminUserCardApi(actor, data) {
  const current = requireAdminApi(actor.uid);
  if (current.admin.role !== 'superadmin' && current.admin.permissions?.users !== true && current.admin.permissions?.relationships !== true) {
    throw new Error('Недостаточно прав для просмотра карточки участника.');
  }
  const uid = String(data.uid || '');
  if (!uid || uid.length > 128) throw new Error('Некорректный UID участника.');
  const profile = fsGet('users/' + encodeURIComponent(uid));
  if (!profile) throw new Error('Участник не найден.');
  const directory = fsQueryGroupByField('userDirectory', 'uid', uid, 1)[0];
  const inviter = profile.invitedByUid ? fsGet('users/' + encodeURIComponent(profile.invitedByUid)) : null;
  const invited = fsQueryFilteredPage('users', 'invitedByUid', uid, 100, '').items;
  const outgoing = fsQueryGroupByField('libraryShares', 'ownerUid', uid, 100);
  const incoming = fsQueryGroupByField('libraryShares', 'viewerUid', uid, 100);
  return {
    user: { ...profile, uid, email: directory?.id ? decodeURIComponent(directory.id) : '' },
    inviter: inviter ? { ...inviter, uid: profile.invitedByUid } : null,
    invited: invited.map(user => ({ ...user, uid: user.id })),
    admin: fsGet('adminUsers/' + encodeURIComponent(uid)),
    banned: fsGet('bannedUsers/' + encodeURIComponent(uid)),
    outgoing: outgoing.filter(share => share.active === true),
    incoming: incoming.filter(share => share.active === true)
  };
}
function getAdminUserHistoryApi(actor, data) {
  requireAdminApi(actor.uid, 'users');
  const uid = String(data.uid || '');
  if (!uid || uid.length > 128) throw new Error('Некорректный UID участника.');
  const invitations = fsQueryGroupByField('shares', 'ownerUid', uid, 100, true)
    .concat(fsQueryGroupByField('shares', 'claimedUid', uid, 100, true));
  const events = fsQueryGroupByField('adminEvents', 'targetUid', uid, 100)
    .concat(fsQueryGroupByField('adminEvents', 'actorUid', uid, 100));
  return {
    outgoing: fsQueryGroupByField('libraryShares', 'ownerUid', uid, 100),
    incoming: fsQueryGroupByField('libraryShares', 'viewerUid', uid, 100),
    invitations: [...new Map(invitations.map(item => [item.id + ':' + item.email, item])).values()],
    events: [...new Map(events.map(item => [item.id, item])).values()].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 100)
  };
}

function fsQueryPage(path, pageSize, cursor) {
  return fsQueryFilteredPage(path, '', '', pageSize, cursor);
}

function fsQueryFilteredPage(path, filterField, filterValue, pageSize, cursor, filterOp) {
  const size = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const structuredQuery = {
    from: [{ collectionId: path }],
    orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    limit: size + 1
  };
  if (filterField) structuredQuery.where = { fieldFilter: {
    field: { fieldPath: filterField }, op: filterOp || 'EQUAL', value: filterValue === null ? { nullValue: null } : typeof filterValue === 'boolean' ? { booleanValue: filterValue } : { stringValue: String(filterValue) }
  } };
  if (cursor) {
    let decoded;
    try { decoded = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(cursor)).getDataAsString()); }
    catch (_) { throw new Error('Некорректный курсор страницы.'); }
    const expectedPrefix = 'projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents/' + path + '/';
    if (decoded.path !== path || typeof decoded.name !== 'string' || !decoded.name.startsWith(expectedPrefix) || decoded.name !== expectedPrefix + decoded.id || String(decoded.id).includes('/')) throw new Error('Некорректный курсор страницы.');
    structuredQuery.startAt = { before: false, values: [{ referenceValue: decoded.name }] };
  }
  const response = fsFetch(FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery', 'post', { structuredQuery });
  if (response.code !== 200) throw new Error('Не удалось загрузить страницу Firebase (' + response.code + ').');
  const rows = JSON.parse(response.text).filter(row => row && row.document).map(row => ({
    id: row.document.name.split('/').pop(), ...fsDecodeFields(row.document.fields || {}), _documentName: row.document.name
  }));
  const hasMore = rows.length > size;
  const items = rows.slice(0, size);
  const last = items[items.length - 1];
  const lastDocumentName = last?._documentName || '';
  items.forEach(item => delete item._documentName);
  return {
    items, hasMore,
    nextCursor: hasMore && last ? Utilities.base64EncodeWebSafe(JSON.stringify({ path, id: last.id, name: lastDocumentName })) : null
  };
}

function fsQueryUsersSearchPage(pageSize, cursor, search) {
  const size = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const term = String(search || '').trim();
  if (!term || term.length > 80) throw new Error('Поисковый запрос должен содержать от 1 до 80 символов.');
  const structuredQuery = {
    from: [{ collectionId: 'users' }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'displayName' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: term } } },
      { fieldFilter: { field: { fieldPath: 'displayName' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: term + '\uf8ff' } } }
    ] } },
    orderBy: [
      { field: { fieldPath: 'displayName' }, direction: 'ASCENDING' },
      { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }
    ],
    limit: size + 1
  };
  if (cursor) {
    let decoded;
    try { decoded = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(cursor)).getDataAsString()); }
    catch (_) { throw new Error('Некорректный курсор поиска.'); }
    const prefix = 'projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents/users/';
    if (decoded.path !== '@users-search' || typeof decoded.name !== 'string' || !decoded.name.startsWith(prefix) || decoded.name !== prefix + decoded.id || typeof decoded.displayName !== 'string') throw new Error('Некорректный курсор поиска.');
    structuredQuery.startAt = { before: false, values: [{ stringValue: decoded.displayName }, { referenceValue: decoded.name }] };
  }
  const response = fsFetch(FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery', 'post', { structuredQuery });
  if (response.code !== 200) throw new Error('Не удалось выполнить поиск участников (' + response.code + ').');
  const rows = JSON.parse(response.text).filter(row => row && row.document).map(row => ({
    id: row.document.name.split('/').pop(), ...fsDecodeFields(row.document.fields || {}), _documentName: row.document.name
  }));
  const hasMore = rows.length > size;
  const items = rows.slice(0, size);
  const last = items[items.length - 1];
  const lastDocumentName = last?._documentName || '';
  const lastDisplayName = last?.displayName || '';
  items.forEach(item => delete item._documentName);
  return { items, hasMore, nextCursor: hasMore && last ? Utilities.base64EncodeWebSafe(JSON.stringify({
    path: '@users-search', id: last.id, name: lastDocumentName, displayName: lastDisplayName
  })) : null };
}
function fsQueryInvitationPage(pageSize, cursor, filter) {
  const size = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const structuredQuery = {
    from: [{ collectionId: 'shares', allDescendants: true }],
    where: filter === 'accepted'
      ? { fieldFilter: { field: { fieldPath: 'claimedUid' }, op: 'NOT_EQUAL', value: { nullValue: null } } }
      : filter === 'pending'
        ? { fieldFilter: { field: { fieldPath: 'claimedUid' }, op: 'EQUAL', value: { nullValue: null } } }
        : filter === 'revoked'
          ? { fieldFilter: { field: { fieldPath: 'active' }, op: 'EQUAL', value: { booleanValue: false } } }
          : { fieldFilter: { field: { fieldPath: 'inviteeEmail' }, op: 'NOT_EQUAL', value: { nullValue: null } } },
    orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    limit: size + 1
  };
  if (cursor) {
    let decoded;
    try { decoded = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(cursor)).getDataAsString()); }
    catch (_) { throw new Error('Некорректный курсор страницы.'); }
    if (decoded.path !== '@invites' || typeof decoded.name !== 'string' ||
        !decoded.name.startsWith('projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents/pendingInvites/') || !decoded.name.includes('/shares/') ||
        decoded.name.split('/').pop() !== decoded.id) throw new Error('Некорректный курсор страницы.');
    structuredQuery.startAt = { before: false, values: [{ referenceValue: decoded.name }] };
  }
  const response = fsFetch(FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery', 'post', { structuredQuery });
  if (response.code !== 200) throw new Error('Не удалось загрузить приглашения Firebase (' + response.code + ').');
  const rows = JSON.parse(response.text).filter(row => row && row.document &&
    row.document.name.includes('/documents/pendingInvites/') && row.document.name.includes('/shares/'))
    .map(row => ({
      id: row.document.name.split('/').pop(),
      email: decodeURIComponent(row.document.name.split('/documents/pendingInvites/')[1].split('/shares/')[0]),
      ...fsDecodeFields(row.document.fields || {}), _documentName: row.document.name
    }));
  const hasMore = rows.length > size;
  const items = rows.slice(0, size);
  const last = items[items.length - 1];
  const lastDocumentName = last?._documentName || '';
  items.forEach(item => delete item._documentName);
  return { items, hasMore, nextCursor: hasMore && last
    ? Utilities.base64EncodeWebSafe(JSON.stringify({ path: '@invites', id: last.id, name: lastDocumentName }))
    : null };
}
function fsQueryGroupByField(collectionId, field, value, limit, nestedOnly) {
  const structuredQuery = {
    from: [{ collectionId, allDescendants: true }],
    where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: String(value) } } },
    limit: Math.min(100, Number(limit) || 100)
  };
  const response = fsFetch(FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery', 'post', { structuredQuery });
  if (response.code !== 200) throw new Error('Не удалось загрузить историю участника.');
  return JSON.parse(response.text).filter(row => row && row.document)
    .filter(row => !nestedOnly || row.document.name.includes('/pendingInvites/'))
    .map(row => ({
      id: row.document.name.split('/').pop(),
      ...(nestedOnly ? { email: decodeURIComponent(row.document.name.split('/documents/pendingInvites/')[1].split('/shares/')[0]) } : {}),
      ...fsDecodeFields(row.document.fields || {})
    }));
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
function fsListPage(path, pageSize, orderBy) {
  const size = Math.max(1, Math.min(1000, Number(pageSize) || 100));
  const query = ['pageSize=' + size];
  if (orderBy) query.push('orderBy=' + encodeURIComponent(orderBy));
  const response = fsFetch(FIRESTORE_REST_ROOT + path + '?' + query.join('&'), 'get');
  if (response.code !== 200) throw new Error('Не удалось прочитать данные Firebase.');
  const body = JSON.parse(response.text);
  return (body.documents || []).map(doc => ({ id: doc.name.split('/').pop(), ...fsDecodeFields(doc.fields || {}) }));
}
function fsListInviteShares() {
  const url = FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery';
  const response = fsFetch(url, 'post', {
    structuredQuery: { from: [{ collectionId: 'shares', allDescendants: true }] }
  });
  if (response.code !== 200) throw new Error('Не удалось прочитать данные Firebase.');
  const rows = JSON.parse(response.text);
  const out = [];
  rows.forEach(row => {
    const doc = row && row.document;
    if (!doc || typeof doc.name !== 'string') return;
    const marker = '/documents/pendingInvites/';
    const markerIndex = doc.name.indexOf(marker);
    if (markerIndex < 0) return;
    const segments = doc.name.slice(markerIndex + marker.length).split('/');
    if (segments.length !== 3 || segments[1] !== 'shares') return;
    out.push({ id: segments[2], ...fsDecodeFields(doc.fields || {}), email: segments[0] });
  });
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

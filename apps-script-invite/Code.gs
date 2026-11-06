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
    stage = 'check-blocked-recipient';
    if (isBlockedInvitationEmail(email)) {
      deactivateBlockedInvitation(email, user.localId);
      throw new Error('Данный емейл заблокирован');
    }
    if (invitation.claimedUid) {
      return responsePage(requestId, true, 'Запрос обработан. Если получателю нужно приглашение, письмо отправлено.');
    }
    stage = 'check-unique-invitation-limit';
    const invitationCount = enforceUniqueInvitationLimit(user.localId, email, invitation);
    stage = 'reserve-send';
    reservation = reserveSend(user.localId, email, invitation.emailSentAt || (invitation.emailStatus === 'sent' ? invitation.createdAt : null));
    if (reservation.status === 'cooldown' || reservation.status === 'sending') {
      // Do not reveal whether an address belongs to an existing member.
      return responsePage(requestId, true, 'Запрос обработан. Если получателю нужно приглашение, письмо отправлено.');
    }

    stage = 'recheck-blocked-recipient';
    if (isBlockedInvitationEmail(email)) {
      deactivateBlockedInvitation(email, user.localId);
      throw new Error('Данный емейл заблокирован');
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
    return responsePage(requestId, true, invitationSuccessMessage(user.localId, invitationCount));
  } catch (error) {
    if (reservation && reservation.status === 'reserved' && !emailSent) {
      try { finishSend(reservation.uid, reservation.email, false, reservation.reservationId); } catch (_) {}
    }
    console.error(adminRequest ? 'Admin request failed' : 'Invitation mailer failed', {
      stage: stage,
      name: error && error.name ? String(error.name) : 'UnknownError',
      message: error && error.message ? String(error.message).slice(0, 500) : 'No error message'
    });
    return adminRequest
      ? adminResponsePage(requestId, false, publicAdminError(error), null)
      : responsePage(requestId, false, publicError(error));
  }
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isValidUid(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isValidLibraryShareId(value) {
  if (typeof value !== 'string' || value.length > 258) return false;
  const parts = value.split('__');
  return parts.length === 2 && parts.every(isValidUid);
}

function isValidEmail(value) {
  return value.length <= 254 && /^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(value);
}

function isBlockedInvitationEmail(email) {
  const address = normalizeEmail(email);
  const directory = fsGet('userDirectory/' + encodeURIComponent(address));
  if (directory && isValidUid(directory.uid) && fsGet('bannedUsers/' + encodeURIComponent(directory.uid))) return true;

  // Older ban records may contain the email but have no directory entry.
  const response = fsFetch(FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery', 'post', {
    structuredQuery: {
      from: [{ collectionId: 'bannedUsers' }],
      where: { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: address } } },
      limit: 1
    }
  });
  if (response.code !== 200) throw new Error('Не удалось проверить блокировку адреса получателя.');
  return JSON.parse(response.text).some(row => row && row.document);
}

function deactivateBlockedInvitation(email, ownerUid) {
  const path = 'pendingInvites/' + encodeURIComponent(email) + '/shares/' + encodeURIComponent(ownerUid);
  const invitation = fsGet(path);
  if (!invitation || invitation.ownerUid !== ownerUid || invitation.active !== true || invitation.claimedUid) return;
  fsSet(path, { active: false, revokedAt: new Date(), revokedBy: 'system' });
}

function verifyFirebaseUser(idToken) {
  // Cache successful Firebase identity lookups briefly to reduce parallel request bursts.
  // Only a digest is used in the cache key; the raw ID token is never stored.
  const cache = CacheService.getScriptCache();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken, Utilities.Charset.UTF_8);
  const tokenHash = digest.map(function (chr) { return (chr < 0 ? chr + 256 : chr).toString(16).padStart(2, '0'); }).join('');
  const cacheKey = 'verified_user_' + tokenHash;
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    lock.waitLock(5000);
    locked = true;
    const cachedAfterLock = cache.get(cacheKey);
    if (cachedAfterLock) return JSON.parse(cachedAfterLock);
  const response = UrlFetchApp.fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ idToken: idToken }),
      muteHttpExceptions: true
    }
  );
  if (response.getResponseCode() !== 200) {
    const status = response.getResponseCode();
    if (status === 429) throw new Error('Firebase Auth accounts:lookup failed (HTTP 429).');
    throw new Error('\u0421\u0435\u0430\u043d\u0441 Google \u0438\u0441\u0442\u0451\u043a. \u041f\u0435\u0440\u0435\u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0438\u0442\u0435 Google \u0438 \u043f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u0435 \u043f\u043e\u043f\u044b\u0442\u043a\u0443.');
  }
  const body = JSON.parse(response.getContentText());
  const user = body.users && body.users[0];
  const googleProvider = user && Array.isArray(user.providerUserInfo) &&
    user.providerUserInfo.some(function (provider) { return provider.providerId === 'google.com'; });
  if (!user || !user.localId || user.disabled === true || user.emailVerified !== true || !googleProvider) {
    throw new Error('Для отправки приглашений нужен подтверждённый Google-сеанс.');
  }
  const cachedUser = {
    localId: user.localId,
    email: user.email || '',
    emailVerified: user.emailVerified === true,
    disabled: user.disabled === true,
    providerUserInfo: [{ providerId: 'google.com' }]
  };
  cache.put(cacheKey, JSON.stringify(cachedUser), 300);
  return cachedUser;
  } finally {
    if (locked) {
      try { lock.releaseLock(); } catch (_) {}
    }
  }
}

function readOwnerDisplayName(idToken, uid) {
  // Keep the cache scoped to both the UID and the caller's token digest.
  const cache = CacheService.getScriptCache();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken, Utilities.Charset.UTF_8);
  const tokenHash = digest.map(function (chr) { return (chr < 0 ? chr + 256 : chr).toString(16).padStart(2, '0'); }).join('');
  const cacheKey = 'owner_name_' + tokenHash + '_' + uid;
  const cachedName = cache.get(cacheKey);
  if (cachedName) return cachedName;

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
  const result = name.trim().slice(0, 160);
  cache.put(cacheKey, result, 300);
  return result;
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
  return decodePendingInvitationResponse(response.getResponseCode(), response.getContentText(), email, uid);
}

function readPendingInvitationsMany(idToken, emails, uid) {
  if (!emails.length) return [];
  if (typeof UrlFetchApp.fetchAll !== 'function' || emails.length === 1) {
    return emails.map(email => readPendingInvitation(idToken, email, uid));
  }
  const requests = emails.map(email => ({
    url: 'https://firestore.googleapis.com/v1/projects/' + FIREBASE_PROJECT_ID +
      '/databases/(default)/documents/pendingInvites/' + encodeURIComponent(email) + '/shares/' + encodeURIComponent(uid),
    method: 'get',
    headers: { Authorization: 'Bearer ' + idToken },
    muteHttpExceptions: true
  }));
  return UrlFetchApp.fetchAll(requests).map((response, index) =>
    decodePendingInvitationResponse(response.getResponseCode(), response.getContentText(), emails[index], uid));
}

function decodePendingInvitationResponse(status, text, email, uid) {
  if (status === 404) return null;
  if (status !== 200) throw new Error('Не удалось проверить приглашение в Firebase. Повторите попытку.');
  const fields = JSON.parse(text).fields || {};
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
  const recipientEmails = emails.filter(email => email !== normalizeEmail(user.email));
  const invitations = readPendingInvitationsMany(idToken, recipientEmails, user.localId);
  const invitationByEmail = new Map(recipientEmails.map((email, index) => [email, invitations[index]]));
  emails.forEach(function (email) {
    if (email === normalizeEmail(user.email)) return;
    const invitation = invitationByEmail.get(email);
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

function invitationSuccessMessage(uid, invitationCount) {
  const admin = fsGet('adminUsers/' + uid);
  if (admin && admin.active === true) return 'Приглашение отправлено.';
  const count = Number.isInteger(invitationCount) ? invitationCount : 0;
  return 'Приглашение отправлено (' + count + ' из ' + getInvitationLimit() + ').';
}

function enforceUniqueInvitationLimit(uid, email, invitation) {
  const admin = fsGet('adminUsers/' + uid);
  if (admin && admin.active === true) return null;

  const limit = getInvitationLimit();
  const count = fsListInviteSharesByOwner(uid).length;
  const current = JSON.parse(PropertiesService.getScriptProperties().getProperty(reservationKey(uid, email)) || 'null');
  const previouslySent = Boolean(invitation.emailSentAt || invitation.emailStatus === 'sent' || current?.status === 'sent');
  // The pending share is created before this endpoint is called, so the current
  // recipient is included in the count. Previously sent recipients remain eligible for retries.
  if (count > limit && !previouslySent) {
    throw new Error('Ваш лимит на приглашения исчерпан.');
  }
  return count;
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
  if (message.indexOf('Ваш лимит на приглашения исчерпан') === 0 ||
      message.indexOf('Достигнут бесплатный дневной лимит') === 0 ||
      message.indexOf('Достигнут дневной лимит') === 0 ||
      message.indexOf('Сеанс Google') === 0 ||
      message.indexOf('Для отправки приглашений') === 0 ||
      message.indexOf('Нельзя отправить') === 0 ||
      message.indexOf('Проверьте адрес') === 0 ||
      message.indexOf('Не удалось обновить состояние приглашений') === 0 ||
      message.indexOf('Приглашение') === 0 ||
      message.indexOf('Данный емейл заблокирован') === 0 ||
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
  }).replace(/</g, '\\u003c').replace(/[^\x00-\x7F]/g, function (character) {
    return '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0');
  });
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    '<p>Операция завершена. Вернитесь в Тайную Библиотеку.</p>' +
    '<script>window.top.postMessage(' + result + ', ' + JSON.stringify(SITE_ORIGIN) + ');</script>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getBootstrapAdminEmail() {
  return normalizeEmail(PropertiesService.getScriptProperties().getProperty('BOOTSTRAP_ADMIN_EMAIL') || '');
}
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
    const bootstrapEmail = getBootstrapAdminEmail();
    if (!bootstrapEmail || normalizeEmail(user.email) !== bootstrapEmail) throw new Error('Первоначальная настройка доступна только владельцу проекта.');
    const current = getAdminRecordCached(user.localId);
    if (current?.role === 'superadmin' && current.active === true) {
      fsSet('users/' + user.localId, { isAdmin: true });
      return { ok: true, alreadyAdmin: true };
    }
    const admins = fsList('adminUsers');
    // Do not mistake the presence of moderators for an existing superadmin.
    // This lets the configured bootstrap account recover if the superadmin record
    // was lost, while still refusing to create a second superadmin.
    const existingSuperAdmin = admins.find(admin => admin.role === 'superadmin');
    if (existingSuperAdmin && existingSuperAdmin.id !== user.localId && current?.role !== 'superadmin') {
      throw new Error('Главный администратор уже настроен.');
    }
    if (current?.role === 'superadmin') {
      fsSet('users/' + user.localId, { isAdmin: true });
      return { ok: true, alreadyAdmin: true };
    }
    fsSet('adminUsers/' + user.localId, {
      uid: user.localId, email: bootstrapEmail, role: 'superadmin', active: true,
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
    case 'setInvitationLimit': return setInvitationLimitApi(actor, data);
    case 'setAdminPermissions': return setAdminPermissionsApi(actor, data);
    case 'banLibraryUser': return banLibraryUserApi(actor, data);
    case 'restoreLibraryUser': return restoreLibraryUserApi(actor, data);
    case 'adminRevokeInvitation': return revokeInvitationApi(actor, data);
    case 'adminSetLibraryShare': return setLibraryShareApi(actor, data);
    default: throw new Error('Неизвестная административная операция.');
  }
}

function requireAdminApi(uid, permission) {
  // Admin access is determined by the admin record, not the user ban list.
  const admin = getAdminRecordCached(uid);
  if (!admin || admin.active !== true) throw new Error('Нет прав администратора.');
  if (admin.role !== 'superadmin' && permission && admin.permissions?.[permission] !== true) {
    throw new Error('Недостаточно прав для этого действия.');
  }
  return { uid: uid, admin: admin };
}

function getAdminDashboardApi(actor) {
  const p = actor.admin.role === 'superadmin'
    ? Object.fromEntries(ADMIN_SECTIONS_API.map(k => [k, true])) : sanitizeAdminPermissions(actor.admin.permissions || {});
  if (!Object.values(p).some(Boolean)) throw new Error('Не назначены права для просмотра админки.');
  const users = p.users || p.relationships ? fsList('users') : [];
  const banned = p.banned || p.users || p.relationships ? fsList('bannedUsers') : [];
  const admins = p.admins || p.users ? fsList('adminUsers') : [];
  const invites = p.invites ? fsListInviteShares() : [];
  const shares = p.shares || p.relationships ? fsList('libraryShares') : [];
  // Relationship-only moderators need the graph, not the private email directory.
  const directory = p.users ? fsList('userDirectory') : [];
  const emailByUid = new Map(directory.filter(item => item.uid && item.id).map(item => [item.uid, item.id]));
  const events = p.events ? fsListPage('adminEvents', 100, 'createdAt desc') : [];
  const userRows = users.map(u => ({ ...sanitizeRelationshipProfile(u), uid: u.id, email: p.users ? (emailByUid.get(u.id) || '') : '', banned: banned.some(b => b.id === u.id), admin: admins.some(a => a.id === u.id) }));
  const visibleShares = redactPrivateEmails(actor, shares, 'shares');
  const visibleAdmins = redactPrivateEmails(actor, admins, 'admins');
  const visibleBanned = redactPrivateEmails(actor, banned, 'banned');
  const visibleEvents = redactPrivateEmails(actor, events, 'events');
  const visibleInvitations = sanitizeInvitationRecords(actor, invites);
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
    invitations: p.invites ? visibleInvitations : [],
    shares: p.shares || p.relationships ? visibleShares : [],
    admins: p.admins ? visibleAdmins : [],
    banned: p.banned ? visibleBanned : [],
    events: p.events ? visibleEvents : [],
    invitationEmailTemplate: p.texts ? getInvitationEmailTemplate() : null,
    invitationLimit: p.invites ? getInvitationLimit() : null
  };
}

function getAdminDashboardSummaryApi(actor) {
  const p = actor.admin.role === 'superadmin'
    ? Object.fromEntries(ADMIN_SECTIONS_API.map(k => [k, true])) : sanitizeAdminPermissions(actor.admin.permissions || {});
  if (!Object.values(p).some(Boolean)) throw new Error('Не назначены права для просмотра админки.');
  const countSpecs = [
    { key: 'users', enabled: p.users, collectionId: 'users' },
    { key: 'invitations', enabled: p.invites, collectionId: 'shares', filter: { fieldPath: 'inviteeEmail', op: 'NOT_EQUAL', value: { nullValue: null } }, allDescendants: true },
    { key: 'acceptedInvitations', enabled: p.invites, collectionId: 'shares', filter: { fieldPath: 'claimedUid', op: 'NOT_EQUAL', value: { nullValue: null } }, allDescendants: true },
    { key: 'shares', enabled: p.shares, collectionId: 'libraryShares', filter: { fieldPath: 'active', op: 'EQUAL', value: { booleanValue: true } } },
    { key: 'admins', enabled: p.admins, collectionId: 'adminUsers' },
    { key: 'banned', enabled: p.banned, collectionId: 'bannedUsers' }
  ];
  const counts = Object.fromEntries(countSpecs.map(spec => [spec.key, null]));
  const summary = fsCountMany(countSpecs.filter(spec => spec.enabled), true);
  Object.assign(counts, summary.counts);
  const superadminUid = summary.superAdminUid;
  return { permissions: p, counts, superAdminUid: superadminUid, invitationEmailTemplate: p.texts ? getInvitationEmailTemplate() : null, invitationLimit: p.invites ? getInvitationLimit() : null };
}

function fsFindSuperAdminUid() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'superadmin_uid';
  const cached = cache.get(cacheKey);
  if (cached) return cached === 'none' ? null : cached;
  const response = fsFetch(FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery', 'post', {
    structuredQuery: {
      from: [{ collectionId: 'adminUsers' }],
      where: { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: 'superadmin' } } },
      limit: 1
    }
  });
  if (response.code !== 200) throw new Error('Не удалось определить главного администратора.');
  const document = JSON.parse(response.text).find(row => row && row.document)?.document;
  const uid = document ? document.name.split('/').pop() : null;
  cache.put(cacheKey, uid || 'none', 30);
  return uid;
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
function fsCountMany(specs, includeSuperAdmin) {
  const cache = includeSuperAdmin ? CacheService.getScriptCache() : null;
  const cachedSuperAdmin = cache ? cache.get('superadmin_uid') : null;
  if (includeSuperAdmin && cachedSuperAdmin) {
    return { counts: fsCountMany(specs, false), superAdminUid: cachedSuperAdmin === 'none' ? null : cachedSuperAdmin };
  }
  if (!specs.length && !includeSuperAdmin) return {};
  if (typeof UrlFetchApp.fetchAll !== 'function' || (!includeSuperAdmin && specs.length === 1)) {
    const counts = Object.fromEntries(specs.map(spec => [spec.key, fsCount(spec.collectionId, spec.filter, spec.allDescendants)]));
    return includeSuperAdmin ? { counts, superAdminUid: fsFindSuperAdminUid() } : counts;
  }
  const token = ScriptApp.getOAuthToken();
  const requests = specs.map(spec => {
    const structuredQuery = { from: [{ collectionId: spec.collectionId, ...(spec.allDescendants ? { allDescendants: true } : {}) }] };
    if (Array.isArray(spec.filter)) structuredQuery.where = { compositeFilter: { op: 'AND', filters: spec.filter.map(item => ({ fieldFilter: { field: { fieldPath: item.fieldPath }, op: item.op, value: item.value } })) } };
    else if (spec.filter) structuredQuery.where = { fieldFilter: { field: { fieldPath: spec.filter.fieldPath }, op: spec.filter.op, value: spec.filter.value } };
    return {
      url: FIRESTORE_REST_ROOT.slice(0, -1) + ':runAggregationQuery',
      method: 'post',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
      contentType: 'application/json',
      payload: JSON.stringify({ structuredAggregationQuery: { structuredQuery, aggregations: [{ count: {}, alias: 'total' }] } })
    };
  });
  if (includeSuperAdmin) requests.push({
    url: FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery', method: 'post',
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true, contentType: 'application/json',
    payload: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'adminUsers' }],
      where: { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: 'superadmin' } } },
      limit: 1
    } })
  });
  const responses = UrlFetchApp.fetchAll(requests);
  const counts = {};
  responses.slice(0, specs.length).forEach((response, index) => {
    const code = response.getResponseCode();
    if (code !== 200) throw new Error('Не удалось получить счётчик Firebase (' + code + ').');
    const rows = JSON.parse(response.getContentText());
    const value = rows.find(row => row && row.result)?.result?.aggregateFields?.total?.integerValue;
    counts[specs[index].key] = Number(value || 0);
  });
  if (!includeSuperAdmin) return counts;
  const response = responses[specs.length];
  if (response.getResponseCode() !== 200) throw new Error('Не удалось определить главного администратора.');
  const document = JSON.parse(response.getContentText()).find(row => row && row.document)?.document;
  const superAdminUid = document ? document.name.split('/').pop() : null;
  cache.put('superadmin_uid', superAdminUid || 'none', 30);
  return { counts, superAdminUid };
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
  if (['shares', 'admins', 'banned', 'events'].includes(section)) page.items = redactPrivateEmails(actor, page.items, section);
  if (section === 'invites') page.items = sanitizeInvitationRecords(actor, page.items);
  if (section === 'users') {
    const uids = page.items.map(user => user.id);
    const flags = fsGetAdminUserFlags(uids);
    page.items = page.items.map(user => ({ ...sanitizeRelationshipProfile(user), uid: user.id, email: flags.emailByUid.get(user.id) || '', banned: flags.banned.has(user.id), admin: flags.admins.has(user.id) }));
  }
  page.userProfiles = fsQueryUserProfiles(adminRelatedUserUids(section, page.items), data.knownProfileUids);
  return page;
}
function adminRelatedUserUids(section, items) {
  const uids = new Set();
  const pageUids = section === 'users' ? new Set(items.map(item => item.uid || item.id).filter(isValidUid)) : null;
  const add = value => { if (isValidUid(value)) uids.add(value); };
  items.forEach(item => {
    if (section === 'users') {
      // The current page already contains these user profiles; only fetch inviters not on this page.
      if (isValidUid(item.invitedByUid) && !pageUids.has(item.invitedByUid)) add(item.invitedByUid);
    }
    else if (section === 'invites') { add(item.ownerUid); add(item.claimedUid); }
    else if (section === 'shares') { add(item.ownerUid); add(item.viewerUid); }
    else if (section === 'events') { add(item.actorUid); add(item.targetUid); }
    else if (section === 'banned') { add(item.uid || item.id); add(item.bannedBy); }
    else if (section === 'admins') { add(item.uid || item.id); add(item.createdBy); add(item.updatedBy); }
  });
  return [...uids];
}
function fsQueryUserProfiles(uids, knownUids) {
  const result = {};
  const known = new Set((Array.isArray(knownUids) ? knownUids : []).filter(isValidUid).slice(0, 300));
  const unique = [...new Set((uids || []).filter(isValidUid))].filter(uid => !known.has(uid)).slice(0, 150);
  const batches = [];
  for (let offset = 0; offset < unique.length; offset += 30) {
    const batch = unique.slice(offset, offset + 30);
    const values = batch.map(uid => ({ referenceValue: 'projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents/users/' + uid }));
    batches.push({
      structuredQuery: { from: [{ collectionId: 'users' }], where: { fieldFilter: { field: { fieldPath: '__name__' }, op: 'IN', value: { arrayValue: { values } } } }, limit: values.length }
    });
  }
  const url = FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery';
  const responses = batches.length > 1 && typeof UrlFetchApp.fetchAll === 'function'
    ? UrlFetchApp.fetchAll(batches.map(body => ({
        url,
        method: 'post',
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true,
        contentType: 'application/json',
        payload: JSON.stringify(body)
      }))).map(response => ({ code: response.getResponseCode(), text: response.getContentText() }))
    : batches.map(body => fsFetch(url, 'post', body));
  responses.forEach(response => {
    if (response.code !== 200) throw new Error('Не удалось получить имена участников Firebase (HTTP ' + response.code + ').' + (response.code === 403 ? ' Проверьте роль Cloud Datastore User (roles/datastore.user) у аккаунта, который развёртывает Apps Script.' : ''));
    JSON.parse(response.text).filter(row => row && row.document).forEach(row => {
      const uid = row.document.name.split('/').pop();
      result[uid] = { ...sanitizeRelationshipProfile(fsDecodeFields(row.document.fields || {})), uid };
    });
  });
  return result;
}

function fsGetAdminUserFlags(uids) {
  const result = { banned: new Set(), admins: new Set(), emailByUid: new Map() };
  const unique = [...new Set((uids || []).filter(isValidUid))].slice(0, 30);
  if (!unique.length) return result;
  const url = FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery';
  const referenceValues = collectionId => unique.map(uid => ({ referenceValue: 'projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents/' + collectionId + '/' + uid }));
  const bodies = [
    { structuredQuery: { from: [{ collectionId: 'bannedUsers' }], where: { fieldFilter: { field: { fieldPath: '__name__' }, op: 'IN', value: { arrayValue: { values: referenceValues('bannedUsers') } } } }, limit: unique.length } },
    { structuredQuery: { from: [{ collectionId: 'adminUsers' }], where: { fieldFilter: { field: { fieldPath: '__name__' }, op: 'IN', value: { arrayValue: { values: referenceValues('adminUsers') } } } }, limit: unique.length } },
    { structuredQuery: { from: [{ collectionId: 'userDirectory' }], where: { fieldFilter: { field: { fieldPath: 'uid' }, op: 'IN', value: { arrayValue: { values: unique.map(uid => ({ stringValue: uid })) } } } }, limit: unique.length } }
  ];
  const responses = typeof UrlFetchApp.fetchAll === 'function'
    ? UrlFetchApp.fetchAll(bodies.map(body => ({ url, method: 'post', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true, contentType: 'application/json', payload: JSON.stringify(body) }))).map(response => ({ code: response.getResponseCode(), text: response.getContentText() }))
    : bodies.map(body => fsFetch(url, 'post', body));
  responses.forEach((response, index) => {
    if (response.code !== 200) throw new Error(index === 2 ? 'Не удалось получить адреса участников.' : 'Не удалось получить статусы участников.');
    JSON.parse(response.text).filter(row => row && row.document).forEach(row => {
      const document = row.document;
      const uid = document.name.split('/').pop();
      if (index === 0 && unique.includes(uid)) result.banned.add(uid);
      else if (index === 1 && unique.includes(uid)) result.admins.add(uid);
      else if (index === 2) {
        const item = fsDecodeFields(document.fields || {});
        if (isValidUid(item.uid) && unique.includes(item.uid)) result.emailByUid.set(item.uid, uid);
      }
    });
  });
  return result;
}
function fsQueryEmailDirectory(uids) {
  const unique = [...new Set((uids || []).filter(isValidUid))].slice(0, 30);
  if (!unique.length) return [];
  const values = unique.map(uid => ({ stringValue: uid }));
  const response = fsFetch(FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery', 'post', {
    structuredQuery: {
      from: [{ collectionId: 'userDirectory' }],
      where: { fieldFilter: { field: { fieldPath: 'uid' }, op: 'IN', value: { arrayValue: { values } } } },
      limit: unique.length
    }
  });
  if (response.code !== 200) throw new Error('Не удалось получить адреса участников.');
  return JSON.parse(response.text).filter(row => row && row.document).map(row => ({
    ...fsDecodeFields(row.document.fields || {}), id: row.document.name.split('/').pop()
  })).filter(item => isValidUid(item.uid) && unique.includes(item.uid));
}

function fsQueryDocumentIds(collectionId, ids) {
  return fsQueryDocumentIdsMany([collectionId], ids)[collectionId] || [];
}
function fsQueryDocumentIdsMany(collectionIds, ids) {
  const unique = [...new Set((ids || []).filter(isValidUid))].slice(0, 30);
  const collections = [...new Set(collectionIds || [])];
  const result = Object.fromEntries(collections.map(collectionId => [collectionId, []]));
  if (!unique.length || !collections.length) return result;
  const url = FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery';
  const bodies = collections.map(collectionId => {
    const values = unique.map(uid => ({ referenceValue: 'projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents/' + collectionId + '/' + uid }));
    return { structuredQuery: { from: [{ collectionId }], where: { fieldFilter: { field: { fieldPath: '__name__' }, op: 'IN', value: { arrayValue: { values } } } }, limit: values.length } };
  });
  const responses = bodies.length > 1 && typeof UrlFetchApp.fetchAll === 'function'
    ? UrlFetchApp.fetchAll(bodies.map(body => ({ url, method: 'post', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true, contentType: 'application/json', payload: JSON.stringify(body) }))).map(response => ({ code: response.getResponseCode(), text: response.getContentText() }))
    : bodies.map(body => fsFetch(url, 'post', body));
  responses.forEach((response, index) => {
    if (response.code !== 200) throw new Error('Не удалось получить статусы участников.');
    result[collections[index]] = JSON.parse(response.text).filter(row => row && row.document).map(row => row.document.name.split('/').pop());
  });
  return result;
}
function sanitizeRelationshipProfile(profile) {
  const safe = {};
  ['id', 'displayName', 'photoURL', 'createdAt', 'invitedByUid'].forEach(key => {
    if (Object.prototype.hasOwnProperty.call(profile, key)) safe[key] = profile[key];
  });
  return safe;
}
function visibleUserProfile(actor, profile, uid) {
  return { ...sanitizeRelationshipProfile(profile), ...(uid ? { uid } : {}) };
}
function sanitizeInvitationRecords(actor, items) {
  const allowed = ['id', 'email', 'ownerUid', 'claimedUid', 'active', 'createdAt', 'claimedAt', 'emailStatus', 'emailSentAt', 'revokedAt', 'revokedBy'];
  return items.map(item => {
    const safe = {};
    allowed.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(item, key)) safe[key] = item[key];
    });
    return safe;
  });
}
function sanitizeAdminPermissions(value) {
  const safe = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return safe;
  ADMIN_SECTIONS_API.forEach(key => {
    if (typeof value[key] === 'boolean') safe[key] = value[key];
  });
  return safe;
}
function redactEmailAddresses(value) {
  return String(value || '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[скрыто]');
}
function sanitizeEventDetails(source, canReadEmails) {
  const details = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return details;
  if (source.permissions && typeof source.permissions === 'object' && !Array.isArray(source.permissions)) {
    details.permissions = sanitizeAdminPermissions(source.permissions);
  }
  if (typeof source.active === 'boolean') details.active = source.active;
  if (typeof source.reason === 'string') {
    const reason = source.reason.slice(0, 500);
    details.reason = canReadEmails ? reason : redactEmailAddresses(reason);
  }
  if (isValidUid(source.ownerUid)) details.ownerUid = source.ownerUid;
  if (Number.isFinite(source.limit) && source.limit >= 0) details.limit = source.limit;
  if (Number.isFinite(source.length) && source.length >= 0) details.length = source.length;
  if (typeof source.adminRestored === 'boolean') details.adminRestored = source.adminRestored;
  if (typeof source.email === 'string') details.email = canReadEmails ? source.email : '';
  return details;
}
function redactPrivateEmails(actor, items, section) {
  const canReadEmails = actor.admin.role === 'superadmin' || actor.admin.permissions?.users === true;
  const pick = (value, fields) => {
    const safe = {};
    fields.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(value, key)) safe[key] = value[key];
    });
    return safe;
  };
  return items.map(item => {
    if (section === 'shares') {
      return { ...pick(item, ['id', 'ownerUid', 'viewerUid', 'active', 'sharedAt', 'revokedAt']), ownerEmail: canReadEmails ? (item.ownerEmail || '') : '' };
    }
    if (section === 'admins') {
      const safe = pick(item, ['id', 'uid', 'role', 'active', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']);
      if (Object.prototype.hasOwnProperty.call(item, 'permissions')) safe.permissions = sanitizeAdminPermissions(item.permissions);
      return { ...safe, email: canReadEmails ? (item.email || '') : '' };
    }
    if (section === 'banned') {
      const safe = pick(item, ['id', 'uid', 'displayName', 'reason', 'bannedBy', 'adminWasActive', 'bannedAt']);
      if (!canReadEmails && typeof safe.reason === 'string') safe.reason = redactEmailAddresses(safe.reason);
      return { ...safe, email: canReadEmails ? (item.email || '') : '' };
    }
    if (section === 'events') {
      return { ...pick(item, ['id', 'actorUid', 'action', 'targetUid', 'createdAt']), details: sanitizeEventDetails(item.details, canReadEmails) };
    }
    return {};
  });
}
function getAdminRelationshipRootsApi(actor, data) {
  requireAdminApi(actor.uid, 'relationships');
  const includeShares = data.includeShares === true;
  const pages = fsQueryPageMany([
    { path: 'users', pageSize: 25, cursor: data.cursor || '' },
    ...(includeShares ? [{ path: 'libraryShares', pageSize: 100, cursor: '' }] : [])
  ]);
  const page = pages[0];
  page.items = page.items.map(user => visibleUserProfile(actor, user, user.id));
  if (includeShares) page.shares = redactPrivateEmails(actor, pages[1].items, 'shares');
  const uids = new Set(adminRelatedUserUids('users', page.items));
  (page.shares || []).forEach(share => { if (isValidUid(share.ownerUid)) uids.add(share.ownerUid); if (isValidUid(share.viewerUid)) uids.add(share.viewerUid); });
  page.userProfiles = fsQueryUserProfiles([...uids], data.knownProfileUids);
  return page;
}

function fsQueryPageMany(specs) {
  if (!Array.isArray(specs) || !specs.length) return [];
  if (specs.length === 1 || typeof UrlFetchApp.fetchAll !== 'function') {
    return specs.map(spec => fsQueryPage(spec.path, spec.pageSize, spec.cursor));
  }
  const url = FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery';
  const queries = specs.map(spec => {
    const path = String(spec.path || '');
    const size = Math.max(1, Math.min(100, Number(spec.pageSize) || 25));
    const structuredQuery = {
      from: [{ collectionId: path }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: size + 1
    };
    if (spec.cursor) {
      let decoded;
      try { decoded = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(spec.cursor)).getDataAsString()); }
      catch (_) { throw new Error('Invalid pagination cursor.'); }
      const expectedPrefix = 'projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents/' + path + '/';
      if (decoded.path !== path || typeof decoded.name !== 'string' || !decoded.name.startsWith(expectedPrefix) || decoded.name !== expectedPrefix + decoded.id || String(decoded.id).includes('/')) throw new Error('Invalid pagination cursor.');
      structuredQuery.startAt = { before: false, values: [{ referenceValue: decoded.name }] };
    }
    return { path, size, body: { structuredQuery } };
  });
  const requests = queries.map(query => ({
    url, method: 'post', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true, contentType: 'application/json', payload: JSON.stringify(query.body)
  }));
  return UrlFetchApp.fetchAll(requests).map((response, index) => {
    const query = queries[index];
    const code = response.getResponseCode();
    if (code !== 200) throw new Error('Firestore page query failed (HTTP ' + code + ').');
    const rows = JSON.parse(response.getContentText()).filter(row => row && row.document).map(row => ({
      ...fsDecodeFields(row.document.fields || {}), id: row.document.name.split('/').pop(), _documentName: row.document.name
    }));
    const hasMore = rows.length > query.size;
    const items = rows.slice(0, query.size);
    const last = items[items.length - 1];
    const lastDocumentName = last?._documentName || '';
    items.forEach(item => delete item._documentName);
    return {
      items, hasMore,
      nextCursor: hasMore && last ? Utilities.base64EncodeWebSafe(JSON.stringify({ path: query.path, id: last.id, name: lastDocumentName })) : null
    };
  });
}
function getAdminBranchApi(actor, data) {
  requireAdminApi(actor.uid, 'relationships');
  const uid = String(data.uid || '');
  if (!isValidUid(uid)) throw new Error('Некорректный UID участника.');
  const page = fsQueryFilteredPage('users', 'invitedByUid', uid, 25, data.cursor || '');
  page.items = page.items.map(user => visibleUserProfile(actor, user, user.id));
  return page;
}

function getAdminUserCardApi(actor, data) {
  const current = requireAdminApi(actor.uid);
  if (current.admin.role !== 'superadmin' && current.admin.permissions?.users !== true && current.admin.permissions?.relationships !== true) {
    throw new Error('Недостаточно прав для просмотра карточки участника.');
  }
  const canReadEmails = current.admin.role === 'superadmin' || current.admin.permissions?.users === true;
  const canReadAdminDetails = current.admin.role === 'superadmin' || current.admin.permissions?.admins === true || current.admin.permissions?.users === true;
  const canReadBanDetails = current.admin.role === 'superadmin' || current.admin.permissions?.banned === true || current.admin.permissions?.users === true;
  const uid = String(data.uid || '');
  if (!isValidUid(uid)) throw new Error('Некорректный UID участника.');
  const profile = fsGet('users/' + encodeURIComponent(uid));
  if (!profile) throw new Error('Участник не найден.');
  const relatedPaths = [];
  const inviterPathIndex = profile.invitedByUid
    ? relatedPaths.push('users/' + encodeURIComponent(profile.invitedByUid)) - 1 : -1;
  const adminPathIndex = canReadAdminDetails
    ? relatedPaths.push('adminUsers/' + encodeURIComponent(uid)) - 1 : -1;
  const bannedPathIndex = canReadBanDetails
    ? relatedPaths.push('bannedUsers/' + encodeURIComponent(uid)) - 1 : -1;
  const groupSpecs = [];
  if (canReadEmails) groupSpecs.push({ collectionId: 'userDirectory', field: 'uid', value: uid, limit: 1 });
  const outgoingIndex = groupSpecs.push({ collectionId: 'libraryShares', field: 'ownerUid', value: uid, limit: 100 }) - 1;
  const incomingIndex = groupSpecs.push({ collectionId: 'libraryShares', field: 'viewerUid', value: uid, limit: 100 }) - 1;
  const invitedIndex = groupSpecs.push({ collectionId: 'users', field: 'invitedByUid', value: uid, limit: 100, allDescendants: false }) - 1;
  const related = fsGetManyAndQueryGroupByFieldMany(relatedPaths, groupSpecs);
  const relatedRecords = related.records;
  const groupRows = related.groups;
  const inviter = inviterPathIndex >= 0 ? relatedRecords[inviterPathIndex] : null;
  const adminRecord = adminPathIndex >= 0 ? relatedRecords[adminPathIndex] : null;
  const bannedRecord = bannedPathIndex >= 0 ? relatedRecords[bannedPathIndex] : null;
  const directory = canReadEmails ? groupRows[0][0] : null;
  const outgoing = groupRows[outgoingIndex];
  const incoming = groupRows[incomingIndex];
  const invited = groupRows[invitedIndex];
  return {
    user: { ...visibleUserProfile(current, profile, uid), email: directory?.id ? decodeURIComponent(directory.id) : '' },
    inviter: inviter ? visibleUserProfile(current, inviter, profile.invitedByUid) : null,
    invited: invited.map(user => visibleUserProfile(current, user, user.id)),
    admin: adminRecord ? redactPrivateEmails(actor, [adminRecord], 'admins')[0] : null,
    banned: bannedRecord ? redactPrivateEmails(actor, [bannedRecord], 'banned')[0] : null,
    outgoing: redactPrivateEmails(actor, outgoing.filter(share => share.active === true), 'shares'),
    incoming: redactPrivateEmails(actor, incoming.filter(share => share.active === true), 'shares')
  };
}
function getAdminUserHistoryApi(actor, data) {
  requireAdminApi(actor.uid, 'users');
  const uid = String(data.uid || '');
  if (!isValidUid(uid)) throw new Error('Некорректный UID участника.');
  const rows = fsQueryGroupByFieldMany([
    { collectionId: 'shares', field: 'ownerUid', value: uid, limit: 100, nestedOnly: true },
    { collectionId: 'shares', field: 'claimedUid', value: uid, limit: 100, nestedOnly: true },
    { collectionId: 'adminEvents', field: 'targetUid', value: uid, limit: 100 },
    { collectionId: 'adminEvents', field: 'actorUid', value: uid, limit: 100 },
    { collectionId: 'libraryShares', field: 'ownerUid', value: uid, limit: 100 },
    { collectionId: 'libraryShares', field: 'viewerUid', value: uid, limit: 100 }
  ]);
  const invitations = rows[0].concat(rows[1]);
  const events = rows[2].concat(rows[3]);
  return {
    outgoing: redactPrivateEmails(actor, rows[4], 'shares'),
    incoming: redactPrivateEmails(actor, rows[5], 'shares'),
    invitations: sanitizeInvitationRecords(actor, [...new Map(invitations.map(item => [item.id + ':' + item.email, item])).values()]),
    events: redactPrivateEmails(actor, [...new Map(events.map(item => [item.id, item])).values()].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 100), 'events')
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
    ...fsDecodeFields(row.document.fields || {}), id: row.document.name.split('/').pop(), _documentName: row.document.name
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
    ...fsDecodeFields(row.document.fields || {}), id: row.document.name.split('/').pop(), _documentName: row.document.name
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
      ...fsDecodeFields(row.document.fields || {}),
      id: row.document.name.split('/').pop(),
      email: decodeURIComponent(row.document.name.split('/documents/pendingInvites/')[1].split('/shares/')[0]),
      _documentName: row.document.name
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
  return fsDecodeGroupByFieldResponse(response, nestedOnly);
}
function fsQueryGroupByFieldMany(specs) {
  if (!Array.isArray(specs) || !specs.length) return [];
  if (specs.length === 1 || typeof UrlFetchApp.fetchAll !== 'function') {
    return specs.map(spec => spec.allDescendants === false
      ? fsQueryFilteredPage(spec.collectionId, spec.field, spec.value, spec.limit, '').items
      : fsQueryGroupByField(spec.collectionId, spec.field, spec.value, spec.limit, spec.nestedOnly));
  }
  const url = FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery';
  const requests = specs.map(spec => ({
    url, method: 'post', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true, contentType: 'application/json',
    payload: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: spec.collectionId, ...(spec.allDescendants === false ? {} : { allDescendants: true }) }],
      where: { fieldFilter: { field: { fieldPath: spec.field }, op: 'EQUAL', value: { stringValue: String(spec.value) } } },
      limit: Math.min(100, Number(spec.limit) || 100)
    } })
  }));
  return UrlFetchApp.fetchAll(requests).map((response, index) => fsDecodeGroupByFieldResponse({ code: response.getResponseCode(), text: response.getContentText() }, specs[index].nestedOnly));
}
function fsDecodeGroupByFieldResponse(response, nestedOnly) {
  if (response.code !== 200) throw new Error('Не удалось загрузить историю участника.');
  return JSON.parse(response.text).filter(row => row && row.document)
    .filter(row => !nestedOnly || row.document.name.includes('/pendingInvites/'))
    .map(row => ({
      ...fsDecodeFields(row.document.fields || {}),
      id: row.document.name.split('/').pop(),
      ...(nestedOnly ? { email: decodeURIComponent(row.document.name.split('/documents/pendingInvites/')[1].split('/shares/')[0]) } : {})
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

function getInvitationLimit() {
  const settings = fsGet('systemSettings/invitationLimit');
  const value = Number(settings?.limit);
  return Number.isInteger(value) && value >= 0 && value <= 100000 ? value : 20;
}

function setInvitationLimitApi(actor, data) {
  requireAdminApi(actor.uid, 'invites');
  const rawLimit = data.limit;
  const value = typeof rawLimit === 'number' ? rawLimit : Number(String(rawLimit ?? '').trim());
  if ((typeof rawLimit !== 'number' && String(rawLimit ?? '').trim() === '') || !Number.isInteger(value) || value < 0 || value > 100000) {
    throw new Error('Лимит должен быть целым числом от 0 до 100000.');
  }
  fsSet('systemSettings/invitationLimit', { limit: value, updatedAt: new Date(), updatedBy: actor.uid });
  fsAddEvent(actor.uid, 'update-invitation-limit', null, { limit: value });
  return { ok: true, limit: value };
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
  if (!isValidUid(uid) || uid === actor.uid || !permissions || typeof permissions !== 'object' || Array.isArray(permissions) ||
      Object.keys(permissions).some(k => !ADMIN_SECTIONS_API.includes(k) || typeof permissions[k] !== 'boolean')) {
    throw new Error('Некорректные права администратора.');
  }
  const [banned, profile, old] = fsGetMany([
    'bannedUsers/' + uid,
    'users/' + uid,
    'adminUsers/' + uid
  ]);
  if (banned) throw new Error('Нельзя назначить администратора заблокированному участнику.');
  if (!profile) throw new Error('Участник не найден.');
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
  if (!isValidUid(uid) || uid === actor.uid) throw new Error('Нельзя заблокировать эту учётную запись.');
  let admin;
  let profile;
  let email = '';
  try {
    const batch = fsGetManyAndQueryGroupByFieldMany(
      ['adminUsers/' + uid, 'users/' + uid],
      [{ collectionId: 'userDirectory', field: 'uid', value: uid, limit: 1 }]
    );
    [admin, profile] = batch.records;
    const directory = batch.groups[0]?.[0];
    if (directory?.id) email = normalizeEmail(decodeURIComponent(directory.id));
  } catch (_) {
    // Preserve existing semantics if the optional directory query fails.
    [admin, profile] = fsGetMany(['adminUsers/' + uid, 'users/' + uid]);
    try {
      const directory = fsQueryGroupByField('userDirectory', 'uid', uid, 1)[0];
      if (directory?.id) email = normalizeEmail(decodeURIComponent(directory.id));
    } catch (_) {}
  }
  if (admin?.role === 'superadmin') throw new Error('Главного администратора нельзя заблокировать.');
  if (!profile) throw new Error('Участник не найден.');
  fsSet('bannedUsers/' + uid, {
    uid, email, displayName: profile.displayName || '', reason, bannedBy: actor.uid,
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
  const currentActor = requireAdminApi(actor.uid, 'banned');
  const uid = String(data.uid || '');
  if (!isValidUid(uid)) throw new Error('Не указан участник.');
  const banned = fsGet('bannedUsers/' + uid);
  if (!banned) return { ok: true };
  fsDelete('bannedUsers/' + uid);
  const admin = fsGet('adminUsers/' + uid);
  const canRestoreAdmin = currentActor.admin.role === 'superadmin' ||
    currentActor.admin.permissions?.admins === true;
  const adminRestored = Boolean(admin && banned.adminWasActive === true && canRestoreAdmin);
  if (adminRestored) {
    fsSet('adminUsers/' + uid, { active: true, updatedAt: new Date(), updatedBy: actor.uid });
    fsSet('users/' + uid, { isAdmin: true });
  }
  fsAddEvent(actor.uid, 'restore-user', uid, { adminRestored });
  return { ok: true };
}

function revokeInvitationApi(actor, data) {
  requireAdminApi(actor.uid, 'invites');
  const email = normalizeEmail(data.email);
  const ownerUid = String(data.ownerUid || '');
  if (!isValidEmail(email) || !isValidUid(ownerUid)) throw new Error('Некорректное приглашение.');
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
  if (!isValidLibraryShareId(id) || typeof data.active !== 'boolean') throw new Error('Некорректный доступ.');
  if (data.active !== false) throw new Error('Администратор может только закрыть доступ; повторное открытие выполняет владелец.');
  const current = fsGet('libraryShares/' + encodeURIComponent(id));
  if (!current) throw new Error('Связь доступа не найдена.');
  const protectedUids = [...new Set([current.ownerUid, current.viewerUid].filter(isValidUid))];
  const protectedAdmins = fsGetMany(protectedUids.map(uid => 'adminUsers/' + encodeURIComponent(uid)));
  if (protectedAdmins.some(admin => admin?.role === 'superadmin')) {
    throw new Error('Нельзя изменять доступ, связанный с главным администратором.');
  }
  fsSet('libraryShares/' + encodeURIComponent(id), { active: data.active, revokedAt: data.active ? null : new Date() });
  fsAddEvent(actor.uid, data.active ? 'admin-open-share' : 'admin-close-share', current.viewerUid || null, { ownerUid: current.ownerUid || '' });
  return { ok: true };
}

function fsGet(path) {
  const response = fsRequest('get', path);
  return response ? { ...fsDecodeFields(response.fields || {}), id: response.name.split('/').pop() } : null;
}
function fsGetManyAndQueryGroupByFieldMany(paths, specs) {
  const safePaths = Array.isArray(paths) ? paths : [];
  const safeSpecs = Array.isArray(specs) ? specs : [];
  if (!safePaths.length || typeof UrlFetchApp.fetchAll !== 'function') {
    return { records: fsGetMany(safePaths), groups: fsQueryGroupByFieldMany(safeSpecs) };
  }
  if (!safeSpecs.length) return { records: fsGetMany(safePaths), groups: [] };
  const token = ScriptApp.getOAuthToken();
  const requests = safePaths.map(path => ({
    url: FIRESTORE_REST_ROOT + path, method: 'get',
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
  }));
  const queryUrl = FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery';
  safeSpecs.forEach(spec => requests.push({
    url: queryUrl, method: 'post',
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
    contentType: 'application/json',
    payload: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: spec.collectionId, ...(spec.allDescendants === false ? {} : { allDescendants: true }) }],
      where: { fieldFilter: { field: { fieldPath: spec.field }, op: 'EQUAL', value: { stringValue: String(spec.value) } } },
      limit: Math.min(100, Number(spec.limit) || 100)
    } })
  }));
  const responses = UrlFetchApp.fetchAll(requests);
  const records = responses.slice(0, safePaths.length).map((response, index) => {
    const code = response.getResponseCode();
    if (code === 404) return null;
    if (code < 200 || code >= 300) return fsGet(safePaths[index]);
    const document = JSON.parse(response.getContentText());
    return { ...fsDecodeFields(document.fields || {}), id: document.name.split('/').pop() };
  });
  const groups = responses.slice(safePaths.length).map((response, index) =>
    fsDecodeGroupByFieldResponse({ code: response.getResponseCode(), text: response.getContentText() }, safeSpecs[index].nestedOnly));
  return { records, groups };
}
function fsGetMany(paths) {
  if (!Array.isArray(paths) || !paths.length) return [];
  if (paths.length === 1 || typeof UrlFetchApp.fetchAll !== 'function') return paths.map(fsGet);
  const url = paths.map(path => FIRESTORE_REST_ROOT + path);
  const requests = url.map(item => ({
    url: item,
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  }));
  return UrlFetchApp.fetchAll(requests).map((response, index) => {
    const code = response.getResponseCode();
    if (code === 404) return null;
    if (code < 200 || code >= 300) return fsGet(paths[index]);
    const document = JSON.parse(response.getContentText());
    return { ...fsDecodeFields(document.fields || {}), id: document.name.split('/').pop() };
  });
}
function getAdminRecordCached(uid) {
  const cache = CacheService.getScriptCache();
  const key = 'admin_record_' + uid;
  const cached = cache.get(key);
  if (cached) return JSON.parse(cached);
  // Coalesce simultaneous admin requests so they don't all read the same record.
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const cachedAfterLock = cache.get(key);
    if (cachedAfterLock) return JSON.parse(cachedAfterLock);
    const admin = fsGet('adminUsers/' + uid);
    if (admin) cache.put(key, JSON.stringify(admin), 10);
    return admin;
  } finally {
    lock.releaseLock();
  }
}
function fsList(path) {
  const out = [];
  let token = '';
  do {
    const url = FIRESTORE_REST_ROOT + path + '?pageSize=1000' + (token ? '&pageToken=' + encodeURIComponent(token) : '');
    const response = fsFetch(url, 'get');
    if (response.code !== 200) throw new Error('Не удалось прочитать данные Firebase.');
    const body = JSON.parse(response.text);
    (body.documents || []).forEach(doc => out.push({ ...fsDecodeFields(doc.fields || {}), id: doc.name.split('/').pop() }));
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
  return (body.documents || []).map(doc => ({ ...fsDecodeFields(doc.fields || {}), id: doc.name.split('/').pop() }));
}
function fsListInviteSharesByOwner(uid) {
  const url = FIRESTORE_REST_ROOT.slice(0, -1) + ':runQuery';
  const response = fsFetch(url, 'post', {
    structuredQuery: {
      from: [{ collectionId: 'shares', allDescendants: true }],
      where: { fieldFilter: { field: { fieldPath: 'ownerUid' }, op: 'EQUAL', value: { stringValue: String(uid) } } }
    }
  });
  if (response.code !== 200) throw new Error('Не удалось проверить лимит приглашений Firebase.');
  return JSON.parse(response.text).filter(row => row && row.document)
    .filter(row => row.document.name.includes('/documents/pendingInvites/'))
    .filter(row => {
      const marker = '/documents/pendingInvites/';
      const index = row.document.name.indexOf(marker);
      if (index < 0) return false;
      const segments = row.document.name.slice(index + marker.length).split('/');
      return segments.length === 3 && segments[1] === 'shares';
    })
    .map(row => ({ ...fsDecodeFields(row.document.fields || {}), id: row.document.name.split('/').pop() }));
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
    out.push({ ...fsDecodeFields(doc.fields || {}), id: segments[2], email: segments[0] });
  });
  return out;
}
function fsSet(path, values) {
  const fields = fsEncodeFields(values);
  const mask = Object.keys(fields).map(key => 'updateMask.fieldPaths=' + encodeURIComponent(key)).join('&');
  const response = fsFetch(FIRESTORE_REST_ROOT + path + '?' + mask, 'patch', { fields: fields });
  if (response.code < 200 || response.code >= 300) throw new Error('Не удалось сохранить данные Firebase (HTTP ' + response.code + ').' + (response.code === 403 ? ' Проверьте роль Cloud Datastore User (roles/datastore.user) у аккаунта, который развёртывает Apps Script.' : ''));
  if (String(path).indexOf('adminUsers/') === 0) {
    const cache = CacheService.getScriptCache();
    cache.remove('admin_record_' + String(path).slice('adminUsers/'.length));
    cache.remove('superadmin_uid');
  }
}
function fsDelete(path) {
  const response = fsFetch(FIRESTORE_REST_ROOT + path, 'delete');
  if (response.code !== 200 && response.code !== 204 && response.code !== 404) throw new Error('Не удалось удалить запись Firebase.');
  if (String(path).indexOf('adminUsers/') === 0) {
    const cache = CacheService.getScriptCache();
    cache.remove('admin_record_' + String(path).slice('adminUsers/'.length));
    cache.remove('superadmin_uid');
  }
}
function fsAddEvent(actorUid, action, targetUid, details) {
  const id = Utilities.getUuid();
  fsSet('adminEvents/' + id, { actorUid, action, targetUid: targetUid || null, details: details || {}, createdAt: new Date() });
}
function fsRequest(method, path, body) {
  const response = fsFetch(FIRESTORE_REST_ROOT + path, method, body);
  if (response.code === 404) return null;
  if (response.code < 200 || response.code >= 300) {
    // Identify the failing Firestore document operation without exposing document IDs.
    const parts = String(path || '').split('?')[0].split('/');
    const documentIndex = parts.indexOf('documents');
    if (documentIndex >= 0) {
      for (let i = documentIndex + 2; i < parts.length; i += 2) {
        if (parts[i]) parts[i] = '{id}';
      }
    }
    const operation = String(method || 'get').toUpperCase() + ' ' + parts.join('/');
    let diagnostic = '';
    try {
      const errorBody = JSON.parse(response.text || '{}').error || {};
      const status = String(errorBody.status || '').replace(/[^A-Z_]/g, '').slice(0, 40);
      const message = String(errorBody.message || '').replace(/[\r\n]+/g, ' ').slice(0, 220);
      const errorInfo = (errorBody.details || []).find(item => item && item['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
      const metadata = errorInfo && errorInfo.metadata ? errorInfo.metadata : {};
      const quota = [metadata.quota_limit, metadata.quota_metric, metadata.quota_location, metadata.consumer]
        .filter(Boolean).map(value => String(value).replace(/[^A-Za-z0-9_./:-]/g, '').slice(0, 120)).join(', ');
      if (status || message || quota) diagnostic = '; ' + [status, message, quota ? 'quota=' + quota : ''].filter(Boolean).join(': ');
      console.error('Firestore request failed', { code: response.code, operation: operation, status: status, message: message, quota: quota });
    } catch (_) {}
    throw new Error('Операция Firebase не выполнена (' + response.code + '; ' + operation + diagnostic + ').');
  }
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
  const message = error && error.message ? String(error.message).slice(0, 500) : '';
  // Return only messages authored by this service. Do not expose raw Google/Firebase
  // response bodies, tokens, document contents, or arbitrary exception text.
  if (/^(Сеанс Google|Для отправки приглашений|Нет прав администратора|Доступ к Тайной Библиотеке|Главный администратор|Первоначальная настройка|Учётная запись администратора|Недостаточно прав|Не назначены права|Некорректные права|Нельзя менять права|Нельзя назначить администратора|Участник не найден|Нельзя заблокировать|Главного администратора|Не указан участник|Приглашение не найдено|Приглашение уже принято|Некорректное приглашение|Некорректный доступ|Связь доступа не найдена|Операция Firebase не выполнена|Некорректная административная операция|Неизвестная административная операция)/i.test(message) ||
      (/^Не удалось .{0,450}$/i.test(message) && /(Firebase|Firestore|участник|адрес|данн|счётчик|профил|приглаш|администратор|доступ)/i.test(message))) return message;
  if (/^Firebase Auth accounts:lookup failed \(HTTP \d{3}\)\.$/.test(message)) return message;
  if (!message) return '\u041e\u0448\u0438\u0431\u043a\u0430 Apps Script: \u0438\u0441\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0435 \u0431\u0435\u0437 \u043e\u043f\u0438\u0441\u0430\u043d\u0438\u044f. \u041f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u0436\u0443\u0440\u043d\u0430\u043b \u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u0438\u0439.';
  const safe = message
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[API key redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[token redacted]')
    .replace(/https?:\/\/[^\s"<>]+/gi, '[URL redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 350);
  return '\u041e\u0448\u0438\u0431\u043a\u0430 Apps Script: ' + safe;
}

function adminResponsePage(requestId, ok, message, result) {
  const payload = JSON.stringify({ type: 'secret-library-admin-result', requestId, ok, message, result })
    .replace(/</g, '\\u003c');
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><script>window.top.postMessage(' +
    payload + ', ' + JSON.stringify(SITE_ORIGIN) + ');</script></body></html>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

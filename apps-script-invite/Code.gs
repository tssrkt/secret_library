const FIREBASE_PROJECT_ID = 'project-071ee00e-4a4a-4a3d-95d';
const FIREBASE_API_KEY = 'AIzaSyDXTowpjzrl6_GfzQED9ITjb7mn9Qzs5J4';
const SITE_ORIGIN = 'https://tssrkt.github.io';
const MAX_INVITES_PER_USER_PER_DAY = 10;
const SENDING_LEASE_MS = 10 * 60 * 1000;

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
  try {
    const raw = e && e.parameter && e.parameter.payload;
    if (!raw || raw.length > 12000) throw new Error('Некорректный запрос.');
    const input = JSON.parse(raw);
    requestId = String(input.requestId || '');
    if (!/^[a-zA-Z0-9_-]{12,80}$/.test(requestId)) throw new Error('Некорректный идентификатор запроса.');
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
    if (invitation.claimedUid || readUserDirectory(idToken, email)) {
      return responsePage(requestId, true, 'Пользователь уже зарегистрировался. Приглашение не требуется.');
    }
    if (invitation.emailStatus === 'sent') {
      return responsePage(requestId, true, 'Приглашение уже было отправлено.');
    }

    stage = 'reserve-send';
    reservation = reserveSend(user.localId, email);
    if (reservation.status === 'sent') {
      return responsePage(requestId, true, 'Приглашение уже было отправлено.');
    }
    if (reservation.status === 'sending') {
      return responsePage(requestId, true, 'Приглашение уже отправляется. Подождите немного.');
    }

    stage = 'send-email';
    const inviterName = String(user.displayName || 'Пользователь').trim().slice(0, 160) || 'Пользователь';
    MailApp.sendEmail({
      to: email,
      subject: 'Приглашение в «Тайную Библиотеку»',
      body: 'Доброго времени суток!\n\n' + inviterName +
        ' приглашает вас в Тайное Общество Вольных Библиотекарей! О том, как вступить в наш закрытый клуб и какие плюшки вы от этого получите, можно прочитать здесь:\n\n' +
        'https://tssrkt.github.io/secret_library/info.html\n\nДобро пожаловать в Тайную Библиотеку!',
      name: 'Тайная Библиотека'
    });

    stage = 'mark-sent';
    finishSend(user.localId, email, true);
    reservation = null;
    return responsePage(requestId, true, 'Приглашение отправлено.');
  } catch (error) {
    if (reservation && reservation.status === 'reserved') {
      try { finishSend(reservation.uid, reservation.email, false); } catch (_) {}
    }
    console.error('Invitation mailer failed', {
      stage: stage,
      name: error && error.name ? String(error.name) : 'UnknownError'
    });
    return responsePage(requestId, false, publicError(error));
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
    emailStatus: value('emailStatus', 'stringValue')
  };
}

function readUserDirectory(idToken, email) {
  const path = '/projects/' + FIREBASE_PROJECT_ID +
    '/databases/(default)/documents/userDirectory/' + encodeURIComponent(email);
  const response = UrlFetchApp.fetch('https://firestore.googleapis.com/v1' + path, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + idToken },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() === 404) return false;
  if (response.getResponseCode() !== 200) {
    throw new Error('Не удалось проверить регистрацию получателя в Firebase. Повторите попытку.');
  }
  return true;
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

function reserveSend(uid, email) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const properties = PropertiesService.getScriptProperties();
    const key = reservationKey(uid, email);
    const now = Date.now();
    const current = JSON.parse(properties.getProperty(key) || 'null');
    if (current && current.status === 'sent') return { status: 'sent' };
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
    properties.setProperty(key, JSON.stringify({ status: 'sending', at: now }));
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
    if (success) {
      properties.setProperty(key, JSON.stringify({ status: 'sent', at: Date.now() }));
      const dailyKey = 'daily:' + uid;
      const recent = JSON.parse(properties.getProperty(dailyKey) || '[]')
        .filter(function (timestamp) { return Number.isFinite(timestamp) && Date.now() - timestamp < 24 * 60 * 60 * 1000; });
      recent.push(Date.now());
      properties.setProperty(dailyKey, JSON.stringify(recent));
    } else {
      properties.setProperty(key, JSON.stringify({ status: 'failed', at: Date.now() }));
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
      message.indexOf('Приглашение') === 0 ||
      message.indexOf('Не удалось проверить') === 0) return message;
  return 'Не удалось отправить приглашение. Повторите попытку позже.';
}

function responsePage(requestId, ok, message) {
  const result = JSON.stringify({
    type: 'secret-library-invite-result',
    requestId: requestId,
    ok: ok,
    message: message
  }).replace(/</g, '\\u003c');
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    '<p>Операция завершена. Вернитесь в Тайную Библиотеку.</p>' +
    '<script>window.top.postMessage(' + result + ', ' + JSON.stringify(SITE_ORIGIN) + ');</script>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

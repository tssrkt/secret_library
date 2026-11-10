import { startFirebaseSession, endFirebaseSession } from './firebase-session.js';
import { createSocialStore } from './social-store.js?v=20261108-registered-sharing-relationship';
import { createSharedLibraryStore } from './shared-library.js?v=20261109-drive-picker-auth-recovery';
import { discoverDriveFriends, grantRootFolderAccess, closeRootFolderAccess } from './drive-sharing.js?v=20261110-drive-permission-diagnostics';
import { findDriveCatalogFile, downloadDriveJsonFile, getCurrentDriveUser } from './drive.js';
import { sendInvitationEmail, getInvitationStatuses as fetchInvitationStatuses, cancelInvitation as cancelInvitationToken } from './invitation-mailer.js?v=20261108-email-registry-auth';
import { createInvitationLedger, acceptedInvitationFriends, invitationLedgerRows, mergeInvitationRows } from './invitation-ledger.js?v=20261107-ledger-server-discovery';

const TRANSIENT_AUTH_CODES = new Set([
  'unavailable', 'deadline-exceeded', 'internal', 'unknown',
  'auth/network-request-failed', 'network-error',
]);

async function retryTransientAuthOperation(operation, attempts = 3) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const code = String(error?.code || '').toLowerCase();
      const message = String(error?.message || '').toLowerCase();
      const transient = TRANSIENT_AUTH_CODES.has(code)
        || /network request failed|service temporarily unavailable|internal error/.test(message);
      if (!transient || attempt + 1 >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
}

export function socialError(error) {
  if (isQuotaExceeded(error)) {
    notifyQuotaExceeded();
    return DATABASE_QUOTA_MESSAGE;
  }
  if (error?.code?.includes('permission-denied')) return 'Нет доступа к социальным данным. Проверьте настройки Firebase и повторите попытку.';
  if (error?.code?.includes('unavailable') || error?.code?.includes('network')) return 'Не удалось связаться с Firebase. Проверьте подключение и повторите попытку.';
  if (error?.code?.startsWith('auth/')) return 'Не удалось подтвердить Google-сеанс в Firebase. Повторите вход через Google.';
  return error?.message || 'Не удалось выполнить социальную операцию. Попробуйте ещё раз.';
}
const DATABASE_QUOTA_MESSAGE = 'Извините, вход на сайт временно недоступен из-за превышения лимита базы данных. Лимит будет обнулён в полночь по тихоокеанскому времени (в 11:00 по Москве). Мы стараемся делать всё возможное, чтобы снизить нагрузку на сервер, но, поскольку проект некоммерческий, вынуждены пользоваться бесплатным тарифом.';
function isQuotaExceeded(error) {
  return /resource-exhausted|quota.?exceeded|exceeded.*quota/i.test(`${error?.code || ''} ${error?.message || ''}`);
}
function notifyQuotaExceeded() {
  globalThis.window?.dispatchEvent(new CustomEvent('database-quota-exceeded', { detail: { message: DATABASE_QUOTA_MESSAGE } }));
}
function disableFirestoreAfterQuota(current) {
  if (current !== generation) return;
  notifyQuotaExceeded();
  stop?.(); stop = null;
  store?.dispose(); store = null;
  // Keep the Firebase-authenticated user for Apps Script invitation operations.
  // Sending/status checks use the ID token and server registry, not Firestore.
  // Google Drive sharing and friend catalogs remain usable without Firestore.
  emit({ status: 'ready', message: '' });
  settleConnectionReady(true);
}
export function isPendingInvitationResult(result) {
  return typeof result === 'string' && /Приглашение (?:уже )?сохранено/.test(result);
}

const listeners = new Set();
let state = { driveDiscoveryStatus: 'idle', status: 'idle', message: 'Социальная часть ещё не подключена.', friends: [], notifications: [] };
let store;
let stop;
let generation = 0;
let shared;
let driveReader;
let invitationUser = null;
const invitationLedger = createInvitationLedger();
const acceptedLedgerSyncs = new Set();
const knownContactsSyncs = new Map();
const FRIEND_CACHE_PREFIX = 'secret-library-social-friends-v1:';
let driveFriends = [];
let registeredShareFriends = [];
let acceptedInviteFriends = [];
let ledgerInvitationRowsCache = [];
let lastDriveFriendEmailSignature = '';
const closedAccessEmails = new Set();
let configuredRootFolderId = '';
let connectedDriveUser = null;
let connectionReadyPromise = Promise.resolve(false);
let resolveConnectionReady = null;
function settleConnectionReady(ready) {
  resolveConnectionReady?.(ready);
  resolveConnectionReady = null;
}
function readFriendCache(uid) {
  try {
    const value = JSON.parse(localStorage.getItem(`${FRIEND_CACHE_PREFIX}${uid}`) || 'null');
    if (!Array.isArray(value)) return null;
    return value.filter((friend) => friend && typeof friend.uid === 'string'
      && typeof friend.displayName === 'string'
      && friend.inbound === true && typeof friend.outbound === 'boolean');
  } catch { return null; }
}
function combineFriendRows() {
  const friends = [...driveFriends];
  const byUid = new Map(friends.map((friend) => [friend.uid, friend]));
  const byEmail = new Map(friends.map((friend) => [String(friend.email || '').trim().toLowerCase(), friend]).filter(([email]) => email));
  for (const registered of registeredShareFriends) {
    const email = String(registered.email || '').trim().toLowerCase();
    const existing = byUid.get(registered.uid) || (email ? byEmail.get(email) : null);
    if (existing) {
      existing.inbound ||= registered.inbound === true;
      existing.outbound ||= registered.outbound === true;
      if ((!existing.email || String(existing.email).startsWith('email:')) && email) existing.email = email;
      if (registered.displayName && (!existing.displayName || existing.displayName === existing.email)) existing.displayName = registered.displayName;
      continue;
    }
    const friend = { ...registered, email, inbound: registered.inbound === true,
      outbound: registered.outbound === true && !closedAccessEmails.has(email), isAdmin: registered.isAdmin === true, catalogId: '' };
    friends.push(friend);
    byUid.set(friend.uid, friend);
    if (email) byEmail.set(email, friend);
  }
  // Accepted invitations are metadata, not an ongoing friendship. A person stays
  // in Friends only while at least one library-sharing direction is active.
  for (const accepted of acceptedInviteFriends) {
    const email = String(accepted.email || '').trim().toLowerCase();
    const existing = byUid.get(accepted.uid) || (email ? byEmail.get(email) : null);
    if (!existing) continue;
    if ((!existing.email || String(existing.email).startsWith('email:')) && email) existing.email = email;
    if (accepted.displayName && (!existing.displayName || existing.displayName === existing.email)) {
      existing.displayName = accepted.displayName;
    }
  }
  return friends.filter((friend) => friend.inbound === true || friend.outbound === true);
}
function writeFriendCache(uid, friends) {
  if (!uid || !Array.isArray(friends)) return;
  try {
    const safe = friends.filter((friend) => friend && typeof friend.uid === 'string' && friend.inbound === true).slice(0, 500)
      .map((friend) => ({
        uid: friend.uid, displayName: String(friend.displayName || '').slice(0, 160),
        email: String(friend.email || '').slice(0, 254), catalogId: String(friend.catalogId || '').slice(0, 256),
        inbound: friend.inbound === true, outbound: friend.outbound === true, isAdmin: friend.isAdmin === true,
      }));
    localStorage.setItem(`${FRIEND_CACHE_PREFIX}${uid}`, JSON.stringify(safe));
  } catch { /* A full or disabled local storage must not break the library. */ }
}
const NOTIFICATION_SEEN_PREFIX = 'secret-library-notifications-seen-v1:';
function notificationIdentity(friend) { return String(friend?.uid || friend?.email || '').trim().toLowerCase(); }
function readSeenNotifications() {
  const identity = state.driveUserEmail || invitationUser?.uid || '';
  if (!identity) return new Set();
  try {
    const value = JSON.parse(localStorage.getItem(`${NOTIFICATION_SEEN_PREFIX}${identity}`) || '[]');
    return new Set(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
  } catch { return new Set(); }
}
function buildDriveNotifications(friends = driveFriends) {
  const seen = readSeenNotifications();
  return friends.filter((friend) => friend.inbound && friend.uid && !String(friend.uid).startsWith('email:'))
    .map((friend) => {
      const key = notificationIdentity(friend);
      return { ownerUid: friend.uid, email: friend.email || '', displayName: friend.displayName || 'Пользователь',
        unread: Boolean(key && !seen.has(key)), mutual: friend.outbound === true, notificationKey: key };
    }).sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));
}
function markDriveNotificationsSeen(items = []) {
  const identity = state.driveUserEmail || invitationUser?.uid || '';
  if (!identity) return;
  const seen = readSeenNotifications();
  for (const item of items) if (item.notificationKey) seen.add(item.notificationKey);
  try { localStorage.setItem(`${NOTIFICATION_SEEN_PREFIX}${identity}`, JSON.stringify([...seen].slice(-1000))); }
  catch { /* Notifications remain usable for this session if storage is unavailable. */ }
  emit({ notifications: buildDriveNotifications() });
}
const emit = (change) => {
  state = { ...state, ...change };
  if (invitationUser && Array.isArray(change.friends)) writeFriendCache(invitationUser.uid, change.friends);
  listeners.forEach((listener) => listener(state));
};
async function syncAcceptedInvitationStatuses(emails, currentGeneration = generation) {
  if (!invitationUser || !Array.isArray(emails)) return {};
  const idToken = await invitationUser.getIdToken();
  const statuses = await fetchInvitationStatuses({ emails, idToken });
  if (currentGeneration !== generation) return statuses;
  const acceptedEmails = [];
  const serverPendingRows = [];
  for (const [rawEmail, status] of Object.entries(statuses || {})) {
    if (rawEmail === '__quota') continue;
    const email = String(rawEmail).trim().toLowerCase();
    if (!email) continue;
    if (status?.invitationStatus === 'pending') serverPendingRows.push({ inviteeEmail: email, ownerUid: invitationUser.uid, active: true, createdAt: Number(status.createdAt) || Date.now(), emailSentAt: Number(status.lastSentAt) || 0, source: 'apps-script' });
    if (status?.registered === true && status.registeredUid) {
      // Resolve an existing account from the canonical server directory. Keep
      // Drive access directions grounded in actual Drive discovery; registration
      // alone does not mean that the other person shares their library with us.
      const driveFriend = driveFriends.find((friend) => String(friend.email || '').trim().toLowerCase() === email
        || String(friend.uid || '') === String(status.registeredUid));
      const existingIndex = acceptedInviteFriends.findIndex((friend) => String(friend.email || '').trim().toLowerCase() === email);
      const previous = existingIndex >= 0 ? acceptedInviteFriends[existingIndex] : {};
      const registered = { uid: String(status.registeredUid), email,
        displayName: String(status.registeredDisplayName || driveFriend?.displayName || email),
        inbound: driveFriend?.inbound === true || previous.inbound === true,
        outbound: driveFriend?.outbound === true || previous.outbound === true };
      if (existingIndex >= 0) acceptedInviteFriends[existingIndex] = { ...previous, ...registered };
      else acceptedInviteFriends.push(registered);
      acceptedEmails.push(email);
      continue;
    }
    if (status?.accepted !== true || !status.acceptedUid) continue;
    acceptedEmails.push(email);
    const accepted = { uid: String(status.acceptedUid), email, displayName: String(status.acceptedDisplayName || email), inbound: true, outbound: true };
    const index = acceptedInviteFriends.findIndex((friend) => String(friend.email || "").trim().toLowerCase() === email);
    if (index >= 0) acceptedInviteFriends[index] = { ...acceptedInviteFriends[index], ...accepted };
    else acceptedInviteFriends.push(accepted);
    const syncKey = String(invitationUser.uid) + ":" + email;
    if (!acceptedLedgerSyncs.has(syncKey)) {
      acceptedLedgerSyncs.add(syncKey);
      void invitationLedger.setStatus(invitationUser.uid, email, "accepted", { acceptedUid: accepted.uid, acceptedDisplayName: accepted.displayName, acceptedAt: Number(status.acceptedAt) || Date.now() })
        .catch((error) => { acceptedLedgerSyncs.delete(syncKey); console.warn("Could not update the Drive invitation ledger:", error); });
    }
  }
  if (serverPendingRows.length) ledgerInvitationRowsCache = mergeInvitationRows(ledgerInvitationRowsCache, serverPendingRows, acceptedEmails);
  if (acceptedEmails.length) ledgerInvitationRowsCache = mergeInvitationRows(ledgerInvitationRowsCache, [], acceptedEmails);
  const hasUnreconciledRegisteredFriend = acceptedEmails.some((email) =>
    !driveFriends.some((friend) => String(friend.email || '').trim().toLowerCase() === email));
  if (acceptedEmails.length || serverPendingRows.length) emit({ friends: combineFriendRows(), invitations: mergeInvitationRows(state.invitations, ledgerInvitationRowsCache, acceptedEmails) });
  if (hasUnreconciledRegisteredFriend && invitationUser) {
    void refreshDriveFriends(invitationUser, currentGeneration, combineFriendRows(), false);
  }
  return statuses;
}

function watchCatalogs(friends) {
  // Friend relationships and access direction are determined by live Google Drive permissions.
  const libraries = friends.filter((friend) => friend.inbound && !String(friend.uid).startsWith('email:'))
    .map((friend) => ({ uid: friend.uid, displayName: friend.displayName, revision: 'drive', catalogId: friend.catalogId || '' }));
  emit({ libraries });
}
async function refreshDriveFriends(user, currentGeneration = generation, knownFriends = driveFriends, announceLoading = false) {
  // Only the initial discovery drives the page-level loading message. Background
  // refreshes after publishing/sharing must not make the finished UI flash again.
  if (announceLoading) emit({ driveDiscoveryStatus: 'loading', driveDiscoveryMessage: '' });
  try {
    // Folder discovery, catalog reads and library availability are Google Drive-only.
    // Friend tabs are discovered from Drive permissions and Drive catalogs; a prior
    // local snapshot is only a fallback if Drive unexpectedly returns no friends.
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Поиск друзей в Google Drive не завершился за 25 секунд. Список зарегистрированных друзей загружен отдельно; повторите обновление, чтобы проверить доступ к библиотекам.')), 25000);
      discoverDriveFriends(user, configuredRootFolderId, {}, combineFriendRows()).then(resolve, reject).finally(() => clearTimeout(timeout));
    });
    if (currentGeneration !== generation) return;
    if (result.rootFolderId) configuredRootFolderId = result.rootFolderId;
    // If Drive's catalog search temporarily returns no records, retain the last
    // confirmed friend list from this browser instead of showing a false zero.
    // This fallback is local-only and does not add Firestore reads.
    const cachedFriends = invitationUser ? readFriendCache(invitationUser.uid) : null;
    // On initial discovery, do not present a persisted friend cache as if it were current.
    // Background refreshes may retain the last confirmed list to avoid disruptive false-zero states.
    driveFriends = result.friends.length ? result.friends
      : (!announceLoading && cachedFriends?.length ? cachedFriends : (knownFriends || []));
    const discoveryMessage = result.errors?.join(' ') || '';
    const usedFriendFallback = result.friends.length === 0 && driveFriends.length > 0;
    emit({ friends: combineFriendRows(), notifications: buildDriveNotifications(driveFriends), ownRootFolderId: result.rootFolderId || configuredRootFolderId, driveDiscoveryMessage: usedFriendFallback ? `Не удалось повторно обнаружить библиотеки в Google Drive; временно показан последний сохранённый список друзей. ${discoveryMessage}` : discoveryMessage, driveDiscoveryStatus: usedFriendFallback ? 'error' : (result.discoveryStatus || 'ready') });
    watchCatalogs(driveFriends);
  } catch (error) {
    // Keep the last confirmed Drive-derived list when Drive is temporarily unavailable.
    emit({ driveDiscoveryMessage: String(error?.message || error), driveDiscoveryStatus: 'error' });
  }
}

export const social = {
  setRootFolder(rootFolderId) {
    configuredRootFolderId = String(rootFolderId || '');
    if (connectedDriveUser) void refreshDriveFriends(connectedDriveUser, generation, driveFriends, false);
  },
  subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
  getState() { return state; },
  async connect(token, rootFolderId = '') {
    settleConnectionReady(false);
    connectionReadyPromise = new Promise((resolve) => { resolveConnectionReady = resolve; });
    configuredRootFolderId = String(rootFolderId || '');
    connectedDriveUser = null;
    const current = ++generation;
    // Invitation operations use Firebase Auth ID tokens and the Apps Script registry;
    // never reuse a stale user while a new connection is being established.
    invitationUser = null;
    knownContactsSyncs.clear();
    stop?.(); store?.dispose(); store = null;
    shared?.dispose(); shared = null;
    emit({ status: 'loading', driveDiscoveryStatus: 'loading', message: 'Подключение социальной части…', friends: driveFriends, notifications: [], libraries: [], ownRootFolderId: configuredRootFolderId });
    try {
      // Discover and open friend libraries directly with the Google Drive token.
      // This path runs independently of Firebase Authentication/Firestore.
      const driveUser = await getCurrentDriveUser();
      if (current !== generation) return false;
      connectedDriveUser = driveUser;
      emit({ driveUserEmail: String(driveUser?.email || driveUser?.emailAddress || '').trim().toLowerCase() });
      driveReader?.dispose();
      driveReader = createSharedLibraryStore({ user: { uid: '' } });
      driveFriends = [];
      registeredShareFriends = [];
      acceptedInviteFriends = [];
      emit({ friends: [], libraries: [], status: 'loading', message: 'Ищем библиотеки друзей в Google Drive…' });
      void refreshDriveFriends(driveUser, current, [], true);
      const session = await retryTransientAuthOperation(() => startFirebaseSession(token));
      if (current !== generation) return false;
      if (!session) { settleConnectionReady(false); return false; }
      // Keep invitation sending available as soon as Firebase Auth is ready. The
      // invitation API is independent of Firestore registration and subscriptions.
      invitationUser = session.user;
      store = createSocialStore(session);
      // Keep shared-library operations unavailable until invitation registration succeeds.
      shared = createSharedLibraryStore({ user: session.user });
      let knownInvitationEmails = [];
      try {
        const savedLedger = await invitationLedger.load(invitationUser.uid);
        ledgerInvitationRowsCache = invitationLedgerRows(savedLedger.ledger);
        acceptedInviteFriends = acceptedInvitationFriends(savedLedger.ledger);
        knownInvitationEmails = [...new Set((savedLedger.ledger.invitations || []).map((item) => String(item.inviteeEmail || '').trim().toLowerCase()).filter(Boolean))];
        emit({ friends: combineFriendRows(), invitations: mergeInvitationRows([], ledgerInvitationRowsCache) });
      } catch (error) {
        if (isQuotaExceeded(error)) notifyQuotaExceeded();
        ledgerInvitationRowsCache = [];
        acceptedInviteFriends = [];
        console.warn('Could not load the Drive invitation ledger:', error);
      }
      // Apps Script is the source of truth. Always request the full owner registry, not only emails found in the secondary Drive ledger, so invitations missing from that cache are restored. Reconstruct the invitation list and accepted
      // friends even when the secondary Drive appData ledger is unavailable.
      try {
        await syncAcceptedInvitationStatuses([], current);
        if (knownInvitationEmails.length) await syncAcceptedInvitationStatuses(knownInvitationEmails, current);
      } catch (error) {
        if (isQuotaExceeded(error)) notifyQuotaExceeded();
        console.warn('Could not refresh invitation acceptance statuses:', error);
      }
      // Registration now updates the server-provisioned profile instead of relying on
      // Firestore pendingInvites as the invitation authority.
      // Registration is the invitation gate. Never fail open when Firestore is
      // unavailable or over quota: without a successful check, access is denied.
      await retryTransientAuthOperation(() => store.register());
      if (current !== generation) return false;
      try {
        registeredShareFriends = await store.loadFriends();
        if (current === generation) emit({ friends: combineFriendRows() });
      } catch (error) {
        if (isQuotaExceeded(error)) notifyQuotaExceeded();
        // Drive discovery remains a fallback, but a failed relationship query must be visible in diagnostics.
        console.warn('Could not load registered friends and library-sharing relationships:', error);
      }
      if (current !== generation) return false;
      // Registration verifies the invitation; Firestore rules independently protect private records.
      // Avoid an undeployed callable because deploying a new function requires the paid Blaze plan.
      if (current !== generation) return false;
      emit({ status: 'ready', message: '' });
      settleConnectionReady(true);
      stop = store.subscribe((snapshot) => {
        if (current !== generation) return;
        // Invitation acceptance comes from the Apps Script registry. Legacy Firestore
        // snapshots are tolerated during migration, while friend tabs and notifications
        // remain derived from Google Drive;
        // notification read state is stored locally in this browser.
        const liveAcceptedInvitations = Array.isArray(snapshot.acceptedInvitations) ? snapshot.acceptedInvitations : [];
        if (liveAcceptedInvitations.length) acceptedInviteFriends = liveAcceptedInvitations;
        for (const accepted of acceptedInviteFriends) {
          const email = String(accepted.email || '').trim().toLowerCase();
          const syncKey = `${invitationUser?.uid || ''}:${email}`;
          if (!email || acceptedLedgerSyncs.has(syncKey)) continue;
          acceptedLedgerSyncs.add(syncKey);
          void invitationLedger.setStatus(invitationUser.uid, email, 'accepted', {
            acceptedUid: String(accepted.uid || ''), acceptedDisplayName: String(accepted.displayName || accepted.email || ''), acceptedAt: Date.now(),
          }).catch((error) => {
            acceptedLedgerSyncs.delete(syncKey);
            console.warn('Could not update the Drive invitation ledger:', error);
          });
        }
        const acceptedEmails = acceptedInviteFriends.map((friend) => friend.email);
        emit({ ...snapshot, invitations: mergeInvitationRows(snapshot.invitations, ledgerInvitationRowsCache, acceptedEmails), friends: combineFriendRows(), libraries: driveFriends
          .filter((friend) => friend.inbound && !String(friend.uid).startsWith('email:'))
          .map((friend) => ({ uid: friend.uid, displayName: friend.displayName, revision: 'drive', catalogId: friend.catalogId || '' })) });
      },
        (error) => {
          if (current !== generation) return;
          if (isQuotaExceeded(error)) { disableFirestoreAfterQuota(current); return; }
          emit({ status: 'error', message: socialError(error) });
        });
      return true;
    } catch (error) {
      if (current === generation) {
        settleConnectionReady(false);
        if (isQuotaExceeded(error)) {
          notifyQuotaExceeded();
          emit({ status: 'error', message: DATABASE_QUOTA_MESSAGE });
        } else {
          emit({ status: 'error', message: socialError(error) });
        }
      }
      return false;
    }
  },
  disconnect() {
    settleConnectionReady(false);
    generation++; stop?.(); stop = null; store?.dispose(); store = null; invitationUser = null;
    shared?.dispose(); shared = null;
    driveReader?.dispose(); driveReader = null;
    driveFriends = [];
    registeredShareFriends = [];
    acceptedInviteFriends = [];
    ledgerInvitationRowsCache = [];
    configuredRootFolderId = '';
    connectedDriveUser = null;
    closedAccessEmails.clear();
    emit({ status: 'idle', message: '', friends: [], notifications: [], libraries: [], ownRootFolderId: null });
    void endFirebaseSession().catch(() => {});
  },
  async shareWithEmail(email) {
    if (!invitationUser) throw new Error('Сначала войдите через Google, чтобы отправлять приглашения.');
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new Error('Укажите корректный адрес электронной почты.');
    if (normalizedEmail === String(invitationUser.email || '').trim().toLowerCase()) throw new Error('Нельзя пригласить собственный адрес.');
    // Registration lookup is the first operation after validating the email.
    // Never resolve Drive access, reserve quota, write an invitation, or send mail
    // until the server has confirmed that this address is not already a participant.
    const idToken = await invitationUser.getIdToken();
    const knownStatuses = await fetchInvitationStatuses({ emails: [normalizedEmail], idToken });
    const registeredStatus = knownStatuses && knownStatuses[normalizedEmail];

    let rootFolderId = configuredRootFolderId || state.ownRootFolderId || '';
    // The selected root is already represented by the published Drive catalog.
    // Recover it from Drive if the in-memory setting has not caught up yet.
    if (!rootFolderId) {
      const catalogFile = await findDriveCatalogFile(invitationUser.uid);
      if (catalogFile) {
        const catalog = await downloadDriveJsonFile(catalogFile.id);
        if (catalog?.ownerUid === invitationUser.uid && typeof catalog.rootFolderId === 'string') {
          rootFolderId = catalog.rootFolderId;
          configuredRootFolderId = rootFolderId;
        }
      }
    }
    if (!rootFolderId) throw new Error('Не удалось определить корневую папку из опубликованного каталога Google Drive. Обновите библиотеку и повторите попытку.');
    if (registeredStatus?.registered === true && registeredStatus.registeredUid) {
      await grantRootFolderAccess(rootFolderId, normalizedEmail);
      // Drive permission alone does not create the app's library relationship.
      // Persist the active owner -> viewer relationship before reporting success.
      if (!store) throw new Error('Library relationship unavailable. Please try again.');
      await store.setSharing(String(registeredStatus.registeredUid), true, normalizedEmail);
      registeredShareFriends = await store.loadFriends();
      closedAccessEmails.delete(normalizedEmail);
      const driveFriend = driveFriends.find((friend) => String(friend.email || '').trim().toLowerCase() === normalizedEmail
        || String(friend.uid || '') === String(registeredStatus.registeredUid));
      const index = acceptedInviteFriends.findIndex((friend) => String(friend.email || '').trim().toLowerCase() === normalizedEmail);
      const existing = index >= 0 ? acceptedInviteFriends[index] : {};
      const registeredFriend = {
        uid: String(registeredStatus.registeredUid), email: normalizedEmail,
        displayName: String(registeredStatus.registeredDisplayName || driveFriend?.displayName || existing.displayName || normalizedEmail),
        inbound: driveFriend?.inbound === true || existing.inbound === true,
        outbound: true,
      };
      if (index >= 0) acceptedInviteFriends[index] = { ...existing, ...registeredFriend };
      else acceptedInviteFriends.push(registeredFriend);
      emit({ friends: combineFriendRows(),
        invitations: mergeInvitationRows(state.invitations, ledgerInvitationRowsCache, [normalizedEmail]),
        notifications: buildDriveNotifications(driveFriends), ownRootFolderId: rootFolderId });
      watchCatalogs(driveFriends);
      void refreshDriveFriends(invitationUser, generation, driveFriends);
      return `Доступ к библиотеке предоставлен.`;
    }

    // Validate and send through the server-owned registry before granting Drive access.
    // This prevents rejected/over-limit invitations from receiving the root folder.
    const result = await sendInvitationEmail({ email: normalizedEmail, idToken });
    try {
      await grantRootFolderAccess(rootFolderId, normalizedEmail);
      closedAccessEmails.delete(normalizedEmail);
    } catch (error) {
      const detail = String(error?.message || error || '').trim();
      throw new Error('Invitation email was sent, but Google Drive folder access could not be granted. Do not resend the invitation; check the folder permissions. ' + detail);
    }
    try {
      const savedLedger = await invitationLedger.upsert(invitationUser.uid, {
        inviteeEmail: normalizedEmail,
        status: 'pending',
        createdAt: Date.now(),
      });
      ledgerInvitationRowsCache = invitationLedgerRows(savedLedger.ledger, acceptedInviteFriends.map((friend) => friend.email));
    } catch (error) {
      // Drive appData is a secondary cache; the Apps Script registry can reconstruct
      // the pending row on the next status refresh even if this write fails.
      console.warn('Could not save the Drive invitation ledger:', error);
    }

    const known = driveFriends.find((friend) => String(friend.email || '').trim().toLowerCase() === normalizedEmail);
    if (known?.inbound) known.outbound = true;
    // Do not add a recipient to Friends merely because a Drive permission was granted.
    // Only a completed registration should create the friend relationship.
    emit({ friends: combineFriendRows(), invitations: mergeInvitationRows(state.invitations, ledgerInvitationRowsCache, acceptedInviteFriends.map((friend) => friend.email)), notifications: buildDriveNotifications(driveFriends), ownRootFolderId: rootFolderId });
    watchCatalogs(driveFriends);
    void refreshDriveFriends(invitationUser, generation, driveFriends);
    return result;
  },
  // Reciprocal sharing is for an existing participant who has already shared
  // their library with us. Grant Drive access only: never send or record an invite.
  async shareBackWithEmail(email, ownerUid = '') {
    if (!invitationUser) throw new Error('Сначала войдите через Google, чтобы открыть доступ к библиотеке.');
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new Error('Не удалось определить email владельца библиотеки.');
    if (normalizedEmail === String(invitationUser.email || '').trim().toLowerCase()) throw new Error('Нельзя открыть доступ самому себе.');
    let rootFolderId = configuredRootFolderId || state.ownRootFolderId || '';
    if (!rootFolderId) {
      const catalogFile = await findDriveCatalogFile(invitationUser.uid);
      if (catalogFile) {
        const catalog = await downloadDriveJsonFile(catalogFile.id);
        if (catalog?.ownerUid === invitationUser.uid && typeof catalog.rootFolderId === 'string') {
          rootFolderId = catalog.rootFolderId;
          configuredRootFolderId = rootFolderId;
        }
      }
    }
    if (!rootFolderId) throw new Error('Не удалось определить корневую папку вашей библиотеки. Обновите библиотеку и повторите попытку.');
    await grantRootFolderAccess(rootFolderId, normalizedEmail);
    closedAccessEmails.delete(normalizedEmail);
    for (const friend of driveFriends) {
      if ((ownerUid && String(friend.uid) === String(ownerUid))
          || String(friend.email || '').trim().toLowerCase() === normalizedEmail) {
        friend.outbound = true;
      }
    }
    emit({ friends: combineFriendRows(), notifications: buildDriveNotifications(driveFriends), ownRootFolderId: rootFolderId });
    watchCatalogs(driveFriends);
    void refreshDriveFriends(invitationUser, generation, driveFriends);
    return 'Доступ к вашей библиотеке предоставлен.';
  },
  async closeFriendAccess(email) {
    let rootFolderId = configuredRootFolderId || state.ownRootFolderId || '';
    if (!rootFolderId && invitationUser?.uid) {
      const catalogFile = await findDriveCatalogFile(invitationUser.uid);
      if (catalogFile) {
        const catalog = await downloadDriveJsonFile(catalogFile.id);
        if (catalog?.ownerUid === invitationUser.uid && typeof catalog.rootFolderId === 'string') {
          rootFolderId = catalog.rootFolderId;
          configuredRootFolderId = rootFolderId;
        }
      }
    }
    const normalizedEmail = String(email || '').trim().toLowerCase();
    // Revoke the actual Drive permission first, then close the matching registered
    // owner -> viewer relationship so the person disappears from Friends unless
    // they still share their library with us.
    const result = await closeRootFolderAccess(rootFolderId, normalizedEmail);
    closedAccessEmails.add(normalizedEmail);
    for (const friend of driveFriends) {
      if (String(friend.email || '').trim().toLowerCase() === normalizedEmail) friend.outbound = false;
    }
    const registeredFriend = registeredShareFriends.find((friend) =>
      String(friend.email || '').trim().toLowerCase() === normalizedEmail && friend.outbound === true);
    const driveFriend = driveFriends.find((friend) =>
      String(friend.email || '').trim().toLowerCase() === normalizedEmail && friend.uid && !String(friend.uid).startsWith('email:'));
    const otherUid = registeredFriend?.uid || driveFriend?.uid;
    if (otherUid && store && registeredShareFriends.some((friend) => String(friend.uid) === String(otherUid) && friend.outbound === true)) {
      await store.setSharing(String(otherUid), false, normalizedEmail);
      registeredShareFriends = await store.loadFriends();
    }
    emit({ friends: combineFriendRows() });
    return result;
  },
  async resendInvitation(email) {
    if (!invitationUser) throw new Error('Сначала войдите через Google, чтобы отправлять приглашения.');
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(normalizedEmail)) throw new Error('Укажите корректный адрес электронной почты.');
    const idToken = await invitationUser.getIdToken();
    const knownStatuses = await fetchInvitationStatuses({ emails: [normalizedEmail], idToken });
    const registeredStatus = knownStatuses && knownStatuses[normalizedEmail];
    if (registeredStatus?.registered === true && registeredStatus.registeredUid) {
      // A stale row may still expose the resend action. Route it through the same
      // registered-user flow; never send another invitation email to a member.
      return social.shareWithEmail(normalizedEmail);
    }
    return sendInvitationEmail({ email: normalizedEmail, idToken });
  },
  async cancelInvitation(email) {
    if (!invitationUser) throw new Error('Сначала войдите через Google, чтобы отменять приглашения.');
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) throw new Error('Не указан адрес приглашённого участника.');
    let rootFolderId = configuredRootFolderId || state.ownRootFolderId || '';
    if (!rootFolderId) {
      const catalogFile = await findDriveCatalogFile(invitationUser.uid);
      if (catalogFile) {
        const catalog = await downloadDriveJsonFile(catalogFile.id);
        if (catalog?.ownerUid === invitationUser.uid && typeof catalog.rootFolderId === 'string') {
          rootFolderId = catalog.rootFolderId;
          configuredRootFolderId = rootFolderId;
        }
      }
    }
    if (!rootFolderId) throw new Error('Не удалось определить корневую папку. Приглашение не отменено; обновите библиотеку и повторите попытку.');
    const idToken = await invitationUser.getIdToken();
    // Server-side revocation comes first: even if Drive permission cleanup fails,
    // the invitation token is already unusable and cannot register the recipient.
    const result = await cancelInvitationToken({ email: normalizedEmail, idToken });
    try {
      await closeRootFolderAccess(rootFolderId, normalizedEmail);
    } catch (error) {
      throw new Error('Приглашение отменено, ссылка регистрации недействительна, письмо отправлено, но Google Drive не подтвердил закрытие доступа к папке. Повторите закрытие доступа из списка друзей или проверьте права папки. ' + (error?.message || error));
    }
    closedAccessEmails.add(normalizedEmail);
    for (const friend of driveFriends) {
      if (String(friend.email || '').trim().toLowerCase() === normalizedEmail) friend.outbound = false;
    }
    try {
      await invitationLedger.setStatus(invitationUser.uid, normalizedEmail, 'revoked');
    } catch (error) {
      console.warn('Could not update the Drive invitation ledger after cancellation:', error);
    }
    emit({ friends: combineFriendRows() });
    return result;
  },
  async getInvitationStatuses(emails) {
    if (!invitationUser) throw new Error('Сначала войдите через Google, чтобы проверить приглашения.');
    return syncAcceptedInvitationStatuses(emails, generation);
  },
  setSharing(uid, active, email = '') { if (!store || state.status !== 'ready') return Promise.reject(new Error(state.message)); return store.setSharing(uid, active, email); },
  markSeen(items) { markDriveNotificationsSeen(items); return Promise.resolve(); },
  syncKnownContacts() { return Promise.resolve(); },
  async publishLibrary(index, settings) {
    if (!shared && state.status === 'loading') await connectionReadyPromise;
    if (!shared) throw new Error(state.message || 'Google Drive session is not ready; the friend catalog was not synchronized.');
    if (index?.rootFolderId) configuredRootFolderId = index.rootFolderId;
    const result = await shared.publish(index, settings);
    if (invitationUser) void refreshDriveFriends(invitationUser);
    return result;
  },
  get ready() { return state.status === 'ready'; },
  unpublishLibrary() { if (!shared || state.status !== 'ready') return Promise.reject(new Error('Для изменения доступа подключите социальную часть.')); return shared.unpublish(); },
  loadLibrary(uid, revision, catalogId = '') {
    // Use the exact catalog ID already validated by Drive discovery. This avoids
    // a second ambiguous global filename search when the user opens the tab.
    const library = state.libraries?.find((item) => item.uid === uid);
    if (!driveReader || !library) return Promise.reject(new Error('Библиотека недоступна.'));
    return driveReader.load(uid, catalogId || library.catalogId || '');
  },
  loadCover(uid, book) {
    // Cover loading is a Google Drive-only feature. Use the reader initialized before
    // Firebase registration so a Firebase session/quota problem cannot blank friend covers.
    if (!driveReader || !state.friends.some((friend) => friend.uid === uid && friend.inbound)) return Promise.resolve(null);
    return driveReader.loadCover(uid, book);
  }
};

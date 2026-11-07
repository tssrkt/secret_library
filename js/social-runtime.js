import { startFirebaseSession, endFirebaseSession } from './firebase-session.js';
import { createSocialStore } from './social-store.js?v=20261107-invite-registry-discovery';
import { createSharedLibraryStore } from './shared-library.js?v=20261106-root-discovery';
import { discoverDriveFriends, grantRootFolderAccess, closeRootFolderAccess } from './drive-sharing.js?v=20261107-close-friend-access';
import { findDriveCatalogFile, downloadDriveJsonFile, getCurrentDriveUser } from './drive.js';
import { sendInvitationEmail, getInvitationStatuses as fetchInvitationStatuses, acceptInvitation as acceptInvitationToken } from './invitation-mailer.js?v=20261107-invite-registry-discovery';
import { createInvitationLedger, acceptedInvitationFriends, invitationLedgerRows, mergeInvitationRows } from './invitation-ledger.js?v=20261107-ledger-server-discovery';

export function socialError(error) {
  if (error?.code?.includes('permission-denied')) return 'Нет доступа к социальным данным. Проверьте настройки Firebase и повторите попытку.';
  if (error?.code?.includes('unavailable') || error?.code?.includes('network')) return 'Не удалось связаться с Firebase. Проверьте подключение и повторите попытку.';
  if (error?.code?.startsWith('auth/')) return 'Не удалось подтвердить Google-сеанс в Firebase. Повторите вход через Google.';
  return error?.message || 'Не удалось выполнить социальную операцию. Попробуйте ещё раз.';
}
function isQuotaExceeded(error) {
  return /resource-exhausted|quota.?exceeded|exceeded.*quota/i.test(`${error?.code || ''} ${error?.message || ''}`);
}
function disableFirestoreAfterQuota(current) {
  if (current !== generation) return;
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
let acceptedInviteFriends = [];
let ledgerInvitationRowsCache = [];
let lastDriveFriendEmailSignature = '';
const closedAccessEmails = new Set();
let configuredRootFolderId = '';
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
  for (const accepted of acceptedInviteFriends) {
    const email = String(accepted.email || '').trim().toLowerCase();
    const existing = byUid.get(accepted.uid) || byEmail.get(email);
    if (existing) {
      if (!closedAccessEmails.has(email)) existing.outbound = true;
      continue;
    }
    const friend = { uid: accepted.uid, email, displayName: accepted.displayName || email, inbound: false, outbound: !closedAccessEmails.has(email), isAdmin: false, catalogId: '' };
    friends.push(friend);
    byUid.set(friend.uid, friend);
    if (email) byEmail.set(email, friend);
  }
  return friends;
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
    const email = String(rawEmail).trim().toLowerCase();
    if (!email) continue;
    if (status?.invitationStatus === 'pending') serverPendingRows.push({ inviteeEmail: email, ownerUid: invitationUser.uid, active: true, createdAt: Number(status.createdAt) || Date.now(), emailSentAt: Number(status.lastSentAt) || 0, source: 'apps-script' });
    if (status?.accepted !== true || !status.acceptedUid) continue;
    acceptedEmails.push(email);
    const accepted = { uid: String(status.acceptedUid), email, displayName: String(status.acceptedDisplayName || email) };
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
  if (acceptedEmails.length || serverPendingRows.length) emit({ friends: combineFriendRows(), invitations: mergeInvitationRows(state.invitations, ledgerInvitationRowsCache, acceptedEmails) });
  return statuses;
}

function watchCatalogs(friends) {
  // Friend relationships and access direction are determined by live Google Drive permissions.
  const libraries = friends.filter((friend) => friend.inbound && !String(friend.uid).startsWith('email:'))
    .map((friend) => ({ uid: friend.uid, displayName: friend.displayName, revision: 'drive', catalogId: friend.catalogId || '' }));
  emit({ libraries });
}
async function refreshDriveFriends(user, currentGeneration = generation, knownFriends = driveFriends) {
  emit({ driveDiscoveryStatus: 'loading', driveDiscoveryMessage: '' });
  try {
    // Folder discovery, catalog reads and library availability are Google Drive-only.
    // Friend tabs are discovered from Drive permissions and Drive catalogs; a prior
    // local snapshot is only a fallback if Drive unexpectedly returns no friends.
    const result = await discoverDriveFriends(user, configuredRootFolderId, {}, knownFriends);
    if (currentGeneration !== generation) return;
    if (result.rootFolderId) configuredRootFolderId = result.rootFolderId;
    // If Drive's catalog search temporarily returns no records, retain the last
    // confirmed friend list from this browser instead of showing a false zero.
    // This fallback is local-only and does not add Firestore reads.
    const cachedFriends = invitationUser ? readFriendCache(invitationUser.uid) : null;
    driveFriends = result.friends.length ? result.friends
      : (cachedFriends?.length ? cachedFriends : (knownFriends || []));
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
  async checkAccess(token) {
    const session = await startFirebaseSession(token);
    if (!session) throw new Error('Не удалось проверить доступ к библиотеке.');
    try {
      const result = await session.functionsSdk.httpsCallable(session.functions, 'checkLibraryAccess')({});
      if (result.data?.allowed !== true) throw new Error('Доступ к библиотеке не подтверждён.');
      return true;
    } catch (error) {
      await endFirebaseSession().catch(() => {});
      throw error;
    }
  },
  subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
  async connect(token, rootFolderId = '', invitationToken = '') {
    settleConnectionReady(false);
    connectionReadyPromise = new Promise((resolve) => { resolveConnectionReady = resolve; });
    if (rootFolderId) configuredRootFolderId = rootFolderId;
    const current = ++generation;
    knownContactsSyncs.clear();
    stop?.(); store?.dispose(); store = null;
    shared?.dispose(); shared = null;
    emit({ status: 'loading', driveDiscoveryStatus: 'loading', message: 'Подключение социальной части…', friends: driveFriends, notifications: [], libraries: [], ownRootFolderId: configuredRootFolderId });
    try {
      // Discover and open friend libraries directly with the Google Drive token.
      // This path runs independently of Firebase Authentication/Firestore.
      const driveUser = await getCurrentDriveUser();
      if (current !== generation) return;
      emit({ driveUserEmail: String(driveUser?.email || driveUser?.emailAddress || '').trim().toLowerCase() });
      driveReader?.dispose();
      driveReader = createSharedLibraryStore({ user: { uid: '' } });
      driveFriends = [];
      acceptedInviteFriends = [];
      emit({ friends: [], libraries: [], status: 'loading', message: 'Ищем библиотеки друзей в Google Drive…' });
      void refreshDriveFriends(driveUser, current, []);
      const session = await startFirebaseSession(token);
      if (current !== generation) return;
      if (!session) { settleConnectionReady(false); return; }
      store = createSocialStore(session);
      // Drive catalog publishing must not depend on Firestore registration/quota.
      // Resolve this gate as soon as the Google-authenticated Drive store exists.
      shared = createSharedLibraryStore({ user: session.user });
      settleConnectionReady(true);
      invitationUser = session.user;
      let knownInvitationEmails = [];
      try {
        const savedLedger = await invitationLedger.load(invitationUser.uid);
        ledgerInvitationRowsCache = invitationLedgerRows(savedLedger.ledger);
        acceptedInviteFriends = acceptedInvitationFriends(savedLedger.ledger);
        knownInvitationEmails = [...new Set((savedLedger.ledger.invitations || []).map((item) => String(item.inviteeEmail || '').trim().toLowerCase()).filter(Boolean))];
        emit({ friends: combineFriendRows(), invitations: mergeInvitationRows([], ledgerInvitationRowsCache) });
      } catch (error) {
        ledgerInvitationRowsCache = [];
        acceptedInviteFriends = [];
        console.warn('Could not load the Drive invitation ledger:', error);
      }
      // Apps Script is the source of truth. Always request the full owner registry, not only emails found in the secondary Drive ledger, so invitations missing from that cache are restored. Reconstruct the invitation list and accepted
      // friends even when the secondary Drive appData ledger is unavailable.
      try { await syncAcceptedInvitationStatuses([], current); }
      catch (error) { console.warn('Could not refresh invitation acceptance statuses:', error); }
      // Accept the server-verified invitation before client registration. Apps Script
      // creates the profile, email directory entry and owner->reader relationship using
      // the verified token; the browser cannot forge an invitation to bypass the gate.
      if (invitationToken) {
        const idToken = await session.user.getIdToken();
        await acceptInvitationToken({ token: invitationToken, idToken });
        // Remove the one-time secret from the address bar only after server acceptance.
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('invite');
        window.history.replaceState({}, '', cleanUrl);
      }
      // Registration now updates the server-provisioned profile instead of relying on
      // Firestore pendingInvites as the invitation authority.
      try {
        await store.register();
      } catch (error) {
        if (!isQuotaExceeded(error)) throw error;
        disableFirestoreAfterQuota(current);
        return;
      }
      if (current !== generation) return;
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
    } catch (error) {
      if (current === generation) {
        settleConnectionReady(false);
        emit({ status: 'error', message: socialError(error) });
      }
    }
  },
  disconnect() {
    settleConnectionReady(false);
    generation++; stop?.(); stop = null; store?.dispose(); store = null; invitationUser = null;
    shared?.dispose(); shared = null;
    driveReader?.dispose(); driveReader = null;
    driveFriends = [];
    acceptedInviteFriends = [];
    ledgerInvitationRowsCache = [];
    configuredRootFolderId = '';
    closedAccessEmails.clear();
    emit({ status: 'idle', message: 'Войдите через Google.', friends: [], notifications: [], libraries: [], ownRootFolderId: null });
    void endFirebaseSession().catch(() => {});
  },
  async shareWithEmail(email) {
    if (!invitationUser || state.status !== 'ready') throw new Error(state.message || 'Сначала подключите библиотеку.');
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new Error('Укажите корректный адрес электронной почты.');
    if (normalizedEmail === String(invitationUser.email || '').trim().toLowerCase()) throw new Error('Нельзя пригласить собственный адрес.');
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

    // Validate and send through the server-owned registry before granting Drive access.
    // This prevents rejected/over-limit invitations from receiving the root folder.
    const idToken = await invitationUser.getIdToken();
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
  async closeFriendAccess(email) {
    // This action is intentionally Google Drive-only: no Firestore/store calls.
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
    const result = await closeRootFolderAccess(rootFolderId, email);
    const normalizedEmail = String(email || '').trim().toLowerCase();
    closedAccessEmails.add(normalizedEmail);
    for (const friend of driveFriends) {
      if (String(friend.email || '').trim().toLowerCase() === normalizedEmail) friend.outbound = false;
    }
    emit({ friends: combineFriendRows() });
    return result;
  },
  async resendInvitation(email) {
    if (!invitationUser || state.status !== 'ready') throw new Error(state.message || 'Сначала подключите библиотеку.');
    const idToken = await invitationUser.getIdToken();
    return sendInvitationEmail({ email, idToken });
  },
  async getInvitationStatuses(emails) {
    if (!invitationUser || state.status !== 'ready') throw new Error(state.message || 'Сначала подключите библиотеку.');
    return syncAcceptedInvitationStatuses(emails, generation);
  },
  setSharing(uid, active) { if (!store || state.status !== 'ready') return Promise.reject(new Error(state.message)); return store.setSharing(uid, active); },
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

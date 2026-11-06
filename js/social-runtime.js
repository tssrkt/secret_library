import { startFirebaseSession, endFirebaseSession } from './firebase-session.js';
import { createSocialStore } from './social-store.js';
import { createSharedLibraryStore } from './shared-library.js?v=20261106-drive-catalog';
import { discoverDriveFriends, grantRootFolderAccess } from './drive-sharing.js?v=20261106-catalog-id-load';
import { sendInvitationEmail, getInvitationStatuses as fetchInvitationStatuses } from './invitation-mailer.js';

export function socialError(error) {
  if (error?.code?.includes('permission-denied')) return 'Нет доступа к социальным данным. Проверьте настройки Firebase и повторите попытку.';
  if (error?.code?.includes('unavailable') || error?.code?.includes('network')) return 'Не удалось связаться с Firebase. Проверьте подключение и повторите попытку.';
  if (error?.code?.startsWith('auth/')) return 'Не удалось подтвердить Google-сеанс в Firebase. Повторите вход через Google.';
  return error?.message || 'Не удалось выполнить социальную операцию. Попробуйте ещё раз.';
}
export function isPendingInvitationResult(result) {
  return typeof result === 'string' && /Приглашение (?:уже )?сохранено/.test(result);
}

const listeners = new Set();
let state = { status: 'idle', message: 'Социальная часть ещё не подключена.', friends: [], notifications: [] };
let store;
let stop;
let generation = 0;
let shared;
let invitationUser = null;
const knownContactsSyncs = new Map();
const FRIEND_CACHE_PREFIX = 'secret-library-social-friends-v1:';
let driveFriends = [];
let lastDriveFriendEmailSignature = '';
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
      && typeof friend.inbound === 'boolean' && typeof friend.outbound === 'boolean');
  } catch { return null; }
}
function writeFriendCache(uid, friends) {
  if (!uid || !Array.isArray(friends)) return;
  try {
    const safe = friends.filter((friend) => friend && typeof friend.uid === 'string').slice(0, 500)
      .map((friend) => ({
        uid: friend.uid, displayName: String(friend.displayName || '').slice(0, 160),
        email: String(friend.email || '').slice(0, 254), catalogId: String(friend.catalogId || '').slice(0, 256),
        inbound: friend.inbound === true, outbound: friend.outbound === true, isAdmin: friend.isAdmin === true,
      }));
    localStorage.setItem(`${FRIEND_CACHE_PREFIX}${uid}`, JSON.stringify(safe));
  } catch { /* A full or disabled local storage must not break the library. */ }
}
const emit = (change) => {
  state = { ...state, ...change };
  if (invitationUser && Array.isArray(change.friends)) writeFriendCache(invitationUser.uid, change.friends);
  listeners.forEach((listener) => listener(state));
};
function watchCatalogs(friends) {
  // Friend relationships and access direction are determined by live Google Drive permissions.
  const libraries = friends.filter((friend) => friend.inbound && !String(friend.uid).startsWith('email:'))
    .map((friend) => ({ uid: friend.uid, displayName: friend.displayName, revision: 'drive', catalogId: friend.catalogId || '' }));
  emit({ libraries });
}
async function refreshDriveFriends(user, currentGeneration = generation, knownFriends = driveFriends) {
  try {
    // Use emails already present in the UI/cache snapshot as search keys only.
    // Folder discovery, catalog reads and library availability are Google Drive-only.
    const emailSignature = [...new Set((knownFriends || []).map((friend) => String(friend?.email || '').trim().toLowerCase()).filter(Boolean))].sort().join('|');
    lastDriveFriendEmailSignature = emailSignature;
    const result = await discoverDriveFriends(user, configuredRootFolderId, {}, knownFriends);
    if (currentGeneration !== generation) return;
    if (result.rootFolderId) configuredRootFolderId = result.rootFolderId;
    driveFriends = result.friends;
    emit({ friends: driveFriends, ownRootFolderId: result.rootFolderId || configuredRootFolderId, driveDiscoveryMessage: result.errors?.join(' ') || '' });
    watchCatalogs(driveFriends);
  } catch (error) {
    // Keep the last confirmed Drive-derived list when Drive is temporarily unavailable.
    emit({ driveDiscoveryMessage: String(error?.message || error) });
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
  async connect(token, rootFolderId = '') {
    settleConnectionReady(false);
    connectionReadyPromise = new Promise((resolve) => { resolveConnectionReady = resolve; });
    if (rootFolderId) configuredRootFolderId = rootFolderId;
    const current = ++generation;
    knownContactsSyncs.clear();
    stop?.(); store?.dispose(); store = null;
    shared?.dispose(); shared = null;
    emit({ status: 'loading', message: 'Подключение социальной части…', friends: driveFriends, notifications: [], libraries: [], ownRootFolderId: configuredRootFolderId });
    try {
      const session = await startFirebaseSession(token);
      if (current !== generation) return;
      if (!session) { settleConnectionReady(false); return; }
      store = createSocialStore(session);
      // Drive catalog publishing must not depend on Firestore registration/quota.
      // Resolve this gate as soon as the Google-authenticated Drive store exists.
      shared = createSharedLibraryStore({ user: session.user });
      settleConnectionReady(true);
      invitationUser = session.user;
      const cachedFriends = readFriendCache(session.user.uid);
      driveFriends = cachedFriends || driveFriends;
      if (cachedFriends) {
        emit({ friends: cachedFriends });
        watchCatalogs(cachedFriends);
      }
      void refreshDriveFriends(session.user, current);
      await store.register();
      if (current !== generation) return;
      emit({ status: 'ready', message: '' });
      settleConnectionReady(true);
      stop = store.subscribe((snapshot) => {
        if (current !== generation) return;
        const snapshotEmailSignature = [...new Set((snapshot.friends || []).map((friend) => String(friend?.email || '').trim().toLowerCase()).filter(Boolean))].sort().join('|');
        if (snapshotEmailSignature && snapshotEmailSignature !== lastDriveFriendEmailSignature) {
          void refreshDriveFriends(session.user, current, snapshot.friends);
        }
        emit({ ...snapshot, friends: driveFriends });
        watchCatalogs(driveFriends);
      },
        (error) => { if (current === generation) emit({ status: 'error', message: socialError(error) }); });
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
    driveFriends = [];
    configuredRootFolderId = '';
    emit({ status: 'idle', message: 'Войдите через Google.', friends: [], notifications: [], libraries: [], ownRootFolderId: null });
    void endFirebaseSession().catch(() => {});
  },
  async shareWithEmail(email) {
    if (!configuredRootFolderId) throw new Error('Сначала выберите корневую папку своей библиотеки.');
    // Drive permissions define library access; Firestore is only invitation metadata.
    await grantRootFolderAccess(configuredRootFolderId, email);
    if (!store || !invitationUser || state.status !== 'ready') return 'Доступ к папке Google Drive предоставлен.';
    let result;
    try { result = await store.shareWithEmail(email); }
    catch (error) { return 'Доступ к папке Google Drive предоставлен, но приглашение не удалось сохранить в базе данных. ' + (error?.message || ''); }
    if (!isPendingInvitationResult(result)) return result;
    const idToken = await invitationUser.getIdToken();
    return sendInvitationEmail({ email, idToken });
  },
  async resendInvitation(email) {
    if (!store || !invitationUser || state.status !== 'ready') throw new Error(state.message);
    const idToken = await invitationUser.getIdToken();
    return sendInvitationEmail({ email, idToken });
  },
  async getInvitationStatuses(emails) {
    if (!store || !invitationUser || state.status !== 'ready') throw new Error(state.message);
    const idToken = await invitationUser.getIdToken();
    return fetchInvitationStatuses({ emails, idToken });
  },
  setSharing(uid, active) { if (!store || state.status !== 'ready') return Promise.reject(new Error(state.message)); return store.setSharing(uid, active); },
  markSeen(items) { if (!store || state.status !== 'ready') return Promise.resolve(); return store.markSeen(items); },
  syncKnownContacts(signature = '') {
    if (!store || state.status !== 'ready') return Promise.resolve();
    const key = `${invitationUser?.uid || ''}:${signature}`;
    if (knownContactsSyncs.has(key)) return knownContactsSyncs.get(key);
    const pending = store.syncKnownContacts().catch((error) => { knownContactsSyncs.delete(key); throw error; });
    knownContactsSyncs.set(key, pending);
    return pending;
  },
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
    if (!shared || !library) return Promise.reject(new Error('Библиотека недоступна.'));
    return shared.load(uid, catalogId || library.catalogId || '');
  },
  loadCover(uid, book) {
    if (!shared || !state.friends.some((friend) => friend.uid === uid && friend.inbound)) return Promise.resolve(null);
    return shared.loadCover(uid, book);
  }
};

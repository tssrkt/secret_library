import { startFirebaseSession, endFirebaseSession } from './firebase-session.js';
import { createSocialStore } from './social-store.js';
import { createSharedLibraryStore } from './shared-library.js?v=20261106-drive-catalog';
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
      .map(({ uid: friendUid, displayName, inbound, outbound, isAdmin }) => ({
        uid: friendUid, displayName: String(displayName || '').slice(0, 160),
        inbound: inbound === true, outbound: outbound === true, isAdmin: isAdmin === true,
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
  // Friend relationships come from the social store; catalog discovery and loading use Drive only.
  // Opening a library does not query Firestore for a manifest or catalog.
  const libraries = friends.filter((friend) => friend.inbound)
    .map((friend) => ({ uid: friend.uid, displayName: friend.displayName, revision: 'drive' }));
  emit({ libraries });
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
  async connect(token) {
    const current = ++generation;
    knownContactsSyncs.clear();
    stop?.(); store?.dispose(); store = null;
    shared?.dispose(); shared = null;
    emit({ status: 'loading', message: 'Подключение социальной части…', friends: [], notifications: [], libraries: [] });
    try {
      const session = await startFirebaseSession(token);
      if (!session || current !== generation) return;
      store = createSocialStore(session);
      shared = createSharedLibraryStore({ user: session.user });
      invitationUser = session.user;
      const cachedFriends = readFriendCache(session.user.uid);
      if (cachedFriends) {
        emit({ friends: cachedFriends, libraries: cachedFriends.filter((friend) => friend.inbound)
          .map((friend) => ({ uid: friend.uid, displayName: friend.displayName, revision: 'drive' })) });
      }
      await store.register();
      await store.syncShareEmails().catch(() => {});
      if (current !== generation) return;
      emit({ status: 'ready', message: '' });
      stop = store.subscribe((snapshot) => { if (current === generation) { emit(snapshot); watchCatalogs(snapshot.friends); } },
        (error) => { if (current === generation) emit({ status: 'error', message: socialError(error) }); });
    } catch (error) { if (current === generation) emit({ status: 'error', message: socialError(error) }); }
  },
  disconnect() {
    generation++; stop?.(); stop = null; store?.dispose(); store = null; invitationUser = null;
    shared?.dispose(); shared = null;
    emit({ status: 'idle', message: 'Войдите через Google.', friends: [], notifications: [], libraries: [] });
    void endFirebaseSession().catch(() => {});
  },
  async shareWithEmail(email) {
    if (!store || !invitationUser || state.status !== 'ready') throw new Error(state.message);
    const result = await store.shareWithEmail(email);
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
  publishLibrary(index, settings) {
    if (!shared || state.status !== 'ready') return Promise.reject(new Error(state.message || 'Firebase connection is not ready; the friend catalog was not synchronized.'));
    return shared.publish(index, settings);
  },
  get ready() { return state.status === 'ready'; },
  unpublishLibrary() { if (!shared || state.status !== 'ready') return Promise.reject(new Error('Для изменения доступа подключите социальную часть.')); return shared.unpublish(); },
  loadLibrary(uid, revision) {
    // A cached relationship may keep the friend's tab available while Firestore is
    // temporarily over quota. Google Drive still enforces the owner's actual access.
    if (!shared || !state.libraries?.some((library) => library.uid === uid)) return Promise.reject(new Error('Библиотека недоступна.'));
    return shared.load(uid);
  },
  loadCover(uid, book) {
    if (!shared || !state.friends.some((friend) => friend.uid === uid && friend.inbound)) return Promise.resolve(null);
    return shared.loadCover(uid, book);
  }
};

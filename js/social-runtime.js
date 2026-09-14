import { startFirebaseSession, endFirebaseSession } from './firebase-session.js';
import { createSocialStore } from './social-store.js';
import { createSharedLibraryStore } from './shared-library.js';

export function socialError(error) {
  if (error?.code?.includes('permission-denied')) return 'Нет доступа к социальным данным. Проверьте настройки Firebase и повторите попытку.';
  if (error?.code?.includes('unavailable') || error?.code?.includes('network')) return 'Не удалось связаться с Firebase. Проверьте подключение и повторите попытку.';
  if (error?.code?.startsWith('auth/')) return 'Не удалось подтвердить Google-сеанс в Firebase. Повторите вход через Google.';
  return error?.message || 'Не удалось выполнить социальную операцию. Попробуйте ещё раз.';
}
const listeners = new Set();
let state = { status: 'idle', message: 'Социальная часть ещё не подключена.', friends: [], notifications: [] };
let store;
let stop;
let generation = 0;
let shared;
const catalogs = new Map();
const catalogWatches = new Map();
function clearCatalogs() {
  for (const stop of catalogWatches.values()) stop();
  catalogWatches.clear(); catalogs.clear();
}
function watchCatalogs(friends) {
  const watchGeneration = generation;
  const incoming = friends.filter((friend) => friend.inbound);
  const ids = new Set(incoming.map((friend) => friend.uid));
  for (const [id, stop] of catalogWatches) if (!ids.has(id)) { stop(); catalogWatches.delete(id); catalogs.delete(id); }
  const publish = () => emit({ libraries: state.friends.filter((friend) => friend.inbound && catalogs.get(friend.uid))
    .map((friend) => ({ uid: friend.uid, displayName: friend.displayName, revision: catalogs.get(friend.uid).revision })) });
  for (const friend of incoming) if (!catalogWatches.has(friend.uid)) {
    catalogWatches.set(friend.uid, shared.watchManifest(friend.uid, (value) => {
      if (generation !== watchGeneration || !state.friends.some((item) => item.uid === friend.uid && item.inbound)) return;
      catalogs.set(friend.uid, value); watchCatalogs(state.friends);
    }, () => { if (generation === watchGeneration) { catalogs.delete(friend.uid); publish(); } }));
  }
  publish();
}
const emit = (change) => { state = { ...state, ...change }; listeners.forEach((listener) => listener(state)); };
export const social = {
  subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
  async connect(token) {
    const current = ++generation;
    stop?.(); store?.dispose(); store = null;
    clearCatalogs(); shared?.dispose(); shared = null;
    emit({ status: 'loading', message: 'Подключение социальной части…', friends: [], notifications: [], libraries: [] });
    try {
      const session = await startFirebaseSession(token);
      if (!session || current !== generation) return;
      store = createSocialStore(session);
      shared = createSharedLibraryStore(session);
      await store.register();
      if (current !== generation) return;
      emit({ status: 'ready', message: '' });
      stop = store.subscribe((snapshot) => { if (current === generation) { emit(snapshot); watchCatalogs(snapshot.friends); } },
        (error) => { if (current === generation) emit({ status: 'error', message: socialError(error) }); });
    } catch (error) { if (current === generation) emit({ status: 'error', message: socialError(error) }); }
  },
  disconnect() {
    generation++; stop?.(); stop = null; store?.dispose(); store = null;
    clearCatalogs(); shared?.dispose(); shared = null;
    emit({ status: 'idle', message: 'Войдите через Google.', friends: [], notifications: [], libraries: [] });
    void endFirebaseSession().catch(() => {});
  },
  shareWithEmail(email) { if (!store || state.status !== 'ready') return Promise.reject(new Error(state.message)); return store.shareWithEmail(email); },
  setSharing(uid, active) { if (!store || state.status !== 'ready') return Promise.reject(new Error(state.message)); return store.setSharing(uid, active); },
  markSeen(items) { if (!store || state.status !== 'ready') return Promise.resolve(); return store.markSeen(items); },
  syncKnownContacts() { if (!store || state.status !== 'ready') return Promise.resolve(); return store.syncKnownContacts(); },
  publishLibrary(index, settings) { if (!shared || state.status !== 'ready') return Promise.resolve(); return shared.publish(index, settings); },
  get ready() { return state.status === 'ready'; },
  unpublishLibrary() { if (!shared || state.status !== 'ready') return Promise.reject(new Error('Для изменения доступа подключите социальную часть.')); return shared.unpublish(); },
  loadLibrary(uid, revision) {
    if (!shared || state.status !== 'ready' || !state.libraries?.some((library) => library.uid === uid)) return Promise.reject(new Error('Библиотека недоступна.'));
    return shared.load(uid, revision);
  },
};

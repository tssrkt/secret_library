import { startFirebaseSession, endFirebaseSession } from './firebase-session.js';
import { createSocialStore } from './social-store.js';

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
const emit = (change) => { state = { ...state, ...change }; listeners.forEach((listener) => listener(state)); };
export const social = {
  subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
  async connect(token) {
    const current = ++generation;
    stop?.(); store?.dispose(); store = null;
    emit({ status: 'loading', message: 'Подключение социальной части…', friends: [], notifications: [] });
    try {
      const session = await startFirebaseSession(token);
      if (!session || current !== generation) return;
      store = createSocialStore(session);
      await store.register();
      if (current !== generation) return;
      emit({ status: 'ready', message: '' });
      stop = store.subscribe((snapshot) => { if (current === generation) emit(snapshot); },
        (error) => { if (current === generation) emit({ status: 'error', message: socialError(error) }); });
    } catch (error) { if (current === generation) emit({ status: 'error', message: socialError(error) }); }
  },
  disconnect() {
    generation++; stop?.(); stop = null; store?.dispose(); store = null;
    emit({ status: 'idle', message: 'Войдите через Google.', friends: [], notifications: [] });
    void endFirebaseSession().catch(() => {});
  },
  shareWithEmail(email) { if (!store || state.status !== 'ready') return Promise.reject(new Error(state.message)); return store.shareWithEmail(email); },
  setSharing(uid, active) { if (!store || state.status !== 'ready') return Promise.reject(new Error(state.message)); return store.setSharing(uid, active); },
  markSeen(items) { if (!store || state.status !== 'ready') return Promise.resolve(); return store.markSeen(items); },
  syncKnownContacts() { if (!store || state.status !== 'ready') return Promise.resolve(); return store.syncKnownContacts(); },
};

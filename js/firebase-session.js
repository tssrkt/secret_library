import { FIREBASE_CONFIG, firebaseConfigured } from './firebase-config.js';

let modules;
let generation = 0;
let auth;
let queue = Promise.resolve();
export function startFirebaseSession(accessToken) {
  const current = ++generation;
  const operation = async () => {
    if (current !== generation) return null;
    if (!firebaseConfigured()) throw new Error('Социальные функции ещё не подключены: требуется Firebase Web config.');
    modules ||= Promise.all([
      import('https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js'),
    ]).catch((error) => { modules = null; throw error; });
    const [appSdk, authSdk, firestoreSdk] = await modules;
    if (current !== generation) return null;
    const app = appSdk.getApps().find((item) => item.name === 'social') || appSdk.initializeApp(FIREBASE_CONFIG, 'social');
    auth = authSdk.getAuth(app);
    await authSdk.setPersistence(auth, authSdk.inMemoryPersistence);
    if (current !== generation) return null;
    const result = await authSdk.signInWithCredential(auth, authSdk.GoogleAuthProvider.credential(null, accessToken));
    if (current !== generation) { await authSdk.signOut(auth); return null; }
    return { user: result.user, db: firestoreSdk.getFirestore(app), sdk: firestoreSdk };
  };
  queue = queue.catch(() => {}).then(operation);
  return queue;
}
export function endFirebaseSession() {
  generation++;
  queue = queue.catch(() => {}).then(async () => { if (auth && modules) await (await modules)[1].signOut(auth); });
  return queue;
}

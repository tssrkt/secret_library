// Public Firebase Web config. Fill these values from your Firebase project settings.
// No Google access tokens or server credentials belong here.
export const FIREBASE_CONFIG = Object.freeze({ apiKey: '', authDomain: '', projectId: '', appId: '' });
export const firebaseConfigured = () => ['apiKey', 'authDomain', 'projectId', 'appId'].every((key) => FIREBASE_CONFIG[key]);

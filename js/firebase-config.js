// Public Firebase Web config.
// No Google access tokens or server credentials belong here.

export const FIREBASE_CONFIG = Object.freeze({
  apiKey: 'AIzaSyDXTowpjzrl6_GfzQED9ITjb7mn9Qzs5J4',
  authDomain: 'project-071ee00e-4a4a-4a3d-95d.firebaseapp.com',
  projectId: 'project-071ee00e-4a4a-4a3d-95d',
  appId: '1:194069938786:web:69f8f1068be0d372d8473b'
});

export const firebaseConfigured = () =>
  ['apiKey', 'authDomain', 'projectId', 'appId'].every(
    (key) => FIREBASE_CONFIG[key]
  );
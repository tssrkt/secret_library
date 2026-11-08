const page = window.location.pathname.toLowerCase().endsWith('/privacy.html') ? 'privacy' : 'info';
// Preserve one-time invitation tokens (and other query parameters) when the
// standalone document redirects into the main app. Dropping ?invite=... makes
// first-time invitees look like uninvited Google accounts and blocks registration.
const destination = new URL('./index.html', window.location.href);
destination.search = window.location.search;
destination.hash = `document=${page}`;
window.location.replace(destination.href);

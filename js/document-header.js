const page = window.location.pathname.toLowerCase().endsWith('/privacy.html') ? 'privacy' : 'info';
// Document pages redirect to the app without invitation links or tokens.
window.location.replace(`./index.html#document=${page}`);

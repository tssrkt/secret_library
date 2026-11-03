const page = window.location.pathname.toLowerCase().endsWith('/privacy.html') ? 'privacy' : 'info';
window.location.replace(`./index.html#document=${page}`);

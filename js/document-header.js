import { setupDropdown } from './dropdown.js';

const host = document.querySelector('#shared-header');
if (host) {
  try {
    const response = await fetch('./index.html', { cache: 'no-cache' });
    if (!response.ok) throw new Error('Не удалось загрузить общую шапку.');
    const source = new DOMParser().parseFromString(await response.text(), 'text/html');
    const header = source.querySelector('.app-header');
    if (!header) throw new Error('Общая шапка не найдена.');
    header.classList.add('info-header');
    host.replaceChildren(document.importNode(header, true));

    header.querySelector('.info-header-links')?.remove();
    const signIn = header.querySelector('#sign-in-button');
    const search = header.querySelector('#book-search-button');
    const searchForm = header.querySelector('#quick-search-form');
    const searchInput = header.querySelector('#quick-search-input');
    const notificationsButton = header.querySelector('#notifications-button');
    const notificationControls = header.querySelector('#notification-controls');
    const avatarButton = header.querySelector('#avatar-button');
    const avatarMenu = header.querySelector('#avatar-menu');
    const userControls = header.querySelector('#user-controls');
    const home = (hash = '') => { window.location.href = `./index.html${hash}`; };

    signIn.addEventListener('click', () => home('#sign-in'));
    search.hidden = false;
    search.disabled = false;
    search.addEventListener('click', () => {
      searchForm.hidden = !searchForm.hidden;
      searchForm.inert = searchForm.hidden;
      header.classList.toggle('quick-search-open', !searchForm.hidden);
      if (!searchForm.hidden) searchInput.focus();
    });
    searchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const query = searchInput.value.trim();
      home(query ? `?q=${encodeURIComponent(query)}#search` : '#search');
    });
    header.querySelector('#advanced-search-button')?.addEventListener('click', () => home('#search'));
    notificationsButton.addEventListener('click', () => home('#notifications'));

    let session = null;
    let profile = null;
    try { session = JSON.parse(window.sessionStorage.getItem('secret-library-google-session') || 'null'); }
    catch { session = null; }
    try { profile = JSON.parse(window.localStorage.getItem('secret-library-persisted-profile') || 'null'); }
    catch { profile = null; }
    const user = session?.user || profile;
    const dropdown = setupDropdown(avatarButton, avatarMenu);
    // The account UI should reflect the persisted sign-in, even if the short-lived Drive token needs renewal.
    if (user && (user.emailAddress || user.displayName || user.photoLink)) {
      signIn.hidden = true;
      notificationControls.hidden = false;
      userControls.hidden = false;
      header.querySelector('#account-display-name').textContent = user.displayName || 'Пользователь Google';
      const email = header.querySelector('#account-email');
      email.textContent = user.emailAddress || '';
      email.hidden = !email.textContent;
      if (user.photoLink) {
        const image = header.querySelector('#avatar-image');
        image.onload = () => { image.hidden = false; header.querySelector('#avatar-placeholder').hidden = true; };
        image.onerror = () => { image.hidden = true; };
        image.src = user.photoLink;
      }
    } else {
      notificationControls.hidden = true;
      userControls.hidden = true;
      signIn.hidden = false;
    }

    for (const [id, hash] of [
      ['refresh-button', '#refresh'], ['change-root-folder-button', '#change-root'],
      ['metadata-button', '#metadata'], ['retry-metadata-button', '#retry'], ['settings-button', '#settings'],
      ['sign-out-button', '#sign-out'],
    ]) header.querySelector(`#${id}`)?.addEventListener('click', (event) => { event.preventDefault(); home(hash); });
    header.querySelector('.account-identity-link')?.addEventListener('click', (event) => { event.preventDefault(); home(); });
  } catch (error) {
    console.error('Не удалось загрузить шапку страницы:', error);
  }
}

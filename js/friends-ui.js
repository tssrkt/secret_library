import { createPaginator, paginateItems } from './pagination.js';
import { socialError } from './social-runtime.js';

export function mountFriends(page, social, retry) {
  const shareSection = document.createElement('section');
  shareSection.className = 'social-section';
  shareSection.innerHTML = '<h3>Поделиться библиотекой</h3><form class="social-share-form"><label>Gmail<input type="email" name="email" autocomplete="off" required aria-label="Gmail"></label><button class="settings-save-button" type="submit">ПОДЕЛИТЬСЯ</button></form><p role="status"></p><button class="settings-save-button" type="button" data-social-retry hidden>ПОВТОРИТЬ ПОДКЛЮЧЕНИЕ</button>';
  const friendsSection = document.createElement('section');
  friendsSection.className = 'social-section friends-section';
  friendsSection.innerHTML = '<h3>Друзья</h3><p class="friends-count" role="status"></p><div class="friends-table-container"></div>';
  page.append(shareSection, friendsSection);
  const form = shareSection.querySelector('form');
  const submit = form.querySelector('button');
  const message = shareSection.querySelector('[role=status]');
  const retryButton = shareSection.querySelector('[data-social-retry]');
  retryButton.addEventListener('click', retry);
  let snapshot = { friends: [], status: 'idle' };
  let pageNumber = 1;
  let sending = false;
  let closed = false;
  let synced = false;
  let serviceMessage = '';
  const busy = new Set();
  const render = () => {
    const paged = paginateItems(snapshot.friends, pageNumber, 50);
    pageNumber = paged.currentPage;
    friendsSection.querySelector('.friends-count').textContent = `Друзей: ${paged.totalItems}`;
    const container = friendsSection.querySelector('.friends-table-container');
    const table = document.createElement('table');
    table.className = 'friends-table';
    table.innerHTML = '<thead><tr><th scope="col">Пользователь</th><th scope="col">Делится с вами</th><th scope="col">Вы делитесь</th><th scope="col">Действие</th></tr></thead><tbody></tbody>';
    for (const friend of paged.items) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const text = document.createElement('span'); text.textContent = friend.displayName; name.append(text);
      if (friend.email) { const email = document.createElement('small'); email.textContent = friend.email; name.append(email); }
      row.append(name);
      for (const value of [friend.inbound, friend.outbound]) { const cell = document.createElement('td'); cell.textContent = value ? 'Да' : '—'; row.append(cell); }
      const action = document.createElement('td');
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'settings-save-button';
      button.textContent = friend.outbound ? 'ЗАКРЫТЬ ДОСТУП' : 'ПОДЕЛИТЬСЯ';
      button.disabled = busy.has(friend.uid) || snapshot.status !== 'ready';
      button.addEventListener('click', async () => {
        if (busy.has(friend.uid)) return;
        busy.add(friend.uid); button.disabled = true; message.textContent = '';
        try { await social.setSharing(friend.uid, !friend.outbound); }
        catch (error) { if (!closed) message.textContent = socialError(error); }
        finally { busy.delete(friend.uid); if (!closed) render(); }
      });
      action.append(button); row.append(action); table.querySelector('tbody').append(row);
    }
    const paginator = createPaginator({ ...paged, onPageChange: (next) => { pageNumber = next; render(); } });
    paginator?.setAttribute('aria-label', 'Страницы друзей');
    container.replaceChildren(table, ...(paginator ? [paginator] : []));
  };
  const unsubscribe = social.subscribe((next) => {
    snapshot = next;
    submit.disabled = sending || next.status !== 'ready';
    retryButton.hidden = next.status !== 'error';
    if (next.message || message.textContent === serviceMessage) message.textContent = next.message || '';
    serviceMessage = next.message || '';
    render();
    if (next.status === 'ready' && !synced) {
      synced = true;
      void social.syncKnownContacts().catch((error) => { synced = false; if (!closed) message.textContent = socialError(error); });
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending || snapshot.status !== 'ready') return;
    sending = true; submit.disabled = true; message.textContent = '';
    try { const result = await social.shareWithEmail(form.elements.email.value); if (!closed) message.textContent = result; }
    catch (error) { if (!closed) message.textContent = socialError(error); }
    finally { sending = false; if (!closed) submit.disabled = snapshot.status !== 'ready'; }
  });
  return () => { closed = true; unsubscribe(); };
}

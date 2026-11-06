export function createNotificationsController({ button, panel, avatarButton, closeAvatar, social }) {
  if (!button || !panel) return { close() {}, destroy() {} };
  const events = new AbortController();
  const listen = (element, type, callback) => element?.addEventListener(type, callback, { signal: events.signal });
  const badge = button.querySelector('[data-notification-badge]');
  let snapshot = { notifications: [] };
  const busy = new Set();
  let reading = false;
  const close = (restore = false) => { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); if (restore) button.focus(); };
  const message = document.createElement('p'); message.setAttribute('role', 'status');
  const render = () => {
    const count = snapshot.notifications.filter((item) => item.unread).length;
    badge.hidden = count === 0; badge.textContent = count > 99 ? '99+' : String(count);
    button.setAttribute('aria-label', count ? `Уведомления, непрочитанных: ${count}` : 'Уведомления');
    const heading = document.createElement('h3'); heading.textContent = 'Уведомления';
    const list = document.createElement('ul');
    for (const item of snapshot.notifications.slice(0, 50)) {
      const row = document.createElement('li');
      const text = document.createElement('p'); text.textContent = `${item.displayName} поделился с вами своей библиотекой`; row.append(text);
      if (item.mutual) { const mutual = document.createElement('small'); mutual.textContent = 'Вы уже делитесь'; row.append(mutual); }
      else {
        const action = document.createElement('button'); action.type = 'button'; action.className = 'settings-save-button notification-share-button';
        action.textContent = 'ПОДЕЛИТЬСЯ В ОТВЕТ'; action.disabled = busy.has(item.ownerUid) || !item.email;
        action.title = item.email ? '' : 'Google Drive не предоставил email владельца библиотеки';
        action.addEventListener('click', async () => {
          if (busy.has(item.ownerUid) || !item.email) return;
          busy.add(item.ownerUid); action.disabled = true; message.textContent = '';
          try { await social.shareWithEmail(item.email); }
          catch (error) { message.textContent = error?.message || 'Не удалось предоставить доступ к библиотеке.'; }
          finally { busy.delete(item.ownerUid); render(); }
        }); row.append(action);
      }
      list.append(row);
    }
    if (!list.children.length) { const empty = document.createElement('li'); empty.textContent = 'Уведомлений пока нет.'; list.append(empty); }
    panel.replaceChildren(heading, list, message);
  };
  const mark = async () => {
    if (reading || panel.hidden) return;
    const displayed = snapshot.notifications.slice(0, 50);
    if (!displayed.some((item) => item.unread)) return;
    reading = true;
    try { await social.markSeen(displayed); message.textContent = ''; }
    catch (error) { message.textContent = error?.message || 'Не удалось отметить уведомления прочитанными.'; }
    finally { reading = false; }
  };
  const unsubscribe = social.subscribe((next) => {
    snapshot = { notifications: Array.isArray(next.notifications) ? next.notifications : [] };
    render();
  });
  listen(button, 'click', () => {
    if (!panel.hidden) { close(); return; }
    closeAvatar(); panel.hidden = false; button.setAttribute('aria-expanded', 'true'); void mark();
  });
  listen(avatarButton, 'click', () => close());
  listen(avatarButton, 'keydown', (event) => { if (event.key === 'ArrowDown') close(); });
  listen(document, 'keydown', (event) => { if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); close(true); } });
  listen(document, 'click', (event) => { if (!button.contains(event.target) && !panel.contains(event.target)) close(); });
  return { close, destroy() { close(); events.abort(); unsubscribe(); } };
}

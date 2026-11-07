import { createPaginator, paginateItems } from './pagination.js';
import { socialError } from './social-runtime.js?v=20261107-invitation-flow';

const HOUR_MS = 60 * 60 * 1000;

function timestampMillis(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value) || 0;
  return 0;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes} мин ${remainder} сек` : `${remainder} сек`;
}

function formatDate(value) {
  const time = timestampMillis(value);
  return time ? new Date(time).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}

function invitationWasSent(result) {
  return typeof result === 'string' && result.startsWith('Приглашение отправлено');
}

export function mountFriends(page, social, retry, openLibrary = (uid) => { window.location.href = `?library=${encodeURIComponent(uid)}`; }) {
  const shareSection = document.createElement('section');
  shareSection.className = 'social-section';
  shareSection.innerHTML = '<h3>Пригласить участника</h3><form class="social-share-form"><label><input type="email" name="email" autocomplete="off" required aria-label="Gmail" placeholder="Gmail нового участника"></label><button class="settings-save-button" type="submit">ПОДЕЛИТЬСЯ</button></form><p role="status"></p><button class="settings-save-button" type="button" data-social-retry hidden>ПОВТОРИТЬ ПОДКЛЮЧЕНИЕ</button>';
  const friendsSection = document.createElement('section');
  friendsSection.className = 'social-section friends-section';
  friendsSection.innerHTML = '<h3>Друзья</h3><p class="friends-count" role="status"></p><div class="friends-table-container"></div>';
  const invitationsSection = document.createElement('section');
  invitationsSection.className = 'social-section sent-invitations-section';
  invitationsSection.innerHTML = '<h3>Отправленные приглашения</h3><p>Если друг не видит приглашения, пусть проверит папку «Спам».</p><p class="sent-invitations-message" role="status"></p><div class="sent-invitations-table-container"></div>';
  page.append(shareSection, friendsSection, invitationsSection);
  const form = shareSection.querySelector('form');
  const submit = form.querySelector('button');
  const message = shareSection.querySelector('[role=status]');
  const retryButton = shareSection.querySelector('[data-social-retry]');
  const invitationsMessage = invitationsSection.querySelector('.sent-invitations-message');
  retryButton.addEventListener('click', retry);
  let snapshot = { friends: [], invitations: [], status: 'idle' };
  let pageNumber = 1;
  let sending = false;
  let closed = false;
  const updateShareButton = () => {
    submit.disabled = sending || !form.elements.email.value.trim() || !form.elements.email.validity.valid;
  };
  form.elements.email.addEventListener('input', updateShareButton);
  updateShareButton();
  let invitationStatusSignature = null;
  let statusRefreshRevision = 0;
  let invitationStatuses = {};
  // Keep a just-sent invitation visible while Firestore's live query catches up.
  const optimisticInvitations = new Map();
  let serviceMessage = '';
  const busy = new Set();
  let cooldownButtons = [];
  const updateCooldowns = () => {
    const now = Date.now();
    for (const item of cooldownButtons) {
      const remaining = Math.max(0, item.sentAt + HOUR_MS - now);
      const cooling = remaining > 0;
      item.button.disabled = cooling || busy.has(item.email) || snapshot.status !== 'ready';
      item.wrapper.title = cooling ? `Повторная отправка будет возможна через ${formatDuration(remaining)}` : '';
      item.wrapper.setAttribute('aria-label', item.wrapper.title || 'Пригласить ещё раз');
    }
  };
  const renderInvitations = () => {
    const container = invitationsSection.querySelector('.sent-invitations-table-container');
    const table = document.createElement('table');
    table.className = 'sent-invitations-table';
    table.innerHTML = '<thead><tr><th scope="col">Пользователь</th><th scope="col">Дата отправки</th><th scope="col">Действие</th></tr></thead><tbody></tbody>';
    cooldownButtons = [];
    const lastSentTime = (invite) => {
      const email = String(invite.inviteeEmail || '').trim().toLowerCase();
      return invitationStatuses[email] ? Number(invitationStatuses[email].lastSentAt) || 0 : timestampMillis(invite.emailSentAt || invite.createdAt);
    };
    const invitations = [...(snapshot.invitations || [])].sort((a, b) => lastSentTime(b) - lastSentTime(a));
    for (const invite of invitations) {
      const email = String(invite.inviteeEmail || '').trim().toLowerCase();
      if (!email) continue;
      const row = document.createElement('tr');
      const user = document.createElement('td');
      user.textContent = email;
      user.className = 'sent-invitation-user';
      const status = invitationStatuses[email];
      const sentAt = status ? Number(status.lastSentAt) || 0 : timestampMillis(invite.emailSentAt || invite.createdAt);
      const sentDate = document.createElement('td');
      sentDate.textContent = sentAt ? formatDate(sentAt) : 'Ещё не отправлено';
      const action = document.createElement('td');
      const wrapper = document.createElement('span');
      wrapper.className = 'invitation-resend-tooltip';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-save-button';
      button.textContent = 'ПРИГЛАСИТЬ ЕЩЁ РАЗ';
      button.addEventListener('click', async () => {
        if (busy.has(email) || snapshot.status !== 'ready') return;
        const currentStatus = invitationStatuses[email];
        const sentAt = currentStatus ? Number(currentStatus.lastSentAt) || 0 : timestampMillis(invite.emailSentAt || invite.createdAt);
        if (sentAt && Date.now() < sentAt + HOUR_MS) return;
        if (typeof social.resendInvitation !== 'function') {
          invitationsMessage.textContent = 'Повторная отправка пока недоступна. Обновите страницу и попробуйте снова.';
          return;
        }
        busy.add(email);
        updateCooldowns();
        invitationsMessage.textContent = '';
        try {
          const result = await social.resendInvitation(email);
          invitationsMessage.textContent = '';
          if (invitationWasSent(result)) await refreshInvitationStatuses();
          else message.textContent = result;
        } catch (error) {
          invitationsMessage.textContent = socialError(error);
        } finally {
          busy.delete(email);
          updateCooldowns();
        }
      });
      wrapper.append(button);
      action.append(wrapper);
      row.append(user, sentDate, action);
      table.querySelector('tbody').append(row);
      cooldownButtons.push({ email, sentAt, button, wrapper });
    }
    if (!table.querySelector('tbody').children.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 3;
      cell.textContent = 'Отправленных приглашений, ожидающих регистрации, нет.';
      row.append(cell);
      table.querySelector('tbody').append(row);
    }
    container.replaceChildren(table);
    updateCooldowns();
  };
  async function refreshInvitationStatuses(extraEmails = []) {
    if (typeof social.getInvitationStatuses !== 'function') return;
    const revision = ++statusRefreshRevision;
    const emails = [...new Set([...(snapshot.invitations || []).map((invite) => String(invite.inviteeEmail || '').trim().toLowerCase()), ...extraEmails.map((email) => String(email || '').trim().toLowerCase())].filter(Boolean))];
    if (!emails.length) { invitationStatuses = {}; renderInvitations(); return; }
    try {
      const next = {};
      for (let offset = 0; offset < emails.length; offset += 100) {
        Object.assign(next, await social.getInvitationStatuses(emails.slice(offset, offset + 100)));
      }
      if (closed || revision !== statusRefreshRevision) return;
      invitationStatuses = next;
      renderInvitations();
    } catch (error) {
      if (!closed && revision === statusRefreshRevision) {
        invitationsMessage.textContent = socialError(error);
        renderInvitations();
      }
    }
  }
  const render = () => {
    const paged = paginateItems(snapshot.friends, pageNumber, 50);
    pageNumber = paged.currentPage;
    const count = paged.totalItems;
    const remainder100 = count % 100;
    const remainder10 = count % 10;
    const noun = remainder100 >= 11 && remainder100 <= 14 ? 'друзей'
      : remainder10 === 1 ? 'друг'
        : remainder10 >= 2 && remainder10 <= 4 ? 'друга' : 'друзей';
    const countLabel = friendsSection.querySelector('.friends-count');
    if (snapshot.driveDiscoveryStatus === 'loading' && count === 0) countLabel.textContent = 'Список друзей загружается…';
    else if (snapshot.driveDiscoveryStatus === 'error' && count === 0) countLabel.textContent = 'Не удалось загрузить список друзей. Проверьте подключение к Google Drive и попробуйте снова.';
    else if (snapshot.driveDiscoveryStatus === 'ready' && count === 0) countLabel.textContent = 'Друзей пока нет.';
    else countLabel.textContent = `У вас ${count.toLocaleString('ru-RU')} ${noun}.`;
    const container = friendsSection.querySelector('.friends-table-container');
    const table = document.createElement('table');
    table.className = 'friends-table';
    table.innerHTML = '<thead><tr><th scope="col">Пользователь</th><th scope="col">Делится с вами</th><th scope="col">Вы делитесь</th></tr></thead><tbody></tbody>';
    for (const friend of paged.items) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const openButton = document.createElement('button');
      openButton.type = 'button'; openButton.className = 'friend-library-button';
      openButton.textContent = friend.displayName;
      if (friend.isAdmin || friend.email) { const detail = document.createElement('small'); detail.textContent = friend.isAdmin ? 'Администратор' : friend.email; openButton.append(detail); }
      openButton.disabled = !friend.inbound || String(friend.uid).startsWith('email:');
      openButton.title = openButton.disabled ? 'Эта библиотека не открыта вам в Google Drive' : 'Открыть библиотеку друга';
      openButton.addEventListener('click', () => { if (!openButton.disabled) openLibrary(friend.uid); });
      name.append(openButton);
      row.append(name);
      for (const value of [friend.inbound, friend.outbound]) {
        const cell = document.createElement('td');
        const mark = document.createElement('span');
        mark.className = value ? 'friend-status-mark is-yes' : 'friend-status-mark is-no';
        mark.textContent = value ? '✓' : '✕';
        mark.setAttribute('role', 'img');
        mark.setAttribute('aria-label', value ? 'Да' : 'Нет');
        cell.append(mark); row.append(cell);
      }
      table.querySelector('tbody').append(row);
    }
    if (!paged.items.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 3;
      cell.textContent = snapshot.driveDiscoveryStatus === 'loading' ? 'Список друзей загружается…'
        : snapshot.driveDiscoveryStatus === 'error' ? 'Не удалось загрузить список друзей.' : 'Друзей пока нет.';
      row.append(cell);
      table.querySelector('tbody').append(row);
    }
    const paginator = createPaginator({ ...paged, onPageChange: (next) => { pageNumber = next; render(); } });
    paginator?.setAttribute('aria-label', 'Страницы друзей');
    container.replaceChildren(table, ...(paginator ? [paginator] : []));
    renderInvitations();
  };
  const unsubscribe = social.subscribe((next) => {
    const actualInvitations = next.invitations || [];
    const actualEmails = new Set(actualInvitations.map((invite) => String(invite.inviteeEmail || '').trim().toLowerCase()));
    const friendEmails = new Set((next.friends || []).map((friend) => String(friend.email || '').trim().toLowerCase()).filter(Boolean));
    for (const email of optimisticInvitations.keys()) {
      if (actualEmails.has(email) || friendEmails.has(email)) optimisticInvitations.delete(email);
    }
    const mergedInvitations = [...actualInvitations];
    for (const [email, invite] of optimisticInvitations) {
      if (!actualEmails.has(email) && !friendEmails.has(email)) mergedInvitations.push(invite);
    }
    snapshot = { ...next, invitations: mergedInvitations };
    const inviteSignature = (snapshot.invitations || []).map((invite) => String(invite.inviteeEmail || '').toLowerCase()).sort().join('|');
    if (inviteSignature !== invitationStatusSignature) {
      invitationStatusSignature = inviteSignature;
      void refreshInvitationStatuses();
    }
    updateShareButton();
    retryButton.hidden = next.status !== 'error';
    if (next.message || message.textContent === serviceMessage) message.textContent = next.message || '';
    serviceMessage = next.message || '';
    render();
    // Friend discovery comes from Google Drive permissions; no Firestore contact sync is needed.
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending || !form.elements.email.value.trim() || !form.elements.email.validity.valid) return;
    sending = true; updateShareButton(); message.textContent = '';
    try {
      const email = form.elements.email.value;
      const result = await social.shareWithEmail(email);
      if (!closed) {
        message.textContent = result;
        if (invitationWasSent(result)) {
          const normalizedEmail = String(email || '').trim().toLowerCase();
          if (normalizedEmail && !snapshot.invitations.some((invite) => String(invite.inviteeEmail || '').trim().toLowerCase() === normalizedEmail)) {
            optimisticInvitations.set(normalizedEmail, {
              inviteeEmail: normalizedEmail,
              ownerUid: social.uid || '',
              active: true,
              createdAt: Date.now(),
              emailSentAt: Date.now(),
            });
            snapshot = { ...snapshot, invitations: [...(snapshot.invitations || []), optimisticInvitations.get(normalizedEmail)] };
            invitationStatusSignature = (snapshot.invitations || []).map((invite) => String(invite.inviteeEmail || '').toLowerCase()).sort().join('|');
            render();
          }
          form.reset();
          void refreshInvitationStatuses([email]);
        }
      }
    }
    catch (error) { if (!closed) message.textContent = socialError(error); }
    finally { sending = false; if (!closed) updateShareButton(); }
  });
  const timer = setInterval(updateCooldowns, 1000);
  return () => { closed = true; clearInterval(timer); unsubscribe(); };
}

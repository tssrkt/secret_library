import { createPaginator, paginateItems } from './pagination.js';
import { socialError } from './social-runtime.js?v=20261108-library-relations-friends';

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
  shareSection.innerHTML = '<h3>Пригласить участника</h3><form class="social-share-form"><label><input type="email" name="email" autocomplete="off" required aria-label="Gmail" placeholder="Gmail нового участника"></label><p class="invitation-send-status" role="status" aria-live="polite"></p><button class="settings-save-button" type="submit">ПОДЕЛИТЬСЯ</button></form><button class="settings-save-button" type="button" data-social-retry hidden>ПОВТОРИТЬ ПОДКЛЮЧЕНИЕ</button>';
  const friendsSection = document.createElement('section');
  friendsSection.className = 'social-section friends-section';
  friendsSection.innerHTML = '<h3>Друзья</h3><p class="friends-count" role="status"></p><p class="friends-access-message" role="status"></p><div class="friends-table-container"></div>';
  const invitationsSection = document.createElement('section');
  invitationsSection.className = 'social-section sent-invitations-section';
  invitationsSection.hidden = true;
  invitationsSection.innerHTML = '<h3>Отправленные приглашения</h3><p>Если друг не видит приглашения, пусть проверит папку «Спам».</p><div class="sent-invitations-table-container"></div><p class="sent-invitations-message" role="status" aria-live="polite"></p>';
  page.append(shareSection, friendsSection, invitationsSection);
  const form = shareSection.querySelector('form');
  const submit = form.querySelector('button');
  const message = shareSection.querySelector('[role=status]');
  const setInvitationMessage = (value) => {
    const cooldownResponse = 'Запрос обработан. Если получателю нужно приглашение, письмо отправлено.';
    if (value === cooldownResponse) {
      const supportLink = document.createElement('a');
      supportLink.href = 'https://t.me/ptica_govorun_bot';
      supportLink.target = '_blank';
      supportLink.rel = 'noopener noreferrer';
      supportLink.textContent = 'техподдержку';
      const prefix = 'Вы не можете отправлять приглашение одному и тому же человеку чаще чем раз в час. Если ваш друг не получил приглашение, пусть проверит папку «Спам». Если и там нет письма, обратитесь в ';
      message.replaceChildren(document.createTextNode(prefix), supportLink);
      return;
    }
    const displayValue = typeof value === 'string' && value.startsWith('Приглашение отправлено')
      ? value.replace(/\s*\(\d+\s+из\s+\d+\)/, '')
      : value;
    message.textContent = displayValue || '';
  };
  const retryButton = shareSection.querySelector('[data-social-retry]');
  const invitationsMessage = invitationsSection.querySelector('.sent-invitations-message');
  const friendsAccessMessage = friendsSection.querySelector('.friends-access-message');
  const closingAccess = new Set();
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
  let invitationStatusesLoaded = false;
  let invitationQuota = null;
  let quotaMetadataRetryUsed = false;
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
    cooldownButtons = [];
    // Invitation rows in the Drive ledger are only a provisional snapshot. Do not
    // display them until the server-owned registry confirms their current status.
    if (!invitationStatusesLoaded) {
      invitationsSection.hidden = true;
      container.replaceChildren();
      return;
    }
    // Anyone who already shares a library with this user is an existing participant,
    // including the original inviter. Their email can be absent from the friend row
    // while it is still available on the Drive notification, so check both sources.
    const friendEmails = new Set([
      ...(snapshot.friends || []).map((friend) => friend.email),
      ...(snapshot.notifications || []).map((notification) => notification.email),
    ].map((email) => String(email || '').trim().toLowerCase()).filter(Boolean));
    const lastSentTime = (invite) => {
      const email = String(invite.inviteeEmail || '').trim().toLowerCase();
      return invitationStatuses[email] ? Number(invitationStatuses[email].lastSentAt) || 0 : timestampMillis(invite.emailSentAt || invite.createdAt);
    };
    const invitations = [...(snapshot.invitations || [])]
      .filter((invite) => {
        const email = String(invite.inviteeEmail || '').trim().toLowerCase();
        const status = invitationStatuses[email]?.invitationStatus;
        // A person whose library is already connected is an existing participant,
        // not a pending invitee. Hide any stale invitation row created by the old
        // reciprocal-sharing flow.
        // The server registry also checks userDirectory. An already-registered
        // participant is a friend, never a pending invitation—even if an old
        // reciprocal-sharing bug left a stale invitation record behind.
        return Boolean(email) && !friendEmails.has(email) && !invitationStatuses[email]?.registered && status !== 'revoked' && status !== 'accepted';
      })
      .sort((a, b) => lastSentTime(b) - lastSentTime(a));
    if (!invitations.length) {
      invitationsSection.hidden = true;
      container.replaceChildren();
      return;
    }
    invitationsSection.hidden = false;
    const table = document.createElement('table');
    table.className = 'sent-invitations-table';
    table.innerHTML = '<thead><tr><th scope="col">Пользователь</th><th scope="col">Дата отправки</th><th scope="col">Действие</th></tr></thead><tbody></tbody>';
    for (const invite of invitations) {
      const email = String(invite.inviteeEmail || '').trim().toLowerCase();
      const invitationState = invitationStatuses[email]?.invitationStatus;
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
          message.textContent = 'Повторная отправка пока недоступна. Обновите страницу и попробуйте снова.';
          return;
        }
        busy.add(email);
        updateCooldowns();
        invitationsMessage.textContent = '';
        try {
          const result = await social.resendInvitation(email);
          invitationsMessage.textContent = '';
          if (invitationWasSent(result)) await refreshInvitationStatuses();
          else setInvitationMessage(result);
        } catch (error) {
          message.textContent = socialError(error);
        } finally {
          busy.delete(email);
          updateCooldowns();
        }
      });
      wrapper.append(button);
      action.append(wrapper);
      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'settings-save-button';
      cancelButton.textContent = 'ОТМЕНИТЬ';
      cancelButton.hidden = invitationState !== 'pending';
      cancelButton.addEventListener('click', async () => {
        if (busy.has(email) || snapshot.status !== 'ready') return;
        if (typeof social.cancelInvitation !== 'function') {
          setInvitationMessage('Отмена приглашения пока недоступна. Обновите страницу и попробуйте снова.');
          return;
        }
        if (!window.confirm(`Отменить приглашение для ${email}? Ссылка регистрации перестанет работать, а доступ к вашей корневой папке будет закрыт.`)) return;
        busy.add(email);
        cancelButton.disabled = true;
        button.disabled = true;
        invitationsMessage.textContent = `Отменяем приглашение для ${email}...`;
        try {
          await social.cancelInvitation(email);
          invitationsMessage.textContent = `Приглашение для ${email} отменено.`;
          await refreshInvitationStatuses([email]);
        } catch (error) {
          invitationsMessage.textContent = socialError(error);
          // Cancellation feedback belongs below the sent-invitations table, not under the email input.
          // Keep the row available for a retry if Drive permission cleanup needs another attempt.
        } finally {
          busy.delete(email);
          updateCooldowns();
          cancelButton.disabled = false;
        }
      });
      action.append(cancelButton);
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
    try {
      // Check every address currently shown in the local/Drive invitation ledger.
      // The server also returns quota metadata for non-empty lists, and must resolve
      // registered users even when an old ledger row has no server invitation record.
      const emails = [...new Set([
        ...(snapshot.invitations || []).map((invite) => String(invite.inviteeEmail || '').trim().toLowerCase()),
        ...extraEmails.map((email) => String(email || '').trim().toLowerCase()),
      ].filter(Boolean))];
      const next = await social.getInvitationStatuses(emails);
      if (closed || revision !== statusRefreshRevision) return;
      invitationStatuses = next;
      invitationStatusesLoaded = true;
      invitationQuota = next.__quota || invitationQuota;
      // Reconcile the invitation ledger against the authoritative directory before
      // rendering either table. The runtime normally adds registered users to friends;
      // this UI-level reconciliation also prevents a registered account from vanishing
      // between the two tables if Drive friend discovery is still catching up.
      const friends = [...(snapshot.friends || [])];
      for (const [rawEmail, status] of Object.entries(next)) {
        if (rawEmail === '__quota' || status?.registered !== true || !status.registeredUid) continue;
        const email = String(rawEmail).trim().toLowerCase();
        if (!email) continue;
        const existing = friends.find((friend) =>
          String(friend.email || '').trim().toLowerCase() === email
          || String(friend.uid || '') === String(status.registeredUid));
        if (existing) continue;
        const notification = (snapshot.notifications || []).find((item) =>
          String(item.email || '').trim().toLowerCase() === email);
        friends.push({
          uid: String(status.registeredUid),
          email,
          displayName: String(status.registeredDisplayName || notification?.displayName || email),
          inbound: false,
          outbound: false,
        });
      }
      snapshot = { ...snapshot, friends };
      render();
      if (!next.__quota && !invitationQuota && !quotaMetadataRetryUsed) {
        quotaMetadataRetryUsed = true;
        setTimeout(() => {
          if (!closed && !invitationQuota) void refreshInvitationStatuses();
        }, 1200);
      }
    } catch (error) {
      // Status refresh is secondary to sending. Keep service errors in the single
      // status line under the email field, never in the sent-invitations section.
      if (!closed && revision === statusRefreshRevision) {
        renderInvitations();
        if (!quotaMetadataRetryUsed) {
          quotaMetadataRetryUsed = true;
          setTimeout(() => {
            if (!closed && !invitationQuota) void refreshInvitationStatuses();
          }, 1200);
        }
      }
    }
  }
  const render = () => {
    const hasKnownFriends = Array.isArray(snapshot.friends) && snapshot.friends.length > 0;
    const discoveryPending = (snapshot.driveDiscoveryStatus === 'loading' || snapshot.driveDiscoveryStatus === 'idle') && !hasKnownFriends;
    const paged = paginateItems(discoveryPending ? [] : snapshot.friends, pageNumber, 50);
    pageNumber = paged.currentPage;
    const count = paged.totalItems;
    const plural = (value, one, few, many) => {
      const n = Math.abs(value) % 100;
      const last = n % 10;
      if (n >= 11 && n <= 14) return many;
      if (last === 1) return one;
      if (last >= 2 && last <= 4) return few;
      return many;
    };
    const countLabel = friendsSection.querySelector('.friends-count');
    if (discoveryPending && count === 0) countLabel.textContent = 'Список друзей загружается…';
    else if (snapshot.driveDiscoveryStatus === 'error' && count === 0) countLabel.textContent = 'Не удалось загрузить список друзей. Проверьте подключение к Google Drive и попробуйте снова.';
    else {
      const friendEmails = new Set([
        ...(snapshot.friends || []).map((friend) => friend.email),
        ...(snapshot.notifications || []).map((notification) => notification.email),
      ].map((email) => String(email || '').trim().toLowerCase()).filter(Boolean));
      // The local invitation ledger may contain already-accepted invitations.
      // Never include those provisional rows in the summary until the server's
      // authoritative invitation statuses have loaded.
      const pendingEmails = new Set((invitationStatusesLoaded ? snapshot.invitations || [] : [])
        .map((invite) => String(invite.inviteeEmail || '').trim().toLowerCase())
        .filter((email) => email && !friendEmails.has(email)
          && !invitationStatuses[email]?.registered
          && invitationStatuses[email]?.invitationStatus !== 'accepted'
          && invitationStatuses[email]?.invitationStatus !== 'revoked'));
      let summary = `У вас ${count.toLocaleString('ru-RU')} ${plural(count, 'друг', 'друга', 'друзей')}`;
      if (pendingEmails.size) {
        summary += `, и отправлено еще ${pendingEmails.size.toLocaleString('ru-RU')} ${plural(pendingEmails.size, 'приглашение', 'приглашения', 'приглашений')}`;
      }
      // Accepted friends do not consume invitation slots. Only outstanding
      // invitations count against the limit for regular participants.
      const currentUserIsAdmin = invitationQuota?.isAdmin === true;
      if (invitationQuota && !currentUserIsAdmin) {
        const limit = Number(invitationQuota.limit);
        if (Number.isFinite(limit)) {
          const remaining = Math.max(0, limit - pendingEmails.size);
          summary += `. Вы можете пригласить еще ${remaining.toLocaleString('ru-RU')} ${plural(remaining, 'друга', 'друзей', 'друзей')}`;
        }
      }
      countLabel.textContent = summary + '.';
    }
    const container = friendsSection.querySelector('.friends-table-container');
    const table = document.createElement('table');
    table.className = 'friends-table';
    table.innerHTML = '<thead><tr><th scope="col">Пользователь</th><th scope="col">Делится с вами</th><th scope="col">Вы делитесь</th><th scope="col">Действие</th></tr></thead><tbody></tbody>';
    for (const friend of paged.items) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      const openButton = document.createElement('button');
      openButton.type = 'button'; openButton.className = 'friend-library-button';
      openButton.textContent = friend.displayName;
      const knownAdminUids = Array.isArray(invitationQuota?.adminUids) ? invitationQuota.adminUids : [];
      const isAdmin = friend.isAdmin === true || friend.uid === 'aA89pCYsKNbWWePmAveUVrG34F82' || knownAdminUids.includes(friend.uid);
      // Never expose a possible administrator's email while the authoritative admin list is still loading.
      if (isAdmin) { const detail = document.createElement('small'); detail.textContent = 'Администратор'; openButton.append(detail); }
      else if (invitationQuota && friend.email) { const detail = document.createElement('small'); detail.textContent = friend.email; openButton.append(detail); }
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
      const actionCell = document.createElement('td');
      const actionButton = document.createElement('button');
      actionButton.type = 'button';
      actionButton.className = 'settings-save-button';
      const isSharingWithFriend = friend.outbound === true;
      actionButton.textContent = isSharingWithFriend ? 'ЗАКРЫТЬ ДОСТУП' : 'ПОДЕЛИТЬСЯ';
      const friendEmail = String(friend.email || '').trim().toLowerCase();
      actionButton.disabled = !friendEmail || closingAccess.has(friendEmail);
      actionButton.title = !friendEmail
        ? 'У друга не указан email'
        : isSharingWithFriend
          ? 'Отозвать доступ к корневой папке в Google Drive'
          : 'Открыть другу доступ к корневой папке вашей библиотеки';
      actionButton.addEventListener('click', async () => {
        const email = String(friend.email || '').trim().toLowerCase();
        if (!email || closingAccess.has(email)) return;
        closingAccess.add(email);
        friendsAccessMessage.textContent = '';
        actionButton.disabled = true;
        actionButton.textContent = isSharingWithFriend ? 'ЗАКРЫВАЕМ…' : 'ОТКРЫВАЕМ ДОСТУП…';
        try {
          if (isSharingWithFriend) {
            if (!window.confirm(`Закрыть для ${email} доступ к корневой папке вашей библиотеки в Google Drive?`)) return;
            const result = await social.closeFriendAccess(email);
            friendsAccessMessage.textContent = result.revoked
              ? `Доступ к корневой папке для ${email} закрыт в Google Drive.`
              : `У ${email} не найдено прямого разрешения на корневую папку.`;
          } else {
            const result = await social.shareBackWithEmail(email, friend.uid);
            friendsAccessMessage.textContent = typeof result === 'string' ? result : `Доступ к библиотеке предоставлен для ${email}.`;
          }
        } catch (error) {
          friendsAccessMessage.textContent = socialError(error);
        } finally {
          closingAccess.delete(email);
          render();
        }
      });
      actionCell.append(actionButton);
      row.append(actionCell);
      table.querySelector('tbody').append(row);
    }
    if (!paged.items.length && snapshot.driveDiscoveryStatus !== 'loading' && snapshot.driveDiscoveryStatus !== 'idle') {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 4;
      cell.textContent = snapshot.driveDiscoveryStatus === 'error' ? 'Не удалось загрузить список друзей.' : 'Друзей пока нет.';
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
    const friendEmails = new Set([
      ...(next.friends || []).map((friend) => friend.email),
      ...(next.notifications || []).map((notification) => notification.email),
    ].map((email) => String(email || '').trim().toLowerCase()).filter(Boolean));
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
      // A response for the previous invitation set cannot validate newly arrived ledger rows.
      // Keep the section hidden until the status request for this exact set completes.
      invitationStatusesLoaded = false;
      void refreshInvitationStatuses();
    }
    updateShareButton();
    retryButton.hidden = next.status !== 'error';
    if (next.message || message.textContent === serviceMessage) setInvitationMessage(next.message || '');
    serviceMessage = next.message || '';
    render();
    // Friend discovery comes from Google Drive permissions; no Firestore contact sync is needed.
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending || !form.elements.email.value.trim() || !form.elements.email.validity.valid) return;
    sending = true; updateShareButton(); setInvitationMessage('Отправляем приглашение…');
    submit.textContent = 'ОТПРАВЛЯЕМ…';
    try {
      const email = form.elements.email.value;
      const result = await social.shareWithEmail(email);
      if (!closed) {
        setInvitationMessage(result);
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
    finally { sending = false; submit.textContent = 'ПОДЕЛИТЬСЯ'; if (!closed) updateShareButton(); }
  });
  const timer = setInterval(updateCooldowns, 1000);
  return () => { closed = true; clearInterval(timer); unsubscribe(); };
}

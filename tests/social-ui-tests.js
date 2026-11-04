import { friendsModel, notificationsModel, validateShareEmail } from '../js/social-model.js';
import { mountFriends } from '../js/friends-ui.js';
import { createNotificationsController } from '../js/notifications-ui.js';
import { setupDropdown } from '../js/dropdown.js';

export async function runSocialUiTests(test, assert, equal) {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const stub = (initial) => {
    let state = { status: 'ready', message: '', friends: [], notifications: [], ...initial };
    const listeners = new Set(); const calls = [];
    return { calls, subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
      update(change) { state = { ...state, ...change }; listeners.forEach((fn) => fn(state)); },
      async syncKnownContacts() { calls.push('syncKnownContacts'); }, async shareWithEmail(email) { calls.push(email); return 'Доступ предоставлен.'; },
      async resendInvitation(email) { calls.push(['resendInvitation', email]); return 'Приглашение отправлено.'; },
      async getInvitationStatuses(emails) { return Object.fromEntries(emails.map((email) => [email, { lastSentAt: 0, cooldownUntil: 0 }])); },
      async setSharing(uid, active) { calls.push([uid, active]); },
      async markSeen(items) { calls.push(items); this.update({ notifications: state.notifications.map((item) => items.includes(item) ? { ...item, unread: false } : item) }); },
    };
  };
  await test('social models preserve direction, deduplicate friends and never use profile email', () => {
    const shares = [{ ownerUid: 'a', viewerUid: 'me', active: true, sharedAt: 1 },
      { ownerUid: 'me', viewerUid: 'a', active: true, sharedAt: 2 },
      { ownerUid: 'me', viewerUid: 'b', active: true }, { ownerUid: 'c', viewerUid: 'me', active: false }];
    const profiles = { a: { displayName: 'Same', email: 'private@gmail.com' }, b: { displayName: 'Same' }, c: { displayName: 'C' } };
    const friends = friendsModel('me', shares, profiles, { b: { email: 'known@gmail.com' } });
    equal(friends.map((item) => [item.uid, item.inbound, item.outbound, item.email]), [['a', true, true, ''], ['b', false, true, 'known@gmail.com']], 'direction, unique person and stable uid tiebreak');
    equal(validateShareEmail(' Ab.C+tag@Gmail.Com ', 'me@gmail.com'), 'ab.c+tag@gmail.com', 'trim lowercase only');
    equal(friendsModel('me', [{ ownerUid: 'owner', viewerUid: 'me', active: true, ownerEmail: 'owner@gmail.com' }], { owner: { displayName: 'Owner' } })[0].email, 'owner@gmail.com', 'incoming friend displays the email attached to their share');
    assert(notificationsModel('me', shares)[0].mutual, 'reciprocal share');
    assert(!notificationsModel('me', shares, { a: { seenSharedAt: 1 } })[0].unread, 'seen timestamp hides unread');
    assert(notificationsModel('me', [{ ...shares[0], sharedAt: 3 }], { a: { seenSharedAt: 1 } })[0].unread, 'regrant is unread');
  });
  await test('known contact sync repeats when an invited friend registers later', async () => {
    const page = document.createElement('div'); document.body.append(page);
    const social = stub({ friends: [] });
    const cleanup = mountFriends(page, social, () => {});
    try {
      await tick();
      assert(social.calls.filter((call) => call === 'syncKnownContacts').length === 1, 'initial contact sync runs');
      social.update({ friends: [{ uid: 'tara', displayName: 'Тара', email: '', inbound: false, outbound: true }] });
      await tick();
      assert(social.calls.filter((call) => call === 'syncKnownContacts').length === 2, 'new friend triggers another contact sync');
    } finally { cleanup(); page.remove(); }
  });
  await test('sent invitations show a one-hour resend cooldown and the calculated tooltip', async () => {
    const recentPage = document.createElement('div'); document.body.append(recentPage);
    const recentSentAt = Date.now() - 30 * 60 * 1000;
    const recentSocial = stub({ invitations: [{ inviteeEmail: 'friend@gmail.com', active: true, createdAt: recentSentAt }] });
    recentSocial.getInvitationStatuses = async (emails) => Object.fromEntries(emails.map((email) => [email, { lastSentAt: recentSentAt, cooldownUntil: recentSentAt + 60 * 60 * 1000 }]));
    const cleanupRecent = mountFriends(recentPage, recentSocial, () => {});
    try {
      await tick(); await tick();
      const section = recentPage.querySelector('.sent-invitations-section');
      assert(section.textContent.includes('Если друг не видит приглашения, пусть проверит папку «Спам».'), 'spam hint visible');
      const row = section.querySelector('tbody tr');
      assert(row.textContent.includes('friend@gmail.com'), 'pending email appears in its own table');
      assert(row.textContent.includes('ПРИГЛАСИТЬ ЕЩЁ РАЗ'), 'resend action label');
      assert(row.querySelector('button').disabled, 'resend disabled during cooldown');
      assert(row.querySelector('.invitation-resend-tooltip').title.startsWith('Повторная отправка будет возможна через '), 'calculated cooldown tooltip');
    } finally { cleanupRecent(); recentPage.remove(); }

    const oldPage = document.createElement('div'); document.body.append(oldPage);
    const oldSentAt = Date.now() - 60 * 60 * 1000 - 1000;
    const oldSocial = stub({ invitations: [{ inviteeEmail: 'friend@gmail.com', active: true, createdAt: oldSentAt }] });
    oldSocial.getInvitationStatuses = async (emails) => Object.fromEntries(emails.map((email) => [email, { lastSentAt: oldSentAt, cooldownUntil: 0 }]));
    const cleanupOld = mountFriends(oldPage, oldSocial, () => {});
    try {
      await tick(); await tick();
      const button = oldPage.querySelector('.sent-invitations-section tbody button');
      assert(!button.disabled, 'resend becomes active after one hour');
      button.click(); await tick();
      assert(oldSocial.calls.some((call) => Array.isArray(call) && call[0] === 'resendInvitation' && call[1] === 'friend@gmail.com'), 'click resends the same invitation');
    } finally { cleanupOld(); oldPage.remove(); }
  });
  await test('friends table labels administrators without displaying their email', () => {
    const page = document.createElement('div'); document.body.append(page);
    const cleanup = mountFriends(page, stub({ friends: [{ uid: 'admin', displayName: 'Library owner', isAdmin: true, email: '', inbound: true, outbound: false }] }), () => {});
    try {
      const row = page.querySelector('tbody tr');
      assert(row.textContent.includes('Администратор'), 'administrator label is visible');
      assert(!row.textContent.includes('@') && !row.textContent.includes('private-admin@gmail.com'), 'email is not rendered');
    } finally { cleanup(); page.remove(); }
  });
  await test('friends table slices before rendering and switches action based on direction', async () => {
    const page = document.createElement('div'); document.body.append(page);
    const friends = Array.from({ length: 51 }, (_, i) => ({ uid: String(i), displayName: `User ${i}`, email: i === 0 ? 'reader@gmail.com' : '', inbound: i !== 1, outbound: i !== 0 }));
    const social = stub({ friends });
    const openedLibraries = [];
    const cleanup = mountFriends(page, social, () => {}, (uid) => openedLibraries.push(uid));
    try {
      equal(page.querySelectorAll('.friends-table tbody tr').length, 50, 'only first 50 friend rows exist');
      assert(page.querySelector('.friends-count').textContent === 'У вас 51 друг', 'grammatical count');
      const rows = [...page.querySelectorAll('.friends-table tbody tr')];
      const profileButton = rows[0].querySelector('.friend-library-button');
      assert(profileButton && profileButton.textContent.includes('User 0') && profileButton.textContent.includes('reader@gmail.com'), 'friend name and email are one library button');
      profileButton.click(); equal(openedLibraries, ['0'], 'friend library button opens the selected user');
      equal([...rows[0].children].slice(1).map((cell, i) => i < 2 ? cell.querySelector('.friend-status-mark')?.getAttribute('aria-label') : cell.textContent), ['Да', 'Нет', 'ПОДЕЛИТЬСЯ'], 'inbound only');
      equal([...rows[1].children].slice(1).map((cell, i) => i < 2 ? cell.querySelector('.friend-status-mark')?.getAttribute('aria-label') : cell.textContent), ['Нет', 'Да', 'ЗАКРЫТЬ ДОСТУП'], 'outbound only');
      equal([...rows[2].children].slice(1).map((cell, i) => i < 2 ? cell.querySelector('.friend-status-mark')?.getAttribute('aria-label') : cell.textContent), ['Да', 'Да', 'ЗАКРЫТЬ ДОСТУП'], 'mutual');
      rows[0].querySelector('.settings-save-button').click(); await tick();
      assert(social.calls.some((call) => Array.isArray(call) && call[0] === '0' && call[1] === true), 'share action');
      page.querySelector('[aria-label="Страница 2"]').click(); equal(page.querySelectorAll('.friends-table tbody tr').length, 1, 'second page is a slice');
      social.update({ friends: friends.slice(0, 50) });
      assert(!page.querySelector('.book-pagination') && page.querySelectorAll('.friends-table tbody tr').length === 50, '50 friends no paginator, page clamps');
      const form = page.querySelector('form'); form.elements.email.value = 'known@gmail.com'; form.requestSubmit(); await tick();
      assert(page.querySelector('[role=status]').textContent === 'Доступ предоставлен.', 'success not email sent');
      social.shareWithEmail = async () => { throw new Error('Connection failed'); };
      form.requestSubmit(); await tick();
      assert(form.elements.email.value === 'known@gmail.com' && !form.querySelector('button').disabled, 'network error keeps draft and enables retry');
      assert(page.querySelector('[role=status]').textContent === 'Connection failed', 'failure visible');
      const shareButton = page.querySelector('.social-share-form .settings-save-button');
      const revokeButton = page.querySelector('.friends-table .settings-save-button');
      equal(getComputedStyle(revokeButton).paddingLeft, getComputedStyle(shareButton).paddingLeft, 'close access left padding matches share');
      equal(getComputedStyle(revokeButton).paddingRight, getComputedStyle(shareButton).paddingRight, 'close access right padding matches share');
      for (const [count, expected] of [[21, 'У вас 21 друг'], [22, 'У вас 22 друга'], [11, 'У вас 11 друзей'], [5, 'У вас 5 друзей'], [1, 'У вас 1 друг'], [0, 'У вас 0 друзей']]) {
        social.update({ friends: friends.slice(0, count) });
        equal(page.querySelector('.friends-count').textContent, expected, `Russian friend count for ${count}`);
      }
      equal(page.querySelectorAll('.friends-table tbody tr').length, 0, 'no active relationship removes row');
    } finally { cleanup(); page.remove(); }
  });
  await test('settings controls use download accent, equal form heights and accessible Gmail placeholder', () => {
    const page = document.createElement('div'); page.style.width = '650px'; document.body.append(page);
    const cleanup = mountFriends(page, stub({}), () => {});
    try {
      const form = page.querySelector('form'); const input = form.elements.email; const button = form.querySelector('button');
      equal(input.placeholder, 'Gmail вашего друга', 'placeholder');
      assert(input.getAttribute('aria-label') && !form.querySelector('label').textContent.trim(), 'accessible name without visible label');
      assert(!input.checkValidity(), 'empty value still required');
      input.value = 'invalid'; assert(!input.checkValidity(), 'invalid email rejected');
      input.value = 'friend@gmail.com'; assert(input.checkValidity(), 'email accepted');
      const field = input.getBoundingClientRect(); const action = button.getBoundingClientRect();
      equal([action.top, action.height], [field.top, field.height], 'same top and height from flex stretch');
      equal(field.width, 280, 'input width preserved');
      const retry = page.querySelector('[data-social-retry]'); retry.hidden = false;
      const style = getComputedStyle(retry);
      assert(parseFloat(style.paddingLeft) >= 16 && style.paddingLeft === style.paddingRight, 'standard equal horizontal padding');
      equal(retry.getBoundingClientRect().height, 34, 'retry height unchanged');
      const list = document.createElement('div'); list.className = 'sharing-folder-list';
      list.innerHTML = '<input type="checkbox" checked><button class="book-download-button">СКАЧАТЬ</button>'; page.append(list);
      const checkbox = list.querySelector('input');
      equal(getComputedStyle(checkbox).accentColor, getComputedStyle(list.querySelector('button')).backgroundColor, 'same download accent');
      checkbox.focus(); assert(parseFloat(getComputedStyle(checkbox).outlineWidth) > 0, 'keyboard focus retained');
    } finally { cleanup(); page.remove(); }
  });
  await test('notification badge, read marking, reciprocal action and dropdown coordination', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<button id="test-bell"><span data-notification-badge hidden></span></button><div id="test-notifications" hidden></div><button id="test-avatar"></button><div id="test-menu" hidden></div>';
    document.body.append(root);
    const [button, panel, avatarButton, menu] = root.children;
    const dropdown = setupDropdown(avatarButton, menu);
    const social = stub({ notifications: Array.from({ length: 51 }, (_, i) => ({ ownerUid: String(i), displayName: `User ${i}`, sharedAt: 51 - i, unread: true, mutual: i === 1 })) });
    const controller = createNotificationsController({ button, panel, avatarButton, closeAvatar: () => dropdown.close(), social, retry: () => {} });
    try {
      equal(button.querySelector('span').textContent, '51', 'badge count');
      avatarButton.click(); assert(!menu.hidden, 'avatar open');
      button.click(); await tick();
      assert(menu.hidden && !panel.hidden, 'one dropdown at a time');
      equal(social.calls[0].length, 50, 'only displayed latest 50 marked');
      equal(button.querySelector('span').textContent, '1', 'remaining unloaded event stays unread');
      equal(panel.querySelectorAll('li').length, 50, 'dropdown limited to 50');
      const action = panel.querySelector('li button'); equal(action.textContent, 'ПОДЕЛИТЬСЯ В ОТВЕТ', 'exact reciprocal text');
      action.click(); await tick(); equal(social.calls[1], ['0', true], 'reverse direction created');
      assert(panel.querySelectorAll('li')[1].textContent.includes('Вы уже делитесь') && !panel.querySelectorAll('li')[1].querySelector('button'), 'mutual state is text');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert(panel.hidden && document.activeElement === button, 'Escape closes and restores button focus');
      button.click(); avatarButton.click(); assert(panel.hidden && !menu.hidden, 'avatar closes notifications');
      button.click(); document.body.click(); assert(panel.hidden, 'outside click closes');
      social.update({ notifications: [] }); assert(button.querySelector('span').hidden, 'zero badge hidden');
    } finally { controller.destroy(); root.remove(); }
  });
  await test('bell, badge and notification dropdown fit mobile and desktop without moving search', async () => {
    const markup = new DOMParser().parseFromString(await (await fetch('../index.html')).text(), 'text/html');
    const header = markup.querySelector('.app-header');
    header.classList.add('social-header');
    header.querySelector('#sign-in-button').hidden = true;
    for (const selector of ['#book-search-button', '#notification-controls', '#user-controls']) header.querySelector(selector).hidden = false;
    header.querySelector('#book-search-button').disabled = false;
    for (const width of [320, 390, 1000, 1001, 1200]) {
      const frame = document.createElement('iframe'); frame.style.cssText = `width:${width}px;height:500px;border:0`;
      const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
      frame.srcdoc = `<link rel="stylesheet" href="${new URL('../css/styles.css', location.href)}"><style>*{transition:none!important}</style><main class="app-shell">${header.outerHTML}</main>`;
      document.body.append(frame); await loaded;
      const doc = frame.contentDocument;
      const rect = (selector) => doc.querySelector(selector).getBoundingClientRect();
      const before = rect('#notifications-button');
      const search = rect('#book-search-button'); const avatar = rect('#avatar-button');
      assert(search.right <= before.left && before.right <= avatar.left, `search bell avatar order at ${width}`);
      const expectedGap = width <= 650 ? 6.4 : 8;
      assert(Math.abs(before.left - search.right - expectedGap) < .02
        && Math.abs(avatar.left - before.right - expectedGap) < .02, 'search, bell and avatar use the responsive gap');
      assert(Math.abs((before.left - search.right) - (avatar.left - before.right)) < .02, 'search, bell and avatar gaps match');
      const center = (box) => box.top + box.height / 2;
      assert(Math.abs(center(search) - center(before)) < 1 && Math.abs(center(before) - center(avatar)) < 1, 'header controls vertically aligned');
      doc.querySelector('.app-header').classList.add('quick-search-open');
      const input = rect('#quick-search-input');
      if (width > 1000) assert(input.right <= search.left && Math.abs(center(input) - center(search)) < 1, 'desktop quick input still aligned and separate');
      else assert(input.top >= avatar.bottom, 'mobile quick input stays below controls');
      const badge = doc.querySelector('[data-notification-badge]'); badge.hidden = false; badge.textContent = '99+';
      equal([rect('#notifications-button').x, rect('#notifications-button').y], [before.x, before.y], 'badge never shifts button');
      doc.querySelector('#notifications-panel').hidden = false;
      const panel = rect('#notifications-panel'); assert(panel.left >= 0 && panel.right <= width, 'dropdown fits viewport');
      const bell = doc.querySelector('#notifications-button'); bell.focus();
      equal(frame.contentWindow.getComputedStyle(bell).outlineColor, 'rgb(138, 98, 59)', 'warm keyboard focus');
      frame.remove();
    }
  });
}

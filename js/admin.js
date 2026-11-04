import { initializeAuth, requestAccessToken, getAccessToken } from './auth.js';
import { startFirebaseSession } from './firebase-session.js';
import { INVITATION_MAILER_URL } from './config.js';

const $ = (selector) => document.querySelector(selector);
const authPanel = $('#auth'), dashboard = $('#dashboard'), status = $('#status'), stats = $('#stats'), tabs = $('#tabs'), content = $('#content');
let session, call, data, activeTab = 'users';
let pageStates = {};
const sections = [
  ['users','Участники'],['relationships','Связи'],['invites','Приглашения'],
  ['shares','Доступ к библиотекам'],['events','Журнал событий'],['banned','Забаненные'],['admins','Администраторы'],['texts','Тексты']
];
const label = (value) => value == null || value === '' ? '—' : String(value);
function dateLabel(value) {
  if (!value) return '—';
  const date = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU');
}
function invitationEmailStatus(invite) {
  const statuses = {
    sent: 'Отправлено',
    sending: 'Отправляется',
    failed: 'Ошибка отправки',
    'not-needed': 'Письмо не требовалось'
  };
  if (statuses[invite.emailStatus]) return statuses[invite.emailStatus];
  if (invite.emailSentAt) return 'Отправлено';
  return 'Нет данных (старая запись)';
}
function invitationActionState(invite) {
  if (invite.claimedUid) return 'Принято';
  if (invite.active === false) return 'Отозвано';
  return null;
}
function gasRequest(action, payload) {
  if (!INVITATION_MAILER_URL) return Promise.reject(new Error('Не настроен адрес административного сервиса.'));
  return new Promise(async (resolve, reject) => {
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(16).padStart(2, '0')).join('');
    const iframe = document.createElement('iframe');
    iframe.name = 'admin-request-' + requestId;
    iframe.hidden = true;
    const form = document.createElement('form');
    form.method = 'POST'; form.action = INVITATION_MAILER_URL; form.target = iframe.name; form.hidden = true;
    const field = document.createElement('input'); field.type = 'hidden'; field.name = 'payload';
    let idToken;
    try { idToken = await session.user.getIdToken(); }
    catch (error) { reject(error); return; }
    field.value = JSON.stringify({ requestId, action, idToken, data: payload || {} });
    form.append(field);
    const cleanup = () => { window.removeEventListener('message', onMessage); clearTimeout(timer); form.remove(); iframe.remove(); };
    const onMessage = event => {
      if (event.data?.type !== 'secret-library-admin-result' || event.data?.requestId !== requestId) return;
      cleanup();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.message || 'Административная операция не выполнена.'));
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Сервис не ответил вовремя. Проверьте подключение и повторите попытку.')); }, 60000);
    window.addEventListener('message', onMessage);
    document.body.append(iframe, form);
    form.submit();
  });
}
function say(message, error = false) { status.textContent = message; status.classList.toggle('error', error); }
function node(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
function button(text, action, cls = '') {
  const b = node('button', text, cls);
  b.addEventListener('click', async () => {
    try { await action(); }
    catch (error) { say(error?.message || 'Операция не выполнена.', true); }
  });
  return b;
}
function table(headers, rows, columnClasses = [], rowClasses = []) {
  const t = node('table'), thead = node('thead'), hr = node('tr'), body = node('tbody');
  headers.forEach((h, index) => hr.append(node('th', h, columnClasses[index] || ''))); if (headers.length) thead.append(hr); t.append(thead, body);
  rows.forEach((row, rowIndex) => { const tr = node('tr', null, rowClasses[rowIndex] || ''); row.forEach((value, index) => { const td = node('td', null, columnClasses[index] || ''); if (value instanceof Node) td.append(value); else td.textContent = label(value); tr.append(td); }); body.append(tr); });
  return t;
}
function paginatedTable(headers, rows, pageSize = 25, columnClasses = [], rowClasses = []) {
  const wrap = node('div', null, 'paginated-list');
  let page = 0;
  const renderPage = () => {
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    page = Math.min(page, pageCount - 1);
    wrap.replaceChildren(table(headers, rows.slice(page * pageSize, (page + 1) * pageSize), columnClasses, rowClasses.slice(page * pageSize, (page + 1) * pageSize)));
    const controls = node('div', null, 'pagination');
    const start = rows.length ? page * pageSize + 1 : 0;
    const end = Math.min((page + 1) * pageSize, rows.length);
    controls.append(node('span', `${start}–${end} из ${rows.length}`));
    const previous = button('← Назад', () => { page--; renderPage(); }, 'secondary');
    previous.disabled = page === 0;
    const next = button('Далее →', () => { page++; renderPage(); }, 'secondary');
    next.disabled = page >= pageCount - 1;
    controls.append(previous, next);
    wrap.append(controls);
  };
  renderPage();
  return wrap;
}
function details(name, email, uid) {
  const d = node('div');
  d.append(node('p', name || 'Без имени'));
  if (email) d.append(node('p', email));
  d.append(node('p', 'UID: ' + uid));
  return d;
}
function userLink(user, fallbackUid = '') {
  const uid = user?.uid || fallbackUid;
  if (!uid) return node('span', user?.displayName || user?.email || '—');
  const b = button(user?.displayName || user?.email || uid, () => renderUserCard(uid), 'user-link');
  b.title = 'Открыть карточку пользователя · UID: ' + uid;
  return b;
}
function userLinks(users) {
  const wrap = node('div');
  if (!users.length) { wrap.textContent = '—'; return wrap; }
  users.forEach((user, index) => { if (index) wrap.append(document.createTextNode(', ')); wrap.append(userLink(user, user.uid)); });
  return wrap;
}
async function renderUserCard(uid) {
  content.replaceChildren(node('h2', 'Карточка участника'), button('← Назад к списку', () => render(), 'secondary'), node('p', 'Загружаем текущий статус…'));
  try {
    const card = await call('getAdminUserCard')({ uid });
    const user = card.user || { uid };
    const personLabel = person => person?.displayName || person?.uid || '—';
    const rows = [
      ['Имя', user.displayName || 'Без имени'], ['UID', uid], ['Электронная почта', user.email || 'Не указана'],
      ['Пригласил', card.inviter ? personLabel(card.inviter) : (user.invitedByUid || '—')],
      ['Приглашённые участники', (card.invited || []).map(personLabel).join(', ') || '—'],
      ['Статус', card.banned ? 'Заблокирован' : 'Активен'],
      ['Права администратора', card.admin ? `${card.admin.role || 'moderator'} · ${card.admin.active === true ? 'активен' : 'отключён'}` : 'Нет'],
      ...(card.banned ? [['Причина блокировки', card.banned.reason || 'Не указана']] : []),
      ['Пользуется библиотеками', (card.incoming || []).map(share => `${share.ownerEmail || share.ownerUid}`).join(', ') || '—'],
      ['Делится библиотеками', (card.outgoing || []).map(share => `${share.viewerEmail || share.viewerUid}`).join(', ') || '—']
    ];
    content.replaceChildren(node('h2', 'Карточка участника'), button('← Назад к списку', () => render(), 'secondary'));
    const cardTable = table([], rows.map(([field, value]) => [node('strong', field), value]));
    cardTable.style.width = 'auto';
    content.append(cardTable);
    const actions = node('div', null, 'actions');
    actions.append(button('Скопировать UID', async () => { await navigator.clipboard.writeText(uid); say('UID скопирован.'); }));
    if (data.permissions?.admins && !card.banned && !card.admin) actions.append(button('Назначить администратором', () => { activeTab = 'admins'; renderAdminEditor(user); }));
    if (data.permissions?.users) actions.append(button('История участника', async () => {
      const history = await call('getAdminUserHistory')({ uid });
      const section = node('section');
      section.append(node('h3', 'История приглашений и связей'));
      const addHistory = (title, items, fields) => {
        section.append(node('h4', title));
        if (!items?.length) { section.append(node('p', 'Записей нет.', 'muted')); return; }
        section.append(table(fields, items.map(item => fields.map(field => {
          const key = ({ 'Владелец': 'ownerUid', 'Получатель': 'viewerUid', 'Событие': 'action', 'Дата': 'createdAt', 'Email': 'email', 'Статус': 'active' })[field] || field;
          const value = field === 'UID' ? (item.targetUid || item.actorUid || item.id) : item[key];
          return key === 'createdAt' ? dateLabel(value) : key === 'active' ? (value ? 'Активна' : 'Закрыта') : value ?? '—';
        }))));
      };
      addHistory('Исходящие доступы', history.outgoing, ['Владелец', 'Получатель', 'Статус']);
      addHistory('Входящие доступы', history.incoming, ['Владелец', 'Получатель', 'Статус']);
      addHistory('Приглашения', history.invitations, ['Email', 'Владелец', 'Дата']);
      addHistory('События', history.events, ['Дата', 'Событие', 'UID']);
      content.append(section);
    }));
    content.append(actions);
  } catch (error) {
    content.replaceChildren(node('h2', 'Карточка участника'), button('← Назад к списку', () => render(), 'secondary'), node('p', error?.message || 'Не удалось загрузить карточку.', 'error'));
  }
}
async function loadActivePage(reset = false) {
  const sectionMap = { users: 'users', invites: 'invites', shares: 'shares', events: 'events', banned: 'banned', admins: 'admins' };
  const section = sectionMap[activeTab];
  if (activeTab === 'relationships') {
    if (reset || !pageStates.relationships) pageStates.relationships = { cursorStack: [null], index: 0, page: null, loading: false };
    const state = pageStates.relationships;
    state.loading = true;
    say('Загружаем корневые ветви…');
    state.page = await call('getAdminRelationshipRoots')({ cursor: state.cursorStack[state.index] });
    data.users = state.page.items || [];
    state.loading = false;
    return;
  }
  if (!section) return;
  if (reset || !pageStates[activeTab]) pageStates[activeTab] = { cursorStack: [null], index: 0, page: null, loading: false, search: pageStates[activeTab]?.search || '', filter: pageStates[activeTab]?.filter || '' };
  const state = pageStates[activeTab];
  state.loading = true;
  say('Загружаем страницу…');
  try {
    state.page = await call('getAdminCollectionPage')({ section, cursor: state.cursorStack[state.index], search: state.search || '', filter: state.filter || '' });
    const destination = { users: 'users', invites: 'invitations', shares: 'shares', events: 'events', banned: 'banned', admins: 'admins' }[activeTab];
    data[destination] = state.page.items || [];
    state.loading = false;
  } catch (error) { state.loading = false; throw error; }
}
function renderRemoteControls() {
  const state = pageStates[activeTab];
  if (!state?.page) return;
  const controls = node('div', null, 'pagination');
  const filterOptions = activeTab === 'invites'
    ? [['', 'Все приглашения'], ['pending', 'Не принятые'], ['accepted', 'Принятые'], ['revoked', 'Отозванные']]
    : ['shares', 'admins'].includes(activeTab)
      ? [['', 'Все записи'], ['active', 'Активные'], ['inactive', 'Неактивные']]
      : [];
  if (filterOptions.length) {
    const filter = node('select');
    filterOptions.forEach(([value, title]) => { const option = node('option', title); option.value = value; filter.append(option); });
    filter.value = state.filter || '';
    controls.append(filter, button('Применить', async () => { state.filter = filter.value; state.cursorStack = [null]; state.index = 0; await loadActivePage(); render(); }, 'secondary'));
  }
  if (activeTab === 'users') {
    const search = node('input');
    search.type = 'search'; search.placeholder = 'Поиск по началу имени'; search.value = state.search || ''; search.setAttribute('aria-label', 'Поиск по началу имени');
    controls.append(search, button('Найти', async () => { state.search = search.value.trim(); state.cursorStack = [null]; state.index = 0; await loadActivePage(); render(); }, 'secondary'));
    if (state.search) controls.append(button('Сбросить', async () => { state.search = ''; state.cursorStack = [null]; state.index = 0; await loadActivePage(); render(); }, 'secondary'));
  }
  const start = state.page.items.length ? state.index * 25 + 1 : 0;
  const end = start ? start + state.page.items.length - 1 : 0;
  controls.append(node('span', `${start}–${end}${state.page.hasMore ? ' и далее' : ''}`));
  const previous = button('← Назад', async () => {
    if (state.index <= 0) return;
    state.index--;
    await loadActivePage();
    render();
  }, 'secondary');
  previous.disabled = state.index === 0 || state.loading;
  const next = button('Далее →', async () => {
    if (!state.page?.hasMore || !state.page.nextCursor) return;
    state.cursorStack = state.cursorStack.slice(0, state.index + 1);
    state.cursorStack.push(state.page.nextCursor);
    state.index++;
    await loadActivePage();
    render();
  }, 'secondary');
  next.disabled = !state.page.hasMore || state.loading;
  controls.append(previous, next);
  content.append(controls);
}
async function refresh() {
  say('Загружаем данные администратора…');
  data = await call('getAdminDashboardSummary')({});
  pageStates = {};
  await loadActivePage(true);
  render();
  say('Данные обновлены.');
}
function renderStats() {
  stats.replaceChildren();
  const counts = data.counts || {};
  [['users','Участники'],['invitations','Приглашения'],['acceptedInvitations','Принятые приглашения'],['shares','Активные доступы'],['admins','Администраторы'],['banned','Забаненные']].forEach(([key,title]) => {
    if (counts[key] == null) return;
    const card = node('div', null, 'stat'); card.append(node('span', title), node('strong', Number(counts[key]).toLocaleString('ru-RU'))); stats.append(card);
  });
}
function renderTabs() {
  tabs.replaceChildren();
  sections.filter(([key]) => data.permissions?.[key]).forEach(([key,title]) => {
    tabs.append(button(title, async () => { activeTab = key; try { await loadActivePage(true); render(); } catch (error) { say(error?.message || 'Не удалось загрузить раздел.', true); } }, 'tab'));
  });
  [...tabs.children].forEach((b,i) => b.setAttribute('aria-pressed', String(sections.filter(([key]) => data.permissions?.[key])[i]?.[0] === activeTab)));
}
function renderUsers() {
  const superAdminUid = data.superAdminUid;
  const users = [...(data.users || [])].sort((a,b)=>(a.displayName||'').localeCompare(b.displayName||'','ru'));
  const rows = users.map(user => {
    const inviter = user.invitedByUid ? userLink({ uid: user.invitedByUid }) : '—';
    const relation = node('div', null, 'user-invitations');
    relation.append(node('div', null, 'inviter-line'));
    relation.firstChild.append(document.createTextNode('Пригласитель: '), inviter instanceof Node ? inviter : document.createTextNode(inviter));
    relation.append(node('div', 'Ветвь приглашений: раздел «Связи»', 'muted'));
    const statusText = user.banned ? 'Забанен' : user.admin ? 'Администратор' : 'Активен';
    const actions = node('div', null, 'actions');
    if (user.uid !== superAdminUid) {
      if (user.banned) {
        if (data.permissions?.banned) actions.append(button('Восстановить', async () => { await call('restoreLibraryUser')({ uid: user.uid }); await refresh(); }));
      } else actions.append(button('Заблокировать', async () => {
        const reason = window.prompt('Причина блокировки (необязательно):', '');
        if (reason === null) return;
        await call('banLibraryUser')({ uid: user.uid, reason });
        await refresh();
      }, 'danger'));
    }
    if (data.permissions?.admins && !user.banned && !user.admin) actions.append(button('Назначить модератором', () => { activeTab = 'admins'; renderAdminEditor(user); }));
    return [userLink(user), relation, statusText, actions];
  });
  content.append(paginatedTable(['Участник', 'Приглашения', 'Статус', 'Действия'], rows));
}
function renderRelations() {
  content.append(node('h2', 'Пригласительная иерархия'));
  content.append(node('p', 'Ветви участников загружаются только при раскрытии.'));
  const tree = node('div');
  function branch(user, depth = 0, seen = new Set()) {
    if (seen.has(user.uid)) return node('div', 'Цикл связей обнаружен.', 'error');
    const nextSeen = new Set(seen); nextSeen.add(user.uid);
    const wrap = node('div', null, 'relationship');
    wrap.style.marginLeft = `${depth * 18}px`;
    const line = node('div', null, 'relationship-line');
    const children = node('div', null, 'relationship-children collapsed');
    let loaded = false;
    let cursor = null;
    let loading = false;
    const toggle = button('▸', async () => {
      if (!loaded && !loading) await loadChildren();
      const collapsed = children.classList.toggle('collapsed');
      toggle.textContent = collapsed ? '▸' : '▾';
      toggle.setAttribute('aria-expanded', String(!collapsed));
    }, 'tree-toggle');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Раскрыть ветку ' + (user.displayName || user.uid));
    line.append(toggle, userLink(user));
    wrap.append(line, children);
    async function loadChildren(next = false) {
      if (loading) return;
      loading = true;
      try {
        const page = await call('getAdminBranch')({ uid: user.uid, cursor: next ? cursor : null });
        if (!next) children.replaceChildren();
        (page.items || []).forEach(child => children.append(branch(child, depth + 1, nextSeen)));
        cursor = page.nextCursor;
        loaded = true;
        if (page.hasMore && cursor) children.append(button('Показать ещё', async () => {
          const moreButton = children.lastElementChild;
          await loadChildren(true);
          moreButton?.remove();
        }, 'secondary'));
        if (!page.items?.length && !next) children.append(node('span', 'Приглашённых нет.', 'muted'));
      } finally { loading = false; }
    }
    return wrap;
  }
  (data.users || []).forEach(user => tree.append(branch(user)));
  content.append(tree);
}
function renderInvites() {
  const invitations = data.invitations || [];
  const rows = invitations.map(i=>[
    i.email,userLink((data.users||[]).find(u=>u.uid===i.ownerUid)||{uid:i.ownerUid},i.ownerUid),i.claimedUid ? userLink((data.users||[]).find(u=>u.uid===i.claimedUid)||{uid:i.claimedUid},i.claimedUid) : 'Не принято',invitationEmailStatus(i),dateLabel(i.createdAt),
    invitationActionState(i) || button('Отменить приглашение',async()=>{if(!confirm('Отменить это приглашение?'))return;try{await call('adminRevokeInvitation')({email:i.email,ownerUid:i.ownerUid||i.id});await refresh();}catch(e){say(e?.message||'Не удалось отменить приглашение.',true);}},'danger')
  ]);
  const rowClasses = invitations.map(i => i.claimedUid ? '' : 'invitation-unaccepted');
  content.append(paginatedTable(['Адрес приглашения','Пригласитель UID','Приглашённый UID','Статус письма','Создано','Действие'],rows,25,[],rowClasses));
}
function renderShares() {
  const users=new Map((data.users||[]).map(u=>[u.uid,u]));
  const superAdminUid = data.superAdminUid || (data.admins || []).find(a => a.role === 'superadmin')?.uid;
  const ownerName = uid => users.get(uid)?.displayName || users.get(uid)?.email || uid || '';
  const shares = [...(data.shares || [])].sort((a,b) => ownerName(a.ownerUid).localeCompare(ownerName(b.ownerUid),'ru') || ownerName(a.viewerUid).localeCompare(ownerName(b.viewerUid),'ru') || String(a.id || '').localeCompare(String(b.id || '')));
  const ownerColors = new Map();
  const rows = shares.map(s=>{
    if (!ownerColors.has(s.ownerUid)) ownerColors.set(s.ownerUid, ownerColors.size % 2 === 0 ? 'share-owner-green' : 'share-owner-yellow');
    return [
      userLink(users.get(s.ownerUid),s.ownerUid),
      userLink(users.get(s.viewerUid),s.viewerUid),
      node('span',s.active?'Активен':'Закрыт',s.active?'':'share-closed'),
      s.ownerUid === superAdminUid || s.viewerUid === superAdminUid ? '—' : button(s.active?'Закрыть доступ':'Доступ закрыт',async()=>{if(!s.active)return;const sure=confirm('Закрыть доступ к этой библиотеке?');if(!sure)return;await call('adminSetLibraryShare')({id:s.id,active:false});await refresh();},s.active?'danger':'')
    ];
  });
  const rowClasses = shares.map(s => ownerColors.get(s.ownerUid));
  content.append(paginatedTable(['Владелец','Получатель','Статус','Действие'],rows,25,[],rowClasses));
}
function renderEvents() {
  const rows = (data.events||[]).map(e=>[
    dateLabel(e.createdAt),userLink((data.users||[]).find(u=>u.uid===e.actorUid)||{uid:e.actorUid},e.actorUid),e.action,e.targetUid ? userLink((data.users||[]).find(u=>u.uid===e.targetUid)||{uid:e.targetUid},e.targetUid) : '—',JSON.stringify(e.details||{})
  ]);
  content.append(paginatedTable(['Время','Администратор UID','Событие','Участник UID','Подробности'],rows));
}
function renderBanned() {
  const rows = (data.banned||[]).map(u=>[
    userLink(u),u.reason,u.bannedBy,dateLabel(u.bannedAt),
    button('Восстановить',async()=>{await call('restoreLibraryUser')({uid:u.uid});await refresh();})
  ]);
  content.append(paginatedTable(['Участник','Причина','Кем заблокирован','Дата','Действие'],rows));
}
function renderAdminEditor(user=null) {
  content.replaceChildren(node('h2',user?'Права модератора':'Администраторы'));
  if(user) {
    const existing=(data.admins||[]).find(a=>a.uid===user.uid);
    if(existing?.role==='superadmin'){content.append(node('p','Права главного администратора нельзя изменить здесь.'));return;}
    const form=node('div'); form.append(details(user.displayName,existing?.email||'',user.uid));
    const checks=[];
    sections.forEach(([key,title])=>{const labelEl=node('label');labelEl.style.display='block';const input=node('input');input.type='checkbox';input.checked=existing?.permissions?.[key]===true;labelEl.append(input,document.createTextNode(' '+title));form.append(labelEl);checks.push([key,input]);});
    const activeLabel=node('label');activeLabel.style.display='block';const activeInput=node('input');activeInput.type='checkbox';activeInput.checked=existing ? existing.active===true : true;activeLabel.append(activeInput,document.createTextNode(' Учётная запись администратора активна'));form.append(activeLabel);
    form.append(button('Сохранить права',async()=>{try{const permissions=Object.fromEntries(checks.map(([k,i])=>[k,i.checked]));await call('setAdminPermissions')({uid:user.uid,email:existing?.email||'',permissions,active:activeInput.checked});await refresh();}catch(e){say(e?.message||'Не удалось сохранить права.',true);}},'primary'));
    form.append(button('Отмена',()=>render()));content.append(form);return;
  }
  const rows = (data.admins||[]).map(a=>[
    userLink((data.users||[]).find(u=>u.uid===a.uid)||a,a.uid),a.role,a.active?'Активен':'Отключён',Object.entries(a.permissions||{}).filter(([,v])=>v).map(([k])=>sections.find(s=>s[0]===k)?.[1]||k).join(', '),
    a.role==='superadmin'?'—':button('Изменить права',()=>renderAdminEditor((data.users||[]).find(u=>u.uid===a.uid)||{uid:a.uid,displayName:a.displayName||a.email}))
  ]);
  content.append(paginatedTable(['Участник','Роль','Статус','Права','Действие'],rows));
  content.append(node('p','Назначение модератора доступно из раздела «Участники».'));
}
function renderTexts() {
  content.replaceChildren();
  content.append(node('h2', 'Тексты'));
  content.append(node('p', 'Редактирование текста пригласительного письма. Имя пригласителя подставляется автоматически.'));
  const fieldLabel = node('label', 'Текст письма');
  fieldLabel.style.display = 'block';
  const editor = node('textarea');
  editor.value = data.invitationEmailTemplate || '';
  editor.rows = 12;
  editor.maxLength = 10000;
  editor.style.width = '100%';
  editor.style.boxSizing = 'border-box';
  editor.setAttribute('aria-label', 'Текст пригласительного письма');
  const hint = node('p', 'В месте, где должно появиться имя пригласителя, оставь {{inviterName}}. Максимум 10 000 символов.');
  fieldLabel.append(editor);
  content.append(fieldLabel, hint);
  content.append(button('Сохранить текст', async () => {
    const body = editor.value;
    const result = await call('setInvitationEmailTemplate')({ body });
    data.invitationEmailTemplate = result.body || body;
    say('Текст пригласительного письма сохранён.');
    renderTexts();
  }, 'primary'));
}

function render() {
  const allowed = sections.filter(([key]) => data.permissions?.[key]).map(([key]) => key);
  if (!allowed.includes(activeTab)) activeTab = allowed[0] || 'users';
  renderStats(); renderTabs(); content.replaceChildren();
  if(activeTab==='users') renderUsers();
  else if(activeTab==='relationships') renderRelations();
  else if(activeTab==='invites') renderInvites();
  else if(activeTab==='shares') renderShares();
  else if(activeTab==='events') renderEvents();
  else if(activeTab==='banned') renderBanned();
  else if(activeTab==='admins') renderAdminEditor();
  else if(activeTab==='texts') renderTexts();
  renderRemoteControls();
}
async function login() {
  $('#login').disabled=true;
  try {
    await initializeAuth();
    await requestAccessToken({prompt:''});
    session=await startFirebaseSession(getAccessToken());
    call=(name)=>(payload={})=>gasRequest(name,payload);
    try { await call('bootstrapAdmin')({}); } catch(e) {
      if (!/Главный администратор уже настроен|Нет прав администратора|Первоначальная настройка доступна только владельцу проекта/.test(e?.message || '')) throw e;
    }
    await refresh();
    authPanel.classList.add('hidden');dashboard.classList.remove('hidden');
  } catch(e) { say(e?.message||'Не удалось войти. Проверьте права администратора.',true); if(!dashboard.classList.contains('hidden')){} else {const p=node('p',e?.message||'Нет доступа','error');authPanel.append(p);} }
  finally { $('#login').disabled=false; }
}
$('#refresh-data').addEventListener('click', () => refresh());
$('#login').addEventListener('click',login);

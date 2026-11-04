import { initializeAuth, requestAccessToken, getAccessToken } from './auth.js';
import { startFirebaseSession } from './firebase-session.js';
import { INVITATION_MAILER_URL } from './config.js';

const $ = (selector) => document.querySelector(selector);
const authPanel = $('#auth'), dashboard = $('#dashboard'), status = $('#status'), stats = $('#stats'), tabs = $('#tabs'), content = $('#content');
let session, call, data, activeTab = 'overview';
const sections = [
  ['overview','Обзор'],['users','Участники'],['relationships','Связи'],['invites','Приглашения'],
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
function table(headers, rows) {
  const t = node('table'), thead = node('thead'), hr = node('tr'), body = node('tbody');
  headers.forEach(h => hr.append(node('th', h))); if (headers.length) thead.append(hr); t.append(thead, body);
  rows.forEach(row => { const tr = node('tr'); row.forEach(value => { const td = node('td'); if (value instanceof Node) td.append(value); else td.textContent = label(value); tr.append(td); }); body.append(tr); });
  return t;
}
function paginatedTable(headers, rows, pageSize = 25) {
  const wrap = node('div', null, 'paginated-list');
  let page = 0;
  const renderPage = () => {
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    page = Math.min(page, pageCount - 1);
    wrap.replaceChildren(table(headers, rows.slice(page * pageSize, (page + 1) * pageSize)));
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
function renderUserCard(uid) {
  const user = (data.users || []).find(u => u.uid === uid) || (data.banned || []).find(u => u.uid === uid) || (data.admins || []).find(u => u.uid === uid) || { uid };
  const admin = (data.admins || []).find(a => a.uid === uid);
  const ban = (data.banned || []).find(u => u.uid === uid);
  const byUid = new Map((data.users || []).map(u => [u.uid, u]));
  const invitedBy = byUid.get(user.invitedByUid);
  const invitedUsers = (data.users || []).filter(u => u.invitedByUid === uid);
  const shares = (data.shares || []).filter(s => s.ownerUid === uid || s.viewerUid === uid);
  const bannedUids = new Set((data.banned || []).map(u => u.uid));
  const personLabel = (personUid) => {
    const person = byUid.get(personUid) || (data.banned || []).find(u => u.uid === personUid) || (data.admins || []).find(a => a.uid === personUid);
    const name = person?.displayName || person?.email || personUid;
    return bannedUids.has(personUid) || person?.banned ? `${name} (заблокирован)` : name;
  };
  const incoming = shares.filter(s => s.viewerUid === uid);
  const outgoing = shares.filter(s => s.ownerUid === uid);
  const rows = [
    ['Имя', user.displayName || 'Без имени'],
    ['UID', uid],
    ['Электронная почта', user.email || admin?.email || ban?.email || 'Не указана в профиле'],
    ['Пригласил', invitedBy ? (invitedBy.displayName || invitedBy.uid) : (user.invitedByUid || '—')],
    ['Приглашённые участники', invitedUsers.map(u => personLabel(u.uid)).join(', ') || '—'],
    ['Статус', ban || user.banned ? 'Заблокирован' : 'Активен'],
    ['Права администратора', admin ? `${admin.role || 'moderator'} · ${admin.active === true ? 'активен' : 'отключён'}` : 'Нет'],
    ...(ban || user.banned ? [['Причина блокировки', ban?.reason || 'Не указана']] : []),
    ['Пользуется', incoming.length ? incoming.map(s => `${personLabel(s.ownerUid)}${s.active ? '' : ' (доступ отозван)'}`).join(', ') : '—'],
    ['Делится', outgoing.length ? outgoing.map(s => `${personLabel(s.viewerUid)}${s.active ? '' : ' (доступ отозван)'}`).join(', ') : '—']
  ];
  content.replaceChildren(node('h2', 'Карточка пользователя'), button('← Назад к списку', () => render(), 'secondary'));
  const cardTable = table([], rows.map(([field, value]) => [node('strong', field), value]));
  cardTable.style.width = 'auto';
  content.append(cardTable);
  const actions = node('div', null, 'actions');
  actions.append(button('Скопировать UID', async () => { await navigator.clipboard.writeText(uid); say('UID скопирован.'); }));
  if (data.permissions?.admins && !user.banned && !admin) actions.append(button('Назначить администратором', () => { activeTab = 'admins'; renderAdminEditor(user); }));
  content.append(actions);
}
async function refresh() {
  say('Загружаем данные администратора…');
  data = await call('getAdminDashboard')({});
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
    tabs.append(button(title, () => { activeTab = key; render(); }, 'tab'));
  });
  [...tabs.children].forEach((b,i) => b.setAttribute('aria-pressed', String(sections.filter(([key]) => data.permissions?.[key])[i]?.[0] === activeTab)));
}
function renderUsers() {
  const superAdminUid = (data.admins || []).find(a => a.role === 'superadmin')?.uid;
  const users = [...(data.users || [])].sort((a,b)=>(a.displayName||'').localeCompare(b.displayName||'','ru'));
  const byUid = new Map(users.map(u => [u.uid,u]));
  const children = new Map();
  users.forEach(u => { if (u.invitedByUid && byUid.has(u.invitedByUid)) { const arr=children.get(u.invitedByUid)||[]; arr.push(u); children.set(u.invitedByUid,arr); } });
  const rows = users.map(u => {
    const who = userLink(u);
    const rel = node('div', null, 'user-invitations');
    const inviterLine = node('div', null, 'inviter-line'); inviterLine.append(document.createTextNode('Пригласитель: '), byUid.has(u.invitedByUid) ? userLink(byUid.get(u.invitedByUid)) : node('span', u.invitedByUid || '—')); rel.append(inviterLine);
    const invited = children.get(u.uid) || [];
    const invitedLine = node('div', null, invited.length ? 'invited-line' : 'invited-empty');
    if (invited.length) invitedLine.append(document.createTextNode('Приглашённые: '), userLinks(invited));
    else invitedLine.textContent = 'Приглашенных нет.';
    rel.append(invitedLine);
    const statusText = u.banned ? 'Забанен' : u.admin ? 'Администратор' : 'Активен';
    const actions = node('div',null,'actions');
    if (u.uid !== superAdminUid) {
      if (u.banned) {
        if (data.permissions?.banned) actions.append(button('Восстановить', async()=>{await call('restoreLibraryUser')({uid:u.uid}); await refresh();}));
      } else actions.append(button('Заблокировать',async()=>{const reason=window.prompt('Причина блокировки (необязательно):','');if(reason===null)return;await call('banLibraryUser')({uid:u.uid,reason});await refresh();},'danger'));
    }
    if (data.permissions?.admins && !u.banned && !u.admin) actions.append(button('Назначить модератором',()=>{activeTab='admins';renderAdminEditor(u);}));
    return [who,rel,statusText,actions];
  });
  content.append(table(['Участник','Приглашения','Статус','Действия'],rows));
}
function renderRelations() {
  const byUid = new Map((data.users||[]).map(u=>[u.uid,u]));
  const tree = node('div');
  const childMap = new Map();
  (data.users||[]).forEach(u=>{if(u.invitedByUid){const a=childMap.get(u.invitedByUid)||[];a.push(u);childMap.set(u.invitedByUid,a);}});
  const roots=(data.users||[]).filter(u=>!u.invitedByUid||!byUid.has(u.invitedByUid));
  function branch(u, depth=0, seen=new Set()) {
    if(seen.has(u.uid)) return node('div','Цикл связей обнаружен');
    const next=new Set(seen); next.add(u.uid);
    const box=node('div',null,'relationship'); box.style.marginLeft=(depth*18)+'px';
    const children=(childMap.get(u.uid)||[]).sort((a,b)=>(a.displayName||'').localeCompare(b.displayName||'','ru'));
    const line=node('div',null,'relationship-line');
    const childList=node('div',null,'relationship-children');
    let toggle=null;
    const toggleBranch=()=>{
      if (!children.length) return;
      const collapsed=childList.classList.toggle('collapsed');
      if (toggle) {
        toggle.textContent=collapsed?'\u25B8':'\u25BE';
        toggle.setAttribute('aria-expanded',String(!collapsed));
        toggle.setAttribute('aria-label',(collapsed?'\u0420\u0430\u0437\u0432\u0435\u0440\u043d\u0443\u0442\u044c':'\u0421\u0432\u0435\u0440\u043d\u0443\u0442\u044c')+' \u0432\u0435\u0442\u043a\u0443 '+(u.displayName||u.uid));
      }
    };
    if (children.length) {
      toggle=button('\u25BE',toggleBranch,'tree-toggle');
      toggle.setAttribute('aria-expanded','true');
      toggle.setAttribute('aria-label','\u0421\u0432\u0435\u0440\u043d\u0443\u0442\u044c \u0432\u0435\u0442\u043a\u0443 '+(u.displayName||u.uid));
      line.append(toggle);
    } else {
      line.append(node('span','', 'tree-toggle-placeholder'));
    }
    const name=button((u.displayName||'\u0411\u0435\u0437 \u0438\u043c\u0435\u043d\u0438')+(u.banned?' \u00B7 \u0437\u0430\u0431\u0430\u043d':''),()=>renderUserCard(u.uid),'tree-name-button');
    name.title='\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0443 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f. UID: '+u.uid;
    line.append(name);
    const copy=button('\u2398',async()=>{
      try {
        await navigator.clipboard.writeText(String(u.uid));
        const feedback=node('span','UID \u0441\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u043d','uid-copy-feedback');
        line.append(feedback);
        setTimeout(()=>feedback.remove(),1600);
      } catch (error) {
        say('\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u0442\u044c UID. \u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u0435 \u0434\u043e\u0441\u0442\u0443\u043f \u043a \u0431\u0443\u0444\u0435\u0440\u0443 \u043e\u0431\u043c\u0435\u043d\u0430 \u0438 \u043f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u0435.',true);
      }
    },'uid-copy-button');
    copy.title='\u0421\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u0442\u044c UID';
    copy.setAttribute('aria-label','\u0421\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u0442\u044c UID \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f '+(u.displayName||u.uid));
    line.append(copy); box.append(line);
    children.forEach(c=>childList.append(branch(c,depth+1,next)));
    box.append(childList);
    return box;
  }
  roots.sort((a,b)=>(a.displayName||'').localeCompare(b.displayName||'','ru')).forEach(u=>tree.append(branch(u)));
  content.append(tree);
  content.append(node('h3','Алфавитный список и типы отношений'));
  const active = (data.shares||[]).filter(s=>s.active);
  const users = data.users || [];
  const invitedByUid = new Map();
  const outgoingByUid = new Map();
  const incomingByUid = new Map();
  users.forEach(u => invitedByUid.set(u.uid, []));
  users.forEach(u => { if (u.invitedByUid && invitedByUid.has(u.invitedByUid)) invitedByUid.get(u.invitedByUid).push(u); });
  active.forEach(s => {
    if (!outgoingByUid.has(s.ownerUid)) outgoingByUid.set(s.ownerUid, new Set());
    if (!incomingByUid.has(s.viewerUid)) incomingByUid.set(s.viewerUid, new Set());
    outgoingByUid.get(s.ownerUid).add(s.viewerUid);
    incomingByUid.get(s.viewerUid).add(s.ownerUid);
  });
  const alphabeticRows = [...users].sort((a,b)=>(a.displayName||'').localeCompare(b.displayName||'','ru')).map(u=>{
    const invited = invitedByUid.get(u.uid) || [];
    const outgoing = outgoingByUid.get(u.uid) || new Set();
    const incoming = incomingByUid.get(u.uid) || new Set();
    const others = new Set([...outgoing, ...incoming]);
    const grouped = { mutual: [], outgoing: [], incoming: [] };
    [...others].forEach(other => {
      const out=outgoing.has(other), inc=incoming.has(other), otherUser=byUid.get(other)||{uid:other};
      if (out && inc) grouped.mutual.push(otherUser);
      else if (out) grouped.outgoing.push(otherUser);
      else grouped.incoming.push(otherUser);
    });
    const types = node('div');
    const addType = (title, people) => { if (!people.length) return; const line = node('div'); line.append(document.createTextNode(title+': '),userLinks(people)); types.append(line); };
    addType('Взаимные',grouped.mutual); addType('Делится',grouped.outgoing); addType('Пользуется',grouped.incoming);
    const userName=node('div'); userName.append(userLink(u));
    return [userName,byUid.has(u.invitedByUid) ? userLink(byUid.get(u.invitedByUid)) : (u.invitedByUid || '—'),userLinks(invited),types.childNodes.length ? types : '—'];
  });
  content.append(paginatedTable(['Участник','Пригласитель','Приглашённые','Связи доступа'],alphabeticRows));
  content.append(node('h3','Отдельные связи доступа'));
  const shareRows = (data.shares||[]).map(s=>[
    userLink(byUid.get(s.ownerUid),s.ownerUid),
    userLink(byUid.get(s.viewerUid),s.viewerUid),s.active?'Активен':'Закрыт'
  ]);
  content.append(paginatedTable(['Владелец библиотеки','Пользователь','Доступ'],shareRows));
}
function renderInvites() {
  content.append(table(['Адрес приглашения','Пригласитель UID','Приглашённый UID','Статус письма','Создано','Действие'],(data.invitations||[]).map(i=>[
    i.email,userLink((data.users||[]).find(u=>u.uid===i.ownerUid)||{uid:i.ownerUid},i.ownerUid),i.claimedUid ? userLink((data.users||[]).find(u=>u.uid===i.claimedUid)||{uid:i.claimedUid},i.claimedUid) : 'Не принято',invitationEmailStatus(i),dateLabel(i.createdAt),
    invitationActionState(i) || button('Отменить приглашение',async()=>{if(!confirm('Отменить это приглашение?'))return;try{await call('adminRevokeInvitation')({email:i.email,ownerUid:i.ownerUid||i.id});await refresh();}catch(e){say(e?.message||'Не удалось отменить приглашение.',true);}},'danger')
  ])));
}
function renderShares() {
  const users=new Map((data.users||[]).map(u=>[u.uid,u]));
  const superAdminUid = (data.admins || []).find(a => a.role === 'superadmin')?.uid;
  content.append(table(['Владелец','Получатель','Статус','Действие'],(data.shares||[]).map(s=>[
    userLink(users.get(s.ownerUid),s.ownerUid),
    userLink(users.get(s.viewerUid),s.viewerUid),
    s.active?'Активен':'Закрыт',
    s.ownerUid === superAdminUid || s.viewerUid === superAdminUid ? '—' : button(s.active?'Закрыть доступ':'Доступ закрыт',async()=>{if(!s.active)return;const sure=confirm('Закрыть доступ к этой библиотеке?');if(!sure)return;await call('adminSetLibraryShare')({id:s.id,active:false});await refresh();},s.active?'danger':'')
  ])));
}
function renderEvents() {
  content.append(table(['Время','Администратор UID','Событие','Участник UID','Подробности'],(data.events||[]).map(e=>[
    dateLabel(e.createdAt),userLink((data.users||[]).find(u=>u.uid===e.actorUid)||{uid:e.actorUid},e.actorUid),e.action,e.targetUid ? userLink((data.users||[]).find(u=>u.uid===e.targetUid)||{uid:e.targetUid},e.targetUid) : '—',JSON.stringify(e.details||{})
  ])));
}
function renderBanned() {
  content.append(table(['Участник','Причина','Кем заблокирован','Дата','Действие'],(data.banned||[]).map(u=>[
    userLink(u),u.reason,u.bannedBy,dateLabel(u.bannedAt),
    button('Восстановить',async()=>{await call('restoreLibraryUser')({uid:u.uid});await refresh();})
  ])));
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
  content.append(table(['Участник','Роль','Статус','Права','Действие'],(data.admins||[]).map(a=>[
    userLink((data.users||[]).find(u=>u.uid===a.uid)||a,a.uid),a.role,a.active?'Активен':'Отключён',Object.entries(a.permissions||{}).filter(([,v])=>v).map(([k])=>sections.find(s=>s[0]===k)?.[1]||k).join(', '),
    a.role==='superadmin'?'—':button('Изменить права',()=>renderAdminEditor((data.users||[]).find(u=>u.uid===a.uid)||{uid:a.uid,displayName:a.displayName||a.email}))
  ])));
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
  if (!allowed.includes(activeTab)) activeTab = allowed[0] || 'overview';
  renderStats(); renderTabs(); content.replaceChildren();
  if(activeTab==='overview') {
    content.append(node('h2','Обзор'),node('p','Сводные показатели отображаются выше. «Обновить данные» повторно загружает их и списки из административного сервиса; автоматического обновления в фоне нет.'));
    content.append(button('Обновить данные',()=>refresh()));
  } else if(activeTab==='users') renderUsers();
  else if(activeTab==='relationships') renderRelations();
  else if(activeTab==='invites') renderInvites();
  else if(activeTab==='shares') renderShares();
  else if(activeTab==='events') renderEvents();
  else if(activeTab==='banned') renderBanned();
  else if(activeTab==='admins') renderAdminEditor();
  else if(activeTab==='texts') renderTexts();
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
$('#login').addEventListener('click',login);

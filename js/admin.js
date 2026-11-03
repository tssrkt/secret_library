import { initializeAuth, requestAccessToken, getAccessToken } from './auth.js';
import { startFirebaseSession } from './firebase-session.js';
import { INVITATION_MAILER_URL } from './config.js';

const $ = (selector) => document.querySelector(selector);
const authPanel = $('#auth'), dashboard = $('#dashboard'), status = $('#status'), stats = $('#stats'), tabs = $('#tabs'), content = $('#content');
let session, call, data, activeTab = 'overview';
const sections = [
  ['overview','Обзор'],['users','Участники'],['relationships','Связи'],['invites','Приглашения'],
  ['shares','Доступ к библиотекам'],['events','Журнал событий'],['banned','Забаненные'],['admins','Администраторы и права']
];
const label = (value) => value == null || value === '' ? '—' : String(value);
function dateLabel(value) {
  if (!value) return '—';
  const date = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU');
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
      if (event.source !== window || event.data?.type !== 'secret-library-admin-result' || event.data?.requestId !== requestId) return;
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
function button(text, action, cls = '') { const b = node('button', text, cls); b.addEventListener('click', action); return b; }
function table(headers, rows) {
  const t = node('table'), thead = node('thead'), hr = node('tr'), body = node('tbody');
  headers.forEach(h => hr.append(node('th', h))); thead.append(hr); t.append(thead, body);
  rows.forEach(row => { const tr = node('tr'); row.forEach(value => { const td = node('td'); if (value instanceof Node) td.append(value); else td.textContent = label(value); tr.append(td); }); body.append(tr); });
  return t;
}
function details(name, email, uid) { const d = node('div'); d.append(node('strong', name || 'Без имени'), node('small', email || uid)); return d; }
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
  const users = [...(data.users || [])].sort((a,b)=>(a.displayName||'').localeCompare(b.displayName||'','ru'));
  const byUid = new Map(users.map(u => [u.uid,u]));
  const children = new Map();
  users.forEach(u => { if (u.invitedByUid && byUid.has(u.invitedByUid)) { const arr=children.get(u.invitedByUid)||[]; arr.push(u); children.set(u.invitedByUid,arr); } });
  const rows = users.map(u => {
    const who = details(u.displayName, '', u.uid);
    const rel = node('div'); rel.append(node('div', 'Пригласитель: '+label(byUid.get(u.invitedByUid)?.displayName || u.invitedByUid)));
    rel.append(node('div', 'Приглашённые: '+(children.get(u.uid)||[]).map(x=>x.displayName||x.uid).join(', ') || '—'));
    const statusText = u.banned ? 'Забанен' : u.admin ? 'Администратор' : 'Активен';
    const actions = node('div',null,'actions');
    if (u.banned) actions.append(button('Восстановить', async()=>{await call('restoreLibraryUser')({uid:u.uid}); await refresh();}));
    else actions.append(button('Заблокировать',async()=>{const reason=window.prompt('Причина блокировки (необязательно):','');if(reason===null)return;await call('banLibraryUser')({uid:u.uid,reason});await refresh();},'danger'));
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
    box.append(node('div',(u.displayName||u.uid)+(u.banned?' · забанен':'')));
    (childMap.get(u.uid)||[]).sort((a,b)=>(a.displayName||'').localeCompare(b.displayName||'','ru')).forEach(c=>box.append(branch(c,depth+1,next)));
    return box;
  }
  roots.sort((a,b)=>(a.displayName||'').localeCompare(b.displayName||'','ru')).forEach(u=>tree.append(branch(u)));
  content.append(tree);
  content.append(node('h3','Алфавитный список и типы отношений'));
  const active = (data.shares||[]).filter(s=>s.active);
  content.append(table(['Участник','Пригласитель','Приглашённые','Связи доступа'],[...(data.users||[])].sort((a,b)=>(a.displayName||'').localeCompare(b.displayName||'','ru')).map(u=>{
    const invited=(data.users||[]).filter(x=>x.invitedByUid===u.uid).map(x=>x.displayName||x.uid);
    const outgoing=active.filter(s=>s.ownerUid===u.uid).map(s=>s.viewerUid);
    const incoming=active.filter(s=>s.viewerUid===u.uid).map(s=>s.ownerUid);
    const others=new Set([...outgoing,...incoming]);
    const types=[...others].map(other=>{
      const out=outgoing.includes(other), inc=incoming.includes(other), name=(data.users||[]).find(x=>x.uid===other)?.displayName||other;
      return (out&&inc?'Взаимные: ':out?'Делится: ':'Пользуется: ')+name;
    });
    return [details(u.displayName,'',u.uid),(data.users||[]).find(x=>x.uid===u.invitedByUid)?.displayName||u.invitedByUid||'—',invited.join(', ')||'—',types.join('; ')||'—'];
  })));
  content.append(node('h3','Отдельные связи доступа'));
  content.append(table(['Владелец библиотеки','Пользователь','Доступ'],(data.shares||[]).map(s=>[
    details(byUid.get(s.ownerUid)?.displayName,s.ownerUid,s.ownerUid),
    details(byUid.get(s.viewerUid)?.displayName,s.viewerUid,s.viewerUid),s.active?'Активен':'Закрыт'
  ])));
}
function renderInvites() {
  content.append(table(['Адрес приглашения','Пригласитель UID','Приглашённый UID','Статус письма','Создано','Действие'],(data.invitations||[]).map(i=>[
    i.email,i.ownerUid,i.claimedUid||'Не принято',i.emailStatus||'—',dateLabel(i.createdAt),
    !i.claimedUid && i.active!==false ? button('Отменить приглашение',async()=>{if(!confirm('Отменить это приглашение?'))return;try{await call('adminRevokeInvitation')({email:i.email,ownerUid:i.ownerUid||i.id});await refresh();}catch(e){say(e?.message||'Не удалось отменить приглашение.',true);}},'danger') : '—'
  ])));
}
function renderShares() {
  const users=new Map((data.users||[]).map(u=>[u.uid,u]));
  content.append(table(['Владелец','Получатель','Статус','Действие'],(data.shares||[]).map(s=>[
    details(users.get(s.ownerUid)?.displayName,s.ownerUid,s.ownerUid),
    details(users.get(s.viewerUid)?.displayName,s.viewerUid,s.viewerUid),
    s.active?'Активен':'Закрыт',
    button(s.active?'Закрыть доступ':'Доступ закрыт',async()=>{if(!s.active)return;const sure=confirm('Закрыть доступ к этой библиотеке?');if(!sure)return;await call('adminSetLibraryShare')({id:s.id,active:false});await refresh();},s.active?'danger':'')
  ])));
}
function renderEvents() {
  content.append(table(['Время','Администратор UID','Событие','Участник UID','Подробности'],(data.events||[]).map(e=>[
    dateLabel(e.createdAt),e.actorUid,e.action,e.targetUid||'—',JSON.stringify(e.details||{})
  ])));
}
function renderBanned() {
  content.append(table(['Участник','Причина','Кем заблокирован','Дата','Действие'],(data.banned||[]).map(u=>[
    details(u.displayName,u.email,u.uid),u.reason,u.bannedBy,dateLabel(u.bannedAt),
    button('Восстановить',async()=>{await call('restoreLibraryUser')({uid:u.uid});await refresh();})
  ])));
}
function renderAdminEditor(user=null) {
  content.replaceChildren(node('h2',user?'Права модератора':'Администраторы и права'));
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
    details(a.email,a.uid,a.uid),a.role,a.active?'Активен':'Отключён',Object.entries(a.permissions||{}).filter(([,v])=>v).map(([k])=>sections.find(s=>s[0]===k)?.[1]||k).join(', '),
    a.role==='superadmin'?'—':button('Изменить права',()=>renderAdminEditor((data.users||[]).find(u=>u.uid===a.uid)||{uid:a.uid,displayName:a.displayName||a.email}))
  ])));
  content.append(node('p','Назначение модератора доступно из раздела «Участники».'));
}
function render() {
  const allowed = sections.filter(([key]) => data.permissions?.[key]).map(([key]) => key);
  if (!allowed.includes(activeTab)) activeTab = allowed[0] || 'overview';
  renderStats(); renderTabs(); content.replaceChildren();
  if(activeTab==='overview') {
    content.append(node('h2','Обзор'),node('p','Приглашения и зарегистрированные участники считаются отдельно. Заблокированный участник сохраняет профиль и связи.'));
    content.append(button('Обновить данные',()=>refresh()));
  } else if(activeTab==='users') renderUsers();
  else if(activeTab==='relationships') renderRelations();
  else if(activeTab==='invites') renderInvites();
  else if(activeTab==='shares') renderShares();
  else if(activeTab==='events') renderEvents();
  else if(activeTab==='banned') renderBanned();
  else if(activeTab==='admins') renderAdminEditor();
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

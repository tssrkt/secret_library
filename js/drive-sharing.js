import { SHARED_CATALOG_FILE_NAME, FOLDER_MIME_TYPE } from './config.js';
import { driveFetch, downloadDriveJsonFile, findDriveCatalogFile } from './drive.js';

const normalizeEmail = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const isEmailPrefixName = (name, email) => {
  const value = typeof name === 'string' ? name.trim().toLowerCase() : '';
  const prefix = normalizeEmail(email).split('@')[0];
  return Boolean(value && prefix && value === prefix);
};
const escapeDriveQuery = (value) => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");

async function listPages(path, params, request = driveFetch) {
  const results = [];
  let pageToken = '';
  do {
    if (pageToken) params.set('pageToken', pageToken);
    const page = await request(`${path}?${params}`, { readJson: true });
    results.push(...(page.files || page.permissions || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return results;
}

async function getRootFolder(rootFolderId, request = driveFetch) {
  if (!rootFolderId) return null;
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,owners(displayName,emailAddress)',
    supportsAllDrives: 'true',
  });
  return request(`/files/${encodeURIComponent(rootFolderId)}?${params}`, { readJson: true });
}

async function getRootCatalog(rootFolderId, request = driveFetch) {
  if (!rootFolderId) return null;
  const params = new URLSearchParams({
    q: `'${escapeDriveQuery(rootFolderId)}' in parents and name = '${escapeDriveQuery(SHARED_CATALOG_FILE_NAME)}' and trashed = false`,
    fields: 'files(id,name,mimeType)',
    pageSize: '10',
    spaces: 'drive',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const result = await request(`/files?${params}`, { readJson: true });
  return (result.files || []).find((file) => file.mimeType === 'application/json') || null;
}

async function listSharedCatalogFiles(request = driveFetch) {
  const params = new URLSearchParams({
    q: `name = '${escapeDriveQuery(SHARED_CATALOG_FILE_NAME)}' and trashed = false`,
    fields: 'nextPageToken,files(id,name,mimeType,parents,owners(displayName,emailAddress))',
    pageSize: '100',
    spaces: 'drive',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  return listPages('/files', params, request);
}

async function listSharedFolders(request = driveFetch, ownerEmail = '') {
  const ownerFilter = normalizeEmail(ownerEmail);
  const clauses = [`mimeType = '${FOLDER_MIME_TYPE}'`, 'trashed = false'];
  if (ownerFilter) clauses.push(`'${escapeDriveQuery(ownerFilter)}' in owners`);
  else clauses.push('sharedWithMe = true');
  const params = new URLSearchParams({
    q: clauses.join(' and '),
    fields: 'nextPageToken,files(id,name,owners(displayName,emailAddress))',
    pageSize: '1000',
    spaces: 'drive',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  return listPages('/files', params, request);
}

async function listPermissions(folderId, request = driveFetch) {
  const params = new URLSearchParams({
    fields: 'nextPageToken,permissions(id,type,emailAddress,displayName,role,deleted,permissionDetails(inherited,role,permissionType))',
    pageSize: '100',
    supportsAllDrives: 'true',
  });
  return listPages(`/files/${encodeURIComponent(folderId)}/permissions`, params, request);
}

// Grant access to the owner's selected root folder before sending an invitation.
// Existing permissions are preserved; rollback only removes a permission created by this attempt.
export async function grantRootFolderAccess(rootFolderId, email, api = {}) {
  const request = api.driveFetch || driveFetch;
  const address = normalizeEmail(email);
  if (!rootFolderId) throw new Error('Сначала выберите корневую папку своей библиотеки.');
  if (!address) throw new Error('Укажите корректный email участника.');
  const existing = (await listPermissions(rootFolderId, request)).find((permission) =>
    !permission.deleted && permission.type === 'user' && normalizeEmail(permission.emailAddress) === address);
  if (existing) {
    // Never leave a direct editor permission in place when an invitation is sent.
    // Inherited permissions cannot be changed here, so fail visibly instead.
    if (existing.role === 'owner') {
      return { permissionId: existing.id || '', created: false, email: address };
    }
    if (existing.role !== 'reader') {
      const inherited = (existing.permissionDetails || []).some((detail) => detail.inherited === true);
      if (inherited) {
        throw new Error(`Для ${address} унаследованы права редактирования Google Drive. Измените доступ на родительской папке на чтение и повторите приглашение.`);
      }
      const params = new URLSearchParams({ supportsAllDrives: 'true', sendNotificationEmail: 'false' });
      const updated = await request(`/files/${encodeURIComponent(rootFolderId)}/permissions/${encodeURIComponent(existing.id)}?${params}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader' }), readJson: true,
      });
      if (updated?.role && updated.role !== 'reader') {
        throw new Error(`Не удалось ограничить доступ ${address} только чтением.`);
      }
    }
    return { permissionId: existing.id || '', created: false, email: address };
  }

  const params = new URLSearchParams({ supportsAllDrives: 'true', sendNotificationEmail: 'false' });
  const created = await request(`/files/${encodeURIComponent(rootFolderId)}/permissions?${params}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'user', role: 'reader', emailAddress: address }), readJson: true,
  });
  if (!created?.id) throw new Error('Google Drive не подтвердил выдачу доступа к корневой папке.');
  return { permissionId: created.id, created: true, email: address };
}

export async function revokeRootFolderAccess(rootFolderId, permission) {
  if (!rootFolderId || !permission?.created || !permission.permissionId) return;
  const params = new URLSearchParams({ supportsAllDrives: 'true' });
  await driveFetch(`/files/${encodeURIComponent(rootFolderId)}/permissions/${encodeURIComponent(permission.permissionId)}?${params}`, { method: 'DELETE' });
}

export async function discoverDriveFriends(user, configuredRootFolderId = '', api = {}, knownFriends = []) {
  const request = api.driveFetch || driveFetch;
  const download = api.downloadDriveJsonFile || downloadDriveJsonFile;
  const findCatalog = api.findDriveCatalogFile || findDriveCatalogFile;
  const ownEmail = normalizeEmail(user?.email || user?.emailAddress);
  const diagnostics = [];
  const note = (stage, detail) => {
    if (diagnostics.length < 30) diagnostics.push(`[${stage}] ${String(detail || '').slice(0, 240)}`);
  };
  const friends = new Map();
  const byEmail = new Map();
  const add = (friend) => {
    if (!friend || (!friend.uid && !friend.email)) return;
    const email = normalizeEmail(friend.email);
    const existingByEmail = email ? byEmail.get(email) : null;
    if (friend.uid && existingByEmail && String(existingByEmail.uid).startsWith('email:')) {
      friends.delete(existingByEmail.uid);
      existingByEmail.uid = friend.uid;
      friends.set(friend.uid, existingByEmail);
    }
    const key = friend.uid || existingByEmail?.uid || `email:${email}`;
    const current = friends.get(key) || {
      uid: friend.uid || `email:${email}`,
      displayName: friend.displayName || email || 'Участник',
      email,
      inbound: false,
      outbound: false,
      isAdmin: false,
    };
    current.inbound ||= friend.inbound === true;
    current.outbound ||= friend.outbound === true;
    if (friend.inbound && friend.uid) current.uid = friend.uid;
    if (friend.catalogId) current.catalogId = friend.catalogId;
    if (friend.displayName && (!current.displayName || current.displayName === current.email || isEmailPrefixName(current.displayName, current.email))) current.displayName = friend.displayName;
    if (email) {
      current.email = email;
      byEmail.set(email, current);
    }
    friends.set(key, current);
    return current;
  };

  let rootFolderId = configuredRootFolderId || '';
  if (!rootFolderId && user?.uid) {
    try {
      const ownCatalog = await findCatalog(user.uid);
      if (ownCatalog) {
        const catalog = await download(ownCatalog.id);
        if (catalog?.ownerUid === user.uid && typeof catalog.rootFolderId === 'string') rootFolderId = catalog.rootFolderId;
      }
    } catch (error) {
      note('own-catalog', `Не удалось определить свою корневую папку по каталогу: ${error?.message || error}`);
    }
  }

  let driveDiscoveryErrors = [];
  let catalogDiscoveryFailed = false;
  // Discover incoming libraries from published catalog files instead of enumerating shared folders.
  // This avoids scanning hundreds or thousands of ordinary folders before finding a library.

  // Do not rely solely on sharedWithMe: Drive can omit an accessible shared root
  // from that listing. Find published catalogs directly, then validate their owner
  // and root folder from the catalog payload and Drive metadata.
  try {
    const catalogFiles = await listSharedCatalogFiles(request);
    note('catalog-search', `Прямой поиск по имени ${SHARED_CATALOG_FILE_NAME} вернул ${catalogFiles.length} доступных файлов: ${catalogFiles.map((file) => `${file.name || '(без имени)'} [${file.id}; MIME=${file.mimeType || '?'}; parents=${(file.parents || []).join(',') || '(нет)'}]`).join('; ') || '(пусто)'}; полный перебор папок не выполнялся.`);
    for (const file of catalogFiles) {
      if (file.mimeType !== 'application/json') { note('catalog-file-skip', `Файл ${file.id} имеет MIME ${file.mimeType || 'не указан'}, ожидался application/json.`); continue; }
      let catalog;
      try { catalog = await download(file.id); }
      catch (error) {
        note('catalog-download-error', `Файл ${file.id}: HTTP ${error?.status || '?'}; ${error?.message || error}`);
        continue;
      }
      if (!catalog || typeof catalog.ownerUid !== 'string' || !catalog.ownerUid
          || catalog.ownerUid === user?.uid || catalog.rootFolderId === rootFolderId || !catalog.rootFolderId
          || !(file.parents || []).includes(catalog.rootFolderId)) {
        note('catalog-validation', `Файл ${file.id} отклонён: ${!catalog ? 'пустой JSON' : !catalog.ownerUid ? 'нет ownerUid' : catalog.ownerUid === user.uid ? 'это собственный каталог' : !catalog.rootFolderId ? 'нет rootFolderId' : 'rootFolderId отсутствует в parents файла'}.`);
        continue;
      }
      let root = null;
      let rootReadError = null;
      try { root = await getRootFolder(catalog.rootFolderId, request); }
      catch (error) {
        if (error?.status === 403 || error?.status === 404) rootReadError = error;
        else throw error;
      }
      // Drive may expose the shared catalog file while denying metadata reads on
      // its parent folder. The catalog's parents + rootFolderId already bind it
      // to that folder; match ownerUid against the in-memory friend list rather
      // than dropping a valid library because a separate folder metadata read failed.
      const knownContact = (Array.isArray(knownFriends) ? knownFriends : []).find((friend) =>
        friend?.uid && String(friend.uid) === catalog.ownerUid);
      // When folder metadata is unavailable, use the catalog file's Drive owner metadata
      // or a known friend UID. Do not require a broad folder listing or Firestore contact.
      const catalogOwner = (file.owners || []).find((item) => normalizeEmail(item.emailAddress)) || file.owners?.[0] || {};
      const knownOwner = knownContact || (catalogOwner.emailAddress || catalogOwner.displayName ? {
        uid: catalog.ownerUid, email: catalogOwner.emailAddress || '', displayName: catalogOwner.displayName || '',
      } : null);
      const effectiveOwnerEmail = normalizeEmail(root?.owners?.find((item) => normalizeEmail(item.emailAddress))?.emailAddress)
        || normalizeEmail(knownOwner?.email);
      if (effectiveOwnerEmail && effectiveOwnerEmail === ownEmail) {
        note('catalog-validation', `Файл ${file.id} отклонён: каталог принадлежит текущему Google Drive аккаунту (${ownEmail}).`);
        continue;
      }
      if (rootReadError) note('catalog-root-metadata-unavailable', `Каталог ${file.id} доступен, но метаданные корневой папки ${catalog.rootFolderId} недоступны (HTTP ${rootReadError.status}); ${knownOwner ? 'владелец сопоставлен по данным Google Drive.' : 'в доступных данных Google Drive нет сведений о владельце.'}`);
      if (root && root.mimeType !== FOLDER_MIME_TYPE) {
        note('catalog-root-invalid', `Корень ${catalog.rootFolderId} каталога ${file.id} не является папкой: MIME=${root.mimeType || 'не указан'}.`);
        continue;
      }
      note('catalog-root-match', `Каталог ${file.id}: UID владельца ${catalog.ownerUid}; корень ${catalog.rootFolderId}; метаданные ${root ? 'доступны' : 'недоступны, использован известный друг'}.`);
      const owner = (root?.owners || []).find((item) => normalizeEmail(item.emailAddress)) || root?.owners?.[0] || {};
      const ownerEmail = normalizeEmail(owner.emailAddress) || normalizeEmail(knownOwner?.email) || '';
      add({
        uid: catalog.ownerUid,
        email: ownerEmail,
        displayName: catalog.ownerDisplayName || owner.displayName || knownOwner?.displayName || root?.name || ownerEmail || 'Участник',
        isAdmin: catalog.ownerUid === 'aA89pCYsKNbWWePmAveUVrG34F82',
        inbound: true,
        catalogId: file.id,
      });
    }
  } catch (error) {
    catalogDiscoveryFailed = true;
    driveDiscoveryErrors.push(`Не удалось найти опубликованные каталоги друзей: ${error?.message || error}`);
  }

  if (rootFolderId) {
    try {
      const root = await getRootFolder(rootFolderId, request);
      if (root?.mimeType === FOLDER_MIME_TYPE) {
        const permissions = await listPermissions(rootFolderId, request);
        for (const permission of permissions) {
        if (permission.deleted || permission.type !== 'user') continue;
        const email = normalizeEmail(permission.emailAddress);
        if (!email || email === ownEmail || permission.role === 'owner') continue;
        const existing = byEmail.get(email);
        if (existing) {
          existing.outbound = true;
          continue;
        }
          add({ uid: '', email, displayName: permission.displayName || email, outbound: true });
        }
      }
    } catch (error) {
      driveDiscoveryErrors.push(`Не удалось прочитать права своей корневой папки: ${error?.message || error}`);
    }
  }

  if (!friends.size) note('result', `Поиск завершён: друзей не обнаружено. ${driveDiscoveryErrors.length ? 'Есть ошибки запросов.' : 'Запросы завершились без явной ошибки; проверьте результаты этапов выше.'}`);
  else note('result', `Поиск завершён: обнаружено ${friends.size} записей; inbound: ${[...friends.values()].filter((friend) => friend.inbound).length}, outbound: ${[...friends.values()].filter((friend) => friend.outbound).length}.`);

  return {
    rootFolderId,
    discoveryStatus: catalogDiscoveryFailed ? 'error' : 'ready',
    errors: [...driveDiscoveryErrors, ...diagnostics],
    friends: [...friends.values()]
      .filter((friend) => friend.inbound || friend.outbound)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru') || a.uid.localeCompare(b.uid)),
  };
}

import { SHARED_CATALOG_FILE_NAME, FOLDER_MIME_TYPE } from './config.js';
import { driveFetch, downloadDriveJsonFile, findDriveCatalogFile } from './drive.js?v=20261109-drive-error-diagnostics';
import { ensureDriveFolderAuthorized, forgetDriveItemAuthorization } from './google-picker.js?v=20261109-picker-exact-folder';

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

// Make the folder checkbox control real Google Drive access as well as catalog visibility.
// Limited access blocks permissions inherited from the shared root; direct grants remain separate.
export async function syncFolderSharingAccess(index, settings, api = {}) {
  const request = api.driveFetch || driveFetch;
  const authorizeFolder = api.authorizeFolder || ensureDriveFolderAuthorized;
  const forgetFolderAuthorization = api.forgetFolderAuthorization || forgetDriveItemAuthorization;
  const excluded = new Set(settings?.sharing?.excludedFolderIds || []);
  const changed = [];
  try {
    for (const folder of index.folders.filter((item) => item.parentId === index.rootFolderId)) {
      const desired = excluded.has(folder.id);
      const params = new URLSearchParams({ fields: 'id,mimeType,inheritedPermissionsDisabled,capabilities(canDisableInheritedPermissions,canEnableInheritedPermissions)', supportsAllDrives: 'true' });
      let current;
      try {
        current = await request(`/files/${encodeURIComponent(folder.id)}?${params}`, {
          readJson: true,
          diagnostics: { stage: 'folder-sharing-metadata', folderId: folder.id, folderName: folder.name },
        });
      } catch (error) {
        // With drive.file, a folder may be invisible until the user selects that exact folder in Picker.
        // Authorize on the first 403, then repeat the metadata read before deciding whether to PATCH.
        if (error?.status !== 403) throw error;
        // A previous Picker selection may have been recorded even though Drive
        // still rejected the API call. Invalidate it before asking the user again.
        forgetFolderAuthorization(folder.id);
        await authorizeFolder({ id: folder.id, name: folder.name, mimeType: FOLDER_MIME_TYPE, isFolder: true });
        try {
          current = await request(`/files/${encodeURIComponent(folder.id)}?${params}`, {
            readJson: true,
            diagnostics: { stage: 'folder-sharing-metadata-after-picker', folderId: folder.id, folderName: folder.name },
          });
        } catch (retryError) {
          if (retryError?.status === 403) forgetFolderAuthorization(folder.id);
          throw retryError;
        }
      }
      if (current.mimeType !== FOLDER_MIME_TYPE) throw new Error(`«${folder.name}» больше не является папкой Google Drive.`);
      const previous = current.inheritedPermissionsDisabled === true;
      if (previous === desired) continue;
      const canChange = desired ? current.capabilities?.canDisableInheritedPermissions : current.capabilities?.canEnableInheritedPermissions;
      if (canChange === false) throw new Error(`Google Drive не разрешает изменить наследование доступа к папке «${folder.name}». Проверьте права владельца папки.`);
      // drive.file does not imply authorization of descendant folders when only the root was picked.
      await authorizeFolder({ id: folder.id, name: folder.name, mimeType: FOLDER_MIME_TYPE, isFolder: true });
      const updateParams = new URLSearchParams({ fields: 'id,inheritedPermissionsDisabled', supportsAllDrives: 'true' });
      try {
        await request(`/files/${encodeURIComponent(folder.id)}?${updateParams}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inheritedPermissionsDisabled: desired }), readJson: true,
          diagnostics: { stage: 'folder-sharing-update', folderId: folder.id, folderName: folder.name },
        });
      } catch (updateError) {
        if (updateError?.status === 403) forgetFolderAuthorization(folder.id);
        throw updateError;
      }
      changed.push({ id: folder.id, previous });
    }
  } catch (error) {
    // Do not leave a partially applied settings change if Drive rejects one folder.
    for (const item of changed.reverse()) {
      try {
        const params = new URLSearchParams({ supportsAllDrives: 'true' });
        await request(`/files/${encodeURIComponent(item.id)}?${params}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inheritedPermissionsDisabled: item.previous }), readJson: true,
        });
      } catch { /* preserve the original failure; the next save can reconcile access */ }
    }
    const diagnostic = [
      error?.stage ? `stage: ${error.stage}` : '',
      error?.status ? `HTTP ${error.status}` : '',
      error?.reason ? `причина: ${error.reason}` : '',
      error?.apiMessage ? `ответ Google: ${error.apiMessage}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(`Не удалось применить ограничения доступа в Google Drive. Настройки не сохранены. ${diagnostic || error?.message || error}`);
  }
  return changed;
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

// Revoke the selected friend's direct permission on the owner's root folder using Drive only.
// Sharing controls never open Picker automatically: a 403 must be reported as a failed operation.
export async function closeRootFolderAccess(rootFolderId, email, api = {}) {
  const request = api.driveFetch || driveFetch;
  const address = normalizeEmail(email);
  if (!rootFolderId) throw new Error('Не удалось определить корневую папку библиотеки. Обновите библиотеку и повторите попытку.');
  if (!address) throw new Error('У этого друга не указан email, поэтому закрыть доступ автоматически нельзя.');

  const permissions = await listPermissions(rootFolderId, request);
  const matching = permissions.filter((permission) => !permission.deleted
    && permission.type === 'user' && normalizeEmail(permission.emailAddress) === address
    && permission.role !== 'owner');
  if (!matching.length) return { revoked: false, email: address };
  for (const permission of matching) {
    const inherited = (permission.permissionDetails || []).some((detail) => detail.inherited === true);
    if (inherited) {
      throw new Error('Доступ ' + address + ' наследуется от родительской папки Google Drive. Его нужно закрыть на уровне родительской папки.');
    }
  }
  for (const permission of matching) {
    const params = new URLSearchParams({ supportsAllDrives: 'true' });
    const path = '/files/' + encodeURIComponent(rootFolderId) + '/permissions/' + encodeURIComponent(permission.id) + '?' + params;
    await request(path, { method: 'DELETE' });
  }
  return { revoked: true, email: address };
}

export async function discoverDriveFriends(user, configuredRootFolderId = '', api = {}, knownFriends = []) {
  // Friend discovery must always settle promptly so the settings page cannot remain
  // on “Список друзей загружается…” indefinitely when Drive is throttling or stalled.
  // Keep the normal Drive retry policy everywhere else; use a bounded policy only
  // for this read-only discovery flow and preserve injected test/API adapters.
  const request = api.driveFetch || ((path, options = {}) => driveFetch(path, {
    ...options,
    diagnostics: { ...options.diagnostics, timeoutMs: 12000, maxRetries: 1, stage: 'friend-discovery' },
  }));
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
          const driveName = String(permission.displayName || '').trim();
          if (driveName && (!existing.displayName || existing.displayName === existing.email || isEmailPrefixName(existing.displayName, existing.email))) {
            existing.displayName = driveName;
          }
          continue;
        }
        // Keep outbound status for a person already known as a registered friend,
        // even when they have not shared their own catalog with us. Unknown Drive
        // permissions alone must not create Friends rows.
        const knownFriend = (Array.isArray(knownFriends) ? knownFriends : []).find((friend) =>
          friend?.uid && !String(friend.uid).startsWith('email:')
          && normalizeEmail(friend.email) === email);
        if (knownFriend) {
          add({ ...knownFriend, email, inbound: knownFriend.inbound === true, outbound: true });
        }

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
      .filter((friend) => friend.inbound || (friend.outbound && (Array.isArray(knownFriends) ? knownFriends : []).some((known) =>
        known?.uid && String(known.uid) === String(friend.uid))))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru') || a.uid.localeCompare(b.uid)),
  };
}

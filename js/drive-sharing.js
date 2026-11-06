import { SHARED_CATALOG_FILE_NAME, FOLDER_MIME_TYPE } from './config.js';
import { driveFetch, downloadDriveJsonFile, findDriveCatalogFile } from './drive.js';

const normalizeEmail = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
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
    fields: 'nextPageToken,files(id,name,mimeType,parents)',
    pageSize: '100',
    spaces: 'drive',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  return listPages('/files', params, request);
}

async function listSharedFolders(request = driveFetch) {
  const params = new URLSearchParams({
    q: `sharedWithMe = true and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`,
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
    fields: 'nextPageToken,permissions(id,type,emailAddress,displayName,role,deleted)',
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
  if (existing) return { permissionId: existing.id || '', created: false, email: address };

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

export async function discoverDriveFriends(user, configuredRootFolderId = '', api = {}) {
  const request = api.driveFetch || driveFetch;
  const download = api.downloadDriveJsonFile || downloadDriveJsonFile;
  const findCatalog = api.findDriveCatalogFile || findDriveCatalogFile;
  const ownEmail = normalizeEmail(user?.email);
  const friends = new Map();
  const byEmail = new Map();
  const add = (friend) => {
    if (!friend || (!friend.uid && !friend.email)) return;
    const email = normalizeEmail(friend.email);
    const key = friend.uid || `email:${email}`;
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
    if (friend.displayName && (!current.displayName || current.displayName === current.email)) current.displayName = friend.displayName;
    if (email) {
      current.email = email;
      byEmail.set(email, current);
    }
    friends.set(key, current);
    return current;
  };

  let rootFolderId = configuredRootFolderId || '';
  if (!rootFolderId) {
    try {
      const ownCatalog = await findCatalog(user?.uid);
      if (ownCatalog) {
        const catalog = await download(ownCatalog.id);
        if (catalog?.ownerUid === user.uid && typeof catalog.rootFolderId === 'string') rootFolderId = catalog.rootFolderId;
      }
    } catch { /* A known configured root can still be inspected if catalog discovery fails. */ }
  }

  let driveDiscoveryErrors = [];
  let sharedFolders = [];
  try { sharedFolders = await listSharedFolders(request); }
  catch (error) { driveDiscoveryErrors.push(`Не удалось найти папки, которыми поделились с вами: ${error?.message || error}`); }
  for (const folder of sharedFolders) {
    if (folder.id === rootFolderId) continue;
    let catalogFile;
    try { catalogFile = await getRootCatalog(folder.id, request); }
    catch (error) {
      if (error?.status === 403 || error?.status === 404) continue;
      throw error;
    }
    if (!catalogFile) continue;
    let catalog;
    try { catalog = await download(catalogFile.id); }
    catch (error) {
      if (error?.status === 403 || error?.status === 404) continue;
      throw error;
    }
    if (!catalog || typeof catalog.ownerUid !== 'string' || !catalog.ownerUid
        || catalog.ownerUid === user.uid || catalog.rootFolderId !== folder.id) continue;
    const owner = (folder.owners || []).find((item) => normalizeEmail(item.emailAddress)) || folder.owners?.[0] || {};
    add({
      uid: catalog.ownerUid,
      email: owner.emailAddress || '',
      displayName: owner.displayName || folder.name || 'Участник',
      isAdmin: catalog.ownerUid === 'aA89pCYsKNbWWePmAveUVrG34F82',
      inbound: true,
    });
  }

  // Do not rely solely on sharedWithMe: Drive can omit an accessible shared root
  // from that listing. Find published catalogs directly, then validate their owner
  // and root folder from the catalog payload and Drive metadata.
  try {
    const catalogFiles = await listSharedCatalogFiles(request);
    for (const file of catalogFiles) {
      if (file.mimeType !== 'application/json') continue;
      let catalog;
      try { catalog = await download(file.id); }
      catch (error) {
        if (error?.status === 403 || error?.status === 404) continue;
        throw error;
      }
      if (!catalog || typeof catalog.ownerUid !== 'string' || !catalog.ownerUid
          || catalog.ownerUid === user.uid || !catalog.rootFolderId
          || !(file.parents || []).includes(catalog.rootFolderId)) continue;
      let root;
      try { root = await getRootFolder(catalog.rootFolderId, request); }
      catch (error) {
        if (error?.status === 403 || error?.status === 404) continue;
        throw error;
      }
      if (root?.mimeType !== FOLDER_MIME_TYPE) continue;
      const owner = (root.owners || []).find((item) => normalizeEmail(item.emailAddress)) || root.owners?.[0] || {};
      add({
        uid: catalog.ownerUid,
        email: owner.emailAddress || '',
        displayName: owner.displayName || root.name || 'Участник',
        isAdmin: catalog.ownerUid === 'aA89pCYsKNbWWePmAveUVrG34F82',
        inbound: true,
      });
    }
  } catch (error) {
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

  if (!sharedFolders.length && ![...friends.values()].some((friend) => friend.inbound)
      && !driveDiscoveryErrors.some((error) => error.startsWith('Не удалось найти папки'))) {
    driveDiscoveryErrors.push('Google Drive не обнаружил папок, которыми поделились с текущим аккаунтом. Проверьте, что друзья предоставили доступ именно тому Google-аккаунту, под которым вы вошли на сайт.');
  }


  return {
    rootFolderId,
    errors: driveDiscoveryErrors,
    friends: [...friends.values()]
      .filter((friend) => friend.inbound || friend.outbound)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru') || a.uid.localeCompare(b.uid)),
  };
}

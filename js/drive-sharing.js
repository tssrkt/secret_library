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

  const sharedFolders = await listSharedFolders(request);
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

  if (rootFolderId) {
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
  }

  return {
    rootFolderId,
    friends: [...friends.values()]
      .filter((friend) => friend.inbound || friend.outbound)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru') || a.uid.localeCompare(b.uid)),
  };
}

import { USER_SETTINGS_FILE_NAME } from './config.js';
import { listAppDataFiles, downloadAppDataFile, createAppDataFile, updateAppDataFile } from './drive.js';

async function readStoredSettings({ list = listAppDataFiles, download = downloadAppDataFile } = {}) {
  const files = await list(USER_SETTINGS_FILE_NAME);
  if (!files.length) return { fileId: null, value: { version: 1 } };
  const response = await download(files[0].id);
  let value;
  try { value = await response.json(); }
  catch { throw new Error('Не удалось прочитать файл настроек: некорректный JSON.'); }
  if (!value || value.version !== 1) throw new Error('Файл настроек имеет неподдерживаемый формат.');
  return { fileId: files[0].id, value };
}

export async function loadRootFolderPreference(api = {}) {
  const { value } = await readStoredSettings(api);
  return typeof value.activeRootFolderId === 'string' && value.activeRootFolderId ? value.activeRootFolderId : null;
}

export async function loadRootFolderResourceKey(api = {}) {
  const { value } = await readStoredSettings(api);
  return typeof value.activeRootFolderResourceKey === 'string' ? value.activeRootFolderResourceKey : '';
}

export async function saveRootFolderPreference(rootFolderId, resourceKey = '', api = {}) {
  if (typeof rootFolderId !== 'string' || !rootFolderId.trim()) throw new Error('Не выбрана корневая папка Google Drive.');
  const { fileId, value } = await readStoredSettings(api);
  const next = JSON.stringify({ ...value, version: 1, activeRootFolderId: rootFolderId, activeRootFolderResourceKey: resourceKey });
  const saved = fileId
    ? await (api.update || updateAppDataFile)(fileId, next)
    : await (api.create || createAppDataFile)(USER_SETTINGS_FILE_NAME, next);
  return saved.id;
}

export function sharingFolders(index) {
  return index.folders.filter((folder) => folder.parentId === index.rootFolderId);
}

export function normalizeUserSettings(settings, index) {
  const excluded = settings?.version === 1 && settings.rootFolderId === index.rootFolderId
    && Array.isArray(settings.sharing?.excludedFolderIds) ? settings.sharing.excludedFolderIds : [];
  const ids = new Set(excluded.filter((id) => typeof id === 'string'));
  const folderNotes = Object.fromEntries(Object.entries(settings?.folderNotes || {})
    .filter(([folderId, note]) => typeof folderId === 'string' && typeof note === 'string' && note.trim())
    .map(([folderId, note]) => [folderId, note.trim()]));
  return {
    version: 1,
    rootFolderId: index.rootFolderId,
    activeRootFolderId: typeof settings?.activeRootFolderId === 'string' ? settings.activeRootFolderId : null,
    activeRootFolderResourceKey: typeof settings?.activeRootFolderResourceKey === 'string' ? settings.activeRootFolderResourceKey : '',
    sharing: { excludedFolderIds: [...new Set(sharingFolders(index).map((folder) => folder.id))].filter((id) => ids.has(id)) },
    folderNotes,
  };
}

export async function loadUserSettings(index, api = {}) {
  const { fileId, value } = await readStoredSettings(api);
  return { fileId, settings: normalizeUserSettings(value, index) };
}

export async function saveUserSettings(settings, index, fileId = null, {
  create = createAppDataFile, update = updateAppDataFile,
} = {}) {
  const json = JSON.stringify(normalizeUserSettings(settings, index));
  const saved = fileId ? await update(fileId, json) : await create(USER_SETTINGS_FILE_NAME, json);
  return saved.id;
}

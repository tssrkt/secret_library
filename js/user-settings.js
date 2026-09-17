import { USER_SETTINGS_FILE_NAME } from './config.js';
import { listAppDataFiles, downloadAppDataFile, createAppDataFile, updateAppDataFile } from './drive.js';

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
    sharing: { excludedFolderIds: [...new Set(sharingFolders(index).map((folder) => folder.id))].filter((id) => ids.has(id)) },
    // Notes deliberately live beside sharing preferences, not in the rebuilt Drive index.
    folderNotes,
  };
}

export async function loadUserSettings(index, {
  list = listAppDataFiles, download = downloadAppDataFile,
} = {}) {
  const files = await list(USER_SETTINGS_FILE_NAME);
  if (!files.length) return { fileId: null, settings: normalizeUserSettings(null, index) };
  const response = await download(files[0].id);
  let settings;
  try { settings = await response.json(); }
  catch { throw new Error('Не удалось прочитать файл настроек: некорректный JSON.'); }
  if (!settings || settings.version !== 1) throw new Error('Файл настроек имеет неподдерживаемый формат.');
  return { fileId: files[0].id, settings: normalizeUserSettings(settings, index) };
}

export async function saveUserSettings(settings, index, fileId = null, {
  create = createAppDataFile, update = updateAppDataFile,
} = {}) {
  const json = JSON.stringify(normalizeUserSettings(settings, index));
  const saved = fileId ? await update(fileId, json) : await create(USER_SETTINGS_FILE_NAME, json);
  return saved.id;
}

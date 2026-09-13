import { BUILDING_INDEX_FILE_NAME, INDEX_FILE_NAME, INDEX_VERSION } from './config.js';
import {
  createAppDataFile, deleteAppDataFile, downloadAppDataFile, listAppDataFiles, updateAppDataFile,
} from './drive.js';

export class IndexError extends Error {
  constructor(message, code = 'index_error', fileId = null) {
    super(message);
    this.name = 'IndexError';
    this.code = code;
    this.fileId = fileId;
  }
}

export function validateIndex(index, rootFolderId) {
  if (!index || ![1, 2, 3, INDEX_VERSION].includes(index.version) || index.rootFolderId !== rootFolderId
      || !Array.isArray(index.folders) || !Array.isArray(index.books)) {
    throw new IndexError('Сохраненный индекс поврежден или имеет несовместимый формат.', 'invalid_index');
  }
  return index;
}

export function migrateIndex(index) {
  let migrated = index.version !== INDEX_VERSION;
  index.version = INDEX_VERSION;
  for (const book of index.books) {
    if (!book.sourceType) {
      book.sourceType = /\.(zip|epub|mobi)$/i.exec(book.fileName)?.[1].toLowerCase() || 'fb2';
      if (book.sourceType === 'zip' && !Object.hasOwn(book, 'entryPath')) book.entryPath = null;
      migrated = true;
    }
    if (!book.metadataStatus || book.metadataStatus === 'processing') {
      book.metadataStatus = 'pending';
      migrated = true;
    }
    if (book.metadataStatus === 'ready' && !Array.isArray(book.authors)) {
      book.authors = [];
      migrated = true;
    }
    if (!book.extension) {
      book.extension = book.sourceType;
      migrated = true;
    }
  }
  return { index, migrated };
}

export async function loadIndex(rootFolderId) {
  let files;
  try { files = await listAppDataFiles(INDEX_FILE_NAME); }
  catch (error) { throw new IndexError(`Не удалось проверить сохраненный индекс: ${error.message}`, 'index_read_failed'); }
  if (!files.length) return { index: null, fileId: null };

  try {
    const response = await downloadAppDataFile(files[0].id);
    const result = migrateIndex(validateIndex(await response.json(), rootFolderId));
    return { ...result, fileId: files[0].id };
  } catch (error) {
    if (error instanceof IndexError) {
      error.fileId = files[0].id;
      throw error;
    }
    throw new IndexError('Не удалось прочитать сохраненный индекс. Его можно построить заново.', 'index_read_failed', files[0].id);
  }
}

export async function saveIndex(index, fileId = null) {
  const json = JSON.stringify(index);
  try {
    const saved = fileId
      ? await updateAppDataFile(fileId, json)
      : await createAppDataFile(INDEX_FILE_NAME, json);
    return saved.id;
  } catch (error) {
    const wrapped = new IndexError(`Библиотека отсканирована, но сохранить индекс не удалось: ${error.message}`, 'index_write_failed');
    wrapped.status = error.status;
    wrapped.stage = 'index-write';
    wrapped.attempt = error.attempt;
    wrapped.retryResult = error.retryResult;
    if (error.code === 'unauthorized') wrapped.code = 'unauthorized';
    throw wrapped;
  }
}

export async function loadBuildingIndex(rootFolderId) {
  const files = await listAppDataFiles(BUILDING_INDEX_FILE_NAME);
  if (!files.length) return { index: null, fileId: null };
  try {
    const response = await downloadAppDataFile(files[0].id);
    const result = migrateIndex(validateIndex(await response.json(), rootFolderId));
    return { ...result, fileId: files[0].id };
  } catch {
    return { index: null, fileId: files[0].id };
  }
}

export async function saveBuildingIndex(index, fileId = null, {
  create = createAppDataFile,
  update = updateAppDataFile,
} = {}) {
  const json = JSON.stringify(index);
  const saved = fileId
    ? await update(fileId, json)
    : await create(BUILDING_INDEX_FILE_NAME, json);
  return saved.id;
}

export async function deleteBuildingIndex(fileId) {
  if (!fileId) return;
  try { await deleteAppDataFile(fileId); }
  catch (error) { if (error?.status !== 404) throw error; }
}

export async function readIndexFile(fileId, rootFolderId, download = downloadAppDataFile) {
  const response = await download(fileId);
  return validateIndex(await response.json(), rootFolderId);
}

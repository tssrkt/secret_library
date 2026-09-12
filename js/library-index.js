import { INDEX_FILE_NAME, INDEX_VERSION } from './config.js';
import { createAppDataFile, downloadAppDataFile, listAppDataFiles, updateAppDataFile } from './drive.js';

export class IndexError extends Error {
  constructor(message, code = 'index_error', fileId = null) {
    super(message);
    this.name = 'IndexError';
    this.code = code;
    this.fileId = fileId;
  }
}

function validateIndex(index, rootFolderId) {
  if (!index || ![1, INDEX_VERSION].includes(index.version) || index.rootFolderId !== rootFolderId
      || !Array.isArray(index.folders) || !Array.isArray(index.books)) {
    throw new IndexError('Сохраненный индекс поврежден или имеет несовместимый формат.', 'invalid_index');
  }
  return index;
}

export function migrateIndex(index) {
  let migrated = index.version !== INDEX_VERSION;
  index.version = INDEX_VERSION;
  for (const book of index.books) {
    if (!book.metadataStatus || book.metadataStatus === 'processing') {
      book.metadataStatus = 'pending';
      migrated = true;
    }
    if (book.metadataStatus === 'ready' && !Array.isArray(book.authors)) {
      book.authors = [];
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
    if (error.code === 'unauthorized') wrapped.code = 'unauthorized';
    throw wrapped;
  }
}

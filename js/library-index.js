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
  if (!index || index.version !== INDEX_VERSION || index.rootFolderId !== rootFolderId
      || !Array.isArray(index.folders) || !Array.isArray(index.books)) {
    throw new IndexError('Сохраненный индекс поврежден или имеет несовместимый формат.', 'invalid_index');
  }
  return index;
}

export async function loadIndex(rootFolderId) {
  let files;
  try { files = await listAppDataFiles(INDEX_FILE_NAME); }
  catch (error) { throw new IndexError(`Не удалось проверить сохраненный индекс: ${error.message}`, 'index_read_failed'); }
  if (!files.length) return { index: null, fileId: null };

  try {
    const response = await downloadAppDataFile(files[0].id);
    const index = validateIndex(await response.json(), rootFolderId);
    return { index, fileId: files[0].id };
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
    throw new IndexError(`Библиотека отсканирована, но сохранить индекс не удалось: ${error.message}`, 'index_write_failed');
  }
}

import { SHARED_CATALOG_FILE_NAME } from './config.js';
import {
  createDriveJsonFile, deleteDriveFile, downloadDriveJsonFile, findDriveCatalogFile, updateDriveJsonFile,
} from './drive.js';
import { loadSharedCover } from './shared-cover-cache.js';

// A read-only projection of the owner's index. Books remain in their original Drive folders.
export function sharedLibraryIndex(index, settings) {
  const excluded = new Set(settings?.sharing?.excludedFolderIds || []);
  const childrenByParent = new Map();
  for (const folder of index.folders) {
    if (!childrenByParent.has(folder.parentId)) childrenByParent.set(folder.parentId, []);
    childrenByParent.get(folder.parentId).push(folder);
  }
  const allowed = new Set();
  const queue = [...(childrenByParent.get(index.rootFolderId) || [])];
  for (let head = 0; head < queue.length; head++) {
    const folder = queue[head];
    if (excluded.has(folder.id) || allowed.has(folder.id)) continue;
    allowed.add(folder.id);
    queue.push(...(childrenByParent.get(folder.id) || []));
  }
  const fields = ['id', 'parentId', 'fileName', 'extension', 'sourceType', 'size', 'modifiedTime', 'metadataStatus',
    'metadataVersion', 'title', 'authors', 'genres', 'series', 'seriesNumber', 'annotation', 'preview', 'language'];
  const projectBook = (book) => Object.fromEntries(fields.filter((field) => book[field] !== undefined).map((field) => [field, book[field]]));
  const folderNotes = Object.fromEntries(Object.entries(settings?.folderNotes || {})
    .filter(([folderId, note]) => allowed.has(folderId) && typeof note === 'string' && note.trim())
    .map(([folderId, note]) => [folderId, note.trim()]));
  return {
    version: index.version, rootFolderId: index.rootFolderId, updatedAt: index.updatedAt || '', folderNotes,
    folders: index.folders.filter((folder) => folder.id === index.rootFolderId || allowed.has(folder.id))
      .map(({ id, parentId, name }) => ({ id, parentId, name })),
    books: index.books.filter((book) => book.parentId === index.rootFolderId || allowed.has(book.parentId)).map(projectBook),
  };
}

async function signatureOf(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createSharedLibraryStore({ user }) {
  let disposed = false;
  let queue = Promise.resolve();
  const catalogIds = new Map();
  const ensureCurrent = () => { if (disposed) throw new Error('Сеанс завершён.'); };
  async function findCatalog(owner) {
    const cached = catalogIds.get(owner);
    if (cached) return { id: cached, cached: true };
    const file = await findDriveCatalogFile(owner);
    if (!file) throw new Error('Не найден опубликованный каталог библиотеки в доступных файлах Google Drive. Владелец должен открыть свою библиотеку в обновлённой версии сайта, чтобы каталог создался в корневой папке, и предоставить вам доступ к этой папке.');
    catalogIds.set(owner, file.id);
    return { ...file, cached: false };
  }
  return {
    dispose() { disposed = true; catalogIds.clear(); },
    publish(index, settings) {
      const task = async () => {
        ensureCurrent();
        const projection = sharedLibraryIndex(index, settings);
        const signature = await signatureOf(projection);
        const catalog = JSON.stringify({ ...projection, ownerUid: user.uid, signature });
        let existing = await findDriveCatalogFile(user.uid);
        if (existing && !existing.parents?.includes(index.rootFolderId)) {
          await deleteDriveFile(existing.id);
          existing = null;
        }
        if (existing) {
          const current = await downloadDriveJsonFile(existing.id);
          if (current?.signature === signature && current.rootFolderId === index.rootFolderId) {
            catalogIds.set(user.uid, existing.id);
            return { fileId: existing.id, revision: signature };
          }
        }
        ensureCurrent();
        if (existing) await updateDriveJsonFile(existing.id, catalog);
        else existing = await createDriveJsonFile(SHARED_CATALOG_FILE_NAME, index.rootFolderId, catalog, user.uid);
        catalogIds.set(user.uid, existing.id);
        return { fileId: existing.id, revision: signature };
      };
      queue = queue.catch(() => {}).then(task);
      return queue;
    },
    unpublish() {
      const task = async () => {
        ensureCurrent();
        const existing = await findDriveCatalogFile(user.uid);
        if (existing) await deleteDriveFile(existing.id);
        catalogIds.delete(user.uid);
      };
      queue = queue.catch(() => {}).then(task);
      return queue;
    },
    async load(owner) {
      ensureCurrent();
      let file = await findCatalog(owner);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Direct Google Drive read. There is no Firestore manifest/catalog request here.
          const index = await downloadDriveJsonFile(file.id);
          ensureCurrent();
          if (index.ownerUid !== owner || !Array.isArray(index.books) || !Array.isArray(index.folders) || !index.rootFolderId
              || typeof index.signature !== 'string') throw new Error('Каталог библиотеки повреждён или не соответствует владельцу.');
          return index;
        } catch (error) {
          if (attempt === 0 && file.cached && (error?.status === 403 || error?.status === 404)) {
            catalogIds.delete(owner);
            file = await findCatalog(owner);
            continue;
          }
          if (error?.status === 403 || error?.status === 404) catalogIds.delete(owner);
          throw error;
        }
      }
      throw new Error('Не удалось загрузить каталог из Google Drive.');
    },
    loadCover(owner, book) {
      ensureCurrent();
      if (!owner || !book?.id) return Promise.resolve(null);
      return loadSharedCover(owner, book);
    },
  };
}

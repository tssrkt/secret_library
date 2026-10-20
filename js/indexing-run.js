import { scanLibrary, classifyLibraryItem } from './library-tree.js';
import { getLibraryFile } from './drive.js';
import { canResumeBuildingIndex, prepareBuildingIndex } from './index-build.js';
import { BOOK_SOURCE_TYPES, FOLDER_MIME_TYPE } from './config.js';
import { libraryFilePath } from './library-path.js';

export async function prepareIndexingRun(active, { mode, building = null, scan = scanLibrary, signal, onScan = () => {}, previousIndex = null }) {
  if (!['full', 'retry', 'refresh'].includes(mode)) throw new Error('Unknown indexing mode.');
  const scannedIndex = mode === 'full' ? await scan(active.rootFolderId, onScan, { signal }) : undefined;
  signal?.throwIfAborted();
  return canResumeBuildingIndex(building, active, { mode, scannedIndex }) ? building
    : prepareBuildingIndex(active, { mode, scannedIndex, previousIndex });
}

export function createRetryEligibilityCheck(index, { getFile = getLibraryFile, signal } = {}) {
  const folders = new Map();
  const folderKeys = new Map((index.folders || []).map((item) => [item.id, item.resourceKey]));
  const parentsOf = (item, id) => {
    if (!Array.isArray(item?.parents) || item.parents.some((parent) => typeof parent !== 'string' || !parent.trim())) {
      throw Object.assign(new Error('Google Drive did not return a valid file parent chain.'),
      { code: 'incomplete_parent_metadata', stage: 'metadata', fileId: id });
    }
    return item.parents;
  };
  const folder = (id) => {
    if (!folders.has(id)) folders.set(id, getFile(id, signal, folderKeys.get(id)).catch((error) => { folders.delete(id); throw error; }));
    return folders.get(id);
  };
  return async (book) => {
    try {
      const file = await getFile(book.id, signal, book.resourceKey);
      if (file.trashed || !BOOK_SOURCE_TYPES.includes(classifyLibraryItem(file))) return false;
      const ancestors = [];
      let parent = parentsOf(file, book.id)[0] || null;
      const visited = new Set();
      while (parent && parent !== index.rootFolderId) {
        if (visited.has(parent)) throw Object.assign(new Error('Google Drive returned a cyclic parent chain.'),
          { code: 'invalid_parent_metadata', stage: 'metadata', fileId: book.id });
        visited.add(parent);
        const item = await folder(parent);
        if (item.trashed) return false;
        if (item.mimeType !== FOLDER_MIME_TYPE) throw Object.assign(new Error('Google Drive returned an invalid parent folder.'),
          { code: 'invalid_parent_metadata', stage: 'metadata', fileId: book.id });
        ancestors.push({ id: item.id, name: item.name, parentId: item.parents?.[0] || null,
          ...(item.resourceKey ? { resourceKey: item.resourceKey } : {}) });
        parent = parentsOf(item, parent)[0] || null;
      }
      if (parent !== index.rootFolderId) return false;
      for (const item of ancestors) {
        const existing = index.folders.find((value) => value.id === item.id);
        if (existing) Object.assign(existing, item); else index.folders.push(item);
      }
      Object.assign(book, { parentId: file.parents[0], fileName: file.name, size: file.size == null ? null : Number(file.size),
        modifiedTime: file.modifiedTime || null, md5Checksum: file.md5Checksum || null,
        sourceType: classifyLibraryItem(file), extension: classifyLibraryItem(file) });
      if (file.resourceKey) book.resourceKey = file.resourceKey;
      else delete book.resourceKey;
      const path = libraryFilePath(index, { ...book, path: null });
      if (path) book.path = path;
      else delete book.path;
      return true;
    } catch (error) {
      // Drive's 404 can mean either deleted or not visible to this account.
      // Keep the indexed record unless Drive returned affirmative metadata
      // proving that it is trashed or outside the configured library.
      throw error;
    }
  };
}

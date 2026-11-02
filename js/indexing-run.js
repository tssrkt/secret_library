import { scanLibrary, classifyLibraryItem } from './library-tree.js';
import { getLibraryFile } from './drive.js';
import { canResumeBuildingIndex, prepareBuildingIndex } from './index-build.js';
import { BOOK_SOURCE_TYPES, FOLDER_MIME_TYPE } from './config.js';
import { libraryFilePath } from './library-path.js';

export async function prepareIndexingRun(active, { mode, building = null, scan = scanLibrary, signal, onScan = () => {}, previousIndex = null,
  selectedBookIds } = {}) {
  if (!['full', 'retry', 'refresh'].includes(mode)) throw new Error('Unknown indexing mode.');
  if (selectedBookIds !== undefined && mode !== 'retry') throw Object.assign(new Error('Book IDs can be selected only for a retry.'), { code: 'invalid_retry_selection' });
  const scannedIndex = mode === 'full' ? await scan(active.rootFolderId, onScan, { signal }) : undefined;
  signal?.throwIfAborted();
  if (canResumeBuildingIndex(building, active, { mode, scannedIndex, selectedBookIds })) return building;
  if (building && mode === 'retry') {
    throw Object.assign(new Error('The saved checkpoint does not match the retry scope and current index.'),
      { code: 'retry_checkpoint_mismatch' });
  }
  return prepareBuildingIndex(active, { mode, scannedIndex, previousIndex, selectedBookIds });
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
      if (!file || file.id !== book.id) throw Object.assign(new Error('Google Drive returned metadata for a different or unidentified file.'),
        { code: 'incomplete_file_metadata', stage: 'metadata', fileId: book.id });
      if (typeof file.name !== 'string' || !file.name.trim()) throw Object.assign(new Error('Google Drive did not return the file name needed to verify its format.'),
        { code: 'incomplete_file_metadata', stage: 'metadata', fileId: book.id });
      if (file.trashed != null && typeof file.trashed !== 'boolean') throw Object.assign(new Error('Google Drive returned an invalid trashed state.'),
        { code: 'incomplete_file_metadata', stage: 'metadata', fileId: book.id });
      if (file.trashed === true) return false;
      if (!BOOK_SOURCE_TYPES.includes(classifyLibraryItem(file))) return false;
      const ancestors = [];
      const fileParents = parentsOf(file, book.id);
      if (!fileParents.length) return false;
      if (fileParents.length !== 1) throw Object.assign(new Error('Google Drive did not return one reliable parent for the indexed file.'),
        { code: 'incomplete_parent_metadata', stage: 'metadata', fileId: book.id });
      let parent = fileParents[0];
      const visited = new Set();
      while (parent && parent !== index.rootFolderId) {
        if (visited.has(parent)) throw Object.assign(new Error('Google Drive returned a cyclic parent chain.'),
          { code: 'invalid_parent_metadata', stage: 'metadata', fileId: book.id });
        visited.add(parent);
        const item = await folder(parent);
        if (!item || item.id !== parent || typeof item.name !== 'string' || !item.name.trim()) {
          throw Object.assign(new Error('Google Drive returned incomplete or mismatched parent-folder metadata.'),
            { code: 'incomplete_parent_metadata', stage: 'metadata', fileId: book.id });
        }
        if (item.trashed != null && typeof item.trashed !== 'boolean') throw Object.assign(new Error('Google Drive returned an invalid parent-folder trashed state.'),
          { code: 'incomplete_parent_metadata', stage: 'metadata', fileId: book.id });
        if (item.trashed === true) return false;
        if (item.mimeType !== FOLDER_MIME_TYPE) throw Object.assign(new Error('Google Drive returned an invalid parent folder.'),
          { code: 'invalid_parent_metadata', stage: 'metadata', fileId: book.id });
        ancestors.push({ id: item.id, name: item.name, parentId: item.parents?.[0] || null,
          ...(item.resourceKey ? { resourceKey: item.resourceKey } : {}) });
        const parentIds = parentsOf(item, parent);
        if (!parentIds.length) return false;
        if (parentIds.length > 1) throw Object.assign(new Error('Google Drive returned an ambiguous parent chain.'),
          { code: 'ambiguous_parent_metadata', stage: 'metadata', fileId: book.id });
        parent = parentIds[0];
      }
      if (parent !== index.rootFolderId) throw Object.assign(new Error('Google Drive did not confirm the path to the configured library root.'),
        { code: 'incomplete_parent_metadata', stage: 'metadata', fileId: book.id });
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
      // Drive's 404 and incomplete ancestry are not proof of removal.
      // Only an explicit ineligible result above may exclude this record.
      error.retryable = true;
      error.eligibilityUndetermined = true;
      error.stage ||= 'metadata';
      throw error;
    }
  };
}

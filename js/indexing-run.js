import { scanLibrary, classifyLibraryItem } from './library-tree.js';
import { getLibraryFile } from './drive.js';
import { canResumeBuildingIndex, prepareBuildingIndex } from './index-build.js';

export async function prepareIndexingRun(active, { mode, building = null, scan = scanLibrary, signal, onScan = () => {} }) {
  if (!['full', 'retry'].includes(mode)) throw new Error('Unknown indexing mode.');
  const scannedIndex = mode === 'full' ? await scan(active.rootFolderId, onScan, { signal }) : undefined;
  signal?.throwIfAborted();
  return canResumeBuildingIndex(building, active, { mode, scannedIndex }) ? building
    : prepareBuildingIndex(active, { mode, scannedIndex });
}

export function createRetryEligibilityCheck(index, { getFile = getLibraryFile, signal } = {}) {
  const folders = new Map();
  const folder = (id) => {
    if (!folders.has(id)) folders.set(id, getFile(id, signal).catch((error) => { folders.delete(id); throw error; }));
    return folders.get(id);
  };
  return async (book) => {
    try {
      const file = await getFile(book.id, signal);
      if (file.trashed || !['fb2', 'zip'].includes(classifyLibraryItem(file))) return false;
      const ancestors = [];
      let parent = file.parents?.[0];
      const visited = new Set();
      while (parent && parent !== index.rootFolderId && !visited.has(parent)) {
        visited.add(parent);
        const item = await folder(parent);
        if (item.trashed || classifyLibraryItem(item) !== 'folder') return false;
        ancestors.push({ id: item.id, name: item.name, parentId: item.parents?.[0] || null });
        parent = item.parents?.[0];
      }
      if (parent !== index.rootFolderId) return false;
      for (const item of ancestors) {
        const existing = index.folders.find((value) => value.id === item.id);
        if (existing) Object.assign(existing, item); else index.folders.push(item);
      }
      Object.assign(book, { parentId: file.parents[0], fileName: file.name, size: file.size == null ? null : Number(file.size),
        modifiedTime: file.modifiedTime || null, md5Checksum: file.md5Checksum || null,
        sourceType: classifyLibraryItem(file), extension: classifyLibraryItem(file) });
      return true;
    } catch (error) {
      if (error.status === 404 || (error.status === 403 && !error.retryable)) return false;
      throw error;
    }
  };
}

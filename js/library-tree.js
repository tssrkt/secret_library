import { FOLDER_MIME_TYPE, INDEX_VERSION, METADATA_VERSION, SCAN_CONCURRENCY } from './config.js';
import { getFolder, listFolderChildren } from './drive.js';

export function classifyLibraryItem(file) {
  if (file.mimeType === FOLDER_MIME_TYPE) return 'folder';
  if (/\.fb2$/i.test(file.name)) return 'fb2';
  if (/\.zip$/i.test(file.name) || ['application/zip', 'application/x-zip-compressed'].includes(file.mimeType)) return 'zip';
  return 'other';
}

export async function scanLibrary(rootFolderId, onProgress = () => {}) {
  const root = await getFolder(rootFolderId);
  const folders = [{ id: root.id, parentId: null, name: root.name }];
  const books = [];
  let pending = [root.id];
  let processedFolders = 0;

  while (pending.length) {
    const level = pending;
    pending = [];
    for (let offset = 0; offset < level.length; offset += SCAN_CONCURRENCY) {
      const batch = level.slice(offset, offset + SCAN_CONCURRENCY);
      const results = await Promise.all(batch.map(async (folderId) => ({
        folderId,
        children: await listFolderChildren(folderId),
      })));

      for (const { folderId, children } of results) {
        for (const item of children) {
          const parentId = item.parents?.[0] || folderId;
          const itemType = classifyLibraryItem(item);
          if (itemType === 'folder') {
            folders.push({ id: item.id, parentId, name: item.name });
            pending.push(item.id);
          } else if (['fb2', 'zip'].includes(itemType)) {
            books.push({
              id: item.id,
              parentId,
              fileName: item.name,
              extension: itemType,
              size: item.size == null ? null : Number(item.size),
              modifiedTime: item.modifiedTime || null,
              md5Checksum: item.md5Checksum || null,
              sourceType: itemType,
              ...(itemType === 'zip' ? { entryPath: null } : {}),
              metadataStatus: 'pending',
            });
          }
        }
        processedFolders += 1;
        onProgress({ processedFolders, discoveredFolders: folders.length - 1, books: books.length });
        await new Promise(requestAnimationFrame);
      }
    }
  }

  const now = new Date().toISOString();
  return { version: INDEX_VERSION, rootFolderId, createdAt: now, updatedAt: now, folders, books };
}

const METADATA_FIELDS = [
  'metadataStatus', 'title', 'authors', 'series', 'seriesNumber', 'annotation', 'metadataError',
  'metadataErrorMessage', 'entryPath', 'metadataWarning', 'genres', 'language', 'metadataVersion',
  'coverFileId', 'coverMimeType',
];

function isUnchanged(current, previous) {
  if ((current.sourceType || 'fb2') !== (previous.sourceType || 'fb2')) return false;
  return current.modifiedTime === previous.modifiedTime && current.size === previous.size;
}

export function preserveBookMetadata(currentIndex, previousIndex) {
  if (!previousIndex) return currentIndex;
  const previousBooks = new Map(previousIndex.books.map((book) => [book.id, book]));
  for (const book of currentIndex.books) {
    const previous = previousBooks.get(book.id);
    if (!previous || !isUnchanged(book, previous)) continue;
    for (const field of METADATA_FIELDS) {
      if (Object.hasOwn(previous, field)) book[field] = previous[field];
    }
    if (book.metadataStatus === 'processing') book.metadataStatus = 'pending';
    if (book.metadataVersion !== METADATA_VERSION) book.metadataStatus = 'pending';
  }
  currentIndex.createdAt = previousIndex.createdAt || currentIndex.createdAt;
  return currentIndex;
}

export function staleCoverFileIds(currentIndex, previousIndex) {
  if (!previousIndex) return [];
  const currentBooks = new Map(currentIndex.books.map((book) => [book.id, book]));
  return previousIndex.books.flatMap((previous) => {
    if (!previous.coverFileId) return [];
    const current = currentBooks.get(previous.id);
    return current && isUnchanged(current, previous) ? [] : [previous.coverFileId];
  });
}

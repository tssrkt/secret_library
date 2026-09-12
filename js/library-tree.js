import { FOLDER_MIME_TYPE, INDEX_VERSION, SCAN_CONCURRENCY } from './config.js';
import { getFolder, listFolderChildren } from './drive.js';

const isBook = (file) => file.mimeType !== FOLDER_MIME_TYPE && /\.fb2$/i.test(file.name);

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
          if (item.mimeType === FOLDER_MIME_TYPE) {
            folders.push({ id: item.id, parentId, name: item.name });
            pending.push(item.id);
          } else if (isBook(item)) {
            books.push({
              id: item.id,
              parentId,
              fileName: item.name,
              size: item.size == null ? null : Number(item.size),
              modifiedTime: item.modifiedTime || null,
              md5Checksum: item.md5Checksum || null,
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
];

function isUnchanged(current, previous) {
  if (current.md5Checksum && previous.md5Checksum) return current.md5Checksum === previous.md5Checksum;
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
  }
  currentIndex.createdAt = previousIndex.createdAt || currentIndex.createdAt;
  return currentIndex;
}

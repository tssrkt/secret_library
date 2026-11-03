import { extractBookMetadata } from './book-metadata.js';
import { resizeCover } from './cover-cache.js';
import { createAppDataBlob, deleteAppDataFile, downloadAppDataBlob, listAppDataFilesByPrefix } from './drive.js';

export const SHARED_COVER_CACHE_PREFIX = 'secret-library-shared-cover-';

export function sharedCoverCacheKey(ownerId, bookId) {
  return String(ownerId) + ':' + String(bookId);
}

function cachePrefix(ownerId, bookId) {
  return SHARED_COVER_CACHE_PREFIX + encodeURIComponent(String(ownerId)) + '-' + encodeURIComponent(String(bookId)) + '-';
}

function cacheName(ownerId, book, modifiedTime) {
  return cachePrefix(ownerId, book.id) + encodeURIComponent(modifiedTime || 'unknown') + '.webp';
}

export function createSharedCoverLoader({
  list = listAppDataFilesByPrefix,
  download = downloadAppDataBlob,
  create = createAppDataBlob,
  remove = deleteAppDataFile,
  extract = extractBookMetadata,
  resize = resizeCover,
} = {}) {
  const inFlight = new Map();
  let filesPromise = null;
  const files = async (refresh = false) => {
    if (refresh || !filesPromise) {
      filesPromise = Promise.resolve().then(() => list(SHARED_COVER_CACHE_PREFIX))
        .catch((error) => { filesPromise = null; throw error; });
    }
    return filesPromise;
  };

  return async function loadSharedCover(ownerId, book, { signal } = {}) {
    if (!ownerId || !book?.id) return null;
    const prefix = cachePrefix(ownerId, book.id);
    const name = cacheName(ownerId, book, book.modifiedTime || '');
    const taskKey = name;
    if (inFlight.has(taskKey)) return inFlight.get(taskKey);
    const task = (async () => {
      signal?.throwIfAborted();
      const existing = (await files()).find((file) => file.name === name);
      if (existing) {
        try { return await download(existing.id, signal); }
        catch (error) {
          if (error?.status !== 404) throw error;
          filesPromise = null;
        }
      }

      const metadata = await extract(book, { signal });
      signal?.throwIfAborted();
      if (!metadata?.cover?.bytes || !metadata.cover.mimeType) return null;
      const blob = await resize(metadata.cover);
      signal?.throwIfAborted();
      const saved = await create(name, blob);
      filesPromise = null;

      // Remove stale versions for this book from the viewer's own Drive cache.
      const stale = (await files(true)).filter((file) => file.name.startsWith(prefix) && file.id !== saved.id);
      for (const file of stale) {
        try { await remove(file.id); } catch (error) { if (error?.status !== 404) throw error; }
      }
      return blob;
    })();
    inFlight.set(taskKey, task);
    try { return await task; }
    finally { if (inFlight.get(taskKey) === task) inFlight.delete(taskKey); }
  };
}

export const loadSharedCover = createSharedCoverLoader();

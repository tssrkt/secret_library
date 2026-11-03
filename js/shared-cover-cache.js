import { extractBookMetadata } from './book-metadata.js';
import { resizeCover } from './cover-cache.js';

export const SHARED_COVER_MAX_ENTRIES = 80;
export const SHARED_COVER_MAX_BYTES = 15 * 1024 * 1024;
const DB_NAME = 'secret-library-shared-covers';
const STORE_NAME = 'covers';
const memoryFallback = new Map();
let databasePromise;

export function sharedCoverCacheKey(ownerId, bookId) {
  return String(ownerId) + ':' + String(bookId);
}

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  if (!databasePromise) databasePromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('lastUsedAt', 'lastUsedAt');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return databasePromise;
}

async function transact(mode, operation) {
  const database = await openDatabase();
  if (!database) return null;
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve(request?.result ?? null);
      transaction.onerror = transaction.onabort = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function readEntry(key) {
  const database = await openDatabase();
  if (!database) return memoryFallback.get(key) || null;
  return new Promise((resolve) => {
    try {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result || memoryFallback.get(key) || null);
      request.onerror = () => resolve(memoryFallback.get(key) || null);
    } catch { resolve(memoryFallback.get(key) || null); }
  });
}

async function writeEntry(entry) {
  memoryFallback.set(entry.key, entry);
  await transact('readwrite', (store) => store.put(entry));
  await enforceCacheLimit();
}

async function readAllEntries() {
  const database = await openDatabase();
  if (!database) return [...memoryFallback.values()];
  return new Promise((resolve) => {
    try {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      request.onsuccess = () => {
        const entries = new Map((request.result || []).map((entry) => [entry.key, entry]));
        for (const entry of memoryFallback.values()) entries.set(entry.key, entry);
        resolve([...entries.values()]);
      };
      request.onerror = () => resolve([...memoryFallback.values()]);
    } catch { resolve([...memoryFallback.values()]); }
  });
}

async function deleteEntry(key) {
  memoryFallback.delete(key);
  await transact('readwrite', (store) => store.delete(key));
}

async function enforceCacheLimit({ maxEntries = SHARED_COVER_MAX_ENTRIES, maxBytes = SHARED_COVER_MAX_BYTES } = {}) {
  const entries = (await readAllEntries()).sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
  let totalBytes = entries.reduce((sum, entry) => sum + (entry.size || entry.blob?.size || 0), 0);
  let count = entries.length;
  for (const entry of entries) {
    if (count <= maxEntries && totalBytes <= maxBytes) break;
    await deleteEntry(entry.key);
    count -= 1;
    totalBytes -= entry.size || entry.blob?.size || 0;
  }
}

export function createSharedCoverLoader({
  get = readEntry,
  set = writeEntry,
  extract = extractBookMetadata,
  resize = resizeCover,
  now = () => Date.now(),
} = {}) {
  const inFlight = new Map();
  const latestRequestedVersion = new Map();
  return async function loadSharedCover(ownerId, book, { signal } = {}) {
    if (!ownerId || !book?.id) return null;
    const key = sharedCoverCacheKey(ownerId, book.id);
    const modifiedTime = book.modifiedTime || '';
    const cached = await get(key);
    if (cached?.blob && cached.modifiedTime === modifiedTime) {
      void Promise.resolve(set({ ...cached, lastUsedAt: now() })).catch(() => {});
      return cached.blob;
    }
    const taskKey = key + ':' + modifiedTime;
    if (inFlight.has(taskKey)) return inFlight.get(taskKey);
    latestRequestedVersion.set(key, modifiedTime);
    const task = (async () => {
      signal?.throwIfAborted();
      const metadata = await extract(book, { signal });
      signal?.throwIfAborted();
      if (!metadata?.cover?.bytes || !metadata.cover.mimeType) return null;
      const blob = await resize(metadata.cover);
      signal?.throwIfAborted();
      if (latestRequestedVersion.get(key) === modifiedTime) {
        await set({ key, ownerId: String(ownerId), bookId: String(book.id), modifiedTime,
          blob, size: blob.size, lastUsedAt: now() });
      }
      return blob;
    })();
    inFlight.set(taskKey, task);
    try { return await task; }
    finally { if (inFlight.get(taskKey) === task) inFlight.delete(taskKey); }
  };
}

export const loadSharedCover = createSharedCoverLoader();

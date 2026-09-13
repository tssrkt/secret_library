import { BOOK_SOURCE_TYPES, FOLDER_MIME_TYPE, INDEX_VERSION, SCAN_CONCURRENCY } from './config.js';
import { getFolder, listFolderChildren } from './drive.js';

export function classifyLibraryItem(file) {
  if (file.mimeType === FOLDER_MIME_TYPE) return 'folder';
  const extension = /\.(fb2|zip|epub|mobi)$/i.exec(file.name)?.[1].toLowerCase();
  if (extension) return extension;
  if (/\.(azw3?|pdf|djvu|docx?|txt)$/i.test(file.name)) return 'other';
  if (file.mimeType === 'application/epub+zip') return 'epub';
  if (file.mimeType === 'application/x-mobipocket-ebook') return 'mobi';
  if (/\.zip$/i.test(file.name) || ['application/zip', 'application/x-zip-compressed'].includes(file.mimeType)) return 'zip';
  return 'other';
}

export async function scanLibrary(rootFolderId, onProgress = () => {}, {
  signal, getRoot = getFolder, listChildren = listFolderChildren, heartbeatMs = 1000, now = Date.now,
} = {}) {
  const controller = new AbortController();
  const scanSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const started = now();
  const folders = [];
  const books = [];
  const queue = [];
  const running = new Set();
  const seenFolders = new Set([rootFolderId]);
  const seenBooks = new Set();
  const retrying = new Set();
  const events = new Map();
  let processedFolders = 0;
  let readingRoot = true;
  let failure = null;
  const emit = () => {
    if (failure || scanSignal.aborted) return;
    onProgress({ processedFolders, discoveredFolders: Math.max(0, folders.length - 1),
      // Outstanding work includes requests already in flight.
      queuedFolders: queue.length + running.size + (readingRoot ? 1 : 0),
      activeFolders: running.size + (readingRoot ? 1 : 0), books: books.length,
      retrying: retrying.size > 0, elapsedSeconds: Math.floor((now() - started) / 1000) });
  };
  const diagnostics = (folder) => ({
    stage: 'list', fileId: folder.id, folderId: folder.id, folderName: folder.name || '',
    onIssue(error) {
      if (failure || scanSignal.aborted) return;
      if (!events.has(folder.id)) events.set(folder.id, []);
      events.get(folder.id).push({ timestamp: new Date().toISOString(), stage: 'list',
        folderId: folder.id, folderName: folder.name || '', fileId: folder.id,
        attempt: error.attempt || 1, retryResult: error.retryResult || 'not-retried',
        status: error.status || null, code: error.code || error.name, message: error.message });
      if (error.retryResult === 'retrying') retrying.add(folder.id);
      emit();
    },
    onSuccess() { retrying.delete(folder.id); emit(); },
  });
  const folderError = (error, folder) => Object.assign(error, { stage: 'list',
    folderId: folder.id, folderName: folder.name || '', fileId: folder.id,
    attempt: error.attempt || 1, retryResult: error.retryResult || 'not-retried',
    scanEvents: events.get(folder.id) || [] });
  const readFolder = async (folder) => {
    try {
      const children = await listChildren(folder.id, { signal: scanSignal, diagnostics: diagnostics(folder) });
      scanSignal.throwIfAborted();
      for (const item of children) {
        const parentId = folder.id;
        const itemType = classifyLibraryItem(item);
        if (itemType === 'folder' && !seenFolders.has(item.id)) {
          seenFolders.add(item.id);
          const child = { id: item.id, parentId, name: item.name };
          folders.push(child); queue.push(child);
        } else if (BOOK_SOURCE_TYPES.includes(itemType) && !seenBooks.has(item.id)) {
          seenBooks.add(item.id);
          books.push({ id: item.id, parentId, fileName: item.name, extension: itemType,
            size: item.size == null ? null : Number(item.size), modifiedTime: item.modifiedTime || null,
            md5Checksum: item.md5Checksum || null, sourceType: itemType,
            ...(itemType === 'zip' ? { entryPath: null } : {}), metadataStatus: 'pending' });
        }
      }
      processedFolders += 1;
    } catch (error) {
      if (!failure) { failure = folderError(error, folder); controller.abort(); }
    }
  };
  const heartbeat = setInterval(emit, heartbeatMs);
  try {
    scanSignal.throwIfAborted();
    emit();
    let root;
    try { root = await getRoot(rootFolderId, { signal: scanSignal, diagnostics: diagnostics({ id: rootFolderId }) }); }
    catch (error) { throw folderError(error, { id: rootFolderId }); }
    scanSignal.throwIfAborted();
    const rootFolder = { id: root.id, parentId: null, name: root.name };
    folders.push(rootFolder); queue.push(rootFolder); readingRoot = false;
    while (queue.length || running.size) {
      scanSignal.throwIfAborted();
      while (queue.length && running.size < SCAN_CONCURRENCY && !failure) {
        const folder = queue.shift();
        const task = readFolder(folder).finally(() => { running.delete(task); emit(); });
        running.add(task);
      }
      emit();
      await Promise.race(running);
      if (failure) throw failure;
    }
    scanSignal.throwIfAborted();
    const timestamp = new Date().toISOString();
    return { version: INDEX_VERSION, rootFolderId, createdAt: timestamp, updatedAt: timestamp,
      folders, books, lastFullScan: { scannedAt: timestamp, totalEligible: books.length } };
  } finally {
    clearInterval(heartbeat);
    controller.abort();
  }
}

const METADATA_FIELDS = [
  'metadataStatus', 'title', 'authors', 'series', 'seriesNumber', 'annotation', 'preview', 'metadataError',
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
  }
  currentIndex.createdAt = previousIndex.createdAt || currentIndex.createdAt;
  const presentIds = new Set(currentIndex.books.map((book) => book.id));
  currentIndex.indexingErrors = structuredClone((previousIndex.indexingErrors || []).filter((entry) => presentIds.has(entry.fileId)));
  if (previousIndex.lastIndexingRun) currentIndex.lastIndexingRun = structuredClone(previousIndex.lastIndexingRun);
  if (previousIndex.fullRunId) currentIndex.fullRunId = previousIndex.fullRunId;
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

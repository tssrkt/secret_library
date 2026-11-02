import { BOOK_SOURCE_TYPES, INDEX_VERSION, METADATA_VERSION } from './config.js';
import { failedBookIds, indexingCounts, selectedRetryBookIds } from './indexing-state.js';

function cloneIndex(index) {
  return typeof structuredClone === 'function'
    ? structuredClone(index)
    : JSON.parse(JSON.stringify(index));
}

function activeSignature(index) {
  return `${index.version}:${METADATA_VERSION}:${index.rootFolderId}:${index.updatedAt || ''}:${index.books.length}`;
}

export function prepareBuildingIndex(activeIndex, { retryErrors = false, mode = retryErrors ? 'retry' : 'incremental', scannedIndex,
  previousIndex = null, selectedBookIds, now = () => new Date().toISOString() } = {}) {
  if (mode === 'full' && (!scannedIndex || scannedIndex.rootFolderId !== activeIndex.rootFolderId)) throw new Error('Full reindex requires a fresh scan of the same root.');
  if (selectedBookIds !== undefined && mode !== 'retry') throw Object.assign(new Error('Book IDs can be selected only for a retry.'), { code: 'invalid_retry_selection' });
  const retryIds = mode === 'retry' ? selectedRetryBookIds(activeIndex, selectedBookIds) : failedBookIds(activeIndex);
  const building = cloneIndex(mode === 'full' ? scannedIndex : activeIndex);
  building.indexingErrors = ['retry', 'refresh'].includes(mode) ? cloneIndex(activeIndex.indexingErrors || []).filter((entry) => entry.stage !== 'index-write') : [];
  const selectedIds = [];
  let total = 0;
  for (const book of building.books) {
    const needsMetadata = mode === 'full' || (mode === 'retry' ? retryIds.has(book.id) : mode === 'refresh'
      ? ['pending', 'processing'].includes(book.metadataStatus) : book.metadataStatus === 'pending'
      || book.metadataStatus === 'processing'
      || book.metadataVersion !== METADATA_VERSION);
    if (!needsMetadata) continue;
    book.metadataStatus = 'pending';
    delete book.metadataError;
    delete book.metadataErrorMessage;
    total += 1;
    selectedIds.push(book.id);
  }
  building.version = INDEX_VERSION;
  building.buildState = {
    status: 'building',
    baseSignature: activeSignature(activeIndex),
    startedAt: now(),
    runId: globalThis.crypto.randomUUID(),
    mode,
    selectedIds,
    processedIds: [],
    pendingIds: [...selectedIds],
    bookIds: building.books.map((book) => book.id),
    removedBookIds: [],
    ...(mode === 'full' ? { sourceBooks: cloneIndex(scannedIndex.books) } : {}),
    ...(mode === 'refresh' && previousIndex ? { previousBooks: cloneIndex(previousIndex.books.filter((book) => selectedIds.includes(book.id)
      && (book.metadataStatus === 'ready' || (book.metadataStatus === 'pending' && book.metadataVersion != null
        && Object.hasOwn(book, 'title') && Array.isArray(book.authors))))) } : {}),
    total,
    retryErrors: mode === 'retry',
    progress: { processed: 0, succeeded: 0, recovered: 0, failed: 0, excluded: 0 },
  };
  return building;
}

export function canResumeBuildingIndex(building, activeIndex, { retryErrors = false, mode = retryErrors ? 'retry' : 'incremental', scannedIndex,
  selectedBookIds } = {}) {
  if (!building?.buildState || !['building', 'paused'].includes(building.buildState.status)) return false;
  if (building.buildState.baseSignature !== activeSignature(activeIndex)) return false;
  if ((building.buildState.mode || 'incremental') !== mode) return false;
  if (building.rootFolderId !== activeIndex.rootFolderId) return false;
  if (mode !== 'full') {
    const activeIds = new Set(activeIndex.books.map((book) => book.id));
    const checkpointBookIds = building.buildState.bookIds || activeIndex.books.map((book) => book.id);
    if (activeIds.size !== activeIndex.books.length || new Set(checkpointBookIds).size !== checkpointBookIds.length
        || activeIds.size !== checkpointBookIds.length || checkpointBookIds.some((id) => !activeIds.has(id))) return false;
  }
  if (mode === 'retry') {
    let failedIds;
    let requested;
    try {
      failedIds = selectedRetryBookIds(activeIndex);
      requested = selectedBookIds === undefined ? null : selectedRetryBookIds(activeIndex, selectedBookIds);
    }
    catch { return false; }
    const checkpointIds = building.buildState.selectedIds || [];
    if (new Set(checkpointIds).size !== checkpointIds.length
        || checkpointIds.some((id) => !failedIds.has(id))) return false;
    if (requested && (requested.size !== checkpointIds.length || checkpointIds.some((id) => !requested.has(id)))) return false;
    const selected = new Set(checkpointIds);
    const activeBooks = new Map(activeIndex.books.map((book) => [book.id, book]));
    for (const book of building.books) if (!selected.has(book.id)
        && JSON.stringify(book) !== JSON.stringify(activeBooks.get(book.id))) return false;
    const unselectedErrors = (entries) => (entries || []).filter((entry) => entry.stage !== 'index-write' && !selected.has(entry.fileId));
    if (JSON.stringify(unselectedErrors(building.indexingErrors)) !== JSON.stringify(unselectedErrors(activeIndex.indexingErrors))) return false;
    if ((building.buildState.removedBookIds || []).some((id) => !selected.has(id))) return false;
  } else if (selectedBookIds !== undefined) return false;
  if (mode === 'full' && scannedIndex) {
    const sources = new Map(building.buildState.sourceBooks?.map((book) => [book.id, book]));
    if (sources.size !== scannedIndex.books.length || !scannedIndex.books.every((book) => JSON.stringify(sources.get(book.id)) === JSON.stringify(book))) return false;
    if (JSON.stringify(building.folders) !== JSON.stringify(scannedIndex.folders)) return false;
  }
  const expected = new Set(building.buildState.bookIds || activeIndex.books.map((book) => book.id));
  for (const id of building.buildState.removedBookIds || []) expected.delete(id);
  return expected.size === building.books.length && new Set(building.books.map((book) => book.id)).size === expected.size
    && building.books.every((book) => expected.has(book.id));
}

export function updateBuildProgress(building, progress) {
  building.buildState.remaining = Math.max(0, building.buildState.total - progress.processed);
  building.buildState.progress = {
    processed: progress.processed,
    succeeded: progress.succeeded,
    recovered: progress.recovered || 0,
    excluded: progress.excluded || 0,
    failed: progress.failed,
    currentFileName: progress.currentFileName || '',
  };
}

export function validateCompletedIndex(candidate, activeIndex, manifest = candidate?.buildState) {
  if (!candidate || candidate.rootFolderId !== activeIndex.rootFolderId) throw new Error('Built index has a different root folder.');
  if (!Array.isArray(candidate.books) || !Array.isArray(candidate.folders)) throw new Error('Built index structure is invalid.');
  const activeIds = new Set(manifest?.bookIds || activeIndex.books.map((book) => book.id));
  for (const id of manifest?.removedBookIds || []) activeIds.delete(id);
  if (candidate.books.length !== activeIds.size) throw new Error('Built index has an incomplete book list.');
  const builtIds = new Set();
  const oldBooks = new Map(activeIndex.books.map((book) => [book.id, book]));
  const sources = new Map((manifest?.sourceBooks || []).map((book) => [book.id, book]));
  const selected = new Set(manifest?.selectedIds || []);
  const preservedIds = new Set((candidate.indexingErrors || []).filter((entry) => entry.previousEntryPreserved && entry.outcome === 'failed').map((entry) => entry.fileId));
  for (const book of candidate.books) {
    if (!book?.id || builtIds.has(book.id) || !activeIds.has(book.id) || !book.fileName || !BOOK_SOURCE_TYPES.includes(book.sourceType)) {
      throw new Error('Built index contains an invalid book record.');
    }
    builtIds.add(book.id);
    if (['retry', 'refresh'].includes(manifest?.mode) && !selected.has(book.id)) {
      if (JSON.stringify(book) !== JSON.stringify(oldBooks.get(book.id))) throw new Error('Retry changed an unselected book.');
      continue;
    }
    if (!['ready', 'error'].includes(book.metadataStatus)) throw new Error('Built index is not complete.');
    const oldBook = oldBooks.get(book.id);
    const fallbackBook = sources.get(book.id);
    const previousBook = oldBook?.metadataStatus === 'ready' ? oldBook
      : oldBook?.metadataStatus === 'pending' && oldBook.metadataVersion != null
        && Object.hasOwn(oldBook, 'title') && Array.isArray(oldBook.authors)
        ? { ...oldBook, metadataStatus: 'ready' } : null;
    const previousReady = previousBook || (manifest?.mode === 'refresh'
      ? (manifest.previousBooks || []).find((item) => item.id === book.id) || null : null);
    const unchangedPrevious = preservedIds.has(book.id) && previousReady
      && JSON.stringify(book) === JSON.stringify(previousRecord(previousReady, fallbackBook || oldBook));
    if (preservedIds.has(book.id) && !unchangedPrevious) throw new Error('Preserved index entry differs from the previous good record.');
    if (book.metadataStatus === 'ready' && book.metadataVersion !== METADATA_VERSION && !unchangedPrevious) {
      throw new Error('Built index contains stale metadata.');
    }
    if (book.metadataStatus === 'ready'
        && (!Object.hasOwn(book, 'title') || !Array.isArray(book.authors) || !Array.isArray(book.genres))) {
      throw new Error('Built index is missing expected metadata fields.');
    }
  }
  const json = JSON.stringify(candidate);
  if (!json || json === '{}' || json.length < 2) throw new Error('Built index serialization is empty.');
  const parsed = JSON.parse(json);
  if (manifest?.runId) {
    parsed.lastIndexingRun = { runId: manifest.runId, mode: manifest.mode, startedAt: manifest.startedAt,
      completedAt: candidate.lastIndexingRun?.runId === manifest.runId ? candidate.lastIndexingRun.completedAt : new Date().toISOString(),
      total: manifest.total, ...manifest.progress };
    if (manifest.mode === 'full') parsed.fullRunId = manifest.runId;
    parsed.lastIndexingRun.fullRunId = parsed.fullRunId || null;
    parsed.indexingCounts = indexingCounts(parsed);
  }
  parsed.buildState = undefined;
  delete parsed.buildState;
  return parsed;
}

// Preserve good metadata while retaining the freshly scanned location/source identity.
export function previousRecord(previous, source) {
  const result = cloneIndex(previous);
  if (source) for (const field of ['id', 'parentId', 'fileName', 'extension', 'size', 'modifiedTime', 'md5Checksum', 'sourceType', 'path', 'resourceKey']) {
    if (Object.hasOwn(source, field)) result[field] = source[field];
  }
  return result;
}

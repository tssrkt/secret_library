import { BOOK_SOURCE_TYPES, INDEX_VERSION, METADATA_VERSION } from './config.js';
import { failedBookIds, indexingCounts } from './indexing-state.js';

function cloneIndex(index) {
  return typeof structuredClone === 'function'
    ? structuredClone(index)
    : JSON.parse(JSON.stringify(index));
}

function activeSignature(index) {
  return `${index.rootFolderId}:${index.updatedAt || ''}:${index.books.length}`;
}

export function prepareBuildingIndex(activeIndex, { retryErrors = false, mode = retryErrors ? 'retry' : 'incremental', scannedIndex,
  now = () => new Date().toISOString() } = {}) {
  if (mode === 'full' && (!scannedIndex || scannedIndex.rootFolderId !== activeIndex.rootFolderId)) throw new Error('Full reindex requires a fresh scan of the same root.');
  const building = cloneIndex(mode === 'full' ? scannedIndex : activeIndex);
  const previousFailures = failedBookIds(activeIndex);
  building.indexingErrors = ['retry', 'refresh'].includes(mode) ? cloneIndex(activeIndex.indexingErrors || []).filter((entry) => entry.stage !== 'index-write') : [];
  const selectedIds = [];
  let total = 0;
  for (const book of building.books) {
    const needsMetadata = mode === 'full' || (mode === 'retry' ? previousFailures.has(book.id) : mode === 'refresh'
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
    bookIds: building.books.map((book) => book.id),
    removedBookIds: [],
    ...(mode === 'full' ? { sourceBooks: cloneIndex(scannedIndex.books) } : {}),
    total,
    retryErrors: mode === 'retry',
    progress: { processed: 0, succeeded: 0, recovered: 0, failed: 0, excluded: 0 },
  };
  return building;
}

export function canResumeBuildingIndex(building, activeIndex, { retryErrors = false, mode = retryErrors ? 'retry' : 'incremental', scannedIndex } = {}) {
  if (!building?.buildState || building.buildState.status !== 'building') return false;
  if (building.buildState.baseSignature !== activeSignature(activeIndex)) return false;
  if ((building.buildState.mode || 'incremental') !== mode) return false;
  if (building.rootFolderId !== activeIndex.rootFolderId) return false;
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
    const unchangedPrevious = preservedIds.has(book.id) && oldBooks.get(book.id)?.metadataStatus === 'ready'
      && JSON.stringify(book) === JSON.stringify(previousRecord(oldBooks.get(book.id), sources.get(book.id)));
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
  if (source) for (const field of ['id', 'parentId', 'fileName', 'extension', 'size', 'modifiedTime', 'md5Checksum', 'sourceType']) {
    if (Object.hasOwn(source, field)) result[field] = source[field];
  }
  return result;
}

import { INDEX_VERSION, METADATA_VERSION } from './config.js';

function cloneIndex(index) {
  return typeof structuredClone === 'function'
    ? structuredClone(index)
    : JSON.parse(JSON.stringify(index));
}

function activeSignature(index) {
  return `${index.rootFolderId}:${index.updatedAt || ''}:${index.books.length}`;
}

export function prepareBuildingIndex(activeIndex, { retryErrors = false, now = () => new Date().toISOString() } = {}) {
  const building = cloneIndex(activeIndex);
  let total = 0;
  for (const book of building.books) {
    const needsMetadata = book.metadataStatus === 'pending'
      || book.metadataStatus === 'processing'
      || book.metadataVersion !== METADATA_VERSION
      || (retryErrors && book.metadataStatus === 'error');
    if (!needsMetadata) continue;
    book.metadataStatus = 'pending';
    delete book.metadataError;
    delete book.metadataErrorMessage;
    total += 1;
  }
  building.version = INDEX_VERSION;
  building.buildState = {
    status: 'building',
    baseSignature: activeSignature(activeIndex),
    startedAt: now(),
    total,
    retryErrors,
    progress: { processed: 0, succeeded: 0, failed: 0 },
  };
  return building;
}

export function canResumeBuildingIndex(building, activeIndex, { retryErrors = false } = {}) {
  if (!building?.buildState || building.buildState.status !== 'building') return false;
  if (building.buildState.baseSignature !== activeSignature(activeIndex)) return false;
  if (Boolean(building.buildState.retryErrors) !== Boolean(retryErrors)) return false;
  if (building.rootFolderId !== activeIndex.rootFolderId || building.books.length !== activeIndex.books.length) return false;
  const activeIds = new Set(activeIndex.books.map((book) => book.id));
  return building.books.every((book) => activeIds.has(book.id));
}

export function updateBuildProgress(building, progress) {
  building.buildState.progress = {
    processed: progress.processed,
    succeeded: progress.succeeded,
    failed: progress.failed,
    currentFileName: progress.currentFileName || '',
  };
}

export function validateCompletedIndex(candidate, activeIndex) {
  if (!candidate || candidate.rootFolderId !== activeIndex.rootFolderId) throw new Error('Built index has a different root folder.');
  if (!Array.isArray(candidate.books) || !Array.isArray(candidate.folders)) throw new Error('Built index structure is invalid.');
  if (candidate.books.length !== activeIndex.books.length) throw new Error('Built index has an incomplete book list.');
  const activeIds = new Set(activeIndex.books.map((book) => book.id));
  const builtIds = new Set();
  for (const book of candidate.books) {
    if (!book?.id || builtIds.has(book.id) || !activeIds.has(book.id) || !book.fileName || !['fb2', 'zip'].includes(book.sourceType)) {
      throw new Error('Built index contains an invalid book record.');
    }
    builtIds.add(book.id);
    if (!['ready', 'error'].includes(book.metadataStatus)) throw new Error('Built index is not complete.');
    if (book.metadataStatus === 'ready' && book.metadataVersion !== METADATA_VERSION) {
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
  parsed.buildState = undefined;
  delete parsed.buildState;
  return parsed;
}

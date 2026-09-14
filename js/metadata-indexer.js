import { METADATA_CHECKPOINT_SIZE, METADATA_CONCURRENCY, METADATA_VERSION } from './config.js';
import { extractBookMetadata } from './book-metadata.js';
import { Fb2Error } from './fb2.js';
import { errorDetails, recordIndexingError } from './indexing-errors.js';
import { previousRecord } from './index-build.js';

export function resetProcessingBooks(index) {
  const selected = index.buildState?.mode === 'retry' ? new Set(index.buildState.selectedIds) : null;
  for (const book of index.books) {
    if (selected && !selected.has(book.id)) continue;
    if (book.metadataStatus === 'processing') book.metadataStatus = 'pending';
  }
}

export function retryMetadataErrors(index) {
  for (const book of index.books) {
    if (book.metadataStatus === 'error') {
      book.metadataStatus = 'pending';
      delete book.metadataError;
      delete book.metadataErrorMessage;
    }
  }
}

export async function indexPendingBooks(index, {
  signal,
  onProgress = () => {},
  onCheckpoint = async () => {},
  onLocalCheckpoint = async () => {},
  extract = extractBookMetadata,
  concurrency = METADATA_CONCURRENCY,
  checkpointSize = METADATA_CHECKPOINT_SIZE,
  onCover = async () => ({}),
  previousIndex = null,
  onErrors = () => {},
  checkEligibility = async () => true,
} = {}) {
  const retry = index.buildState?.mode === 'retry';
  const selected = retry ? new Set(index.buildState.selectedIds) : null;
  const pending = index.books.filter((book) => book.metadataStatus === 'pending' && (!selected || selected.has(book.id)));
  const stats = { total: pending.length, processed: 0, succeeded: 0, recovered: 0, skipped: index.books.length - pending.length, failed: 0, excluded: 0 };
  const previousBooks = new Map((previousIndex?.books || []).filter((book) => book.metadataStatus === 'ready').map((book) => [book.id, book]));
  index.indexingErrors ||= [];
  const sources = new Map((index.buildState?.sourceBooks || []).map((book) => [book.id, book]));

  const processBook = async (book) => {
    if (signal?.aborted) return;
    book.metadataStatus = 'processing';
    const issues = new Map();
    let reportChanged = false;
    const clearReport = () => {
      const oldCount = index.indexingErrors.length;
      index.indexingErrors = index.indexingErrors.filter((entry) => entry.fileId !== book.id || entry.stage === 'index-write');
      reportChanged ||= oldCount !== index.indexingErrors.length;
    };
    const onIssue = (error) => issues.set(error, errorDetails(error, { runId: index.buildState?.runId || null }));
    try {
      if (retry && !await checkEligibility(book)) throw Object.assign(new Error('Файл удалён или больше не входит в доступную библиотеку.'), { code: 'no_longer_eligible', stage: 'metadata' });
      const metadata = await extract(book, { signal, onIssue });
      if (signal?.aborted) {
        book.metadataStatus = 'pending';
        return;
      }
      const recovery = metadata.binaryRecovery;
      const previous = previousBooks.get(book.id);
      const preserveFull = Boolean(recovery?.code === 'metadata_only_recovered' && previous
        && previous.metadataWarning !== 'metadata_only_recovered');
      const preserveCover = Boolean(recovery?.coverDamaged && previous?.coverFileId);
      let coverFields = {};
      try {
        coverFields = preserveCover
          ? { coverFileId: previous.coverFileId, coverMimeType: previous.coverMimeType || null }
          : recovery?.coverDamaged ? { coverFileId: null, coverMimeType: null }
            : await onCover(book, metadata.cover || null);
      }
      catch (error) {
        error.stage = 'cover';
        throw error;
      }
      delete metadata.cover;
      delete metadata.coverId;
      delete metadata.binaryRecovery;
      if (preserveFull) {
        for (const key of Object.keys(book)) delete book[key];
        Object.assign(book, previousRecord(previous, sources.get(previous.id)));
      } else Object.assign(book, metadata, coverFields, { metadataStatus: 'ready', metadataVersion: METADATA_VERSION });
      delete book.metadataError;
      delete book.metadataErrorMessage;
      if (!preserveFull && !Object.hasOwn(metadata, 'metadataWarning')) delete book.metadataWarning;
      clearReport();
      if (recovery) {
        stats.recovered += 1;
        onIssue({ ...recovery, metadataIndexed: true, coverRecovered: !recovery.coverDamaged && Boolean(coverFields.coverFileId),
          previousCoverPreserved: preserveCover, previousFullEntryPreserved: preserveFull, bookSkipped: false });
      } else stats.succeeded += 1;
      if (issues.size) {
        const events = [...issues.values()].map((event) => ({ ...event, retryResult: event.retryResult === 'retrying' ? 'success-after-backoff' : event.retryResult }));
        recordIndexingError(index, book, events, { outcome: 'recovered', preserved: preserveFull });
      }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        book.metadataStatus = 'pending';
        return;
      }
      if (error?.status === 401 || error?.code === 'unauthorized' || error?.retryable) {
        book.metadataStatus = 'pending';
        onIssue(error);
        recordIndexingError(index, book, [...issues.values()], { outcome: 'interrupted' });
        error.indexingLogged = true;
        onErrors(index.indexingErrors);
        throw error;
      }
      onIssue(error);
      const previous = previousBooks.get(book.id);
      if (retry && (error.code === 'no_longer_eligible' || (error.status === 404 && (!error.stage || error.stage === 'download' || error.stage === 'metadata')))) {
        index.books = index.books.filter((item) => item.id !== book.id);
        index.buildState.removedBookIds.push(book.id);
        clearReport();
        recordIndexingError(index, book, [...issues.values()], { outcome: 'excluded' });
        stats.excluded += 1;
      } else {
        if (previous) {
          for (const key of Object.keys(book)) delete book[key];
          Object.assign(book, previousRecord(previous, sources.get(previous.id)));
        } else {
          book.metadataStatus = 'error';
          book.metadataError = error?.status === 403 ? 'insufficient_permissions'
            : error instanceof Fb2Error ? error.code : error.code || 'download_failed';
          book.metadataErrorMessage = String(error?.message || book.metadataError).slice(0, 240);
        }
        recordIndexingError(index, book, [...issues.values()], { preserved: Boolean(previous) });
        stats.failed += 1;
      }
    }
    stats.processed += 1;
    if (index.buildState?.processedIds) index.buildState.processedIds.push(book.id);
    if (issues.size || reportChanged) onErrors(index.indexingErrors);
    onProgress({ ...stats, currentFileName: book.fileName });
  };

  let checkpointAt = checkpointSize;
  for (let offset = 0; offset < pending.length && !signal?.aborted; offset += concurrency) {
    const batch = await Promise.allSettled(pending.slice(offset, offset + concurrency).map(processBook));
    const fatal = batch.find((result) => result.status === 'rejected');
    if (index.buildState) index.buildState.pendingIds = pending
      .filter((book) => ['pending', 'processing'].includes(book.metadataStatus)).map((book) => book.id);
    await onLocalCheckpoint(index, { ...stats }, pending.slice(offset, offset + concurrency).map((book) => book.id));
    if (fatal) throw fatal.reason;
    if (stats.processed >= checkpointAt) {
      index.updatedAt = new Date().toISOString();
      await onCheckpoint(index, { ...stats });
      checkpointAt = stats.processed + checkpointSize;
    }
  }
  resetProcessingBooks(index);
  return stats;
}

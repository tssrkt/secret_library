import { METADATA_CHECKPOINT_SIZE, METADATA_CONCURRENCY, METADATA_VERSION } from './config.js';
import { extractBookMetadata } from './book-metadata.js';
import { Fb2Error } from './fb2.js';
import { errorDetails, recordIndexingError } from './indexing-errors.js';

export function resetProcessingBooks(index) {
  for (const book of index.books) {
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
  extract = extractBookMetadata,
  concurrency = METADATA_CONCURRENCY,
  checkpointSize = METADATA_CHECKPOINT_SIZE,
  onCover = async () => ({}),
  previousIndex = null,
  onErrors = () => {},
} = {}) {
  const pending = index.books.filter((book) => book.metadataStatus === 'pending');
  const stats = { total: pending.length, processed: 0, succeeded: 0, skipped: index.books.length - pending.length, failed: 0 };
  const previousBooks = new Map((previousIndex?.books || []).filter((book) => book.metadataStatus === 'ready').map((book) => [book.id, book]));
  index.indexingErrors ||= [];

  const processBook = async (book) => {
    if (signal?.aborted) return;
    book.metadataStatus = 'processing';
    const issues = new Map();
    const onIssue = (error) => issues.set(error, errorDetails(error));
    try {
      const metadata = await extract(book, { signal, onIssue });
      if (signal?.aborted) {
        book.metadataStatus = 'pending';
        return;
      }
      let coverFields = {};
      try { coverFields = await onCover(book, metadata.cover || null); }
      catch (error) {
        error.stage = 'cover';
        throw error;
      }
      delete metadata.cover;
      delete metadata.coverId;
      Object.assign(book, metadata, coverFields, { metadataStatus: 'ready', metadataVersion: METADATA_VERSION });
      delete book.metadataError;
      delete book.metadataErrorMessage;
      if (!Object.hasOwn(metadata, 'metadataWarning')) delete book.metadataWarning;
      stats.succeeded += 1;
      if (issues.size) {
        const events = [...issues.values()].map((event) => ({ ...event, retryResult: event.retryResult === 'retrying' ? 'success-after-backoff' : event.retryResult }));
        recordIndexingError(index, book, events, { outcome: 'recovered' });
      }
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        book.metadataStatus = 'pending';
        return;
      }
      if (error?.status === 401 || error?.code === 'unauthorized') {
        book.metadataStatus = 'pending';
        onIssue(error);
        recordIndexingError(index, book, [...issues.values()], { outcome: 'interrupted' });
        error.indexingLogged = true;
        onErrors(index.indexingErrors);
        throw error;
      }
      onIssue(error);
      const previous = previousBooks.get(book.id);
      if (previous) {
        for (const key of Object.keys(book)) delete book[key];
        Object.assign(book, structuredClone(previous));
      } else {
        book.metadataStatus = 'error';
        book.metadataError = error?.status === 403 ? 'insufficient_permissions'
          : error instanceof Fb2Error ? error.code : error.code || 'download_failed';
        book.metadataErrorMessage = String(error?.message || book.metadataError).slice(0, 240);
      }
      recordIndexingError(index, book, [...issues.values()], { preserved: Boolean(previous) });
      stats.failed += 1;
    }
    stats.processed += 1;
    if (issues.size) onErrors(index.indexingErrors);
    onProgress({ ...stats, currentFileName: book.fileName });
  };

  let checkpointAt = checkpointSize;
  for (let offset = 0; offset < pending.length && !signal?.aborted; offset += concurrency) {
    const batch = await Promise.allSettled(pending.slice(offset, offset + concurrency).map(processBook));
    const fatal = batch.find((result) => result.status === 'rejected');
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

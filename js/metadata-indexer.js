import { METADATA_CHECKPOINT_SIZE, METADATA_CONCURRENCY } from './config.js';
import { extractFb2Metadata, Fb2Error } from './fb2.js';

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
    }
  }
}

export async function indexPendingBooks(index, {
  signal,
  onProgress = () => {},
  onCheckpoint = async () => {},
  extract = extractFb2Metadata,
  concurrency = METADATA_CONCURRENCY,
  checkpointSize = METADATA_CHECKPOINT_SIZE,
} = {}) {
  const pending = index.books.filter((book) => book.metadataStatus === 'pending');
  const stats = { total: pending.length, processed: 0, succeeded: 0, failed: 0 };

  const processBook = async (book) => {
    if (signal?.aborted) return;
    book.metadataStatus = 'processing';
    try {
      const metadata = await extract(book, { signal });
      if (signal?.aborted) {
        book.metadataStatus = 'pending';
        return;
      }
      Object.assign(book, metadata, { metadataStatus: 'ready' });
      delete book.metadataError;
      stats.succeeded += 1;
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        book.metadataStatus = 'pending';
        return;
      }
      if (error?.status === 401 || error?.code === 'unauthorized') {
        book.metadataStatus = 'pending';
        throw error;
      }
      book.metadataStatus = 'error';
      book.metadataError = error instanceof Fb2Error ? error.code : 'download_failed';
      stats.failed += 1;
    }
    stats.processed += 1;
    onProgress({ ...stats, currentFileName: book.fileName });
  };

  let checkpointAt = checkpointSize;
  for (let offset = 0; offset < pending.length && !signal?.aborted; offset += concurrency) {
    await Promise.all(pending.slice(offset, offset + concurrency).map(processBook));
    if (stats.processed >= checkpointAt) {
      index.updatedAt = new Date().toISOString();
      await onCheckpoint(index, { ...stats });
      checkpointAt = stats.processed + checkpointSize;
    }
  }
  resetProcessingBooks(index);
  return stats;
}

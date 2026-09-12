import { extractFb2Metadata, parseFullFb2 } from './fb2.js';
import { extractZipFb2 } from './zip.js';
import { downloadDriveFile, downloadFileRange } from './drive.js';

export async function extractBookMetadata(book, options = {}) {
  const diagnostics = { ...options.diagnostics, onIssue: options.onIssue, stage: 'download' };
  const download = options.downloadFile || ((id, signal, extra = {}) => downloadDriveFile(id, signal, undefined, { ...diagnostics, ...extra }));
  const extractOptions = {
    ...options, downloadFile: download,
    fetchRange: options.fetchRange || ((id, start, end, signal, rangeOptions) => downloadFileRange(id, start, end, signal, { ...rangeOptions, diagnostics })),
  };
  try {
    return await (book.sourceType === 'zip' ? extractZipFb2(book, extractOptions) : extractFb2Metadata(book, extractOptions));
  } catch (error) {
    if (error.status !== 416 || options.signal?.aborted) throw error;
    error.retryResult = 'retry-without-range';
    options.onIssue?.(error);
    let bytes;
    try {
      // One new full request; no inherited Range, offsets, cached ZIP regions or nested retries.
      const blob = await download(book.id, options.signal, { maxRetries: 0 });
      bytes = new Uint8Array(await blob.arrayBuffer());
    } catch (retryError) {
      error.retryResult = 'failed-without-range';
      options.onIssue?.(error);
      retryError.stage ||= 'download';
      retryError.attempt = (error.attempt || 1) + 1;
      retryError.retryResult = 'failed-without-range';
      throw retryError;
    }
    error.retryResult = 'success-without-range';
    options.onIssue?.(error);
    if (book.sourceType !== 'zip') return parseFullFb2(bytes, options.Parser);
    return extractZipFb2({ ...book, size: bytes.length }, {
      ...options,
      fetchRange: async (id, start, end) => ({ bytes: bytes.slice(start, end + 1), status: 206, isComplete: end >= bytes.length - 1 }),
    });
  }
}

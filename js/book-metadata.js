import { extractFb2Metadata, parseFullFb2 } from './fb2.js';
import { extractZipFb2 } from './zip.js';
import { downloadDriveFile, downloadFileRange } from './drive.js';
import { extractEpubMetadata } from './epub.js';
import { extractMobiMetadata } from './mobi.js';
import { BookFormatError } from './book-content.js';

function dispatch(book, options) {
  switch (book.sourceType || 'fb2') {
    case 'fb2': return extractFb2Metadata(book, options);
    case 'zip': return extractZipFb2(book, options);
    case 'epub': return extractEpubMetadata(book, options);
    case 'mobi': return extractMobiMetadata(book, options);
    default: throw new BookFormatError('unsupported_book_format');
  }
}

export async function extractBookMetadata(book, options = {}) {
  try { return await extractWithRangeFallback(book, options); }
  catch (error) { error.containerType = { zip: 'ZIP', epub: 'EPUB', mobi: 'MOBI' }[book.sourceType] || 'raw FB2'; throw error; }
}

async function extractWithRangeFallback(book, options) {
  const diagnostics = { ...options.diagnostics, onIssue: options.onIssue, stage: 'download' };
  const download = options.downloadFile || ((id, signal, extra = {}) => downloadDriveFile(id, signal, undefined, { ...diagnostics, ...extra }));
  const extractOptions = {
    ...options, downloadFile: download,
    fetchRange: options.fetchRange || ((id, start, end, signal, rangeOptions) => downloadFileRange(id, start, end, signal, { ...rangeOptions, diagnostics })),
  };
  try {
    return await dispatch(book, extractOptions);
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
    if (!book.sourceType || book.sourceType === 'fb2') return parseFullFb2(bytes, options.Parser);
    return dispatch({ ...book, size: bytes.length }, {
      ...options,
      fetchRange: async (id, start, end) => ({ bytes: bytes.subarray(start, end + 1), status: 206, isComplete: end >= bytes.length - 1 }),
    });
  }
}

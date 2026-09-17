import { extractFb2Metadata } from './fb2.js';
import { extractZipBook, ZipError } from './zip.js';
import { downloadDriveFile, downloadFileRange } from './drive.js';
import { extractEpubMetadata } from './epub.js';
import { extractMobiMetadata } from './mobi.js';
import { BookFormatError } from './book-content.js';

const memoryRanges = (bytes) => async (id, start, end, signal) => {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= bytes.length) {
    throw new ZipError('malformed_zip', 'Inner book range is outside extracted entry.');
  }
  return { bytes: bytes.subarray(start, end + 1), status: 206, isComplete: end === bytes.length - 1 };
};

async function dispatchZip(book, options) {
  let selected;
  try { selected = await extractZipBook(book, options); }
  catch (error) { error.containerType ||= 'ZIP'; throw error; }
  const innerBook = { ...book, id: `${book.id}:${selected.entryPath}`, fileName: selected.entryPath,
    sourceType: selected.innerFormat, extension: selected.innerFormat, size: selected.bytes.length };
  try {
    const metadata = await dispatch(innerBook, { ...options, fetchRange: memoryRanges(selected.bytes) });
    if (metadata.binaryRecovery) Object.assign(metadata.binaryRecovery, { containerType: 'ZIP', entryPath: selected.entryPath, innerFormat: selected.innerFormat });
    return { ...metadata, entryPath: selected.entryPath, innerFormat: selected.innerFormat,
      ...(selected.metadataWarning ? { metadataWarning: selected.metadataWarning, metadataWarningDetails: selected.metadataWarningDetails } : {}) };
  } catch (error) {
    error.containerType = 'ZIP'; error.entryPath = selected.entryPath; error.innerFormat = selected.innerFormat;
    throw error;
  }
}

function dispatch(book, options) {
  switch (book.sourceType || 'fb2') {
    case 'fb2': return extractFb2Metadata(book, { ...options, onZip: async (bytes, complete) => {
      try {
        const metadata = await dispatchZip({ ...book, size: complete ? bytes.length : book.size }, { ...options,
          fetchRange: async (id, start, end, signal, rangeOptions) => end < bytes.length
            ? { bytes: bytes.subarray(start, end + 1), status: 206, isComplete: complete && end === bytes.length - 1 }
            : options.fetchRange(id, start, end, signal, rangeOptions),
        });
        if (metadata.binaryRecovery) metadata.binaryRecovery.containerDetectedBySignature = true;
        return metadata;
      } catch (error) { error.containerType = 'ZIP'; error.containerDetectedBySignature = true; throw error; }
    } });
    case 'zip': return dispatchZip(book, options);
    case 'epub': return extractEpubMetadata(book, options);
    case 'mobi': return extractMobiMetadata(book, options);
    default: throw new BookFormatError('unsupported_book_format');
  }
}

export async function extractBookMetadata(book, options = {}) {
  try { return await extractWithRangeFallback(book, options); }
  catch (error) { error.containerType ||= { zip: 'ZIP', epub: 'EPUB', mobi: 'MOBI' }[book.sourceType] || 'raw FB2'; throw error; }
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
    return dispatch({ ...book, size: bytes.length }, {
      ...options,
      downloadFile: async () => new Blob([bytes]),
      fetchRange: async (id, start, end) => ({ bytes: bytes.subarray(start, end + 1), status: 206, isComplete: end >= bytes.length - 1 }),
    });
  }
}

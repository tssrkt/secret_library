import { extractFb2Metadata } from './fb2.js';
import { extractZipFb2 } from './zip.js';

export function extractBookMetadata(book, options = {}) {
  return book.sourceType === 'zip'
    ? extractZipFb2(book, options)
    : extractFb2Metadata(book, options);
}

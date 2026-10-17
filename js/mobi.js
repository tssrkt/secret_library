import { downloadFileRange } from './drive.js';
import { MOBI_HEADER_BYTES, MOBI_MAX_RECORDS, BOOK_COVER_BYTES, BOOK_PREVIEW_BYTES } from './config.js';
import { BookFormatError, emptyBookMetadata, cleanText, uniqueText, plainDescription, htmlPreview, usableCover, optionalResource } from './book-content.js';

const invalid = (message) => new BookFormatError('invalid_mobi', message);
const ascii = (bytes) => String.fromCharCode(...bytes);
// Common primary LCIDs. EXTH 524 (when present) takes precedence; unknown IDs
// remain null, rather than guessing a language from the book's text.
const LANGUAGES = { 1: 'ar', 4: 'zh', 5: 'cs', 6: 'da', 7: 'de', 8: 'el', 9: 'en', 10: 'es', 11: 'fi', 12: 'fr',
  13: 'he', 14: 'hu', 16: 'it', 17: 'ja', 18: 'ko', 19: 'nl', 20: 'no', 21: 'pl', 22: 'pt', 24: 'ro', 25: 'ru', 29: 'sv', 31: 'tr', 34: 'uk' };

function imageDimensions(bytes) {
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes.subarray(1, 4)) === 'PNG') {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: data.getUint32(16), height: data.getUint32(20) };
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(ascii(bytes.subarray(0, 6)))) {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: data.getUint16(6, true), height: data.getUint16(8, true) };
  }
  if (bytes.length >= 30 && ascii(bytes.subarray(0, 4)) === 'RIFF' && ascii(bytes.subarray(8, 12)) === 'WEBP') {
    const type = ascii(bytes.subarray(12, 16));
    if (type === 'VP8X') return { width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) };
    if (type === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); return { width: data.getUint16(26, true) & 0x3fff, height: data.getUint16(28, true) & 0x3fff };
    }
    if (type === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let position = 2; position + 9 < bytes.length;) {
    if (bytes[position] !== 0xff) { position += 1; continue; }
    const marker = bytes[position + 1]; position += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (position + 2 > bytes.length) return null;
    const length = (bytes[position] << 8) | bytes[position + 1];
    if (length < 2 || position + length > bytes.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: (bytes[position + 3] << 8) | bytes[position + 4], width: (bytes[position + 5] << 8) | bytes[position + 6] };
    }
    position += length;
  }
  return null;
}

function coverScore(dimensions) {
  if (!dimensions || dimensions.width < 120 || dimensions.height < 160 || dimensions.height <= dimensions.width) return null;
  const ratio = dimensions.height / dimensions.width;
  if (ratio < 1.15 || ratio > 3) return null;
  // Area wins for equivalent cover-shaped images, while the ratio term keeps
  // tall book art ahead of banners and other incidental illustrations.
  return dimensions.width * dimensions.height * Math.min(ratio, 2);
}

function palmdoc(bytes, limit) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i];
    if (value >= 1 && value <= 8) {
      if (i + value >= bytes.length) throw invalid('Truncated PalmDOC literal.');
      for (let n = 0; n < value; n++) out.push(bytes[++i]);
    } else if (value <= 0x7f) out.push(value);
    else if (value >= 0xc0) out.push(32, value ^ 0x80);
    else {
      if (++i >= bytes.length) throw invalid('Truncated PalmDOC back-reference.');
      const pair = (value << 8) | bytes[i];
      const distance = (pair & 0x3fff) >>> 3;
      const length = (pair & 7) + 3;
      if (!distance || distance > out.length) throw invalid('Invalid PalmDOC distance.');
      for (let n = 0; n < length; n++) out.push(out[out.length - distance]);
    }
    if (out.length > limit) throw invalid('PalmDOC preview exceeds its budget.');
  }
  return new Uint8Array(out);
}

export async function extractMobiMetadata(book, { signal, fetchRange = downloadFileRange } = {}) {
  const size = Number(book.size);
  if (!Number.isSafeInteger(size) || size < 86) throw invalid('MOBI/PDB header is truncated.');
  const regions = [];
  const read = async (start, length, limit) => {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || length < 0 || length > limit || start < 0 || start + length > size) throw invalid('MOBI record is outside its bounds or memory budget.');
    if (!length) return new Uint8Array();
    const cached = regions.find((region) => start >= region.start && start + length <= region.start + region.bytes.length);
    if (cached) return cached.bytes.subarray(start - cached.start, start - cached.start + length);
    const result = await fetchRange(book.id, start, start + length - 1, signal, { requirePartial: !(start === 0 && length === size) });
    if (result.status === 200 && result.bytes.length === size) {
      regions.push({ start: 0, bytes: result.bytes }); return result.bytes.subarray(start, start + length);
    }
    if (result.bytes.length !== length) throw invalid('Unexpected MOBI range length.');
    regions.push({ start, bytes: result.bytes });
    return result.bytes;
  };
  const header = await read(0, 78, 78);
  if (ascii(header.subarray(60, 68)) !== 'BOOKMOBI') throw new BookFormatError('unsupported_mobi', 'Expected a Mobipocket BOOK/MOBI database.');
  const count = new DataView(header.buffer, header.byteOffset).getUint16(76);
  if (!count || count > MOBI_MAX_RECORDS) throw invalid('Invalid PDB record count.');
  const directory = await read(78, count * 8, MOBI_MAX_RECORDS * 8);
  const offsets = [];
  const directoryView = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  for (let i = 0; i < count; i++) {
    const offset = directoryView.getUint32(i * 8);
    if (offset < 78 + count * 8 || offset >= size || (i && offset <= offsets[i - 1])) throw invalid('Invalid PDB record offsets.');
    offsets.push(offset);
  }
  offsets.push(size);
  const record = (index, limit) => index >= 0 && index < count ? read(offsets[index], offsets[index + 1] - offsets[index], limit) : Promise.reject(invalid('Missing MOBI record.'));
  const zero = await record(0, MOBI_HEADER_BYTES);
  if (zero.length < 108 || ascii(zero.subarray(16, 20)) !== 'MOBI') throw invalid('MOBI header is missing.');
  const view = new DataView(zero.buffer, zero.byteOffset, zero.byteLength);
  const headerLength = view.getUint32(20);
  if (headerLength < 92 || 16 + headerLength > zero.length) throw invalid('Invalid MOBI header length.');
  const codepage = view.getUint32(28);
  let decoder;
  try { decoder = new TextDecoder(codepage === 65001 ? 'utf-8' : codepage === 1200 ? 'utf-16le' : `windows-${codepage || 1252}`); }
  catch { throw new BookFormatError('unsupported_mobi', 'Unsupported MOBI metadata encoding.'); }
  const decode = (bytes) => cleanText(decoder.decode(bytes).replace(/\0+$/, ''));
  const fields = new Map();
  if (headerLength >= 116 && (view.getUint32(128) & 0x40)) {
    let position = 16 + headerLength;
    if (position + 12 > zero.length || ascii(zero.subarray(position, position + 4)) !== 'EXTH') throw invalid('EXTH header missing.');
    const end = position + view.getUint32(position + 4);
    const records = view.getUint32(position + 8);
    if (end > zero.length || end < position + 12 || records > 4096) throw invalid('Invalid EXTH bounds.');
    position += 12;
    for (let i = 0; i < records; i++) {
      if (position + 8 > end) throw invalid('Truncated EXTH record.');
      const type = view.getUint32(position), length = view.getUint32(position + 4);
      if (length < 8 || position + length > end) throw invalid('Invalid EXTH record length.');
      if (!fields.has(type)) fields.set(type, []);
      fields.get(type).push(zero.subarray(position + 8, position + length));
      position += length;
    }
  }
  const texts = (type) => (fields.get(type) || []).map(decode).filter(Boolean);
  const titleOffset = view.getUint32(84), titleLength = view.getUint32(88);
  const title = titleOffset >= 16 + headerLength && titleOffset + titleLength <= zero.length ? decode(zero.subarray(titleOffset, titleOffset + titleLength)) : null;
  const metadata = { ...emptyBookMetadata(), title: texts(503)[0] || title || null,
    authors: uniqueText(texts(100)), genres: uniqueText(texts(105).flatMap((text) => text.split(';'))),
    annotation: plainDescription(texts(103).join('\n\n')),
    language: texts(524)[0] || LANGUAGES[view.getUint32(92) & 0x3ff] || null };
  // No universally reliable series field in MOBI EXTH: do not infer from title.
  const firstImage = headerLength >= 96 ? view.getUint32(108) : 0xffffffff;
  const coverOffset = fields.get(201)?.[0];
  if (coverOffset?.length === 4 && firstImage !== 0xffffffff) {
    const coverIndex = firstImage + new DataView(coverOffset.buffer, coverOffset.byteOffset, 4).getUint32(0);
    if (coverIndex > 0 && coverIndex < count) metadata.cover = await optionalResource(async () => usableCover(await record(coverIndex, BOOK_COVER_BYTES), signal));
  }
  // Older MOBI files often have image records but omit EXTH 201.  Examine a
  // bounded run of those records and choose cover-like artwork, rather than
  // assuming the first image is a cover (it is commonly a publisher logo).
  if (!metadata.cover && firstImage !== 0xffffffff && firstImage > 0 && firstImage < count) {
    let best = null;
    for (let index = firstImage; index < Math.min(count, firstImage + 128); index += 1) {
      const length = offsets[index + 1] - offsets[index];
      if (length <= 0 || length > BOOK_COVER_BYTES) continue;
      const candidate = await optionalResource(async () => {
        const image = await record(index, BOOK_COVER_BYTES);
        return { image, score: coverScore(imageDimensions(image)) };
      });
      if (candidate?.score != null && (!best || candidate.score > best.score)) best = candidate;
    }
    if (best) metadata.cover = await optionalResource(async () => usableCover(best.image, signal));
  }
  const compression = view.getUint16(0), textRecords = view.getUint16(8);
  const encrypted = view.getUint16(12) !== 0 || (headerLength >= 160 && view.getUint32(172) > 0);
  const extraFlags = headerLength >= 228 ? view.getUint16(242) : 0;
  const version = view.getUint32(36);
  if (!metadata.annotation && !encrypted && version <= 6 && !extraFlags && [1, 2].includes(compression)) {
    metadata.preview = await optionalResource(async () => {
      const chunks = [];
      let total = 0;
      for (let index = 1; index <= Math.min(textRecords, count - 1, 8); index++) {
        if (index >= firstImage) break;
        const bytes = await record(index, BOOK_PREVIEW_BYTES / 8);
        const plain = compression === 2 ? palmdoc(bytes, BOOK_PREVIEW_BYTES / 8) : bytes;
        chunks.push(plain); total += plain.length;
      }
      const combined = new Uint8Array(total);
      let offset = 0; for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
      return htmlPreview(decoder.decode(combined));
    });
  }
  signal?.throwIfAborted();
  return metadata;
}

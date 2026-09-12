import {
  ZIP_MAX_CENTRAL_DIRECTORY_SIZE,
  ZIP_MAX_COMPRESSED_ENTRY_SIZE,
  ZIP_MAX_FB2_ENTRY_SIZE,
  ZIP_TAIL_SIZE,
} from './config.js';
import { downloadFileRange } from './drive.js';
import { Fb2Error, parseFullFb2 } from './fb2.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export class ZipError extends Fb2Error {}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u16(bytes, offset) { return view(bytes).getUint16(offset, true); }
function u32(bytes, offset) { return view(bytes).getUint32(offset, true); }

function assertRange(start, end, size, code = 'malformed_zip') {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= size) {
    throw new ZipError(code, 'ZIP contains an invalid offset or size.');
  }
}

function decodeEntryName(bytes, utf8) {
  return new TextDecoder(utf8 ? 'utf-8' : 'windows-1252').decode(bytes);
}

class ZipRanges {
  constructor(fileId, fileSize, fetchRange) {
    this.fileId = fileId;
    this.fileSize = fileSize;
    this.fetchRange = fetchRange;
    this.regions = [];
  }

  async read(start, end, signal) {
    assertRange(start, end, this.fileSize);
    const cached = this.regions.find((region) => start >= region.start && end <= region.end);
    if (cached) return cached.bytes.slice(start - cached.start, end - cached.start + 1);
    const wholeFile = start === 0 && end === this.fileSize - 1;
    const response = await this.fetchRange(this.fileId, start, end, signal, { requirePartial: !wholeFile });
    const expected = end - start + 1;
    if (response.bytes.length !== expected) throw new ZipError('malformed_zip', 'ZIP Range response has an unexpected length.');
    this.regions.push({ start, end, bytes: response.bytes });
    return response.bytes;
  }
}

export function findEocd(tail, tailStart, fileSize) {
  const data = view(tail);
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (data.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = data.getUint16(offset + 20, true);
    if (offset + 22 + commentLength !== tail.length) continue;
    const diskNumber = data.getUint16(offset + 4, true);
    const centralDisk = data.getUint16(offset + 6, true);
    const entriesOnDisk = data.getUint16(offset + 8, true);
    const entryCount = data.getUint16(offset + 10, true);
    const centralSize = data.getUint32(offset + 12, true);
    const centralOffset = data.getUint32(offset + 16, true);
    if (diskNumber || centralDisk || entriesOnDisk !== entryCount) throw new ZipError('unsupported_zip', 'Multi-disk ZIP is unsupported.');
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new ZipError('unsupported_zip64', 'ZIP64 is not supported.');
    }
    if (centralSize > ZIP_MAX_CENTRAL_DIRECTORY_SIZE) throw new ZipError('zip_central_directory_too_large');
    if (entryCount && !centralSize) throw new ZipError('malformed_zip');
    const eocdOffset = tailStart + offset;
    if (centralOffset + centralSize > eocdOffset || centralOffset + centralSize > fileSize) {
      throw new ZipError('malformed_zip', 'Central directory is outside ZIP boundaries.');
    }
    return { entryCount, centralSize, centralOffset };
  }
  throw new ZipError('malformed_zip', 'ZIP EOCD record was not found.');
}

export function parseCentralDirectory(bytes, expectedEntries, fileSize) {
  const entries = [];
  let offset = 0;
  for (let index = 0; index < expectedEntries; index += 1) {
    if (offset + 46 > bytes.length || u32(bytes, offset) !== CENTRAL_SIGNATURE) throw new ZipError('malformed_zip');
    const flags = u16(bytes, offset + 8);
    const method = u16(bytes, offset + 10);
    const compressedSize = u32(bytes, offset + 20);
    const uncompressedSize = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const diskStart = u16(bytes, offset + 34);
    const localHeaderOffset = u32(bytes, offset + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (offset + recordLength > bytes.length) throw new ZipError('malformed_zip');
    if ([compressedSize, uncompressedSize, localHeaderOffset].includes(0xffffffff) || diskStart === 0xffff) {
      throw new ZipError('unsupported_zip64');
    }
    const name = decodeEntryName(bytes.slice(offset + 46, offset + 46 + nameLength), Boolean(flags & 0x0800));
    if (localHeaderOffset >= fileSize) throw new ZipError('malformed_zip');
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += recordLength;
  }
  return entries;
}

function suitableFb2Entries(entries) {
  return entries.filter(({ name }) => {
    const normalized = name.replaceAll('\\', '/');
    return !normalized.endsWith('/')
      && !normalized.split('/').some((part) => part === '__MACOSX')
      && !normalized.toLowerCase().endsWith('/thumbs.db')
      && /\.fb2$/i.test(normalized);
  });
}

async function inflateFb2(compressed, signal) {
  if (typeof DecompressionStream !== 'function') throw new ZipError('unsupported_compression', 'Deflate is unsupported by this browser.');
  let stream;
  try { stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')); }
  catch { throw new ZipError('unsupported_compression', 'Raw Deflate is unsupported by this browser.'); }
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (length <= ZIP_MAX_FB2_ENTRY_SIZE) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      length += result.value.length;
    }
  } catch (error) {
    if (error?.name === 'AbortError' || error instanceof Fb2Error) throw error;
    throw new ZipError('malformed_zip', 'Deflate stream is damaged.');
  } finally {
    reader.releaseLock();
  }
  if (length > ZIP_MAX_FB2_ENTRY_SIZE) throw new ZipError('zip_entry_too_large');
  const combined = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) { combined.set(chunk, cursor); cursor += chunk.length; }
  return combined;
}

export async function extractZipFb2(book, {
  signal,
  Parser = globalThis.DOMParser,
  fetchRange = downloadFileRange,
} = {}) {
  const fileSize = Number(book.size);
  if (!Number.isSafeInteger(fileSize) || fileSize < 22) throw new ZipError('malformed_zip');
  const ranges = new ZipRanges(book.id, fileSize, fetchRange);
  const tailStart = Math.max(0, fileSize - ZIP_TAIL_SIZE);
  const tail = await ranges.read(tailStart, fileSize - 1, signal);
  const eocd = findEocd(tail, tailStart, fileSize);
  if (!eocd.entryCount) throw new ZipError('zip_no_fb2');
  const central = await ranges.read(eocd.centralOffset, eocd.centralOffset + eocd.centralSize - 1, signal);
  const candidates = suitableFb2Entries(parseCentralDirectory(central, eocd.entryCount, fileSize));
  if (!candidates.length) throw new ZipError('zip_no_fb2', 'ZIP contains no FB2 entry.');
  const entry = candidates[0];
  if (entry.flags & 1) throw new ZipError('encrypted_zip', 'Encrypted ZIP entries are unsupported.');
  if (![0, 8].includes(entry.method)) throw new ZipError('unsupported_compression');
  if (entry.compressedSize > ZIP_MAX_COMPRESSED_ENTRY_SIZE) throw new ZipError('zip_entry_too_large');
  if (entry.uncompressedSize > ZIP_MAX_FB2_ENTRY_SIZE) throw new ZipError('zip_entry_too_large');

  const local = await ranges.read(entry.localHeaderOffset, entry.localHeaderOffset + 29, signal);
  if (u32(local, 0) !== LOCAL_SIGNATURE) throw new ZipError('malformed_zip');
  const dataOffset = entry.localHeaderOffset + 30 + u16(local, 26) + u16(local, 28);
  if (!entry.compressedSize || dataOffset + entry.compressedSize > fileSize) throw new ZipError('malformed_zip');

  let fb2Bytes;
  if (entry.method === 0) {
    const end = dataOffset + entry.compressedSize - 1;
    fb2Bytes = await ranges.read(dataOffset, end, signal);
  } else {
    const compressed = await ranges.read(dataOffset, dataOffset + entry.compressedSize - 1, signal);
    fb2Bytes = await inflateFb2(compressed, signal);
  }
  return {
    ...parseFullFb2(fb2Bytes, Parser),
    entryPath: entry.name.replaceAll('\\', '/'),
    ...(candidates.length > 1 ? { metadataWarning: 'multiple_fb2_entries' } : {}),
  };
}

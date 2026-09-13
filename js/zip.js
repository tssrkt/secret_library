import {
  ZIP_MAX_CENTRAL_DIRECTORY_SIZE,
  ZIP_MAX_COMPRESSED_ENTRY_SIZE,
  ZIP_MAX_FB2_ENTRY_SIZE,
  ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES, ZIP_MAX_COMPRESSION_RATIO, ZIP_MAX_ENTRY_COUNT,
  ZIP_PARALLEL_ENTRY_BUDGET,
  ZIP_TAIL_SIZE,
} from './config.js';
import { downloadFileRange } from './drive.js';
import { Fb2Error, parseFullFb2 } from './fb2.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
let largeEntryTail = Promise.resolve();

// Avoid three simultaneous large byte buffers + decoded strings + DOM trees.
async function withEntryMemoryBudget(entry, signal, action) {
  if (entry.uncompressedSize <= ZIP_PARALLEL_ENTRY_BUDGET && entry.compressedSize <= ZIP_PARALLEL_ENTRY_BUDGET) return action();
  const previous = largeEntryTail;
  let release;
  largeEntryTail = new Promise((resolve) => { release = resolve; });
  try { await previous; signal?.throwIfAborted(); return await action(); }
  finally { release(); }
}

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
    if (cached) return cached.bytes.subarray(start - cached.start, end - cached.start + 1);
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
    if (entryCount > ZIP_MAX_ENTRY_COUNT) throw new ZipError('zip_too_many_entries', 'ZIP exceeds the 4096-entry safety budget.');
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
  if (expectedEntries > ZIP_MAX_ENTRY_COUNT) throw new ZipError('zip_too_many_entries');
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

export function validateZipBudgets(entries, entry, fileSize) {
  const total = entries.reduce((sum, item) => sum + item.uncompressedSize, 0);
  if (total > ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) throw new ZipError('zip_total_uncompressed_limit_exceeded', 'ZIP declares more than 512 MiB across its entries.');
  if (entry.uncompressedSize / Math.max(1, entry.compressedSize) > ZIP_MAX_COMPRESSION_RATIO
      || total / Math.max(1, fileSize) > ZIP_MAX_COMPRESSION_RATIO) {
    throw new ZipError('zip_suspicious_compression_ratio', 'ZIP compression ratio exceeds 500:1.');
  }
  if (entry.compressedSize > ZIP_MAX_COMPRESSED_ENTRY_SIZE) throw new ZipError('zip_compressed_limit_exceeded', 'Selected ZIP entry exceeds the 64 MiB input budget.');
  if (entry.uncompressedSize > ZIP_MAX_FB2_ENTRY_SIZE) throw new ZipError('zip_uncompressed_limit_exceeded', 'Selected FB2 exceeds the 128 MiB output budget.');
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

async function inflateFb2(compressed, expectedSize, signal) {
  if (typeof DecompressionStream !== 'function') throw new ZipError('unsupported_compression', 'Deflate is unsupported by this browser.');
  let stream;
  try {
    stream = new ReadableStream({ start(controller) { controller.enqueue(compressed); controller.close(); } })
      .pipeThrough(new DecompressionStream('deflate-raw'));
  }
  catch { throw new ZipError('unsupported_compression', 'Raw Deflate is unsupported by this browser.'); }
  const reader = stream.getReader();
  const combined = new Uint8Array(expectedSize);
  let length = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await reader.read();
      if (result.done) break;
      if (length + result.value.length > expectedSize) throw new ZipError('malformed_zip', 'Inflated output exceeds its declared size.');
      combined.set(result.value, length);
      length += result.value.length;
    }
  } catch (error) {
    if (error?.name === 'AbortError' || error instanceof Fb2Error) throw error;
    throw new ZipError('malformed_zip', 'Deflate stream is damaged.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (length !== expectedSize) throw new ZipError('malformed_zip', 'Inflated output differs from its declared size.');
  return combined;
}

// Shared ZIP infrastructure for FB2 archives and EPUB; only requested entries inflate.
export async function openZip(book, { signal, fetchRange = downloadFileRange } = {}) {
  signal?.throwIfAborted();
  const fileSize = Number(book.size);
  if (!Number.isSafeInteger(fileSize) || fileSize < 22) throw new ZipError('malformed_zip');
  const ranges = new ZipRanges(book.id, fileSize, fetchRange);
  const tailStart = Math.max(0, fileSize - ZIP_TAIL_SIZE);
  const tail = await ranges.read(tailStart, fileSize - 1, signal);
  const eocd = findEocd(tail, tailStart, fileSize);
  const entries = eocd.entryCount ? parseCentralDirectory(
    await ranges.read(eocd.centralOffset, eocd.centralOffset + eocd.centralSize - 1, signal), eocd.entryCount, fileSize) : [];
  return {
    entries,
    async readEntry(entry, maxBytes = ZIP_MAX_FB2_ENTRY_SIZE) {
      signal?.throwIfAborted();
      if (!entries.includes(entry)) throw new ZipError('malformed_zip');
      if (entry.flags & 1) throw new ZipError('encrypted_zip', 'Encrypted ZIP entries are unsupported.');
      if (![0, 8].includes(entry.method)) throw new ZipError('unsupported_compression');
      validateZipBudgets(entries, entry, fileSize);
      if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes + ZIP_TAIL_SIZE) {
        throw new ZipError('zip_entry_limit_exceeded', 'Resource exceeds its extraction memory budget.');
      }
      const local = await ranges.read(entry.localHeaderOffset, entry.localHeaderOffset + 29, signal);
      if (u32(local, 0) !== LOCAL_SIGNATURE || u16(local, 8) !== entry.method) throw new ZipError('malformed_zip');
      const dataOffset = entry.localHeaderOffset + 30 + u16(local, 26) + u16(local, 28);
      if (!entry.compressedSize || dataOffset + entry.compressedSize > eocd.centralOffset) throw new ZipError('malformed_zip');
      const compressed = await ranges.read(dataOffset, dataOffset + entry.compressedSize - 1, signal);
      if (entry.method === 0) {
        if (entry.compressedSize !== entry.uncompressedSize) throw new ZipError('malformed_zip', 'Stored entry size mismatch.');
        return compressed;
      }
      return inflateFb2(compressed, entry.uncompressedSize, signal);
    },
  };
}

export async function extractZipFb2(book, options = {}) {
  const archive = await openZip(book, options);
  const candidates = suitableFb2Entries(archive.entries);
  if (!candidates.length) throw new ZipError('zip_no_fb2', 'ZIP contains no FB2 entry.');
  const entry = candidates[0];
  return withEntryMemoryBudget(entry, options.signal, async () => {
    const bytes = await archive.readEntry(entry);
    let metadata;
    try { metadata = parseFullFb2(bytes, options.Parser); }
    catch (error) { error.containerType = 'ZIP'; throw error; }
    if (metadata.binaryRecovery) metadata.binaryRecovery.containerType = 'ZIP';
    return { ...metadata, entryPath: entry.name.replaceAll('\\', '/'),
      ...(candidates.length > 1 ? { metadataWarning: 'multiple_fb2_entries' } : {}) };
  });
}

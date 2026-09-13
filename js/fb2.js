import { downloadDriveFile, downloadFileRange } from './drive.js';
import { recoverBinaryXml, xmlParserDiagnostics } from './fb2-binary-recovery.js';
import { sniffFb2 } from './fb2-format.js';

// Bounded geometric reads, not one request per MiB. Full XML still has a memory budget.
export const MAX_FB2_DOCUMENT_BYTES = 128 * 1024 * 1024;

export const FB2_RANGES = Object.freeze([
  [0, 65_535],
  [65_536, 262_143],
  [262_144, 1_048_575],
  ...[2, 4, 8, 16, 32, 64, 128].map((mib) => [mib * 1024 * 1024 / 2, mib * 1024 * 1024 - 1]),
]);

export class Fb2Error extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'Fb2Error';
    this.code = code;
    this.stage = ['invalid_xml', 'unsupported_encoding', 'parse_failed'].includes(code) ? 'parse' : 'metadata-extraction';
  }
}

function asciiProbe(bytes, limit = 1024) {
  return String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, limit)));
}

export function detectEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';

  const probe = asciiProbe(bytes).replaceAll('\0', '');
  const declaration = probe.match(/<\?xml\s[^>]*encoding\s*=\s*["']\s*([^"']+)\s*["']/i);
  const declared = declaration?.[1]?.trim().toLowerCase().replaceAll('_', '-');
  if (bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0) return 'utf-16be';
  if (bytes[0] === 0x3c && bytes[1] === 0 && bytes[3] === 0) return 'utf-16le';
  if (!declared || ['utf-8', 'utf8'].includes(declared)) return 'utf-8';
  if (['windows-1251', 'cp1251', 'x-cp1251'].includes(declared)) return 'windows-1251';
  if (['utf-16', 'utf16'].includes(declared)) {
    if (bytes[0] === 0 && bytes[1] === 0x3c) return 'utf-16be';
    return 'utf-16le';
  }
  if (['utf-16le', 'utf16le'].includes(declared)) return 'utf-16le';
  if (['utf-16be', 'utf16be'].includes(declared)) return 'utf-16be';
  // TextDecoder supplies the standard legacy encodings and canonical labels.
  const label = declared.replace(/^windows(\d+)$/, 'windows-$1');
  try { return new TextDecoder(label).encoding; }
  catch { throw Object.assign(new Fb2Error('unsupported_encoding', `Unsupported FB2 encoding: ${declared.slice(0, 80)}`), { encoding: declared.slice(0, 80) }); }
}

export function decodeFb2(bytes) {
  const encoding = detectEncoding(bytes);
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch (error) {
    if (error instanceof Fb2Error) throw error;
    throw new Fb2Error('invalid_xml', 'FB2 text cannot be decoded.');
  }
}

export function descriptionEnd(text) {
  const match = /<\/([\w.-]+:)?description\s*>/i.exec(text);
  return match ? match.index + match[0].length : -1;
}

function concatChunks(chunks, totalLength) {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function readFb2Prefix(fileId, { signal, fetchRange = downloadFileRange, size } = {}) {
  const chunks = [];
  let totalLength = 0;
  for (const [start, end] of FB2_RANGES) {
    signal?.throwIfAborted();
    if (Number.isFinite(size) && start >= size) break;
    const response = await fetchRange(fileId, start, Number.isFinite(size) ? Math.min(end, size - 1) : end, signal);
    if (response.status === 200) { chunks.length = 0; totalLength = 0; }
    chunks.push(response.bytes);
    totalLength += response.bytes.length;
    const bytes = concatChunks(chunks, totalLength);
    let text;
    try { text = decodeFb2(bytes); }
    catch (error) {
      // A partial range may end inside a multibyte character.
      if (error.code === 'invalid_xml' && !response.isComplete && end < FB2_RANGES.at(-1)[1]) continue;
      throw error;
    }
    const endIndex = descriptionEnd(text);
    const complete = response.status === 200 || response.isComplete || (Number.isFinite(size) && bytes.length >= size);
    if (endIndex >= 0 || complete) return { prefix: endIndex >= 0 ? text.slice(0, endIndex) : null, bytes, complete };
  }
  throw new Fb2Error('description_scan_limit_exceeded', 'Description search reached the 128 MiB memory budget before end of file.');
}

export async function readFb2Description(fileId, options = {}) {
  const result = await readFb2Prefix(fileId, options);
  if (!result.prefix) throw new Fb2Error('description_missing', 'FB2 description is absent from the complete document.');
  return result.prefix;
}

function directChild(element, localName) {
  if (!element) return null;
  return [...element.children].find((child) => child.localName === localName) || null;
}

function childText(element, localName) {
  return directChild(element, localName)?.textContent?.replace(/\s+/g, ' ').trim() || '';
}

function atStage(stage, action) {
  try { return action(); } catch (error) { error.stage = stage; throw error; }
}

function annotationText(annotation) {
  if (!annotation) return null;
  const blocks = [...annotation.children]
    .filter((element) => ['p', 'subtitle', 'cite', 'poem', 'text-author'].includes(element.localName))
    .map((element) => element.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (blocks.length) return blocks.join('\n\n');
  return annotation.textContent.replace(/\s+/g, ' ').trim() || null;
}

const PREVIEW_TARGET_LENGTH = 800;
const PREVIEW_MAX_LENGTH = 1_200;
const PREVIEW_EXCLUDED_ANCESTORS = new Set([
  'annotation', 'cite', 'epigraph', 'history', 'poem', 'subtitle', 'title',
]);

function normalizedBlockText(element) {
  return element.textContent.replace(/\s+/g, ' ').trim();
}

function isMainTextParagraph(paragraph, body) {
  let parent = paragraph.parentElement;
  while (parent && parent !== body) {
    if (PREVIEW_EXCLUDED_ANCESTORS.has(parent.localName)) return false;
    parent = parent.parentElement;
  }
  const text = normalizedBlockText(paragraph);
  return (text.match(/[\p{L}\p{N}]+/gu) || []).length >= 2;
}

function truncateAtWord(text, limit) {
  if (text.length <= limit) return text;
  const candidate = text.slice(0, limit + 1);
  const boundary = Math.max(candidate.lastIndexOf(' '), candidate.lastIndexOf('\u00a0'));
  return (boundary > 0 ? candidate.slice(0, boundary) : text.slice(0, limit)).trim();
}

export function extractBodyPreview(document) {
  const bodies = [...document.getElementsByTagNameNS('*', 'body')];
  const body = bodies.find((element) => !element.getAttribute('name')?.trim())
    || bodies.find((element) => !/^(notes?|comments?|footnotes?)$/i.test(element.getAttribute('name')?.trim() || ''))
    || bodies[0];
  if (!body) return null;

  const blocks = [];
  let length = 0;
  for (const paragraph of body.getElementsByTagNameNS('*', 'p')) {
    if (!isMainTextParagraph(paragraph, body)) continue;
    const text = normalizedBlockText(paragraph);
    const separatorLength = blocks.length ? 2 : 0;
    if (blocks.length && length >= PREVIEW_TARGET_LENGTH && length + separatorLength + text.length > PREVIEW_MAX_LENGTH) break;
    if (!blocks.length && text.length > PREVIEW_MAX_LENGTH) {
      blocks.push(truncateAtWord(text, PREVIEW_MAX_LENGTH));
      break;
    }
    if (blocks.length && length + separatorLength + text.length > PREVIEW_MAX_LENGTH) {
      const remainder = PREVIEW_MAX_LENGTH - length - separatorLength;
      const fragment = truncateAtWord(text, remainder);
      if (fragment) blocks.push(fragment);
      break;
    }
    blocks.push(text);
    length += separatorLength + text.length;
    if (length >= PREVIEW_TARGET_LENGTH) break;
  }
  return blocks.join('\n\n') || null;
}

function titleInfoMetadata(titleInfo) {
  const authors = [...titleInfo.children]
    .filter((element) => element.localName === 'author')
    .map((author) => [
      childText(author, 'first-name'), childText(author, 'middle-name'),
      childText(author, 'last-name'), childText(author, 'nickname'),
    ].filter(Boolean).join(' '))
    .filter(Boolean);
  const genres = [...new Set([...titleInfo.children]
    .filter((element) => element.localName === 'genre')
    .map((element) => element.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean))];
  const sequence = [...titleInfo.children].find((element) => element.localName === 'sequence');
  const sequenceNumber = sequence?.getAttribute('number');
  const parsedNumber = sequenceNumber == null || sequenceNumber.trim() === '' ? null : Number(sequenceNumber);
  const coverImage = directChild(directChild(titleInfo, 'coverpage'), 'image');
  const coverHref = coverImage?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
    || coverImage?.getAttribute('xlink:href') || coverImage?.getAttribute('href') || null;
  return {
    title: childText(titleInfo, 'book-title') || null,
    authors,
    genres,
    series: sequence?.getAttribute('name')?.trim() || null,
    seriesNumber: Number.isFinite(parsedNumber) ? parsedNumber : null,
    annotation: atStage('annotation', () => annotationText(directChild(titleInfo, 'annotation'))),
    preview: null,
    language: childText(titleInfo, 'lang') || null,
    coverId: coverHref?.replace(/^#/, '') || null,
  };
}

export function parseFb2Metadata(descriptionPrefix, Parser = globalThis.DOMParser) {
  if (!Parser) throw new Fb2Error('parse_failed', 'DOMParser is unavailable.');
  const rootMatch = /<([\w.-]+:)?FictionBook\b[^>]*>/i.exec(descriptionPrefix);
  if (!rootMatch) throw new Fb2Error('invalid_xml', 'FictionBook root element is missing.');
  const rootName = rootMatch[0].match(/^<([^\s>]+)/)[1];
  const fragment = `${descriptionPrefix}</${rootName}>`;
  const document = new Parser().parseFromString(fragment, 'application/xml');
  if (document.querySelector('parsererror')) throw Object.assign(new Fb2Error('invalid_xml', 'FB2 description is malformed XML.'), xmlParserDiagnostics(document));

  const description = [...document.getElementsByTagNameNS('*', 'description')][0];
  const titleInfo = description && directChild(description, 'title-info');
  if (!titleInfo) throw new Fb2Error('parse_failed', 'FB2 title-info is missing.');

  return titleInfoMetadata(titleInfo);
}

function decodeBase64(text) {
  try {
    const binary = atob(text.replace(/\s+/g, ''));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Fb2Error('invalid_xml', 'FB2 cover contains invalid base64 data.');
  }
}

export function parseFullFb2(bytes, Parser = globalThis.DOMParser) {
  let encoding;
  try {
    if (bytes.length > MAX_FB2_DOCUMENT_BYTES) throw new Fb2Error('fb2_memory_limit_exceeded', 'Full FB2 parse exceeds the 128 MiB memory budget.');
    encoding = detectEncoding(bytes);
    return parseFullDocument(bytes, Parser);
  } catch (error) {
    error.encoding ||= encoding || 'unknown';
    error.containerType ||= 'raw FB2';
    throw error;
  }
}

function parseFullDocument(bytes, Parser) {
  if (!Parser) throw new Fb2Error('parse_failed', 'DOMParser is unavailable.');
  const text = decodeFb2(bytes);
  const encoding = detectEncoding(bytes);
  const format = sniffFb2(bytes, text);
  let document = new Parser().parseFromString(text, 'application/xml');
  let recovery = null;
  if (document.querySelector('parsererror')) {
    const diagnostics = xmlParserDiagnostics(document);
    const binaryRecoveryAttempt = {};
    recovery = recoverBinaryXml(text, Parser, binaryRecoveryAttempt);
    if (!recovery) throw Object.assign(new Fb2Error(format.classification || 'invalid_xml', 'FB2 document is malformed XML.'),
      diagnostics, { stage: 'parse', encoding, containerType: 'raw FB2', format, binaryRecoveryAttempt });
    document = recovery.document;
    recovery = { code: 'binary_corruption_recovered', stage: 'parse',
      message: 'Повреждено встроенное изображение; книга проиндексирована без него.',
      binaries: recovery.binaries, ...diagnostics, encoding, containerType: 'raw FB2', binaryRecoveryAttempt };
  }
  if (document.documentElement?.localName !== 'FictionBook') throw Object.assign(
    new Fb2Error(format.classification || 'invalid_xml', 'Expected an FB2 FictionBook document.'), { stage: 'parse', encoding, format });
  if (![...document.documentElement.children].some((element) => element.localName === 'description')) {
    throw new Fb2Error('description_missing', 'FB2 description is absent from the complete document.');
  }
  const titleInfo = [...document.getElementsByTagNameNS('*', 'title-info')][0];
  if (!titleInfo) throw new Fb2Error('parse_failed', 'FB2 title-info is missing.');
  const metadata = titleInfoMetadata(titleInfo);
  if (recovery) {
    metadata.binaryRecovery = { ...recovery, coverDamaged: recovery.binaries.some((binary) => binary.id === metadata.coverId) };
    metadata.metadataWarning = recovery.code;
  }
  if (!metadata.annotation) metadata.preview = atStage('preview', () => extractBodyPreview(document));
  if (!metadata.coverId) return metadata;
  if (metadata.binaryRecovery?.coverDamaged) return metadata;
  const binary = [...document.getElementsByTagNameNS('*', 'binary')]
    .find((element) => element.getAttribute('id') === metadata.coverId);
  if (!binary) return metadata;
  const mimeType = binary.getAttribute('content-type')?.toLowerCase() || '';
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) {
    return { ...metadata, metadataWarning: 'unsupported_cover_format' };
  }
  return { ...metadata, cover: { mimeType, bytes: atStage('cover', () => decodeBase64(binary.textContent)) } };
}

export function parseFb2Bytes(bytes, Parser = globalThis.DOMParser) {
  const text = decodeFb2(bytes);
  const endIndex = descriptionEnd(text);
  if (endIndex < 0) return parseFullFb2(bytes, Parser);
  return parseFb2Metadata(text.slice(0, endIndex), Parser);
}

export async function extractFb2Metadata(book, options = {}) {
  try {
    // Small/unknown-size books need one full read, also supplying preview and cover.
    if (!Number.isFinite(book.size) || book.size <= 1_048_576) {
      const blob = await (options.downloadFile || downloadDriveFile)(book.id, options.signal);
      if (blob.size > MAX_FB2_DOCUMENT_BYTES) throw new Fb2Error('fb2_memory_limit_exceeded', 'Full FB2 parse exceeds the 128 MiB memory budget.');
      return parseFullFb2(new Uint8Array(await blob.arrayBuffer()), options.Parser);
    }
    const result = await readFb2Prefix(book.id, { ...options, size: book.size });
    if (result.complete) return parseFullFb2(result.bytes, options.Parser);
    let metadata;
    try { metadata = parseFb2Metadata(result.prefix, options.Parser); }
    catch (error) { if (error.code !== 'invalid_xml') throw error; }
    if (metadata?.annotation && !metadata.coverId) return metadata;
    if (book.size > MAX_FB2_DOCUMENT_BYTES) throw new Fb2Error('fb2_memory_limit_exceeded', 'Full FB2 parse exceeds the 128 MiB memory budget.');
    const blob = await (options.downloadFile || downloadDriveFile)(book.id, options.signal);
    if (blob.size > MAX_FB2_DOCUMENT_BYTES) throw new Fb2Error('fb2_memory_limit_exceeded', 'Full FB2 parse exceeds the 128 MiB memory budget.');
    return parseFullFb2(new Uint8Array(await blob.arrayBuffer()), options.Parser);
  } catch (error) {
    if (error instanceof Fb2Error || error?.name === 'AbortError' || error?.status === 401) throw error;
    error.stage ||= 'download';
    throw error;
  }
}

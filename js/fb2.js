import { downloadDriveFile, downloadFileRange } from './drive.js';

export const FB2_RANGES = Object.freeze([
  [0, 65_535],
  [65_536, 262_143],
  [262_144, 1_048_575],
]);

export class Fb2Error extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'Fb2Error';
    this.code = code;
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
  const declared = declaration?.[1]?.toLowerCase().replaceAll('_', '-');
  if (!declared || ['utf-8', 'utf8'].includes(declared)) return 'utf-8';
  if (['windows-1251', 'cp1251', 'x-cp1251'].includes(declared)) return 'windows-1251';
  if (['utf-16', 'utf16'].includes(declared)) {
    if (bytes[0] === 0 && bytes[1] === 0x3c) return 'utf-16be';
    return 'utf-16le';
  }
  if (['utf-16le', 'utf16le'].includes(declared)) return 'utf-16le';
  if (['utf-16be', 'utf16be'].includes(declared)) return 'utf-16be';
  throw new Fb2Error('unsupported_encoding', `Unsupported FB2 encoding: ${declared}`);
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

export async function readFb2Description(fileId, { signal, fetchRange = downloadFileRange } = {}) {
  const chunks = [];
  let totalLength = 0;
  for (const [start, end] of FB2_RANGES) {
    const response = await fetchRange(fileId, start, end, signal);
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
    if (endIndex >= 0) return text.slice(0, endIndex);
    if (response.isComplete) break;
  }
  throw new Fb2Error('description_not_found', 'FB2 description was not found in the first 1 MiB.');
}

function directChild(element, localName) {
  if (!element) return null;
  return [...element.children].find((child) => child.localName === localName) || null;
}

function childText(element, localName) {
  return directChild(element, localName)?.textContent?.replace(/\s+/g, ' ').trim() || '';
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
    annotation: annotationText(directChild(titleInfo, 'annotation')),
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
  if (document.querySelector('parsererror')) throw new Fb2Error('invalid_xml', 'FB2 description is malformed XML.');

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
  if (!Parser) throw new Fb2Error('parse_failed', 'DOMParser is unavailable.');
  const document = new Parser().parseFromString(decodeFb2(bytes), 'application/xml');
  if (document.querySelector('parsererror')) throw new Fb2Error('invalid_xml', 'FB2 document is malformed XML.');
  const titleInfo = [...document.getElementsByTagNameNS('*', 'title-info')][0];
  if (!titleInfo) throw new Fb2Error('parse_failed', 'FB2 title-info is missing.');
  const metadata = titleInfoMetadata(titleInfo);
  if (!metadata.coverId) return metadata;
  const binary = [...document.getElementsByTagNameNS('*', 'binary')]
    .find((element) => element.getAttribute('id') === metadata.coverId);
  if (!binary) return metadata;
  const mimeType = binary.getAttribute('content-type')?.toLowerCase() || '';
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) {
    return { ...metadata, metadataWarning: 'unsupported_cover_format' };
  }
  return { ...metadata, cover: { mimeType, bytes: decodeBase64(binary.textContent) } };
}

export function parseFb2Bytes(bytes, Parser = globalThis.DOMParser) {
  const text = decodeFb2(bytes);
  const endIndex = descriptionEnd(text);
  if (endIndex < 0) throw new Fb2Error('description_not_found', 'FB2 description was not found in the available data.');
  return parseFb2Metadata(text.slice(0, endIndex), Parser);
}

export async function extractFb2Metadata(book, options = {}) {
  try {
    const metadata = parseFb2Metadata(await readFb2Description(book.id, options), options.Parser);
    if (!metadata.coverId) return metadata;
    const blob = await (options.downloadFile || downloadDriveFile)(book.id, options.signal);
    return parseFullFb2(new Uint8Array(await blob.arrayBuffer()), options.Parser);
  } catch (error) {
    if (error instanceof Fb2Error || error?.name === 'AbortError' || error?.status === 401) throw error;
    throw new Fb2Error('download_failed', error?.message || 'FB2 download failed.');
  }
}

import { openZip } from './zip.js';
import { EPUB_CONTAINER_BYTES, EPUB_PACKAGE_BYTES, BOOK_PREVIEW_BYTES, BOOK_COVER_BYTES, EPUB_PREVIEW_DOCUMENTS } from './config.js';
import { BookFormatError, emptyBookMetadata, cleanText, uniqueText, seriesNumber, plainDescription, htmlPreview, usableCover, optionalResource } from './book-content.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const children = (root, name) => [...root.children].filter((node) => node.localName === name);
const tokens = (node, attr) => (node.getAttribute(attr) || '').split(/\s+/);

function xml(bytes, rootName, Parser) {
  let text;
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new BookFormatError('invalid_epub', 'EPUB XML text could not be decoded.'); }
  const document = new Parser().parseFromString(text, 'application/xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== rootName) throw new BookFormatError('invalid_epub', `Invalid EPUB ${rootName} document.`);
  return document.documentElement;
}

export function epubPath(base, reference) {
  if (!reference || /^[a-z][a-z\d+.-]*:|^[\/\\]/i.test(reference)) return null;
  let path;
  try { path = decodeURIComponent(reference.split(/[?#]/)[0]); } catch { return null; }
  if (/^[\/\\]|\\|\0/.test(path)) return null;
  const parts = base ? base.split('/').slice(0, -1) : [];
  for (const part of path.split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

export async function extractEpubMetadata(book, { signal, Parser = globalThis.DOMParser, ...options } = {}) {
  const archive = await openZip(book, { ...options, signal });
  const byPath = new Map();
  for (const entry of archive.entries) {
    if (byPath.has(entry.name)) throw new BookFormatError('invalid_epub', 'Duplicate EPUB resource path.');
    byPath.set(entry.name, entry);
  }
  const container = byPath.get('META-INF/container.xml');
  if (!container) throw new BookFormatError('epub_container_missing');
  const root = xml(await archive.readEntry(container, EPUB_CONTAINER_BYTES), 'container', Parser);
  const rootfiles = [...root.getElementsByTagNameNS('*', 'rootfile')];
  const selected = rootfiles.find((node) => node.getAttribute('media-type') === 'application/oebps-package+xml') || rootfiles[0];
  const packagePath = epubPath('', selected?.getAttribute('full-path'));
  const packageEntry = byPath.get(packagePath);
  if (!packageEntry) throw new BookFormatError('epub_package_missing');
  const pkg = xml(await archive.readEntry(packageEntry, EPUB_PACKAGE_BYTES), 'package', Parser);
  const meta = children(pkg, 'metadata')[0];
  const manifest = children(pkg, 'manifest')[0];
  if (!meta || !manifest) throw new BookFormatError('invalid_epub', 'EPUB metadata/manifest missing.');
  const dc = (name) => [...meta.getElementsByTagNameNS(DC, name)];
  const refinements = children(meta, 'meta');
  const refine = (node, property) => node.id ? refinements.find((item) => item.getAttribute('refines') === `#${node.id}` && item.getAttribute('property') === property)?.textContent.trim() : null;
  const named = (name) => refinements.find((node) => node.getAttribute('name') === name)?.getAttribute('content');
  const metadata = { ...emptyBookMetadata(), title: cleanText(dc('title')[0]?.textContent) || null,
    authors: uniqueText(dc('creator').filter((node) => {
      const role = refine(node, 'role') || node.getAttributeNS('http://www.idpf.org/2007/opf', 'role');
      return !role || role === 'aut';
    }).map((node) => node.textContent)),
    language: cleanText(dc('language')[0]?.textContent) || null,
    genres: uniqueText(dc('subject').map((node) => node.textContent)) };
  const description = dc('description')[0];
  metadata.annotation = description ? plainDescription(description.children.length ? description.innerHTML : description.textContent) : null;
  const collections = refinements.filter((node) => node.getAttribute('property') === 'belongs-to-collection');
  const collection = collections.find((node) => refine(node, 'collection-type') === 'series')
    || collections.find((node) => !refine(node, 'collection-type'));
  metadata.series = cleanText(collection?.textContent || named('calibre:series')) || null;
  metadata.seriesNumber = metadata.series ? seriesNumber(collection ? refine(collection, 'group-position') : named('calibre:series_index')) : null;
  const items = children(manifest, 'item');
  const byId = new Map(items.map((node) => [node.getAttribute('id'), node]));
  if (byId.size !== items.length) throw new BookFormatError('invalid_epub', 'Duplicate EPUB manifest id.');
  const resource = (node) => byPath.get(epubPath(packagePath, node?.getAttribute('href')));
  const cover = items.find((node) => tokens(node, 'properties').includes('cover-image')) || byId.get(named('cover'));
  if (cover && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(cover.getAttribute('media-type'))) {
    metadata.cover = await optionalResource(async () => {
      const entry = resource(cover);
      return entry ? usableCover(await archive.readEntry(entry, BOOK_COVER_BYTES), signal) : null;
    });
  }
  if (!metadata.annotation) {
    const spine = children(pkg, 'spine')[0];
    let count = 0;
    for (const ref of spine ? children(spine, 'itemref') : []) {
      signal?.throwIfAborted();
      const item = byId.get(ref.getAttribute('idref'));
      if (!item || ref.getAttribute('linear') === 'no' || tokens(item, 'properties').includes('nav')) continue;
      if (!['application/xhtml+xml', 'text/html'].includes(item.getAttribute('media-type'))) continue;
      if (/(?:^|[\/_.-])(?:nav|toc|cover|titlepage|copyright)(?:[\/_.-]|$)/i.test(item.getAttribute('href'))) continue;
      if (++count > EPUB_PREVIEW_DOCUMENTS) break;
      metadata.preview = await optionalResource(async () => {
        const entry = resource(item);
        return entry ? htmlPreview(new TextDecoder().decode(await archive.readEntry(entry, BOOK_PREVIEW_BYTES))) : null;
      });
      if (metadata.preview) break;
    }
  }
  signal?.throwIfAborted();
  return metadata;
}

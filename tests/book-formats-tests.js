import { extractEpubMetadata, epubPath } from '../js/epub.js';
import { extractMobiMetadata } from '../js/mobi.js';
import { extractBookMetadata } from '../js/book-metadata.js';
import { classifyLibraryItem, preserveBookMetadata } from '../js/library-tree.js';
import { prepareIndexingRun } from '../js/indexing-run.js';
import { validateCompletedIndex } from '../js/index-build.js';
import { indexPendingBooks } from '../js/metadata-indexer.js';
import { BOOK_SOURCE_TYPES, INDEX_VERSION, METADATA_VERSION } from '../js/config.js';
import { createBookCard, bookCardView } from '../js/book-card.js';
import { searchBooks, librarySearchOptions } from '../js/book-search.js';
import { filterBooksByDirectValue } from '../js/direct-filter.js';

const bytes = (text) => new TextEncoder().encode(text);
// Generated 1x1 RGB PNG, including valid CRCs (not a copyrighted cover).
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'), (c) => c.charCodeAt(0));
const ranges = (data, calls = []) => async (id, start, end, signal) => {
  signal?.throwIfAborted(); calls.push([start, end]);
  return { bytes: data.subarray(start, end + 1), status: 206, isComplete: end === data.length - 1 };
};
const pending = (id, sourceType) => ({ id, parentId: 'root', fileName: `${id}.${sourceType}`, sourceType, extension: sourceType, metadataStatus: 'pending' });

export function makeMobi({ annotation = true, cover = true, compression = 1, encrypted = false, exth = true, extraFlags = 0 } = {}) {
  const text = bytes('<p>First normal paragraph of this book, suitable for a preview.</p><script>window.mobiExecuted=true</script>');
  const title = bytes('MOBI full title');
  const records = [[100, bytes('Author One')], [100, bytes('Author Two')], [503, bytes('MOBI title')],
    [105, bytes('Fantasy; History; Fantasy')], [524, bytes('ru-RU')]];
  if (annotation) records.push([103, bytes('<p>Readable &amp; safe annotation.</p><script>window.mobiExecuted=true</script>')]);
  if (cover) records.push([201, new Uint8Array(4)]);
  const exthLength = exth ? 12 + records.reduce((sum, [, value]) => sum + 8 + value.length, 0) : 0;
  const zero = new Uint8Array(248 + exthLength + title.length);
  const view = new DataView(zero.buffer);
  view.setUint16(0, compression); view.setUint32(4, text.length); view.setUint16(8, 1); view.setUint16(10, 4096); view.setUint16(12, encrypted ? 2 : 0);
  zero.set(bytes('MOBI'), 16); view.setUint32(20, 232); view.setUint32(24, 2); view.setUint32(28, 65001);
  view.setUint32(36, 6); view.setUint32(84, 248 + exthLength); view.setUint32(88, title.length); view.setUint32(92, 0x419);
  view.setUint32(108, cover ? 2 : 0xffffffff); view.setUint32(128, exth ? 0x40 : 0); view.setUint16(242, extraFlags);
  if (exth) {
    zero.set(bytes('EXTH'), 248); view.setUint32(252, exthLength); view.setUint32(256, records.length);
    let cursor = 260;
    for (const [type, value] of records) { view.setUint32(cursor, type); view.setUint32(cursor + 4, 8 + value.length); zero.set(value, cursor + 8); cursor += value.length + 8; }
  }
  zero.set(title, 248 + exthLength);
  const parts = cover ? [zero, text, PNG] : [zero, text];
  const headerLength = 78 + parts.length * 8 + 2;
  const file = new Uint8Array(headerLength + parts.reduce((sum, part) => sum + part.length, 0));
  file.set(bytes('BOOKMOBI'), 60);
  const header = new DataView(file.buffer); header.setUint16(76, parts.length);
  let offset = headerLength;
  parts.forEach((part, i) => { header.setUint32(78 + i * 8, offset); file.set(part, offset); offset += part.length; });
  return file;
}

export async function runBookFormatTests(test, assert, equal, makeZip) {
  const epub = async ({ annotation = true, cover = 'v3', series = 'v3', broken = false, remote = false, coverBytes = PNG } = {}) => makeZip([
    { name: 'mimetype', bytes: bytes('application/epub+zip') },
    { name: 'META-INF/container.xml', bytes: bytes('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/packages/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>') },
    { name: 'OPS/packages/book.opf', method: 8, bytes: bytes(broken ? '<package>' : `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title>EPUB title</dc:title><dc:creator>Author One</dc:creator><dc:creator>Author Two</dc:creator><dc:language>ru</dc:language>
      <dc:subject>Fantasy</dc:subject><dc:subject>Fantasy</dc:subject><dc:subject> History </dc:subject>
      ${annotation ? '<dc:description>&lt;p&gt;Readable &amp;amp; safe annotation.&lt;/p&gt;&lt;script&gt;window.epubExecuted=true&lt;/script&gt;</dc:description>' : ''}
      ${cover === 'v2' ? '<meta name="cover" content="image"/>' : ''}
      ${series === 'calibre' ? '<meta name="calibre:series" content="Saga"/><meta name="calibre:series_index" content="2.5"/>'
        : series === 'v3' ? '<meta property="belongs-to-collection" id="series">Saga</meta><meta refines="#series" property="collection-type">series</meta><meta refines="#series" property="group-position">2.5</meta>' : ''}
      </metadata><manifest><item id="nav" href="../nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>
      <item id="text" href="${remote ? 'https://example.invalid/tracker' : '../Text/chapter.xhtml'}" media-type="application/xhtml+xml"/>
      ${cover ? `<item id="image" href="../Images/cover.png" media-type="image/png" ${cover === 'v3' ? 'properties="cover-image"' : ''}/>` : ''}
      </manifest><spine><itemref idref="nav"/><itemref idref="text"/></spine></package>`) },
    { name: 'OPS/nav.xhtml', bytes: bytes('<html><body><p>Wrong navigation preview should never be used.</p></body></html>') },
    { name: 'OPS/Text/chapter.xhtml', method: 8, bytes: bytes('<html><head><style>bad</style></head><body><p>First normal paragraph of the EPUB book.</p><p>Second paragraph has useful text too.</p><script>window.epubExecuted=true</script><img src="https://example.invalid/tracker"/></body></html>') },
    { name: 'OPS/Images/cover.png', bytes: coverBytes },
    { name: 'unused.bin', bytes: new Uint8Array(90000).fill(37) },
  ]);
  await test('scanner classifies four formats, EPUB and MOBI before ZIP MIME', () => {
    for (const type of BOOK_SOURCE_TYPES) for (const extension of [type, type.toUpperCase()]) equal(classifyLibraryItem({ name: `book.${extension}` }), type, 'extension');
    for (const type of ['epub', 'mobi']) equal(classifyLibraryItem({ name: `book.${type}`, mimeType: 'application/zip' }), type, 'generic MIME cannot steal new format');
    equal(classifyLibraryItem({ name: 'no extension', mimeType: 'application/epub+zip' }), 'epub', 'EPUB MIME');
    equal(classifyLibraryItem({ name: 'no extension', mimeType: 'application/x-mobipocket-ebook' }), 'mobi', 'MOBI MIME');
    for (const extension of ['azw', 'azw3', 'pdf', 'txt', 'docx', 'djvu']) equal(classifyLibraryItem({ name: `book.${extension}` }), 'other', 'no other formats');
    equal(classifyLibraryItem({ name: 'book.azw3', mimeType: 'application/x-mobipocket-ebook' }), 'other', 'AZW3 not added through MIME');
  });
  await test('EPUB 2/3 covers and calibre/collection series share the common model', async () => {
    for (const [cover, series] of [['v3', 'v3'], ['v2', 'calibre'], [false, false]]) {
      const data = await epub({ cover, series }); const calls = [];
      const result = await extractEpubMetadata({ id: 'epub', size: data.length }, { fetchRange: ranges(data, calls) });
      equal([result.title, result.authors, result.genres, result.language, result.annotation],
        ['EPUB title', ['Author One', 'Author Two'], ['Fantasy', 'History'], 'ru', 'Readable & safe annotation.'], 'metadata from OPF');
      equal([result.series, result.seriesNumber], series ? ['Saga', 2.5] : [null, null], 'series metadata');
      equal(Boolean(result.cover), Boolean(cover), 'cover optional');
      if (cover) equal(result.cover.mimeType, 'image/png', 'shared cover contract');
      assert(calls.reduce((sum, [start, end]) => sum + end - start + 1, 0) < data.length, 'only metadata/resources downloaded');
      assert(new Set(calls.map(String)).size === calls.length, 'no identical range repeated');
      assert(!window.epubExecuted, 'embedded JS never executes');
    }
  });
  await test('EPUB preview follows spine, skips navigation, never fetches external paths', async () => {
    for (const remote of [false, true]) {
      const data = await epub({ annotation: false, cover: false, remote });
      const result = await extractEpubMetadata({ id: 'preview', size: data.length }, { fetchRange: ranges(data) });
      equal(result.annotation, null, 'no invented annotation');
      assert(remote ? result.preview === null : result.preview.includes('First normal paragraph') && !result.preview.includes('Wrong navigation'), 'spine preview or safe null');
    }
    equal(epubPath('OPS/package.opf', '../../escape.xhtml'), null, 'path cannot escape archive');
    equal(epubPath('OPS/package.opf', 'https://example.org/a'), null, 'external resource rejected');
  });
  await test('MOBI EXTH metadata and cover, including missing optional fields', async () => {
    for (const cover of [true, false]) {
      const data = makeMobi({ cover }); const calls = [];
      const result = await extractMobiMetadata({ id: 'mobi', size: data.length }, { fetchRange: ranges(data, calls) });
      equal([result.title, result.authors, result.genres, result.language, result.annotation],
        ['MOBI title', ['Author One', 'Author Two'], ['Fantasy', 'History'], 'ru-RU', 'Readable & safe annotation.'], 'EXTH metadata');
      equal(Boolean(result.cover), cover, 'MOBI image resource');
      equal([result.series, result.seriesNumber], [null, null], 'series never guessed');
      assert(!window.mobiExecuted, 'MOBI markup inert');
      assert(!calls.some(([start, end]) => start === 0 && end === data.length - 1), 'no full MOBI metadata download');
    }
    const data = makeMobi({ cover: false, exth: false });
    const fallback = await extractMobiMetadata({ id: 'fallback', size: data.length }, { fetchRange: ranges(data) });
    equal([fallback.title, fallback.authors, fallback.language], ['MOBI full title', [], 'ru'], 'full-name/header fallback');
  });
  await test('MOBI optional preview supports plain/PalmDOC and skips DRM/HUFF/trailing data', async () => {
    for (const options of [{ compression: 1 }, { compression: 2 }, { compression: 17480 }, { encrypted: true }, { extraFlags: 1 }]) {
      const data = makeMobi({ ...options, annotation: false, cover: false });
      const result = await extractMobiMetadata({ id: 'preview', size: data.length }, { fetchRange: ranges(data) });
      const supported = [1, 2].includes(options.compression);
      assert(supported ? result.preview?.includes('First normal paragraph') : result.preview === null, 'preview best effort without rejecting metadata');
      equal(result.title, 'MOBI title', 'metadata independent of text');
    }
  });
  await test('ZIP is a book container for FB2, EPUB and MOBI with deterministic selection', async () => {
    const epubData = await epub(); const mobiData = makeMobi();
    const fb2Data = bytes('<FictionBook><description><title-info><book-title>ZIP FB2</book-title></title-info></description></FictionBook>');
    const extractZip = async (fileName, entries) => {
      const data = await makeZip(entries);
      return extractBookMetadata({ id: fileName, fileName, sourceType: 'zip', size: data.length }, { fetchRange: ranges(data) });
    };
    const epubResult = await extractZip('archive.zip', [{ name: 'cover.jpg', bytes: PNG }, { name: 'notes.txt', bytes: bytes('ignore') }, { name: 'nested/book.EPUB', bytes: epubData }]);
    equal([epubResult.title, epubResult.entryPath, epubResult.innerFormat], ['EPUB title', 'nested/book.EPUB', 'epub'], 'ZIP to EPUB uses normal EPUB parser');
    const mobiResult = await extractZip('archive.zip', [{ name: '__MACOSX/ghost.mobi', bytes: mobiData }, { name: 'Thumbs.db', bytes: bytes('ignore') }, { name: 'book.MOBI', bytes: mobiData }]);
    equal([mobiResult.title, mobiResult.entryPath, mobiResult.innerFormat], ['MOBI title', 'book.MOBI', 'mobi'], 'ZIP to MOBI ignores service entries');
    const fb2Result = await extractZip('archive.zip', [{ name: 'book.fb2', bytes: fb2Data }]);
    equal([fb2Result.title, fb2Result.innerFormat], ['ZIP FB2', 'fb2'], 'ZIP to FB2 remains supported');
    const preferred = await extractZip('choice.fb2.zip', [{ name: 'first.epub', bytes: epubData }, { name: 'wanted.fb2', bytes: fb2Data }, { name: 'third.mobi', bytes: mobiData }]);
    equal([preferred.title, preferred.entryPath, preferred.metadataWarning], ['ZIP FB2', 'wanted.fb2', 'multiple_supported_book_entries'], 'outer format preference wins over central-directory order');
    const ordinary = await extractZip('ordinary.zip', [{ name: 'first.mobi', bytes: mobiData }, { name: 'second.epub', bytes: epubData }]);
    equal(ordinary.entryPath, 'first.mobi', 'ordinary ZIP uses stable central-directory order');
    const epubPreferred = await extractZip('choice.epub.zip', [{ name: 'first.mobi', bytes: mobiData }, { name: 'wanted.epub', bytes: epubData }]);
    equal(epubPreferred.entryPath, 'wanted.epub', 'EPUB suffix preference');
    const mobiPreferred = await extractZip('choice.mobi.zip', [{ name: 'first.epub', bytes: epubData }, { name: 'wanted.mobi', bytes: mobiData }]);
    equal(mobiPreferred.entryPath, 'wanted.mobi', 'MOBI suffix preference');
  });
  await test('ZIP errors retain selected inner parser format and reject no-book containers', async () => {
    const noBook = await makeZip([{ name: 'cover.jpg', bytes: PNG }, { name: 'readme.txt', bytes: bytes('ignore') }]);
    let error;
    try { await extractBookMetadata({ id: 'none', fileName: 'none.zip', sourceType: 'zip', size: noBook.length }, { fetchRange: ranges(noBook) }); } catch (caught) { error = caught; }
    equal([error?.code, error?.containerType], ['zip_no_supported_book', 'ZIP'], 'generic missing-book error');
    const brokenEpub = await makeZip([{ name: 'book.epub', bytes: await epub({ broken: true }) }]);
    try { await extractBookMetadata({ id: 'broken-epub', fileName: 'broken.zip', sourceType: 'zip', size: brokenEpub.length }, { fetchRange: ranges(brokenEpub) }); } catch (caught) { error = caught; }
    equal([error?.code, error?.containerType, error?.innerFormat], ['invalid_epub', 'ZIP', 'epub'], 'broken nested EPUB preserves EPUB error');
    const brokenMobi = await makeZip([{ name: 'book.mobi', bytes: new Uint8Array(100) }]);
    try { await extractBookMetadata({ id: 'broken-mobi', fileName: 'broken.zip', sourceType: 'zip', size: brokenMobi.length }, { fetchRange: ranges(brokenMobi) }); } catch (caught) { error = caught; }
    assert(['invalid_mobi', 'unsupported_mobi'].includes(error?.code) && error.containerType === 'ZIP' && error.innerFormat === 'mobi', 'broken nested MOBI preserves MOBI error');
  });
  await test('new formats support one full retry after 416, abort and controlled corruption errors', async () => {
    for (const type of ['epub', 'mobi']) {
      const data = type === 'epub' ? await epub() : makeMobi();
      let attempts = 0, downloads = 0;
      const result = await extractBookMetadata({ id: type, sourceType: type, size: data.length }, {
        fetchRange: async () => { attempts++; throw Object.assign(new Error('Range'), { status: 416 }); },
        downloadFile: async () => { downloads++; return new Blob([data]); },
      });
      equal([attempts, downloads, result.title], [1, 1, `${type.toUpperCase()} title`], 'one full fallback, local ranges thereafter');
      const controller = new AbortController(); controller.abort();
      let aborted; try { await extractBookMetadata({ id: type, sourceType: type, size: data.length }, { signal: controller.signal, fetchRange: ranges(data) }); } catch (error) { aborted = error; }
      equal(aborted?.name, 'AbortError', 'abort propagated');
    }
    const data = await epub({ broken: true });
    let error;
    try { await extractEpubMetadata({ id: 'broken', size: data.length }, { fetchRange: ranges(data) }); } catch (caught) { error = caught; }
    equal(error?.code, 'invalid_epub', 'malformed package');
    try { await extractMobiMetadata({ id: 'broken', size: 100 }, { fetchRange: ranges(new Uint8Array(100)) }); } catch (caught) { error = caught; }
    assert(['invalid_mobi', 'unsupported_mobi'].includes(error?.code), 'bad MOBI controlled');
  });
  await test('bad optional covers preserve metadata and real resource network errors remain failures', async () => {
    const damaged = new Uint8Array(PNG.length); damaged.set(PNG.subarray(0, 8));
    const epubData = await epub({ coverBytes: damaged });
    const mobiData = makeMobi(); mobiData.set(damaged, mobiData.length - PNG.length);
    for (const [sourceType, data] of [['epub', epubData], ['mobi', mobiData]]) {
      const result = await extractBookMetadata({ id: sourceType, sourceType, size: data.length }, { fetchRange: ranges(data) });
      equal(result.title, `${sourceType.toUpperCase()} title`, 'damaged cover does not erase metadata');
      assert(!result.cover, 'broken image never reaches cover cache');
    }
    const data = makeMobi();
    let caught;
    try {
      await extractMobiMetadata({ id: 'network', size: data.length }, { fetchRange: async (id, start, end) => {
        if (start === data.length - PNG.length) throw Object.assign(new Error('Network unavailable'), { code: 'network_error' });
        return ranges(data)(id, start, end);
      } });
    } catch (error) { caught = error; }
    equal(caught?.code, 'network_error', 'network errors are not swallowed as missing cover');
  });
  await test('new-format failures continue the batch, retry successfully, and abort resets pending', async () => {
    const epubData = await epub(); const mobiData = makeMobi();
    const active = { version: INDEX_VERSION, rootFolderId: 'root', folders: [], books: [pending('epub', 'epub'), pending('mobi', 'mobi')] };
    const extract = (book) => { const data = book.sourceType === 'epub' ? epubData : mobiData;
      return extractBookMetadata({ ...book, size: data.length }, { fetchRange: ranges(data) }); };
    const stats = await indexPendingBooks(active, { extract: (book) => book.sourceType === 'epub'
      ? extractBookMetadata({ ...book, size: 30 }, { fetchRange: ranges(new Uint8Array(30)) }) : extract(book) });
    equal([stats.failed, stats.succeeded], [1, 1], 'broken EPUB does not stop MOBI');
    const retry = await prepareIndexingRun(active, { mode: 'retry' });
    equal(retry.buildState.selectedIds, ['epub'], 'common retry selects failed new format');
    const retried = await indexPendingBooks(retry, { previousIndex: active, extract });
    equal([retried.succeeded, retried.failed], [1, 0], 'shared retry succeeds');
    assert(validateCompletedIndex(retry, active).books.every((book) => book.metadataStatus === 'ready'), 'new types pass shadow validation');
    const controller = new AbortController();
    const interrupted = { books: [pending('mobi', 'mobi')] };
    await indexPendingBooks(interrupted, { signal: controller.signal, extract: async (book) => {
      controller.abort(); return extract(book);
    } });
    equal(interrupted.books[0].metadataStatus, 'pending', 'abort never leaves processing state');
  });
  await test('refresh preserves 9257 old books and indexes only new EPUB/MOBI into cards/search/filters', async () => {
    const old = { version: INDEX_VERSION, rootFolderId: 'root', folders: [], books: Array.from({ length: 9257 }, (_, i) => ({
      ...pending(String(i), i % 2 ? 'zip' : 'fb2'), title: `Old ${i}`, authors: [], genres: [], size: 17, modifiedTime: 'same', metadataStatus: 'ready', metadataVersion: METADATA_VERSION })) };
    const scanned = { ...old, books: old.books.map((book) => ({ ...pending(book.id, book.sourceType), size: 17, modifiedTime: 'same' })).concat(pending('new', 'epub'), pending('another', 'mobi')) };
    const refreshed = preserveBookMetadata(scanned, old);
    assert(refreshed.books.slice(0, 9257).every((book, i) => Object.entries(old.books[i])
      .every(([key, value]) => JSON.stringify(book[key]) === JSON.stringify(value))), 'all old metadata fields preserved');
    const building = await prepareIndexingRun(refreshed, { mode: 'refresh', scan: async () => { throw new Error('Already scanned'); } });
    equal(building.buildState.total, 2, 'new/changed books only');
    const epubData = await epub(); const mobiData = makeMobi(); const extracted = [];
    const stats = await indexPendingBooks(building, { previousIndex: refreshed,
      extract: (book) => { extracted.push(book.sourceType); const data = book.sourceType === 'epub' ? epubData : mobiData;
        return extractBookMetadata({ ...book, size: data.length }, { fetchRange: ranges(data) }); },
      onCover: async (book, cover) => ({ coverFileId: cover ? `cache-${book.id}` : null, coverMimeType: cover?.mimeType || null }),
    });
    equal([stats.succeeded, stats.failed, extracted], [2, 0, ['epub', 'mobi']], 'same indexer, no old file reads');
    const completed = validateCompletedIndex(building, refreshed);
    const books = completed.books.slice(-2);
    assert(books.every((book) => book.metadataStatus === 'ready' && book.metadataVersion === METADATA_VERSION && book.coverFileId), 'ready with common cover fields');
    equal(searchBooks(books, { query: 'Author', genre: 'Fantasy', language: 'rus' }).length, 2, 'shared search and language normalization');
    equal(searchBooks(books, { series: 'Saga' }).length, 1, 'series search');
    equal(librarySearchOptions(books).genres.map((item) => item.value).sort(), ['Fantasy', 'History'], 'subjects remain literal genres');
    equal(filterBooksByDirectValue(books, { type: 'genre', value: 'Fantasy' }).length, 2, 'direct genre filter');
    for (const book of books) {
      let downloaded;
      const card = createBookCard(book, async (original) => { downloaded = original; });
      card.querySelector('.book-download-button').click();
      equal(downloaded, book, 'existing download receives original file identity');
      assert(card.textContent.includes(book.title) && card.textContent.includes('Fantasy'), 'ordinary card');
    }
    equal(bookCardView({ ...pending('name', 'epub'), metadataStatus: 'ready' }).title, 'name', 'filename fallback without persisting fake title');
    equal([INDEX_VERSION, METADATA_VERSION], [4, 2], 'no version bump');
  });
}

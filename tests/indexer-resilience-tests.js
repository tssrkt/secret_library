import { parseFullFb2, detectEncoding, extractFb2Metadata } from '../js/fb2.js';
import { extractZipFb2, validateZipBudgets, parseCentralDirectory } from '../js/zip.js';
import { extractBookMetadata } from '../js/book-metadata.js';
import { prepareIndexingRun } from '../js/indexing-run.js';
import { indexPendingBooks } from '../js/metadata-indexer.js';
import { failedBookIds } from '../js/indexing-state.js';
import { formatIndexingErrors, errorDetails } from '../js/indexing-errors.js';

const utf8 = (text) => new TextEncoder().encode(text);
const description = '<description><title-info><book-title>Кровь Кадии</book-title><author><first-name>Аарон</first-name><last-name>Дембски-Боуден</last-name></author><genre>sf_epic</genre><annotation><p>Сохранённая аннотация.</p></annotation><sequence name="Цикл" number="7"/><coverpage><image href="#cover.jpg"/></coverpage></title-info></description>';
const body = '<body><section><p>Текст книги остаётся целым.</p></section></body>';
const corrupt = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBD' + '\u0000\u0001\u0002\u0007\u000b\u000c\u001f' + '<A\u0002\ufffd\u00ff<JPEG_RAW_BYTES&\u0000<!\u0001<?\u0002<!--RAW';
const source = (payload = corrupt) => `<?xml version="1.0"?><FictionBook>${description}${body}<binary id="cover.jpg" content-type="image/jpeg">${payload}</binary></FictionBook>`;
const fetcher = (bytes, calls = [], full = false) => async (_id, start, end) => {
  calls.push([start, end]);
  return { bytes: full ? bytes : bytes.subarray(start, end + 1), status: full ? 200 : 206, isComplete: full || end >= bytes.length - 1 };
};

export async function runIndexerResilienceTests(test, assert, equal, makeZip) {
  const rejects = async (action, code) => {
    let caught;
    try { await action(); } catch (error) { caught = error; }
    equal(caught?.code, code, 'specific failure');
    return caught;
  };
  await test('realistic raw binary with tag-like garbage recovers only attachment and reports diagnostics', () => {
    const attempts = [];
    class Parser { parseFromString(text, type) { attempts.push(text); return new DOMParser().parseFromString(text, type); } }
    const pieces = source().split('\u00ff');
    const rawBytes = Uint8Array.from([...utf8(pieces[0]), 0xff, 0x80, 0xd8, ...utf8(pieces[1])]);
    const result = parseFullFb2(rawBytes, Parser);
    equal(attempts.length, 2, 'normal strict parse then one sanitized strict parse');
    equal(attempts[1], source(''), 'only binary payload removed');
    equal([result.title, result.authors, result.genres, result.seriesNumber, result.annotation],
      ['Кровь Кадии', ['Аарон Дембски-Боуден'], ['sf_epic'], 7, 'Сохранённая аннотация.'], 'all metadata survives');
    assert(result.binaryRecovery.coverDamaged && !result.cover, 'cover rejected');
    equal(result.binaryRecovery.binaryRecoveryAttempt.result, 'recovered', 'attempt recorded');
    assert(attempts[1].includes(body), 'body unchanged');
  });
  await test('failed recovery explains missing boundary and external corruption without exposing payload', async () => {
    for (const [text, reason] of [[source().replace('</binary>', ''), 'closing-boundary-not-found'],
      [source().replace('Текст', '\u0001Текст'), 'sanitized-xml-still-invalid'],
      [source().replace('</binary>', '<section>keep me</section></binary>'), 'ambiguous-binary-boundaries']]) {
      const result = parseFullFb2(utf8(text));
      equal(result.metadataWarning, 'metadata_only_recovered', 'valid description remains recoverable');
      const error = result.binaryRecovery;
      // The root closing tag is structural evidence when a binary closing tag is absent.
      assert(error.binaryRecoveryAttempt.reason === reason || (reason === 'closing-boundary-not-found' && error.binaryRecoveryAttempt.reason === 'ambiguous-binary-boundaries'), 'safe rejection reason');
      const log = formatIndexingErrors([{ ...errorDetails(error), outcome: 'failed' }]);
      assert(log.includes('Binary recovery attempted: yes') && log.includes('Encoding: utf-8'), 'diagnostic fields exported');
      assert(!log.includes('JPEG_RAW_BYTES') && !log.includes('Сохранённая аннотация'), 'source never logged');
    }
  });
  await test('actual windows-1252 bytes and aliases decode as normal success', () => {
    for (const encoding of ['windows-1252', 'cp1252', 'windows1252']) {
      const text = `<?xml version="1.0" encoding="${encoding}"?><FictionBook><description><title-info><book-title>“Café”</book-title><author><first-name>André</first-name></author></title-info></description><body><p>Un texte français.</p></body></FictionBook>`;
      const bytes = Uint8Array.from(text, (char) => char === '“' ? 0x93 : char === '”' ? 0x94 : char.charCodeAt(0));
      equal(detectEncoding(bytes), 'windows-1252', 'canonical encoding');
      const result = parseFullFb2(bytes);
      equal([result.title, result.authors, result.preview], ['“Café”', ['André'], 'Un texte français.'], 'real legacy bytes');
      assert(!result.binaryRecovery && !result.metadataWarning, 'encoding is not a warning');
    }
  });
  await test('UTF-16 BOMs decode normally and false FB2 containers get exact classifications', async () => {
    const text = source('').replace('version="1.0"', 'version="1.0" encoding="UTF-16"');
    for (const le of [true, false]) {
      const bytes = new Uint8Array(2 + text.length * 2);
      const data = new DataView(bytes.buffer);
      data.setUint16(0, 0xfeff, le);
      for (let i = 0; i < text.length; i++) data.setUint16(2 + i * 2, text.charCodeAt(i), le);
      equal(parseFullFb2(bytes).title, 'Кровь Кадии', 'BOM wins over generic declaration');
    }
    for (const [bytes, code] of [[utf8('<!DOCTYPE html><html><body>Not FB2</body></html>'), 'not_xml_html'],
      [utf8('{\\rtf1 hello}'), 'not_xml_rtf'], [new Uint8Array([0x50, 0x4b, 3, 4, 0]), 'unexpected_zip'],
      [new Uint8Array([0x1f, 0x8b, 0]), 'unexpected_gzip'], [new Uint8Array([0xff, 0xd8, 0xff, 0]), 'binary_file']]) {
      await rejects(() => parseFullFb2(bytes), code);
    }
  });
  await test('late description uses geometric ranges and a full 200 response is never downloaded again', async () => {
    const bytes = utf8(source('').replace('<description>', `<!--${'x'.repeat(1_200_000)}--><description>`));
    for (const full of [false, true]) {
      const calls = [];
      const result = await extractFb2Metadata({ id: 'late', size: bytes.length }, {
        fetchRange: fetcher(bytes, calls, full), downloadFile: async () => { throw new Error('Duplicate download'); },
      });
      equal(result.title, 'Кровь Кадии', 'description beyond 1 MiB found');
      equal(calls.length, full ? 1 : 4, 'bounded request count');
      if (!full) assert(calls.every(([start], i) => i === 0 || start === calls[i - 1][1] + 1), 'ranges do not overlap');
    }
    await rejects(() => parseFullFb2(utf8('<FictionBook><body><p>No metadata.</p></body></FictionBook>')), 'description_missing');
  });
  await test('ZIP budgets reject bombs and entry floods before extraction', async () => {
    const entry = { compressedSize: 100, uncompressedSize: 80 * 1024 * 1024 };
    await rejects(() => validateZipBudgets([entry], entry, 1000), 'zip_suspicious_compression_ratio');
    await rejects(() => parseCentralDirectory(new Uint8Array(), 4097, 100), 'zip_too_many_entries');
    await rejects(() => validateZipBudgets([{ uncompressedSize: 600 * 1024 * 1024 }], entry, 1000), 'zip_total_uncompressed_limit_exceeded');
    const large = { compressedSize: 1024 * 1024, uncompressedSize: 129 * 1024 * 1024 };
    await rejects(() => validateZipBudgets([large], large, 1024 * 1024), 'zip_uncompressed_limit_exceeded');
    const bomb = await makeZip([{ name: 'bomb.fb2', method: 8, bytes: utf8('x'.repeat(1024 * 1024)) }]);
    const Native = globalThis.DecompressionStream;
    let inflations = 0;
    globalThis.DecompressionStream = class { constructor(...args) { inflations++; return new Native(...args); } };
    try { await rejects(() => extractZipFb2({ id: 'bomb', size: bomb.length }, { fetchRange: fetcher(bomb) }), 'zip_suspicious_compression_ratio'); }
    finally { globalThis.DecompressionStream = Native; }
    equal(inflations, 0, 'suspicious archive rejected before allocating decompression output');
  });
  await test('lying ZIP output size remains malformed_zip', async () => {
    const bytes = await makeZip([{ name: 'short.fb2', method: 8, bytes: utf8(source('')) }]);
    const view = new DataView(bytes.buffer);
    const central = view.getUint32(bytes.length - 6, true);
    view.setUint32(central + 24, 10, true);
    view.setUint32(22, 10, true);
    await rejects(() => extractZipFb2({ id: 'liar', size: bytes.length }, { fetchRange: fetcher(bytes) }), 'malformed_zip');
  });
  await test('legitimate deflated FB2 over old 32 MiB limit indexes through bounded extraction', async () => {
    // Deterministic high-entropy XML comments: large but nowhere near bomb ratios.
    let state = 123456789;
    const block = new Uint8Array(256 * 1024);
    for (let i = 0; i < block.length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; block[i] = 65 + (state >>> 0) % 26; }
    const comment = new TextDecoder().decode(block);
    const plain = utf8(source('').replace('</FictionBook>', `${Array.from({ length: 132 }, () => `<!--${comment}-->`).join('')}</FictionBook>`));
    const compressed = new Uint8Array(await new Response(new Blob([plain]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    // Build using typed-array copies; avoid spreading tens of MiB into JS arrays.
    const template = await makeZip([{ name: 'large.fb2', bytes: new Uint8Array([65]) }]);
    const original = new DataView(template.buffer);
    const oldCentral = original.getUint32(template.length - 6, true);
    const dataOffset = oldCentral - 1;
    const centralOffset = dataOffset + compressed.length;
    const bytes = new Uint8Array(centralOffset + template.length - oldCentral);
    bytes.set(template.subarray(0, dataOffset)); bytes.set(compressed, dataOffset); bytes.set(template.subarray(oldCentral), centralOffset);
    const view = new DataView(bytes.buffer);
    view.setUint16(8, 8, true); view.setUint16(centralOffset + 10, 8, true);
    for (const offset of [18, centralOffset + 20]) view.setUint32(offset, compressed.length, true);
    for (const offset of [22, centralOffset + 24]) view.setUint32(offset, plain.length, true);
    view.setUint32(bytes.length - 6, centralOffset, true);
    assert(plain.length > 32 * 1024 * 1024 && compressed.length > 16 * 1024 * 1024, 'both former artificial limits exceeded');
    const result = await extractZipFb2({ id: 'large', size: bytes.length }, { fetchRange: fetcher(bytes) });
    equal(result.title, 'Кровь Кадии', 'large normal archive indexed');
  });
  await test('retry alone resolves new parser cases, keeps genuine failures and reports recovered separately', async () => {
    const active = { rootFolderId: 'root', folders: [], books: ['binary', 'legacy', 'missing', 'badzip'].map((id) => ({ id, fileName: `${id}.fb2`, sourceType: 'fb2', metadataStatus: 'error' })) };
    const retry = await prepareIndexingRun(active, { mode: 'retry', scan: async () => { throw new Error('No full scan'); } });
    let downloads = 0;
    const stats = await indexPendingBooks(retry, { extract: (book) => extractBookMetadata(book, {
      downloadFile: async () => { downloads++; return new Blob([book.id === 'binary' ? utf8(source()) : book.id === 'legacy'
        ? Uint8Array.from('<?xml version="1.0" encoding="cp1252"?><FictionBook><description><title-info><book-title>Café</book-title></title-info></description></FictionBook>', (char) => char.charCodeAt(0)) : utf8('<FictionBook>')]); },
    }) });
    equal([stats.succeeded, stats.recovered, stats.failed, downloads], [1, 1, 2, 4], 'one download per failed book, no rebuild');
    equal([...failedBookIds(retry)], ['missing', 'badzip'], 'resolved failures removed');
    equal(retry.books.find((book) => book.id === 'legacy').title, 'Café', 'retry decodes actual legacy bytes');
    assert(retry.indexingErrors.some((entry) => entry.outcome === 'recovered' && entry.binaryRecoveryAttempt.result === 'recovered'), 'warning contains attempt diagnostics');
    const emptyZip = await makeZip([{ name: 'text.txt', bytes: utf8('Not FB2') }]);
    await rejects(() => extractZipFb2({ id: 'empty', size: emptyZip.length }, { fetchRange: fetcher(emptyZip) }), 'zip_no_supported_book');
    await rejects(() => extractZipFb2({ id: 'bad', size: 24 }, { fetchRange: fetcher(new Uint8Array(24)) }), 'malformed_zip');
  });
}

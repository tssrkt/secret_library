import {
  decodeFb2, detectEncoding, extractFb2Metadata, FB2_RANGES, Fb2Error, parseFb2Metadata, parseFullFb2, readFb2Description,
} from '../js/fb2.js';
import { migrateIndex } from '../js/library-index.js';
import { classifyLibraryItem, preserveBookMetadata, staleCoverFileIds } from '../js/library-tree.js';
import { removeCovers, removeOrphanCovers, storeCover } from '../js/cover-cache.js';
import { buildLibraryLookups, folderHasLibraryChildren } from '../js/library-view-model.js';
import { indexPendingBooks } from '../js/metadata-indexer.js';
import { extractZipFb2, findEocd, parseCentralDirectory, ZipError } from '../js/zip.js';
import { setupDropdown } from '../js/dropdown.js';
import { accountIdentity, applyDriveAvatar, createAvatarController } from '../js/avatar.js';
import { downloadDriveFile, getCurrentDriveUser } from '../js/drive.js';
import { bookCardView, createBookCard } from '../js/book-card.js';
import { createAnnotationModalController, formatModalAuthors, modalCoverWidth } from '../js/annotation-modal.js';
import { genreLabels, loadGenreDictionary } from '../js/genre-labels.js';
import {
  AUTH_SESSION_KEY, PREVIOUS_SIGN_IN_KEY, clearAccessToken, clearPersistedAuth,
  createAuthAttemptGuard, getAccessToken, persistAuthSession, recoverAuthSession, restoreAuthSession,
} from '../js/auth.js';

const output = document.querySelector('#results');
let passed = 0;
const failures = [];

function assert(value, message) {
  if (!value) throw new Error(message);
}

function equal(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

await test('valid Google session restores token and account after reload', async () => {
  const session = memoryStorage({
    [AUTH_SESSION_KEY]: JSON.stringify({ accessToken: 'valid-token', expiresAt: 20_000, user: { displayName: 'Ada', emailAddress: 'ada@example.com', photoLink: 'photo' } }),
  });
  const restored = restoreAuthSession({ session, now: 10_000 });
  equal([getAccessToken(), restored.user.displayName, restored.user.emailAddress], ['valid-token', 'Ada', 'ada@example.com'], 'restored session');
  let requests = 0;
  const recovery = await recoverAuthSession({ restore: () => restored, previous: () => true, request: async () => { requests += 1; } });
  equal([recovery.mode, requests], ['session', 0], 'valid session skips GIS request');
});

await test('expired token is discarded and triggers silent GIS recovery', async () => {
  const session = memoryStorage({
    [AUTH_SESSION_KEY]: JSON.stringify({ accessToken: 'expired', expiresAt: 9_000, user: { displayName: 'Old' } }),
  });
  equal(restoreAuthSession({ session, now: 10_000 }), null, 'expired session rejected');
  equal(getAccessToken(), null, 'expired token not installed');
  let prompt = null;
  const recovered = await recoverAuthSession({
    restore: () => null, previous: () => true,
    request: async (options) => { prompt = options.prompt; },
  });
  equal([recovered.mode, prompt], ['silent', ''], 'silent request uses empty prompt');
});

await test('failed silent recovery returns unauthenticated state without throwing', async () => {
  const recovered = await recoverAuthSession({
    restore: () => null, previous: () => true, request: async () => { throw new Error('silent denied'); },
  });
  equal(recovered, null, 'normal sign-in screen fallback');
});

await test('session persists account data and manual logout clears all state', () => {
  const session = memoryStorage({
    [AUTH_SESSION_KEY]: JSON.stringify({ accessToken: 'token', expiresAt: Date.now() + 60_000, user: {} }),
  });
  const local = memoryStorage();
  restoreAuthSession({ session });
  persistAuthSession({ displayName: 'Ada King', emailAddress: 'ada@example.com', photoLink: 'photo' }, { session, local });
  const saved = JSON.parse(session.getItem(AUTH_SESSION_KEY));
  equal([saved.user.displayName, saved.user.emailAddress], ['Ada King', 'ada@example.com'], 'account persisted');
  clearPersistedAuth({ forget: true, session, local });
  clearAccessToken();
  equal([session.getItem(AUTH_SESSION_KEY), local.getItem(PREVIOUS_SIGN_IN_KEY), getAccessToken()], [null, null, null], 'manual logout clears session, marker and token');
});

await test('late Google response cannot restore authorization after logout', () => {
  const guard = createAuthAttemptGuard();
  const request = guard.begin();
  guard.invalidate();
  assert(!guard.isCurrent(request), 'late response is invalidated');
});

async function test(name, callback) {
  try {
    await callback();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error.stack || error.message}`);
  }
}

const xml = (titleInfo, encoding = 'UTF-8') => `<?xml version="1.0" encoding="${encoding}"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:xlink="http://www.w3.org/1999/xlink">
<description><title-info>${titleInfo}</title-info></description>`;

function encodeWindows1251(text) {
  return Uint8Array.from([...text].map((character) => {
    const code = character.charCodeAt(0);
    if (code < 128) return code;
    if (code >= 0x410 && code <= 0x42f) return code - 0x410 + 0xc0;
    if (code >= 0x430 && code <= 0x44f) return code - 0x430 + 0xe0;
    if (code === 0x401) return 0xa8;
    if (code === 0x451) return 0xb8;
    throw new Error(`Test encoder has no mapping for ${character}`);
  }));
}

function encodeUtf16Le(text) {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes.set([0xff, 0xfe]);
  for (let index = 0; index < text.length; index += 1) {
    bytes[2 + index * 2] = text.charCodeAt(index) & 0xff;
    bytes[3 + index * 2] = text.charCodeAt(index) >> 8;
  }
  return bytes;
}

function le16(value) { return [value & 255, (value >>> 8) & 255]; }
function le32(value) { return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]; }

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function makeZip(entries, comment = '') {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const plain = entry.bytes || new Uint8Array();
    const method = entry.method ?? 0;
    const compressed = method === 8 ? await deflateRaw(plain) : plain;
    const flags = entry.flags ?? 0x0800;
    const local = Uint8Array.from([
      ...le32(0x04034b50), ...le16(20), ...le16(flags), ...le16(method), ...le16(0), ...le16(0),
      ...le32(0), ...le32(compressed.length), ...le32(plain.length), ...le16(name.length), ...le16(0),
      ...name, ...compressed,
    ]);
    const central = Uint8Array.from([
      ...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(flags), ...le16(method), ...le16(0), ...le16(0),
      ...le32(0), ...le32(compressed.length), ...le32(plain.length), ...le16(name.length), ...le16(0), ...le16(0),
      ...le16(0), ...le16(0), ...le32(0), ...le32(localOffset), ...name,
    ]);
    locals.push(local);
    centrals.push(central);
    localOffset += local.length;
  }
  const centralSize = centrals.reduce((sum, bytes) => sum + bytes.length, 0);
  const commentBytes = encoder.encode(comment);
  const eocd = Uint8Array.from([
    ...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(entries.length), ...le16(entries.length),
    ...le32(centralSize), ...le32(localOffset), ...le16(commentBytes.length), ...commentBytes,
  ]);
  const result = new Uint8Array(localOffset + centralSize + eocd.length);
  let offset = 0;
  for (const part of [...locals, ...centrals, eocd]) { result.set(part, offset); offset += part.length; }
  return result;
}

function zipFetcher(bytes, calls = []) {
  return async (_id, start, end, signal) => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    calls.push([start, end]);
    return { bytes: bytes.slice(start, end + 1), status: 206, isComplete: end + 1 >= bytes.length };
  };
}

await test('UTF-8, one author, numbered series and paragraphs', () => {
  const metadata = parseFb2Metadata(xml(`
    <genre>prose</genre><author><first-name>Лев</first-name><middle-name>Николаевич</middle-name><last-name>Толстой</last-name></author>
    <book-title>Война и мир</book-title><annotation><p>Первый <strong>абзац</strong>.</p><empty-line/><p>Второй абзац.</p></annotation>
    <sequence name="Классика" number="3"/>`));
  equal({ title: metadata.title, authors: metadata.authors, genres: metadata.genres, series: metadata.series,
    seriesNumber: metadata.seriesNumber, annotation: metadata.annotation }, {
    title: 'Война и мир', authors: ['Лев Николаевич Толстой'], genres: ['prose'], series: 'Классика',
    seriesNumber: 3, annotation: 'Первый абзац.\n\nВторой абзац.',
  }, 'parsed metadata');
});

await test('multiple authors, nickname, series without number, no annotation', () => {
  const metadata = parseFb2Metadata(xml(`
    <author><first-name>Аркадий</first-name><last-name>Стругацкий</last-name></author>
    <author><nickname>Борис Стругацкий</nickname></author><book-title>Тест</book-title><sequence name="Мир"/>`));
  equal(metadata.authors, ['Аркадий Стругацкий', 'Борис Стругацкий'], 'authors');
  equal([metadata.series, metadata.seriesNumber, metadata.annotation], ['Мир', null, null], 'optional fields');
});

await test('full namespaced FB2 parses genres, language and embedded cover', () => {
  const source = `${xml(`
    <genre>history</genre><genre>history</genre><genre>prose</genre>
    <author><first-name>Ada</first-name><last-name>King</last-name></author>
    <book-title>Complete</book-title><lang>ru</lang>
    <coverpage><image xlink:href="#cover-image"/></coverpage>`)}</FictionBook>`
    .replace('</FictionBook>', '<binary id="cover-image" content-type="image/png">AQID</binary></FictionBook>');
  const metadata = parseFullFb2(new TextEncoder().encode(source));
  equal([metadata.title, metadata.language, metadata.genres], ['Complete', 'ru', ['history', 'prose']], 'full metadata');
  equal([metadata.cover.mimeType, [...metadata.cover.bytes]], ['image/png', [1, 2, 3]], 'embedded cover');
});

await test('standalone FB2 downloads the full source only when cover binary is referenced', async () => {
  const covered = `${xml('<book-title>Covered</book-title><coverpage><image xlink:href="#c"/></coverpage>')}</FictionBook>`
    .replace('</FictionBook>', '<binary id="c" content-type="image/png">AQID</binary></FictionBook>');
  let downloads = 0;
  const metadata = await extractFb2Metadata({ id: 'covered' }, {
    fetchRange: rangeFetcher(new TextEncoder().encode(covered)).fetchRange,
    downloadFile: async () => { downloads += 1; return new Blob([covered]); },
  });
  equal([metadata.title, downloads], ['Covered', 1], 'cover requires one full source read');
  await extractFb2Metadata({ id: 'plain' }, {
    fetchRange: rangeFetcher(new TextEncoder().encode(xml('<book-title>Plain</book-title>'))).fetchRange,
    downloadFile: async () => { downloads += 1; return new Blob(); },
  });
  equal(downloads, 1, 'coverless FB2 stays on partial ranges');
});

await test('Windows-1251 declaration and decoding', () => {
  const source = xml('<book-title>Название</book-title>', 'windows-1251');
  const bytes = encodeWindows1251(source);
  equal(detectEncoding(bytes), 'windows-1251', 'encoding');
  equal(parseFb2Metadata(decodeFb2(bytes)).title, 'Название', 'decoded title');
});

await test('UTF-16 BOM and decoding', () => {
  const bytes = encodeUtf16Le(xml('<book-title>Название</book-title>', 'UTF-16'));
  equal(detectEncoding(bytes), 'utf-16le', 'encoding');
  equal(parseFb2Metadata(decodeFb2(bytes)).title, 'Название', 'decoded title');
});

await test('unsupported encoding', () => {
  try {
    detectEncoding(new TextEncoder().encode('<?xml version="1.0" encoding="KOI8-R"?><FictionBook>'));
    assert(false, 'error expected');
  } catch (error) { equal(error.code, 'unsupported_encoding', 'error code'); }
});

await test('malformed XML', () => {
  try {
    parseFb2Metadata(xml('<book-title>Broken</wrong-tag>'));
    assert(false, 'error expected');
  } catch (error) { equal(error.code, 'invalid_xml', 'error code'); }
});

function rangeFetcher(bytes, { force200 = false } = {}) {
  const calls = [];
  return {
    calls,
    fetchRange: async (_id, start, end) => {
      calls.push([start, end]);
      return { bytes: force200 ? bytes : bytes.slice(start, end + 1), isComplete: force200 || end + 1 >= bytes.length, status: force200 ? 200 : 206 };
    },
  };
}

await test('description in first 64 KiB uses one 206 request', async () => {
  const bytes = new TextEncoder().encode(xml('<book-title>Short</book-title>'));
  const mock = rangeFetcher(bytes);
  await readFb2Description('one', mock);
  equal(mock.calls, [FB2_RANGES[0]], 'ranges');
});

await test('description in second range does not redownload bytes', async () => {
  const source = xml(`<annotation><!--${'x'.repeat(70_000)}--></annotation><book-title>Long</book-title>`);
  const mock = rangeFetcher(new TextEncoder().encode(source));
  await readFb2Description('two', mock);
  equal(mock.calls, [FB2_RANGES[0], FB2_RANGES[1]], 'sequential ranges');
});

await test('200 full response prevents further range requests', async () => {
  const bytes = new TextEncoder().encode(xml(`<annotation><!--${'x'.repeat(70_000)}--></annotation><book-title>Full</book-title>`));
  const mock = rangeFetcher(bytes, { force200: true });
  await readFb2Description('full', mock);
  equal(mock.calls.length, 1, 'request count');
});

await test('missing description stops at 1 MiB', async () => {
  const bytes = new TextEncoder().encode(`<?xml version="1.0"?><FictionBook>${'x'.repeat(1_100_000)}`);
  const mock = rangeFetcher(bytes);
  try {
    await readFb2Description('missing', mock);
    assert(false, 'error expected');
  } catch (error) { equal(error.code, 'description_not_found', 'error code'); }
  equal(mock.calls, FB2_RANGES, 'bounded ranges');
});

await test('batch continues after a book error and checkpoints', async () => {
  const index = { books: ['a', 'b', 'c'].map((id) => ({ id, fileName: `${id}.fb2`, metadataStatus: 'pending' })) };
  let checkpoints = 0;
  const stats = await indexPendingBooks(index, {
    concurrency: 2,
    checkpointSize: 2,
    extract: async (book) => {
      if (book.id === 'b') throw new Fb2Error('invalid_xml');
      return { title: book.id, authors: [], series: null, seriesNumber: null, annotation: null };
    },
    onCheckpoint: async () => { checkpoints += 1; },
  });
  equal([stats.processed, stats.succeeded, stats.failed], [3, 2, 1], 'batch stats');
  equal(index.books.map((book) => book.metadataStatus), ['ready', 'error', 'ready'], 'book statuses');
  equal(checkpoints, 1, 'checkpoint count');
});

await test('Stage 1 migration and processing reset', () => {
  const result = migrateIndex({ version: 1, books: [{ id: 'a' }, { id: 'b', metadataStatus: 'processing' }] });
  equal(result.index.version, 4, 'version');
  equal(result.index.books.map((book) => book.metadataStatus), ['pending', 'pending'], 'statuses');
  assert(result.migrated, 'migration flag');
});

await test('folders are expandable from indexed children, independently of files', () => {
  const index = {
    folders: [
      { id: 'root', parentId: null }, { id: 'parent', parentId: 'root' },
      { id: 'child', parentId: 'parent' }, { id: 'empty', parentId: 'root' },
      { id: 'zip-folder', parentId: 'root' },
      { id: 'bad-zip-folder', parentId: 'root' },
    ],
    books: [
      { id: 'zip', parentId: 'zip-folder', fileName: 'book.zip', sourceType: 'zip', metadataStatus: 'pending' },
      { id: 'bad', parentId: 'bad-zip-folder', fileName: 'bad.zip', sourceType: 'zip', metadataStatus: 'error', metadataError: 'zip_no_fb2' },
    ],
  };
  const lookups = buildLibraryLookups(index);
  assert(folderHasLibraryChildren(lookups, 'parent'), 'folder containing only a subfolder');
  assert(folderHasLibraryChildren(lookups, 'zip-folder'), 'folder containing a ZIP book');
  assert(folderHasLibraryChildren(lookups, 'bad-zip-folder'), 'every indexed ZIP candidate remains visible');
  assert(!folderHasLibraryChildren(lookups, 'empty'), 'truly empty folder');
});

await test('Drive scan classification includes ZIP case-insensitively and ignores unrelated files', () => {
  equal(classifyLibraryItem({ name: 'BOOK.ZiP', mimeType: 'application/octet-stream' }), 'zip', 'ZIP extension');
  equal(classifyLibraryItem({ name: 'book', mimeType: 'application/zip' }), 'zip', 'ZIP MIME');
  equal(classifyLibraryItem({ name: 'book.FB2', mimeType: 'application/octet-stream' }), 'fb2', 'FB2 extension');
  equal(classifyLibraryItem({ name: 'document.pdf', mimeType: 'application/pdf' }), 'other', 'irrelevant file');
  equal(classifyLibraryItem({ name: 'nested', mimeType: 'application/vnd.google-apps.folder' }), 'folder', 'folder unaffected');
});

const zipFb2 = new TextEncoder().encode(`${xml(`
  <author><first-name>Zip</first-name><last-name>Author</last-name></author>
  <book-title>Archive Book</book-title><annotation><p>From ZIP.</p></annotation>`)}</FictionBook>`);

await test('ZIP EOCD with comment and central directory', async () => {
  const bytes = await makeZip([{ name: 'book.fb2', bytes: zipFb2 }], 'variable comment');
  const eocd = findEocd(bytes, 0, bytes.length);
  equal(eocd.entryCount, 1, 'entry count');
  const entries = parseCentralDirectory(bytes.slice(eocd.centralOffset, eocd.centralOffset + eocd.centralSize), 1, bytes.length);
  equal(entries[0].name, 'book.fb2', 'entry name');
});

await test('Stored FB2 in nested path with irrelevant entries', async () => {
  const bytes = await makeZip([
    { name: 'cover.jpg', bytes: new Uint8Array([1, 2, 3]) },
    { name: '__MACOSX/noise.fb2', bytes: zipFb2 },
    { name: 'folder/book.fb2', bytes: zipFb2 },
  ], 'comment');
  const result = await extractZipFb2({ id: 'zip', size: bytes.length }, { fetchRange: zipFetcher(bytes) });
  equal([result.title, result.entryPath], ['Archive Book', 'folder/book.fb2'], 'stored metadata');
});

await test('Deflate FB2 extraction', async () => {
  const bytes = await makeZip([{ name: 'book.FB2', bytes: zipFb2, method: 8 }]);
  const result = await extractZipFb2({ id: 'zip', size: bytes.length }, { fetchRange: zipFetcher(bytes) });
  equal(result.title, 'Archive Book', 'deflated title');
});

await test('multiple FB2 entries use first and preserve warning', async () => {
  const bytes = await makeZip([{ name: 'one.fb2', bytes: zipFb2 }, { name: 'two.fb2', bytes: zipFb2 }]);
  const result = await extractZipFb2({ id: 'zip', size: bytes.length }, { fetchRange: zipFetcher(bytes) });
  equal([result.entryPath, result.metadataWarning], ['one.fb2', 'multiple_fb2_entries'], 'multiple entries');
});

await test('ZIP without FB2 is isolated error', async () => {
  const bytes = await makeZip([{ name: 'cover.jpg', bytes: new Uint8Array([1]) }, { name: 'Thumbs.db', bytes: new Uint8Array([2]) }]);
  try {
    await extractZipFb2({ id: 'zip', size: bytes.length }, { fetchRange: zipFetcher(bytes) });
    assert(false, 'error expected');
  } catch (error) { equal(error.code, 'zip_no_fb2', 'error code'); }
});

await test('malformed ZIP and invalid offset are rejected', async () => {
  try { findEocd(new Uint8Array(100), 0, 100); assert(false, 'EOCD error expected'); }
  catch (error) { equal(error.code, 'malformed_zip', 'missing EOCD'); }

  const bytes = await makeZip([{ name: 'book.fb2', bytes: zipFb2 }]);
  const centralSignature = [0x50, 0x4b, 0x01, 0x02];
  const centralOffset = bytes.findIndex((value, index) => centralSignature.every((byte, part) => bytes[index + part] === byte));
  bytes.set(le32(bytes.length + 100), centralOffset + 42);
  try {
    await extractZipFb2({ id: 'zip', size: bytes.length }, { fetchRange: zipFetcher(bytes) });
    assert(false, 'offset error expected');
  } catch (error) { equal(error.code, 'malformed_zip', 'invalid offset'); }
});

await test('unsupported compression method is isolated', async () => {
  const bytes = await makeZip([{ name: 'book.fb2', bytes: zipFb2, method: 12 }]);
  try {
    await extractZipFb2({ id: 'zip', size: bytes.length }, { fetchRange: zipFetcher(bytes) });
    assert(false, 'compression error expected');
  } catch (error) { equal(error.code, 'unsupported_compression', 'error code'); }
});

await test('encrypted ZIP is reported without stopping other work', async () => {
  const bytes = await makeZip([{ name: 'book.fb2', bytes: zipFb2, flags: 0x0801 }]);
  try { await extractZipFb2({ id: 'zip', size: bytes.length }, { fetchRange: zipFetcher(bytes) }); assert(false, 'encryption error expected'); }
  catch (error) { equal(error.code, 'encrypted_zip', 'encrypted error code'); }
});

await test('ZIP64 markers are detected as unsupported', async () => {
  const bytes = await makeZip([{ name: 'book.fb2', bytes: zipFb2 }]);
  const eocdOffset = bytes.length - 22;
  bytes.set(le32(0xffffffff), eocdOffset + 12);
  try { findEocd(bytes, 0, bytes.length); assert(false, 'ZIP64 error expected'); }
  catch (error) { equal(error.code, 'unsupported_zip64', 'error code'); }
});

await test('large ZIP uses bounded ranges rather than full download', async () => {
  const bytes = await makeZip([
    { name: 'padding.bin', bytes: new Uint8Array(70_000) },
    { name: 'book.fb2', bytes: zipFb2 },
  ]);
  const calls = [];
  await extractZipFb2({ id: 'zip', size: bytes.length }, { fetchRange: zipFetcher(bytes, calls) });
  assert(!calls.some(([start, end]) => start === 0 && end === bytes.length - 1), 'full ZIP must not be requested');
  assert(calls[0][1] - calls[0][0] + 1 <= 65_557, 'tail is bounded');
});

await test('ZIP Range operation supports abort', async () => {
  const bytes = await makeZip([{ name: 'book.fb2', bytes: zipFb2 }]);
  const controller = new AbortController();
  controller.abort();
  try {
    await extractZipFb2({ id: 'zip', size: bytes.length }, { signal: controller.signal, fetchRange: zipFetcher(bytes) });
    assert(false, 'abort expected');
  } catch (error) { equal(error.name, 'AbortError', 'abort error'); }
});

await test('ZIP source metadata survives rescan and changed ZIP resets', () => {
  const previous = { createdAt: 'old', books: [{
    id: 'zip', fileName: 'book.zip', sourceType: 'zip', modifiedTime: 'one', size: 100, metadataVersion: 1, metadataStatus: 'ready',
    entryPath: 'folder/book.fb2', title: 'Kept', authors: ['A'], coverFileId: 'cover-old',
  }] };
  const unchanged = { books: [{ id: 'zip', fileName: 'book.zip', sourceType: 'zip', modifiedTime: 'one', size: 100, metadataStatus: 'pending', entryPath: null }] };
  preserveBookMetadata(unchanged, previous);
  equal([unchanged.books[0].metadataStatus, unchanged.books[0].entryPath], ['ready', 'folder/book.fb2'], 'ZIP metadata preserved');
  const changed = { books: [{ id: 'zip', fileName: 'book.zip', sourceType: 'zip', modifiedTime: 'two', size: 100, metadataStatus: 'pending', entryPath: null }] };
  preserveBookMetadata(changed, previous);
  equal([changed.books[0].metadataStatus, changed.books[0].entryPath], ['pending', null], 'changed ZIP reset');
  const removed = { books: [] };
  preserveBookMetadata(removed, previous);
  equal(removed.books.length, 0, 'deleted ZIP remains absent');
  equal(staleCoverFileIds(changed, previous), ['cover-old'], 'changed source invalidates cover');
  equal(staleCoverFileIds(removed, previous), ['cover-old'], 'deleted source invalidates cover');
});

await test('cover cache stores resized blob separately and removes stale files', async () => {
  let storedName = '';
  const result = await storeCover({ id: 'drive-id' }, { bytes: new Uint8Array([1]), mimeType: 'image/png' }, {
    resize: async () => new Blob(['small'], { type: 'image/webp' }),
    create: async (name) => { storedName = name; return { id: 'cover-file' }; },
  });
  equal(result, { coverFileId: 'cover-file', coverMimeType: 'image/webp' }, 'cover index reference');
  assert(storedName.includes('drive-id') && storedName.endsWith('.webp'), 'separate cover filename');
  const removed = [];
  await removeCovers(['a', 'a', 'b'], async (id) => { removed.push(id); });
  equal(removed, ['a', 'b'], 'stale covers removed once');
  const orphaned = [];
  await removeOrphanCovers({ books: [{ coverFileId: 'keep' }] }, async () => [
    { id: 'keep', name: 'secret-library-cover-keep.webp' }, { id: 'old', name: 'secret-library-cover-old.webp' },
  ], async (id) => { orphaned.push(id); });
  equal(orphaned, ['old'], 'unreferenced cover is removed');
});

await test('one broken ZIP does not stop a mixed metadata batch', async () => {
  const index = { books: [
    { id: 'zip-bad', fileName: 'bad.zip', sourceType: 'zip', metadataStatus: 'pending' },
    { id: 'fb2-good', fileName: 'good.fb2', sourceType: 'fb2', metadataStatus: 'pending' },
  ] };
  const stats = await indexPendingBooks(index, {
    extract: async (book) => {
      if (book.sourceType === 'zip') throw new ZipError('malformed_zip');
      return { title: 'Good', authors: [], series: null, seriesNumber: null, annotation: null };
    },
  });
  equal([stats.succeeded, stats.failed], [1, 1], 'mixed batch stats');
  equal(index.books.map((book) => book.metadataStatus), ['error', 'ready'], 'mixed batch statuses');
});

await test('avatar dropdown supports toggle, outside click and Escape', () => {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = '<button id="test-toggle" aria-expanded="false"></button><div id="test-menu" hidden><button role="menuitem">Action</button><button role="menuitem" hidden>Hidden</button></div>';
  document.body.append(wrapper);
  const toggle = wrapper.querySelector('#test-toggle');
  const menu = wrapper.querySelector('#test-menu');
  setupDropdown(toggle, menu);
  toggle.click();
  assert(!menu.hidden && toggle.getAttribute('aria-expanded') === 'true', 'menu opens');
  toggle.click();
  assert(menu.hidden, 'second click closes');
  toggle.click();
  document.body.click();
  assert(menu.hidden, 'outside click closes');
  toggle.click();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert(menu.hidden && toggle.getAttribute('aria-expanded') === 'false', 'Escape closes');
  wrapper.remove();
});

await test('account identity uses Google name/email with fallbacks', () => {
  equal(accountIdentity({ displayName: ' Ada King ', emailAddress: ' ada@example.com ' }), {
    displayName: 'Ada King', emailAddress: 'ada@example.com',
  }, 'Google identity');
  equal(accountIdentity({}), { displayName: 'Пользователь Google', emailAddress: '' }, 'missing identity fallback');
  equal(accountIdentity({ displayName: '   ', emailAddress: '   ' }), {
    displayName: 'Пользователь Google', emailAddress: '',
  }, 'blank identity fallback');
});

function avatarFixture() {
  const button = document.createElement('button');
  button.className = 'avatar-button';
  const placeholder = document.createElement('span');
  placeholder.textContent = '☺';
  const image = document.createElement('img');
  image.hidden = true;
  button.append(placeholder, image);
  document.body.append(button);
  return { button, placeholder, image, controller: createAvatarController(button, image, placeholder) };
}

await test('Drive about user returns name, email and photo in one request', async () => {
  let requestedPath = '';
  const user = await getCurrentDriveUser(async (path) => {
    requestedPath = path;
    return { json: async () => ({ user: { displayName: 'Test User', emailAddress: 'test@example.com', photoLink: 'photo' } }) };
  });
  equal(user, { displayName: 'Test User', emailAddress: 'test@example.com', photoLink: 'photo' }, 'Drive user');
  assert(requestedPath.startsWith('/about?') && decodeURIComponent(requestedPath).includes('fields=user(displayName,emailAddress,photoLink)'), 'single minimal about request');
});

await test('avatar shows photo, uses cover, and keeps dropdown button', async () => {
  const fixture = avatarFixture();
  const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>');
  assert(await fixture.controller.set({ displayName: 'Test User', photoLink: svg }), 'image loaded');
  assert(!fixture.image.hidden && fixture.placeholder.hidden, 'photo visible');
  assert(fixture.button.getAttribute('aria-label') === 'Профиль: Test User', 'profile label');
  assert(getComputedStyle(fixture.image).objectFit === 'cover', 'object-fit cover');
  fixture.button.remove();
});

await test('missing photo and image load error keep placeholder', async () => {
  const fixture = avatarFixture();
  assert(!(await fixture.controller.set({ displayName: 'No Photo' })), 'missing photo fallback');
  assert(!fixture.placeholder.hidden && fixture.image.hidden, 'placeholder without photo');
  assert(!(await fixture.controller.set({ displayName: 'Broken', photoLink: 'data:image/png;base64,broken' })), 'broken image fallback');
  assert(!fixture.placeholder.hidden && fixture.image.hidden, 'placeholder after image error');
  fixture.button.remove();
});

await test('about error is noncritical and logout resets avatar', async () => {
  const fixture = avatarFixture();
  const applied = await applyDriveAvatar(
    async () => { throw new Error('about failed'); },
    fixture.controller.set,
  );
  assert(!applied && !fixture.placeholder.hidden, 'about error fallback');
  const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  await fixture.controller.set({ photoLink: svg });
  fixture.controller.reset();
  assert(!fixture.placeholder.hidden && fixture.image.hidden && !fixture.image.hasAttribute('src'), 'logout reset');
  fixture.button.remove();
});

await test('book card uses ready metadata and placeholder fields', () => {
  const ready = bookCardView({
    metadataStatus: 'ready', fileName: 'fallback.fb2', title: 'Book title',
    authors: ['First Author', 'Second Author'], annotation: 'Book annotation',
  });
  equal(ready, {
    author: 'First Author, Second Author', title: 'Book title', genreLine: 'Жанр не указан', annotation: 'Book annotation',
  }, 'ready card');
  const pending = bookCardView({ metadataStatus: 'pending', fileName: 'pending.zip' });
  equal(pending, {
    author: 'Автор не указан', title: 'pending', genreLine: 'Жанр не указан', annotation: 'Аннотация отсутствует',
  }, 'pending card');
});

await test('book card is not a tree branch and download receives original source', async () => {
  for (const sourceType of ['fb2', 'zip']) {
    let selected = null;
    const book = { id: `${sourceType}-id`, sourceType, fileName: `book.${sourceType}`, metadataStatus: 'pending' };
    const card = createBookCard(book, async (value) => { selected = value; });
    document.body.append(card);
    assert(!card.hasAttribute('aria-expanded') && !card.querySelector('[aria-expanded]'), 'card has no tree expansion state');
    assert(card.querySelector('.book-cover-placeholder') && !card.querySelector('.book-cover-placeholder img'), 'neutral cover placeholder');
    card.querySelector('.book-download-button').click();
    await new Promise((resolve) => setTimeout(resolve));
    assert(selected === book, `${sourceType} original selected`);
    card.remove();
  }
});

await test('book card replaces placeholder with cached cover lazily', async () => {
  const card = createBookCard(
    { id: 'covered', coverFileId: 'cover-cache-id', metadataStatus: 'ready', fileName: 'covered.fb2', title: 'Covered' },
    async () => {}, document,
    { loadCover: async () => 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==' },
  );
  document.body.append(card);
  await new Promise((resolve) => setTimeout(resolve));
  assert(card.querySelector('.book-cover-image') && !card.querySelector('.book-cover-placeholder'), 'cached cover displayed');
  card.remove();
});

await test('Drive download requests the original file ID', async () => {
  let path = '';
  const expected = new Blob(['source']);
  const blob = await downloadDriveFile('drive zip/id', undefined, async (requestPath) => {
    path = requestPath;
    return { blob: async () => expected };
  });
  assert(blob === expected, 'original response blob');
  assert(path.startsWith('/files/drive%20zip%2Fid?') && path.includes('alt=media'), 'Drive media path');
});

await test('one full-width card per row, with download directly below equal-width cover', () => {
  const card = createBookCard({ metadataStatus: 'ready', fileName: 'book.fb2', annotation: 'Text' }, async () => {});
  const second = createBookCard({ metadataStatus: 'ready', fileName: 'second.fb2', annotation: 'Long '.repeat(500) }, async () => {});
  const grid = document.createElement('div');
  grid.className = 'book-grid';
  grid.style.width = '600px';
  grid.append(card, second);
  document.body.append(grid);
  assert(getComputedStyle(grid).flexDirection === 'column', 'one-column layout');
  assert(card.getBoundingClientRect().width === grid.getBoundingClientRect().width, 'card fills row');
  assert(second.getBoundingClientRect().top > card.getBoundingClientRect().bottom, 'second card starts on next row');
  assert(card.getBoundingClientRect().height === second.getBoundingClientRect().height, 'long annotation does not increase fixed card height');
  const cover = card.querySelector('.book-cover-placeholder').getBoundingClientRect();
  const coverFrame = card.querySelector('.book-cover-frame').getBoundingClientRect();
  const download = card.querySelector('.book-download-button').getBoundingClientRect();
  assert(cover.width === download.width, 'cover and download widths match');
  assert(download.top === cover.bottom, 'download touches cover');
  const secondDownload = second.querySelector('.book-download-button');
  assert(download.height === secondDownload.getBoundingClientRect().height, 'download buttons have equal height');
  assert(download.height === 34, 'download button has compact fixed height');
  assert(coverFrame.height === 180 && coverFrame.width === 135, 'cover is twenty percent larger while preserving 3:4 proportions');
  assert(getComputedStyle(card.querySelector('.book-download-button')).whiteSpace === 'nowrap', 'download label does not wrap');
  assert(card.querySelector('.book-download-button').textContent === 'СКАЧАТЬ', 'download label is uppercase');
  assert(getComputedStyle(card.querySelector('.book-cover-frame')).aspectRatio === '3 / 4', 'cover container uses 3:4 ratio');
  assert(cover.width === coverFrame.width && cover.height === coverFrame.height, 'placeholder fills cover container');
  const image = document.createElement('img');
  image.className = 'book-cover-image';
  card.querySelector('.book-cover-placeholder').replaceWith(image);
  const imageRect = image.getBoundingClientRect();
  assert(imageRect.width === coverFrame.width && imageRect.height === coverFrame.height, 'square or portrait image fills fixed container');
  assert(getComputedStyle(image).objectFit === 'contain', 'different image ratios remain uncropped and undistorted');
  equal([
    getComputedStyle(card.querySelector('.book-card-title')).fontSize,
    getComputedStyle(card.querySelector('.book-card-author')).fontSize,
    getComputedStyle(card.querySelector('.book-card-genre')).fontSize,
    getComputedStyle(card.querySelector('.book-card-annotation')).fontSize,
    getComputedStyle(card.querySelector('.book-annotation-more')).fontSize,
  ], ['18px', '16px', '15px', '16px', '14px'], 'card typography sizes');
  const annotationTypography = getComputedStyle(card.querySelector('.book-card-annotation'));
  equal(
    [annotationTypography.fontSize, annotationTypography.lineHeight],
    ['16px', '24.8px'],
    'annotation has readable computed typography',
  );
  grid.style.width = '320px';
  assert(card.getBoundingClientRect().width === 320, 'larger card remains within a narrow container');
  assert(card.querySelector('.book-annotation-more').getBoundingClientRect().right <= card.getBoundingClientRect().right, 'read-more remains inside the card at narrow width');
  grid.remove();
});

await test('Read more stays bottom-right while only overflowing annotation is truncated', async () => {
  let openedBook = null;
  let updateShort = null;
  let updateLong = null;
  const shortCard = createBookCard(
    { metadataStatus: 'ready', fileName: 'short.fb2', annotation: 'Short' }, async () => {}, document,
    { scheduleFrame: (callback) => { updateShort = callback; } },
  );
  const longCard = createBookCard(
    { metadataStatus: 'ready', fileName: 'long.fb2', title: 'Noah', authors: ['Julia'], annotation: 'Long '.repeat(100) }, async () => {}, document,
    { scheduleFrame: (callback) => { updateLong = callback; }, onAnnotation: (book) => { openedBook = book; } },
  );
  document.body.append(shortCard, longCard);
  updateShort();
  updateLong();
  assert(!shortCard.querySelector('.book-annotation-more').hidden, 'fitting annotation keeps the link at the bottom');
  assert(!shortCard.querySelector('.book-card-annotation').classList.contains('truncated'), 'fitting annotation is not truncated');
  assert(!longCard.querySelector('.book-annotation-more').hidden, 'overflowing annotation has link');
  assert(longCard.querySelector('.book-annotation-more').textContent === 'ЧИТАТЬ ДАЛЕЕ', 'link uses uppercase label');
  const annotation = longCard.querySelector('.book-card-annotation');
  const more = longCard.querySelector('.book-annotation-more');
  const annotationRect = annotation.getBoundingClientRect();
  const moreRect = more.getBoundingClientRect();
  const bodyRect = longCard.querySelector('.book-card-body').getBoundingClientRect();
  const annotationStyles = getComputedStyle(annotation);
  const moreStyles = getComputedStyle(more);
  const lineHeight = Number.parseFloat(annotationStyles.lineHeight);
  assert(Math.abs((annotationRect.height / lineHeight) - Math.round(annotationRect.height / lineHeight)) < 0.02, 'annotation ends on a whole text line');
  assert(Math.abs(moreRect.right - (bodyRect.right - Number.parseFloat(getComputedStyle(longCard.querySelector('.book-card-body')).paddingRight))) < 1, 'read-more aligns with text column right edge');
  assert(moreRect.top >= annotationRect.bottom, 'reserved row prevents overlap with annotation');
  assert(Math.abs(moreRect.bottom - (bodyRect.bottom - Number.parseFloat(getComputedStyle(longCard.querySelector('.book-card-body')).paddingBottom))) < 1, 'read-more link stays at text column bottom');
  assert(moreStyles.position === 'absolute' && moreStyles.textAlign === 'right', 'read-more is anchored at bottom-right');
  assert(moreRect.height === 24, 'read-more has a separate fixed-height row');
  assert(annotation.classList.contains('truncated') && annotationStyles.webkitLineClamp !== 'none', 'overflow uses line clamp with ellipsis');
  assert(annotationStyles.maskImage === 'none' && annotationStyles.backgroundImage === 'none', 'annotation has no masks, gradients or overlay lines');
  assert(Number.parseInt(annotation.style.getPropertyValue('--annotation-lines'), 10) >= 2, 'taller card displays additional annotation lines');
  longCard.querySelector('.book-annotation-more').click();
  equal(openedBook, { annotation: 'Long '.repeat(100).trim(), title: 'Noah', author: 'Julia', authors: ['Julia'], genres: [], coverFileId: null }, 'link opens complete book annotation data');
  shortCard.remove();
  longCard.remove();
});

await test('annotation overflow is recalculated after card width changes', async () => {
  let overflowing = false;
  let resizeCallback = null;
  let scheduledUpdate = null;
  const card = createBookCard(
    { metadataStatus: 'ready', fileName: 'resize.fb2', annotation: 'Responsive annotation' }, async () => {}, document,
    {
      isAnnotationOverflowing: () => overflowing,
      observeResize: (_element, callback) => { resizeCallback = callback; },
      scheduleFrame: (callback) => { scheduledUpdate = callback; },
    },
  );
  document.body.append(card);
  scheduledUpdate();
  assert(!card.querySelector('.book-annotation-more').hidden, 'link remains anchored when annotation initially fits');
  assert(!card.querySelector('.book-card-annotation').classList.contains('truncated'), 'fitting annotation is initially unclamped');
  overflowing = true;
  resizeCallback();
  scheduledUpdate();
  assert(!card.querySelector('.book-annotation-more').hidden, 'link appears after narrower layout overflows');
  assert(card.classList.contains('book-card') && card.getBoundingClientRect().height > 0, 'annotation does not resize card');
  card.remove();
});

await test('genre renders as exactly one current line', () => {
  const known = createBookCard({ metadataStatus: 'ready', fileName: 'book.fb2', genres: ['Историческая проза'] }, async () => {});
  const missing = createBookCard({ metadataStatus: 'ready', fileName: 'book.fb2' }, async () => {});
  equal(known.querySelectorAll('.book-card-genre').length, 1, 'known genre node count');
  equal(known.querySelector('.book-card-genre').textContent, 'Жанр: Историческая проза', 'known genre');
  equal(missing.querySelector('.book-card-genre').textContent, 'Жанр не указан', 'genre fallback');
});

await test('book card translates known genre codes without mutating source order', () => {
  const book = {
    metadataStatus: 'ready', fileName: 'book.fb2',
    genres: ['nonf_biography', 'popular_business', 'religion_self', 'unknown_code'],
  };
  const originalGenres = [...book.genres];
  const view = bookCardView(book, {
    nonf_biography: 'Биографии и мемуары',
    popular_business: 'О бизнесе популярно',
    religion_self: 'Самосовершенствование',
  });
  equal(view.genreLine, 'Жанр: Биографии и мемуары, О бизнесе популярно, Самосовершенствование, unknown_code', 'translated genre line');
  equal(book.genres, originalGenres, 'source genre codes and order are unchanged');
  equal(bookCardView(book, {}).genreLine, 'Жанр: nonf_biography, popular_business, religion_self, unknown_code', 'dictionary failure falls back to source codes');
});

await test('genre dictionary translates only for display and preserves unknown codes', async () => {
  const source = ['biography', 'unknown_code'];
  const labels = await genreLabels(source, async () => ({ biography: 'Биографии и мемуары' }));
  equal(labels, 'Биографии и мемуары, unknown_code', 'display labels');
  equal(source, ['biography', 'unknown_code'], 'source genre codes remain unchanged');
});

await test('current 393-entry genre dictionary covers real canonical and extended codes', async () => {
  const dictionary = await loadGenreDictionary();
  assert(Object.keys(dictionary).length === 393, 'current dictionary entry count');
  const source = [
    'prose_contemporary',
    'sci_psychology',
    'sci_popular',
    'popular_business',
    'biznes-literatura',
    'young adult',
    'буддизм',
    'urban-fantasy',
    'sci-fi',
    'unknown_custom_code',
  ];
  const original = [...source];
  const expected = [
    'Современная проза',
    'Психология',
    'Научпоп',
    'О бизнесе популярно',
    'Бизнес-литература',
    'Молодёжная литература',
    'Буддизм',
    'Городское фэнтези',
    'Научная фантастика',
    'unknown_custom_code',
  ].join(', ');
  equal(await genreLabels(source), expected, 'real codes translate independently in source order with fallback');
  equal(source, original, 'display translation does not mutate indexed genre codes');
  equal(
    bookCardView({ metadataStatus: 'ready', fileName: 'book.fb2', genres: source }, dictionary).genreLine,
    `Жанр: ${expected}`,
    'book card uses the current dictionary and fallback',
  );
});

await test('full annotation modal renders genres and closes normally', async () => {
  const overlay = document.createElement('div');
  overlay.hidden = true;
  const dialog = document.createElement('section');
  const closeButton = document.createElement('button');
  const title = document.createElement('h2');
  const genres = document.createElement('p');
  genres.className = 'annotation-modal-genres';
  const text = document.createElement('p');
  dialog.append(closeButton, title, genres, text);
  overlay.append(dialog);
  document.body.append(overlay);
  const modal = createAnnotationModalController(overlay, text, closeButton, title, genres, null, null, {
    genreLabels: async () => 'Биографии и мемуары, Историческая проза',
  });
  const book = {
    title: 'Ноев ковчег',
    author: 'Юлия Васильевна Артюхович, Анна Автор, Третий Автор',
    authors: ['Юлия Васильевна Артюхович', 'Анна Автор', 'Третий Автор'],
    genres: ['biography', 'prose_history'], annotation: 'Full annotation',
  };
  modal.open(book);
  await Promise.resolve();
  assert(!overlay.hidden && text.textContent === 'Full annotation', 'modal opens');
  assert(title.textContent === '«Ноев ковчег» Юлия Васильевна Артюхович, Анна Автор и другие', 'modal heading limits three or more authors');
  assert(genres.textContent === 'Биографии и мемуары, Историческая проза', 'translated genres have no prefix');
  assert(getComputedStyle(genres).color !== getComputedStyle(title).color, 'genre line is visually muted');
  closeButton.click();
  assert(overlay.hidden, 'close button');
  modal.open(book);
  overlay.click();
  assert(overlay.hidden, 'backdrop click');
  modal.open(book);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert(overlay.hidden, 'Escape');
  overlay.remove();
});

await test('annotation modal limits only the displayed author list', () => {
  equal(formatModalAuthors({ authors: ['First'] }), 'First', 'one author is displayed in full');
  equal(formatModalAuthors({ authors: ['First', 'Second'] }), 'First, Second', 'two authors are displayed in full');
  const authors = ['First', 'Second', 'Third', 'Fourth'];
  equal(formatModalAuthors({ authors }), 'First, Second и другие', 'three or more authors are shortened without ellipsis');
  equal(authors, ['First', 'Second', 'Third', 'Fourth'], 'formatting does not mutate complete author metadata');
  equal(formatModalAuthors({ author: 'Legacy Author' }), 'Legacy Author', 'legacy display author remains supported');
});

await test('annotation modal keeps close action fixed and uses readable computed typography', () => {
  const fixture = document.createElement('div');
  fixture.innerHTML = `
    <section class="annotation-modal" style="width:500px; height:420px">
      <div class="annotation-modal-cover"><div class="annotation-modal-cover-placeholder">No cover</div></div>
      <div class="annotation-modal-content">
        <div class="modal-header">
          <h2><span class="annotation-modal-book-title">«A very long book title that wraps onto several lines in this deliberately narrow dialog»</span> <span class="annotation-modal-authors">First Author, Second Author и другие</span></h2>
          <button id="annotation-modal-close" class="secondary compact">×</button>
        </div>
        <p class="annotation-modal-genres">Biography, History</p>
        <p id="annotation-modal-text">Full annotation text.</p>
      </div>
    </section>`;
  document.body.append(fixture);
  const modal = fixture.querySelector('.annotation-modal');
  const close = fixture.querySelector('#annotation-modal-close');
  const title = fixture.querySelector('.annotation-modal-book-title');
  const authors = fixture.querySelector('.annotation-modal-authors');
  const genres = fixture.querySelector('.annotation-modal-genres');
  const annotation = fixture.querySelector('#annotation-modal-text');
  const modalRect = modal.getBoundingClientRect();
  const closeRect = close.getBoundingClientRect();
  assert(getComputedStyle(modal).position === 'relative' && getComputedStyle(close).position === 'absolute', 'close button is positioned against modal');
  assert(Math.abs(closeRect.top - modalRect.top - 12) < 1 && Math.abs(modalRect.right - closeRect.right - 14) < 1, 'close button remains at modal top-right');
  assert(Number.parseFloat(getComputedStyle(fixture.querySelector('.modal-header h2')).paddingRight) >= 40, 'heading reserves room for close button');
  equal([
    getComputedStyle(title).fontSize,
    getComputedStyle(authors).fontSize,
    getComputedStyle(genres).fontSize,
    getComputedStyle(annotation).fontSize,
    getComputedStyle(annotation).lineHeight,
  ], ['18px', '16px', '15px', '17px', '27.2px'], 'modal computed typography');
  fixture.remove();
});

await test('annotation modal cover uses full height and intrinsic proportions', () => {
  equal(modalCoverWidth(600, 300, 900, 1200), 200, 'narrow cover width follows aspect ratio');
  equal(modalCoverWidth(600, 450, 600, 1200), 450, 'regular cover width follows aspect ratio');
  equal(modalCoverWidth(600, 700, 600, 1200), 700, 'wide cover is not capped on desktop');
  equal(modalCoverWidth(600, 1000, 600, 600), 228, 'wide cover is constrained only on mobile');
  const fixture = document.createElement('div');
  fixture.innerHTML = '<section class="annotation-modal" style="height:400px;width:800px"><div class="annotation-modal-cover"><img></div><div class="annotation-modal-content">Text</div></section>';
  document.body.append(fixture);
  const cover = fixture.querySelector('.annotation-modal-cover');
  const image = fixture.querySelector('img');
  const coverStyles = getComputedStyle(cover);
  const imageStyles = getComputedStyle(image);
  assert(coverStyles.width !== '150px' && coverStyles.maxWidth === 'none', 'desktop cover column has no fixed width cap');
  assert(image.getBoundingClientRect().height === cover.getBoundingClientRect().height, 'cover image fills the column height');
  assert(imageStyles.maxWidth === 'none' && imageStyles.objectFit === 'fill', 'cover is not contained in a fixed box');
  fixture.remove();
});

await test('lazy folder tree renders books as cards only after folder expansion', async () => {
  const fixture = document.createElement('div');
  fixture.innerHTML = `
    <button id="sign-in-button"></button><button id="refresh-button"></button><button id="metadata-button"></button>
    <button id="retry-metadata-button"></button><button id="stop-button"></button>
    <div id="user-controls"><button id="avatar-button"><span id="avatar-placeholder"></span><img id="avatar-image"></button><div id="avatar-menu"><div class="account-identity"><strong id="account-display-name">Пользователь Google</strong><span id="account-email" hidden></span></div><button id="sign-out-button" role="menuitem">Выйти</button></div></div>
    <p id="status-text"></p><dl id="stats"><div><dd id="folder-count"></dd></div><div><dd id="book-count"></dd></div></dl>
    <div id="error-panel"><p id="error-text"></p></div><button id="retry-button"></button>
    <section id="library-panel"><div id="library-tree"></div></section>
    <div id="annotation-modal" hidden><section class="annotation-modal"><div id="annotation-modal-cover"><div id="annotation-modal-cover-placeholder"></div><img id="annotation-modal-cover-image"></div><div><button id="annotation-modal-close"></button><h2 id="annotation-modal-title"></h2><p id="annotation-modal-genres"></p><p id="annotation-modal-text"></p></div></section></div>`;
  document.body.append(fixture);
  const uiModule = await import(`../js/ui.js?tree-test=${Date.now()}`);
  uiModule.renderLibrary({
    rootFolderId: 'root',
    folders: [{ id: 'root', parentId: null, name: 'Root' }, { id: 'folder', parentId: 'root', name: 'Folder' }],
    books: [{ id: 'book', parentId: 'folder', fileName: 'book.fb2', sourceType: 'fb2', metadataStatus: 'pending' }],
  });
  assert(!fixture.querySelector('.book-card'), 'collapsed folder has no book DOM');
  fixture.querySelector('.folder-toggle').click();
  assert(fixture.querySelector('.book-card'), 'expanded folder contains card');
  assert(fixture.querySelectorAll('[aria-expanded]').length === 2, 'only avatar and folder are expandable');
  await uiModule.setUserAvatar({ displayName: 'Ada King', emailAddress: 'ada@example.com' });
  assert(fixture.querySelector('#account-display-name').textContent === 'Ada King', 'account name updated');
  assert(fixture.querySelector('#account-email').textContent === 'ada@example.com' && !fixture.querySelector('#account-email').hidden, 'account email updated');
  assert(getComputedStyle(fixture.querySelector('#account-display-name')).textOverflow === 'ellipsis', 'long name is ellipsized');
  assert(getComputedStyle(fixture.querySelector('#account-email')).textOverflow === 'ellipsis', 'long email is ellipsized');
  let signOutCalls = 0;
  const noop = () => {};
  uiModule.bindActions({ signIn: noop, refresh: noop, indexMetadata: noop, retryMetadata: noop, stopMetadata: noop, signOut: () => { signOutCalls += 1; }, rebuild: noop });
  fixture.querySelector('#avatar-button').click();
  fixture.querySelector('#sign-out-button').click();
  assert(signOutCalls === 1 && fixture.querySelector('#avatar-menu').hidden, 'menu logout action and close');
  uiModule.setAuthorized(false);
  assert(fixture.querySelector('#account-display-name').textContent === 'Пользователь Google', 'logout resets account name');
  assert(fixture.querySelector('#account-email').hidden && fixture.querySelector('#account-email').textContent === '', 'logout clears account email');
  fixture.remove();
});

await test('production controls keep stop in status panel and menu actions out of header flow', async () => {
  const html = await (await fetch('../index.html')).text();
  const page = new DOMParser().parseFromString(html, 'text/html');
  assert(page.querySelector('#status-panel > #stop-button'), 'stop button belongs to status panel');
  assert(page.querySelector('#avatar-menu > #metadata-button'), 'metadata action belongs to avatar menu');
  assert(page.querySelector('#avatar-menu > #retry-metadata-button'), 'retry action belongs to avatar menu');
  assert(page.querySelector('#avatar-menu .account-identity #account-display-name'), 'account identity belongs to menu');
  assert(page.querySelector('#avatar-menu > #sign-out-button'), 'logout belongs to menu bottom');
  const settingsItem = [...page.querySelectorAll('#avatar-menu > button')]
    .find((item) => item.textContent.includes('Настройки'));
  assert(settingsItem?.previousElementSibling?.tagName !== 'HR', 'no separator directly above settings');
  assert(page.querySelector('.annotation-modal > .annotation-modal-cover'), 'modal has a left cover column');
  assert(page.querySelector('.annotation-modal-content > #annotation-modal-genres'), 'genres are in the right text column');
  assert(!page.querySelector('#annotation-modal-label'), 'annotation heading is removed');
  assert(!page.querySelector('.app-header #user-greeting'), 'greeting is absent from header');
  assert(!page.querySelector('#avatar-menu').textContent.includes('Мой профиль'), 'profile menu label removed');
  assert(!page.querySelector('.app-header #stop-button'), 'stop is absent from header');
  assert(page.querySelector('h1').textContent === 'Тайная Библиотека', 'header title');
  const fixture = document.createElement('div');
  fixture.innerHTML = '<div class="user-controls" style="width:43px"><button class="avatar-button"></button><div class="avatar-menu"><button>Item</button></div></div><section id="library-panel"><article class="book-card"><button class="book-download-button">СКАЧАТЬ</button><button class="book-annotation-more">Читать далее</button></article></section><button class="theme-button">Action</button><button hidden>Hidden</button>';
  document.body.append(fixture);
  const menuStyles = getComputedStyle(fixture.querySelector('.avatar-menu'));
  assert(menuStyles.position === 'absolute', 'dropdown is outside layout flow');
  assert(menuStyles.right === '0px' && parseFloat(menuStyles.left) < 0, 'dropdown keeps its right edge and expands left');
  assert(menuStyles.width !== 'auto' && parseFloat(menuStyles.minWidth) >= 360, 'desktop dropdown accommodates long actions');
  const menuButtonWhiteSpace = getComputedStyle(fixture.querySelector('.avatar-menu button')).whiteSpace;
  assert(
    matchMedia('(max-width: 650px)').matches ? menuButtonWhiteSpace === 'normal' : menuButtonWhiteSpace === 'nowrap',
    'menu action wrapping follows the responsive breakpoint',
  );
  const rootStyles = getComputedStyle(document.documentElement);
  assert(getComputedStyle(document.body).backgroundColor === 'rgb(245, 241, 232)', 'original page background is restored from history');
  assert(getComputedStyle(fixture.querySelector('#library-panel')).backgroundColor === 'rgb(255, 253, 249)', 'original panel background is restored from history');
  assert(getComputedStyle(fixture.querySelector('.book-card')).backgroundColor === 'rgb(255, 250, 243)', 'original card background is restored from history');
  assert(getComputedStyle(fixture.querySelector('.avatar-menu')).backgroundColor === 'rgb(255, 253, 249)', 'original menu background is restored from history');
  assert(getComputedStyle(fixture.querySelector('.theme-button')).backgroundColor === 'rgb(104, 70, 41)', 'ordinary buttons use original brown accent');
  assert(rootStyles.getPropertyValue('--download-accent').trim() === '#273142', 'current download accent is preserved');
  assert(rootStyles.getPropertyValue('--download-hover').trim() === '#11141a', 'current download hover is preserved');
  const downloadColor = getComputedStyle(fixture.querySelector('.book-download-button')).backgroundColor;
  const readMoreColor = getComputedStyle(fixture.querySelector('.book-annotation-more')).color;
  assert(downloadColor === 'rgb(39, 49, 66)' && readMoreColor === downloadColor, 'read-more text exactly matches download accent');
  const readMoreHoverRule = [...document.styleSheets]
    .flatMap((sheet) => [...sheet.cssRules])
    .find((rule) => rule.selectorText === '.book-annotation-more:not(:disabled):hover');
  assert(readMoreHoverRule?.style.color === 'rgb(0, 0, 0)', 'read-more hover is explicitly black');
  assert(getComputedStyle(fixture.lastElementChild).display === 'none', 'hidden actions take no space');
  fixture.remove();
});

await test('Drive refresh preserves unchanged metadata and resets changed books', () => {
  const ready = { id: 'same', md5Checksum: 'one', modifiedTime: 'x', size: 10, metadataVersion: 1, metadataStatus: 'ready', title: 'Kept', authors: ['A'] };
  const previous = { createdAt: 'old', books: [ready, { ...ready, id: 'changed', title: 'Old' }] };
  const current = { createdAt: 'new', books: [
    { id: 'same', md5Checksum: 'one', modifiedTime: 'x', size: 10, metadataStatus: 'pending' },
    { id: 'changed', md5Checksum: 'two', modifiedTime: 'y', size: 10, metadataStatus: 'pending' },
  ] };
  preserveBookMetadata(current, previous);
  equal([current.createdAt, current.books[0].title, current.books[0].metadataStatus], ['old', 'Kept', 'ready'], 'preserved');
  equal([current.books[1].title, current.books[1].metadataStatus], [undefined, 'pending'], 'changed');
});

output.textContent = failures.length
  ? `${passed} passed, ${failures.length} failed\n\n${failures.join('\n\n')}`
  : `${passed} tests passed`;
document.body.dataset.testStatus = failures.length ? 'failed' : 'passed';

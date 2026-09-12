import {
  decodeFb2, detectEncoding, FB2_RANGES, Fb2Error, parseFb2Metadata, readFb2Description,
} from '../js/fb2.js';
import { migrateIndex } from '../js/library-index.js';
import { classifyLibraryItem, preserveBookMetadata } from '../js/library-tree.js';
import { buildLibraryLookups, folderHasLibraryChildren } from '../js/library-view-model.js';
import { indexPendingBooks } from '../js/metadata-indexer.js';
import { extractZipFb2, findEocd, parseCentralDirectory, ZipError } from '../js/zip.js';
import { setupDropdown } from '../js/dropdown.js';
import { applyDriveAvatar, createAvatarController } from '../js/avatar.js';
import { getCurrentDriveUser } from '../js/drive.js';

const output = document.querySelector('#results');
let passed = 0;
const failures = [];

function assert(value, message) {
  if (!value) throw new Error(message);
}

function equal(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

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
    const local = Uint8Array.from([
      ...le32(0x04034b50), ...le16(20), ...le16(0x0800), ...le16(method), ...le16(0), ...le16(0),
      ...le32(0), ...le32(compressed.length), ...le32(plain.length), ...le16(name.length), ...le16(0),
      ...name, ...compressed,
    ]);
    const central = Uint8Array.from([
      ...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0x0800), ...le16(method), ...le16(0), ...le16(0),
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
  equal(metadata, {
    title: 'Война и мир', authors: ['Лев Николаевич Толстой'], series: 'Классика',
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
  equal(result.index.version, 3, 'version');
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
  assert(!folderHasLibraryChildren(lookups, 'bad-zip-folder'), 'folder containing only a rejected ZIP');
  assert(!folderHasLibraryChildren(lookups, 'empty'), 'truly empty folder');
});

await test('Drive scan classification includes ZIP case-insensitively and ignores unrelated files', () => {
  equal(classifyLibraryItem({ name: 'BOOK.ZiP', mimeType: 'application/octet-stream' }), 'zip', 'ZIP extension');
  equal(classifyLibraryItem({ name: 'book', mimeType: 'application/zip' }), 'zip', 'ZIP MIME');
  equal(classifyLibraryItem({ name: 'book.FB2', mimeType: 'application/octet-stream' }), 'fb2', 'FB2 extension');
  equal(classifyLibraryItem({ name: 'document.pdf', mimeType: 'application/pdf' }), 'other', 'irrelevant file');
  equal(classifyLibraryItem({ name: 'nested', mimeType: 'application/vnd.google-apps.folder' }), 'folder', 'folder unaffected');
});

const zipFb2 = new TextEncoder().encode(xml(`
  <author><first-name>Zip</first-name><last-name>Author</last-name></author>
  <book-title>Archive Book</book-title><annotation><p>From ZIP.</p></annotation>`));

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
    id: 'zip', fileName: 'book.zip', sourceType: 'zip', md5Checksum: 'a', metadataStatus: 'ready',
    entryPath: 'folder/book.fb2', title: 'Kept', authors: ['A'],
  }] };
  const unchanged = { books: [{ id: 'zip', fileName: 'book.zip', sourceType: 'zip', md5Checksum: 'a', metadataStatus: 'pending', entryPath: null }] };
  preserveBookMetadata(unchanged, previous);
  equal([unchanged.books[0].metadataStatus, unchanged.books[0].entryPath], ['ready', 'folder/book.fb2'], 'ZIP metadata preserved');
  const changed = { books: [{ id: 'zip', fileName: 'book.zip', sourceType: 'zip', md5Checksum: 'b', metadataStatus: 'pending', entryPath: null }] };
  preserveBookMetadata(changed, previous);
  equal([changed.books[0].metadataStatus, changed.books[0].entryPath], ['pending', null], 'changed ZIP reset');
  const removed = { books: [] };
  preserveBookMetadata(removed, previous);
  equal(removed.books.length, 0, 'deleted ZIP remains absent');
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

await test('Drive about user returns displayName and photoLink without extra fields', async () => {
  let requestedPath = '';
  const user = await getCurrentDriveUser(async (path) => {
    requestedPath = path;
    return { json: async () => ({ user: { displayName: 'Test User', photoLink: 'photo' } }) };
  });
  equal(user, { displayName: 'Test User', photoLink: 'photo' }, 'Drive user');
  assert(requestedPath.startsWith('/about?') && decodeURIComponent(requestedPath).includes('fields=user(displayName,photoLink)'), 'minimal about fields');
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

await test('production controls keep stop in status panel and menu actions out of header flow', async () => {
  const html = await (await fetch('../index.html')).text();
  const page = new DOMParser().parseFromString(html, 'text/html');
  assert(page.querySelector('#status-panel > #stop-button'), 'stop button belongs to status panel');
  assert(page.querySelector('#avatar-menu > #metadata-button'), 'metadata action belongs to avatar menu');
  assert(page.querySelector('#avatar-menu > #retry-metadata-button'), 'retry action belongs to avatar menu');
  assert(!page.querySelector('.app-header #stop-button'), 'stop is absent from header');
  assert(page.querySelector('h1').textContent === 'Тайная Библиотека', 'header title');
  const fixture = document.createElement('div');
  fixture.innerHTML = '<div class="user-controls"><button class="avatar-button"></button><div class="avatar-menu"><button>Item</button></div></div><button hidden>Hidden</button>';
  document.body.append(fixture);
  assert(getComputedStyle(fixture.querySelector('.avatar-menu')).position === 'absolute', 'dropdown is outside layout flow');
  assert(getComputedStyle(fixture.lastElementChild).display === 'none', 'hidden actions take no space');
  fixture.remove();
});

await test('Drive refresh preserves unchanged metadata and resets changed books', () => {
  const ready = { id: 'same', md5Checksum: 'one', modifiedTime: 'x', size: 10, metadataStatus: 'ready', title: 'Kept', authors: ['A'] };
  const previous = { createdAt: 'old', books: [ready, { ...ready, id: 'changed', title: 'Old' }] };
  const current = { createdAt: 'new', books: [
    { id: 'same', md5Checksum: 'one', modifiedTime: 'y', size: 20, metadataStatus: 'pending' },
    { id: 'changed', md5Checksum: 'two', modifiedTime: 'x', size: 10, metadataStatus: 'pending' },
  ] };
  preserveBookMetadata(current, previous);
  equal([current.createdAt, current.books[0].title, current.books[0].metadataStatus], ['old', 'Kept', 'ready'], 'preserved');
  equal([current.books[1].title, current.books[1].metadataStatus], [undefined, 'pending'], 'changed');
});

output.textContent = failures.length
  ? `${passed} passed, ${failures.length} failed\n\n${failures.join('\n\n')}`
  : `${passed} tests passed`;
document.body.dataset.testStatus = failures.length ? 'failed' : 'passed';

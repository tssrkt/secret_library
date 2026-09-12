import {
  decodeFb2, detectEncoding, FB2_RANGES, Fb2Error, parseFb2Metadata, readFb2Description,
} from '../js/fb2.js';
import { migrateIndex } from '../js/library-index.js';
import { preserveBookMetadata } from '../js/library-tree.js';
import { indexPendingBooks } from '../js/metadata-indexer.js';

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
  equal(result.index.version, 2, 'version');
  equal(result.index.books.map((book) => book.metadataStatus), ['pending', 'pending'], 'statuses');
  assert(result.migrated, 'migration flag');
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

import { parseFullFb2, extractFb2Metadata } from '../js/fb2.js';
import { indexPendingBooks } from '../js/metadata-indexer.js';
import { prepareBuildingIndex, updateBuildProgress, validateCompletedIndex } from '../js/index-build.js';
import { formatIndexingErrors, errorDetails } from '../js/indexing-errors.js';
import { createIndexingErrorsController } from '../js/indexing-errors-ui.js';
import { METADATA_VERSION } from '../js/config.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const bad = '/9j/4AAQSkZJRgABAQ' + '\u0001\u0000\u00ff\ufffdRAW_BYTES';
const binary = (id, payload, mime = 'image/png') => `<binary id="${id}" content-type="${mime}">${payload}</binary>`;
// Minimal reproduction of the reported defect, not a copy of the real book.
const source = (binaries = binary('cover.jpg', bad, 'image/jpeg'), annotation = '<annotation><p>Тестовая аннотация Крови Кадии.</p></annotation>') => `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><genre>sf_epic</genre><author><first-name>Аарон</first-name><last-name>Дембски-Боуден</last-name></author>
<book-title>Кровь Кадии</book-title>${annotation}<lang>ru</lang><sequence name="Тестовый цикл" number="7"/>
<coverpage><image l:href="#cover.jpg"/></coverpage></title-info></description>
<body><section><p>Обычный текст книги остаётся совершенно неизменным.</p></section></body>
${binaries}</FictionBook>`;
const bytes = (text) => new TextEncoder().encode(text);
const pending = (id) => ({ id, fileName: `${id}.fb2`, sourceType: 'fb2', metadataStatus: 'pending' });

export async function runBinaryRecoveryTests(test, assert, equal) {
  const parseWithTrace = (text) => {
    const attempts = [];
    class Parser {
      parseFromString(xml, type) { attempts.push(xml); return new DOMParser().parseFromString(xml, type); }
    }
    return { metadata: parseFullFb2(bytes(text), Parser), attempts };
  };
  await test('valid embedded cover uses only the original strict parse', () => {
    const text = source(binary('cover.jpg', PNG));
    const { metadata, attempts } = parseWithTrace(text);
    equal(attempts, [text], 'no scanner reparse or sanitization for valid FB2');
    assert(metadata.cover.bytes.length > 0 && !metadata.binaryRecovery && !metadata.metadataWarning, 'normal cover unchanged');
  });
  await test('raw bytes in cover recover metadata by removing only that payload', () => {
    const text = source();
    const original = bytes(text);
    const snapshot = [...original];
    const { metadata, attempts } = parseWithTrace(text);
    equal(attempts.length, 2, 'strict failure followed by strict sanitized parse');
    assert(new DOMParser().parseFromString(attempts[0], 'application/xml').querySelector('parsererror'), 'original really is invalid XML');
    equal(attempts[1], text.replace(bad, ''), 'no changes outside exact binary payload');
    equal([metadata.title, metadata.authors, metadata.genres, metadata.annotation, metadata.series, metadata.seriesNumber, metadata.language],
      ['Кровь Кадии', ['Аарон Дембски-Боуден'], ['sf_epic'], 'Тестовая аннотация Крови Кадии.', 'Тестовый цикл', 7, 'ru'], 'all source metadata survives');
    assert(!metadata.cover && metadata.binaryRecovery.coverDamaged, 'broken cover is never decoded');
    equal(metadata.binaryRecovery.binaries.map((item) => item.id), ['cover.jpg'], 'arbitrary binary ID is recorded');
    parseFullFb2(original);
    equal([...original], snapshot, 'original byte buffer unchanged');
    equal(parseFullFb2(bytes(source(undefined, ''))).preview, 'Обычный текст книги остаётся совершенно неизменным.', 'existing preview logic retained');
    assert(parseFullFb2(bytes(source(binary('cover.jpg', '<\u0001raw&bytes')))).binaryRecovery, 'raw angle bracket is not mistaken for a structural tag');
  });
  await test('only damaged binary payloads are removed, including multiple arbitrary image IDs', () => {
    const text = source(binary('cover.jpg', PNG) + binary('illustration-17', bad, 'image/webp') + binary('drawing', '&broken', 'image/gif'));
    const { metadata, attempts } = parseWithTrace(text);
    equal(metadata.binaryRecovery.binaries.map((item) => item.id), ['illustration-17', 'drawing'], 'all damaged IDs enumerated');
    assert(metadata.cover.bytes.length > 0 && !metadata.binaryRecovery.coverDamaged, 'good cover retained');
    assert(attempts[1].includes(PNG), 'good embedded payload retained exactly');
    const damagedCover = source(binary('cover.jpg', bad) + binary('good-illustration', PNG));
    assert(parseWithTrace(damagedCover).attempts[1].includes(PNG), 'good illustration survives a damaged cover');
    const wrapped = `<![CDATA[${PNG}]]><!-- valid comment -->`;
    const withCdata = parseWithTrace(source(binary('cover.jpg', wrapped) + binary('broken', bad)));
    assert(withCdata.attempts[1].includes(wrapped) && withCdata.metadata.cover.bytes.length > 0, 'valid CDATA and comment inside good image preserved');
  });
  await test('scanner handles namespaces, quoted greater-than signs and self-closing binaries', () => {
    let text = source('<binary id="empty"/>' + binary('cover.jpg', bad));
    text = text.replace(/<(\/?)(FictionBook|binary)(?=[\s>])/g, '<$1f:$2').replace('<f:FictionBook ', '<f:FictionBook xmlns:f="http://www.gribuser.ru/xml/fictionbook/2.0" ');
    text = text.replace('id="cover.jpg"', "id = 'cover.jpg' note='a > b'");
    const { metadata, attempts } = parseWithTrace(text);
    equal(metadata.binaryRecovery.binaries[0].id, 'cover.jpg', 'namespace and quote aware scanning');
    equal(attempts[1], text.replace(bad, ''), 'attributes kept byte-for-byte');
  });
  await test('real XML damage outside binary and ambiguous boundaries remain fatal', () => {
    const cases = [
      source().replace('</section>', ''),
      source().replace('Обычный', 'Обычный\u0001'),
      source().replace('Тестовая аннотация', 'Аннотация\u0001'),
      source().replace('content-type="image/jpeg"', 'content-type="image/jpeg\u0001"'),
      source().replace('</binary>', '<body><section><p>must not disappear</p></section></body></binary>'),
      source().replace('</binary>', '<раздел>must not disappear</раздел></binary>'),
      source().replace('</binary>', ''),
      source().replace('<binary ', '<foreign:binary xmlns:foreign="urn:foreign" ').replace('</binary>', '</foreign:binary>'),
      source('').replace('Обычный', 'Обычный\u0001'),
      source('').replace('</section>', '<binary id="not-an-attachment">\u0001</binary></section>'),
      source('').replace('</section>', '<!-- <binary id="fake"> -->\u0001<!-- </binary> --></section>'),
      source('').replace('</section>', '<![CDATA[<binary id="fake">\u0001</binary>]]></section>'),
    ];
    for (const text of cases) {
      try { parseFullFb2(bytes(text)); assert(false, 'must reject genuine malformed XML'); }
      catch (error) {
        equal(error.code, 'invalid_xml', 'fatal invalid_xml retained');
        assert(error.parserMessage && error.stage === 'parse', 'safe parser diagnostic attached');
        assert(error.parserLine > 0 && error.parserColumn > 0, 'browser parser line and column retained');
      }
    }
  });
  await test('binary recovery downloads once and keeps previous cover without calling cover storage', async () => {
    for (const hasPreviousCover of [false, true]) {
      const old = { ...pending('07. Кровь Кадии'), metadataStatus: 'ready', metadataVersion: METADATA_VERSION - 1,
        title: 'Old', authors: ['Old'], genres: [], ...(hasPreviousCover ? { coverFileId: 'good-old-cover', coverMimeType: 'image/webp' } : {}) };
      const active = { version: 4, rootFolderId: 'root', folders: [], books: [old] };
      const snapshot = JSON.stringify(active);
      const building = prepareBuildingIndex(active);
      let downloads = 0;
      let coverCalls = 0;
      let updates = 0;
      const stats = await indexPendingBooks(building, { previousIndex: active,
        extract: (book) => extractFb2Metadata(book, { downloadFile: async () => { downloads++; return new Blob([source()]); } }),
        onCover: async () => { coverCalls++; throw new Error('broken cover must not reach image decoder'); },
        onErrors: () => updates++,
      });
      equal([downloads, coverCalls, stats.succeeded, stats.recovered, stats.failed, stats.processed, updates], [1, 0, 0, 1, 0, 1, 1], 'local recovery, separate stats, journal update');
      const book = building.books[0];
      equal([book.title, book.metadataStatus, book.coverFileId], ['Кровь Кадии', 'ready', hasPreviousCover ? 'good-old-cover' : null], 'normal indexed record with old cover or fallback');
      assert(!Object.hasOwn(book, 'binaryRecovery') && !Object.hasOwn(book, 'cover'), 'transient parse data not stored in book');
      const entry = building.indexingErrors[0];
      equal([entry.outcome, entry.code, entry.previousCoverPreserved, entry.metadataIndexed, entry.bookSkipped],
        ['recovered', 'binary_corruption_recovered', hasPreviousCover, true, false], 'warning explains successful recovery');
      const report = formatIndexingErrors(building.indexingErrors);
      assert(report.includes('Binary id: cover.jpg') && report.includes('Content-Type: image/jpeg') && report.includes('Metadata indexed: yes') && report.includes('Book skipped: no'), 'complete recovery log');
      assert(!report.includes('RAW_BYTES') && !report.includes('/9j/') && !report.includes('Тестовая аннотация'), 'no payload or book text logged');
      updateBuildProgress(building, stats);
      equal(building.buildState.progress.recovered, 1, 'checkpoint retains recovered count');
      equal(validateCompletedIndex(building, active).books[0].title, 'Кровь Кадии', 'recovered record passes shadow publish validation');
      equal(JSON.stringify(active), snapshot, 'previous working index untouched');
    }
  });
  await test('failed recovery preserves prior record and continues processing the next book', async () => {
    const old = { ...pending('bad'), metadataStatus: 'ready', metadataVersion: METADATA_VERSION - 1,
      title: 'Old good title', authors: ['Old'], genres: [], annotation: 'old annotation', coverFileId: 'old-cover' };
    const active = { version: 4, rootFolderId: 'root', folders: [], books: [old, pending('next'), pending('no-previous')] };
    const building = prepareBuildingIndex(active);
    const stats = await indexPendingBooks(building, { previousIndex: active, concurrency: 1,
      extract: async (book) => parseFullFb2(bytes(book.id === 'next' ? source(binary('cover.jpg', PNG)) : source().replace('Обычный', 'Обычный\u0001'))),
    });
    equal([stats.succeeded, stats.recovered, stats.failed, stats.processed], [1, 0, 2, 3], 'continue after invalid_xml');
    equal(building.books[0], old, 'whole previous good record preserved');
    equal(building.books[2].metadataError, 'invalid_xml', 'no previous record is fatal');
    assert(building.indexingErrors.every((entry) => entry.outcome === 'failed' && entry.parserMessage), 'remaining failures have parser details');
    assert(validateCompletedIndex(building, active), 'failed and recovered records keep shadow validation guarantees');
  });
  await test('journal displays recovered binaries as warnings separately from failures and retries', async () => {
    const index = { books: [pending('warning')] };
    await indexPendingBooks(index, { extract: async () => parseFullFb2(bytes(source())) });
    const markup = new DOMParser().parseFromString(await (await fetch('../index.html')).text(), 'text/html');
    const root = markup.querySelector('#indexing-errors');
    document.body.append(root);
    const controller = createIndexingErrorsController(root);
    const failed = { ...errorDetails({ code: 'invalid_xml', stage: 'parse', message: 'Malformed XML' }), fileId: 'failed', outcome: 'failed' };
    const retry = { ...errorDetails({ status: 429, message: 'Retry succeeded' }), fileId: 'retry', outcome: 'recovered' };
    controller.update([...index.indexingErrors, failed, retry]);
    assert(root.querySelector('[data-error-count]').textContent.includes('Ошибок: 1. Предупреждений: 1. Восстановлено повтором: 1.'), 'separate counts');
    equal(root.querySelector('[data-error-list]').children.length, 1, 'warning absent from fatal list');
    const warning = root.querySelector('[data-recovered-list]').firstElementChild.textContent;
    assert(warning.includes('книга проиндексирована без него') && !warning.includes('повтор успешен'), 'recovery reason is accurate');
    controller.reset(); root.remove();
  });
}

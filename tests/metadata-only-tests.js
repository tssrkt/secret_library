import { extractBookMetadata } from '../js/book-metadata.js';
import { parseFullFb2 } from '../js/fb2.js';
import { indexPendingBooks } from '../js/metadata-indexer.js';
import { failedBookIds } from '../js/indexing-state.js';
import { formatIndexingErrors } from '../js/indexing-errors.js';

const bytes = (text) => new TextEncoder().encode(text);
const description = '<description><title-info><book-title>Book</book-title><author><first-name>Author</first-name></author><genre>sf</genre><annotation><p>Annotation</p></annotation><lang>ru</lang><sequence name="Series" number="2"/><coverpage><image l:href="#cover"/></coverpage></title-info></description>';
const root = '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink" note="a > b">';
const source = (tail) => root + description + tail;
const pending = () => ({ id: 'book', fileName: 'book.fb2', sourceType: 'fb2', metadataStatus: 'pending' });

export async function runMetadataOnlyTests(test, assert, equal, makeZip) {
  for (const [label, tail, code] of [
    ['valid', '</FictionBook>', null],
    ['binary', '<body><p>Normal book text</p></body><binary id="cover">AAAA\u0001BBBB</binary></FictionBook>', 'binary_corruption_recovered'],
    ['metadata', '<body><section></body></FictionBook>', 'metadata_only_recovered'],
  ]) {
    await test(`ZIP signature with fb2 filename uses shared pipeline: ${label}`, async () => {
      const archive = await makeZip([{ name: 'inner.fb2', bytes: bytes(source(tail)) }]);
      let downloads = 0; let ranges = 0;
      const result = await extractBookMetadata({ ...pending(), size: archive.length }, {
        downloadFile: async () => { downloads++; return new Blob([archive]); },
        fetchRange: async () => { ranges++; throw new Error('already downloaded'); },
      });
      equal([result.title, result.entryPath, result.metadataWarning || null, downloads, ranges], ['Book', 'inner.fb2', code, 1, 0], 'container reused locally');
      if (code) equal(result.binaryRecovery.containerType, 'ZIP', 'inner recovery container');
    });
  }
  await test('ZIP signature keeps no-FB2, malformed and bomb errors', async () => {
    const bomb = await makeZip([{ name: 'bomb.fb2', method: 8, bytes: bytes('x'.repeat(1024 * 1024)) }]);
    for (const [archive, code] of [
      [await makeZip([{ name: 'book.txt', bytes: bytes('text') }]), 'zip_no_fb2'],
      [new Uint8Array([80, 75, 3, 4, 0]), 'malformed_zip'],
      [bomb, 'zip_suspicious_compression_ratio'],
    ]) {
      let error;
      try { await extractBookMetadata(pending(), { downloadFile: async () => new Blob([archive]) }); } catch (caught) { error = caught; }
      equal([error?.code, error?.containerType], [code, 'ZIP'], 'same ZIP protections');
    }
  });
  await test('large disguised ZIP uses cached prefix and existing ranges; 416 falls back only once', async () => {
    const archive = await makeZip([{ name: 'inner.fb2', bytes: bytes(source('</FictionBook>')) },
      { name: 'padding.dat', bytes: new Uint8Array(1_100_000) }]);
    for (const failRange of [false, true]) {
      let downloads = 0; const ranges = [];
      const result = await extractBookMetadata({ ...pending(), size: archive.length }, {
        downloadFile: async () => { downloads++; return new Blob([archive]); },
        fetchRange: async (id, start, end) => {
          ranges.push([start, end]);
          if (failRange) throw Object.assign(new Error('range'), { status: 416 });
          return { bytes: archive.subarray(start, end + 1), status: 206, isComplete: end >= archive.length - 1 };
        },
      });
      equal([result.title, downloads], ['Book', failRange ? 1 : 0], 'range path or one full fallback');
      assert(ranges.filter(([start]) => start === 0).length === 1, 'cached header not requested twice');
      if (failRange) equal(ranges.length, 1, 'no further network range requests after fallback');
    }
  });
  await test('valid namespace-aware description survives broken body or unclosed binary without preview/cover', () => {
    for (const tail of ['<body><section></body></FictionBook>', '<body><p>Text\u0001</p></body></FictionBook>', '<binary id="cover">AAAA\u0001raw']) {
      const result = parseFullFb2(bytes(source(tail)));
      equal([result.title, result.authors, result.genres, result.annotation, result.series, result.seriesNumber, result.language],
        ['Book', ['Author'], ['sf'], 'Annotation', 'Series', 2, 'ru'], 'existing metadata contract');
      equal(result.metadataWarning, 'metadata_only_recovered', 'distinct recovery');
      assert(!result.preview && !result.cover && result.binaryRecovery.metadataRecoveryAttempt.descriptionValid, 'strict description only');
    }
    const noAnnotation = source('<body><p>Must not become preview</p></body><binary>').replace('<annotation><p>Annotation</p></annotation>', '');
    assert(!parseFullFb2(bytes(noAnnotation)).preview, 'no body preview even without annotation');
    const prefixed = source('<body>').replace('<FictionBook ', '<f:FictionBook xmlns:f="http://www.gribuser.ru/xml/fictionbook/2.0" ')
      .replace('<description>', '<f:description>').replace('</description>', '</f:description>')
      .replace('Annotation', '<![CDATA[Annotation </description>]]>');
    const result = parseFullFb2(bytes(prefixed));
    equal(result.annotation, 'Annotation </description>', 'CDATA closing lookalike is not a boundary; root namespaces inherited');
  });
  await test('invalid description, fake roots and unrelated formats are never salvaged', () => {
    for (const [text, code] of [
      [source('<body>').replace('</book-title>', ''), 'invalid_xml'],
      [source('<body>').replace('Annotation', 'Bad\u0001text'), 'invalid_xml'],
      ['<!--' + source('<body>') + '-->', 'invalid_xml'],
      ['<html>' + source('<body>') + '</html>', 'not_xml_html'],
      ['{\\rtf1 ' + source('<body>'), 'not_xml_rtf'],
    ]) {
      let error; try { parseFullFb2(bytes(text)); } catch (caught) { error = caught; }
      equal(error?.code, code, 'no field regex repair');
      if (code !== 'invalid_xml') assert(!error.metadataRecoveryAttempt?.attempted, 'non-FB2 recovery not attempted');
    }
    let error; try { parseFullFb2(new Uint8Array([255, 216, 255, 0])); } catch (caught) { error = caught; }
    equal(error.code, 'binary_file', 'unknown binary remains fatal');
  });
  await test('metadata-only creates ready record, clears failed set, preserves previous full record and logs warning', async () => {
    for (const hasPrevious of [false, true]) {
      const previous = { ...pending(), metadataStatus: 'ready', title: 'Old title', authors: ['Old author'], genres: ['old'],
        annotation: 'Old annotation', preview: 'Old preview', coverFileId: 'old-cover', coverMimeType: 'image/png' };
      const index = { books: [pending()], buildState: { mode: 'retry', selectedIds: ['book'], removedBookIds: [] },
        indexingErrors: [{ fileId: 'book', outcome: 'failed', stage: 'parse' }] };
      let downloads = 0;
      const stats = await indexPendingBooks(index, { previousIndex: hasPrevious ? { books: [previous] } : null,
        extract: (book) => extractBookMetadata(book, { downloadFile: async () => { downloads++; return new Blob([source('<binary id="cover">AAAA\u0001raw')]); } }),
        onCover: () => { throw new Error('damaged cover must not be read'); },
      });
      equal([stats.failed, stats.recovered, downloads, failedBookIds(index).size], [0, 1, 1, 0], 'warning replaces unresolved failure');
      if (hasPrevious) equal(index.books[0], previous, 'full previous record unchanged');
      else equal([index.books[0].title, index.books[0].metadataStatus, index.books[0].preview], ['Book', 'ready', null], 'new metadata-only card');
      const log = formatIndexingErrors(index.indexingErrors);
      assert(log.includes('Code: metadata_only_recovered') && log.includes('Full XML parsed: no') && log.includes('Body indexed: no'), 'explicit scope in journal');
      assert(log.includes(`Previous full index entry preserved: ${hasPrevious ? 'yes' : 'no'}`) && !log.includes('AAAA'), 'preservation logged without payload');
    }
  });
}

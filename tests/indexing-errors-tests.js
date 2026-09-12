import { extractBookMetadata } from '../js/book-metadata.js';
import { indexPendingBooks } from '../js/metadata-indexer.js';
import { prepareBuildingIndex, validateCompletedIndex } from '../js/index-build.js';
import { readFb2Description } from '../js/fb2.js';
import { downloadFileRange } from '../js/drive.js';
import { restoreAuthSession, clearAccessToken } from '../js/auth.js';
import { METADATA_VERSION } from '../js/config.js';
import { formatIndexingErrors } from '../js/indexing-errors.js';
import { createIndexingErrorsController } from '../js/indexing-errors-ui.js';
import { saveBuildingIndex } from '../js/library-index.js';

const fb2 = '<FictionBook><description><title-info><book-title>Good</book-title><author><first-name>Author</first-name></author><genre>sf</genre><annotation><p>Good annotation.</p></annotation></title-info></description></FictionBook>';
const pendingBook = (id, size = 100) => ({ id, fileName: `${id}.fb2`, sourceType: 'fb2', size, metadataStatus: 'pending' });

async function withDrive(respond, run) {
  const original = window.fetch;
  const calls = [];
  restoreAuthSession({ session: { getItem: () => JSON.stringify({ accessToken: 'test-only', expiresAt: Date.now() + 60000 }) } });
  window.fetch = async (url, options = {}) => {
    const call = { fileId: String(url).match(/\/files\/([^?]+)/)?.[1], range: options.headers?.Range || null, url: String(url) };
    calls.push(call);
    return respond(call, calls.length);
  };
  try { await run(calls); } finally { window.fetch = original; clearAccessToken(); }
}

export async function runIndexingErrorTests(test, assert, equal, makeZip) {
  await test('small FB2 indexes with one complete download, no Range and no errors', async () => {
    await withDrive(() => new Response(fb2), async (calls) => {
      const index = { books: [pendingBook('good')] };
      const stats = await indexPendingBooks(index);
      equal([stats.succeeded, stats.failed, calls.length, calls[0].range, index.indexingErrors.length], [1, 0, 1, null, 0], 'single full read');
      equal(index.books[0].title, 'Good', 'XML parsed');
    });
  });
  await test('416 retries once without Range and logs a recovered request', async () => {
    await withDrive((call, attempt) => attempt === 1 ? new Response('', { status: 416, headers: { 'Content-Range': 'bytes */100' } }) : new Response(fb2), async (calls) => {
      const index = { books: [pendingBook('range', 2000000)] };
      const stats = await indexPendingBooks(index);
      equal(calls.map((call) => call.range), ['bytes=0-65535', null], 'fresh complete request exactly once');
      equal([stats.succeeded, stats.failed], [1, 0], 'recovered book succeeds');
      const entry = index.indexingErrors[0];
      equal([entry.fileId, entry.status, entry.stage, entry.retryResult, entry.outcome, entry.contentRange],
        ['range', 416, 'download', 'success-without-range', 'recovered', 'bytes */100'], 'detailed recovered event');
    });
  });
  await test('repeated 416 preserves old record, continues next book and validates complete index', async () => {
    await withDrive((call) => call.fileId === 'bad' ? new Response('', { status: 416 }) : new Response(fb2), async (calls) => {
      const old = { ...pendingBook('bad', 2000000), metadataStatus: 'ready', metadataVersion: METADATA_VERSION - 1,
        title: 'Old title', authors: ['Old author'], genres: ['old'], annotation: 'Old annotation', preview: 'Old preview', coverFileId: 'old-cover' };
      const active = { version: 4, rootFolderId: 'root', folders: [], books: [old, pendingBook('good')] };
      const snapshot = JSON.stringify(active);
      const building = prepareBuildingIndex(active);
      const stats = await indexPendingBooks(building, { previousIndex: active, concurrency: 1 });
      equal([stats.failed, stats.succeeded, calls.filter((call) => call.fileId === 'bad').length], [1, 1, 2], 'bounded retry and next book');
      equal(JSON.stringify(building.books[0]), JSON.stringify(old), 'whole prior good record retained including version and cover');
      equal(JSON.stringify(active), snapshot, 'active index unchanged during build');
      const complete = validateCompletedIndex(building, active);
      equal(complete.books[0], old, 'preserved old-version record can be published');
      const entry = complete.indexingErrors[0];
      equal([entry.status, entry.attempt, entry.retryResult, entry.previousEntryPreserved], [416, 2, 'failed-without-range', true], 'terminal diagnostic');
      const tampered = structuredClone(building); tampered.books[0].title = '';
      try { validateCompletedIndex(tampered, active); assert(false, 'partial fallback must be rejected'); }
      catch (error) { assert(error.message.includes('differs'), 'fallback integrity checked'); }
    });
  });
  await test('404 is one failed book without retry and next book still indexes', async () => {
    await withDrive((call) => call.fileId === 'missing' ? new Response('', { status: 404 }) : new Response(fb2), async (calls) => {
      const index = { books: [pendingBook('missing'), pendingBook('good')] };
      const stats = await indexPendingBooks(index, { concurrency: 1 });
      equal([stats.failed, stats.succeeded, calls.filter((call) => call.fileId === 'missing').length], [1, 1, 1], 'no pointless retries');
      equal([index.indexingErrors.length, index.indexingErrors[0].status, index.indexingErrors[0].retryResult], [1, 404, 'not-retried'], '404 status survives FB2 extraction');
      assert(!index.indexingErrors[0].message.includes('Корневая папка'), 'file failure is not mislabeled as root failure');
    });
  });
  await test('journal survives checkpoint and preserved ready records remain eligible for explicit retry', async () => {
    const active = { version: 4, rootFolderId: 'root', folders: [], books: [{ ...pendingBook('old'), metadataStatus: 'ready', metadataVersion: METADATA_VERSION }],
      indexingErrors: [{ fileId: 'old', outcome: 'failed', previousEntryPreserved: true, stage: 'download', status: 404 }] };
    const building = prepareBuildingIndex(active, { retryErrors: true });
    equal([building.buildState.total, building.books[0].metadataStatus], [1, 'pending'], 'ready fallback can be retried');
    building.indexingErrors = structuredClone(active.indexingErrors);
    let stored;
    await saveBuildingIndex(building, null, { create: async (name, json) => { stored = JSON.parse(json); return { id: 'draft' }; } });
    equal(stored.indexingErrors, active.indexingErrors, 'journal persists in normal draft checkpoint');
  });
  await test('503 and network failures have three attempts and bounded increasing backoff', async () => {
    for (const network of [false, true]) await withDrive(() => {
      if (network) throw new TypeError('Network failed');
      return new Response('', { status: 503 });
    }, async (calls) => {
      const sleeps = [];
      const index = { books: [pendingBook('temporary')] };
      const stats = await indexPendingBooks(index, {
        extract: (book, options) => extractBookMetadata(book, { ...options, diagnostics: { sleep: async (delay) => sleeps.push(delay) } }),
      });
      equal([calls.length, stats.failed, index.indexingErrors.length], [3, 1, 1], 'one file error with all attempts');
      assert(sleeps.length === 2 && sleeps[1] > sleeps[0], 'increasing backoff');
      equal([index.indexingErrors[0].attempt, index.indexingErrors[0].retryResult], [3, 'exhausted'], 'retry exhaustion recorded');
      assert(index.indexingErrors[0].events.length === 3, 'request history retained');
    });
  });
  await test('temporary retry recovery records success instead of a failed book', async () => {
    await withDrive((call, attempt) => attempt === 1 ? new Response('', { status: 429 }) : new Response(fb2), async (calls) => {
      const index = { books: [pendingBook('throttled')] };
      const stats = await indexPendingBooks(index, { extract: (book, options) => extractBookMetadata(book, { ...options, diagnostics: { sleep: async () => {} } }) });
      equal([stats.succeeded, stats.failed, calls.length], [1, 0, 2], 'retry succeeds');
      equal(index.indexingErrors[0].retryResult, 'success-after-backoff', 'recovered outcome');
    });
  });
  await test('stale ZIP size reproduces 416 and full retry resets all ZIP offsets', async () => {
    const bytes = await makeZip([{ name: 'inside.fb2', bytes: new TextEncoder().encode(fb2) }]);
    await withDrive((call) => call.range ? new Response('', { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } }) : new Response(bytes), async (calls) => {
      const index = { books: [{ ...pendingBook('archive', bytes.length + 200000), sourceType: 'zip', fileName: 'archive.zip' }] };
      const stats = await indexPendingBooks(index);
      assert(Number(calls[0].range.match(/bytes=(\d+)/)[1]) >= bytes.length, 'stale tail starts beyond current EOF: concrete 416 cause');
      equal([calls.length, calls[1].range, stats.succeeded, index.books[0].entryPath], [2, null, 1, 'inside.fb2'], 'ZIP reparses full buffer without further network');
    });
  });
  await test('FB2 exact range boundary without Content-Range reproduces EOF 416; known size prevents it', async () => {
    const requests = [];
    const fetchRange = async (id, start, end) => {
      requests.push(start);
      if (start >= 65536) throw Object.assign(new Error('EOF'), { status: 416 });
      return { bytes: new TextEncoder().encode('x'.repeat(65536)), isComplete: false, status: 206 };
    };
    try { await readFb2Description('boundary', { fetchRange }); assert(false, 'historical unbounded path fails'); }
    catch (error) { equal(error.status, 416, 'EOF outside the file'); }
    equal(requests, [0, 65536], 'exact boundary triggers next request without total size');
    requests.length = 0;
    try { await readFb2Description('boundary', { fetchRange, size: 65536 }); assert(false, 'invalid XML rejected'); }
    catch (error) { equal(error.code, 'description_not_found', 'metadata error instead of illegal range'); }
    equal(requests, [0], 'no request beyond known EOF');
  });
  await test('wrong Content-Range is rejected and 200 full response replaces earlier chunks', async () => {
    await withDrive(() => new Response('wrong', { status: 206, headers: { 'Content-Range': 'bytes 2-6/10' } }), async () => {
      try { await downloadFileRange('bad-range', 0, 4); assert(false, 'invalid range rejected'); }
      catch (error) { equal(error.code, 'invalid_content_range', 'range response validated'); }
    });
    let calls = 0;
    const prefix = await readFb2Description('changed', { fetchRange: async () => ++calls === 1
      ? { bytes: new TextEncoder().encode('x'.repeat(65536)), status: 206, isComplete: false }
      : { bytes: new TextEncoder().encode(fb2), status: 200, isComplete: true } });
    assert(prefix.startsWith('<FictionBook>'), 'no concatenation of stale prefix with full response');
  });
  await test('parse and cover failures have distinct stages and favicon is not an indexing error', async () => {
    await withDrive((call) => call.url.includes('favicon') ? new Response('', { status: 404 }) : new Response('<broken>'), async () => {
      const index = { books: [pendingBook('broken')] };
      await fetch('/favicon.ico');
      await indexPendingBooks(index);
      equal([index.indexingErrors.length, index.indexingErrors[0].stage, index.indexingErrors[0].status], [1, 'parse', null], 'only book parse failure logged');
    });
    const index = { books: [pendingBook('cover')] };
    await indexPendingBooks(index, { extract: async () => ({ title: 'Title' }), onCover: async () => { throw Object.assign(new Error('cover store missing'), { status: 404 }); } });
    equal(index.indexingErrors[0].stage, 'cover', 'cover-stage failure');
  });
  await test('journal UI exposes per-file errors, copy fallback and downloadable report', async () => {
    const markup = new DOMParser().parseFromString(await (await fetch('../index.html')).text(), 'text/html');
    const root = markup.querySelector('#indexing-errors');
    document.body.append(root);
    const controller = createIndexingErrorsController(root);
    const entry = { timestamp: new Date().toISOString(), fileName: '<book>.fb2', fileId: 'test-id', stage: 'download', status: 404,
      code: 'drive_error', message: 'Not found', attempt: 1, retryResult: 'not-retried', previousEntryPreserved: true, outcome: 'failed' };
    controller.update([entry]);
    root.querySelector('[data-error-toggle]').click();
    assert(!root.querySelector('[data-error-panel]').hidden, 'list opens');
    assert(root.querySelectorAll('li').length === 1 && root.textContent.includes('<book>.fb2'), 'one escaped row per file');
    assert(root.querySelector('[data-error-count]').textContent.includes('Ошибок: 1'), 'count matches failed rows');
    const report = formatIndexingErrors([entry]);
    assert(report.includes('FileId: test-id') && report.includes('Previous index entry preserved: yes') && report.includes('HTTP: 404'), 'copy/download contains diagnostic details');
    assert(root.querySelector('[data-error-copy]') && root.querySelector('[data-error-download]'), 'both report actions available');
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    let copied;
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { copied = text; } } });
      root.querySelector('[data-error-copy]').click();
      await Promise.resolve();
      equal(copied, report, 'copy action writes the full report');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
      root.querySelector('[data-error-copy]').click();
      await Promise.resolve();
      assert(!root.querySelector('textarea').hidden && root.querySelector('textarea').value === report, 'copy failure offers selectable report');
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else delete navigator.clipboard;
    }
    controller.reset(); root.remove();
  });
}

import { prepareIndexingRun, createRetryEligibilityCheck } from '../js/indexing-run.js';
import { validateCompletedIndex, updateBuildProgress, canResumeBuildingIndex } from '../js/index-build.js';
import { failedBookIds, metadataActionLabels } from '../js/indexing-state.js';
import { indexPendingBooks } from '../js/metadata-indexer.js';
import { METADATA_VERSION, INDEX_VERSION } from '../js/config.js';

const book = (id) => ({ id: String(id), parentId: 'root', fileName: `${id}.fb2`, sourceType: 'fb2',
  metadataStatus: 'ready', metadataVersion: METADATA_VERSION, title: `Book ${id}`, authors: [], genres: [] });
const library = (books) => ({ version: INDEX_VERSION, rootFolderId: 'root', updatedAt: 'original', folders: [], books,
  lastFullScan: { totalEligible: books.length }, indexingErrors: [] });
const metadata = () => ({ title: 'Indexed', authors: [], genres: [] });
const failure = (id) => ({ fileId: String(id), stage: 'parse', outcome: 'failed', code: 'invalid_xml' });

export async function runIndexingRunTests(test, assert, equal) {
  await test('9257 full books and 303 failures have independent menu counts and execution sets', async () => {
    const active = library(Array.from({ length: 9257 }, (_, id) => book(id)));
    active.indexingErrors = Array.from({ length: 303 }, (_, id) => failure(id));
    active.indexingErrors.push({ fileId: '400', outcome: 'recovered', stage: 'parse' });
    const snapshot = JSON.stringify(active);
    const labels = metadataActionLabels(active);
    equal(labels.full, `Переиндексировать все книги (${(9257).toLocaleString('ru-RU')})`, 'full count');
    equal(labels.retry, 'Повторить ошибки (303)', 'failed count');
    let scans = 0;
    const full = await prepareIndexingRun(active, { mode: 'full', scan: async () => { scans++; return structuredClone(active); } });
    let calls = 0;
    const stats = await indexPendingBooks(full, { previousIndex: active, extract: async () => { calls++; return metadata(); } });
    updateBuildProgress(full, stats);
    const completed = validateCompletedIndex(full, active);
    equal([scans, calls, stats.total, stats.succeeded, failedBookIds(completed).size], [1, 9257, 9257, 9257, 0], 'all books including previous failed and recovered processed');
    equal(JSON.stringify(active), snapshot, 'active remains untouched throughout shadow build');
    assert(completed.fullRunId === full.buildState.runId, 'full result owns its run ID');

    const retry = await prepareIndexingRun(active, { mode: 'retry', scan: async () => { throw new Error('Retry must not scan'); } });
    const selected = [];
    const retryStats = await indexPendingBooks(retry, { previousIndex: active, extract: async (item) => {
      selected.push(item.id);
      if (+item.id >= 270) throw Object.assign(new Error('Still malformed'), { code: 'invalid_xml', stage: 'parse' });
      return +item.id < 250 ? metadata() : { ...metadata(), metadataWarning: 'binary_corruption_recovered',
        binaryRecovery: { code: 'binary_corruption_recovered', stage: 'parse', message: 'Recovered binary', binaries: [], coverDamaged: true } };
    } });
    updateBuildProgress(retry, retryStats);
    const retried = validateCompletedIndex(retry, active);
    equal([selected.length, retryStats.total, retryStats.succeeded, retryStats.recovered, retryStats.failed], [303, 303, 250, 20, 33], 'retry only failed files');
    assert(!selected.includes('400'), 'recovered excluded from retry');
    equal(failedBookIds(retried).size, 33, 'resolved reports removed');
    equal(metadataActionLabels(retried).retry, 'Повторить ошибки (33)', 'counter shrinks');
    equal(metadataActionLabels(retried).full, labels.full, 'retry does not overwrite last full scan count');
    assert(retried.indexingErrors.filter((entry) => entry.outcome === 'failed').every((entry) => entry.runId === retry.buildState.runId), 'remaining errors belong to retry run');
    equal(JSON.stringify(active), snapshot, 'retry does not mutate active');
  });

  await test('full action remains available with zero errors and unknown total', () => {
    const active = library([book('one')]);
    delete active.lastFullScan;
    equal(metadataActionLabels(active).full, 'Переиндексировать все книги', 'no invented count and full available');
    assert(metadataActionLabels(active).retryHidden, 'nothing to retry');
  });

  await test('fresh full scan includes additions, removes missing books and preserves moved good metadata on failure', async () => {
    const active = library([book('deleted'), book('moved'), book('old-failed')]);
    active.indexingErrors = [failure('old-failed')];
    const scanned = library([book('new'), { ...book('moved'), parentId: 'new-folder', fileName: 'renamed.fb2' }, book('old-failed')]);
    const building = await prepareIndexingRun(active, { mode: 'full', scan: async () => scanned });
    await indexPendingBooks(building, { previousIndex: active, extract: async (item) => {
      if (item.id === 'moved') throw Object.assign(new Error('Malformed'), { code: 'invalid_xml' });
      return metadata();
    } });
    const completed = validateCompletedIndex(building, active);
    equal(completed.books.map((item) => item.id), ['new', 'moved', 'old-failed'], 'current Drive membership');
    equal([completed.books[1].title, completed.books[1].parentId, completed.books[1].fileName], ['Book moved', 'new-folder', 'renamed.fb2'], 'old good metadata with current path');
    equal([...failedBookIds(completed)], ['moved'], 'new full failed set replaces historical errors');
    const incomplete = structuredClone(building);
    incomplete.books.pop();
    let rejected = false;
    try { validateCompletedIndex(incomplete, active); } catch { rejected = true; }
    assert(rejected, 'partial full manifest rejected');
  });

  await test('interrupted full build reload keeps active and requires fresh matching scan to resume', async () => {
    const active = library([book('a')]);
    const snapshot = JSON.stringify(active);
    const scan = async () => library([book('a'), book('new')]);
    const building = await prepareIndexingRun(active, { mode: 'full', scan });
    const controller = new AbortController();
    await indexPendingBooks(building, { signal: controller.signal, concurrency: 1,
      extract: async () => { controller.abort(); return metadata(); } });
    const reloaded = JSON.parse(JSON.stringify(building));
    assert(canResumeBuildingIndex(reloaded, active, { mode: 'full' }), 'draft reload is separate from active');
    equal(JSON.stringify(active), snapshot, 'old active survived interruption');
    assert(await prepareIndexingRun(active, { mode: 'full', building: reloaded, scan }) === reloaded, 'matching fresh scan resumes');
    const changed = await prepareIndexingRun(active, { mode: 'full', building: reloaded, scan: async () => library([book('different')]) });
    equal(changed.books.map((item) => item.id), ['different'], 'changed Drive tree restarts full manifest');
    assert(!canResumeBuildingIndex(reloaded, active, { mode: 'retry' }), 'full never becomes retry');
  });

  await test('retry leaves unrelated pending and outdated books untouched', async () => {
    const active = library([book('failed'), { ...book('pending'), metadataStatus: 'pending' }, { ...book('old'), metadataVersion: 0 }]);
    active.indexingErrors = [failure('failed')];
    const retry = await prepareIndexingRun(active, { mode: 'retry' });
    const calls = [];
    await indexPendingBooks(retry, { extract: async (item) => { calls.push(item.id); return metadata(); } });
    equal(calls, ['failed'], 'only unresolved failed selected');
    const completed = validateCompletedIndex(retry, active);
    equal(completed.books.slice(1), active.books.slice(1), 'unselected records preserved');
  });

  await test('empty full scan removes all old books while a failed scan cannot replace active', async () => {
    const active = library([book('removed')]);
    const snapshot = JSON.stringify(active);
    const empty = await prepareIndexingRun(active, { mode: 'full', scan: async () => library([]) });
    const stats = await indexPendingBooks(empty);
    updateBuildProgress(empty, stats);
    equal(validateCompletedIndex(empty, active).books, [], 'zero books is a completed full rebuild');
    let rejected = false;
    try { await prepareIndexingRun(active, { mode: 'full', scan: async () => { throw new Error('Drive unavailable'); } }); }
    catch { rejected = true; }
    assert(rejected, 'scan error stops run');
    equal(JSON.stringify(active), snapshot, 'scan failure retains active');
  });

  await test('retry download 404 leaves queue but cover-cache 404 remains a book failure', async () => {
    const active = library([book('gone'), book('cover')]);
    active.indexingErrors = active.books.map((item) => failure(item.id));
    const retry = await prepareIndexingRun(active, { mode: 'retry' });
    await indexPendingBooks(retry, { previousIndex: active, extract: async (item) => {
      if (item.id === 'gone') throw Object.assign(new Error('Deleted after preflight'), { status: 404, stage: 'download' });
      return metadata();
    }, onCover: async () => { throw Object.assign(new Error('Cover cache missing'), { status: 404 }); } });
    const completed = validateCompletedIndex(retry, active);
    equal(completed.books, [active.books[1]], 'preserved good record for cover error only');
    equal([...failedBookIds(completed)], ['cover'], '404 from cover storage does not remove the book');
  });

  await test('retry checks only target ancestry, removes deleted/outside files and caches shared ancestors', async () => {
    const active = library(['deleted', 'outside', 'inside1', 'inside2'].map(book));
    active.indexingErrors = active.books.map((item) => failure(item.id));
    const retry = await prepareIndexingRun(active, { mode: 'retry' });
    const calls = [];
    const getFile = async (id) => {
      calls.push(id);
      if (id === 'deleted') throw Object.assign(new Error('Gone'), { status: 404 });
      if (id === 'outside') return { id, name: 'outside.fb2', parents: ['elsewhere'] };
      if (id === 'elsewhere') return { id, name: 'Elsewhere', mimeType: 'application/vnd.google-apps.folder', parents: [] };
      if (id === 'nested') return { id, name: 'Nested', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] };
      return { id, name: `${id}.fb2`, parents: ['nested'] };
    };
    const extracted = [];
    const stats = await indexPendingBooks(retry, { checkEligibility: createRetryEligibilityCheck(retry, { getFile }),
      extract: async (item) => { extracted.push(item.id); return metadata(); } });
    updateBuildProgress(retry, stats);
    const completed = validateCompletedIndex(retry, active);
    equal([stats.excluded, stats.failed, failedBookIds(completed).size], [2, 0, 0], 'missing files no longer retried');
    equal(extracted.sort(), ['inside1', 'inside2'], 'only eligible target downloads');
    equal(calls.filter((id) => id === 'nested').length, 1, 'shared ancestor fetched once');
    equal(completed.books.map((item) => item.parentId), ['nested', 'nested'], 'current in-root location applied');
    equal(active.books.length, 4, 'active survives until commit');
  });
}

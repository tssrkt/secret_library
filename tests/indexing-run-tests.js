import { prepareIndexingRun, createRetryEligibilityCheck } from '../js/indexing-run.js';
import { validateCompletedIndex, updateBuildProgress, canResumeBuildingIndex } from '../js/index-build.js';
import { failedBookIds, metadataActionLabels } from '../js/indexing-state.js';
import { indexPendingBooks } from '../js/metadata-indexer.js';
import { searchBooks } from '../js/book-search.js';
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

  await test('full action count uses the current index when no full-scan record exists', () => {
    const active = library([book('one')]);
    delete active.lastFullScan;
    assert(metadataActionLabels(active).full.endsWith('(1)'), 'menu count comes from the current catalog even without a scan summary');
    assert(metadataActionLabels(active).retryHidden, 'nothing to retry');
  });

  await test('selective retry validates exact Drive IDs and leaves unselected records untouched', async () => {
    const active = library(['one', 'two', 'three'].map((id) => book(id)));
    active.indexingErrors = active.books.map((item) => failure(item.id));
    const snapshot = JSON.stringify(active);
    const building = await prepareIndexingRun(active, { mode: 'retry', selectedBookIds: ['two'] });
    equal([building.buildState.selectedIds, building.buildState.total], [['two'], 1], 'one source ID is selected');
    const called = [];
    const stats = await indexPendingBooks(building, { previousIndex: active,
      extract: async (item) => { called.push(item.id); return metadata(); } });
    updateBuildProgress(building, stats);
    const completed = validateCompletedIndex(building, active);
    equal(called, ['two'], 'no additional failed book reaches metadata processing');
    equal(completed.books.filter((item) => item.id !== 'two'), active.books.filter((item) => item.id !== 'two'),
      'unselected book records are unchanged');
    equal(completed.indexingErrors.filter((entry) => entry.fileId !== 'two'),
      active.indexingErrors.filter((entry) => entry.fileId !== 'two'), 'unselected journal entries are unchanged');
    equal([...failedBookIds(completed)].sort(), ['one', 'three'], 'only selected successful outcome is resolved');
    equal(JSON.stringify(active), snapshot, 'selective build does not mutate active index');

    const several = await prepareIndexingRun(active, { mode: 'retry', selectedBookIds: ['one', 'three'] });
    equal(several.buildState.selectedIds.sort(), ['one', 'three'], 'multiple source IDs are supported');
  });

  await test('selective retry rejects invalid IDs and a mismatched checkpoint without mutations', async () => {
    const active = library(['one', 'two'].map((id) => book(id)));
    active.indexingErrors = active.books.map((item) => failure(item.id));
    const snapshot = JSON.stringify(active);
    for (const ids of [['one', 'one'], ['unknown'], []]) {
      let error;
      try { await prepareIndexingRun(active, { mode: 'retry', selectedBookIds: ids }); } catch (caught) { error = caught; }
      assert(error?.code === 'invalid_retry_selection', `invalid selection rejected: ${JSON.stringify(ids)}`);
      equal(JSON.stringify(active), snapshot, 'invalid selection does not mutate active records or errors');
    }
    const duplicateActive = library([book('duplicate'), book('duplicate')]);
    duplicateActive.indexingErrors = [failure('duplicate')];
    let duplicateError;
    try { await prepareIndexingRun(duplicateActive, { mode: 'retry', selectedBookIds: ['duplicate'] }); }
    catch (caught) { duplicateError = caught; }
    assert(duplicateError?.code === 'invalid_retry_selection', 'ambiguous duplicate book IDs are rejected');
    equal(duplicateActive.books.length, 2, 'duplicate-ID validation leaves the index unchanged');

    active.indexingErrors = [failure('one')];
    const withoutFailureSnapshot = JSON.stringify(active);
    let error;
    try { await prepareIndexingRun(active, { mode: 'retry', selectedBookIds: ['two'] }); } catch (caught) { error = caught; }
    assert(error?.code === 'invalid_retry_selection', 'ID without current error is rejected');
    equal(JSON.stringify(active), withoutFailureSnapshot, 'non-failed selection rejection is side-effect free');

    const checkpoint = await prepareIndexingRun(active, { mode: 'retry', selectedBookIds: ['one'] });
    const checkpointSnapshot = JSON.stringify(checkpoint);
    error = null;
    try { await prepareIndexingRun(active, { mode: 'retry', building: checkpoint, selectedBookIds: ['two'] }); } catch (caught) { error = caught; }
    assert(error?.code === 'retry_checkpoint_mismatch', 'checkpoint with a different requested scope is refused');
    equal(JSON.stringify(checkpoint), checkpointSnapshot, 'mismatched checkpoint is not rewritten');
    assert(await prepareIndexingRun(active, { mode: 'retry', building: structuredClone(checkpoint) }),
      'saved subset checkpoint resumes its recorded scope after reload');
    for (const [name, mismatchedActive, mode, draft] of [
      ['different root', { ...active, rootFolderId: 'other' }, 'retry', checkpoint],
      ['different base index', { ...active, updatedAt: 'changed' }, 'retry', checkpoint],
      ['different operation mode', active, 'retry', await prepareIndexingRun(active, { mode: 'full', scan: async () => structuredClone(active) })],
    ]) {
      error = null;
      try { await prepareIndexingRun(mismatchedActive, { mode, building: structuredClone(draft), selectedBookIds: ['one'] }); }
      catch (caught) { error = caught; }
      assert(error?.code === 'retry_checkpoint_mismatch', `checkpoint is rejected for ${name}`);
    }
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

  await test('retry download 404 preserves the prior record and cover-cache 404 remains a book failure', async () => {
    const active = library([book('gone'), book('cover')].map((item) => ({ ...item, authors: ['Author'] })));
    active.indexingErrors = active.books.map((item) => failure(item.id));
    const retry = await prepareIndexingRun(active, { mode: 'retry' });
    await indexPendingBooks(retry, { previousIndex: active, extract: async (item) => {
      if (item.id === 'gone') throw Object.assign(new Error('Deleted after preflight'), { status: 404, stage: 'download' });
      return metadata();
    }, onCover: async () => { throw Object.assign(new Error('Cover cache missing'), { status: 404 }); } });
    const completed = validateCompletedIndex(retry, active);
    equal(completed.books.map((item) => item.id), ['gone', 'cover'], 'both prior records survive errors');
    equal(completed.books.map((item) => item.metadataStatus), ['ready', 'ready'], 'prior searchable metadata survives');
    equal([...failedBookIds(completed)], ['gone', 'cover'], 'download and cover 404s remain failures');
    equal(searchBooks(completed.books, { title: 'Book gone' }).map((item) => item.id), ['gone'], 'preserved record remains searchable by title');
    equal(searchBooks(completed.books, { author: 'Author' }).map((item) => item.id), ['gone', 'cover'], 'preserved records remain searchable by author');
  });

  await test('retry parse failure preserves ready metadata and temporary Drive failure keeps its record pending', async () => {
    const active = library([book('parse'), book('temporary')]);
    active.indexingErrors = active.books.map((item) => failure(item.id));
    const snapshot = JSON.stringify(active);
    const retry = await prepareIndexingRun(active, { mode: 'retry' });
    let paused = false;
    try {
      await indexPendingBooks(retry, { previousIndex: active, concurrency: 1, extract: async (item) => {
        if (item.id === 'parse') throw Object.assign(new Error('Malformed FB2'), { code: 'invalid_xml', stage: 'parse' });
        throw Object.assign(new Error('Drive temporarily unavailable'), { status: 503, retryable: true, stage: 'download' });
      } });
    } catch (error) { paused = error.retryable; }
    assert(paused, 'temporary Drive failure pauses the retry for later resumption');
    equal([retry.books[0].id, retry.books[0].metadataStatus, retry.books[0].title], ['parse', 'ready', 'Book parse'], 'parse failure restores the whole prior record');
    equal([retry.books[1].id, retry.books[1].metadataStatus, retry.books[1].title], ['temporary', 'pending', 'Book temporary'], 'temporary API failure retains ID and metadata');
    equal(JSON.stringify(active), snapshot, 'failed retry never mutates the active index');
  });

  await test('retry checks target ancestry, excludes confirmed ineligible files and caches shared ancestors', async () => {
    const active = library(['trashed', 'inside1', 'inside2'].map(book));
    active.indexingErrors = active.books.map((item) => failure(item.id));
    const retry = await prepareIndexingRun(active, { mode: 'retry' });
    const calls = [];
    const getFile = async (id) => {
      calls.push(id);
      if (id === 'trashed') return { id, name: `${id}.fb2`, parents: ['nested'], trashed: true };
      if (id === 'nested') return { id, name: 'Nested', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] };
      return { id, name: `${id}.fb2`, parents: ['nested'] };
    };
    const extracted = [];
    const stats = await indexPendingBooks(retry, { checkEligibility: createRetryEligibilityCheck(retry, { getFile }),
      extract: async (item) => { extracted.push(item.id); return metadata(); } });
    updateBuildProgress(retry, stats);
    const completed = validateCompletedIndex(retry, active);
    equal([stats.excluded, stats.failed, failedBookIds(completed).size], [1, 0, 0], 'confirmed trashed files are excluded while eligible files process normally');
    equal(extracted.sort(), ['inside1', 'inside2'], 'only eligible target downloads');
    equal(calls.filter((id) => id === 'nested').length, 1, 'shared ancestor fetched once');
    equal(completed.books.map((item) => item.id).sort(), ['inside1', 'inside2'], 'only positively excluded records are removed');
    equal(completed.books.find((item) => item.id === 'inside1').parentId, 'nested', 'current in-root location applied');
    equal(active.books.length, 3, 'active survives until commit');
    assert(metadataActionLabels(completed).full.endsWith('(2)'), 'menu count follows the current catalog after confirmed exclusions');
  });

  await test('uncertain eligibility API errors pause retry and preserve the last good entry', async () => {
    const active = library([book('uncertain')]);
    active.books[0].authors = ['Author'];
    active.indexingErrors = [failure('uncertain')];
    const retry = await prepareIndexingRun(active, { mode: 'retry' });
    let error;
    try { await indexPendingBooks(retry, { previousIndex: active,
      checkEligibility: createRetryEligibilityCheck(retry, { getFile: async () => {
        throw Object.assign(new Error('Drive response is ambiguous'), { status: 404, code: 'drive_error' });
      } }), extract: async () => { throw new Error('metadata processing must not start without eligibility'); },
    }); } catch (caught) { error = caught; }
    assert(error?.retryable && error.eligibilityUndetermined, 'ambiguous availability response pauses the build');
    equal([retry.books[0].id, retry.books[0].metadataStatus, retry.books[0].title,
      retry.buildState.removedBookIds, retry.buildState.pendingIds],
    ['uncertain', 'pending', 'Book uncertain', [], ['uncertain']], 'source ID and searchable metadata remain in the unfinished build');
    assert(retry.indexingErrors.at(-1)?.outcome === 'interrupted', 'eligibility uncertainty is recorded diagnostically');
    let rejected = false;
    try { validateCompletedIndex(retry, active); } catch { rejected = true; }
    assert(rejected, 'unresolved eligibility cannot be committed as complete');
  });

  await test('temporary parent-folder metadata failure also pauses without removing the book', async () => {
    const active = library([book('folder-error')]);
    active.indexingErrors = [failure('folder-error')];
    const retry = await prepareIndexingRun(active, { mode: 'retry' });
    let error;
    try { await indexPendingBooks(retry, { previousIndex: active,
      checkEligibility: createRetryEligibilityCheck(retry, { getFile: async (id) => {
        if (id === 'folder-error') return { id, name: 'folder-error.fb2', parents: ['folder'] };
        throw Object.assign(new Error('Parent lookup temporarily failed'), { status: 503, retryable: true });
      } }), extract: async () => { throw new Error('download must wait for a complete ancestry check'); },
    }); } catch (caught) { error = caught; }
    equal([Boolean(error?.eligibilityUndetermined), retry.books.map((item) => item.id),
      retry.books[0].metadataStatus, retry.buildState.removedBookIds, retry.buildState.pendingIds],
    [true, ['folder-error'], 'pending', [], ['folder-error']], 'failed parent lookup is indeterminate and resumable');
  });

  await test('retry removes only books with complete evidence of exclusion from the root', async () => {
    const folderMime = 'application/vnd.google-apps.folder';
    const scenarios = [
      ['missing file parents', { file: { id: 'item', name: 'item.fb2' } }, 'kept'],
      ['null file parents', { file: { id: 'item', name: 'item.fb2', parents: null } }, 'kept'],
      ['malformed file parents', { file: { id: 'item', name: 'item.fb2', parents: [null] } }, 'kept'],
      ['empty file parents', { file: { id: 'item', name: 'item.fb2', parents: [] } }, 'excluded'],
      ['multiple file parents', { file: { id: 'item', name: 'item.fb2', parents: ['root', 'elsewhere'] } }, 'kept'],
      ['missing parent-folder parents', { file: { id: 'item', name: 'item.fb2', parents: ['folder'] },
        folder: { id: 'folder', name: 'Folder', mimeType: folderMime } }, 'kept'],
      ['null parent-folder parents', { file: { id: 'item', name: 'item.fb2', parents: ['folder'] },
        folder: { id: 'folder', name: 'Folder', mimeType: folderMime, parents: null } }, 'kept'],
      ['parent object lacks explicit folder type', { file: { id: 'item', name: 'item.fb2', parents: ['folder'] },
        folder: { id: 'folder', name: 'Folder' } }, 'kept'],
      ['parent folder lacks a name', { file: { id: 'item', name: 'item.fb2', parents: ['folder'] },
        folder: { id: 'folder', mimeType: folderMime, parents: ['root'] } }, 'kept'],
      ['parent object contradicts folder type', { file: { id: 'item', name: 'item.fb2', parents: ['folder'] },
        folder: { id: 'folder', name: 'Folder', mimeType: 'application/pdf', parents: ['root'] } }, 'kept'],
      ['complete chain ends outside configured root', { file: { id: 'item', name: 'item.fb2', parents: ['folder'] },
        folder: { id: 'folder', name: 'Folder', mimeType: folderMime, parents: [] } }, 'excluded'],
      ['cyclic ancestry', { file: { id: 'item', name: 'item.fb2', parents: ['a'] },
        a: { id: 'a', name: 'A', mimeType: folderMime, parents: ['b'] },
        b: { id: 'b', name: 'B', mimeType: folderMime, parents: ['a'] } }, 'kept'],
      ['confirmed trashed file', { file: { id: 'item', name: 'item.fb2', parents: ['root'], trashed: true } }, 'excluded'],
      ['malformed trashed state', { file: { id: 'item', name: 'item.fb2', parents: ['root'], trashed: 'true' } }, 'kept'],
      ['confirmed trashed parent folder', { file: { id: 'item', name: 'item.fb2', parents: ['folder'] },
        folder: { id: 'folder', name: 'Folder', mimeType: folderMime, parents: ['root'], trashed: true } }, 'excluded'],
      ['mismatched file ID', { file: { id: 'different', name: 'item.fb2', parents: ['root'] } }, 'kept'],
      ['direct child of root', { file: { id: 'item', name: 'item.fb2', parents: ['root'] } }, 'eligible'],
    ];
    for (const [name, response, expected] of scenarios) {
      const active = library([book('item')]);
      active.indexingErrors = [failure('item')];
      const retry = await prepareIndexingRun(active, { mode: 'retry' });
      let stats; let paused = false;
      try { stats = await indexPendingBooks(retry, { previousIndex: active,
        checkEligibility: createRetryEligibilityCheck(retry, { getFile: async (id) => id === 'item' ? response.file : response[id] }),
        extract: async () => metadata(),
      }); } catch (error) { paused = Boolean(error.eligibilityUndetermined); }
      const outcome = paused ? 'kept' : retry.books.length === 0 ? 'excluded'
        : retry.books[0].metadataStatus === 'ready' && !failedBookIds(retry).has('item') ? 'eligible' : 'kept';
      equal([outcome, stats?.excluded || 0, retry.buildState.removedBookIds],
        [expected, expected === 'excluded' ? 1 : 0, expected === 'excluded' ? ['item'] : []],
        `${name}: only explicit, complete exclusion evidence removes the book`);
      if (paused) {
        equal([retry.books[0]?.id, retry.books[0]?.metadataStatus, retry.buildState.pendingIds],
          ['item', 'pending', ['item']], `${name}: uncertain ancestry remains in the unfinished build`);
        let rejected = false;
        try { validateCompletedIndex(retry, active); } catch { rejected = true; }
        assert(rejected, `${name}: incomplete eligibility cannot be committed`);
      }
    }
  });
}

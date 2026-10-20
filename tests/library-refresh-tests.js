import { preserveBookMetadata, scanLibrary } from '../js/library-tree.js';
import { createLibraryRefresher, scanStatus, scanFailureMessage } from '../js/library-refresh.js';
import { listFolderChildren } from '../js/drive.js';
import { restoreAuthSession, clearAccessToken } from '../js/auth.js';
import { INDEX_VERSION, METADATA_VERSION, FOLDER_MIME_TYPE } from '../js/config.js';
import { canResumeBuildingIndex, prepareBuildingIndex, previousRecord, validateCompletedIndex } from '../js/index-build.js';
import { indexPendingBooks } from '../js/metadata-indexer.js';
import { prepareIndexingRun, createRetryEligibilityCheck } from '../js/indexing-run.js';
import { extractBookMetadata } from '../js/book-metadata.js';
import { sharedLibraryIndex } from '../js/shared-library.js';
import { buildLibraryLookups } from '../js/library-view-model.js';
import { bookCardView } from '../js/book-card.js';
import { searchBooks } from '../js/book-search.js';
import { failedBookIds } from '../js/indexing-state.js';

const folder = (id, name = id) => ({ id, name, mimeType: FOLDER_MIME_TYPE });
const file = (id) => ({ id, name: `${id}.fb2`, size: '17', modifiedTime: 'same' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const scanTree = (tree, progress = () => {}) => scanLibrary('root', progress, {
  getRoot: async () => folder('root'), listChildren: async (id) => tree[id] || [],
});
const oldIndex = (count = 1) => ({ version: INDEX_VERSION, rootFolderId: 'root',
  folders: [{ id: 'root', parentId: null, name: 'Root' }, { id: 'A', parentId: 'root', name: 'A' }],
  books: Array.from({ length: count }, (_, i) => ({ id: String(i), parentId: 'A', fileName: `${i}.fb2`,
    sourceType: 'fb2', size: 17, modifiedTime: 'same', metadataStatus: 'ready', metadataVersion: METADATA_VERSION,
    title: `Title ${i}`, authors: ['Author'], coverFileId: `cover${i}` })),
});

export async function runLibraryRefreshTests(test, assert, equal, makeZip) {
  await test('incomplete or repeating Drive pages fail explicitly instead of publishing partial folders', async () => {
    const original = window.fetch;
    restoreAuthSession({ session: { getItem: () => JSON.stringify({ accessToken: 'test-only', expiresAt: Date.now() + 3600000 }) } });
    try {
      for (const [page, code, count] of [
        [{ files: [], incompleteSearch: true }, 'incomplete_folder_list', 1],
        [{ files: [], nextPageToken: 'same' }, 'repeated_page_token', 2],
        [{}, 'invalid_folder_response', 1],
      ]) {
        let calls = 0; let error;
        window.fetch = async () => { calls++; return new Response(JSON.stringify(page)); };
        try { await listFolderChildren('root'); } catch (caught) { error = caught; }
        equal([error.code, calls], [code, count], 'bounded explicit failure');
      }
    } finally { window.fetch = original; clearAccessToken(); }
  });
  await test('refresh moves 9257 unchanged books and applies same-count new structure without resetting metadata', async () => {
    const old = oldIndex(9257); let shown; let saved;
    const refresh = createLibraryRefresher({ scan: () => scanTree({ root: [folder('B')], B: old.books.map((b) => file(b.id)) }),
      apply: (index) => { shown = index; }, save: async (index) => { saved = index; return 'index'; },
      removeCovers: () => { throw new Error('unchanged covers must stay'); } });
    await refresh.run({ activeIndex: old, rootFolderId: 'root' });
    assert(shown === saved && shown.books.length === 9257, 'entire new structure published and saved');
    assert(shown.books.every((b) => b.parentId === 'B' && b.metadataStatus === 'ready' && b.title === `Title ${b.id}` && b.coverFileId === `cover${b.id}`), 'moves preserve metadata and cover');
    assert(old.books.every((b) => b.parentId === 'A'), 'old snapshot untouched');
  });
  await test('refresh reads renamed folders and new nesting from Drive', async () => {
    const index = await scanTree({ root: [folder('A', 'Renamed')], A: [folder('C')], C: [folder('B')], B: [file('0')] });
    equal(index.folders.map((f) => [f.id, f.parentId, f.name]), [['root', null, 'root'], ['A', 'root', 'Renamed'], ['C', 'A', 'C'], ['B', 'C', 'B']], 'fresh names and hierarchy');
    equal(index.books[0].parentId, 'B', 'book remains inside moved folder');
  });
  await test('slow folder does not hide sibling progress and heartbeat needs no animation frames', async () => {
    const gate = deferred(); const progress = []; const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0;
    try {
      const pending = scanLibrary('root', (s) => progress.push(s), { getRoot: async () => folder('root'), heartbeatMs: 5,
        listChildren: async (id) => id === 'root' ? [folder('A'), folder('B')] : id === 'A' ? gate.promise : [file('0')] });
      await tick();
      assert(progress.some((s) => s.processedFolders === 2 && s.books === 1 && s.queuedFolders === 1), 'fast sibling publishes before slow sibling');
      const count = progress.length; await tick(); assert(progress.length > count, 'heartbeat while request pending');
      gate.resolve([]); await pending;
      equal(progress.at(-1).queuedFolders, 0, 'queue drained');
      assert(scanStatus(progress.at(-1)).includes('В очереди: 0'), 'visible queue');
    } finally { gate.resolve([]); window.requestAnimationFrame = raf; }
  });
  for (const mode of ['temporary', 'body-timeout', 'fatal']) {
    await test(`folder list ${mode} uses bounded retries and preserves active index on failure`, async () => {
      const original = window.fetch; let calls = 0; const progress = []; const old = oldIndex(); let applied = 0; let saved = 0; let removed = 0;
      restoreAuthSession({ session: { getItem: () => JSON.stringify({ accessToken: 'test-only', expiresAt: Date.now() + 3600000 }) } });
      window.fetch = async (url, options) => {
        calls++;
        if (mode === 'body-timeout' && calls === 1) return { ok: true, json: () => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('Timeout', 'AbortError')), { once: true });
        }) };
        return mode === 'fatal' || (mode === 'temporary' && calls === 1)
          ? new Response('{}', { status: 503 }) : new Response('{"files":[]}');
      };
      const refresh = createLibraryRefresher({ scan: () => scanLibrary('root', (s) => progress.push(s), {
        getRoot: async () => folder('root', 'Library'), listChildren: (id, options) => listFolderChildren(id, {
          ...options, diagnostics: { ...options.diagnostics, timeoutMs: 20, sleep: async () => {} },
        }),
      }), apply: () => { applied++; }, save: async () => { saved++; return 'index'; }, removeCovers: async () => { removed++; } });
      try {
        if (mode === 'fatal') {
          let error; try { await refresh.run({ activeIndex: old, rootFolderId: 'root' }); } catch (caught) { error = caught; }
          equal([calls, applied, saved, removed, refresh.running], [3, 0, 0, 0, false], 'bounded failure, no publication or deletion, lock released');
          equal([error.stage, error.folderId, error.folderName, error.attempt, error.status], ['list', 'root', 'Library', 3, 503], 'folder diagnostics');
          assert(error.scanEvents.length === 3 && error.scanEvents.every((e) => e.timestamp && e.retryResult), 'all attempts recorded');
          assert(scanFailureMessage(error).includes('Library') && scanFailureMessage(error).includes('Старая версия'), 'actionable error');
          window.fetch = async () => new Response('{"files":[]}');
          await refresh.run({ activeIndex: old, rootFolderId: 'root' });
          equal(saved, 1, 'retry refresh available');
        } else {
          await refresh.run({ activeIndex: old, rootFolderId: 'root' });
          equal([calls, applied, saved], [2, 1, 1], 'retry succeeds');
          assert(progress.some((s) => s.retrying) && !progress.at(-1).retrying, 'retry status returns to normal');
        }
        equal(old.books[0].coverFileId, 'cover0', 'old snapshot preserved');
      } finally { window.fetch = original; clearAccessToken(); }
    });
  }
  await test('refresh ignores double start and defers cover cleanup until successful persistence', async () => {
    const scanning = deferred(); const saving = deferred(); const cleaning = deferred(); const order = []; let scans = 0;
    const refresh = createLibraryRefresher({ scan: async () => { scans++; await scanning.promise; return scanTree({ root: [] }); },
      apply: () => order.push('apply'), save: async () => { order.push('save'); await saving.promise; return 'index'; },
      removeCovers: async () => { order.push('cleanup'); await cleaning.promise; } });
    const args = { activeIndex: oldIndex(), rootFolderId: 'root' };
    const first = refresh.run(args);
    equal(await refresh.run(args), null, 'duplicate ignored'); equal(scans, 1, 'one traversal');
    scanning.resolve(); await tick(); equal(order, ['save'], 'new snapshot is persisted before publication');
    saving.resolve(); const result = await first;
    assert(!refresh.running, 'cleanup does not block refresh');
    equal(order, ['save', 'apply', 'cleanup'], 'publication and cleanup follow persisted index');
    cleaning.resolve(); await result.cleanup;
  });
  await test('failed refresh save does not publish a partial scan over the active index', async () => {
    const old = oldIndex(); let applied = null; let attempted = null;
    const refresh = createLibraryRefresher({
      scan: () => scanTree({ root: [folder('A')], A: [file('new-book')] }),
      apply: (index) => { applied = index; },
      save: async (index) => { attempted = index; throw new Error('save failed'); },
      removeCovers: async () => {},
    });
    let error;
    try { await refresh.run({ activeIndex: old, rootFolderId: 'root' }); } catch (caught) { error = caught; }
    assert(error && attempted.books.some((book) => book.id === 'new-book'), 'save attempted with the discovered Drive record');
    equal(applied, null, 'failed persistence leaves the in-memory active snapshot unchanged');
    assert(old.books.some((book) => book.id === '0' && book.metadataStatus === 'ready'), 'previous ready record remains active');
  });
  await test('refresh processing failure preserves prior ready metadata for a changed Drive file', async () => {
    const old = oldIndex(); old.books[0].genres = []; let active = old;
    const changed = { ...file('0'), modifiedTime: 'changed' };
    const refresh = createLibraryRefresher({
      scan: () => scanTree({ root: [folder('A')], A: [changed] }),
      apply: (index) => { active = index; },
      save: async () => 'index',
      removeCovers: async () => {},
    });
    await refresh.run({ activeIndex: old, rootFolderId: 'root' });
    const building = prepareBuildingIndex(active, { mode: 'refresh', previousIndex: old });
    await indexPendingBooks(building, {
      previousIndex: active,
      extract: async () => { throw Object.assign(new Error('Updated FB2 cannot be read yet'), { code: 'invalid_xml', stage: 'parse' }); },
    });
    const completed = validateCompletedIndex(building, active);
    const book = completed.books.find((item) => item.id === '0');
    equal([book.id, book.metadataStatus, book.title, book.authors, book.genres, book.modifiedTime],
      ['0', 'ready', 'Title 0', ['Author'], [], 'changed'], 'same Drive ID keeps old searchable metadata and current Drive version');
    equal([...completed.indexingErrors].map((entry) => entry.outcome), ['failed'], 'failed update remains reported as an error');

    const transientBuild = prepareBuildingIndex(active, { mode: 'refresh', previousIndex: old });
    let paused = false;
    try {
      await indexPendingBooks(transientBuild, { previousIndex: active,
        extract: async () => { throw Object.assign(new Error('Drive temporarily unavailable'), { status: 503, retryable: true }); } });
    } catch (error) { paused = Boolean(error.retryable); }
    const pending = transientBuild.books.find((item) => item.id === '0');
    assert(paused, 'temporary processing error remains a retryable interruption');
    equal([pending.id, pending.metadataStatus, pending.title, pending.authors, pending.modifiedTime],
      ['0', 'pending', 'Title 0', ['Author'], 'changed'], 'temporary error keeps prior metadata and the current Drive ID/version');
    let incompleteRejected = false;
    try { validateCompletedIndex(transientBuild, active); } catch { incompleteRejected = true; }
    assert(incompleteRejected, 'paused refresh cannot be committed as a complete index');

    const resumed = await prepareIndexingRun(active, { mode: 'refresh', building: structuredClone(transientBuild) });
    await indexPendingBooks(resumed, { extract: async () => {
      throw Object.assign(new Error('Updated FB2 still cannot be parsed'), { code: 'invalid_xml', stage: 'parse' });
    } });
    equal(validateCompletedIndex(resumed, active).books.find((item) => item.id === '0').title, 'Title 0',
      'refresh checkpoint retains the separate last-good metadata fallback');

    let refreshedAgain = null;
    const secondRefresh = createLibraryRefresher({
      scan: () => scanTree({ root: [folder('A')], A: [{ ...changed, modifiedTime: 'changed-again' }] }),
      apply: (index) => { refreshedAgain = index; }, save: async () => 'index', removeCovers: async () => {},
    });
    await secondRefresh.run({ activeIndex: completed, rootFolderId: 'root' });
    const afterSecondRefresh = refreshedAgain.books.find((item) => item.id === '0');
    equal([afterSecondRefresh.id, afterSecondRefresh.metadataStatus, afterSecondRefresh.title,
      afterSecondRefresh.authors, afterSecondRefresh.modifiedTime],
    ['0', 'pending', undefined, undefined, 'changed-again'], 'changed scan does not attach metadata to the previous file contents');
  });
  await test('legacy refresh checkpoint without previousBooks preserves metadata available in its active record only', async () => {
    const previous = oldIndex();
    previous.books[0].path = 'Root / A / 0.fb2';
    const scanned = await scanTree({ root: [folder('A')], A: [{ ...file('0'), name: 'renamed.fb2', size: '31', modifiedTime: 'changed' }] });
    const legacyActive = { ...scanned, books: scanned.books.map((source) => ({
      ...previousRecord(previous.books.find((book) => book.id === source.id), source), metadataStatus: 'pending',
    })) };
    const legacy = prepareBuildingIndex(legacyActive, { mode: 'refresh' });
    delete legacy.buildState.previousBooks;
    const checkpoint = JSON.parse(JSON.stringify(legacy));
    assert(!Object.hasOwn(checkpoint.buildState, 'previousBooks'), 'fixture matches checkpoint format before previousBooks');
    assert(canResumeBuildingIndex(checkpoint, legacyActive, { mode: 'refresh' }), 'legacy checkpoint remains resumable');
    const resumed = await prepareIndexingRun(legacyActive, { mode: 'refresh', building: checkpoint });
    try {
      await indexPendingBooks(resumed, { previousIndex: legacyActive, extract: async () => {
        throw Object.assign(new Error('Temporary ZIP read failure'), { status: 503, retryable: true });
      } });
    } catch (error) { assert(error.retryable, 'temporary failure remains an interruption'); }
    const retained = resumed.books.find((book) => book.id === '0');
    equal([retained.id, retained.modifiedTime, retained.fileName, retained.path, retained.title, retained.authors, retained.metadataStatus],
      ['0', 'changed', 'renamed.fb2', 'root / A / renamed.fb2', 'Title 0', ['Author'], 'pending'],
      'legacy active entry supplies old metadata while current source fields remain authoritative');
    let incompleteRejected = false;
    try { validateCompletedIndex(resumed, legacyActive); } catch { incompleteRejected = true; }
    assert(incompleteRejected, 'interrupted legacy checkpoint is not accepted as complete');

    const noMetadataActive = JSON.parse(JSON.stringify(legacyActive));
    for (const field of ['title', 'authors', 'genres', 'metadataVersion', 'entryPath']) delete noMetadataActive.books[0][field];
    const noMetadataBuild = prepareBuildingIndex(noMetadataActive, { mode: 'refresh' });
    const noMetadataCheckpoint = JSON.parse(JSON.stringify(noMetadataBuild));
    assert(!Object.hasOwn(noMetadataCheckpoint.buildState, 'previousBooks'), 'second fixture also uses legacy checkpoint format');
    assert(canResumeBuildingIndex(noMetadataCheckpoint, noMetadataActive, { mode: 'refresh' }), 'legacy checkpoint without old metadata remains resumable');
    const noMetadataResumed = await prepareIndexingRun(noMetadataActive, { mode: 'refresh', building: noMetadataCheckpoint });
    try {
      await indexPendingBooks(noMetadataResumed, { previousIndex: noMetadataActive, extract: async () => {
        throw Object.assign(new Error('Temporary ZIP read failure'), { status: 503, retryable: true });
      } });
    } catch (error) { assert(error.retryable, 'missing fallback does not hide the temporary error'); }
    const unavailable = noMetadataResumed.books[0];
    equal([unavailable.id, unavailable.modifiedTime, unavailable.fileName, unavailable.path,
      Object.hasOwn(unavailable, 'title'), unavailable.metadataStatus],
    ['0', 'changed', 'renamed.fb2', 'root / A / renamed.fb2', false, 'pending'],
    'absent metadata is neither invented nor reported as restored');
    incompleteRejected = false;
    try { validateCompletedIndex(noMetadataResumed, noMetadataActive); } catch { incompleteRejected = true; }
    assert(incompleteRejected, 'legacy checkpoint without a successful result remains incomplete');
  });
  await test('changed ZIP resumes from a temporary error and indexes the new local FB2 entry', async () => {
    assert(typeof makeZip === 'function', 'shared ZIP fixture builder is available');
    const encoder = new TextEncoder();
    const fb2 = (title, firstName, lastName) => encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
      <FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info>
      <book-title>${title}</book-title><author><first-name>${firstName}</first-name><last-name>${lastName}</last-name></author>
      </title-info></description><body><section><p>Local ZIP fixture content.</p></section></body></FictionBook>`);
    const oldZip = await makeZip([{ name: 'old/inside.fb2', bytes: fb2('Old ZIP Title', 'Old', 'Author') }]);
    const newZip = await makeZip([{ name: 'new/inside.fb2', bytes: fb2('New ZIP Title', 'New', 'Author') }]);
    const oldRequestedIds = [];
    const oldMetadata = await extractBookMetadata({ id: 'drive-zip-id', fileName: 'book.fb2.zip', sourceType: 'zip', size: oldZip.length }, {
      fetchRange: async (id, start, end) => {
        oldRequestedIds.push(id);
        return { bytes: oldZip.slice(start, end + 1), status: 206, isComplete: end + 1 >= oldZip.length };
      },
    });
    equal([oldMetadata.title, oldMetadata.authors, oldMetadata.entryPath],
      ['Old ZIP Title', ['Old Author'], 'old/inside.fb2'], 'old record is derived from parsing the old ZIP fixture');
    const old = oldIndex(0);
    old.books = [{ id: 'drive-zip-id', parentId: 'A', fileName: 'book.fb2.zip', sourceType: 'zip', extension: 'zip',
      path: 'Root / A / book.fb2.zip', size: oldZip.length, modifiedTime: 'old-version', ...oldMetadata,
      metadataStatus: 'ready', metadataVersion: METADATA_VERSION }];
    assert(oldRequestedIds.length > 0 && oldRequestedIds.every((id) => id === 'drive-zip-id'),
      'old ZIP fixture is also read only by its outer Drive ID');
    let refreshed;
    const refresh = createLibraryRefresher({
      scan: () => scanTree({ root: [folder('A')], A: [{ id: 'drive-zip-id', name: 'book.fb2.zip', mimeType: 'application/zip',
        size: String(newZip.length), modifiedTime: 'new-version' }] }),
      apply: (index) => { refreshed = index; }, save: async () => 'index', removeCovers: async () => {},
    });
    const result = await refresh.run({ activeIndex: old, rootFolderId: 'root' });
    const building = prepareBuildingIndex(refreshed, { mode: 'refresh', previousIndex: result.previousIndex });
    try {
      await indexPendingBooks(building, { previousIndex: refreshed, extract: async () => {
        throw Object.assign(new Error('Drive temporarily unavailable'), { status: 503, retryable: true });
      } });
    } catch (error) { assert(error.retryable, 'first ZIP attempt is interrupted by a temporary failure'); }
    const checkpoint = JSON.parse(JSON.stringify(building));
    const resumed = await prepareIndexingRun(refreshed, { mode: 'refresh', building: checkpoint });
    const requestedIds = [];
    await indexPendingBooks(resumed, { extract: (book) => extractBookMetadata(book, {
      fetchRange: async (id, start, end) => {
        requestedIds.push(id);
        return { bytes: newZip.slice(start, end + 1), status: 206, isComplete: end + 1 >= newZip.length };
      },
    }) });
    const completed = validateCompletedIndex(resumed, refreshed);
    const book = completed.books.find((item) => item.id === 'drive-zip-id');
    equal([book.id, book.modifiedTime, book.fileName, book.title, book.authors, book.entryPath, book.metadataStatus],
      ['drive-zip-id', 'new-version', 'book.fb2.zip', 'New ZIP Title', ['New Author'], 'new/inside.fb2', 'ready'],
      'successful retry indexes new ZIP metadata and inner path under the external Drive ID');
    assert(requestedIds.length > 0 && requestedIds.every((id) => id === 'drive-zip-id'),
      'ZIP byte requests use only the outer Drive ID, never a composite inner path');
    assert(!completed.indexingErrors.some((entry) => entry.fileId === 'drive-zip-id' && entry.outcome === 'failed'),
      'successful retry clears the temporary error outcome');
  });
  await test('new Drive books reach the catalog despite metadata errors and ambiguous retry 404s', async () => {
    const old = oldIndex(); old.books[0].genres = [];
    let active = null; let saved = null;
    const refresh = createLibraryRefresher({
      scan: () => scanTree({ root: [folder('A')], A: [file('0'), file('new-error'), file('new-good')] }),
      apply: (index) => { active = index; },
      save: async (index) => { saved = structuredClone(index); return 'index'; },
      removeCovers: async () => {},
    });
    await refresh.run({ activeIndex: old, rootFolderId: 'root' });
    assert(saved.books.some((book) => book.id === 'new-error' && book.metadataStatus === 'pending'),
      'new Drive file is persisted before metadata extraction');

    const building = prepareBuildingIndex(active, { mode: 'refresh' });
    await indexPendingBooks(building, { previousIndex: active, extract: async (book) => {
      if (book.id === 'new-error') throw Object.assign(new Error('Invalid FB2'), { code: 'invalid_xml', stage: 'parse' });
      return { title: 'New Good', authors: ['New Author'], genres: [] };
    } });
    const completed = validateCompletedIndex(building, active);
    equal(completed.books.map((book) => book.id).sort(), ['0', 'new-error', 'new-good'], 'scan additions survive completion');
    equal([completed.books.find((book) => book.id === 'new-error').metadataStatus,
      completed.books.find((book) => book.id === 'new-good').title], ['error', 'New Good'], 'metadata error is retained while successful metadata is indexed');
    equal(completed.books.find((book) => book.id === '0').title, 'Title 0', 'existing successful metadata survives refresh');
    const catalog = sharedLibraryIndex(completed, { sharing: { excludedFolderIds: [] } });
    equal(catalog.books.map((book) => book.id).sort(), ['0', 'new-error', 'new-good'], 'catalog projection includes new books with errors');
    const ownBooks = buildLibraryLookups(completed).booksByParent.get('A');
    assert(ownBooks.some((book) => book.id === 'new-error'), 'owner catalog keeps failed book in folder list');
    equal(bookCardView(ownBooks.find((book) => book.id === 'new-error')).title, 'new-error', 'failed book card uses its filename instead of hiding the entry');
    equal(searchBooks(ownBooks, { query: 'new-error' }).map((book) => book.id), ['new-error'], 'failed book remains searchable by filename');
    equal(searchBooks(ownBooks, { title: 'New Good', author: 'New Author' }).map((book) => book.id), ['new-good'], 'successful new metadata is searchable by title and author');

    const retry = await prepareIndexingRun(completed, { mode: 'retry' });
    await indexPendingBooks(retry, { previousIndex: completed, extract: async () => {
      throw Object.assign(new Error('Ambiguous Drive response'), { status: 404, stage: 'download' });
    } });
    const retried = validateCompletedIndex(retry, completed);
    equal(retried.books.map((book) => book.id).sort(), ['0', 'new-error', 'new-good'], 'ambiguous retry response does not remove books');
    equal(retried.books.find((book) => book.id === '0').title, 'Title 0', 'existing metadata remains intact after retry failure');
    equal(retry.buildState.removedBookIds, [], 'no removal without positive ineligibility evidence');

    const retryAgain = await prepareIndexingRun(retried, { mode: 'retry' });
    await indexPendingBooks(retryAgain, { previousIndex: retried, extract: async (book) => ({
      title: 'Recovered New Book', authors: ['Retry Author'], genres: [],
    }) });
    const recovered = validateCompletedIndex(retryAgain, retried);
    equal([recovered.books.map((book) => book.id).sort(), recovered.books.find((book) => book.id === 'new-error').metadataStatus,
      searchBooks(recovered.books, { title: 'Recovered New Book', author: 'Retry Author' }).map((book) => book.id),
      failedBookIds(recovered).has('new-error')],
    [['0', 'new-error', 'new-good'], 'ready', ['new-error'], false], 'successful retry restores search and clears its failure while retaining all books');
  });
  await test('new book with metadata failure survives retry when Drive omits parent metadata', async () => {
    const scanned = await scanTree({ root: [folder('A')], A: [file('new-book')] });
    const active = preserveBookMetadata(scanned, oldIndex(0));
    const firstRun = prepareBuildingIndex(active, { mode: 'refresh' });
    await indexPendingBooks(firstRun, { previousIndex: active, extract: async () => {
      throw Object.assign(new Error('FB2 parse failed'), { code: 'invalid_xml', stage: 'parse' });
    } });
    const errored = validateCompletedIndex(firstRun, active);
    equal([errored.books.map((book) => book.id), errored.books[0]?.metadataStatus,
      failedBookIds(errored).has('new-book')], [['new-book'], 'error', true],
    'discovered new book is kept as a retryable catalog entry after parsing fails');

    const retry = await prepareIndexingRun(errored, { mode: 'retry' });
    const stats = await indexPendingBooks(retry, { previousIndex: errored,
      checkEligibility: createRetryEligibilityCheck(retry, { getFile: async () => ({ id: 'new-book', name: 'new-book.fb2' }) }),
      extract: async () => { throw new Error('must not download before eligibility metadata is complete'); },
    });
    const retried = validateCompletedIndex(retry, errored);
    equal([stats.excluded, retry.buildState.removedBookIds, retried.books.map((book) => book.id),
      retried.books[0]?.metadataStatus, failedBookIds(retried).has('new-book')],
    [0, [], ['new-book'], 'error', true],
    'incomplete ancestry is an indexing error, not confirmation that the scanned book was removed');
  });
  await test('scanned per-file resource key reaches Drive download and new book catalog entry', async () => {
    const originalFetch = window.fetch;
    restoreAuthSession({ session: { getItem: () => JSON.stringify({ accessToken: 'test-only', expiresAt: Date.now() + 3600000 }) } });
    const headers = []; let listing = 0;
    const fb2 = `<?xml version="1.0"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>Resource Key Book</book-title><author><first-name>Test Author</first-name></author></title-info></description><body><section><p>Readable test book content.</p></section></body></FictionBook>`;
    window.fetch = async (url, options) => {
      headers.push(options.headers['X-Goog-Drive-Resource-Keys'] || '');
      if (String(url).includes('/files?')) {
        listing++;
        return new Response(JSON.stringify({ files: listing === 1
          ? [{ id: 'A', name: 'A', mimeType: FOLDER_MIME_TYPE, resourceKey: 'folder-key' }]
          : [{ id: 'new-secure', name: 'new-secure.fb2', size: '17', modifiedTime: 'same', resourceKey: 'resource-token' }] }));
      }
      return new Response(new Blob([fb2]), { status: 200 });
    };
    try {
      const scanned = await scanLibrary('root', () => {}, { getRoot: async () => folder('root'),
        listChildren: (id, options) => listFolderChildren(id, options) });
      equal(scanned.books.map((book) => [book.id, book.resourceKey]), [['new-secure', 'resource-token']], 'scan retains the Drive resource key');
      const active = { ...oldIndex(0), folders: scanned.folders, books: scanned.books };
      const building = prepareBuildingIndex(active, { mode: 'incremental' });
      await indexPendingBooks(building, { previousIndex: active, onCover: async () => ({}) });
      const completed = validateCompletedIndex(building, active);
      const book = completed.books.find((item) => item.id === 'new-secure');
      equal([book.metadataStatus, book.title, book.authors], ['ready', 'Resource Key Book', ['Test Author']], 'new supported file is indexed from its authorized content');
      equal(headers, ['', 'A/folder-key', 'new-secure/resource-token'], 'nested folder listing and metadata download send their target resource keys');
      equal(buildLibraryLookups(completed).booksByParent.get('A').map((item) => item.id), ['new-secure'], 'successfully indexed book appears in the owner catalog');
      equal(sharedLibraryIndex(completed, { sharing: { excludedFolderIds: [] } }).books.map((item) => item.id), ['new-secure'], 'successfully indexed book appears in the shared catalog projection');
    } finally { window.fetch = originalFetch; clearAccessToken(); }
  });
  await test('retry eligibility reuses indexed resource keys for the file and its parent folders', async () => {
    const book = { ...file('secured'), parentId: 'A', resourceKey: 'file-key', metadataStatus: 'error' };
    const index = { rootFolderId: 'root', folders: [{ id: 'A', parentId: 'root', name: 'A', resourceKey: 'folder-key' }], books: [book] };
    const calls = [];
    const check = createRetryEligibilityCheck(index, { getFile: async (id, _signal, key) => {
      calls.push([id, key]);
      return id === 'secured'
        ? { id, name: 'secured.fb2', mimeType: 'application/fb2', parents: ['A'], resourceKey: 'file-key' }
        : { id: 'A', name: 'A', mimeType: FOLDER_MIME_TYPE, parents: ['root'], resourceKey: 'folder-key' };
    } });
    assert(await check(book), 'book remains eligible after positive Drive metadata');
    equal(calls, [['secured', 'file-key'], ['A', 'folder-key']], 'eligibility requests use the keys discovered during scan');
    equal(book.resourceKey, 'file-key', 'refresh retains the file key for a later content retry');
  });
  await test('failed index save keeps old covers intact', async () => {
    let removed = false;
    const refresh = createLibraryRefresher({ scan: () => scanTree({ root: [] }), apply: () => {},
      save: async () => { throw new Error('save failed'); }, removeCovers: () => { removed = true; } });
    try { await refresh.run({ activeIndex: oldIndex(), rootFolderId: 'root' }); } catch {}
    assert(!removed && !refresh.running, 'no cache removal and unlocked');
  });
}

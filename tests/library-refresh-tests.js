import { scanLibrary } from '../js/library-tree.js';
import { createLibraryRefresher, scanStatus, scanFailureMessage } from '../js/library-refresh.js';
import { listFolderChildren } from '../js/drive.js';
import { restoreAuthSession, clearAccessToken } from '../js/auth.js';
import { INDEX_VERSION, METADATA_VERSION, FOLDER_MIME_TYPE } from '../js/config.js';

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

export async function runLibraryRefreshTests(test, assert, equal) {
  await test('incomplete or repeating Drive pages fail explicitly instead of publishing partial folders', async () => {
    const original = window.fetch;
    restoreAuthSession({ session: { getItem: () => JSON.stringify({ accessToken: 'test-only', expiresAt: Date.now() + 60000 }) } });
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
      restoreAuthSession({ session: { getItem: () => JSON.stringify({ accessToken: 'test-only', expiresAt: Date.now() + 60000 }) } });
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
    scanning.resolve(); await tick(); equal(order, ['apply', 'save'], 'no early deletion');
    saving.resolve(); const result = await first;
    assert(!refresh.running, 'cleanup does not block refresh');
    equal(order, ['apply', 'save', 'cleanup'], 'cleanup follows persisted index');
    cleaning.resolve(); await result.cleanup;
  });
  await test('failed index save keeps old covers intact', async () => {
    let removed = false;
    const refresh = createLibraryRefresher({ scan: () => scanTree({ root: [] }), apply: () => {},
      save: async () => { throw new Error('save failed'); }, removeCovers: () => { removed = true; } });
    try { await refresh.run({ activeIndex: oldIndex(), rootFolderId: 'root' }); } catch {}
    assert(!removed && !refresh.running, 'no cache removal and unlocked');
  });
}

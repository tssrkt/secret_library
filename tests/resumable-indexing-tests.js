import { initializeAuth, requestAccessToken, restoreAuthSession, clearAccessToken, getAccessToken } from '../js/auth.js';
import { driveFetch, downloadDriveFile } from '../js/drive.js';
import { prepareBuildingIndex, canResumeBuildingIndex, updateBuildProgress } from '../js/index-build.js';
import { indexPendingBooks } from '../js/metadata-indexer.js';
import { checkpointKey, saveCheckpoint, loadCheckpoint, deleteCheckpoint, commitCheckpoint } from '../js/indexing-checkpoint.js';
import { INDEX_VERSION, METADATA_VERSION } from '../js/config.js';

const metadata = () => ({ title: 'Indexed', authors: [], genres: [] });
const library = (count, pending = count) => ({ version: INDEX_VERSION, rootFolderId: 'resume-test', updatedAt: 'base', folders: [],
  books: Array.from({ length: count }, (_, i) => ({ id: String(i), fileName: `${i}.fb2`, sourceType: 'fb2',
    metadataStatus: i < pending ? 'pending' : 'ready', metadataVersion: METADATA_VERSION, ...metadata() })) });

async function withGoogle(run) {
  const oldGoogle = window.google;
  const oldFetch = window.fetch;
  const requests = [];
  let deny = false;
  const client = { requestAccessToken(options) {
    requests.push(options);
    queueMicrotask(() => deny ? client.error_callback({ type: 'popup_failed_to_open' })
      : client.callback({ access_token: 'renewed', expires_in: 3600 }));
  } };
  window.google = { accounts: { oauth2: { initTokenClient: () => client } } };
  await initializeAuth();
  restoreAuthSession({ session: { getItem: () => JSON.stringify({ accessToken: 'old', expiresAt: Date.now() + 3600000,
    user: { emailAddress: 'checkpoint@example.com' } }) } });
  try { await run({ requests, deny: (value) => { deny = value; } }); }
  finally { clearAccessToken(); window.google = oldGoogle; window.fetch = oldFetch; }
}

export async function runResumableIndexingTests(test, assert, equal) {
  await test('near-expiry access token is renewed before the next Drive request', () => withGoogle(async ({ requests }) => {
    restoreAuthSession({ session: { getItem: () => JSON.stringify({ accessToken: 'near-expiry', expiresAt: Date.now() + 30000 }) } });
    const tokens = [];
    window.fetch = async (url, options) => { tokens.push(options.headers.Authorization); return new Response('{}'); };
    await driveFetch('/files/proactive');
    equal([requests.length, requests[0].prompt, tokens], [1, '', ['Bearer renewed']], 'renewal precedes Drive request');
  }));
  await test('network interruption after HTTP headers keeps the book pending and commits the batch', async () => {
    const index = prepareBuildingIndex(library(2), { mode: 'refresh' });
    let checkpointed = false;
    let paused = false;
    try {
      await indexPendingBooks(index, { concurrency: 1,
        extract: async () => downloadDriveFile('stream', undefined, async () => ({ blob: async () => { throw new TypeError('connection lost'); } })),
        onLocalCheckpoint: async () => { checkpointed = true; },
      });
    } catch (error) { paused = error.retryable; }
    assert(paused && checkpointed, 'stream error pauses after durable callback');
    equal(index.books.map((book) => book.metadataStatus), ['pending', 'pending'], 'interrupted download stays in remaining queue');
  });
  await test('401 during parallel indexing renews once with empty prompt and retries original requests', () => withGoogle(async ({ requests }) => {
    const headers = [];
    window.fetch = async (url, options) => {
      headers.push(options.headers.Authorization);
      return new Response('{}', { status: options.headers.Authorization === 'Bearer old' ? 401 : 200 });
    };
    const index = prepareBuildingIndex(library(3), { mode: 'refresh' });
    const stats = await indexPendingBooks(index, { extract: async (book) => { await driveFetch(`/files/${book.id}`); return metadata(); } });
    equal([stats.succeeded, requests.length, headers.length, getAccessToken()], [3, 1, 6, 'renewed'], 'queue continues and session remains connected');
    equal(requests[0], { prompt: '', login_hint: 'checkpoint@example.com' }, 'no forced consent or account selector');
  }));

  await test('403 permission denial does not request a token; repeated 401 retries only once', () => withGoogle(async ({ requests }) => {
    let calls = 0;
    window.fetch = async () => { calls++; return new Response('{}', { status: 403 }); };
    try { await driveFetch('/files/denied'); } catch (error) { equal(error.status, 403, 'permission error'); }
    equal([calls, requests.length], [1, 0], '403 is not logout');
    window.fetch = async () => { calls++; return new Response('{}', { status: 401 }); };
    try { await driveFetch('/files/expired'); } catch (error) { equal(error.status, 401, 'auth still unavailable'); }
    equal([calls, requests.length], [3, 1], 'single replay');
  }));

  await test('failed automatic renewal checkpoints successful batch and reconnect processes only remaining files', () => withGoogle(async ({ deny }) => {
    const active = library(6);
    const index = prepareBuildingIndex(active, { mode: 'refresh' });
    const key = checkpointKey('auth-test', active.rootFolderId);
    await saveCheckpoint(key, index);
    deny(true);
    window.fetch = async (url) => new Response('{}', { status: url.includes('/files/0') ? 200 : 401 });
    let paused = false;
    try {
      await indexPendingBooks(index, { concurrency: 3,
        extract: async (book) => { await driveFetch(`/files/${book.id}`); return metadata(); },
        onLocalCheckpoint: async (value, progress, ids) => { updateBuildProgress(value, progress); await saveCheckpoint(key, value, ids); },
      });
    } catch (error) {
      paused = error.status === 401;
      index.buildState.status = 'paused';
      await saveCheckpoint(key, index);
    }
    assert(paused, 'interaction-required pauses');
    const restored = await loadCheckpoint(key);
    equal([restored.buildState.progress.processed, restored.books.filter((book) => book.metadataStatus === 'pending').length], [1, 5], 'partial batch safely stored');
    assert(canResumeBuildingIndex(restored, active, { mode: 'refresh' }), 'paused checkpoint is compatible');
    deny(false);
    await requestAccessToken({ prompt: '' });
    window.fetch = async () => new Response('{}');
    const ids = [];
    await indexPendingBooks(restored, { extract: async (book) => { ids.push(book.id); await driveFetch(`/files/${book.id}`); return metadata(); } });
    equal(ids, ['1', '2', '3', '4', '5'], 'successful file never repeated');
    await deleteCheckpoint(key);
  }));

  await test('9336 books select 1535 for refresh, persist 1000, reload and process exactly 535; full selects all', async () => {
    const active = library(9336, 1535);
    const index = prepareBuildingIndex(active, { mode: 'refresh' });
    equal(index.buildState.total, 1535, 'only new/changed queue');
    const key = checkpointKey('reload-test', active.rootFolderId);
    await saveCheckpoint(key, index);
    const controller = new AbortController();
    await indexPendingBooks(index, { concurrency: 5, signal: controller.signal, extract: async () => metadata(),
      onLocalCheckpoint: async (value, stats, ids) => {
        updateBuildProgress(value, stats);
        await saveCheckpoint(key, value, ids);
        if (stats.processed === 1000) controller.abort();
      },
    });
    const restored = await loadCheckpoint(key);
    equal(restored.buildState.progress.processed, 1000, 'committed progress');
    equal([restored.buildState.processedIds.length, restored.buildState.pendingIds.length], [1000, 535], 'durable completed and remaining file IDs');
    let calls = 0;
    await indexPendingBooks(restored, { extract: async () => { calls++; return metadata(); } });
    equal(calls, 535, 'reload resumes remainder');
    equal(await loadCheckpoint(checkpointKey('another-user', active.rootFolderId)), undefined, 'owner isolation');
    assert(!canResumeBuildingIndex(restored, { ...active, updatedAt: 'different' }, { mode: 'refresh' }), 'stale base rejected');
    const full = prepareBuildingIndex(active, { mode: 'full', scannedIndex: structuredClone(active) });
    calls = 0;
    await indexPendingBooks(full, { extract: async () => { calls++; return metadata(); } });
    equal(calls, 9336, 'full action processes entire library');
    await deleteCheckpoint(key);
  });

  await test('final checkpoint deletion requires successful save and identical read-back', async () => {
    const key = checkpointKey('commit-test', 'root');
    const index = library(2);
    for (const failure of ['upload', 'read', 'mismatch', null]) {
      await saveCheckpoint(key, index);
      try {
        await commitCheckpoint(index, {
          save: async () => { if (failure === 'upload') throw new Error('offline'); return 'saved'; },
          read: async () => { if (failure === 'read') throw new Error('offline'); return failure === 'mismatch' ? {} : structuredClone(index); },
          remove: () => deleteCheckpoint(key),
        });
        assert(!failure, 'failure must reject');
      } catch (error) { assert(Boolean(failure), error.message); }
      equal(Boolean(await loadCheckpoint(key)), Boolean(failure), 'checkpoint lifetime follows verified commit');
    }
  });
}

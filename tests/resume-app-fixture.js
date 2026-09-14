// Runs the real app against a deterministic Drive/GIS boundary, including reload.
import { ROOT_FOLDER_ID, INDEX_VERSION, METADATA_VERSION } from '../js/config.js';
import { prepareBuildingIndex, updateBuildProgress } from '../js/index-build.js';
import { checkpointKey, saveCheckpoint, loadCheckpoint } from '../js/indexing-checkpoint.js';
import { AUTH_SESSION_KEY } from '../js/auth.js';
import { social } from '../js/social-runtime.js';

social.connect = async () => {};
const owner = 'app-resume@example.com';
const key = checkpointKey(owner, ROOT_FOLDER_ID);
const active = { version: INDEX_VERSION, rootFolderId: ROOT_FOLDER_ID, updatedAt: 'app-base',
  folders: [{ id: ROOT_FOLDER_ID, parentId: null, name: 'Library' }],
  books: Array.from({ length: 6 }, (_, i) => ({ id: `book${i}`, parentId: ROOT_FOLDER_ID,
    fileName: `book${i}.fb2`, sourceType: 'fb2', extension: 'fb2', metadataStatus: 'pending', size: 100 })) };
if (!sessionStorage.getItem('resume-fixture-started')) {
  const draft = prepareBuildingIndex(active, { mode: 'refresh' });
  for (const book of draft.books.slice(0, 3)) Object.assign(book, { metadataStatus: 'ready', metadataVersion: METADATA_VERSION,
    title: 'Already indexed', authors: [], genres: [] });
  draft.buildState.processedIds = draft.books.slice(0, 3).map((book) => book.id);
  updateBuildProgress(draft, { processed: 3, succeeded: 3, failed: 0 });
  await saveCheckpoint(key, draft);
  sessionStorage.setItem('resume-fixture-started', '1');
}
sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({ accessToken: 'fixture-old', expiresAt: Date.now() + 3600000,
  user: { emailAddress: owner } }));
const state = window.resumeFixture = { deny: true, requests: [], downloads: [], checkpoint: () => loadCheckpoint(key) };
const client = { requestAccessToken(options) {
  state.requests.push(options);
  queueMicrotask(() => state.deny ? client.error_callback({ type: 'popup_failed_to_open' })
    : client.callback({ access_token: 'fixture-renewed', expires_in: 3600 }));
} };
window.google = { accounts: { oauth2: { initTokenClient: () => client } } };
const files = new Map([['active-index', active]]);
const realFetch = window.fetch;
window.fetch = async (input, options = {}) => {
  const url = new URL(input, location.href);
  if (url.hostname !== 'www.googleapis.com') return realFetch(input, options);
  const json = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  if (url.pathname.endsWith('/about')) return json({ user: { emailAddress: owner, displayName: 'Resume user' } });
  const id = url.pathname.match(/\/files\/([^/]+)/)?.[1];
  if (options.method === 'DELETE') { files.delete(id); return new Response(null, { status: 204 }); }
  if (options.method === 'PATCH') { files.set(id, JSON.parse(options.body)); return json({ id }); }
  if (options.method === 'POST') {
    const body = String(options.body).split('Content-Type: application/json\r\n\r\n')[1].split('\r\n--')[0];
    files.set('building-index', JSON.parse(body));
    return json({ id: 'building-index' });
  }
  if (id?.startsWith('book')) {
    state.downloads.push(id);
    if (options.headers.Authorization === 'Bearer fixture-old') return new Response('{}', { status: 401 });
    return new Response('<FictionBook><description><title-info><book-title>Resumed</book-title></title-info></description></FictionBook>');
  }
  if (id && files.has(id)) return json(files.get(id));
  const query = url.searchParams.get('q') || '';
  if (query.includes("name = 'secret-library-index.json'")) return json({ files: [{ id: 'active-index' }] });
  return json({ files: [] });
};
await import('../js/app.js');
state.ready = true;

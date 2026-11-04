import { downloadAppDataBlob } from './drive.js';

// A read-only projection; the owner's complete Drive index remains authoritative.
export function sharedLibraryIndex(index, settings) {
  const excluded = new Set(settings.sharing.excludedFolderIds);
  const allowed = new Set(index.folders.filter((folder) => folder.parentId === index.rootFolderId && !excluded.has(folder.id)).map((folder) => folder.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of index.folders) if (!allowed.has(folder.id) && allowed.has(folder.parentId)) { allowed.add(folder.id); changed = true; }
  }
  const fields = ['id', 'parentId', 'fileName', 'extension', 'sourceType', 'size', 'modifiedTime', 'metadataStatus',
    'metadataVersion', 'title', 'authors', 'genres', 'series', 'seriesNumber', 'annotation', 'preview', 'language', 'resourceKey'];
  const folderNotes = Object.fromEntries(Object.entries(settings.folderNotes || {})
    .filter(([folderId, note]) => allowed.has(folderId) && typeof note === 'string' && note.trim())
    .map(([folderId, note]) => [folderId, note.trim()]));
  return { version: index.version, rootFolderId: index.rootFolderId, updatedAt: index.updatedAt || '', folderNotes,
    folders: index.folders.filter((folder) => folder.id === index.rootFolderId || allowed.has(folder.id))
      .map(({ id, parentId, name }) => ({ id, parentId, name })),
    books: index.books.filter((book) => book.parentId === index.rootFolderId || allowed.has(book.parentId))
      .map((book) => Object.fromEntries(fields.filter((field) => book[field] !== undefined).map((field) => [field, book[field]]))) };
}

export async function sharedLibraryPayload(index, settings) {
  const json = JSON.stringify(sharedLibraryIndex(index, settings));
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  const signature = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const chunks = [];
  // At most 600 kB UTF-8 per document, below Firestore's 1 MiB limit.
  for (let offset = 0; offset < json.length;) {
    let end = Math.min(json.length, offset + 150000);
    if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1])) end--;
    chunks.push(json.slice(offset, end)); offset = end;
  }
  return { signature, chunks };
}

async function coverSourceKey(book) {
  const bytes = new TextEncoder().encode(`${book.coverFileId}:${book.modifiedTime || ''}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBlob(value, mimeType) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export function createSharedLibraryStore({ db, sdk, user, downloadCover = downloadAppDataBlob }) {
  const manifest = (owner) => sdk.doc(db, 'sharedLibraries', owner);
  const chunks = (owner, revision) => sdk.collection(db, 'sharedLibraries', owner, 'versions', revision, 'chunks');
  const covers = (owner) => sdk.collection(db, 'sharedLibraries', owner, 'covers');
  const coverRef = (owner, bookId) => sdk.doc(db, 'sharedLibraries', owner, 'covers', bookId);
  async function syncCovers(index, projection, oldSignature) {
    const visibleIds = new Set(projection.books.map((book) => book.id));
    const books = index.books.filter((book) => visibleIds.has(book.id) && book.coverFileId);
    const sources = await Promise.all(books.map(async (book) => ({ book, sourceKey: await coverSourceKey(book) })));
    const digestInput = sources.map(({ book, sourceKey }) => `${book.id}:${sourceKey}`).sort().join('|');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(digestInput));
    const signature = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (signature === oldSignature || (!sources.length && !oldSignature)) return signature;
    const existingSnapshot = await sdk.getDocsFromServer(covers(user.uid));
    const existing = new Map(existingSnapshot.docs.map((doc) => [doc.id, doc.data()]));
    const currentIds = new Set(sources.map(({ book }) => book.id));
    for (const id of existing.keys()) if (!currentIds.has(id)) await sdk.deleteDoc(coverRef(user.uid, id));
    let cursor = 0;
    const worker = async () => {
      while (cursor < sources.length) {
        const item = sources[cursor++];
        ensureCurrent();
        if (existing.get(item.book.id)?.sourceKey === item.sourceKey) continue;
        const blob = await downloadCover(item.book.coverFileId);
        const data = await blobToBase64(blob);
        if (data.length > 800000) throw new Error(`╨Ю╨▒╨╗╨╛╨╢╨║╨░ ╨║╨╜╨╕╨│╨╕ ┬л${item.book.title || item.book.fileName || item.book.id}┬╗ ╤Б╨╗╨╕╤И╨║╨╛╨╝ ╨▓╨╡╨╗╨╕╨║╨░ ╨┤╨╗╤П ╨▒╨╡╤Б╨┐╨╗╨░╤В╨╜╨╛╨│╨╛ ╤Е╤А╨░╨╜╨╕╨╗╨╕╤Й╨░ Firebase.`);
        ensureCurrent();
        await sdk.setDoc(coverRef(user.uid, item.book.id), { sourceKey: item.sourceKey, mimeType: 'image/webp', data });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, worker));
    return signature;
  }
  let queue = Promise.resolve();
  let disposed = false;
  const ensureCurrent = () => { if (disposed) throw new Error('╨б╨╡╨░╨╜╤Б ╨╖╨░╨▓╨╡╤А╤И╤С╨╜.'); };
  return {
    dispose() { disposed = true; },
    unpublish() {
      queue = queue.catch(() => {}).then(async () => {
        ensureCurrent();
        await sdk.deleteDoc(manifest(user.uid));
        const snapshot = await sdk.getDocsFromServer(covers(user.uid));
        for (let start = 0; start < snapshot.docs.length; start += 100) {
          ensureCurrent();
          const batch = sdk.writeBatch(db);
          snapshot.docs.slice(start, start + 100).forEach((doc) => batch.delete(doc.ref));
          await batch.commit();
        }
      });
      return queue;
    },
    watchManifest(owner, next, error) {
      return sdk.onSnapshot(manifest(owner), { includeMetadataChanges: true }, (snapshot) => {
        if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) next(snapshot.exists() ? snapshot.data() : null);
      }, error);
    },
    publish(index, settings) {
      const task = async () => {
        ensureCurrent();
        const projection = sharedLibraryIndex(index, settings);
        const payload = await sharedLibraryPayload(index, settings);
        const before = await sdk.getDocFromServer(manifest(user.uid));
        const previous = before.exists() ? before.data() : {};
        const coversSignature = await syncCovers(index, projection, previous.coversSignature || '');
        if (before.exists() && previous.signature === payload.signature) {
          if (previous.coversSignature !== coversSignature) {
            await sdk.setDoc(manifest(user.uid), { ...previous, coversSignature });
          }
          return;
        }
        const revision = crypto.randomUUID();
        for (let start = 0; start < payload.chunks.length; start += 10) {
          const batch = sdk.writeBatch(db);
          payload.chunks.slice(start, start + 10).forEach((json, offset) => batch.set(sdk.doc(chunks(user.uid, revision), String(start + offset)), { position: start + offset, json }));
          await batch.commit();
        }
        ensureCurrent();
        await sdk.setDoc(manifest(user.uid), { revision, signature: payload.signature, chunkCount: payload.chunks.length, coversSignature });
        if (before.exists()) {
          const old = await sdk.getDocsFromServer(chunks(user.uid, before.data().revision));
          for (let start = 0; start < old.docs.length; start += 100) {
            const batch = sdk.writeBatch(db);
            old.docs.slice(start, start + 100).forEach((doc) => batch.delete(doc.ref));
            await batch.commit();
          }
        }
      };
      queue = queue.catch(() => {}).then(task);
      return queue;
    },
    async loadCover(owner, bookId) {
      ensureCurrent();
      if (!owner || !bookId) return null;
      const snapshot = await sdk.getDocFromServer(coverRef(owner, bookId));
      if (!snapshot.exists()) return null;
      const cover = snapshot.data();
      if (typeof cover.data !== 'string' || cover.mimeType !== 'image/webp') return null;
      return base64ToBlob(cover.data, cover.mimeType);
    },
    async load(owner, expected) {
      const before = await sdk.getDocFromServer(manifest(owner));
      if (!before.exists()) throw new Error('╨С╨╕╨▒╨╗╨╕╨╛╤В╨╡╨║╨░ ╨╜╨╡╨┤╨╛╤Б╤В╤Г╨┐╨╜╨░.');
      const header = before.data();
      if (expected && header.revision !== expected) throw new Error('╨С╨╕╨▒╨╗╨╕╨╛╤В╨╡╨║╨░ ╨╛╨▒╨╜╨╛╨▓╨╗╤П╨╡╤В╤Б╤П. ╨Т╤Л╨▒╨╡╤А╨╕╤В╨╡ ╨╡╤С ╨╡╤Й╤С ╤А╨░╨╖.');
      const snapshot = await sdk.getDocsFromServer(chunks(owner, header.revision));
      const parts = snapshot.docs.map((doc) => doc.data()).sort((a, b) => a.position - b.position);
      if (parts.length !== header.chunkCount || parts.some((part, i) => part.position !== i)) throw new Error('╨Ъ╨░╤В╨░╨╗╨╛╨│ ╨╡╤Й╤С ╨╜╨╡ ╨│╨╛╤В╨╛╨▓.');
      const after = await sdk.getDocFromServer(manifest(owner));
      if (!after.exists() || after.data().revision !== header.revision) throw new Error('╨С╨╕╨▒╨╗╨╕╨╛╤В╨╡╨║╨░ ╨╛╨▒╨╜╨╛╨▓╨╗╤П╨╡╤В╤Б╤П. ╨Т╤Л╨▒╨╡╤А╨╕╤В╨╡ ╨╡╤С ╨╡╤Й╤С ╤А╨░╨╖.');
      const index = JSON.parse(parts.map((part) => part.json).join(''));
      if (!Array.isArray(index.books) || !Array.isArray(index.folders) || !index.rootFolderId) throw new Error('╨Э╨╡╨║╨╛╤А╤А╨╡╨║╤В╨╜╤Л╨╣ ╨║╨░╤В╨░╨╗╨╛╨│.');
      return index;
    },
  };
}

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
    'metadataVersion', 'title', 'authors', 'genres', 'series', 'seriesNumber', 'annotation', 'preview', 'language'];
  return { version: index.version, rootFolderId: index.rootFolderId, updatedAt: index.updatedAt || '',
    folders: index.folders.filter((folder) => folder.id === index.rootFolderId || allowed.has(folder.id))
      .map(({ id, parentId, name }) => ({ id, parentId, name })),
    books: index.books.filter((book) => allowed.has(book.parentId))
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

export function createSharedLibraryStore({ db, sdk, user }) {
  const manifest = (owner) => sdk.doc(db, 'sharedLibraries', owner);
  const chunks = (owner, revision) => sdk.collection(db, 'sharedLibraries', owner, 'versions', revision, 'chunks');
  let queue = Promise.resolve();
  let disposed = false;
  const ensureCurrent = () => { if (disposed) throw new Error('Сеанс завершён.'); };
  return {
    dispose() { disposed = true; },
    unpublish() { queue = queue.catch(() => {}).then(() => { ensureCurrent(); return sdk.deleteDoc(manifest(user.uid)); }); return queue; },
    watchManifest(owner, next, error) {
      return sdk.onSnapshot(manifest(owner), { includeMetadataChanges: true }, (snapshot) => {
        if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) next(snapshot.exists() ? snapshot.data() : null);
      }, error);
    },
    publish(index, settings) {
      const task = async () => {
        ensureCurrent();
        const payload = await sharedLibraryPayload(index, settings);
        const before = await sdk.getDocFromServer(manifest(user.uid));
        if (before.exists() && before.data().signature === payload.signature) return;
        const revision = crypto.randomUUID();
        for (let start = 0; start < payload.chunks.length; start += 10) {
          const batch = sdk.writeBatch(db);
          payload.chunks.slice(start, start + 10).forEach((json, offset) => batch.set(sdk.doc(chunks(user.uid, revision), String(start + offset)), { position: start + offset, json }));
          await batch.commit();
        }
        ensureCurrent();
        await sdk.setDoc(manifest(user.uid), { revision, signature: payload.signature, chunkCount: payload.chunks.length });
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
    async load(owner, expected) {
      const before = await sdk.getDocFromServer(manifest(owner));
      if (!before.exists()) throw new Error('Библиотека недоступна.');
      const header = before.data();
      if (expected && header.revision !== expected) throw new Error('Библиотека обновляется. Выберите её ещё раз.');
      const snapshot = await sdk.getDocsFromServer(chunks(owner, header.revision));
      const parts = snapshot.docs.map((doc) => doc.data()).sort((a, b) => a.position - b.position);
      if (parts.length !== header.chunkCount || parts.some((part, i) => part.position !== i)) throw new Error('Каталог ещё не готов.');
      const after = await sdk.getDocFromServer(manifest(owner));
      if (!after.exists() || after.data().revision !== header.revision) throw new Error('Библиотека обновляется. Выберите её ещё раз.');
      const index = JSON.parse(parts.map((part) => part.json).join(''));
      if (!Array.isArray(index.books) || !Array.isArray(index.folders) || !index.rootFolderId) throw new Error('Некорректный каталог.');
      return index;
    },
  };
}

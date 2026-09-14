// Local working data only. Credentials must never enter this database.
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('secret-library-indexing', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('operations');
      request.result.createObjectStore('results');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function checkpointKey(owner, root) {
  if (!owner || !root) throw new Error('Не удалось определить владельца checkpoint.');
  return JSON.stringify([owner, root]);
}

export async function checkpointTransaction(key, action, { open = openDatabase } = {}) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(['operations', 'results'], action.type === 'load' ? 'readonly' : 'readwrite');
      const operations = tx.objectStore('operations');
      const results = tx.objectStore('results');
      const range = IDBKeyRange.bound([key, ''], [key, '\uffff']);
      let base = null;
      let journal = [];
      if (action.type === 'load') {
        operations.get(key).onsuccess = (event) => { base = event.target.result; };
        results.getAll(range).onsuccess = (event) => { journal = event.target.result; };
      } else if (action.type === 'delete') {
        operations.delete(key);
        results.delete(range);
      } else {
        const { index, changedIds } = action;
        if (!changedIds) {
          operations.put(index, key);
          results.delete(range);
        } else {
          // Small journal writes commit together with their progress manifest.
          const { books, ...header } = index;
          results.put({ header }, [key, '']);
          const selected = new Set(changedIds);
          for (const book of books) if (selected.has(book.id)) results.put({ book }, [key, book.id]);
        }
      }
      tx.oncomplete = () => {
        if (base) {
          const books = new Map(base.books.map((book) => [book.id, book]));
          for (const entry of journal) {
            if (entry.header) Object.assign(base, entry.header);
            if (entry.book) books.set(entry.book.id, entry.book);
          }
          for (const id of base.buildState?.removedBookIds || []) books.delete(id);
          base.books = [...books.values()];
        }
        resolve(base);
      };
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Не удалось сохранить checkpoint.'));
    });
  } finally { db.close(); }
}

export const loadCheckpoint = (key) => checkpointTransaction(key, { type: 'load' });
export const saveCheckpoint = (key, index, changedIds) => checkpointTransaction(key, { type: 'save', index, changedIds });
export const deleteCheckpoint = (key) => checkpointTransaction(key, { type: 'delete' });

// A failed upload or read-back must leave the working journal intact.
export async function commitCheckpoint(index, { save, read, remove }) {
  const fileId = await save(index);
  const verified = await read(fileId);
  if (JSON.stringify(verified) !== JSON.stringify(index)) throw new Error('Проверка сохранённого индекса не совпала с результатом операции.');
  await remove();
  return { fileId, index: verified };
}

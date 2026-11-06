export function latestBookOutcomes(entries = []) {
  return new Map(entries.filter((entry) => entry.stage !== 'index-write'
    && ['failed', 'recovered', 'excluded'].includes(entry.outcome)).map((entry) => [entry.fileId, entry]));
}

export function failedBookIds(index) {
  const outcomes = new Map([...latestBookOutcomes(index.indexingErrors)].map(([id, entry]) => [id, entry.outcome]));
  return new Set(index.books.filter((book) => outcomes.get(book.id) === 'failed'
    || (!index.lastIndexingRun && !outcomes.has(book.id) && book.metadataStatus === 'error')).map((book) => book.id));
}

export function selectedRetryBookIds(index, requestedIds) {
  const failures = failedBookIds(index);
  if (requestedIds === undefined) return failures;
  if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
    throw Object.assign(new Error('A selective retry requires at least one Drive file ID.'), { code: 'invalid_retry_selection' });
  }
  const bookIdCounts = new Map();
  for (const book of index.books) bookIdCounts.set(book.id, (bookIdCounts.get(book.id) || 0) + 1);
  const ids = new Set();
  for (const id of requestedIds) {
    if (typeof id !== 'string' || !id.trim() || id !== id.trim() || ids.has(id)) {
      throw Object.assign(new Error('Selective retry IDs must be non-empty, unique Drive file IDs.'), { code: 'invalid_retry_selection' });
    }
    ids.add(id);
    if (bookIdCounts.get(id) !== 1 || !failures.has(id)) {
      throw Object.assign(new Error(`Drive file ID ${id} is not an unambiguous failed book in the current index.`),
        { code: 'invalid_retry_selection', fileId: id });
    }
  }
  return ids;
}

export function indexingCounts(index) {
  const failed = failedBookIds(index);
  const warnings = new Set((index.indexingErrors || []).filter((entry) => entry.outcome === 'recovered').map((entry) => entry.fileId));
  const ready = index.books.filter((book) => book.metadataStatus === 'ready' && !failed.has(book.id));
  const recoveredBooks = ready.filter((book) => warnings.has(book.id) || ['binary_corruption_recovered', 'metadata_only_recovered'].includes(book.metadataWarning)).length;
  return { totalEligibleBooks: Array.isArray(index.books) ? index.books.length : 0,
    failedBooks: failed.size, recoveredBooks, successBooks: ready.length - recoveredBooks };
}

export function metadataActionLabels(index) {
  const { totalEligibleBooks, failedBooks } = indexingCounts(index);
  return { full: 'Переиндексировать все книги' + (totalEligibleBooks == null ? '' : ` (${totalEligibleBooks.toLocaleString('ru-RU')})`),
    retry: `Повторить ошибки (${failedBooks.toLocaleString('ru-RU')})`, retryHidden: !failedBooks };
}

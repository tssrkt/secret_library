export function failedBookIds(index) {
  const outcomes = new Map((index.indexingErrors || []).filter((entry) => entry.stage !== 'index-write'
    && ['failed', 'recovered', 'excluded'].includes(entry.outcome)).map((entry) => [entry.fileId, entry.outcome]));
  return new Set(index.books.filter((book) => outcomes.get(book.id) === 'failed'
    || (!index.lastIndexingRun && !outcomes.has(book.id) && book.metadataStatus === 'error')).map((book) => book.id));
}

export function indexingCounts(index) {
  const failed = failedBookIds(index);
  const warnings = new Set((index.indexingErrors || []).filter((entry) => entry.outcome === 'recovered').map((entry) => entry.fileId));
  const ready = index.books.filter((book) => book.metadataStatus === 'ready' && !failed.has(book.id));
  const recoveredBooks = ready.filter((book) => warnings.has(book.id) || book.metadataWarning === 'binary_corruption_recovered').length;
  return { totalEligibleBooks: Number.isInteger(index.lastFullScan?.totalEligible) ? index.lastFullScan.totalEligible : null,
    failedBooks: failed.size, recoveredBooks, successBooks: ready.length - recoveredBooks };
}

export function metadataActionLabels(index) {
  const { totalEligibleBooks, failedBooks } = indexingCounts(index);
  return { full: 'Переиндексировать книги' + (totalEligibleBooks == null ? '' : ` (${totalEligibleBooks.toLocaleString('ru-RU')})`),
    retry: `Повторить ошибки (${failedBooks.toLocaleString('ru-RU')})`, retryHidden: !failedBooks };
}

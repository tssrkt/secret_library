export const INDEXING_STAGES = ['list', 'metadata', 'download', 'parse', 'metadata-extraction', 'annotation', 'preview', 'cover', 'index-write'];

export function errorDetails(error, extra = {}) {
  return {
    timestamp: new Date().toISOString(),
    stage: error.stage || (error.status ? 'download' : 'metadata-extraction'),
    status: error.status || null,
    code: error.code || error.name || 'error',
    message: String(error.message || error).slice(0, 1000),
    attempt: error.attempt || 1,
    range: error.range || null,
    contentRange: error.contentRange || null,
    retryResult: error.retryResult || 'not-retried',
    ...extra,
  };
}

export function recordIndexingError(index, book, events, { preserved = false, outcome = 'failed' } = {}) {
  index.indexingErrors ||= [];
  const entry = {
    ...(outcome === 'recovered' ? events[0] : events.at(-1)), fileName: book.fileName || '', fileId: book.id || '',
    retryResult: events.at(-1).retryResult, previousEntryPreserved: preserved, outcome, events,
  };
  // One report per file/run; individual request failures remain in its events.
  const existing = index.indexingErrors.findIndex((item) => item.fileId === entry.fileId && item.stage !== 'index-write');
  if (existing >= 0 && entry.stage !== 'index-write') index.indexingErrors[existing] = entry;
  else index.indexingErrors.push(entry);
  return entry;
}

export function formatIndexingErrors(entries) {
  return entries.map((entry) => [
    `[${entry.timestamp}]`, `File: ${entry.fileName}`, `FileId: ${entry.fileId}`,
    `Outcome: ${entry.outcome}`, `Previous index entry preserved: ${entry.previousEntryPreserved ? 'yes' : 'no'}`,
    ...(entry.events || [entry]).flatMap((event) => [
      `At: ${event.timestamp}`, `Stage: ${event.stage}`, `HTTP: ${event.status ?? '-'}`, `Code: ${event.code}`,
      `Error: ${event.message}`, `Attempt: ${event.attempt}`, `Range: ${event.range || 'none'}`,
      `Content-Range: ${event.contentRange || 'unavailable'}`, `Retry: ${event.retryResult}`,
    ]),
  ].join('\n')).join('\n\n---\n\n');
}

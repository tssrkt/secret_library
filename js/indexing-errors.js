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
    ...(error.encoding ? { encoding: error.encoding } : {}),
    ...(error.containerType ? { containerType: error.containerType } : {}),
    ...(error.format ? { format: error.format } : {}),
    ...(error.binaryRecoveryAttempt ? { binaryRecoveryAttempt: { ...error.binaryRecoveryAttempt } } : {}),
    ...(error.parserMessage ? { parserLine: error.parserLine, parserColumn: error.parserColumn, parserMessage: error.parserMessage } : {}),
    ...(error.code === 'binary_corruption_recovered' ? {
      binaries: error.binaries.map(({ id, contentType, reason, payloadLength }) => ({
        id: String(id).replace(/[\r\n\t]/g, ' ').slice(0, 160),
        contentType: String(contentType).replace(/[\r\n\t]/g, ' ').slice(0, 80), reason, payloadLength,
      })),
      metadataIndexed: error.metadataIndexed, coverRecovered: error.coverRecovered,
      previousCoverPreserved: error.previousCoverPreserved, bookSkipped: error.bookSkipped,
    } : {}),
    ...extra,
  };
}

export function recordIndexingError(index, book, events, { preserved = false, outcome = 'failed' } = {}) {
  index.indexingErrors ||= [];
  const entry = {
    ...(outcome === 'recovered' ? events.find((event) => event.code === 'binary_corruption_recovered') || events[0] : events.at(-1)), fileName: book.fileName || '', fileId: book.id || '',
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
    `Run: ${entry.runId || 'legacy'}`,
    `Outcome: ${entry.outcome}`, `Previous index entry preserved: ${entry.previousEntryPreserved ? 'yes' : 'no'}`,
    ...(entry.events || [entry]).flatMap((event) => [
      `At: ${event.timestamp}`, `Stage: ${event.stage}`, `HTTP: ${event.status ?? '-'}`, `Code: ${event.code}`,
      `Error: ${event.message}`, `Attempt: ${event.attempt}`, `Range: ${event.range || 'none'}`,
      `Content-Range: ${event.contentRange || 'unavailable'}`, `Retry: ${event.retryResult}`,
      ...(event.encoding ? [`Encoding: ${event.encoding}`] : []),
      ...(event.containerType ? [`Container: ${event.containerType}`] : []),
      ...(event.format ? [`Signature: ${event.format.classification || 'XML/unknown'}`, `BOM: ${event.format.bom || 'none'}`, `XML declaration: ${event.format.xmlDeclaration ? 'yes' : 'no'}`] : []),
      ...(event.binaryRecoveryAttempt ? [`Binary recovery attempted: yes`, `Candidate binaries found: ${event.binaryRecoveryAttempt.candidateBinaries}`,
        `Recovery result: ${event.binaryRecoveryAttempt.result}`, `Reason: ${event.binaryRecoveryAttempt.reason}`] : []),
      ...(event.parserMessage ? [`Parser line: ${event.parserLine ?? 'unavailable'}`, `Parser column: ${event.parserColumn ?? 'unavailable'}`, `Parser error: ${event.parserMessage}`] : []),
      ...(event.binaries ? [
        `Damaged binaries: ${event.binaries.length}`,
        ...event.binaries.flatMap((binary) => [`Binary id: ${binary.id}`, `Content-Type: ${binary.contentType}`, `Corruption: ${binary.reason}`, `Payload length: ${binary.payloadLength}`]),
        `Metadata indexed: ${event.metadataIndexed ? 'yes' : 'no'}`, `Cover recovered: ${event.coverRecovered ? 'yes' : 'no'}`,
        `Previous cover preserved: ${event.previousCoverPreserved ? 'yes' : 'no'}`, `Book skipped: ${event.bookSkipped ? 'yes' : 'no'}`,
      ] : []),
    ]),
  ].join('\n')).join('\n\n---\n\n');
}

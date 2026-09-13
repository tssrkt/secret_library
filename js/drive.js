import { FOLDER_MIME_TYPE, ROOT_FOLDER_ID, ROOT_FOLDER_RESOURCE_KEY } from './config.js';
import { getAccessToken } from './auth.js';

const API_ROOT = 'https://www.googleapis.com/drive/v3';
const UPLOAD_ROOT = 'https://www.googleapis.com/upload/drive/v3';
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

export class DriveError extends Error {
  constructor(message, { status = 0, code = 'drive_error', retryable = false } = {}) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
  const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(finish, milliseconds);
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
});

function resourceKeyHeaders() {
  return ROOT_FOLDER_RESOURCE_KEY
    ? { 'X-Goog-Drive-Resource-Keys': `${ROOT_FOLDER_ID}/${ROOT_FOLDER_RESOURCE_KEY}` }
    : {};
}

export async function driveFetch(path, options = {}, retry = 0, apiRoot = API_ROOT) {
  const { diagnostics = {}, readJson = false, ...requestOptions } = options;
  options.signal?.throwIfAborted();
  const pause = (ms) => diagnostics.sleep ? diagnostics.sleep(ms) : delay(ms, options.signal);
  const report = (error, retryResult) => {
    Object.assign(error, { stage: diagnostics.stage || (requestOptions.method ? 'index-write' : path.includes('alt=media') ? 'download' : path.startsWith('/files?') ? 'list' : 'metadata'),
      fileId: diagnostics.fileId || decodeURIComponent(path.match(/^\/files\/([^?]+)/)?.[1] || ''),
      ...(diagnostics.folderId ? { folderId: diagnostics.folderId, folderName: diagnostics.folderName || '' } : {}),
      attempt: retry + 1, range: options.headers?.Range || null, retryResult });
    diagnostics.onIssue?.(error);
    return error;
  };
  const token = getAccessToken();
  if (!token) throw report(new DriveError('Сеанс Google истек. Войдите снова.', { status: 401, code: 'unauthorized' }), 'not-retried');

  let response;
  const timeoutSignal = AbortSignal.timeout(diagnostics.timeoutMs ?? 30000);
  const requestSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  try {
    response = await fetch(`${apiRoot}${path}`, {
      ...requestOptions,
      signal: requestSignal,
      headers: { Authorization: `Bearer ${token}`, ...resourceKeyHeaders(), ...options.headers },
    });
    // Folder listing must retry body-read timeouts/network failures too, not
    // only failures before the HTTP headers arrive.
    if (response.ok && readJson) {
      const value = await response.json();
      diagnostics.onSuccess?.({ attempt: retry + 1 });
      return value;
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    const timedOut = error?.name === 'TimeoutError' || timeoutSignal.aborted;
    if (error?.name === 'AbortError' && !timedOut) throw error;
    const failure = new DriveError(timedOut ? 'Google Drive не ответил за 30 секунд.'
      : 'Не удалось связаться с Google Drive. Проверьте подключение к интернету.',
    { code: timedOut ? 'download_timeout' : 'network_error', retryable: true });
    if (retry < (diagnostics.maxRetries ?? MAX_RETRIES)) {
      report(failure, 'retrying');
      await pause(500 * (2 ** retry));
      return driveFetch(path, options, retry + 1, apiRoot);
    }
    throw report(failure, retry ? 'exhausted' : 'not-retried');
  }

  if (response.ok) { diagnostics.onSuccess?.({ attempt: retry + 1 }); return response; }
  let errorBody = null;
  try { errorBody = await response.clone().json(); } catch { /* response has no JSON body */ }
  const reason = errorBody?.error?.errors?.[0]?.reason || '';
  const retryable = RETRYABLE_STATUSES.has(response.status)
    || (response.status === 403 && ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason));
  if (retryable && retry < (diagnostics.maxRetries ?? MAX_RETRIES)) {
    report(new DriveError(errorBody?.error?.message || `HTTP ${response.status}`, { status: response.status, retryable }), 'retrying');
    const retryAfter = Number(response.headers.get('Retry-After')) * 1000;
    await pause(Math.min(retryAfter || 700 * (2 ** retry), 10000));
    return driveFetch(path, options, retry + 1, apiRoot);
  }

  const apiMessage = errorBody?.error?.message || '';
  const messages = {
    401: 'Сеанс Google истек. Войдите снова.',
    403: retryable ? 'Google Drive временно ограничил число запросов. Повторите позже.' : 'Нет доступа к запрошенным данным Google Drive.',
    404: 'Файл Google Drive не найден или недоступен.',
    416: 'Запрошенный диапазон находится за пределами доступного файла (Range Not Satisfiable).',
    429: 'Google Drive временно ограничил число запросов. Повторите позже.',
  };
  const error = new DriveError(messages[response.status] || apiMessage || 'Google Drive вернул ошибку.', {
    status: response.status,
    code: response.status === 401 ? 'unauthorized' : 'drive_error',
    retryable,
  });
  error.contentRange = response.headers.get('Content-Range');
  throw report(error, retry ? 'exhausted' : 'not-retried');
}

export async function getFolder(folderId, { signal, diagnostics = {} } = {}) {
  const params = new URLSearchParams({ fields: 'id,name,mimeType,parents', supportsAllDrives: 'true' });
  const folder = await driveFetch(`/files/${encodeURIComponent(folderId)}?${params}`, { signal, readJson: true, diagnostics });
  if (folder.mimeType !== FOLDER_MIME_TYPE) throw new DriveError('Настроенный rootFolderId не является папкой Google Drive.', { code: 'not_folder' });
  return folder;
}

export async function getLibraryFile(fileId, signal) {
  const params = new URLSearchParams({ fields: 'id,name,mimeType,parents,size,modifiedTime,md5Checksum,trashed', supportsAllDrives: 'true' });
  return (await driveFetch(`/files/${encodeURIComponent(fileId)}?${params}`, { signal, diagnostics: { stage: 'metadata', fileId } })).json();
}

export async function getCurrentDriveUser(request = driveFetch) {
  const params = new URLSearchParams({ fields: 'user(displayName,emailAddress,photoLink)' });
  const response = await request(`/about?${params}`);
  return (await response.json()).user || {};
}

export async function listFolderChildren(folderId, { signal, diagnostics = {} } = {}) {
  const files = [];
  let pageToken = '';
  const seenTokens = new Set();
  do {
    signal?.throwIfAborted();
    const params = new URLSearchParams({
      q: `'${folderId.replaceAll("'", "\\'")}' in parents and trashed = false`,
      fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,parents,size,modifiedTime,md5Checksum,resourceKey)',
      pageSize: '1000',
      spaces: 'drive',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await driveFetch(`/files?${params}`, { signal, readJson: true, diagnostics: { ...diagnostics, stage: 'list', fileId: folderId } });
    if (page.incompleteSearch) throw Object.assign(new DriveError('Google Drive вернул неполный список папки.', { code: 'incomplete_folder_list' }), { stage: 'list', fileId: folderId });
    if (!Array.isArray(page.files)) throw Object.assign(new DriveError('Некорректный ответ списка папки.', { code: 'invalid_folder_response' }), { stage: 'list', fileId: folderId });
    files.push(...page.files);
    pageToken = page.nextPageToken || '';
    if (pageToken && seenTokens.has(pageToken)) throw Object.assign(new DriveError('Повторяющаяся страница списка папки.', { code: 'repeated_page_token' }), { stage: 'list', fileId: folderId });
    if (pageToken) seenTokens.add(pageToken);
  } while (pageToken);
  return files;
}

export async function listAppDataFiles(name) {
  const safeName = name.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name = '${safeName}' and trashed = false`,
    fields: 'files(id,name,modifiedTime)',
    pageSize: '100',
    orderBy: 'modifiedTime desc',
  });
  const response = await driveFetch(`/files?${params}`);
  return (await response.json()).files || [];
}

export async function listAppDataFilesByPrefix(prefix) {
  const files = [];
  let pageToken = '';
  const safePrefix = prefix.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  do {
    const params = new URLSearchParams({
      spaces: 'appDataFolder', q: `name contains '${safePrefix}' and trashed = false`,
      fields: 'nextPageToken,files(id,name)', pageSize: '1000',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await (await driveFetch(`/files?${params}`)).json();
    files.push(...(page.files || []).filter((file) => file.name.startsWith(prefix)));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return files;
}

export async function downloadAppDataFile(fileId) {
  const params = new URLSearchParams({ alt: 'media' });
  return driveFetch(`/files/${encodeURIComponent(fileId)}?${params}`);
}

export async function downloadDriveFile(fileId, signal, request = driveFetch, diagnostics = {}) {
  const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
  const response = await request(`/files/${encodeURIComponent(fileId)}?${params}`, { signal, diagnostics });
  return response.blob();
}

export async function downloadFileRange(fileId, start, end, signal, { requirePartial = false, diagnostics = {} } = {}) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw Object.assign(new DriveError('Некорректный диапазон байтов.', { code: 'invalid_range' }), { stage: 'download' });
  }
  const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
  const response = await driveFetch(`/files/${encodeURIComponent(fileId)}?${params}`, {
    headers: { Range: `bytes=${start}-${end}` },
    signal,
    diagnostics,
  });
  if (requirePartial && response.status === 200) {
    await response.body?.cancel();
    throw new DriveError('Google Drive проигнорировал Range для ZIP; полный архив не загружен.', { code: 'range_ignored' });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentRange = response.headers.get('Content-Range')?.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (response.status === 206 && contentRange
      && (Number(contentRange[1]) !== start || Number(contentRange[2]) - start + 1 !== bytes.length)) {
    throw Object.assign(new DriveError('Content-Range не соответствует запрошенным байтам.', { code: 'invalid_content_range' }), { stage: 'download' });
  }
  const reachedEnd = bytes.length < end - start + 1
    || (contentRange && contentRange[3] !== '*' && Number(contentRange[2]) + 1 >= Number(contentRange[3]));
  return {
    bytes,
    isComplete: response.status === 200 || reachedEnd,
    status: response.status,
  };
}

export async function createAppDataFile(name, jsonText) {
  const boundary = `secret_library_${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, parents: ['appDataFolder'], mimeType: 'application/json' });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${jsonText}\r\n--${boundary}--`;
  const params = new URLSearchParams({ uploadType: 'multipart', fields: 'id' });
  const response = await driveFetch(`/files?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  }, 0, UPLOAD_ROOT);
  return response.json();
}

export async function updateAppDataFile(fileId, jsonText) {
  const params = new URLSearchParams({ uploadType: 'media', fields: 'id' });
  const response = await driveFetch(`/files/${encodeURIComponent(fileId)}?${params}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: jsonText,
  }, 0, UPLOAD_ROOT);
  return response.json();
}

export async function createAppDataBlob(name, blob) {
  const boundary = `secret_library_${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, parents: ['appDataFolder'], mimeType: blob.type });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${blob.type}\r\n\r\n`, blob, `\r\n--${boundary}--`,
  ]);
  const params = new URLSearchParams({ uploadType: 'multipart', fields: 'id' });
  const response = await driveFetch(`/files?${params}`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  }, 0, UPLOAD_ROOT);
  return response.json();
}

export async function downloadAppDataBlob(fileId, signal) {
  return (await driveFetch(`/files/${encodeURIComponent(fileId)}?alt=media`, { signal })).blob();
}

export async function deleteAppDataFile(fileId) {
  await driveFetch(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
}

import { FOLDER_MIME_TYPE, SHARED_CATALOG_FILE_NAME } from './config.js';
import { ensureAccessToken, renewAccessToken } from './auth.js?v=20261114-brave-redirect-signin';

const API_ROOT = 'https://www.googleapis.com/drive/v3';
const UPLOAD_ROOT = 'https://www.googleapis.com/upload/drive/v3';
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

async function readDownloadBody(response, method, signal) {
  try { return await response[method](); }
  catch (cause) {
    signal?.throwIfAborted();
    throw Object.assign(new DriveError('Загрузка Google Drive прервана. Проверьте подключение.',
      { code: 'network_error', retryable: true }), { stage: 'download', cause });
  }
}

export class DriveError extends Error {
  constructor(message, { status = 0, code = 'drive_error', reason = '', apiMessage = '', details = [], retryable = false } = {}) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.apiMessage = apiMessage;
    this.details = Array.isArray(details) ? details : [];
    this.retryable = retryable;
  }
}

const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
  const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(finish, milliseconds);
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
});

function resourceKeyHeaders(resourceKey) {
  const keys = [];
  if (resourceKey?.fileId && resourceKey.key) {
    const value = `${resourceKey.fileId}/${resourceKey.key}`;
    if (!keys.includes(value)) keys.push(value);
  }
  return keys.length ? { 'X-Goog-Drive-Resource-Keys': keys.join(',') } : {};
}

export async function driveFetch(path, options = {}, retry = 0, apiRoot = API_ROOT, authRetried = false) {
  const { diagnostics = {}, readJson = false, resourceKey, ...requestOptions } = options;
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
  const token = await ensureAccessToken();
  if (!token) throw report(new DriveError('Сеанс Google истек. Войдите снова.', { status: 401, code: 'unauthorized' }), 'not-retried');

  let response;
  const timeoutSignal = AbortSignal.timeout(diagnostics.timeoutMs ?? 30000);
  const requestSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  try {
    response = await fetch(`${apiRoot}${path}`, {
      ...requestOptions,
      signal: requestSignal,
      headers: { Authorization: `Bearer ${token}`, ...resourceKeyHeaders(resourceKey), ...options.headers },
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
      return driveFetch(path, options, retry + 1, apiRoot, authRetried);
    }
    throw report(failure, retry ? 'exhausted' : 'not-retried');
  }

  if (response.ok) { diagnostics.onSuccess?.({ attempt: retry + 1 }); return response; }
  if (response.status === 401 && !authRetried) {
    await renewAccessToken(token);
    options.signal?.throwIfAborted();
    return driveFetch(path, options, retry, apiRoot, true);
  }
  let errorBody = null;
  try { errorBody = await response.clone().json(); } catch { /* response has no JSON body */ }
  const reason = errorBody?.error?.errors?.[0]?.reason || '';
  const retryable = RETRYABLE_STATUSES.has(response.status)
    || (response.status === 403 && ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason));
  if (retryable && retry < (diagnostics.maxRetries ?? MAX_RETRIES)) {
    report(new DriveError(errorBody?.error?.message || `HTTP ${response.status}`, { status: response.status, retryable }), 'retrying');
    const retryAfter = Number(response.headers.get('Retry-After')) * 1000;
    await pause(Math.min(retryAfter || 700 * (2 ** retry), 10000));
    return driveFetch(path, options, retry + 1, apiRoot, authRetried);
  }

  const apiMessage = errorBody?.error?.message || '';
  const missingDriveScope = response.status === 403
    && /insufficient authentication scopes|insufficientpermissions|insufficient permissions/i.test(apiMessage);
  const appNotAuthorizedToFile = response.status === 403 && reason === 'appNotAuthorizedToFile';
  const appNotAuthorizedToChild = response.status === 403 && reason === 'appNotAuthorizedToChild';
  const insufficientFilePermissions = response.status === 403 && reason === 'insufficientFilePermissions';
  const messages = {
    401: 'Сеанс Google истек. Войдите снова.',
    403: retryable ? 'Google Drive временно ограничил число запросов. Повторите позже.' : 'Нет доступа к запрошенным данным Google Drive.',
    404: 'Файл Google Drive не найден или недоступен.',
    416: 'Запрошенный диапазон находится за пределами доступного файла (Range Not Satisfiable).',
    429: 'Google Drive временно ограничил число запросов. Повторите позже.',
  };
  const error = new DriveError(missingDriveScope
    ? 'Чтобы выдавать доступ к папке, нужно обновить разрешения Google Drive. Выйдите из сайта и войдите снова, подтвердив новые разрешения.'
    : appNotAuthorizedToFile
      ? 'Google Drive не подтвердил разрешение приложения для этой папки. Повторно подтвердите доступ именно к корневой папке библиотеки.'
      : appNotAuthorizedToChild
        ? 'Google Drive не разрешил изменить доступ к этому объекту. Возможно, разрешение унаследовано от родительской папки или объект не авторизован для приложения. Проверьте доступ на родительском уровне и повторно подтвердите папку через выбор в Google Picker.'
        : insufficientFilePermissions
          ? 'У текущего аккаунта недостаточно прав для изменения доступа к этой папке. Проверьте, что вы вошли под аккаунтом владельца библиотеки.'
          : messages[response.status] || apiMessage || 'Google Drive вернул ошибку.', {
    status: response.status,
    code: response.status === 401 ? 'unauthorized' : missingDriveScope ? 'insufficient_scope' : appNotAuthorizedToFile ? 'app_not_authorized_to_file' : appNotAuthorizedToChild ? 'app_not_authorized_to_child' : insufficientFilePermissions ? 'insufficient_file_permissions' : 'drive_error',
    retryable,
    reason,
    apiMessage,
    details: errorBody?.error?.errors || [],
  });
  if (/quota/i.test(reason) || /quota/i.test(apiMessage)) {
    error.message += ` (Google Drive HTTP ${response.status}; reason: ${reason || 'not provided'})`;
  }
  error.contentRange = response.headers.get('Content-Range');
  if (response.status === 403) {
    // Keep diagnostics actionable without logging tokens, emails, file IDs, or raw provider payloads.
    console.warn('[Secret Library] Google Drive permission denied', {
      stage: error.stage || diagnostics.stage || 'unknown',
      status: response.status,
      reason: reason || 'not provided',
      code: error.code,
    });
  }
  throw report(error, retry ? 'exhausted' : 'not-retried');
}

export async function getFolderMetadata(folderId, { signal, diagnostics = {}, resourceKey, request = driveFetch } = {}) {
  const params = new URLSearchParams({ fields: 'id,name,mimeType,parents,resourceKey,isAppAuthorized,capabilities(canShare)', supportsAllDrives: 'true' });
  return request(`/files/${encodeURIComponent(folderId)}?${params}`, { signal, readJson: true, diagnostics, resourceKey: resourceKey ? { fileId: folderId, key: resourceKey } : undefined });
}

export async function getFolder(folderId, { signal, diagnostics = {}, resourceKey, request = driveFetch } = {}) {
  const params = new URLSearchParams({ fields: 'id,name,mimeType,parents,resourceKey,isAppAuthorized,capabilities(canShare)', supportsAllDrives: 'true' });
  const folder = await request(`/files/${encodeURIComponent(folderId)}?${params}`, { signal, readJson: true, diagnostics, resourceKey: resourceKey ? { fileId: folderId, key: resourceKey } : undefined });
  if (folder.mimeType !== FOLDER_MIME_TYPE) throw new DriveError('Настроенный rootFolderId не является папкой Google Drive.', { code: 'not_folder' });
  return folder;
}

export async function getLibraryFile(fileId, signal, key) {
  const params = new URLSearchParams({ fields: 'id,name,mimeType,parents,size,modifiedTime,md5Checksum,trashed,resourceKey', supportsAllDrives: 'true' });
  return driveFetch(`/files/${encodeURIComponent(fileId)}?${params}`, { signal, readJson: true,
    resourceKey: key ? { fileId, key } : undefined, diagnostics: { stage: 'metadata', fileId } });
}

export async function getCurrentDriveUser(request = driveFetch) {
  const params = new URLSearchParams({ fields: 'user(displayName,emailAddress,photoLink)' });
  const response = await request(`/about?${params}`);
  return (await response.json()).user || {};
}

export async function listFolderChildren(folderId, { signal, diagnostics = {}, resourceKey, foldersOnly = false } = {}) {
  const files = [];
  let pageToken = '';
  const seenTokens = new Set();
  do {
    signal?.throwIfAborted();
    const params = new URLSearchParams({
      q: `'${folderId.replaceAll("'", "\\'")}' in parents and trashed = false${foldersOnly ? ` and mimeType = '${FOLDER_MIME_TYPE}'` : ''}`,
      fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,md5Checksum,resourceKey)',
      pageSize: '1000',
      spaces: 'drive',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await driveFetch(`/files?${params}`, { signal, readJson: true,
      resourceKey: resourceKey ? { fileId: folderId, key: resourceKey } : undefined,
      diagnostics: { ...diagnostics, stage: 'list', fileId: folderId } });
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
  const response = await request(`/files/${encodeURIComponent(fileId)}?${params}`, { signal, diagnostics,
    resourceKey: diagnostics.resourceKey ? { fileId, key: diagnostics.resourceKey } : undefined });
  return readDownloadBody(response, 'blob', signal);
}

export async function downloadFileRange(fileId, start, end, signal, { requirePartial = false, diagnostics = {}, resourceKey } = {}) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw Object.assign(new DriveError('Некорректный диапазон байтов.', { code: 'invalid_range' }), { stage: 'download' });
  }
  const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
  const response = await driveFetch(`/files/${encodeURIComponent(fileId)}?${params}`, {
    headers: { Range: `bytes=${start}-${end}` },
    signal,
    resourceKey: resourceKey ? { fileId, key: resourceKey } : undefined,
    diagnostics,
  });
  if (requirePartial && response.status === 200) {
    await response.body?.cancel();
    throw new DriveError('Google Drive проигнорировал Range для ZIP; полный архив не загружен.', { code: 'range_ignored' });
  }
  const bytes = new Uint8Array(await readDownloadBody(response, 'arrayBuffer', signal));
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

// Shared catalogs live inside the owner's selected Drive root so inherited Drive
// permissions protect them. Unlike appDataFolder files, friends can read these files.
export async function createDriveJsonFile(name, parentId, jsonText, ownerUid) {
  if (!name || !parentId || !ownerUid) throw new Error('Для каталога не заданы имя, владелец или корневая папка Google Drive.');
  const boundary = `secret_library_${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, parents: [parentId], mimeType: 'application/json',
    appProperties: { secretLibraryOwnerUid: ownerUid } });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${jsonText}\r\n--${boundary}--`;
  const params = new URLSearchParams({ uploadType: 'multipart', fields: 'id,name,parents,mimeType', supportsAllDrives: 'true' });
  const response = await driveFetch(`/files?${params}`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  }, 0, UPLOAD_ROOT);
  return response.json();
}

export async function updateDriveJsonFile(fileId, jsonText) {
  const params = new URLSearchParams({ uploadType: 'media', fields: 'id', supportsAllDrives: 'true' });
  const response = await driveFetch(`/files/${encodeURIComponent(fileId)}?${params}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: jsonText,
  }, 0, UPLOAD_ROOT);
  return response.json();
}

export async function downloadDriveJsonFile(fileId) {
  const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
  return driveFetch(`/files/${encodeURIComponent(fileId)}?${params}`, { readJson: true });
}

export async function findDriveCatalogFile(ownerUid) {
  if (!ownerUid) return null;
  // Search all Drive files visible to this account, including files inherited from
  // shared folders; then match the app-private owner marker returned by the API.
  let pageToken = '';
  let unpublishedCatalog = null;
  let inaccessibleMarkedCatalog = null;
  do {
    const query = `name = '${SHARED_CATALOG_FILE_NAME}' and trashed = false`;
    const params = new URLSearchParams({ q: query, spaces: 'drive', pageSize: '100',
      fields: 'nextPageToken,files(id,name,mimeType,parents,appProperties)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
    if (pageToken) params.set('pageToken', pageToken);
    const result = await driveFetch(`/files?${params}`, { readJson: true });
    const candidates = result.files || [];
    // Prefer appProperties matches to avoid reading unrelated catalogs. If a prior
    // root left a tombstone, keep searching for a live catalog belonging to this owner.
    const orderedCandidates = [
      ...candidates.filter((file) => file.appProperties?.secretLibraryOwnerUid === ownerUid),
      ...candidates.filter((file) => file.appProperties?.secretLibraryOwnerUid !== ownerUid),
    ];
    for (const candidate of orderedCandidates) {
      if (candidate.mimeType !== 'application/json') continue;
      const markedForOwner = candidate.appProperties?.secretLibraryOwnerUid === ownerUid;
      try {
        const catalog = await downloadDriveJsonFile(candidate.id);
        if (catalog?.ownerUid !== ownerUid) continue;
        if (catalog.published === false) {
          unpublishedCatalog ||= candidate;
          continue;
        }
        return candidate;
      } catch (error) {
        if (error?.status !== 403 && error?.status !== 404) throw error;
        // Preserve the most likely owner catalog as a fallback so load() can
        // surface the original permission error if no readable live catalog exists.
        if (markedForOwner && error?.status === 403) inaccessibleMarkedCatalog ||= candidate;
      }
    }
    pageToken = result.nextPageToken || '';
  } while (pageToken);
  return unpublishedCatalog || inaccessibleMarkedCatalog || null;
}

// Fail closed: ordinary Drive files may contain the user's books and must never be
// deleted by the application. Internal appDataFolder cleanup uses deleteAppDataFile.
export async function deleteDriveFile(fileId) {
  throw Object.assign(new Error('Удаление обычных файлов Google Drive запрещено в целях безопасности.'), {
    code: 'drive_file_deletion_blocked', fileId,
  });
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
  return readDownloadBody(await driveFetch(`/files/${encodeURIComponent(fileId)}?alt=media`, { signal }), 'blob', signal);
}

export async function deleteAppDataFile(fileId) {
  if (!fileId) throw new Error('Не задан ID служебного файла приложения.');
  const params = new URLSearchParams({ fields: 'id,parents' });
  const file = await driveFetch(`/files/${encodeURIComponent(fileId)}?${params}`, { readJson: true });
  if (!Array.isArray(file.parents) || !file.parents.includes('appDataFolder')) {
    throw Object.assign(new Error('Удаление разрешено только для файлов в appDataFolder.'), {
      code: 'appdata_deletion_blocked', fileId,
    });
  }
  await driveFetch(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
}

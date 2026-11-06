import {
  clearAccessToken, clearPersistedAuth, createAuthAttemptGuard,
  initializeAuth, persistAuthSession, recoverAuthSession, requestAccessToken,
} from './auth.js';
import { downloadDriveFile, getCurrentDriveUser, getFolder, listFolderChildren } from './drive.js?v=20261106-root-discovery';
import { removeCovers, removeOrphanCovers, storeCover } from './cover-cache.js';
import {
  deleteBuildingIndex, IndexError, loadBuildingIndex, loadIndex, readIndexFile,
  saveBuildingIndex, saveIndex,
} from './library-index.js';
import { createLibraryRefresher, scanStatus, scanFailureMessage } from './library-refresh.js';
import { scanLibrary } from './library-tree.js';
import { indexPendingBooks, resetProcessingBooks } from './metadata-indexer.js';
import {
  canResumeBuildingIndex, prepareBuildingIndex, updateBuildProgress, validateCompletedIndex,
} from './index-build.js';
import { prepareIndexingRun, createRetryEligibilityCheck } from './indexing-run.js';
import * as ui from './ui.js?v=20261106-root-discovery';
import { errorDetails, recordIndexingError } from './indexing-errors.js';
import { social, socialError } from './social-runtime.js?v=20261106-root-discovery';
import { getAccessToken } from './auth.js';
import { checkpointKey, loadCheckpoint, saveCheckpoint, deleteCheckpoint, commitCheckpoint } from './indexing-checkpoint.js';
import { createLibraryTabs } from './library-tabs.js';
import { createLibrarySelection } from './library-selection.js';
import { loadUserSettings, loadRootFolderPreference, loadRootFolderResourceKey, saveRootFolderPreference } from './user-settings.js';
import { chooseRootFolder } from './root-folder-picker.js?v=20261106-root-discovery';
import { firebaseConfigured } from './firebase-config.js';
import { hasMinimumBooks, MINIMUM_LIBRARY_BOOKS } from './library-access.js';

function reportOperationError(index, error, stage, fileId = '', fileName = '') {
  if (!index || error.indexingLogged) return;
  recordIndexingError(index, { id: error.fileId || fileId, fileName: error.folderName || fileName },
    [...(error.scanEvents || []), errorDetails(error, { stage: error.stage || stage })], { outcome: 'interrupted' });
  error.indexingLogged = true;
  ui.updateIndexingErrors(index.indexingErrors);
}

let indexFileId = null;
let currentIndex = null;
let shareableIndex = null;
let sharingVersion = 0;
let buildingIndex = null;
let buildingIndexFileId = null;
let metadataController = null;
let localCheckpointKey = null;
let authorizedOwner = null;
let activeRootFolderId = null;
let activeRootFolderResourceKey = '';
let reconnectRequired = false;
let refreshCommitUncertain = false;
let libraryAccessGranted = false;
const authAttempts = createAuthAttemptGuard();
const tabsRoot = document.querySelector('#library-tabs');
const tabs = createLibraryTabs(tabsRoot, (uid) => selection.select(uid));
const selection = createLibrarySelection({ tabs, service: social,
  show: (index, { own, ownerIndex, ownerId }) => {
    if (!libraryAccessGranted) { tabsRoot.hidden = true; return; }
    tabsRoot.hidden = false;
    ui.renderLibrary(index, downloadBook, { ownerIndex, readOnly: !own, ownerId,
      onSettingsSaved: (index, settings) => publishLibrary(shareableIndex || index, settings),
      beforeSettingsSave: () => { sharingVersion++; return firebaseConfigured() ? social.unpublishLibrary() : Promise.resolve(); } });
  },
  unavailable: (message, goHome) => { if (!libraryAccessGranted) { tabsRoot.hidden = true; return; } tabsRoot.hidden = false; ui.showLibraryUnavailable(message, goHome); },
});
async function publishLibrary(index, settings = null) {
  // social.connect() starts before the saved index is loaded, but may still be
  // registering the Firebase session here. Do not drop publication on that race:
  // social.publishLibrary() waits for the connection to become ready.
  if (!hasMinimumBooks(index)) return;
  const version = sharingVersion;
  const owner = authorizedOwner;
  const loaded = settings || (await loadUserSettings(index)).settings;
  if (version !== sharingVersion || owner !== authorizedOwner) return;
  await social.publishLibrary(index, loaded);
}
let publishingFor = null;
const friendLibrariesStatus = document.querySelector('#friend-libraries-status');
social.subscribe((state) => {
  if (friendLibrariesStatus) {
    const inboundCount = (state.libraries || []).length;
    if (state.driveDiscoveryStatus === 'loading') {
      friendLibrariesStatus.textContent = 'Библиотеки друзей загружаются…';
      friendLibrariesStatus.hidden = false;
    } else if (state.driveDiscoveryStatus === 'error') {
      friendLibrariesStatus.textContent = 'Не удалось загрузить библиотеки друзей. ' + (state.driveDiscoveryMessage || 'Проверьте подключение к Google Drive.');
      friendLibrariesStatus.hidden = false;
    } else if (state.driveDiscoveryStatus === 'ready' && inboundCount === 0) {
      friendLibrariesStatus.textContent = 'Библиотек друзей пока нет.';
      friendLibrariesStatus.hidden = false;
    } else {
      friendLibrariesStatus.hidden = true;
    }
  }
  if (state.status !== 'ready') { publishingFor = null; return; }
  if (shareableIndex && publishingFor !== shareableIndex) {
    publishingFor = shareableIndex;
    void publishLibrary(shareableIndex).catch((error) => { ui.showError(`Не удалось обновить каталог для друзей: ${socialError(error)}`); });
  }
});

function showUnfinishedOperation() {
  const state = buildingIndex?.buildState;
  ui.setIndexingContinuation(state, () => runMetadataIndexing({ resume: true }));
}

window.addEventListener('google-reconnect-required', () => {
  reconnectRequired = true;
  if (!metadataController) ui.setReconnectRequired(true);
});
window.addEventListener('online', () => {
  if (buildingIndex?.buildState?.pauseReason === 'network' && !reconnectRequired) void runMetadataIndexing({ resume: true });
});

async function cacheBuildingCover(book, cover) {
  return cover ? storeCover(book, cover) : { coverFileId: null, coverMimeType: null };
}

function staleActiveCoverIds(activeIndex, nextIndex) {
  const nextCoverIds = new Set(nextIndex.books.map((book) => book.coverFileId).filter(Boolean));
  return activeIndex.books.map((book) => book.coverFileId).filter((id) => id && !nextCoverIds.has(id));
}

function readableError(error) {
  if (error?.status === 401 || error?.code === 'unauthorized') {
    reconnectRequired = true;
    if (!metadataController) ui.setReconnectRequired(true);
    return 'Подключите Google снова. Прогресс индексации сохранён.';
  }
  return error?.message || 'Произошла непредвиденная ошибка.';
}

async function downloadBook(book) {
  try {
    ui.saveDownloadedFile(await downloadDriveFile(book.id, undefined, undefined,
      { resourceKey: book.resourceKey }), book.fileName);
  } catch (error) {
    ui.showError(readableError(error));
  }
}

function renderLibrary(index) {
  if (!hasMinimumBooks(index)) {
    libraryAccessGranted = false;
    tabsRoot.hidden = true;
    selection.reset();
    return;
  }
  libraryAccessGranted = true;
  tabsRoot.hidden = false;
  selection.setOwn(index);
}

async function ensureMinimumBookAccess(index) {
  if (hasMinimumBooks(index)) { libraryAccessGranted = true; return true; }
  libraryAccessGranted = false;
  tabsRoot.hidden = true;
  selection.reset();
  const count = Array.isArray(index?.books) ? index.books.length : 0;
  const reason = 'В вашей папке всего ' + count + ' книг, а нужно не менее ' + MINIMUM_LIBRARY_BOOKS + '!';
  ui.setStatus(reason + ' Выберите другую корневую папку.');
  while (true) {
    const folder = await chooseRootFolder({ listChildren: listFolderChildren, getFolder, scanFolder: scanLibrary,
      description: reason + ' Выберите корневую папку, где после сканирования найдётся не менее ' + MINIMUM_LIBRARY_BOOKS + ' книг. Учитываются книги во вложенных папках.' });
    if (!folder) {
      ui.setStatus('Доступ к каталогу закрыт: нужно не менее ' + MINIMUM_LIBRARY_BOOKS + ' книг. Выберите подходящую корневую папку через личное меню.');
      return false;
    }
    if (folder.id === activeRootFolderId) {
      await rebuildIndex();
      return false;
    }
    await saveRootFolderPreference(folder.id, folder.resourceKey);
    window.location.reload();
    return false;
  }
}

const libraryRefresher = createLibraryRefresher({
  save: saveIndex,
  apply: (index) => { currentIndex = index; renderLibrary(index); },
  beforeSave: async (index, previousIndex) => {
    const prepared = prepareBuildingIndex(index, { mode: 'refresh', previousIndex });
    if (!prepared.buildState.total) return null;
    await saveCheckpoint(localCheckpointKey, prepared);
    buildingIndex = prepared;
    return prepared;
  },
  onSaveFailure: async (_error, prepared) => {
    if (prepared && buildingIndex === prepared) buildingIndex = null;
    refreshCommitUncertain = true;
  },
  removeCovers,
  onProgress: (stats) => { ui.setStatus(scanStatus(stats)); ui.showStats(stats.processedFolders, stats.books); },
  onPhase: () => ui.setStatus('Сканирование завершено. Новая структура применена. Сохраняем индекс…'),
  onCleanupError: (error) => reportOperationError(currentIndex, error, 'cover'),
});

async function rebuildIndex() {
  if (!activeRootFolderId) { ui.showError('Сначала выберите корневую папку Google Drive через личное меню.'); return; }
  if (refreshCommitUncertain) {
    ui.showError('Не удалось подтвердить, сохранено ли обновление. Перезагрузите страницу, чтобы сверить индекс и checkpoint перед продолжением.');
    return;
  }
  if (metadataController || libraryRefresher.running) return;
  if (buildingIndex) return runMetadataIndexing({ resume: true });
  ui.clearError();
  ui.setBusy(true);
  ui.setStatus('Сканирование библиотеки… Обработано папок: 0. В очереди: 1. Найдено книг: 0.');
  try {
    const result = await libraryRefresher.run({ activeIndex: currentIndex, rootFolderId: activeRootFolderId, rootResourceKey: activeRootFolderResourceKey, fileId: indexFileId });
    if (!result) return;
    indexFileId = result.fileId;
    shareableIndex = result.index;
    ui.showStats(currentIndex.folders.length, currentIndex.books.length);
    if (!await ensureMinimumBookAccess(result.index)) return;
    void publishLibrary(result.index).catch((error) => ui.showError(`Не удалось обновить каталог для друзей: ${socialError(error)}`));
    ui.setStatus(`Библиотека обновлена: ${result.index.books.length.toLocaleString('ru-RU')} книг.`);
    if (buildingIndex) await runMetadataIndexing({ resume: true });
  } catch (error) {
    reportOperationError(currentIndex || {}, error, error.stage || 'list', error.folderId || activeRootFolderId);
    if (refreshCommitUncertain) ui.showError('Не удалось подтвердить, сохранено ли обновление. Перезагрузите страницу; до сверки индекса обработка заблокирована.');
    else if (error.status === 401 || error.code === 'unauthorized') ui.showError(readableError(error));
    else ui.showError(error.stage === 'index-write' ? readableError(error) : scanFailureMessage(error), { canRebuild: true });
    ui.setStatus(refreshCommitUncertain ? 'Сначала перезагрузите страницу и проверьте восстановленный checkpoint.'
      : error.stage === 'index-write' ? 'Новая структура показана в этой вкладке. Сохранить индекс не удалось; прежний сохранённый индекс и обложки оставлены.' : scanFailureMessage(error));
  } finally {
    ui.setBusy(false);
  }
}

async function runMetadataIndexing({ retryErrors = false, refreshOnly = false, resume = false, previousIndex = null,
  selectedBookIds } = {}) {
  if (refreshCommitUncertain) {
    ui.showError('Обработка заблокирована до перезагрузки и сверки активного индекса с checkpoint.');
    return;
  }
  if (!currentIndex || metadataController || (libraryRefresher.running && !refreshOnly)) return;
  if (buildingIndex && !resume) {
    if (selectedBookIds !== undefined) {
      ui.showError('Нельзя начать выборочную обработку, пока существует незавершённая сборка. Сначала продолжите её или дождитесь завершения.');
      return;
    }
    showUnfinishedOperation();
    ui.setStatus('Сначала продолжите незавершённую индексацию.');
    return;
  }
  if (resume && !buildingIndex) return;
  if (resume) {
    refreshOnly = buildingIndex.buildState.mode === 'refresh';
    retryErrors = buildingIndex.buildState.mode === 'retry';
  }
  if (!resume && refreshOnly && !currentIndex.books.some((book) => ['pending', 'processing'].includes(book.metadataStatus))) return;
  const activeIndex = currentIndex;
  const mode = resume ? buildingIndex.buildState.mode : refreshOnly ? 'refresh'
    : (retryErrors || selectedBookIds !== undefined) ? 'retry' : 'full';
  if (!resume && mode === 'full' && !window.confirm('Переиндексировать всю библиотеку? Будут повторно обработаны все книги.')) return;
  const modeLabel = refreshOnly ? 'Индексация новых и изменённых книг'
    : (retryErrors || selectedBookIds !== undefined) ? 'Повторная обработка ошибок' : 'Полная переиндексация';
  metadataController = new AbortController();
  ui.clearError();
  ui.setMetadataRunning(true);
  ui.setStatus(`${modeLabel}…`);
  let prepared = false;
  try {
    buildingIndex = resume ? buildingIndex : await prepareIndexingRun(activeIndex, {
      mode, building: buildingIndex, signal: metadataController.signal,
      previousIndex, selectedBookIds,
      onScan: (stats) => ui.setStatus(scanStatus(stats)),
    });
    prepared = true;
    resetProcessingBooks(buildingIndex);
    buildingIndex.buildState.status = 'building';
    delete buildingIndex.buildState.pauseReason;
    await saveCheckpoint(localCheckpointKey, buildingIndex);
    ui.setIndexingContinuation(null);
    if (mode !== 'full' && !buildingIndex.buildState.total) {
      await deleteCheckpoint(localCheckpointKey);
      buildingIndex = null;
      return;
    }
    const cachedCount = Math.max(0, buildingIndex.books.length - buildingIndex.buildState.total);
    const previousProgress = { ...buildingIndex.buildState.progress };
    const overallProgress = (progress) => ({
      ...progress, total: buildingIndex.buildState.total,
      ...Object.fromEntries(['processed', 'succeeded', 'recovered', 'failed', 'excluded']
        .map((key) => [key, (previousProgress[key] || 0) + (progress[key] || 0)])),
      skipped: cachedCount,
    });
    let stats = overallProgress({});
    ui.updateIndexingErrors(buildingIndex.indexingErrors || []);
    ui.setStatus(`${modeLabel}. Обработано: ${stats.processed} / ${stats.total}.`);
    const runStats = await indexPendingBooks(buildingIndex, {
      previousIndex: activeIndex,
      checkEligibility: retryErrors ? createRetryEligibilityCheck(buildingIndex, { signal: metadataController.signal }) : undefined,
      onErrors: (entries) => ui.updateIndexingErrors(entries),
      signal: metadataController.signal,
      onProgress: (progress) => {
        stats = overallProgress(progress);
        updateBuildProgress(buildingIndex, stats);
        ui.setStatus(`${modeLabel}. Обработано: ${stats.processed.toLocaleString('ru-RU')} / ${stats.total.toLocaleString('ru-RU')}. Успешно: ${stats.succeeded.toLocaleString('ru-RU')}. Восстановлено: ${stats.recovered.toLocaleString('ru-RU')}. Ошибок: ${stats.failed.toLocaleString('ru-RU')}. Исключено: ${stats.excluded}.`);
      },
      onCover: cacheBuildingCover,
      onLocalCheckpoint: async (index, progress, changedIds) => {
        updateBuildProgress(index, overallProgress(progress));
        await saveCheckpoint(localCheckpointKey, index, changedIds);
      },
    });
    stats = overallProgress(runStats);
    updateBuildProgress(buildingIndex, stats);
    buildingIndex.updatedAt = new Date().toISOString();
    await saveCheckpoint(localCheckpointKey, buildingIndex);
    buildingIndexFileId = await saveBuildingIndex(buildingIndex, buildingIndexFileId);
    if (metadataController.signal.aborted) {
      buildingIndex.buildState.status = 'paused';
      await saveCheckpoint(localCheckpointKey, buildingIndex);
      ui.setStatus(`Индексирование остановлено. Сохранено результатов: ${stats.processed.toLocaleString('ru-RU')}.`);
    } else {
      const manifest = buildingIndex.buildState;
      validateCompletedIndex(buildingIndex, activeIndex, manifest);
      const completed = validateCompletedIndex(
        await readIndexFile(buildingIndexFileId, activeIndex.rootFolderId), activeIndex, manifest);
      metadataController.signal.throwIfAborted();
      completed.updatedAt = new Date().toISOString();
      const committed = await commitCheckpoint(completed, {
        save: async (index) => { indexFileId = await saveIndex(index, indexFileId); return indexFileId; },
        read: async (id) => validateCompletedIndex(await readIndexFile(id, activeIndex.rootFolderId), activeIndex, manifest),
        remove: () => deleteCheckpoint(localCheckpointKey),
      });
      currentIndex = committed.index;
      shareableIndex = currentIndex;
      renderLibrary(currentIndex);
      if (hasMinimumBooks(currentIndex)) void publishLibrary(currentIndex).catch((error) => ui.showError(`Не удалось обновить каталог для друзей: ${socialError(error)}`));
      const obsoleteCovers = staleActiveCoverIds(activeIndex, currentIndex);
      const completedBuildingFileId = buildingIndexFileId;
      buildingIndex = null;
      buildingIndexFileId = null;
      try { await deleteBuildingIndex(completedBuildingFileId); } catch { /* Active index is already safely committed. */ }
      try { await removeCovers(obsoleteCovers); } catch { /* Orphan cleanup can be retried on the next load. */ }
      const preserved = (currentIndex.indexingErrors || []).filter((entry) => entry.previousEntryPreserved).length;
      ui.setStatus(`${modeLabel}. Всего: ${stats.total.toLocaleString('ru-RU')}. Успешно: ${stats.succeeded.toLocaleString('ru-RU')}. Восстановлено: ${stats.recovered.toLocaleString('ru-RU')}. Ошибок: ${stats.failed.toLocaleString('ru-RU')}. Исключено: ${stats.excluded}. Сохранены из предыдущего индекса: ${preserved}.`);
    }
  } catch (error) {
    if (prepared && buildingIndex) {
      reportOperationError(buildingIndex, error, 'index-write', buildingIndexFileId, 'secret-library-index-building.json');
      resetProcessingBooks(buildingIndex);
      buildingIndex.buildState.status = 'paused';
      buildingIndex.buildState.pauseReason = error.status === 401 || error.code === 'unauthorized' ? 'auth' : error.retryable ? 'network' : 'error';
      try {
        buildingIndex.updatedAt = new Date().toISOString();
        await saveCheckpoint(localCheckpointKey, buildingIndex);
      } catch (checkpointError) {
        reportOperationError(buildingIndex, checkpointError, 'index-write', buildingIndexFileId, 'secret-library-index-building.json');
      }
    }
    if (error.name !== 'AbortError') ui.showError(readableError(error));
    ui.setStatus(`${modeLabel} приостановлена. Обработано: ${buildingIndex?.buildState?.progress?.processed || 0} из ${buildingIndex?.buildState?.total || 0}.`);
  } finally {
    metadataController = null;
    ui.setMetadataRunning(false);
    ui.updateMetadataActions(currentIndex);
    showUnfinishedOperation();
    if (reconnectRequired) ui.setReconnectRequired(true);
  }
}

// Explicit programmatic entry point for a diagnostic retry; the UI action remains global.
export function retrySelectedBooks(bookIds) {
  if (!Array.isArray(bookIds) || !bookIds.length) {
    return Promise.reject(Object.assign(new Error('A selective retry requires an explicit non-empty Drive ID list.'),
      { code: 'invalid_retry_selection' }));
  }
  return runMetadataIndexing({ retryErrors: true, selectedBookIds: bookIds });
}

function stopMetadataIndexing() {
  if (!metadataController) return;
  ui.setStatus('Останавливаем индексирование и сохраняем результаты…');
  metadataController.abort();
}

async function afterAuthorization() {
  const user = await getCurrentDriveUser();
  if (!user.emailAddress) throw new Error('Google не вернул идентификатор пользователя.');
  const sameOwner = authorizedOwner === user.emailAddress;
  if (authorizedOwner && !sameOwner) {
    sharingVersion++; shareableIndex = null; currentIndex = null;
    selection.reset(); tabsRoot.hidden = true; ui.resetUi();
  }
  authorizedOwner = user.emailAddress;
  libraryAccessGranted = false;
  tabsRoot.hidden = true;
  activeRootFolderId = await loadRootFolderPreference();
  activeRootFolderResourceKey = activeRootFolderId ? await loadRootFolderResourceKey() : '';
  if (activeRootFolderId) {
    const savedRoot = await getFolder(activeRootFolderId, { resourceKey: activeRootFolderResourceKey });
    const driveRoot = await getFolder('root');
    if (!Array.isArray(savedRoot.parents) || !savedRoot.parents.includes(driveRoot.id)) {
      activeRootFolderId = null;
      activeRootFolderResourceKey = '';
    }
  }
  persistAuthSession(user);
  if (!activeRootFolderId) {
    ui.setAuthorized(true);
    ui.setStatus('Выберите корневую папку вашей библиотеки.');
    const folder = await chooseRootFolder({ listChildren: listFolderChildren, getFolder, scanFolder: scanLibrary });
    if (!folder) {
      ui.setStatus('Корневая папка не выбрана. Выберите её через личное меню.');
      return;
    }
    await saveRootFolderPreference(folder.id, folder.resourceKey);
    activeRootFolderId = folder.id;
    activeRootFolderResourceKey = folder.resourceKey;
  }
  localCheckpointKey = checkpointKey(authorizedOwner, activeRootFolderId);
  reconnectRequired = false;
  ui.setReconnectRequired(false);
  ui.setAuthorized(true);
  // The optional checkLibraryAccess callable is not deployed in the free Firebase project.
  // Admin display labels are resolved from the registered administrator UID in social-store.
  void social.connect(getAccessToken(), activeRootFolderId);
  void ui.setUserAvatar(user);
  ui.clearError();
  if (sameOwner && currentIndex) {
    // A previously rejected library may have gained books in Drive since the last scan.
    // Refresh the stale index before asking the user to choose another root folder.
    if (!hasMinimumBooks(currentIndex)) { await rebuildIndex(); return; }
    if (!await ensureMinimumBookAccess(currentIndex)) return;
    renderLibrary(currentIndex);
    if (buildingIndex && !metadataController) await runMetadataIndexing({ resume: true });
    return;
  }
  currentIndex = null;
  buildingIndex = null;
  buildingIndexFileId = null;
  indexFileId = null;
  ui.setIndexingContinuation(null);
  ui.setStatus('Проверяем сохраненный индекс…');
  try {
    const saved = await loadIndex(activeRootFolderId);
    indexFileId = saved.fileId;
    if (saved.index) {
      currentIndex = saved.index;
      refreshCommitUncertain = false;
      // The saved index may be stale if the user added books after the previous scan.
      // Refresh Drive first; enforce the minimum against the fresh scan, not the old cache.
      if (!hasMinimumBooks(currentIndex)) { await rebuildIndex(); return; }
      if (!await ensureMinimumBookAccess(currentIndex)) return;
      if (saved.migrated) {
        saved.index.updatedAt = new Date().toISOString();
        indexFileId = await saveIndex(saved.index, indexFileId);
      }
      shareableIndex = currentIndex;
      const local = await loadCheckpoint(localCheckpointKey);
      try {
        const draft = local ? { index: local, fileId: null } : await loadBuildingIndex(activeRootFolderId);
        buildingIndexFileId = draft.fileId;
        const mode = draft.index?.buildState?.mode || 'incremental';
        buildingIndex = canResumeBuildingIndex(draft.index, currentIndex, { mode }) ? draft.index : null;
        if (local && !buildingIndex) await deleteCheckpoint(localCheckpointKey);
      } catch (error) {
        buildingIndex = null;
        buildingIndexFileId = null;
        throw error;
      }
      renderLibrary(currentIndex);
      if (hasMinimumBooks(currentIndex)) void publishLibrary(currentIndex).catch((error) => ui.showError(`Не удалось обновить каталог для друзей: ${socialError(error)}`));
      ui.updateIndexingErrors(buildingIndex?.indexingErrors || currentIndex.indexingErrors || []);
      const coverIndex = buildingIndex
        ? { books: [...currentIndex.books, ...buildingIndex.books] }
        : currentIndex;
      void removeOrphanCovers(coverIndex).catch(() => {});
      ui.setStatus('Показан сохраненный индекс. При необходимости обновите библиотеку.');
      showUnfinishedOperation();
      if (buildingIndex) ui.setStatus(`Индексация приостановлена: ${buildingIndex.buildState.progress.processed} из ${buildingIndex.buildState.total}. Можно продолжить.`);
      else if (local) await rebuildIndex();
      return;
    }
    await rebuildIndex();
  } catch (error) {
    const canRebuild = error instanceof IndexError;
    if (error.fileId) indexFileId = error.fileId;
    ui.showError(readableError(error), { canRebuild });
    ui.setStatus(canRebuild ? 'Сохраненный индекс недоступен. Можно построить его заново.' : 'Не удалось открыть библиотеку.');
  }
}

async function changeRootFolder() {
  if (!authorizedOwner || metadataController || libraryRefresher.running) return;
  ui.clearError();
  try {
    const folder = await chooseRootFolder({ listChildren: listFolderChildren, getFolder, scanFolder: scanLibrary });
    if (!folder || folder.id === activeRootFolderId) return;
    if (!window.confirm(`Сменить корневую папку на «${folder.name}»? Текущий каталог останется сохранён, а для новой папки будет создан отдельный индекс.`)) return;
    await saveRootFolderPreference(folder.id, folder.resourceKey);
    const url = new URL(window.location.href);
    url.searchParams.delete('library');
    window.history.replaceState(null, '', url);
    ui.setStatus(`Корневая папка изменена на «${folder.name}». Загружаем её библиотеку…`);
    window.location.reload();
  } catch (error) {
    ui.showError(readableError(error));
  }
}

async function signIn() {
  if (metadataController) return;
  const attempt = authAttempts.begin();
  ui.clearError();
  ui.setBusy(true);
  ui.setStatus('Ожидаем авторизацию Google…');
  try {
    await requestAccessToken({ prompt: '' });
    if (!authAttempts.isCurrent(attempt)) {
      clearAccessToken();
      return;
    }
    await afterAuthorization();
  } catch (error) {
    if (authAttempts.isCurrent(attempt)) {
      ui.showError(readableError(error));
      ui.setStatus('Авторизация не завершена.');
    }
  } finally {
    ui.setBusy(false);
  }
}

function signOut() {
  sharingVersion++; shareableIndex = null;
  selection.reset(); tabsRoot.hidden = true;
  authAttempts.invalidate();
  clearPersistedAuth({ forget: true });
  clearAccessToken({ revoke: true });
  indexFileId = null;
  currentIndex = null;
  buildingIndex = null;
  buildingIndexFileId = null;
  localCheckpointKey = null;
  authorizedOwner = null;
  ui.setIndexingContinuation(null);
  ui.setReconnectRequired(false);
  ui.setAuthorized(false);
  ui.resetUi();
  ui.setStatus('Вы вышли. Для доступа к библиотеке войдите через Google.');
}

const runOnOwnLibrary = (action) => async () => {
  if (selection.selected) selection.select('');
  await action();
};

ui.bindActions({
  settingsError: (error) => ui.showError(readableError(error)),
  home: () => ui.showLibraryHome(),
  signIn,
  refresh: runOnOwnLibrary(rebuildIndex),
  changeRootFolder,
  rebuild: rebuildIndex,
  signOut,
  indexMetadata: runOnOwnLibrary(() => runMetadataIndexing()),
  retryMetadata: runOnOwnLibrary(() => runMetadataIndexing({ retryErrors: true })),
  stopMetadata: stopMetadataIndexing,
});

async function restoreAuthorization() {
  const attempt = authAttempts.begin();
  const recovered = await recoverAuthSession();
  if (!authAttempts.isCurrent(attempt)) {
    clearAccessToken();
    return;
  }
  if (recovered) {
    await afterAuthorization();
  } else {
    clearPersistedAuth();
    clearAccessToken();
    ui.setAuthorized(false);
    ui.setStatus('Для доступа к библиотеке войдите через Google.');
  }
}

ui.setBusy(true);
try {
  // Keep the sign-in button disabled until Google Identity Services is ready.
  // Otherwise an early first click can race initializeAuth() and fail before
  // the OAuth token client exists, forcing the user to click a second time.
  await initializeAuth();
  ui.setBusy(false);
  await restoreAuthorization();
} catch (error) {
  ui.showError(readableError(error));
  ui.setBusy(false);
}

const sharedSearchQuery = new URLSearchParams(window.location.search).get('q');
if (sharedSearchQuery) {
  const quickSearchInput = document.querySelector('#quick-search-input');
  if (quickSearchInput) quickSearchInput.value = sharedSearchQuery;
}
const headerAction = window.location.hash.slice(1);
const headerActionButtons = {
  'sign-in': '#sign-in-button', settings: '#settings-button', refresh: '#refresh-button',
  'change-root': '#change-root-folder-button', metadata: '#metadata-button', retry: '#retry-metadata-button',
  'sign-out': '#sign-out-button', search: '#book-search-button', notifications: '#notifications-button',
};
if (headerActionButtons[headerAction]) {
  document.querySelector(headerActionButtons[headerAction])?.click();
}
import {
  clearAccessToken, clearPersistedAuth, createAuthAttemptGuard,
  initializeAuth, persistAuthSession, recoverAuthSession, requestAccessToken,
} from './auth.js';
import { ROOT_FOLDER_ID } from './config.js';
import { downloadDriveFile, getCurrentDriveUser } from './drive.js';
import { removeCovers, removeOrphanCovers, storeCover } from './cover-cache.js';
import {
  deleteBuildingIndex, IndexError, loadBuildingIndex, loadIndex, readIndexFile,
  saveBuildingIndex, saveIndex,
} from './library-index.js';
import { createLibraryRefresher, scanStatus, scanFailureMessage } from './library-refresh.js';
import { indexPendingBooks, resetProcessingBooks } from './metadata-indexer.js';
import {
  canResumeBuildingIndex, updateBuildProgress, validateCompletedIndex,
} from './index-build.js';
import { prepareIndexingRun, createRetryEligibilityCheck } from './indexing-run.js';
import * as ui from './ui.js';
import { errorDetails, recordIndexingError } from './indexing-errors.js';
import { social } from './social-runtime.js';
import { getAccessToken } from './auth.js';
import { checkpointKey, loadCheckpoint, saveCheckpoint, deleteCheckpoint, commitCheckpoint } from './indexing-checkpoint.js';
import { createLibraryTabs } from './library-tabs.js';
import { createLibrarySelection } from './library-selection.js';
import { loadUserSettings } from './user-settings.js';
import { firebaseConfigured } from './firebase-config.js';

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
let reconnectRequired = false;
const authAttempts = createAuthAttemptGuard();
const tabsRoot = document.querySelector('#library-tabs');
const tabs = createLibraryTabs(tabsRoot, (uid) => selection.select(uid));
const selection = createLibrarySelection({ tabs, service: social,
  show: (index, { own, ownerIndex }) => {
    tabsRoot.hidden = false;
    ui.renderLibrary(index, downloadBook, { ownerIndex, readOnly: !own,
      onSettingsSaved: (index, settings) => publishLibrary(shareableIndex || index, settings),
      beforeSettingsSave: () => { sharingVersion++; return firebaseConfigured() ? social.unpublishLibrary() : Promise.resolve(); } });
  },
  unavailable: (message, goHome) => { tabsRoot.hidden = false; ui.showLibraryUnavailable(message, goHome); },
});
async function publishLibrary(index, settings = null) {
  if (!social.ready) return;
  const version = sharingVersion;
  const owner = authorizedOwner;
  const loaded = settings || (await loadUserSettings(index)).settings;
  if (version !== sharingVersion || owner !== authorizedOwner) return;
  await social.publishLibrary(index, loaded);
}
let publishingFor = null;
social.subscribe((state) => {
  if (state.status !== 'ready') { publishingFor = null; return; }
  if (shareableIndex && publishingFor !== shareableIndex) {
    publishingFor = shareableIndex;
    void publishLibrary(shareableIndex).catch((error) => { ui.showError(`Не удалось обновить каталог для друзей: ${error.message}`); });
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
    ui.saveDownloadedFile(await downloadDriveFile(book.id), book.fileName);
  } catch (error) {
    ui.showError(readableError(error));
  }
}

function renderLibrary(index) {
  selection.setOwn(index);
}

const libraryRefresher = createLibraryRefresher({
  save: saveIndex,
  apply: (index) => { currentIndex = index; renderLibrary(index); },
  removeCovers,
  onProgress: (stats) => { ui.setStatus(scanStatus(stats)); ui.showStats(stats.processedFolders, stats.books); },
  onPhase: () => ui.setStatus('Сканирование завершено. Новая структура применена. Сохраняем индекс…'),
  onCleanupError: (error) => reportOperationError(currentIndex, error, 'cover'),
});

async function rebuildIndex() {
  if (metadataController || libraryRefresher.running) return;
  if (buildingIndex) return runMetadataIndexing({ resume: true });
  ui.clearError();
  ui.setBusy(true);
  ui.setStatus('Сканирование библиотеки… Обработано папок: 0. В очереди: 1. Найдено книг: 0.');
  try {
    const result = await libraryRefresher.run({ activeIndex: currentIndex, rootFolderId: ROOT_FOLDER_ID, fileId: indexFileId });
    if (!result) return;
    indexFileId = result.fileId;
    shareableIndex = result.index;
    void publishLibrary(result.index).catch((error) => ui.showError(`Не удалось обновить каталог для друзей: ${error.message}`));
    ui.setStatus(`Библиотека обновлена: ${result.index.books.length.toLocaleString('ru-RU')} книг.`);
    await runMetadataIndexing({ refreshOnly: true });
  } catch (error) {
    reportOperationError(currentIndex || {}, error, error.stage || 'list', error.folderId || ROOT_FOLDER_ID);
    if (error.status === 401 || error.code === 'unauthorized') ui.showError(readableError(error));
    else ui.showError(error.stage === 'index-write' ? readableError(error) : scanFailureMessage(error), { canRebuild: true });
    ui.setStatus(error.stage === 'index-write' ? 'Новая структура показана в этой вкладке. Сохранить индекс не удалось; прежний сохранённый индекс и обложки оставлены.' : scanFailureMessage(error));
  } finally {
    ui.setBusy(false);
  }
}

async function runMetadataIndexing({ retryErrors = false, refreshOnly = false, resume = false } = {}) {
  if (!currentIndex || metadataController || (libraryRefresher.running && !refreshOnly)) return;
  if (buildingIndex && !resume) {
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
  const mode = resume ? buildingIndex.buildState.mode : refreshOnly ? 'refresh' : retryErrors ? 'retry' : 'full';
  if (!resume && mode === 'full' && !window.confirm('Переиндексировать всю библиотеку? Будут повторно обработаны все книги.')) return;
  const modeLabel = refreshOnly ? 'Индексация новых и изменённых книг' : retryErrors ? 'Повторная обработка ошибок' : 'Полная переиндексация';
  metadataController = new AbortController();
  ui.clearError();
  ui.setMetadataRunning(true);
  ui.setStatus(`${modeLabel}…`);
  let prepared = false;
  try {
    buildingIndex = resume ? buildingIndex : await prepareIndexingRun(activeIndex, {
      mode, building: buildingIndex, signal: metadataController.signal,
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
      void publishLibrary(currentIndex).catch((error) => ui.showError(`Не удалось обновить каталог для друзей: ${error.message}`));
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
  localCheckpointKey = checkpointKey(authorizedOwner, ROOT_FOLDER_ID);
  reconnectRequired = false;
  ui.setReconnectRequired(false);
  ui.setAuthorized(true);
  void social.connect(getAccessToken());
  persistAuthSession(user);
  void ui.setUserAvatar(user);
  ui.clearError();
  if (sameOwner && currentIndex) {
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
    const saved = await loadIndex(ROOT_FOLDER_ID);
    indexFileId = saved.fileId;
    if (saved.index) {
      currentIndex = saved.index;
      if (saved.migrated) {
        saved.index.updatedAt = new Date().toISOString();
        indexFileId = await saveIndex(saved.index, indexFileId);
      }
      shareableIndex = currentIndex;
      const local = await loadCheckpoint(localCheckpointKey);
      try {
        const draft = local ? { index: local, fileId: null } : await loadBuildingIndex(ROOT_FOLDER_ID);
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
      void publishLibrary(currentIndex).catch((error) => ui.showError(`Не удалось обновить каталог для друзей: ${error.message}`));
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

ui.bindActions({
  settingsError: (error) => ui.showError(readableError(error)),
  home: () => ui.showLibraryHome(),
  signIn,
  refresh: rebuildIndex,
  rebuild: rebuildIndex,
  signOut,
  indexMetadata: () => runMetadataIndexing(),
  retryMetadata: () => runMetadataIndexing({ retryErrors: true }),
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

try {
  await initializeAuth();
  await restoreAuthorization();
} catch (error) {
  ui.showError(readableError(error));
  ui.setBusy(false);
}

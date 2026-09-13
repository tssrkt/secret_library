import {
  clearAccessToken, clearPersistedAuth, createAuthAttemptGuard,
  initializeAuth, persistAuthSession, recoverAuthSession, requestAccessToken,
} from './auth.js';
import { ROOT_FOLDER_ID } from './config.js';
import { downloadDriveFile, getCurrentDriveUser } from './drive.js';
import { applyDriveAvatar } from './avatar.js';
import { removeCovers, removeOrphanCovers, storeCover } from './cover-cache.js';
import {
  deleteBuildingIndex, IndexError, loadBuildingIndex, loadIndex, readIndexFile,
  saveBuildingIndex, saveIndex,
} from './library-index.js';
import { preserveBookMetadata, scanLibrary, staleCoverFileIds } from './library-tree.js';
import { indexPendingBooks, resetProcessingBooks } from './metadata-indexer.js';
import {
  canResumeBuildingIndex, prepareBuildingIndex, updateBuildProgress, validateCompletedIndex,
} from './index-build.js';
import * as ui from './ui.js';
import { errorDetails, recordIndexingError } from './indexing-errors.js';

function reportOperationError(index, error, stage, fileId = '', fileName = '') {
  if (!index || error.indexingLogged) return;
  recordIndexingError(index, { id: error.fileId || fileId, fileName }, [errorDetails(error, { stage: error.stage || stage })], { outcome: 'interrupted' });
  error.indexingLogged = true;
  ui.updateIndexingErrors(index.indexingErrors);
}

let indexFileId = null;
let currentIndex = null;
let buildingIndex = null;
let buildingIndexFileId = null;
let metadataController = null;
let avatarRequestId = 0;
const authAttempts = createAuthAttemptGuard();

async function cacheBuildingCover(book, cover) {
  return cover ? storeCover(book, cover) : { coverFileId: null, coverMimeType: null };
}

function staleActiveCoverIds(activeIndex, nextIndex) {
  const nextCoverIds = new Set(nextIndex.books.map((book) => book.coverFileId).filter(Boolean));
  return activeIndex.books.map((book) => book.coverFileId).filter((id) => id && !nextCoverIds.has(id));
}

function readableError(error) {
  if (error?.status === 401 || error?.code === 'unauthorized') {
    clearPersistedAuth();
    clearAccessToken();
    ui.setAuthorized(false);
    return 'Сеанс Google истек. Войдите снова, чтобы продолжить.';
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
  ui.renderLibrary(index, downloadBook);
}

async function rebuildIndex() {
  ui.clearError();
  ui.setBusy(true);
  ui.setStatus('Сканирование библиотеки…');
  try {
    const scannedIndex = await scanLibrary(ROOT_FOLDER_ID, ({ processedFolders, books }) => {
      ui.setStatus(`Сканирование библиотеки… Обработано папок: ${processedFolders}. Найдено книг: ${books}.`);
      ui.showStats(processedFolders, books);
    });
    const obsoleteCovers = staleCoverFileIds(scannedIndex, currentIndex);
    const index = preserveBookMetadata(scannedIndex, currentIndex);
    try { await removeCovers(obsoleteCovers); }
    catch (error) { ui.showError(`Не удалось полностью очистить старый кеш обложек: ${error.message}`); }
    currentIndex = index;
    renderLibrary(index);
    ui.setStatus('Сканирование завершено. Сохраняем индекс…');
    try {
      indexFileId = await saveIndex(index, indexFileId);
      ui.setStatus(`Библиотека обновлена: ${index.books.length.toLocaleString('ru-RU')} книг.`);
    } catch (error) {
      reportOperationError(index, error, 'index-write', indexFileId, 'secret-library-index.json');
      ui.setStatus('Сканирование завершено, библиотека доступна в этой вкладке.');
      ui.showError(readableError(error), { canRebuild: false });
    }
  } catch (error) {
    reportOperationError(currentIndex || {}, error, 'list', ROOT_FOLDER_ID);
    ui.showError(readableError(error), { canRebuild: true });
    ui.setStatus('Не удалось обновить библиотеку.');
  } finally {
    ui.setBusy(false);
  }
}

async function runMetadataIndexing({ retryErrors = false } = {}) {
  if (!currentIndex || metadataController) return;
  const activeIndex = currentIndex;
  const resumable = canResumeBuildingIndex(buildingIndex, activeIndex, { retryErrors });
  if (!resumable) buildingIndex = prepareBuildingIndex(activeIndex, { retryErrors });
  if (!buildingIndex.buildState.total) return;
  const cachedCount = activeIndex.books.length - buildingIndex.buildState.total;
  const previousProgress = { ...buildingIndex.buildState.progress };
  const overallProgress = (progress) => ({
    ...progress,
    total: buildingIndex.buildState.total,
    processed: (previousProgress.processed || 0) + progress.processed,
    succeeded: (previousProgress.succeeded || 0) + progress.succeeded,
    failed: (previousProgress.failed || 0) + progress.failed,
    skipped: cachedCount,
  });

  metadataController = new AbortController();
  ui.updateIndexingErrors(buildingIndex.indexingErrors || []);
  ui.clearError();
  ui.setMetadataRunning(true);
  ui.setStatus(`Индексирование FB2… Обработано: ${(previousProgress.processed || 0).toLocaleString('ru-RU')} / ${buildingIndex.buildState.total.toLocaleString('ru-RU')}. Из кеша: ${cachedCount.toLocaleString('ru-RU')}.`);
  let stats = {
    total: buildingIndex.buildState.total,
    processed: previousProgress.processed || 0,
    succeeded: previousProgress.succeeded || 0,
    skipped: cachedCount,
    failed: previousProgress.failed || 0,
  };
  try {
    const runStats = await indexPendingBooks(buildingIndex, {
      previousIndex: activeIndex,
      onErrors: (entries) => ui.updateIndexingErrors(entries),
      signal: metadataController.signal,
      onProgress: (progress) => {
        stats = overallProgress(progress);
        updateBuildProgress(buildingIndex, stats);
        ui.setStatus(`Индексирование FB2… Обработано: ${stats.processed.toLocaleString('ru-RU')} / ${stats.total.toLocaleString('ru-RU')}. Успешно: ${stats.succeeded.toLocaleString('ru-RU')}. Из кеша: ${stats.skipped.toLocaleString('ru-RU')}. Ошибок: ${stats.failed.toLocaleString('ru-RU')}.`);
      },
      onCover: cacheBuildingCover,
      onCheckpoint: async (index, progress) => {
        updateBuildProgress(index, overallProgress(progress));
        buildingIndexFileId = await saveBuildingIndex(index, buildingIndexFileId);
      },
    });
    stats = overallProgress(runStats);
    updateBuildProgress(buildingIndex, stats);
    buildingIndex.updatedAt = new Date().toISOString();
    buildingIndexFileId = await saveBuildingIndex(buildingIndex, buildingIndexFileId);
    if (metadataController.signal.aborted) {
      ui.setStatus(`Индексирование остановлено. Сохранено результатов: ${stats.processed.toLocaleString('ru-RU')}.`);
    } else {
      const completed = validateCompletedIndex(buildingIndex, activeIndex);
      completed.updatedAt = new Date().toISOString();
      indexFileId = await saveIndex(completed, indexFileId);
      const verified = validateCompletedIndex(await readIndexFile(indexFileId, ROOT_FOLDER_ID), activeIndex);
      currentIndex = verified;
      renderLibrary(currentIndex);
      const obsoleteCovers = staleActiveCoverIds(activeIndex, currentIndex);
      const completedBuildingFileId = buildingIndexFileId;
      buildingIndex = null;
      buildingIndexFileId = null;
      try { await deleteBuildingIndex(completedBuildingFileId); } catch { /* Active index is already safely committed. */ }
      try { await removeCovers(obsoleteCovers); } catch { /* Orphan cleanup can be retried on the next load. */ }
      const preserved = (currentIndex.indexingErrors || []).filter((entry) => entry.previousEntryPreserved).length;
      ui.setStatus(`Всего: ${stats.total.toLocaleString('ru-RU')}. Успешно: ${stats.succeeded.toLocaleString('ru-RU')}. Из кеша: ${stats.skipped.toLocaleString('ru-RU')}. Ошибок: ${stats.failed.toLocaleString('ru-RU')}. Сохранены из предыдущего индекса: ${preserved}.`);
    }
  } catch (error) {
    reportOperationError(buildingIndex, error, 'index-write', buildingIndexFileId, 'secret-library-index-building.json');
    resetProcessingBooks(buildingIndex);
    try {
      buildingIndex.updatedAt = new Date().toISOString();
      buildingIndexFileId = await saveBuildingIndex(buildingIndex, buildingIndexFileId);
    } catch (checkpointError) {
      reportOperationError(buildingIndex, checkpointError, 'index-write', buildingIndexFileId, 'secret-library-index-building.json');
    }
    ui.showError(readableError(error));
    ui.setStatus('Индексирование FB2 прервано. Рабочая библиотека не изменена. Подробности и ошибки сохранения — в журнале.');
  } finally {
    metadataController = null;
    ui.setMetadataRunning(false);
    ui.updateMetadataActions(currentIndex);
  }
}

function stopMetadataIndexing() {
  if (!metadataController) return;
  ui.setStatus('Останавливаем индексирование и сохраняем результаты…');
  metadataController.abort();
}

async function afterAuthorization({ restoredUser = null } = {}) {
  ui.setAuthorized(true);
  persistAuthSession(restoredUser || {});
  const requestId = ++avatarRequestId;
  if (restoredUser) {
    void ui.setUserAvatar(restoredUser);
  } else {
    void applyDriveAvatar(
      async () => (requestId === avatarRequestId ? getCurrentDriveUser() : null),
      (user) => {
        if (requestId !== avatarRequestId) return false;
        persistAuthSession(user || {});
        return ui.setUserAvatar(user);
      },
    );
  }
  ui.clearError();
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
      try {
        const draft = await loadBuildingIndex(ROOT_FOLDER_ID);
        buildingIndexFileId = draft.fileId;
        const retryErrors = Boolean(draft.index?.buildState?.retryErrors);
        buildingIndex = canResumeBuildingIndex(draft.index, currentIndex, { retryErrors }) ? draft.index : null;
      } catch {
        buildingIndex = null;
        buildingIndexFileId = null;
      }
      renderLibrary(currentIndex);
      ui.updateIndexingErrors(buildingIndex?.indexingErrors || currentIndex.indexingErrors || []);
      const coverIndex = buildingIndex
        ? { books: [...currentIndex.books, ...buildingIndex.books] }
        : currentIndex;
      void removeOrphanCovers(coverIndex).catch(() => {});
      ui.setStatus('Показан сохраненный индекс. При необходимости обновите библиотеку.');
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
  const attempt = authAttempts.begin();
  ui.clearError();
  ui.setBusy(true);
  ui.setStatus('Ожидаем авторизацию Google…');
  try {
    await requestAccessToken({ prompt: 'consent' });
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
  authAttempts.invalidate();
  avatarRequestId += 1;
  clearPersistedAuth({ forget: true });
  clearAccessToken({ revoke: true });
  indexFileId = null;
  currentIndex = null;
  buildingIndex = null;
  buildingIndexFileId = null;
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
    await afterAuthorization({ restoredUser: recovered.mode === 'session' ? recovered.user : null });
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
  ui.setBusy(true);
}

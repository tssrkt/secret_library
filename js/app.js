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
  canResumeBuildingIndex, updateBuildProgress, validateCompletedIndex,
} from './index-build.js';
import { prepareIndexingRun, createRetryEligibilityCheck } from './indexing-run.js';
import * as ui from './ui.js';
import { errorDetails, recordIndexingError } from './indexing-errors.js';
import { social } from './social-runtime.js';
import { getAccessToken } from './auth.js';

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
  if (metadataController) return;
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
      await runMetadataIndexing({ refreshOnly: true });
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

async function runMetadataIndexing({ retryErrors = false, refreshOnly = false } = {}) {
  if (!currentIndex || metadataController) return;
  if (refreshOnly && !currentIndex.books.some((book) => ['pending', 'processing'].includes(book.metadataStatus))) return;
  const activeIndex = currentIndex;
  const mode = refreshOnly ? 'refresh' : retryErrors ? 'retry' : 'full';
  if (mode === 'full' && !window.confirm('Переиндексировать всю библиотеку? Будут повторно обработаны все книги.')) return;
  const modeLabel = refreshOnly ? 'Индексация новых и изменённых книг' : retryErrors ? 'Повторная обработка ошибок' : 'Полная переиндексация';
  metadataController = new AbortController();
  ui.clearError();
  ui.setMetadataRunning(true);
  ui.setStatus(`${modeLabel}…`);
  let prepared = false;
  try {
    buildingIndex = await prepareIndexingRun(activeIndex, {
      mode, building: buildingIndex, signal: metadataController.signal,
      onScan: ({ processedFolders, books }) => ui.setStatus(
        `${modeLabel} — сканирование. Папок: ${processedFolders}. Найдено книг: ${books}.`),
    });
    prepared = true;
    resetProcessingBooks(buildingIndex);
    if (mode !== 'full' && !buildingIndex.buildState.total) return;
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
      const manifest = buildingIndex.buildState;
      validateCompletedIndex(buildingIndex, activeIndex, manifest);
      const completed = validateCompletedIndex(
        await readIndexFile(buildingIndexFileId, activeIndex.rootFolderId), activeIndex, manifest);
      metadataController.signal.throwIfAborted();
      completed.updatedAt = new Date().toISOString();
      indexFileId = await saveIndex(completed, indexFileId);
      const verified = validateCompletedIndex(await readIndexFile(indexFileId, activeIndex.rootFolderId), activeIndex, manifest);
      currentIndex = verified;
      renderLibrary(currentIndex);
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
      try {
        buildingIndex.updatedAt = new Date().toISOString();
        buildingIndexFileId = await saveBuildingIndex(buildingIndex, buildingIndexFileId);
      } catch (checkpointError) {
        reportOperationError(buildingIndex, checkpointError, 'index-write', buildingIndexFileId, 'secret-library-index-building.json');
      }
    }
    if (error.name !== 'AbortError') ui.showError(readableError(error));
    ui.setStatus(`${modeLabel} прервана. Рабочая библиотека остаётся доступной.`);
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
  void social.connect(getAccessToken());
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
        const mode = draft.index?.buildState?.mode || 'incremental';
        buildingIndex = canResumeBuildingIndex(draft.index, currentIndex, { mode }) ? draft.index : null;
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

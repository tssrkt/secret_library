import { clearAccessToken, initializeAuth, requestAccessToken } from './auth.js';
import { ROOT_FOLDER_ID } from './config.js';
import { IndexError, loadIndex, saveIndex } from './library-index.js';
import { preserveBookMetadata, scanLibrary } from './library-tree.js';
import { indexPendingBooks, resetProcessingBooks, retryMetadataErrors } from './metadata-indexer.js';
import * as ui from './ui.js';

let indexFileId = null;
let currentIndex = null;
let metadataController = null;

function readableError(error) {
  if (error?.status === 401 || error?.code === 'unauthorized') {
    clearAccessToken();
    ui.setAuthorized(false);
    return 'Сеанс Google истек. Войдите снова, чтобы продолжить.';
  }
  return error?.message || 'Произошла непредвиденная ошибка.';
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
    const index = preserveBookMetadata(scannedIndex, currentIndex);
    currentIndex = index;
    ui.renderLibrary(index);
    ui.setStatus('Сканирование завершено. Сохраняем индекс…');
    try {
      indexFileId = await saveIndex(index, indexFileId);
      ui.setStatus(`Библиотека обновлена: ${index.books.length.toLocaleString('ru-RU')} книг.`);
    } catch (error) {
      ui.setStatus('Сканирование завершено, библиотека доступна в этой вкладке.');
      ui.showError(readableError(error), { canRebuild: false });
    }
  } catch (error) {
    ui.showError(readableError(error), { canRebuild: true });
    ui.setStatus('Не удалось обновить библиотеку.');
  } finally {
    ui.setBusy(false);
  }
}

async function runMetadataIndexing({ retryErrors = false } = {}) {
  if (!currentIndex || metadataController) return;
  if (retryErrors) retryMetadataErrors(currentIndex);
  const pendingCount = currentIndex.books.filter((book) => book.metadataStatus === 'pending').length;
  if (!pendingCount) return;

  metadataController = new AbortController();
  ui.clearError();
  ui.setMetadataRunning(true);
  ui.setStatus(`Индексирование FB2… Обработано: 0 / ${pendingCount.toLocaleString('ru-RU')}.`);
  let stats = { total: pendingCount, processed: 0, succeeded: 0, failed: 0 };
  try {
    stats = await indexPendingBooks(currentIndex, {
      signal: metadataController.signal,
      onProgress: (progress) => {
        stats = progress;
        ui.setStatus(`Индексирование FB2… Обработано: ${progress.processed.toLocaleString('ru-RU')} / ${progress.total.toLocaleString('ru-RU')}. Успешно: ${progress.succeeded.toLocaleString('ru-RU')}. Ошибок: ${progress.failed.toLocaleString('ru-RU')}.`);
      },
      onCheckpoint: async (index) => {
        indexFileId = await saveIndex(index, indexFileId);
      },
    });
    currentIndex.updatedAt = new Date().toISOString();
    indexFileId = await saveIndex(currentIndex, indexFileId);
    if (metadataController.signal.aborted) {
      ui.setStatus(`Индексирование остановлено. Сохранено результатов: ${stats.processed.toLocaleString('ru-RU')}.`);
    } else {
      ui.setStatus(`Обработано ${stats.processed.toLocaleString('ru-RU')} книг. Успешно: ${stats.succeeded.toLocaleString('ru-RU')}. Ошибок: ${stats.failed.toLocaleString('ru-RU')}.`);
    }
  } catch (error) {
    resetProcessingBooks(currentIndex);
    try {
      currentIndex.updatedAt = new Date().toISOString();
      indexFileId = await saveIndex(currentIndex, indexFileId);
    } catch { /* The original error is more useful, commonly an expired token. */ }
    ui.showError(readableError(error));
    ui.setStatus('Индексирование FB2 прервано. Уже сохраненные checkpoints не потеряны.');
  } finally {
    metadataController = null;
    ui.setMetadataRunning(false);
    ui.renderLibrary(currentIndex);
  }
}

function stopMetadataIndexing() {
  if (!metadataController) return;
  ui.setStatus('Останавливаем индексирование и сохраняем результаты…');
  metadataController.abort();
}

async function afterAuthorization() {
  ui.setAuthorized(true);
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
      ui.renderLibrary(saved.index);
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
  ui.clearError();
  ui.setBusy(true);
  ui.setStatus('Ожидаем авторизацию Google…');
  try {
    await requestAccessToken({ prompt: 'consent' });
    await afterAuthorization();
  } catch (error) {
    ui.showError(readableError(error));
    ui.setStatus('Авторизация не завершена.');
  } finally {
    ui.setBusy(false);
  }
}

function signOut() {
  clearAccessToken({ revoke: true });
  indexFileId = null;
  currentIndex = null;
  ui.setAuthorized(false);
  ui.resetUi();
  ui.setStatus('Вы вышли. Для доступа к библиотеке войдите через Google.');
}

ui.bindActions({
  signIn,
  refresh: rebuildIndex,
  rebuild: rebuildIndex,
  signOut,
  indexMetadata: () => runMetadataIndexing(),
  retryMetadata: () => runMetadataIndexing({ retryErrors: true }),
  stopMetadata: stopMetadataIndexing,
});

try {
  await initializeAuth();
} catch (error) {
  ui.showError(readableError(error));
  ui.setBusy(true);
}

import { clearAccessToken, initializeAuth, requestAccessToken } from './auth.js';
import { ROOT_FOLDER_ID } from './config.js';
import { IndexError, loadIndex, saveIndex } from './library-index.js';
import { scanLibrary } from './library-tree.js';
import * as ui from './ui.js';

let indexFileId = null;

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
    const index = await scanLibrary(ROOT_FOLDER_ID, ({ processedFolders, books }) => {
      ui.setStatus(`Сканирование библиотеки… Обработано папок: ${processedFolders}. Найдено книг: ${books}.`);
      ui.showStats(processedFolders, books);
    });
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

async function afterAuthorization() {
  ui.setAuthorized(true);
  ui.clearError();
  ui.setStatus('Проверяем сохраненный индекс…');
  try {
    const saved = await loadIndex(ROOT_FOLDER_ID);
    indexFileId = saved.fileId;
    if (saved.index) {
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
  ui.setAuthorized(false);
  ui.resetUi();
  ui.setStatus('Вы вышли. Для доступа к библиотеке войдите через Google.');
}

ui.bindActions({ signIn, refresh: rebuildIndex, rebuild: rebuildIndex, signOut });

try {
  await initializeAuth();
} catch (error) {
  ui.showError(readableError(error));
  ui.setBusy(true);
}

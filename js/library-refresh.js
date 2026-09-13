import { scanLibrary, preserveBookMetadata, staleCoverFileIds } from './library-tree.js';
import { validateIndex } from './library-index.js';

export function scanStatus(stats) {
  const prefix = stats.retrying ? 'Google Drive временно не ответил. Повторяем запрос…' : 'Сканирование библиотеки…';
  return `${prefix} Обработано папок: ${stats.processedFolders}. В очереди: ${stats.queuedFolders}. Найдено книг: ${stats.books}. Прошло: ${stats.elapsedSeconds} с.`;
}

export function scanFailureMessage(error) {
  return (error.folderName ? `Не удалось прочитать папку «${error.folderName}».`
    : 'Не удалось завершить обновление библиотеки. Не удалось прочитать одну из папок Google Drive.')
    + ' Старая версия библиотеки сохранена.';
}

// Keep the old catalog until scan completes; publish the entire new structure,
// then save it. Cache cleanup must never block publication or precede saving.
export function createLibraryRefresher({ scan = scanLibrary, save, apply, removeCovers,
  onProgress = () => {}, onPhase = () => {}, onCleanupError = () => {} }) {
  let running = false;
  return {
    get running() { return running; },
    async run({ activeIndex, rootFolderId, fileId }) {
      if (running) return null;
      running = true;
      try {
        const scanned = await scan(rootFolderId, onProgress);
        const index = preserveBookMetadata(scanned, activeIndex);
        validateIndex(index, rootFolderId);
        const obsolete = staleCoverFileIds(index, activeIndex);
        apply(index);
        onPhase('saving');
        const savedId = await save(index, fileId);
        const cleanup = obsolete.length ? Promise.resolve().then(() => removeCovers(obsolete)).catch(onCleanupError) : Promise.resolve();
        return { index, fileId: savedId, cleanup };
      } finally { running = false; }
    },
  };
}

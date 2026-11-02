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

// Keep the old catalog active until the complete scan has been persisted.
// Cache cleanup must never block publication or precede saving.
export function createLibraryRefresher({ scan = scanLibrary, save, apply, removeCovers,
  onProgress = () => {}, onPhase = () => {}, onCleanupError = () => {}, beforeSave = async () => null,
  onSaveFailure = async () => {} }) {
  let running = false;
  return {
    get running() { return running; },
    async run({ activeIndex, rootFolderId, rootResourceKey = '', fileId }) {
      if (running) return null;
      running = true;
      try {
        const scanned = await scan(rootFolderId, onProgress, { rootResourceKey });
        const index = preserveBookMetadata(scanned, activeIndex);
        validateIndex(index, rootFolderId);
        const obsolete = staleCoverFileIds(index, activeIndex);
        const preparation = await beforeSave(index, activeIndex);
        onPhase('saving');
        let savedId;
        try { savedId = await save(index, fileId); }
        catch (error) { await onSaveFailure(error, preparation); throw error; }
        apply(index);
        const cleanup = obsolete.length ? Promise.resolve().then(() => removeCovers(obsolete)).catch(onCleanupError) : Promise.resolve();
        return { index, fileId: savedId, previousIndex: activeIndex, preparation, cleanup };
      } finally { running = false; }
    },
  };
}

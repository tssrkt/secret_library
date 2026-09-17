import { buildLibraryLookups } from '../js/library-view-model.js';
import { normalizeUserSettings, saveUserSettings } from '../js/user-settings.js';

export async function runFolderTreeTests(test, assert, equal) {
  const index = { rootFolderId: 'root', folders: [
    { id: 'root', parentId: null, name: 'Корень' },
    { id: 'empty', parentId: 'root', name: 'Пусто' },
    { id: 'books', parentId: 'root', name: 'Книги' },
    { id: 'folders', parentId: 'root', name: 'Папки' },
    { id: 'folder-child', parentId: 'folders', name: 'Подпапка' },
    { id: 'mixed', parentId: 'root', name: 'Смешанная' },
    { id: 'nested', parentId: 'mixed', name: 'Вложенная' },
  ], books: [
    { id: 'book-1', parentId: 'books' }, { id: 'book-2', parentId: 'books' },
    { id: 'book-3', parentId: 'mixed' }, { id: 'book-4', parentId: 'nested' },
  ] };
  await test('folder counters contain only immediate folders and books', () => {
    const counts = buildLibraryLookups(index).contentCounts;
    const count = (id) => counts.get(id) || { folderCount: 0, bookCount: 0 };
    equal([count('empty'), count('books'), count('folders'), count('mixed')], [
      { folderCount: 0, bookCount: 0 }, { folderCount: 0, bookCount: 2 },
      { folderCount: 1, bookCount: 0 }, { folderCount: 1, bookCount: 1 },
    ], 'empty, books-only, folders-only/mixed and nested books are distinct');
    equal(count('root'), { folderCount: 4, bookCount: 0 }, 'nested contents do not leak into parent');
  });
  await test('folder notes survive index rebuild and are saved by stable folder ID', async () => {
    const settings = normalizeUserSettings({ version: 1, rootFolderId: 'root', sharing: { excludedFolderIds: [] },
      folderNotes: { mixed: '  Длинная заметка  ', removed: 'Сохраняется для папки, которая вернётся после обновления' } }, index);
    equal(settings.folderNotes, { mixed: 'Длинная заметка', removed: 'Сохраняется для папки, которая вернётся после обновления' }, 'notes are keyed by folder ID and whitespace is normalized');
    let written;
    await saveUserSettings(settings, { ...index, folders: index.folders.filter((folder) => folder.id !== 'mixed') }, null, {
      create: async (name, json) => { written = JSON.parse(json); return { id: 'notes-file' }; },
    });
    equal(written.folderNotes, settings.folderNotes, 'saving settings does not depend on the rebuilt index folders');
    assert(!normalizeUserSettings(null, index).folderNotes.mixed, 'missing note is represented by no rendered text');
  });
  await test('note area is a single constrained line and does not widen its row', () => {
    const row = document.createElement('div'); row.className = 'tree-row'; row.style.width = '180px';
    const name = document.createElement('button'); name.className = 'folder-toggle'; name.textContent = 'Папка';
    const count = document.createElement('span'); count.className = 'folder-content-count'; count.textContent = '0 / 0';
    const edit = document.createElement('button'); edit.className = 'folder-note-edit'; edit.textContent = '✒';
    const viewport = document.createElement('span'); viewport.className = 'folder-note-viewport';
    const note = document.createElement('span'); note.className = 'folder-note'; note.textContent = 'Очень длинная заметка '.repeat(20);
    viewport.append(note); row.append(name, count, edit, viewport); document.body.append(row);
    try {
      const style = getComputedStyle(viewport);
      assert(style.whiteSpace === 'nowrap' && style.overflow === 'hidden' && style.minWidth === '0px', 'long note stays inside a one-line, constrained viewport');
      assert(row.scrollWidth <= row.clientWidth, 'note does not create page/tree horizontal overflow');
    } finally { row.remove(); }
  });
}

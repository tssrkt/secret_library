import { authorizeDriveFolder } from './google-picker.js?v=20261109-picker-first-auth-fix';

export function chooseRootFolder({ listChildren, getFolder, onExit = () => {}, description = 'Выберите папку в корне Google Диска. Сайт будет сканировать её и все вложенные папки.', documentRef = document }) {
  return new Promise((resolve, reject) => {
    const backdrop = documentRef.createElement('div');
    backdrop.className = 'modal-backdrop root-folder-backdrop';
    const dialog = documentRef.createElement('section');
    dialog.className = 'root-folder-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'root-folder-title');
    dialog.innerHTML = '<header><h2 id="root-folder-title">Выберите корневую папку</h2><button type="button" class="secondary compact" data-close aria-label="Закрыть">×</button></header><p class="root-folder-description"></p><nav class="root-folder-breadcrumb" aria-label="Расположение">Мой диск</nav><div class="root-folder-status-row"><p class="root-folder-status" role="status">Загружаем папки…</p><button type="button" class="secondary compact" data-refresh>Обновить</button></div><ul class="root-folder-list"></ul><footer><button type="button" class="secondary" data-exit>Выход</button><button type="button" data-select disabled>Выбрать эту папку</button></footer>';
    dialog.querySelector('.root-folder-description').textContent = description;
    backdrop.append(dialog);
    documentRef.body.append(backdrop);
    const status = dialog.querySelector('.root-folder-status');
    const list = dialog.querySelector('.root-folder-list');
    const select = dialog.querySelector('[data-select]');
    const refresh = dialog.querySelector('[data-refresh]');
    let onKey = null;
    let busy = false;
    let selectedFolder = null;
    const close = (value, error) => {
      if (onKey) documentRef.removeEventListener('keydown', onKey);
      backdrop.remove();
      if (error) reject(error); else resolve(value);
    };
    const renderSelection = () => {
      for (const button of list.querySelectorAll('.root-folder-entry')) {
        const selected = button.dataset.folderId === selectedFolder?.id;
        button.setAttribute('aria-pressed', String(selected));
        button.classList.toggle('is-selected', selected);
      }
      select.disabled = !selectedFolder || busy;
      refresh.disabled = busy;
    };
    const load = async () => {
      if (busy) return;
      busy = true;
      selectedFolder = null;
      status.textContent = 'Загружаем папки в корне Google Диска…';
      list.replaceChildren();
      renderSelection();
      try {
        const children = await listChildren('root', { foldersOnly: true });
        const folders = children.filter((item) => item.mimeType === 'application/vnd.google-apps.folder')
          .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        if (!folders.length) status.textContent = 'В корне Google Диска папок не найдено.';
        else status.textContent = 'Показаны только папки непосредственно в корне Google Диска. Выберите одну из них.';
        for (const folder of folders) {
          const li = documentRef.createElement('li');
          const button = documentRef.createElement('button');
          button.type = 'button';
          button.className = 'root-folder-entry';
          button.textContent = folder.name;
          button.dataset.folderId = folder.id;
          button.setAttribute('aria-pressed', 'false');
          button.addEventListener('click', () => {
            selectedFolder = { id: folder.id, name: folder.name, resourceKey: folder.resourceKey || '' };
            status.textContent = 'Выбрана папка «' + folder.name + '». Внутренние папки будут включены в библиотеку.';
            renderSelection();
          });
          li.append(button);
          list.append(li);
        }
      } catch (error) {
        status.textContent = error.message || 'Не удалось загрузить папки из корня Google Диска.';
      } finally {
        busy = false;
        renderSelection();
      }
    };
    refresh.addEventListener('click', () => { void load(); });
    select.addEventListener('click', async () => {
      if (busy || !selectedFolder) return;
      busy = true;
      select.disabled = true;
      refresh.disabled = true;
      status.textContent = 'Проверяем выбранную папку…';
      try {
        const folder = await getFolder(selectedFolder.id, { resourceKey: selectedFolder.resourceKey });
        status.textContent = 'Подтвердите эту же папку в окне Google Picker, чтобы разрешить приложению менять только выбранные объекты.';
        await authorizeDriveFolder({ id: folder.id, name: folder.name });
        close({ id: folder.id, name: folder.name, resourceKey: folder.resourceKey || '' });
      } catch (error) {
        busy = false;
        status.textContent = error.message || 'Папка недоступна.';
        renderSelection();
      }
    });
    dialog.querySelector('[data-close]').addEventListener('click', () => close(null));
    dialog.querySelector('[data-exit]').addEventListener('click', () => {
      close(null);
      onExit();
    });
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(null); });
    onKey = (event) => { if (event.key === 'Escape') close(null); };
    documentRef.addEventListener('keydown', onKey);
    dialog.querySelector('[data-close]').focus();
    void load();
  });
}

export function chooseRootFolder({ listChildren, getFolder, scanFolder, description = 'Выберите папку с книгами. Сайт будет сканировать её и все вложенные папки.', documentRef = document }) {
  return new Promise((resolve, reject) => {
    const backdrop = documentRef.createElement('div');
    backdrop.className = 'modal-backdrop root-folder-backdrop';
    const dialog = documentRef.createElement('section');
    dialog.className = 'root-folder-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'root-folder-title');
    dialog.innerHTML = '<header><h2 id="root-folder-title">Выберите корневую папку</h2><button type="button" class="secondary compact" data-close aria-label="Закрыть">×</button></header><p class="root-folder-description">Выберите папку с книгами. Сайт будет сканировать её и все вложенные папки.</p><nav class="root-folder-breadcrumb" aria-label="Путь к папке"></nav><div class="root-folder-status-row"><p class="root-folder-status" role="status">Загружаем папки…</p><button type="button" class="secondary compact" data-refresh>Обновить</button></div><ul class="root-folder-list"></ul><footer><button type="button" class="secondary" data-cancel>Отмена</button><button type="button" data-select disabled>Выбрать эту папку</button></footer>';
    dialog.querySelector('.root-folder-description').textContent = description;
    backdrop.append(dialog);
    documentRef.body.append(backdrop);
    const breadcrumb = dialog.querySelector('.root-folder-breadcrumb');
    const status = dialog.querySelector('.root-folder-status');
    const list = dialog.querySelector('.root-folder-list');
    const select = dialog.querySelector('[data-select]');
    const refresh = dialog.querySelector('[data-refresh]');
    let onKey = null;
    const close = (value, error) => {
      if (onKey) documentRef.removeEventListener('keydown', onKey);
      backdrop.remove();
      if (error) reject(error); else resolve(value);
    };
    const path = [{ id: 'root', name: 'Мой диск' }];
    let busy = false;
    const renderPath = () => {
      breadcrumb.replaceChildren();
      path.forEach((part, index) => {
        const button = documentRef.createElement('button');
        button.type = 'button'; button.className = 'root-folder-crumb';
        button.textContent = part.name;
        button.disabled = index === path.length - 1 || busy;
        button.addEventListener('click', () => { path.splice(index + 1); void load(); });
        breadcrumb.append(button);
        if (index < path.length - 1) breadcrumb.append(documentRef.createTextNode(' / '));
      });
      select.disabled = path.length === 1 || busy;
      refresh.disabled = busy;
    };
    const load = async ({ scanFiles = false } = {}) => {
      if (busy) return;
      busy = true; status.textContent = 'Загружаем папки…'; list.replaceChildren(); renderPath();
      try {
        const currentFolder = path.at(-1);
        const children = await listChildren(currentFolder.id, { resourceKey: currentFolder.resourceKey });
        const folders = children.filter((item) => item.mimeType === 'application/vnd.google-apps.folder')
          .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        let scanSummary = '';
        if (scanFiles && scanFolder) {
          status.textContent = '\u0421\u043a\u0430\u043d\u0438\u0440\u0443\u044e \u0444\u0430\u0439\u043b\u044b \u0438 \u0432\u043b\u043e\u0436\u0435\u043d\u043d\u044b\u0435 \u043f\u0430\u043f\u043a\u0438?';
          const scanned = await scanFolder(currentFolder.id, { rootResourceKey: currentFolder.resourceKey || '' });
          scanSummary = ' \u041d\u0430\u0439\u0434\u0435\u043d\u043e \u043a\u043d\u0438\u0433: ' + scanned.books.length.toLocaleString('ru-RU') + '; \u043f\u0430\u043f\u043e\u043a: ' + Math.max(0, scanned.folders.length - 1).toLocaleString('ru-RU') + '.';
        }
        status.textContent = (folders.length ? '\u0412\u043b\u043e\u0436\u0435\u043d\u043d\u044b\u0435 \u043f\u0430\u043f\u043a\u0438 \u043e\u0442\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u044b \u043d\u0438\u0436\u0435.' : '\u0412 \u044d\u0442\u043e\u0439 \u043f\u0430\u043f\u043a\u0435 \u043d\u0435\u0442 \u0432\u043b\u043e\u0436\u0435\u043d\u043d\u044b\u0445 \u043f\u0430\u043f\u043e\u043a.') + scanSummary;
        for (const folder of folders) {
          const li = documentRef.createElement('li');
          const button = documentRef.createElement('button');
          button.type = 'button'; button.className = 'root-folder-entry'; button.textContent = folder.name;
          button.addEventListener('click', () => { path.push({ id: folder.id, name: folder.name, resourceKey: folder.resourceKey || '' }); void load(); });
          li.append(button); list.append(li);
        }
      } catch (error) {
        status.textContent = error.message || 'Не удалось прочитать содержимое папки.';
      } finally { busy = false; renderPath(); }
    };
    refresh.addEventListener('click', () => { void load({ scanFiles: true }); });
    select.addEventListener('click', async () => {
      if (busy || path.length === 1) return;
      busy = true; select.disabled = true; status.textContent = 'Проверяем выбранную папку…';
      try {
        const selectedFolder = path.at(-1);
        const folder = await getFolder(selectedFolder.id, { resourceKey: selectedFolder.resourceKey });
        close({ id: folder.id, name: folder.name, resourceKey: folder.resourceKey || '' });
      } catch (error) { busy = false; status.textContent = error.message || 'Папка недоступна.'; renderPath(); }
    });
    dialog.querySelector('[data-close]').addEventListener('click', () => close(null));
    dialog.querySelector('[data-cancel]').addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(null); });
    onKey = (event) => { if (event.key === 'Escape') close(null); };
    documentRef.addEventListener('keydown', onKey);
    dialog.querySelector('[data-close]').focus();
    void load();
  });
}

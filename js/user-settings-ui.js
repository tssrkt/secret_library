import { loadUserSettings, saveUserSettings, sharingFolders } from './user-settings.js';

export function createUserSettingsController({ container, index, onError, clearError,
  load = loadUserSettings, save = saveUserSettings, documentRef = document, mountSections = () => () => {} }) {
  let active = false;
  let revision = 0;
  let saved = null;
  let loading = null;
  let saving = null;
  let unmount = () => {};
  const element = (tag, text, className) => {
    const node = documentRef.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const open = async () => {
    unmount();
    active = true;
    documentRef.body?.classList.add('settings-page-open');
    const current = ++revision;
    const isCurrent = () => active && current === revision;
    clearError();
    const page = element('div', '', 'user-settings-page');
    const section = element('section');
    section.append(element('h3', 'Папки, которыми вы делитесь'));
    const description = element('p', 'Выберите папки библиотеки, которые будут доступны вашим друзьям.');
    section.append(description);
    const status = element('p', 'Загрузка настроек…');
    status.setAttribute('role', 'status');
    page.append(section);
    section.append(status);
    container.replaceChildren(page);
    try {
      unmount = mountSections(page);
      // Reopening during a write waits for its file ID, so it cannot create a duplicate.
      if (saving) await saving;
      if (!isCurrent()) return;
      // The in-memory value is only a cache, not the source of truth. Revalidate it
      // against Drive whenever the page opens so changes made elsewhere cannot leave
      // this form displaying stale sharing settings. Keep the loading state visible
      // until the fresh snapshot is ready instead of briefly rendering old controls.
      loading ||= load(index).finally(() => { loading = null; });
      saved = await loading;
      if (!isCurrent()) return;
      status.textContent = '';
      const folders = sharingFolders(index);
      if (!folders.length) {
        description.hidden = true;
        status.textContent = 'В корневой папке библиотеки нет папок.';
        return;
      }
      const excluded = new Set(saved.settings.sharing.excludedFolderIds);
      const form = element('form', '', 'sharing-settings-form');
      const list = element('div', '', 'sharing-folder-list');
      for (const folder of folders) {
        const label = element('label');
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.value = folder.id;
        checkbox.checked = !excluded.has(folder.id);
        label.append(checkbox, element('span', folder.name));
        list.append(label);
      }
      const button = element('button', 'СОХРАНИТЬ', 'settings-save-button');
      button.type = 'submit';
      form.append(list, button);
      section.insertBefore(form, status);
      form.addEventListener('input', () => { status.textContent = ''; });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (saving || !isCurrent()) return;
        const settings = { ...saved.settings, version: 1, rootFolderId: index.rootFolderId,
          sharing: { excludedFolderIds: [...list.querySelectorAll('input')].filter((field) => !field.checked).map((field) => field.value) } };
        const fields = [...list.querySelectorAll('input')];
        button.disabled = true;
        fields.forEach((field) => { field.disabled = true; });
        status.textContent = '';
        clearError();
        saving = (async () => {
          try {
            const fileId = await save(settings, index, saved.fileId);
            saved = { fileId, settings };
            if (isCurrent()) status.textContent = 'Настройки сохранены.';
          } catch (error) {
            if (isCurrent() || error?.status === 401 || error?.code === 'unauthorized') onError(error);
          } finally {
            fields.forEach((field) => { field.disabled = false; });
            button.disabled = false;
          }
        })();
        await saving;
        saving = null;
      });
    } catch (error) {
      if (!isCurrent()) return;
      status.textContent = '';
      onError(error);
      const retry = element('button', 'ПОВТОРИТЬ', 'settings-save-button');
      retry.type = 'button';
      retry.addEventListener('click', open);
      section.append(retry);
    }
  };
  return {
    open,
    get active() { return active; },
    leave() {
      active = false;
      revision++;
      documentRef.body?.classList.remove('settings-page-open');
      unmount();
      unmount = () => {};
    },
  };
}

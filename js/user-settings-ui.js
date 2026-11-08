import { loadUserSettings, saveUserSettings, sharingFolders } from './user-settings.js';

export function createUserSettingsController({ container, index, onError, clearError,
  load = loadUserSettings, save = saveUserSettings, documentRef = document, mountSections = () => () => {} }) {
  let active = false;
  let revision = 0;
  let saved = null;
  let loading = null;
  let saving = null;
  let unmount = () => {};
  let removeQuotaListener = () => {};
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
    removeQuotaListener();
    let quotaExceeded = false;
    clearError();
    const page = element('div', '', 'user-settings-page');
    const section = element('section');
    const quotaMessage = 'Извините, из-за жестких квот бесплатного тарифа лимит базы данных превышен на сегодня. Лимит будет обнулен в полночь по тихоокеанскому времени (11:00 по Москве).';
    const showQuotaMessage = () => {
      if (!isCurrent()) return;
      quotaExceeded = true;
      const message = element('p', quotaMessage, 'database-quota-message');
      message.setAttribute('role', 'alert');
      page.replaceChildren(section, message);
    };
    const onQuotaExceeded = () => showQuotaMessage();
    documentRef.defaultView?.addEventListener('database-quota-exceeded', onQuotaExceeded);
    removeQuotaListener = () => documentRef.defaultView?.removeEventListener('database-quota-exceeded', onQuotaExceeded);
    section.className = 'sharing-folders-section';
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
      if (quotaExceeded) showQuotaMessage();
      // Reopening during a write waits for its file ID, so it cannot create a duplicate.
      if (saving) await saving;
      if (!isCurrent()) return;
      const folders = sharingFolders(index);
      const renderForm = () => {
        if (!isCurrent()) return;
        status.textContent = '';
        if (!folders.length) {
          description.hidden = true;
          status.textContent = 'В вашей библиотеке нет папок.';
          return;
        }
        const previousForm = section.querySelector('.sharing-settings-form');
        const hadDraft = Boolean(previousForm?.dataset.dirty === 'true');
        const draft = hadDraft ? new Map([...previousForm.querySelectorAll('input')].map((field) => [field.value, field.checked])) : null;
        const excluded = new Set(saved.settings.sharing.excludedFolderIds);
        const form = element('form', '', 'sharing-settings-form');
        const list = element('div', '', 'sharing-folder-list');
        for (const folder of folders) {
          const label = element('label');
          const checkbox = element('input');
          checkbox.type = 'checkbox';
          checkbox.value = folder.id;
          checkbox.checked = draft?.has(folder.id) ? draft.get(folder.id) : !excluded.has(folder.id);
          label.append(checkbox, element('span', folder.name));
          list.append(label);
        }
        const button = element('button', 'СОХРАНИТЬ', 'settings-save-button');
        button.type = 'submit';
        form.append(list, button);
        if (previousForm) previousForm.replaceWith(form);
        else section.insertBefore(form, status);
        form.addEventListener('input', () => {
          form.dataset.dirty = 'true';
          status.textContent = '';
        });
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
              form.dataset.dirty = 'false';
              if (isCurrent()) status.textContent = 'Настройки сохранены.';
            } catch (error) {
              // A failed save must not leave the unsaved checkbox draft looking applied.
              const savedExcluded = new Set(saved.settings.sharing.excludedFolderIds);
              fields.forEach((field) => { field.checked = !savedExcluded.has(field.value); });
              form.dataset.dirty = 'false';
              if (isCurrent() || error?.status === 401 || error?.code === 'unauthorized') onError(error);
            } finally {
              fields.forEach((field) => { field.disabled = false; });
              button.disabled = false;
            }
          })();
          await saving;
          saving = null;
        });
      };
      // Do not render cached settings here: they may be stale. Show the loading
      // status until the current Drive snapshot is available, then render once.
      status.textContent = 'Загружаем актуальные настройки…';
      loading ||= load(index).finally(() => { loading = null; });
      try {
        const fresh = await loading;
        if (!isCurrent()) return;
        const changed = !saved || JSON.stringify(fresh) !== JSON.stringify(saved);
        saved = fresh;
        if (changed && section.querySelector('.sharing-settings-form')?.dataset.dirty !== 'true') renderForm();
        else if (!section.querySelector('.sharing-settings-form')) renderForm();
      } catch (error) {
        if (!saved) throw error;
        if (isCurrent()) onError(error);
      }
    } catch (error) {
      if (!isCurrent() || quotaExceeded) return;
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
      removeQuotaListener();
      removeQuotaListener = () => {};
      documentRef.body?.classList.remove('settings-page-open');
      unmount();
      unmount = () => {};
    },
  };
}

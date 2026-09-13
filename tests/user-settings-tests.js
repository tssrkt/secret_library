import { loadUserSettings, saveUserSettings, normalizeUserSettings, sharingFolders } from '../js/user-settings.js';
import { createUserSettingsController } from '../js/user-settings-ui.js';
import { USER_SETTINGS_FILE_NAME, INDEX_VERSION, METADATA_VERSION } from '../js/config.js';
import { restoreAuthSession, clearAccessToken } from '../js/auth.js';

export async function runUserSettingsTests(test, assert, equal) {
  const makeIndex = () => ({ version: INDEX_VERSION, rootFolderId: 'root', folders: [
    { id: 'root', parentId: null, name: 'Корень' },
    { id: 'sf', parentId: 'root', name: 'Фантастика' },
    { id: 'lem', parentId: 'sf', name: 'Лем' },
    { id: 'history', parentId: 'root', name: 'История' },
    { id: 'new', parentId: 'root', name: 'Новые книги' },
  ], books: [{ id: 'book', parentId: 'root', title: 'Книга', authors: ['Автор'], genres: ['sf'],
    fileName: 'book.fb2', metadataStatus: 'ready', metadataVersion: METADATA_VERSION }] });
  const settings = (rootFolderId = 'root') => ({ version: 1, rootFolderId,
    sharing: { excludedFolderIds: ['sf', 'deleted', 'lem', 'sf', null] } });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  await test('user settings normalize only current root children without touching the index', () => {
    const index = makeIndex();
    const before = JSON.stringify(index);
    equal(sharingFolders(index).map((folder) => folder.id), ['sf', 'history', 'new'], 'only first level folders');
    equal(normalizeUserSettings(null, index).sharing.excludedFolderIds, [], 'all selected by default');
    equal(normalizeUserSettings(settings(), index).sharing.excludedFolderIds, ['sf'], 'stale, nested and duplicate IDs removed');
    equal(normalizeUserSettings(settings('other'), index).sharing.excludedFolderIds, [], 'different root defaults to all');
    equal(normalizeUserSettings({ version: 1, rootFolderId: 'root', sharing: { excludedFolderIds: 'sf' } }, index).sharing.excludedFolderIds, [], 'malformed list safely defaults');
    equal(JSON.stringify(index), before, 'index and metadata unchanged');
  });

  await test('user settings load defaults, create once and update the existing appData file', async () => {
    const index = makeIndex();
    const before = JSON.stringify(index);
    let file = null;
    let creates = 0;
    let updates = 0;
    const api = {
      list: async (name) => { equal(name, USER_SETTINGS_FILE_NAME, 'dedicated filename'); return file ? [{ id: 'settings-id' }] : []; },
      download: async (id) => { equal(id, 'settings-id', 'existing file'); return { json: async () => file }; },
      create: async (name, json) => { equal(name, USER_SETTINGS_FILE_NAME, 'create settings only'); creates++; file = JSON.parse(json); return { id: 'settings-id' }; },
      update: async (id, json) => { equal(id, 'settings-id', 'update same file'); updates++; file = JSON.parse(json); return { id }; },
    };
    const initial = await loadUserSettings(index, api);
    equal(initial, { fileId: null, settings: normalizeUserSettings(null, index) }, 'missing file defaults');
    const fileId = await saveUserSettings(settings(), index, initial.fileId, api);
    equal(file, { version: 1, rootFolderId: 'root', sharing: { excludedFolderIds: ['sf'] } }, 'only current exclusions and required fields stored');
    const loaded = await loadUserSettings(index, api);
    equal(loaded.fileId, fileId, 'load preserves file ID');
    await saveUserSettings(loaded.settings, index, loaded.fileId, api);
    equal([creates, updates], [1, 1], 'subsequent save updates');
    file = settings('old-root');
    equal((await loadUserSettings(index, api)).settings.sharing.excludedFolderIds, [], 'root mismatch handled on load');
    const unauthorized = Object.assign(new Error('expired'), { status: 401, code: 'unauthorized' });
    for (const operation of [
      () => loadUserSettings(index, { list: async () => { throw unauthorized; } }),
      () => saveUserSettings(settings(), index, fileId, { update: async () => { throw unauthorized; } }),
    ]) {
      try { await operation(); assert(false, 'must propagate error'); }
      catch (error) { assert(error === unauthorized, '401 reaches existing auth handler intact'); }
    }
    equal(JSON.stringify(index), before, 'storage never mutates index or book metadata');
  });

  await test('settings page preserves drafts on failure, prevents duplicate writes and discards unsaved changes', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const errors = [];
    let resolveSave;
    let rejectSave;
    const writes = [];
    const controller = createUserSettingsController({ container, index: makeIndex(), clearError: () => {},
      onError: (error) => errors.push(error),
      load: async (index) => ({ fileId: null, settings: normalizeUserSettings(settings(), index) }),
      save: (value, index, fileId) => { writes.push({ value, fileId }); return new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; }); },
    });
    const fields = () => [...container.querySelectorAll('input')];
    const submit = () => container.querySelector('form').requestSubmit();
    try {
      await controller.open();
      equal(fields().map((field) => [field.value, field.checked]), [['sf', false], ['history', true], ['new', true]], 'saved exclusions and new folder default');
      assert(fields().every((field) => field.closest('label')?.querySelector('span')), 'folder names are labels');
      fields()[1].checked = false;
      submit(); submit();
      assert(container.querySelector('[type=submit]').disabled && writes.length === 1, 'only save is disabled and duplicate submit ignored');
      rejectSave(new Error('Не удалось сохранить настройки.'));
      await tick();
      assert(errors.length === 1 && !fields()[1].checked && !container.querySelector('[type=submit]').disabled, 'failure preserves draft and enables retry');
      submit();
      equal(writes[1].value.sharing.excludedFolderIds, ['sf', 'history'], 'save captures current unchecked folders');
      resolveSave('settings-id');
      await tick();
      const status = container.querySelector('[role=status]');
      equal(status.textContent, 'Настройки сохранены.', 'success text');
      assert(document.activeElement !== status && !status.hasAttribute('tabindex') && getComputedStyle(status).outlineStyle === 'none', 'status has no focus or frame');
      fields()[2].checked = false;
      controller.leave();
      await controller.open();
      assert(fields()[2].checked && !fields()[1].checked, 'unsaved draft discarded, saved choices retained');
      submit();
      equal(writes[2].fileId, 'settings-id', 'later save updates existing file');
      controller.leave();
      const reopened = controller.open();
      resolveSave('settings-id');
      await reopened;
      assert(fields().length === 3, 'reopen during write waits safely');
    } finally { controller.leave(); container.remove(); }
  });

  await test('empty settings and delayed loads do not restore a page after navigation', async () => {
    const container = document.createElement('div');
    const index = makeIndex();
    index.folders = index.folders.slice(0, 1);
    let finish;
    const controller = createUserSettingsController({ container, index, clearError: () => {}, onError: (error) => { throw error; },
      load: () => new Promise((resolve) => { finish = resolve; }),
    });
    const opened = controller.open();
    controller.leave();
    container.textContent = 'Home';
    finish({ fileId: null, settings: normalizeUserSettings(null, index) });
    await opened;
    equal(container.textContent, 'Home', 'late load cannot replace home');
    await controller.open();
    assert(container.textContent.includes('В корневой папке библиотеки нет папок.') && !container.querySelector('form'), 'empty root is a normal state');
    controller.leave();
  });

  await test('avatar settings integrate with SPA home, search and direct filters without scanning Drive', async () => {
    const markup = new DOMParser().parseFromString(await (await fetch('../index.html')).text(), 'text/html');
    markup.querySelectorAll('script').forEach((node) => node.remove());
    const fixture = document.createElement('div');
    fixture.append(...markup.body.children);
    document.body.append(fixture);
    const ui = await import(`../js/ui.js?settings-test=${Date.now()}`);
    const index = makeIndex();
    const before = JSON.stringify(index);
    ui.renderLibrary(index);
    ui.setAuthorized(true);
    const noop = () => {};
    ui.bindActions({ home: ui.showLibraryHome, signIn: noop, refresh: noop, indexMetadata: noop,
      retryMetadata: noop, stopMetadata: noop, signOut: noop, rebuild: noop });
    restoreAuthSession({ session: { getItem: () => JSON.stringify({ accessToken: 'test-only', expiresAt: Date.now() + 60000 }) } });
    const nativeFetch = window.fetch;
    const requests = [];
    let stored = null;
    let failWrite = false;
    window.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method || 'GET' });
      const parsed = new URL(url);
      if (options.method) {
        assert(parsed.pathname.startsWith('/upload/drive/v3/files'), 'writes only use appData upload helpers');
        if (failWrite) return new Response('{}', { status: 403 });
        if (options.method === 'POST') {
          assert(options.body.includes('"parents":["appDataFolder"]') && options.body.includes(USER_SETTINGS_FILE_NAME), 'create belongs to appDataFolder');
          stored = JSON.parse(options.body.split('Content-Type: application/json\r\n\r\n')[1].split('\r\n--')[0]);
        } else {
          assert(options.method === 'PATCH' && parsed.pathname.endsWith('/settings-id'), 'later writes update same file');
          stored = JSON.parse(options.body);
        }
        return new Response(JSON.stringify({ id: 'settings-id' }), { status: 200 });
      }
      assert(parsed.searchParams.get('spaces') === 'appDataFolder' && parsed.searchParams.get('q').includes(USER_SETTINGS_FILE_NAME), 'only settings lookup is allowed; no scan, book or permissions calls');
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    };
    const click = (selector) => fixture.querySelector(selector).click();
    const tree = fixture.querySelector('#library-tree');
    try {
      const menuItem = fixture.querySelector('#settings-button');
      assert(!menuItem.disabled && menuItem.textContent === 'Настройки' && !menuItem.querySelector('small'), 'active menu item without placeholder');
      click('#avatar-button');
      click('#settings-button');
      for (let i = 0; i < 100 && !tree.querySelector('form') && fixture.querySelector('#error-panel').hidden; i++) await tick();
      assert(tree.querySelector('form'), `settings loaded: ${fixture.querySelector('#error-text').textContent}`);
      assert(fixture.querySelector('#avatar-menu').hidden && tree.querySelector('h2').textContent === 'Настройки', 'menu closes and settings opens');
      assert([...tree.querySelectorAll('input')].every((field) => field.checked), 'missing settings selects all');
      tree.querySelector('input').checked = false;
      click('#library-home-link');
      assert(tree.querySelector('.tree-list') && !tree.querySelector('.user-settings-page'), 'home restores tree');
      click('#settings-button');
      await tick();
      assert(tree.querySelector('input').checked, 'home discarded unsaved changes');
      click('#book-search-button');
      click('#advanced-search-button');
      assert(tree.querySelector('.book-search-form'), 'search opens from settings');
      tree.querySelector('form').requestSubmit();
      click('#settings-button');
      await tick();
      assert(!tree.querySelector('.book-search-form') && tree.querySelector('.user-settings-page'), 'settings exits search');
      click('#library-home-link');
      click('.book-author-link');
      assert(tree.querySelector('.direct-results-title'), 'direct filter still works');
      click('.book-card-title');
      assert(!fixture.querySelector('#annotation-modal').hidden, 'annotation opened');
      click('#settings-button');
      await tick();
      assert(fixture.querySelector('#annotation-modal').hidden && !tree.querySelector('.direct-results-title'), 'settings closes modal and direct filter');
      tree.querySelector('input').checked = false;
      const save = async () => {
        const button = tree.querySelector('[type=submit]');
        tree.querySelector('form').requestSubmit();
        for (let i = 0; i < 100 && button.disabled; i++) await tick();
        assert(!button.disabled, 'write completed');
      };
      await save();
      equal(stored.sharing.excludedFolderIds, ['sf'], 'actual Drive helper serializes unchecked IDs');
      equal(tree.querySelector('[role=status]').textContent, 'Настройки сохранены.', 'successful API write shows status');
      tree.querySelectorAll('input')[1].checked = false;
      failWrite = true;
      await save();
      assert(!fixture.querySelector('#error-panel').hidden && !tree.querySelectorAll('input')[1].checked, 'Drive failure uses existing error panel and preserves draft');
      failWrite = false;
      await save();
      equal(stored.sharing.excludedFolderIds, ['sf', 'history'], 'retry saves the same draft');
      assert(fixture.querySelector('#error-panel').hidden, 'retry clears old error');
      click('#library-home-link');
      equal(requests.map((request) => request.method), ['GET', 'POST', 'PATCH', 'PATCH'], 'one lookup, one create, update and retry; no scans or book requests');
      equal(JSON.stringify(index), before, 'index and metadata versions unchanged');
    } finally {
      window.fetch = nativeFetch;
      clearAccessToken();
      ui.resetUi();
      fixture.remove();
    }
  });
}

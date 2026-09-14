import { createLibraryTabs } from '../js/library-tabs.js';
import { createLibrarySelection } from '../js/library-selection.js';
import { sharedLibraryIndex, sharedLibraryPayload } from '../js/shared-library.js';

const tick = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
export async function runLibraryTabsTests(test, assert, equal) {
  await test('library strip overflow, five hidden tabs, expansion, collapse and keyboard', async () => {
    const root = document.createElement('div'); root.className = 'library-tabs'; root.style.width = '500px';
    document.body.append(root);
    let selected = '';
    const tabs = createLibraryTabs(root, (uid) => { selected = uid; tabs.update(friends, uid); });
    let friends = [{ uid: 'one', displayName: 'Вася' }];
    tabs.update(friends); await tick();
    equal([...root.children].filter((node) => node.tagName === 'BUTTON' && !node.hidden).length, 0, 'no controls when all fit');
    friends = Array.from({ length: 4 }, (_, i) => ({ uid: String(i), displayName: `Длинное имя друга ${i}` }));
    tabs.update(friends); await tick();
    assert(!root.querySelector('[aria-label="Прокрутить библиотеки вправо"]').hidden, 'overflow arrow');
    assert(root.querySelector('[aria-label="Показать все"]').hidden, 'less than five hidden tabs');
    friends = Array.from({ length: 15 }, (_, i) => ({ uid: String(i), displayName: `Длинное имя друга ${i}` }));
    tabs.update(friends); await tick();
    const expand = root.querySelector('[aria-label="Показать все"]');
    assert(!expand.hidden, 'five or more hidden tabs allow expansion');
    expand.click(); await tick();
    assert(root.classList.contains('expanded') && expand.getAttribute('aria-label') === 'Свернуть', 'expanded state');
    assert([...root.children].slice(0, 3).filter((node) => node.tagName === 'BUTTON').every((node) => node.hidden), 'arrows hidden expanded');
    root.querySelector('[data-library="14"]').click();
    equal(selected, '14', 'expanded ordinary click');
    expand.click(); await tick();
    const active = root.querySelector('[aria-selected="true"]');
    const strip = root.querySelector('[role="tablist"]');
    assert(active.getBoundingClientRect().right <= strip.getBoundingClientRect().right + 1, 'active stays visible after collapse');
    active.focus(); active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    equal(selected, '', 'keyboard Home selects own library');
    equal(root.querySelector('[role="tab"]').textContent, 'Моя библиотека', 'own always first');
    tabs.destroy(); root.remove();
  });

  await test('selection uses URL UID, isolates catalogs, resets on switch and rejects denied or stale loads', async () => {
    const shown = []; const errors = []; let listener; let pending;
    const location = { href: 'https://example.test/index.html' };
    const history = { pushState(a, b, url) { location.href = String(url); }, replaceState(a, b, url) { location.href = String(url); } };
    const own = { books: [{ id: 'own' }] }; const friend = { books: [{ id: 'friend' }] };
    const service = { subscribe(fn) { listener = fn; return () => {}; }, loadLibrary: async () => friend };
    const options = { tabs: { update() {} }, service, show: (index) => shown.push(index), unavailable: (message) => errors.push(message), location, history, events: new EventTarget() };
    const selection = createLibrarySelection(options);
    listener({ status: 'ready', libraries: [{ uid: 'friend-uid', displayName: 'Друг', revision: '1' }] });
    selection.setOwn(own); equal(shown.at(-1), own, 'default own');
    selection.select('friend-uid'); await Promise.resolve();
    equal(shown.at(-1), friend, 'friend alone');
    assert(location.href.includes('library=friend-uid') && !location.href.includes('@'), 'internal identifier in URL');
    selection.select(''); equal(shown.at(-1), own, 'own catalog restored');
    selection.select('denied'); assert(errors.at(-1).includes('недоступна'), 'denied URL has no catalog');
    service.loadLibrary = () => new Promise((resolve) => { pending = resolve; });
    selection.select('friend-uid'); selection.select(''); pending(friend); await Promise.resolve();
    equal(shown.at(-1), own, 'late response cannot replace active own catalog');
    selection.select('friend-uid'); listener({ status: 'ready', libraries: [] }); pending(friend); await Promise.resolve();
    assert(errors.at(-1).includes('недоступна'), 'revocation clears view and cancels in-flight response');
    selection.destroy();
    location.href = 'https://example.test/index.html?library=friend-uid';
    service.loadLibrary = async () => friend;
    const reloaded = createLibrarySelection(options); listener({ status: 'ready', libraries: [{ uid: 'friend-uid', revision: '1' }] });
    reloaded.setOwn(own); await Promise.resolve(); equal(shown.at(-1), friend, 'reload honors explicit URL'); reloaded.destroy();
  });

  await test('shared projection contains only allowed folder descendants and preserves Unicode chunks', async () => {
    const index = { version: 4, rootFolderId: 'r', folders: [{ id: 'r', parentId: null }, { id: 'a', parentId: 'r' },
      { id: 'b', parentId: 'r' }, { id: 'c', parentId: 'b' }],
    books: [{ id: 'yes', parentId: 'a', title: '📚'.repeat(90000), coverFileId: 'private', metadataError: 'private' },
      { id: 'no', parentId: 'c' }, { id: 'root', parentId: 'r' }] };
    const settings = { sharing: { excludedFolderIds: ['b'] } };
    const visible = sharedLibraryIndex(index, settings);
    equal(visible.books.map((book) => book.id), ['yes'], 'excluded descendants and root files not shared');
    assert(!JSON.stringify(visible).includes('private'), 'no private cover ID or diagnostics');
    const payload = await sharedLibraryPayload(index, settings);
    equal(JSON.parse(payload.chunks.join('')), visible, 'Unicode survives chunking');
    assert(payload.chunks.length > 1 && payload.chunks.every((json) => new TextEncoder().encode(json).length < 600001), 'bounded documents');
    equal(index.books.length, 3, 'owner index unchanged');
  });
}

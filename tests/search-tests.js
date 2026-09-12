import { searchBooks, librarySearchOptions } from '../js/book-search.js';

export async function runSearchTests(test, assert, equal) {
  for (const field of ['title', 'authors', 'series', 'annotation', 'fileName']) {
    await test(`general search matches ${field} without case sensitivity`, () => {
      const book = { [field]: field === 'authors' ? ['Другой', 'СТАНИСЛАВ ЛЕМ'] : 'СТАНИСЛАВ ЛЕМ' };
      equal(searchBooks([book], { query: '  лЕм  ' }), [book], field);
    });
  }
  await test('general search excludes genre, language, preview and series number', () => {
    for (const book of [{ genres: ['needle'] }, { language: 'needle' }, { preview: 'needle' }, { seriesNumber: 'needle' }]) {
      equal(searchBooks([book], { query: 'needle' }), [], 'not a general-search field');
    }
  });
  await test('general words use AND across fields and safely handle incomplete metadata', () => {
    const book = { title: 'Тибет', annotation: 'Буддизм', authors: null, series: null };
    equal(searchBooks([book, {}], { query: ' ТИБЕТ  \n буддизм ' }), [book], 'words may match different fields');
    equal(searchBooks([book], { query: 'тибет буддизм дракон' }), [], 'every word required');
    equal(searchBooks([{ fileName: 'Лем.fb2', title: null, authors: [null], genres: null }], { query: 'лем' }).length, 1, 'filename fallback in general query');
    equal(searchBooks(null, { query: 'лем' }), [], 'absent library');
  });
  await test('advanced text fields are independent substring conditions', () => {
    const book = { title: 'Солярис', authors: ['Другой', 'Станислав Лем'], series: 'Миры будущего', seriesNumber: 10 };
    for (const conditions of [{ title: ' ЛЯР ' }, { author: 'ЛЕМ' }, { series: ' БУДУЩ ' }]) {
      equal(searchBooks([book], conditions), [book], 'case-insensitive substring');
    }
    equal(searchBooks([{ fileName: 'Солярис.fb2' }], { title: 'солярис' }), [], 'title has no filename fallback');
    equal(searchBooks([book], { series: '10' }), [], 'series number excluded');
  });
  await test('advanced fields combine with AND and preserve exact genre/language values', () => {
    const book = { title: 'Дракон', authors: ['Иванов'], genres: ['fantasy'], language: 'ru' };
    const before = JSON.stringify(book);
    equal(searchBooks([book], { query: 'ДРАКОН', author: 'иван', genre: 'fantasy', language: 'ru' }), [book], 'all fields match');
    for (const conditions of [{ genre: 'Фэнтези' }, { language: 'RU' }, { query: 'дракон', author: 'петров' }]) {
      equal(searchBooks([book], conditions), [], 'failed condition excludes book');
    }
    equal(JSON.stringify(book), before, 'source unchanged');
  });
  await test('genre and language options contain only current-library distinct source values', () => {
    const options = librarySearchOptions([
      { genres: ['a', 'b', 'a'], language: 'ru' }, { genres: ['unknown'], language: 'invalid_code' }, {},
    ], { a: 'Одинаково', b: 'Одинаково', absent: 'Лишний' });
    equal(options.genres.map((option) => option.value).sort(), ['a', 'b', 'unknown'], 'source codes remain distinct');
    assert(options.genres.filter((option) => option.label === 'Одинаково').length === 2, 'equal translations do not merge');
    equal(options.languages.map((option) => option.value).sort(), ['invalid_code', 'ru'], 'only present languages');
    assert(options.languages.find((option) => option.value === 'invalid_code').label === 'invalid_code', 'safe invalid-language fallback');
  });

  await test('quick and advanced search share local state, pagination and direct navigation', async () => {
    const markup = new DOMParser().parseFromString(await (await fetch('../index.html')).text(), 'text/html');
    markup.querySelectorAll('script').forEach((element) => element.remove());
    const fixture = document.createElement('div');
    fixture.append(...markup.body.children);
    document.body.append(fixture);
    const ui = await import(`../js/ui.js?search-test=${Date.now()}`);
    const books = Array.from({ length: 51 }, (_, i) => ({
      id: String(i), fileName: `Book ${i}.fb2`, parentId: i ? 'nested' : 'root', title: `Лем ${i}`,
      metadataStatus: 'ready', authors: ['Лем'], genres: i < 50 ? ['sf', 'sci_psychology'] : ['sf'],
      language: 'ru', annotation: 'Буддизм',
    }));
    const index = { rootFolderId: 'root', folders: [{ id: 'root', parentId: null }, { id: 'nested', parentId: 'root', name: 'Nested' }], books };
    const before = JSON.stringify(index);
    ui.renderLibrary(index);
    ui.setAuthorized(true);
    const noop = () => {};
    ui.bindActions({ home: ui.showLibraryHome, signIn: noop, refresh: noop, indexMetadata: noop, retryMetadata: noop, stopMetadata: noop, signOut: noop, rebuild: noop });
    const tree = fixture.querySelector('#library-tree');
    const icon = fixture.querySelector('#book-search-button');
    const header = fixture.querySelector('.app-header');
    const quick = fixture.querySelector('#quick-search-input');
    const quickForm = fixture.querySelector('#quick-search-form');
    const setValue = (element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); };
    const cards = () => tree.querySelectorAll('.book-card').length;
    const submitQuick = () => quickForm.requestSubmit();
    const home = () => fixture.querySelector('#library-home-link').click();
    const pageTwo = () => tree.querySelector('[aria-label="Страница 2"]').click();
    const nativeFetch = window.fetch;
    let requests = 0;
    window.fetch = (...args) => { requests++; return nativeFetch(...args); };
    try {
      const avatar = fixture.querySelector('#avatar-button');
      const originalPosition = [avatar.getBoundingClientRect().x, avatar.getBoundingClientRect().y];
      icon.click();
      assert(document.activeElement === quick && !quickForm.inert, 'opening focuses the quick field');
      equal([avatar.getBoundingClientRect().x, avatar.getBoundingClientRect().y], originalPosition, 'avatar stays fixed');
      setValue(quick, '  ');
      submitQuick();
      assert(tree.querySelector('.tree-list'), 'blank Enter/submit does not navigate');
      icon.click();
      assert(!header.classList.contains('quick-search-open'), 'repeat click closes empty field');
      icon.click();
      setValue(quick, ' ЛЕМ ');
      icon.click();
      assert(quick.value === ' ЛЕМ ' && header.classList.contains('quick-search-open'), 'repeat click preserves text');
      fixture.querySelector('#status-panel').click();
      assert(quick.value === ' ЛЕМ ', 'outside click preserves text');
      quick.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert(!header.classList.contains('quick-search-open') && quickForm.inert && quick.value === ' ЛЕМ ', 'Escape closes without clearing');
      icon.click();
      submitQuick();
      const form = tree.querySelector('.book-search-form');
      assert(form && !tree.querySelector('.tree-list') && form.elements.query.value === 'ЛЕМ', 'quick query transferred to advanced form');
      assert(cards() === 50 && tree.querySelector('.search-result-count').textContent === 'Найдено 51 книга', 'quick submit executes immediately');
      assert(tree.querySelectorAll('[aria-label^="Страница "]').length === 2, '51 results have two pages');
      pageTwo();
      assert(cards() === 1 && form === tree.querySelector('.book-search-form') && form.elements.query.value === 'ЛЕМ', 'page two retains form');
      setValue(form.elements.title, 'draft');
      tree.querySelector('[aria-label="Страница 1"]').click();
      assert(cards() === 50 && form.elements.title.value === 'draft', 'pagination preserves unsubmitted draft and applied results');
      setValue(form.elements.title, '');
      setValue(form.elements.genre, 'sci_psychology');
      form.requestSubmit();
      assert(cards() === 50 && !tree.querySelector('.book-pagination'), '50 results omit paginator and new search resets page');
      icon.click();
      assert(document.activeElement === form.elements.query && !header.classList.contains('quick-search-open'), 'icon focuses existing search');
      setValue(form.elements.query, 'нет совпадений');
      form.requestSubmit();
      assert(cards() === 0 && tree.textContent.includes('Ничего не найдено.') && !tree.querySelector('.book-pagination'), 'safe empty results');
      setValue(form.elements.query, 'Лем 49');
      form.requestSubmit();
      assert(tree.querySelector('.search-result-count').textContent === 'Найдена 1 книга', 'singular result count');
      tree.querySelector('.book-card-title').click();
      const modal = fixture.querySelector('#annotation-modal');
      assert(!modal.hidden, 'existing annotation modal opens from search');
      modal.querySelector('.book-author-link').click();
      assert(modal.hidden && tree.querySelector('.direct-results-title').textContent === 'Автор: Лем', 'modal direct filter remains functional');
      tree.querySelector('.book-genre-link').click();
      assert(tree.querySelector('.direct-results-title').textContent.startsWith('Жанр:'), 'genre direct filter remains functional');
      home();
      assert(tree.querySelector('.tree-list') && cards() === 1 && quick.value === '', 'home restores tree and resets search');
      icon.click();
      fixture.querySelector('#advanced-search-button').click();
      const emptyForm = tree.querySelector('.book-search-form');
      assert(emptyForm && [...emptyForm.querySelectorAll('input, select')].every((field) => !field.value), 'advanced form opens with six empty conditions');
      assert(emptyForm.querySelectorAll('input, select').length === 6, 'exactly the specified fields');
      const downloadStyles = getComputedStyle(document.querySelector('.book-download-button') || (() => {
        const button = document.createElement('button'); button.className = 'book-download-button'; fixture.append(button); return button;
      })());
      const submitStyles = getComputedStyle(emptyForm.querySelector('[type="submit"]'));
      equal([submitStyles.color, submitStyles.backgroundColor, submitStyles.borderRadius, submitStyles.borderWidth, submitStyles.fontSize],
        [downloadStyles.color, downloadStyles.backgroundColor, downloadStyles.borderRadius, downloadStyles.borderWidth, downloadStyles.fontSize], 'find matches download visual standard');
      home();
      assert(tree.querySelector('.tree-list') && !tree.querySelector('.book-search-form'), 'home exits search directly');
      equal(JSON.stringify(index), before, 'search leaves index untouched');
      assert(requests === 0, 'search, paging, modal and home issue no network requests for coverless fixtures');
    } finally {
      window.fetch = nativeFetch;
      ui.resetUi();
      fixture.remove();
    }
  });

  await test('quick search stays within mobile header and opens left on desktop without moving avatar', async () => {
    const markup = new DOMParser().parseFromString(await (await fetch('../index.html')).text(), 'text/html');
    const sourceHeader = markup.querySelector('.app-header');
    sourceHeader.querySelector('#sign-in-button').hidden = true;
    sourceHeader.querySelector('#user-controls').hidden = false;
    sourceHeader.querySelector('#book-search-button').hidden = false;
    sourceHeader.querySelector('#book-search-button').disabled = false;
    for (const width of [320, 390, 480, 768, 1200]) {
      const iframe = document.createElement('iframe');
      iframe.style.cssText = `width:${width}px;height:300px;border:0;`;
      const loaded = new Promise((resolve) => iframe.addEventListener('load', resolve, { once: true }));
      iframe.srcdoc = `<link rel="stylesheet" href="${new URL('../css/styles.css', location.href)}"><style>*{transition:none!important}</style><main class="app-shell">${sourceHeader.outerHTML}</main>`;
      document.body.append(iframe);
      await loaded;
      const doc = iframe.contentDocument;
      const header = doc.querySelector('.app-header');
      const avatar = doc.querySelector('#avatar-button');
      const before = avatar.getBoundingClientRect();
      header.classList.add('quick-search-open');
      const after = avatar.getBoundingClientRect();
      const input = doc.querySelector('#quick-search-input').getBoundingClientRect();
      const icon = doc.querySelector('#book-search-button').getBoundingClientRect();
      equal([after.x, after.y], [before.x, before.y], `avatar stable at ${width}px`);
      assert(input.left >= 0 && input.right <= width, `field fits viewport at ${width}px`);
      if (width <= 1000) assert(input.top >= after.bottom, `separate mobile row at ${width}px`);
      else assert(input.right <= icon.left, 'desktop field opens left of icon');
      assert(doc.documentElement.scrollWidth <= width, `no header overflow at ${width}px`);
      iframe.remove();
    }
  });
}

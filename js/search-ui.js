import { emptySearchState, librarySearchOptions, searchBooks } from './book-search.js';
import { createPaginator, paginateItems } from './pagination.js';
import { russianBookCount } from './direct-filter.js';

export function createSearchController({ container, header, button, quickForm, quickInput, advancedButton,
  books, genresRu, createCard, disposeCards, onOpen, documentRef = document }) {
  const searchState = emptySearchState();
  const events = new AbortController();
  let active = false;
  let matched = [];
  let form = null;
  let results = null;
  const listen = (element, type, callback) => element?.addEventListener(type, callback, { signal: events.signal });
  const closeQuick = (focus = false) => {
    header?.classList.remove('quick-search-open');
    button?.setAttribute('aria-expanded', 'false');
    if (quickForm) quickForm.inert = true;
    if (focus) button?.focus();
  };
  const renderResults = () => {
    const page = paginateItems(matched, searchState.page);
    searchState.page = page.currentPage;
    const count = documentRef.createElement('p');
    count.className = 'search-result-count';
    count.setAttribute('role', 'status');
    count.textContent = `${page.totalItems === 1 ? 'Найдена' : 'Найдено'} ${russianBookCount(page.totalItems)}`;
    const grid = documentRef.createElement('div');
    grid.className = 'book-grid';
    for (const book of page.items) grid.append(createCard(book));
    if (!page.totalItems) {
      const empty = documentRef.createElement('p');
      empty.textContent = 'Ничего не найдено.';
      grid.append(empty);
    }
    const paginator = createPaginator({ ...page, documentRef, onPageChange: (next) => {
      searchState.page = next;
      renderResults();
    } });
    disposeCards(results);
    results.replaceChildren(count, grid, ...(paginator ? [paginator] : []));
  };
  const execute = () => {
    searchState.page = 1;
    matched = searchBooks(books, searchState);
    renderResults();
  };
  const open = (run = false) => {
    closeQuick();
    if (!active) {
      onOpen();
      active = true;
      const heading = documentRef.createElement('h2');
      heading.textContent = 'Поиск книг';
      form = documentRef.createElement('form');
      form.className = 'book-search-form';
      const options = librarySearchOptions(books, genresRu);
      for (const [name, labelText, choices] of [
        ['query', 'Общий запрос'], ['title', 'Название'], ['author', 'Автор'], ['series', 'Цикл'],
        ['genre', 'Жанр', options.genres], ['language', 'Язык', options.languages],
      ]) {
        const label = documentRef.createElement('label');
        label.textContent = labelText;
        const field = documentRef.createElement(choices ? 'select' : 'input');
        field.name = name;
        if (choices) {
          for (const choice of [{ value: '', label: 'Любой' }, ...choices]) {
            const option = documentRef.createElement('option');
            option.value = choice.value;
            option.textContent = choice.label;
            field.append(option);
          }
        } else field.type = 'text';
        field.value = searchState[name];
        field.addEventListener('input', () => {
          searchState[name] = field.value;
          if (name === 'query' && quickInput) quickInput.value = field.value;
        });
        label.append(field);
        form.append(label);
      }
      const submit = documentRef.createElement('button');
      submit.type = 'submit';
      submit.className = 'search-submit-button';
      submit.textContent = 'НАЙТИ';
      form.append(submit);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        for (const key of Object.keys(emptySearchState()).filter((key) => key !== 'page')) {
          searchState[key] = form.elements.namedItem(key).value;
        }
        if (quickInput) quickInput.value = searchState.query;
        execute();
      });
      results = documentRef.createElement('div');
      results.className = 'book-search-results';
      disposeCards(container);
      container.replaceChildren(heading, form, results);
    }
    if (run) execute();
    else form.elements.namedItem('query').focus();
  };
  listen(button, 'click', () => {
    if (active) { form.elements.namedItem('query').focus(); return; }
    if (header.classList.contains('quick-search-open') && !quickInput.value.trim()) { closeQuick(); return; }
    header.classList.add('quick-search-open');
    button.setAttribute('aria-expanded', 'true');
    quickForm.inert = false;
    quickInput.focus();
  });
  listen(quickInput, 'input', () => { searchState.query = quickInput.value; });
  listen(quickForm, 'submit', (event) => {
    event.preventDefault();
    if (!quickInput.value.trim()) return;
    searchState.query = quickInput.value.trim();
    quickInput.value = searchState.query;
    open(true);
  });
  listen(advancedButton, 'click', () => open());
  listen(documentRef, 'keydown', (event) => {
    if (event.key === 'Escape' && header?.classList.contains('quick-search-open')) {
      event.preventDefault();
      closeQuick(true);
    }
  });
  listen(documentRef, 'click', (event) => {
    if (!quickForm?.contains(event.target) && !button?.contains(event.target) && !quickInput?.value.trim()) closeQuick();
  });
  if (button) button.disabled = false;
  return {
    get active() { return active; },
    leave() { active = false; form = null; results = null; matched = []; closeQuick(); },
    reset() {
      this.leave();
      Object.assign(searchState, emptySearchState());
      if (quickInput) quickInput.value = '';
    },
    destroy() { this.reset(); events.abort(); if (button) button.disabled = true; },
  };
}

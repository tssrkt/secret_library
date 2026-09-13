import { setupDropdown } from './dropdown.js';
import { buildLibraryLookups, folderHasLibraryChildren } from './library-view-model.js';
import { accountIdentity, createAvatarController } from './avatar.js';
import { createBookCard } from './book-card.js';
import { createAnnotationModalController } from './annotation-modal.js';
import { loadCover } from './cover-cache.js';
import { loadGenreDictionary } from './genre-labels.js';
import { createPaginator, paginateItems } from './pagination.js';
import { metadataActionLabels } from './indexing-state.js';
import { filterBooksByDirectValue, russianBookCount } from './direct-filter.js';
import { createSearchController } from './search-ui.js';
import { createIndexingErrorsController } from './indexing-errors-ui.js';
import { createUserSettingsController } from './user-settings-ui.js';
import { mountFriends } from './friends-ui.js';
import { createNotificationsController } from './notifications-ui.js';
import { social } from './social-runtime.js';
import { getAccessToken } from './auth.js';

const genresRu = await loadGenreDictionary().catch(() => ({}));

const coverUrls = new Set();
const pageByFolderId = new Map();
let resetLibraryHome = () => {};
let selectDirectFilter = () => {};
let searchController = null;
let settingsController = null;
let openSettings = () => {};
let reportSettingsError = (error) => showError(error.message);
const onAuthorFilter = (value) => selectDirectFilter({ type: 'author', value: value.trim() });
const onGenreFilter = (value) => selectDirectFilter({ type: 'genre', value });
const onSeriesFilter = (value) => selectDirectFilter({ type: 'series', value: value.trim() });

function clearCoverUrls() {
  for (const url of coverUrls) URL.revokeObjectURL(url);
  coverUrls.clear();
}

function disposeBookCards(container) {
  for (const card of container?.querySelectorAll?.('.book-card') || []) {
    card.dispatchEvent(new Event('book-card-dispose'));
  }
}

const elements = {
  signIn: document.querySelector('#sign-in-button'),
  home: document.querySelector('#library-home-link'),
  refresh: document.querySelector('#refresh-button'),
  metadata: document.querySelector('#metadata-button'),
  retryMetadata: document.querySelector('#retry-metadata-button'),
  stop: document.querySelector('#stop-button'),
  signOut: document.querySelector('#sign-out-button'),
  settings: document.querySelector('#settings-button'),
  userControls: document.querySelector('#user-controls'),
  accountDisplayName: document.querySelector('#account-display-name'),
  accountEmail: document.querySelector('#account-email'),
  avatar: document.querySelector('#avatar-button'),
  avatarImage: document.querySelector('#avatar-image'),
  avatarPlaceholder: document.querySelector('#avatar-placeholder'),
  avatarMenu: document.querySelector('#avatar-menu'),
  status: document.querySelector('#status-text'),
  stats: document.querySelector('#stats'),
  folderCount: document.querySelector('#folder-count'),
  bookCount: document.querySelector('#book-count'),
  errorPanel: document.querySelector('#error-panel'),
  errorText: document.querySelector('#error-text'),
  retry: document.querySelector('#retry-button'),
  libraryPanel: document.querySelector('#library-panel'),
  tree: document.querySelector('#library-tree'),
  annotationModal: document.querySelector('#annotation-modal'),
  annotationModalText: document.querySelector('#annotation-modal-text'),
  annotationModalClose: document.querySelector('#annotation-modal-close'),
  annotationModalTitle: document.querySelector('#annotation-modal-title'),
  annotationModalGenres: document.querySelector('#annotation-modal-genres'),
  annotationModalCoverImage: document.querySelector('#annotation-modal-cover-image'),
  annotationModalCoverPlaceholder: document.querySelector('#annotation-modal-cover-placeholder'),
};

const dropdown = setupDropdown(elements.avatar, elements.avatarMenu);
const retrySocial = () => { void social.connect(getAccessToken()); };
const notifications = createNotificationsController({ button: document.querySelector('#notifications-button'),
  panel: document.querySelector('#notifications-panel'), avatarButton: elements.avatar,
  closeAvatar: () => dropdown.close(), social, retry: retrySocial });
const indexingErrors = createIndexingErrorsController(document.querySelector('#indexing-errors'));
export function updateIndexingErrors(entries) { indexingErrors.update(entries); }
const avatar = createAvatarController(elements.avatar, elements.avatarImage, elements.avatarPlaceholder);
const annotationModal = createAnnotationModalController(
  elements.annotationModal,
  elements.annotationModalText,
  elements.annotationModalClose,
  elements.annotationModalTitle,
  elements.annotationModalGenres,
  elements.annotationModalCoverImage,
  elements.annotationModalCoverPlaceholder,
  {
    genresRu,
    onAuthorFilter,
    onGenreFilter,
    loadCover: async ({ coverFileId }) => {
      const url = URL.createObjectURL(await loadCover(coverFileId));
      coverUrls.add(url);
      return url;
    },
    releaseCoverUrl: (url) => {
      URL.revokeObjectURL(url);
      coverUrls.delete(url);
    },
  },
);

export function setUserAvatar(user = {}) {
  const identity = accountIdentity(user);
  elements.accountDisplayName.textContent = identity.displayName;
  elements.accountEmail.textContent = identity.emailAddress;
  elements.accountEmail.hidden = !identity.emailAddress;
  return avatar.set(user);
}
export function resetUserAvatar() {
  const identity = accountIdentity();
  elements.accountDisplayName.textContent = identity.displayName;
  elements.accountEmail.textContent = '';
  elements.accountEmail.hidden = true;
  avatar.reset();
}

export function bindActions(actions) {
  reportSettingsError = actions.settingsError || reportSettingsError;
  elements.settings?.addEventListener('click', () => openSettings());
  elements.home?.addEventListener('click', (event) => {
    event.preventDefault();
    actions.home?.();
  });
  elements.signIn.addEventListener('click', actions.signIn);
  elements.refresh.addEventListener('click', actions.refresh);
  elements.metadata.addEventListener('click', actions.indexMetadata);
  elements.retryMetadata.addEventListener('click', actions.retryMetadata);
  elements.stop.addEventListener('click', actions.stopMetadata);
  elements.signOut.addEventListener('click', actions.signOut);
  elements.retry.addEventListener('click', actions.rebuild);
}

export function setAuthorized(authorized) {
  const controls = document.querySelector('#notification-controls');
  if (controls) controls.hidden = !authorized;
  document.querySelector('.app-header')?.classList.toggle('social-header', authorized);
  if (elements.settings) elements.settings.disabled = !authorized;
  elements.signIn.hidden = authorized;
  elements.userControls.hidden = !authorized;
  elements.signOut.hidden = !authorized;
  const searchButton = document.querySelector('#book-search-button');
  if (searchButton) searchButton.hidden = !authorized;
  if (!authorized) {
    notifications.close();
    social.disconnect();
    dropdown.close();
    resetUserAvatar();
    elements.metadata.hidden = true;
    elements.retryMetadata.hidden = true;
    elements.stop.hidden = true;
  }
}

export function setBusy(busy) {
  elements.signIn.disabled = busy;
  elements.refresh.disabled = busy;
  elements.signOut.disabled = busy;
  elements.retry.disabled = busy;
  elements.metadata.disabled = busy;
  elements.retryMetadata.disabled = busy;
}

export function updateMetadataActions(index) {
  const labels = metadataActionLabels(index);
  elements.metadata.hidden = false;
  elements.metadata.textContent = labels.full;
  elements.retryMetadata.hidden = labels.retryHidden;
  elements.retryMetadata.textContent = labels.retry;
}

export function setMetadataRunning(running) {
  elements.stop.hidden = !running;
  elements.stop.disabled = false;
  elements.metadata.disabled = running;
  elements.retryMetadata.disabled = running;
  elements.refresh.disabled = running;
  elements.signOut.disabled = running;
  if (running) dropdown.close();
}

export function setStatus(message) { elements.status.textContent = message; }

export function showStats(folderCount, bookCount) {
  elements.stats.hidden = false;
  elements.folderCount.textContent = folderCount.toLocaleString('ru-RU');
  elements.bookCount.textContent = bookCount.toLocaleString('ru-RU');
}

export function showError(message, { canRebuild = false } = {}) {
  elements.errorText.textContent = message;
  elements.errorPanel.hidden = false;
  elements.retry.hidden = !canRebuild;
}

export function clearError() { elements.errorPanel.hidden = true; }

export function showLibraryHome() { resetLibraryHome(); }

export function renderLibrary(index, onDownload = async () => {}) {
  settingsController?.leave();
  searchController?.destroy();
  clearCoverUrls();
  disposeBookCards(elements.tree);
  elements.tree.replaceChildren();
  elements.libraryPanel.hidden = false;
  const root = index.folders.find((folder) => folder.id === index.rootFolderId);
  const lookups = buildLibraryLookups(index);
  const resultsState = { filter: null, page: 1 };
  settingsController = createUserSettingsController({
    container: elements.tree, index, clearError,
    mountSections: (page) => mountFriends(page, social, retrySocial),
    onError: (error) => reportSettingsError(error),
  });
  openSettings = () => {
    dropdown.close();
    annotationModal.close();
    searchController.reset();
    resultsState.filter = null;
    resultsState.page = 1;
    disposeBookCards(elements.tree);
    elements.libraryPanel.scrollTop = 0;
    void settingsController.open();
  };

  const createCard = (book) => createBookCard(book, onDownload, document, {
    onAnnotation: (details, trigger) => annotationModal.open(details, trigger),
    genresRu,
    onAuthorFilter,
    onGenreFilter,
    onSeriesFilter,
    loadCover: async ({ coverFileId }) => {
      const url = URL.createObjectURL(await loadCover(coverFileId));
      coverUrls.add(url);
      return url;
    },
    releaseCoverUrl: (url) => {
      URL.revokeObjectURL(url);
      coverUrls.delete(url);
    },
  });

  searchController = createSearchController({
    container: elements.tree,
    header: document.querySelector('.app-header'),
    button: document.querySelector('#book-search-button'),
    quickForm: document.querySelector('#quick-search-form'),
    quickInput: document.querySelector('#quick-search-input'),
    advancedButton: document.querySelector('#advanced-search-button'),
    books: index.books, genresRu, createCard, disposeCards: disposeBookCards,
    onOpen: () => {
      settingsController.leave();
      annotationModal.close();
      resultsState.filter = null;
      resultsState.page = 1;
      elements.libraryPanel.scrollTop = 0;
    },
  });

  function appendBookPage(list, parentId) {
    const books = lookups.booksByParent.get(parentId) || [];
    if (!books.length) return null;
    const item = document.createElement('li');
    item.className = 'book-grid-item';

    const renderPage = () => {
      const page = paginateItems(books, pageByFolderId.get(parentId) || 1);
      pageByFolderId.set(parentId, page.currentPage);
      const grid = document.createElement('div');
      grid.className = 'book-grid';
      for (const book of page.items) grid.append(createCard(book));
      const paginator = createPaginator({
        totalPages: page.totalPages,
        currentPage: page.currentPage,
        onPageChange: (nextPage) => {
          pageByFolderId.set(parentId, nextPage);
          renderPage();
        },
      });
      disposeBookCards(item);
      item.replaceChildren(grid, ...(paginator ? [paginator] : []));
    };
    renderPage();
    list.append(item);
    return renderPage;
  }

  let renderRootBookPage = null;
  function createBranch(parentId) {
    const list = document.createElement('ul');
    list.className = 'tree-list';
    for (const folder of lookups.foldersByParent.get(parentId) || []) {
      const item = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'tree-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'folder-toggle';
      button.textContent = folder.name;
      const hasChildren = folderHasLibraryChildren(lookups, folder.id);
      button.classList.toggle('empty', !hasChildren);
      button.setAttribute('aria-expanded', 'false');
      row.append(button);
      item.append(row);
      button.addEventListener('click', () => {
        const existing = item.querySelector(':scope > .tree-list');
        if (existing) {
          disposeBookCards(existing);
          existing.remove();
          button.setAttribute('aria-expanded', 'false');
        } else if (hasChildren) {
          item.append(createBranch(folder.id));
          button.setAttribute('aria-expanded', 'true');
        }
      });
      list.append(item);
    }
    const renderBooks = appendBookPage(list, parentId);
    if (parentId === (root?.id || index.rootFolderId)) renderRootBookPage = renderBooks;
    return list;
  }

  const rootId = root?.id || index.rootFolderId;
  let branch = createBranch(rootId);
  if (!branch.childElementCount) {
    const empty = document.createElement('p');
    empty.className = 'empty-library';
    empty.textContent = 'В библиотеке пока нет папок или FB2-файлов.';
    elements.tree.append(empty);
  } else {
    elements.tree.append(branch);
  }
  resetLibraryHome = () => {
    annotationModal.close();
    const wasResults = Boolean(resultsState.filter) || searchController.active || settingsController.active;
    settingsController.leave();
    searchController.reset();
    if (wasResults) {
      resultsState.filter = null;
      resultsState.page = 1;
      disposeBookCards(elements.tree);
      pageByFolderId.set(rootId, 1);
      branch = createBranch(rootId);
      elements.tree.replaceChildren(branch);
      if (!branch.childElementCount) {
        const empty = document.createElement('p');
        empty.className = 'empty-library';
        empty.textContent = 'В библиотеке пока нет папок или FB2-файлов.';
        elements.tree.append(empty);
      }
    }
    pageByFolderId.set(rootId, 1);
    if (!wasResults) renderRootBookPage?.();
    for (const item of branch.children) {
      const toggle = item.querySelector(':scope > .tree-row > .folder-toggle');
      const child = item.querySelector(':scope > .tree-list');
      disposeBookCards(child);
      child?.remove();
      toggle?.setAttribute('aria-expanded', 'false');
    }
    elements.libraryPanel.scrollTop = 0;
  };
  const renderResults = () => {
    const page = paginateItems(filterBooksByDirectValue(index.books, resultsState.filter), resultsState.page);
    resultsState.page = page.currentPage;
    const heading = document.createElement('h2');
    heading.className = 'direct-results-title';
    heading.tabIndex = -1;
    const { type, value } = resultsState.filter;
    heading.textContent = type === 'genre' ? `Жанр: ${genresRu[value] || value}`
      : type === 'series' ? `Цикл: ${value}` : `Автор: ${value}`;
    const count = document.createElement('p');
    count.textContent = `Найдено: ${russianBookCount(page.totalItems)}`;
    const grid = document.createElement('div');
    grid.className = 'book-grid';
    for (const book of page.items) grid.append(createCard(book));
    if (!page.totalItems) {
      const empty = document.createElement('p');
      empty.textContent = 'Ничего не найдено.';
      grid.append(empty);
    }
    const paginator = createPaginator({
      totalPages: page.totalPages,
      currentPage: page.currentPage,
      onPageChange: (nextPage) => {
        resultsState.page = nextPage;
        renderResults();
      },
    });
    disposeBookCards(elements.tree);
    elements.tree.replaceChildren(heading, count, grid, ...(paginator ? [paginator] : []));
    elements.libraryPanel.scrollTop = 0;
    heading.focus({ preventScroll: true });
  };
  selectDirectFilter = (filter) => {
    settingsController.leave();
    searchController.leave();
    annotationModal.close();
    resultsState.filter = filter;
    resultsState.page = 1;
    renderResults();
  };
  showStats(Math.max(0, index.folders.length - (root ? 1 : 0)), index.books.length);
  updateMetadataActions(index);
}

export function resetUi() {
  notifications.close();
  settingsController?.leave();
  settingsController = null;
  openSettings = () => {};
  indexingErrors.reset();
  searchController?.destroy();
  searchController = null;
  clearCoverUrls();
  elements.libraryPanel.hidden = true;
  elements.stats.hidden = true;
  disposeBookCards(elements.tree);
  elements.tree.replaceChildren();
  resetLibraryHome = () => {};
  selectDirectFilter = () => {};
  annotationModal.close();
  clearError();
}

export function saveDownloadedFile(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

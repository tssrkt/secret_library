import { setupDropdown } from './dropdown.js';
import { bookDisplayLabel, buildLibraryLookups, folderHasLibraryChildren } from './library-view-model.js';
import { createAvatarController } from './avatar.js';

const elements = {
  signIn: document.querySelector('#sign-in-button'),
  refresh: document.querySelector('#refresh-button'),
  metadata: document.querySelector('#metadata-button'),
  retryMetadata: document.querySelector('#retry-metadata-button'),
  stop: document.querySelector('#stop-button'),
  signOut: document.querySelector('#sign-out-button'),
  userControls: document.querySelector('#user-controls'),
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
  details: document.querySelector('#book-details'),
  closeDetails: document.querySelector('#close-details-button'),
  detailsTitle: document.querySelector('#details-book-title'),
  detailsAuthors: document.querySelector('#details-authors'),
  detailsSeries: document.querySelector('#details-series'),
  detailsFileName: document.querySelector('#details-file-name'),
  detailsAnnotation: document.querySelector('#details-annotation'),
};

const dropdown = setupDropdown(elements.avatar, elements.avatarMenu);
const avatar = createAvatarController(elements.avatar, elements.avatarImage, elements.avatarPlaceholder);

export function setUserAvatar(user) { return avatar.set(user); }
export function resetUserAvatar() { avatar.reset(); }

export function bindActions(actions) {
  elements.signIn.addEventListener('click', actions.signIn);
  elements.refresh.addEventListener('click', actions.refresh);
  elements.metadata.addEventListener('click', actions.indexMetadata);
  elements.retryMetadata.addEventListener('click', actions.retryMetadata);
  elements.stop.addEventListener('click', actions.stopMetadata);
  elements.signOut.addEventListener('click', actions.signOut);
  elements.retry.addEventListener('click', actions.rebuild);
  elements.closeDetails.addEventListener('click', () => { elements.details.hidden = true; });
}

export function setAuthorized(authorized) {
  elements.signIn.hidden = authorized;
  elements.userControls.hidden = !authorized;
  elements.signOut.hidden = !authorized;
  if (!authorized) {
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
  const pending = index.books.filter((book) => book.metadataStatus === 'pending').length;
  const failed = index.books.filter((book) => book.metadataStatus === 'error').length;
  elements.metadata.hidden = pending === 0;
  elements.metadata.textContent = pending ? `Проиндексировать книги (${pending.toLocaleString('ru-RU')})` : 'Проиндексировать книги';
  elements.retryMetadata.hidden = failed === 0;
  elements.retryMetadata.textContent = failed ? `Повторить ошибки (${failed.toLocaleString('ru-RU')})` : 'Повторить ошибки';
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

function showBookDetails(book) {
  const ready = book.metadataStatus === 'ready';
  elements.detailsTitle.textContent = ready ? (book.title || 'Не указано') : 'Метаданные не извлечены';
  elements.detailsAuthors.textContent = ready && book.authors?.length ? book.authors.join(', ') : 'Не указано';
  elements.detailsSeries.textContent = ready && book.series
    ? `${book.series}${book.seriesNumber == null ? '' : ` — № ${book.seriesNumber}`}`
    : 'Не указано';
  elements.detailsFileName.textContent = book.sourceType === 'zip' && book.entryPath
    ? `${book.fileName} → ${book.entryPath}`
    : book.fileName;
  elements.detailsAnnotation.textContent = ready && book.annotation ? book.annotation : 'Не указано';
  elements.details.hidden = false;
}

export function renderLibrary(index) {
  elements.tree.replaceChildren();
  elements.libraryPanel.hidden = false;
  const root = index.folders.find((folder) => folder.id === index.rootFolderId);
  const lookups = buildLibraryLookups(index);

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
          existing.hidden = !existing.hidden;
          button.setAttribute('aria-expanded', String(!existing.hidden));
        } else if (hasChildren) {
          item.append(createBranch(folder.id));
          button.setAttribute('aria-expanded', 'true');
        }
      });
      list.append(item);
    }
    for (const book of lookups.booksByParent.get(parentId) || []) {
      const item = document.createElement('li');
      item.className = 'tree-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'book-button';
      button.textContent = bookDisplayLabel(book);
      button.addEventListener('click', () => showBookDetails(book));
      item.append(button);
      list.append(item);
    }
    return list;
  }

  const rootId = root?.id || index.rootFolderId;
  const branch = createBranch(rootId);
  if (!branch.childElementCount) {
    const empty = document.createElement('p');
    empty.className = 'empty-library';
    empty.textContent = 'В библиотеке пока нет папок или FB2-файлов.';
    elements.tree.append(empty);
  } else {
    elements.tree.append(branch);
  }
  showStats(Math.max(0, index.folders.length - (root ? 1 : 0)), index.books.length);
  updateMetadataActions(index);
}

export function resetUi() {
  elements.libraryPanel.hidden = true;
  elements.stats.hidden = true;
  elements.tree.replaceChildren();
  elements.details.hidden = true;
  clearError();
}

import { setupDropdown } from './dropdown.js';
import { buildLibraryLookups, folderHasLibraryChildren } from './library-view-model.js';
import { createAvatarController, greetingText } from './avatar.js';
import { createBookCard } from './book-card.js';
import { createAnnotationModalController } from './annotation-modal.js';

const elements = {
  signIn: document.querySelector('#sign-in-button'),
  refresh: document.querySelector('#refresh-button'),
  metadata: document.querySelector('#metadata-button'),
  retryMetadata: document.querySelector('#retry-metadata-button'),
  stop: document.querySelector('#stop-button'),
  signOut: document.querySelector('#sign-out-button'),
  userControls: document.querySelector('#user-controls'),
  greeting: document.querySelector('#user-greeting'),
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
};

const dropdown = setupDropdown(elements.avatar, elements.avatarMenu);
const avatar = createAvatarController(elements.avatar, elements.avatarImage, elements.avatarPlaceholder);
const annotationModal = createAnnotationModalController(
  elements.annotationModal,
  elements.annotationModalText,
  elements.annotationModalClose,
);

export function setUserAvatar(user = {}) {
  elements.greeting.textContent = greetingText(user.displayName);
  return avatar.set(user);
}
export function resetUserAvatar() {
  elements.greeting.textContent = greetingText();
  avatar.reset();
}

export function bindActions(actions) {
  elements.signIn.addEventListener('click', actions.signIn);
  elements.refresh.addEventListener('click', actions.refresh);
  elements.metadata.addEventListener('click', actions.indexMetadata);
  elements.retryMetadata.addEventListener('click', actions.retryMetadata);
  elements.stop.addEventListener('click', actions.stopMetadata);
  elements.signOut.addEventListener('click', actions.signOut);
  elements.retry.addEventListener('click', actions.rebuild);
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

export function renderLibrary(index, onDownload = async () => {}) {
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
    const books = lookups.booksByParent.get(parentId) || [];
    if (books.length) {
      const item = document.createElement('li');
      item.className = 'book-grid-item';
      const grid = document.createElement('div');
      grid.className = 'book-grid';
      for (const book of books) {
        grid.append(createBookCard(book, onDownload, document, {
          onAnnotation: (annotation, trigger) => annotationModal.open(annotation, trigger),
        }));
      }
      item.append(grid);
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

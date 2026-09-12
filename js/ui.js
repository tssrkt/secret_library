const elements = {
  signIn: document.querySelector('#sign-in-button'),
  refresh: document.querySelector('#refresh-button'),
  metadata: document.querySelector('#metadata-button'),
  retryMetadata: document.querySelector('#retry-metadata-button'),
  stop: document.querySelector('#stop-button'),
  signOut: document.querySelector('#sign-out-button'),
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

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });

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
  elements.refresh.hidden = !authorized;
  elements.signOut.hidden = !authorized;
  if (!authorized) {
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

function buildLookups(index) {
  const foldersByParent = new Map();
  const booksByParent = new Map();
  for (const folder of index.folders) {
    if (folder.parentId == null) continue;
    const siblings = foldersByParent.get(folder.parentId) || [];
    siblings.push(folder);
    foldersByParent.set(folder.parentId, siblings);
  }
  for (const book of index.books) {
    const siblings = booksByParent.get(book.parentId) || [];
    siblings.push(book);
    booksByParent.set(book.parentId, siblings);
  }
  for (const siblings of foldersByParent.values()) siblings.sort((a, b) => collator.compare(a.name, b.name));
  for (const siblings of booksByParent.values()) siblings.sort((a, b) => collator.compare(a.fileName, b.fileName));
  return { foldersByParent, booksByParent };
}

function bookLabel(book) {
  if (book.metadataStatus !== 'ready') return book.fileName;
  const title = book.title || book.fileName;
  if (!book.authors?.length) return title;
  const authors = book.authors.length > 2
    ? `${book.authors.slice(0, 2).join(', ')} и др.`
    : book.authors.join(', ');
  return `${authors} — ${title}`;
}

function showBookDetails(book) {
  const ready = book.metadataStatus === 'ready';
  elements.detailsTitle.textContent = ready ? (book.title || 'Не указано') : 'Метаданные не извлечены';
  elements.detailsAuthors.textContent = ready && book.authors?.length ? book.authors.join(', ') : 'Не указано';
  elements.detailsSeries.textContent = ready && book.series
    ? `${book.series}${book.seriesNumber == null ? '' : ` — № ${book.seriesNumber}`}`
    : 'Не указано';
  elements.detailsFileName.textContent = book.fileName;
  elements.detailsAnnotation.textContent = ready && book.annotation ? book.annotation : 'Не указано';
  elements.details.hidden = false;
}

export function renderLibrary(index) {
  elements.tree.replaceChildren();
  elements.libraryPanel.hidden = false;
  const root = index.folders.find((folder) => folder.id === index.rootFolderId);
  const lookups = buildLookups(index);

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
      const hasChildren = lookups.foldersByParent.has(folder.id) || lookups.booksByParent.has(folder.id);
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
      button.textContent = bookLabel(book);
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

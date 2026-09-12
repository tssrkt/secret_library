const elements = {
  signIn: document.querySelector('#sign-in-button'),
  refresh: document.querySelector('#refresh-button'),
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
};

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });

export function bindActions(actions) {
  elements.signIn.addEventListener('click', actions.signIn);
  elements.refresh.addEventListener('click', actions.refresh);
  elements.signOut.addEventListener('click', actions.signOut);
  elements.retry.addEventListener('click', actions.rebuild);
}

export function setAuthorized(authorized) {
  elements.signIn.hidden = authorized;
  elements.refresh.hidden = !authorized;
  elements.signOut.hidden = !authorized;
}

export function setBusy(busy) {
  elements.signIn.disabled = busy;
  elements.refresh.disabled = busy;
  elements.signOut.disabled = busy;
  elements.retry.disabled = busy;
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
      item.className = 'tree-row book';
      item.textContent = book.fileName;
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
}

export function resetUi() {
  elements.libraryPanel.hidden = true;
  elements.stats.hidden = true;
  elements.tree.replaceChildren();
  clearError();
}

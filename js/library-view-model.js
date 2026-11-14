const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });

export function compareCatalogBooks(a, b) {
  return collator.compare(a.fileName, b.fileName);
}

export function buildLibraryLookups(index) {
  const foldersByParent = new Map();
  const booksByParent = new Map();
  const contentCounts = new Map();
  const countFor = (folderId) => {
    let count = contentCounts.get(folderId);
    if (!count) { count = { folderCount: 0, bookCount: 0 }; contentCounts.set(folderId, count); }
    return count;
  };
  for (const folder of index.folders) {
    if (folder.parentId == null) continue;
    const siblings = foldersByParent.get(folder.parentId) || [];
    siblings.push(folder);
    foldersByParent.set(folder.parentId, siblings);
    countFor(folder.parentId).folderCount++;
  }
  for (const book of index.books) {
    const siblings = booksByParent.get(book.parentId) || [];
    siblings.push(book);
    booksByParent.set(book.parentId, siblings);
    countFor(book.parentId).bookCount++;
  }
  for (const siblings of foldersByParent.values()) siblings.sort((a, b) => collator.compare(a.name, b.name));
  for (const siblings of booksByParent.values()) siblings.sort(compareCatalogBooks);
  return { foldersByParent, booksByParent, contentCounts };
}

export function folderHasLibraryChildren(lookups, folderId) {
  return lookups.foldersByParent.has(folderId) || lookups.booksByParent.has(folderId);
}

const visibilityMemos = new WeakMap();

// A folder belongs to the library only when it holds indexable books, directly
// or anywhere in its nested subfolders; empty branches stay out of the tree.
export function folderHasAnyBooks(lookups, folderId) {
  let memo = visibilityMemos.get(lookups);
  if (!memo) { memo = new Map(); visibilityMemos.set(lookups, memo); }
  const cached = memo.get(folderId);
  if (cached !== undefined) return cached;
  memo.set(folderId, false); // cycle guard for malformed indexes
  const result = lookups.booksByParent.has(folderId)
    || (lookups.foldersByParent.get(folderId) || []).some((child) => folderHasAnyBooks(lookups, child.id));
  memo.set(folderId, result);
  return result;
}

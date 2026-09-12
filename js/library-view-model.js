const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });

export function buildLibraryLookups(index) {
  const foldersByParent = new Map();
  const booksByParent = new Map();
  for (const folder of index.folders) {
    if (folder.parentId == null) continue;
    const siblings = foldersByParent.get(folder.parentId) || [];
    siblings.push(folder);
    foldersByParent.set(folder.parentId, siblings);
  }
  for (const book of index.books) {
    // A ZIP proven not to be a readable FB2 source remains in the index for diagnostics/retry,
    // but it is not presented as a book or used to make a folder expandable.
    if (book.sourceType === 'zip' && book.metadataStatus === 'error') continue;
    const siblings = booksByParent.get(book.parentId) || [];
    siblings.push(book);
    booksByParent.set(book.parentId, siblings);
  }
  for (const siblings of foldersByParent.values()) siblings.sort((a, b) => collator.compare(a.name, b.name));
  for (const siblings of booksByParent.values()) siblings.sort((a, b) => collator.compare(a.fileName, b.fileName));
  return { foldersByParent, booksByParent };
}

export function folderHasLibraryChildren(lookups, folderId) {
  return lookups.foldersByParent.has(folderId) || lookups.booksByParent.has(folderId);
}

export function bookDisplayLabel(book) {
  if (book.metadataStatus !== 'ready') return book.fileName;
  const title = book.title || book.entryPath?.split('/').at(-1) || book.fileName;
  if (!book.authors?.length) return title;
  const authors = book.authors.length > 2
    ? `${book.authors.slice(0, 2).join(', ')} и др.`
    : book.authors.join(', ');
  return `${authors} — ${title}`;
}

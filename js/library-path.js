// Diagnostic text only: resolve from the already loaded tree, never from Drive.
export function libraryFilePath(index, book) {
  const folders = new Map((index.folders || []).map((folder) => [folder.id, folder]));
  const parts = [book.fileName];
  const visited = new Set();
  let parent = book.parentId;
  while (parent && !visited.has(parent)) {
    visited.add(parent);
    const folder = folders.get(parent);
    if (!folder) return book.path || null;
    parts.unshift(folder.name);
    if (parent === index.rootFolderId) return parts.filter(Boolean).join(' / ');
    parent = folder.parentId;
  }
  return book.path || null;
}

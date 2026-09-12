import { COVER_CACHE_PREFIX, COVER_MAX_HEIGHT, COVER_MAX_WIDTH } from './config.js';
import { createAppDataBlob, deleteAppDataFile, downloadAppDataBlob, listAppDataFilesByPrefix } from './drive.js';

export async function resizeCover({ bytes, mimeType }, {
  createBitmap = createImageBitmap,
  createCanvas = () => document.createElement('canvas'),
} = {}) {
  const bitmap = await createBitmap(new Blob([bytes], { type: mimeType }));
  try {
    const scale = Math.min(1, COVER_MAX_WIDTH / bitmap.width, COVER_MAX_HEIGHT / bitmap.height);
    const canvas = createCanvas();
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82));
    if (!blob) throw new Error('Cover could not be resized.');
    return blob;
  } finally {
    bitmap.close?.();
  }
}

export async function storeCover(book, cover, dependencies = {}) {
  const resize = dependencies.resize || resizeCover;
  const create = dependencies.create || createAppDataBlob;
  const blob = await resize(cover);
  const saved = await create(`${COVER_CACHE_PREFIX}${book.id}.webp`, blob);
  return { coverFileId: saved.id, coverMimeType: blob.type };
}

export async function loadCover(fileId, signal, download = downloadAppDataBlob) {
  return download(fileId, signal);
}

export async function removeCovers(fileIds, remove = deleteAppDataFile) {
  for (const fileId of new Set(fileIds.filter(Boolean))) {
    try { await remove(fileId); } catch (error) {
      if (error?.status !== 404) throw error;
    }
  }
}

export async function removeOrphanCovers(index, list = listAppDataFilesByPrefix, remove = deleteAppDataFile) {
  const referenced = new Set(index.books.map((book) => book.coverFileId).filter(Boolean));
  const cached = await list(COVER_CACHE_PREFIX);
  await removeCovers(cached.filter((file) => !referenced.has(file.id)).map((file) => file.id), remove);
}

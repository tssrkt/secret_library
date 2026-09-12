function textOrFallback(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function bookCardView(book) {
  const ready = book.metadataStatus === 'ready';
  const genre = Array.isArray(book.genres)
    ? book.genres.find((value) => typeof value === 'string' && value.trim())
    : book.genre;
  const fallbackTitle = String(book.fileName || '').replace(/\.(fb2|zip)$/i, '').trim() || book.fileName;
  return {
    author: ready && book.authors?.length ? book.authors.join(', ') : 'Автор не указан',
    title: ready ? textOrFallback(book.title, fallbackTitle) : fallbackTitle,
    genreLine: ready && typeof genre === 'string' && genre.trim() ? `Жанр: ${book.genres?.join(', ') || genre.trim()}` : 'Жанр не указан',
    annotation: ready ? textOrFallback(book.annotation, 'Аннотация отсутствует') : 'Аннотация отсутствует',
  };
}

export function createBookCard(book, onDownload, documentRef = document, options = {}) {
  const content = bookCardView(book);
  const article = documentRef.createElement('article');
  article.className = 'book-card';

  const media = documentRef.createElement('div');
  media.className = 'book-card-media';

  const cover = documentRef.createElement('div');
  cover.className = 'book-cover-placeholder';
  cover.setAttribute('aria-label', 'Обложка отсутствует');
  cover.innerHTML = '<span aria-hidden="true">▤</span><small>Нет обложки</small>';

  const body = documentRef.createElement('div');
  body.className = 'book-card-body';
  const author = documentRef.createElement('p');
  author.className = 'book-card-author';
  author.textContent = content.author;
  const title = documentRef.createElement('h3');
  title.className = 'book-card-title';
  title.textContent = content.title;
  const genre = documentRef.createElement('p');
  genre.className = 'book-card-genre';
  genre.textContent = content.genreLine;
  const annotationBlock = documentRef.createElement('div');
  annotationBlock.className = 'book-card-annotation-block';
  const annotation = documentRef.createElement('p');
  annotation.className = 'book-card-annotation';
  annotation.textContent = content.annotation;
  const more = documentRef.createElement('button');
  more.type = 'button';
  more.className = 'book-annotation-more';
  more.textContent = 'Читать далее';
  more.hidden = true;
  more.addEventListener('click', () => options.onAnnotation?.({
    annotation: content.annotation,
    title: content.title,
    author: content.author,
  }, more));
  annotationBlock.append(annotation, more);
  const download = documentRef.createElement('button');
  download.type = 'button';
  download.className = 'book-download-button';
  download.textContent = 'Скачать';
  download.addEventListener('click', async () => {
    download.disabled = true;
    try { await onDownload(book); }
    finally { download.disabled = false; }
  });
  media.append(cover, download);
  body.append(author, title, genre, annotationBlock);
  article.append(media, body);

  if (book.coverFileId && options.loadCover) {
    Promise.resolve(options.loadCover(book)).then((url) => {
      if (!url) return;
      if (!cover.isConnected) {
        options.releaseCoverUrl?.(url);
        return;
      }
      const image = documentRef.createElement('img');
      image.className = 'book-cover-image';
      image.alt = `Обложка: ${content.title}`;
      image.src = url;
      image.addEventListener('load', () => options.releaseCoverUrl?.(url), { once: true });
      image.addEventListener('error', () => {
        options.releaseCoverUrl?.(url);
        image.replaceWith(cover);
      }, { once: true });
      cover.replaceWith(image);
    }).catch(() => {});
  }

  const updateMore = () => {
    const overflowing = options.isAnnotationOverflowing
      ? options.isAnnotationOverflowing(annotation)
      : annotation.scrollHeight > annotation.clientHeight + 1;
    more.hidden = !overflowing;
  };
  if (documentRef.defaultView?.requestAnimationFrame) documentRef.defaultView.requestAnimationFrame(updateMore);
  else globalThis.requestAnimationFrame(updateMore);
  return article;
}

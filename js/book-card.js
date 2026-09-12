function textOrFallback(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function bookCardView(book) {
  const ready = book.metadataStatus === 'ready';
  return {
    author: ready && book.authors?.length ? book.authors.join(', ') : 'Автор не указан',
    title: ready ? textOrFallback(book.title, book.fileName) : book.fileName,
    genres: 'Жанр не указан',
    annotation: ready ? textOrFallback(book.annotation, 'Аннотация пока не загружена') : 'Аннотация пока не загружена',
  };
}

export function createBookCard(book, onDownload, documentRef = document) {
  const content = bookCardView(book);
  const article = documentRef.createElement('article');
  article.className = 'book-card';

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
  const genres = documentRef.createElement('p');
  genres.className = 'book-card-genres';
  genres.textContent = content.genres;
  const annotation = documentRef.createElement('p');
  annotation.className = 'book-card-annotation';
  annotation.textContent = content.annotation;
  const download = documentRef.createElement('button');
  download.type = 'button';
  download.className = 'book-download-button';
  download.textContent = 'Скачать';
  download.addEventListener('click', async () => {
    download.disabled = true;
    try { await onDownload(book); }
    finally { download.disabled = false; }
  });
  body.append(author, title, genres, annotation, download);
  article.append(cover, body);
  return article;
}

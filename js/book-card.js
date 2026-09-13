import { seriesName, seriesLabel } from './book-series.js';

function textOrFallback(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function bookCardView(book, genresRu = {}) {
  const ready = book.metadataStatus === 'ready';
  const genre = Array.isArray(book.genres)
    ? book.genres.find((value) => typeof value === 'string' && value.trim())
    : book.genre;
  const fallbackTitle = String(book.fileName || '').replace(/\.(fb2|zip|epub|mobi)$/i, '').trim() || book.fileName;
  return {
    author: ready && book.authors?.length ? book.authors.join(', ') : 'Автор не указан',
    title: ready ? textOrFallback(book.title, fallbackTitle) : fallbackTitle,
    genreLine: ready && typeof genre === 'string' && genre.trim()
      ? (book.genres || [genre]).map((code) => genresRu[code] || code).join(', ')
      : 'Жанр не указан',
    annotation: ready ? textOrFallback(book.annotation, textOrFallback(book.preview, '')) : 'Аннотация отсутствует',
  };
}

export function createBookCard(book, onDownload, documentRef = document, options = {}) {
  const content = bookCardView(book, options.genresRu);
  const article = documentRef.createElement('article');
  article.className = 'book-card';
  article.tabIndex = 0;
  article.setAttribute('role', 'button');
  article.setAttribute('aria-label', `Открыть сведения: ${content.title}`);

  const annotationDetails = {
    annotation: content.annotation,
    title: content.title,
    author: content.author,
    authors: Array.isArray(book.authors) ? [...book.authors] : [],
    genres: Array.isArray(book.genres) ? book.genres : [],
    coverFileId: book.coverFileId || null,
  };
  const openAnnotation = () => options.onAnnotation?.(annotationDetails, article);
  article.addEventListener('click', (event) => {
    if (event.target.closest('button, a, input, select, textarea')) return;
    const selection = documentRef.defaultView?.getSelection?.();
    if (selection && !selection.isCollapsed && article.contains(selection.anchorNode)) return;
    openAnnotation();
  });
  article.addEventListener('keydown', (event) => {
    if (event.target !== article || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    openAnnotation();
  });

  const media = documentRef.createElement('div');
  media.className = 'book-card-media';

  const coverFrame = documentRef.createElement('div');
  coverFrame.className = 'book-cover-frame';

  const cover = documentRef.createElement('div');
  cover.className = 'book-cover-placeholder';
  cover.setAttribute('aria-label', 'Обложка отсутствует');
  cover.innerHTML = '<span aria-hidden="true">▤</span><small>Нет обложки</small>';

  const body = documentRef.createElement('div');
  body.className = 'book-card-body';
  const author = documentRef.createElement('p');
  author.className = 'book-card-author';
  const authors = Array.isArray(book.authors)
    ? book.authors.filter((value) => typeof value === 'string' && value.trim())
    : [];
  if (authors.length && options.onAuthorFilter) {
    authors.forEach((value, index) => {
      if (index) author.append(documentRef.createTextNode(', '));
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.className = 'book-metadata-link book-author-link';
      button.textContent = value.trim();
      button.addEventListener('click', () => options.onAuthorFilter(value.trim()));
      author.append(button);
    });
  } else author.textContent = content.author;
  const title = documentRef.createElement('h3');
  title.className = 'book-card-title';
  title.textContent = content.title;
  const genre = documentRef.createElement('p');
  genre.className = 'book-card-genre';
  const genreCodes = Array.isArray(book.genres)
    ? book.genres.filter((value) => typeof value === 'string' && value.trim())
    : [];
  if (genreCodes.length && options.onGenreFilter) {
    genreCodes.forEach((code, index) => {
      if (index) genre.append(documentRef.createTextNode(', '));
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.className = 'book-metadata-link book-genre-link';
      button.textContent = options.genresRu?.[code] || code;
      button.addEventListener('click', () => options.onGenreFilter(code, button.textContent));
      genre.append(button);
    });
  } else genre.textContent = content.genreLine;
  const cycle = seriesName(book);
  if (cycle) {
    genre.append(documentRef.createTextNode(', '));
    const element = documentRef.createElement(options.onSeriesFilter ? 'button' : 'span');
    element.textContent = seriesLabel(book);
    if (options.onSeriesFilter) {
      element.type = 'button';
      element.className = 'book-metadata-link book-series-link';
      element.addEventListener('click', () => options.onSeriesFilter(cycle));
    }
    genre.append(element);
  }
  const annotationBlock = documentRef.createElement('div');
  annotationBlock.className = 'book-card-annotation-block';
  const annotation = documentRef.createElement('p');
  annotation.className = 'book-card-annotation';
  annotation.textContent = content.annotation;
  annotationBlock.append(annotation);
  const download = documentRef.createElement('button');
  download.type = 'button';
  download.className = 'book-download-button';
  download.textContent = 'СКАЧАТЬ';
  download.addEventListener('click', async (event) => {
    event.stopPropagation();
    download.disabled = true;
    try { await onDownload(book); }
    finally { download.disabled = false; }
  });
  coverFrame.append(cover);
  media.append(coverFrame, download);
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

  const updateAnnotationClamp = () => {
    annotation.classList.remove('truncated');
    annotation.style.removeProperty('--annotation-lines');
    annotation.style.removeProperty('--annotation-height');
    const overflowing = options.isAnnotationOverflowing
      ? options.isAnnotationOverflowing(annotation)
      : annotation.scrollHeight > annotationBlock.clientHeight + 1;
    if (overflowing) {
      const styles = documentRef.defaultView?.getComputedStyle(annotation);
      const lineHeight = Number.parseFloat(styles?.lineHeight) || 16;
      const lines = Math.max(1, Math.floor(annotationBlock.clientHeight / lineHeight));
      annotation.style.setProperty('--annotation-lines', String(lines));
      annotation.style.setProperty('--annotation-height', `${lines * lineHeight}px`);
      annotation.classList.add('truncated');
    }
  };
  const scheduleUpdate = () => {
    if (options.scheduleFrame) {
      options.scheduleFrame(updateAnnotationClamp);
      return;
    }
    const frame = documentRef.defaultView?.requestAnimationFrame || globalThis.requestAnimationFrame;
    frame(updateAnnotationClamp);
  };
  scheduleUpdate();
  if (options.observeResize) options.observeResize(article, scheduleUpdate);
  else if (documentRef.defaultView?.ResizeObserver) {
    const resizeObserver = new documentRef.defaultView.ResizeObserver(scheduleUpdate);
    resizeObserver.observe(article);
    article.addEventListener('book-card-dispose', () => resizeObserver.disconnect(), { once: true });
  }
  return article;
}

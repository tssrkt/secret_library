import { genreLabels } from './genre-labels.js';

const MOBILE_BREAKPOINT = 650;

export function modalCoverWidth(modalHeight, naturalWidth, naturalHeight, viewportWidth) {
  if (!modalHeight || !naturalWidth || !naturalHeight) return 0;
  const scaledWidth = modalHeight * naturalWidth / naturalHeight;
  if (viewportWidth > MOBILE_BREAKPOINT) return scaledWidth;
  return Math.min(scaledWidth, viewportWidth * 0.38);
}

export function formatModalAuthors(book) {
  const authors = Array.isArray(book.authors)
    ? book.authors.filter((author) => typeof author === 'string' && author.trim()).map((author) => author.trim())
    : [];
  if (authors.length >= 3) return `${authors.slice(0, 2).join(', ')} и другие`;
  if (authors.length) return authors.join(', ');
  return typeof book.author === 'string' && book.author.trim() ? book.author.trim() : 'Автор не указан';
}

export function createAnnotationModalController(
  overlay, text, closeButton, title, genres, coverImage = null, coverPlaceholder = null,
  options = {}, documentRef = document,
) {
  let returnFocus = null;
  let version = 0;
  let activeCoverUrl = null;
  let coverResizeObserver = null;

  const releaseCover = () => {
    if (activeCoverUrl) options.releaseCoverUrl?.(activeCoverUrl);
    activeCoverUrl = null;
  };
  const resetCover = () => {
    coverResizeObserver?.disconnect();
    coverResizeObserver = null;
    releaseCover();
    if (!coverImage || !coverPlaceholder) return;
    coverImage.onload = null;
    coverImage.onerror = null;
    coverImage.hidden = true;
    coverImage.removeAttribute('src');
    coverPlaceholder.hidden = false;
    coverImage.parentElement.style.removeProperty('width');
  };
  const close = () => {
    if (overlay.hidden) return;
    version += 1;
    resetCover();
    overlay.hidden = true;
    const target = returnFocus;
    returnFocus = null;
    target?.focus();
  };
  const open = (book, trigger = null) => {
    const openVersion = ++version;
    returnFocus = trigger;
    title.textContent = `«${book.title}» ${formatModalAuthors(book)}`;
    genres.textContent = book.genres?.length ? book.genres.join(', ') : 'Жанр не указан';
    text.textContent = book.annotation;
    resetCover();
    overlay.hidden = false;
    closeButton.focus();

    void Promise.resolve((options.genreLabels || genreLabels)(book.genres)).then((labels) => {
      if (openVersion === version) genres.textContent = labels;
    });
    if (book.coverFileId && coverImage && coverPlaceholder && options.loadCover) {
      void Promise.resolve(options.loadCover(book)).then((url) => {
        if (!url) return;
        if (openVersion !== version) {
          options.releaseCoverUrl?.(url);
          return;
        }
        activeCoverUrl = url;
        coverImage.onload = () => {
          if (openVersion !== version) return;
          const modal = coverImage.closest('.annotation-modal');
          const syncCoverWidth = () => {
            const width = modalCoverWidth(
              modal?.clientHeight || 0,
              coverImage.naturalWidth,
              coverImage.naturalHeight,
              documentRef.defaultView.innerWidth,
            );
            if (width && Math.abs(coverImage.parentElement.clientWidth - width) > 0.5) {
              coverImage.parentElement.style.width = `${width}px`;
            }
          };
          syncCoverWidth();
          coverPlaceholder.hidden = true;
          coverImage.hidden = false;
          const ResizeObserverClass = documentRef.defaultView.ResizeObserver;
          if (modal && ResizeObserverClass) {
            coverResizeObserver = new ResizeObserverClass(syncCoverWidth);
            coverResizeObserver.observe(modal);
          }
          releaseCover();
        };
        coverImage.onerror = resetCover;
        coverImage.src = url;
      }).catch(() => {});
    }
  };

  closeButton.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  documentRef.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) {
      event.preventDefault();
      close();
    }
  });
  return { open, close };
}

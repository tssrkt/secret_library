import { genreLabels } from './genre-labels.js';

export function createAnnotationModalController(
  overlay, text, closeButton, title, genres, coverImage = null, coverPlaceholder = null,
  options = {}, documentRef = document,
) {
  let returnFocus = null;
  let version = 0;
  let activeCoverUrl = null;

  const releaseCover = () => {
    if (activeCoverUrl) options.releaseCoverUrl?.(activeCoverUrl);
    activeCoverUrl = null;
  };
  const resetCover = () => {
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
    title.textContent = `«${book.title}» ${book.author}`;
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
          const modalHeight = coverImage.closest('.annotation-modal')?.clientHeight || 0;
          if (modalHeight && coverImage.naturalHeight) {
            const naturalWidth = modalHeight * coverImage.naturalWidth / coverImage.naturalHeight;
            const maximumWidth = Math.min(300, documentRef.defaultView.innerWidth * 0.38);
            coverImage.parentElement.style.width = `${Math.min(naturalWidth, maximumWidth)}px`;
          }
          coverPlaceholder.hidden = true;
          coverImage.hidden = false;
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

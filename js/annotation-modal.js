export function createAnnotationModalController(overlay, text, closeButton, title, label, documentRef = document) {
  let returnFocus = null;

  const close = () => {
    if (overlay.hidden) return;
    overlay.hidden = true;
    const target = returnFocus;
    returnFocus = null;
    target?.focus();
  };

  const open = (book, trigger = null) => {
    returnFocus = trigger;
    title.textContent = `«${book.title}» ${book.author}`;
    label.textContent = 'Аннотация';
    text.textContent = book.annotation;
    overlay.hidden = false;
    closeButton.focus();
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

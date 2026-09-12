export function setupDropdown(toggle, menu) {
  const enabledItems = () => [...menu.querySelectorAll('[role="menuitem"]:not([disabled]):not([hidden])')];
  const close = ({ restoreFocus = false } = {}) => {
    if (menu.hidden) return;
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) toggle.focus();
  };
  const open = () => {
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
  };
  const toggleMenu = () => (menu.hidden ? open() : close());

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMenu();
  });
  menu.addEventListener('click', (event) => {
    if (event.target.closest('[role="menuitem"]:not([disabled])')) close();
  });
  document.addEventListener('click', (event) => {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== toggle) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      close({ restoreFocus: true });
    }
    if (event.key === 'ArrowDown' && document.activeElement === toggle) {
      event.preventDefault();
      open();
      enabledItems()[0]?.focus();
    }
  });
  return { open, close, toggle: toggleMenu };
}

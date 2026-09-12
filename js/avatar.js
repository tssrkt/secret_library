const DEFAULT_LABEL = 'Открыть меню пользователя';

export function greetingText(displayName = '') {
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  return name ? `Привет, ${name}!` : 'Привет!';
}

export function createAvatarController(button, image, placeholder) {
  let version = 0;
  let settlePending = null;

  const showPlaceholder = (displayName = '') => {
    image.hidden = true;
    image.removeAttribute('src');
    placeholder.hidden = false;
    const label = displayName ? `Профиль: ${displayName}` : DEFAULT_LABEL;
    button.setAttribute('aria-label', label);
    button.title = displayName || '';
  };

  const reset = () => {
    version += 1;
    settlePending?.(false);
    settlePending = null;
    image.onload = null;
    image.onerror = null;
    showPlaceholder();
  };

  const set = (user = {}) => {
    user ||= {};
    version += 1;
    const requestVersion = version;
    settlePending?.(false);
    settlePending = null;
    image.onload = null;
    image.onerror = null;
    showPlaceholder(user.displayName || '');
    if (!user.photoLink) return Promise.resolve(false);

    return new Promise((resolve) => {
      settlePending = resolve;
      image.onload = () => {
        if (requestVersion !== version) return;
        placeholder.hidden = true;
        image.hidden = false;
        image.onload = null;
        image.onerror = null;
        settlePending = null;
        resolve(true);
      };
      image.onerror = () => {
        if (requestVersion !== version) return;
        image.onload = null;
        image.onerror = null;
        settlePending = null;
        showPlaceholder(user.displayName || '');
        resolve(false);
      };
      image.src = user.photoLink;
    });
  };

  reset();
  return { set, reset };
}

export async function applyDriveAvatar(fetchUser, setUser) {
  try {
    return await setUser(await fetchUser());
  } catch {
    await setUser(null);
    return false;
  }
}

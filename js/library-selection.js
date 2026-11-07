export function createLibrarySelection({ tabs, service, show, unavailable, location = window.location, history = window.history, events = window }) {
  let selected = new URL(location.href).searchParams.get('library') || '';
  let own = null;
  let snapshot = { status: 'idle', libraries: [] };
  let version = 0;
  let renderedKey = null;
  const update = async (force = false) => {
    // Friend tabs are discovered from Google Drive and remain available even if
    // the optional Firebase social store is loading, unavailable, or over quota.
    const libraries = Array.isArray(snapshot.libraries) ? snapshot.libraries : [];
    tabs.update(libraries, selected);
    if (!own) return;
    const target = libraries.find((library) => library.uid === selected);
    // Social status changes are unrelated to the selected home library. Including them
    // in this key remounts the whole book tree (and makes folder notes flicker).
    const key = selected
      ? `${selected}:${target?.revision || ''}:${snapshot.status}:${snapshot.driveDiscoveryMessage || ''}`
      : 'own-library';
    if (!force && key === renderedKey) return;
    renderedKey = key;
    const request = ++version;
    if (!selected) { show(own, { own: true, ownerIndex: own, ownerId: '' }); return; }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(selected) || !target) {
      const base = snapshot.status === 'loading' ? 'Проверяем доступ к библиотеке…' : 'Библиотека не найдена среди доступных каталогов друзей.';
      unavailable(base, () => select(''));
      return;
    }
    unavailable('Загружаем библиотеку…', () => select(''));
    try {
      const index = await service.loadLibrary(selected, target.revision, target.catalogId || '');
      if (request === version) show(index, { own: false, ownerIndex: own, ownerId: selected });
    } catch (error) {
      if (request === version) {
        const detail = typeof error?.message === 'string' && error.message.trim() ? ` ${error.message}` : '';
        unavailable(`Не удалось открыть библиотеку друга.${detail}`, () => select(''));
      }
    }
  };
  function select(uid, write = true) {
    selected = uid;
    if (write) {
      const url = new URL(location.href);
      if (uid) url.searchParams.set('library', uid); else url.searchParams.delete('library');
      history.pushState(null, '', url);
    }
    void update(true);
  }
  const pop = () => select(new URL(location.href).searchParams.get('library') || '', false);
  events.addEventListener('popstate', pop);
  const stop = service.subscribe((value) => { snapshot = value; void update(); });
  return {
    select,
    get selected() { return selected; },
    setOwn(index) { own = index; void update(!selected); },
    reset() {
      version++; own = null; selected = ''; renderedKey = null; tabs.update([], '');
      const url = new URL(location.href); url.searchParams.delete('library'); history.replaceState(null, '', url);
    },
    destroy() { version++; stop(); events.removeEventListener('popstate', pop); },
  };
}

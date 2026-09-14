export function createLibrarySelection({ tabs, service, show, unavailable, location = window.location, history = window.history, events = window }) {
  let selected = new URL(location.href).searchParams.get('library') || '';
  let own = null;
  let snapshot = { status: 'idle', libraries: [] };
  let version = 0;
  let renderedKey = null;
  const update = async (force = false) => {
    const libraries = snapshot.status === 'ready' ? snapshot.libraries || [] : [];
    tabs.update(libraries, selected);
    if (!own) return;
    const target = libraries.find((library) => library.uid === selected);
    const key = `${selected}:${target?.revision || ''}:${snapshot.status}`;
    if (!force && key === renderedKey) return;
    renderedKey = key;
    const request = ++version;
    if (!selected) { show(own, { own: true, ownerIndex: own }); return; }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(selected) || !target) {
      unavailable(snapshot.status === 'loading' ? 'Проверяем доступ к библиотеке…' : 'Библиотека недоступна или доступ к ней закрыт.', () => select(''));
      return;
    }
    unavailable('Загружаем библиотеку…', () => select(''));
    try {
      const index = await service.loadLibrary(selected, target.revision);
      if (request === version) show(index, { own: false, ownerIndex: own });
    } catch (error) {
      if (request === version) unavailable('Не удалось открыть библиотеку. Возможно, доступ закрыт или соединение прервано.', () => select(''));
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

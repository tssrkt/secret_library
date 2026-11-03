const view = document.querySelector('#document-view');
const shell = document.querySelector('.app-shell');
const pages = {
  info: { url: './info.html', title: 'Инструкция — Тайная Библиотека' },
  privacy: { url: './privacy.html', title: 'Политика конфиденциальности — Тайная Библиотека' },
};
let activePage = '';

function showDocumentMode(enabled) {
  view.hidden = !enabled;
  shell?.classList.toggle('document-mode', enabled);
}

async function renderDocument(key, { updateHistory = true } = {}) {
  const page = pages[key];
  if (!page || !view) return;
  if (activePage === key && !view.hidden) return;
  view.setAttribute('aria-busy', 'true');
  showDocumentMode(true);
  try {
    const response = await fetch(page.url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
    const article = parsed.querySelector('.info-document');
    if (!article) throw new Error('Не найден текст документа');
    const footer = document.createElement('nav');
    footer.className = 'document-navigation';
    footer.setAttribute('aria-label', 'Навигация по документам');
    footer.innerHTML = '<a href="./info.html" data-document="info">Инструкция</a><a href="./privacy.html" data-document="privacy">Конфиденциальность</a><a href="./index.html" data-document-home>Вернуться в библиотеку</a>';
    view.replaceChildren(document.importNode(article, true), footer);
    activePage = key;
    document.title = page.title;
    if (updateHistory) history.pushState({ documentPage: key }, '', `#document=${key}`);
    view.scrollIntoView({ block: 'start' });
  } catch (error) {
    view.replaceChildren();
    const message = document.createElement('p');
    message.className = 'document-load-error';
    message.textContent = 'Не удалось загрузить документ. Проверьте соединение и попробуйте ещё раз.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Повторить';
    retry.addEventListener('click', () => { activePage = ''; void renderDocument(key, { updateHistory: false }); });
    view.append(message, retry);
    console.error('Не удалось загрузить публичный документ:', error);
  } finally {
    view.removeAttribute('aria-busy');
  }
}

function showLibrary({ updateHistory = true } = {}) {
  activePage = '';
  showDocumentMode(false);
  document.title = 'Тайная Библиотека';
  if (updateHistory) history.pushState({}, '', './index.html');
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const key = link.dataset.document || (link.getAttribute('href')?.endsWith('/info.html') || link.getAttribute('href') === './info.html' ? 'info'
    : link.getAttribute('href')?.endsWith('/privacy.html') || link.getAttribute('href') === './privacy.html' ? 'privacy' : '');
  if (key && pages[key]) {
    event.preventDefault();
    void renderDocument(key);
    return;
  }
  if (link.hasAttribute('data-document-home') || link.id === 'library-home-link' || link.getAttribute('href') === './index.html') {
    if (!view.hidden) {
      event.preventDefault();
      showLibrary();
    }
  }
});

window.addEventListener('popstate', () => {
  const match = window.location.hash.match(/^#document=(info|privacy)$/);
  if (match) void renderDocument(match[1], { updateHistory: false });
  else if (!view.hidden) showLibrary({ updateHistory: false });
});

const initial = window.location.hash.match(/^#document=(info|privacy)$/);
if (initial) void renderDocument(initial[1], { updateHistory: false });

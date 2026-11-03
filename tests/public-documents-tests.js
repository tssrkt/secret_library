export async function runPublicDocumentsTests(test, assert, equal) {
  await test('public instruction preserves document structure and owner link without application scripts', async () => {
    const html = await (await fetch('../info.html')).text();
    const page = new DOMParser().parseFromString(html, 'text/html');
    assert(!page.querySelector('script[src*="app.js"], script[src*="auth.js"], script[src*="firebase"]')
      && page.querySelector('script[src="./js/document-header.js"]'), 'public page loads only the shared-header controller, not app, Drive or Firebase code');
    assert(page.querySelectorAll('h1, h2, h3').length > 0 && page.querySelectorAll('ol, ul').length > 0, 'DOCX headings and lists remain structured HTML');
    const link = [...page.querySelectorAll('a')].find((item) => item.textContent.includes('сообщите владельцу «Тайной Библиотеки»'));
    assert(link && link.href === 'https://t.me/ptica_govorun_bot' && link.target === '_blank' && link.rel.includes('noopener'), 'owner phrase is the safe Telegram link');
  });
  await test('instruction and privacy mount the shared main-page header from one source', async () => {
    const [instructionHtml, privacyHtml, loaderHtml, homeHtml] = await Promise.all([
      fetch('../info.html').then((response) => response.text()),
      fetch('../privacy.html').then((response) => response.text()),
      fetch('../js/document-header.js').then((response) => response.text()),
      fetch('../index.html').then((response) => response.text()),
    ]);
    for (const html of [instructionHtml, privacyHtml]) {
      const page = new DOMParser().parseFromString(html, 'text/html');
      assert(page.querySelector('#shared-header') && page.querySelector('script[src="./js/document-header.js"]'), 'document page uses the shared-header loader');
      const footer = page.querySelector('.app-footer');
      assert(footer && footer.querySelector('a[href="./info.html"]') && footer.querySelector('a[href="./index.html"]'), 'document page has instruction and return-to-library links in the shared footer style');
      assert(!page.querySelector('.info-document > p a[href="./info.html"], .info-document > p a[href="./index.html"]'), 'navigation links are not embedded in the document body');
    }
    assert(loaderHtml.includes("fetch('./index.html'") && loaderHtml.includes("querySelector('.app-header')"), 'document pages fetch the header from the main page');
    const styles = await (await fetch('../css/styles.css')).text();
    const ui = await (await fetch('../js/ui.js')).text();
    assert(styles.includes('#stats dd { font-weight: 700; }') && styles.includes('.folder-content-count { flex: none; margin-left: .45rem; color: #000; font-weight: 400;'), 'summary counts are bold while folder row counts stay regular');
    assert(styles.includes('#sign-in-button { background: var(--download-accent); }') && styles.includes('.social-header .account-actions { column-gap: .5rem; }'), 'sign-in color and header icon spacing match the download accent and avatar spacing');
    assert(ui.includes('panel.textContent = message;') && !ui.includes("button.textContent = 'Моя библиотека'"), 'unavailable friend library message does not add a duplicate home button');
    const home = new DOMParser().parseFromString(homeHtml, 'text/html');
    assert(home.querySelector('#book-search-button') && home.querySelector('#notifications-button') && home.querySelector('#avatar-button'), 'shared source contains search, notifications and avatar');
  });
  await test('privacy and instruction menu items follow settings and precede logout', async () => {
    const html = await (await fetch('../index.html')).text();
    const page = new DOMParser().parseFromString(html, 'text/html');
    const items = [...page.querySelector('#avatar-menu').children];
    const settings = page.querySelector('#settings-button');
    const privacy = [...page.querySelectorAll('#avatar-menu .avatar-menu-link')].find((item) => item.textContent.trim() === 'Конфиденциальность');
    const instruction = [...page.querySelectorAll('#avatar-menu .avatar-menu-link')].find((item) => item.textContent.trim() === 'Инструкция');
    const signOut = page.querySelector('#sign-out-button');
    assert(privacy && privacy.getAttribute('href') === './privacy.html', 'relative privacy policy link exists');
    assert(instruction && instruction.getAttribute('href') === './info.html', 'relative instruction link exists');
    assert(items.indexOf(settings) < items.indexOf(privacy), 'settings are above the privacy separator and link');
    assert(items.indexOf(privacy) < items.indexOf(instruction), 'privacy link is above instruction');
    assert(items.indexOf(instruction) < items.indexOf(signOut), 'instruction is above logout');
    assert(items.filter((item) => item.tagName === 'HR' && item.classList.contains('account-menu-separator')).length === 2, 'separators divide utility links from privacy and logout');
  });
  await test('checked-in email template retains source placeholder and public instruction URL', async () => {
    const template = await (await fetch('../functions/invitation-template.json')).json();
    equal(template.subject, 'Приглашение в «Тайную Библиотеку»', 'required subject');
    assert(template.text.includes('{{имя_пригласившего}}') && template.text.includes('https://tssrkt.github.io/secret_library/info.html'), 'DOCX email text remains server template');
  });
}

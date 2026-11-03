export async function runPublicDocumentsTests(test, assert, equal) {
  await test('public instruction preserves document structure and owner link without application scripts', async () => {
    const html = await (await fetch('../info.html')).text();
    const page = new DOMParser().parseFromString(html, 'text/html');
    assert(!page.querySelector('script'), 'public page does not start app, Drive or Firebase code');
    assert(page.querySelectorAll('h1, h2, h3').length > 0 && page.querySelectorAll('ol, ul').length > 0, 'DOCX headings and lists remain structured HTML');
    const link = [...page.querySelectorAll('a')].find((item) => item.textContent.includes('сообщите владельцу «Тайной Библиотеки»'));
    assert(link && link.href === 'https://t.me/ptica_govorun_bot' && link.target === '_blank' && link.rel.includes('noopener'), 'owner phrase is the safe Telegram link');
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

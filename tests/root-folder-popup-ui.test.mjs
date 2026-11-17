import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../css/styles.css', import.meta.url), 'utf8');

test('root-folder change notice links to the newly selected folder', () => {
  assert.match(app, /function showRootFolderChangeNotice\(folder\)/);
  assert.match(app, /drive\.google\.com\/drive\/folders\/\$\{encodeURIComponent\(folder\.id\)\}/);
  assert.match(app, /folderLink\.target = '_blank'/);
  assert.match(app, /folderLink\.textContent = 'Открыть новую папку в Google Drive'/);
  assert.doesNotMatch(app, /Откройте новую корневую папку библиотеки:/);
  assert.match(app, /showRootFolderChangeNotice\(folder\)/);
});

test('emails in the root-folder notice copy to clipboard and show the exact confirmation', () => {
  assert.match(app, /emailButton\.addEventListener\('click', async \(\) => \{/);
  assert.match(app, /await copyTextToClipboard\(email\)/);
  assert.match(app, /copyMessage\.textContent = `Емейл \$\{email\} скопирован\.`/);
});

test('copy confirmation is inserted immediately before the Done button footer', () => {
  assert.match(app, /if \(copyEmails\) dialog\.append\(copyMessage\);\s*dialog\.append\(footer\);/);
  assert.match(css, /\.root-folder-email:hover, \.root-folder-email:focus-visible \{ font-weight: 700; \}/);
  assert.match(css, /\.root-folder-link-description a:hover \{ color: #687487; \}/);
  assert.match(css, /\.root-folder-link-description a:focus-visible \{ outline: 2px solid currentColor; outline-offset: 4px; \}/);
  assert.match(css, /\.root-folder-copy-message \{ text-align: left; \}/);
});

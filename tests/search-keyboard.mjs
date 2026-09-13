// Run with Node 22+ and Chrome: node tests/search-keyboard.mjs
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, extname, sep } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const setup = `<script type="module">
  import * as ui from '/js/ui.js';
  ui.renderLibrary({ rootFolderId: 'root', folders: [{ id: 'root', parentId: null }],
    books: Array.from({ length: 51 }, (_, i) => ({ id: String(i), parentId: 'root', fileName: 'book' + i + '.fb2',
      title: 'Лем ' + i, authors: ['Станислав Лем'], metadataStatus: 'ready' })) });
  ui.setAuthorized(true);
  window.testUi = ui;
  window.indexActions = [];
  const noop = () => {};
  ui.bindActions({ home: ui.showLibraryHome, signIn: noop, refresh: noop, indexMetadata: () => window.indexActions.push('full'),
    retryMetadata: () => window.indexActions.push('retry'), stopMetadata: noop, signOut: noop, rebuild: noop });
  window.testReady = true;
</script>`;
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const path = resolve(root, '.' + (pathname === '/keyboard-fixture' ? '/index.html' : pathname));
    if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    let content = await readFile(path);
    if (pathname === '/keyboard-fixture') content = content.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '') + setup;
    if (pathname === '/tests/fb2-tests.html') content = content.toString().replace(
      '<script type="module" src="./fb2-tests.js"></script>',
      '<script type="module">await new Promise(resolve => window.addEventListener("load", resolve, { once: true })); await import("./fb2-tests.js");</script>',
    );
    response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' })[extname(path)] || 'application/octet-stream');
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const profile = await mkdtemp(resolve(root, 'temp/chrome-search-keyboard-'));
const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome did not start')), 15000);
    chrome.once('error', reject);
    chrome.once('exit', () => reject(new Error('Chrome exited before connecting')));
    chrome.stderr.on('data', (data) => {
      const match = data.toString().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  const target = (await (await fetch(`${endpoint}/json/list`)).json()).find((target) => target.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data);
    if (response.method === 'Runtime.exceptionThrown') console.error(JSON.stringify(response.params.exceptionDetails));
    const callback = pending.get(response.id);
    if (callback) { pending.delete(response.id); response.error ? callback.reject(response.error) : callback.resolve(response.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome command timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const key = async (key, code, virtualKey, text) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, ...(text ? { text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey });
  };
  await send('Runtime.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/keyboard-fixture` });
  for (let i = 0; i < 100 && !await evaluate('Boolean(window.testReady)'); i++) await delay(50);
  assert(await evaluate('Boolean(window.testReady)'), await evaluate('JSON.stringify({url:location.href,body:document.body?.innerText,html:document.documentElement.outerHTML.slice(-1400)})'));
  await evaluate("document.querySelector('#book-search-button').focus()");
  await key('Enter', 'Enter', 13, '\r');
  assert.equal(await evaluate('document.activeElement.id'), 'quick-search-input');
  await key('Enter', 'Enter', 13, '\r');
  assert(await evaluate("Boolean(document.querySelector('.tree-list'))"), 'empty native Enter stays home');
  await send('Input.insertText', { text: 'ЛЕМ' });
  await key('Escape', 'Escape', 27);
  assert.equal(await evaluate("document.querySelector('#quick-search-input').value"), 'ЛЕМ');
  await key('Enter', 'Enter', 13, '\r');
  await key('Enter', 'Enter', 13, '\r');
  assert.equal(await evaluate("document.querySelector('.book-search-form').elements.query.value"), 'ЛЕМ');
  assert.equal(await evaluate("document.querySelectorAll('.book-card').length"), 50, 'native Enter executes quick search');
  await evaluate("document.querySelector('.book-search-form').elements.title.focus()");
  await send('Input.insertText', { text: 'Лем 49' });
  await key('Enter', 'Enter', 13, '\r');
  assert.equal(await evaluate("document.querySelectorAll('.book-card').length"), 1, 'native Enter submits advanced form');
  await evaluate("document.querySelector('#library-home-link').click(); document.querySelector('#book-search-button').focus()");
  await key('Tab', 'Tab', 9);
  assert.equal(await evaluate('document.activeElement.id'), 'notifications-button', 'closed quick form is absent from Tab order');
  await key('Tab', 'Tab', 9);
  assert.equal(await evaluate('document.activeElement.id'), 'avatar-button', 'bell is between search and avatar');
  for (const width of [390, 1200]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.querySelector('#book-search-button').click()");
    await delay(200);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(resolve(root, `temp/search-header-${width}.png`), Buffer.from(shot.data, 'base64'));
    await key('Escape', 'Escape', 27);
  }
  console.log('Keyboard checks passed: native Enter, Escape, Tab, query transfer, automatic search and advanced submit.');
  await evaluate(`window.testUi.updateMetadataActions({books: Array.from({length: 303}, (_, i) => ({id: String(i), metadataStatus: 'error'})), lastFullScan: {totalEligible: 9257}});
    document.querySelector('#metadata-button').click(); document.querySelector('#retry-metadata-button').click();`);
  assert.deepEqual(await evaluate('window.indexActions'), ['full', 'retry'], 'menu actions remain independent');
  assert.equal(await evaluate("document.querySelector('#metadata-button').textContent"), `Переиндексировать книги (${(9257).toLocaleString('ru-RU')})`);
  assert.equal(await evaluate("document.querySelector('#retry-metadata-button').textContent"), 'Повторить ошибки (303)');
  await evaluate('window.testUi.updateMetadataActions({books: []})');
  assert.equal(await evaluate("document.querySelector('#metadata-button').hidden"), false, 'full available without errors');
  assert.equal(await evaluate("document.querySelector('#retry-metadata-button').hidden"), true, 'empty retry hidden');
  console.log('Indexing menu checks passed: independent actions, 9257/303 counts, full available with zero errors.');
  await key('Tab', 'Tab', 9);
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/tests/fb2-tests.html` });
  for (let i = 0; i < 600 && !await evaluate('Boolean(document.body?.dataset.testStatus)'); i++) await delay(50);
  const summary = await evaluate("document.querySelector('#results')?.textContent");
  assert.equal(await evaluate('document.body?.dataset.testStatus'), 'passed', summary);
  console.log(summary);
} finally {
  socket?.close();
  chrome.kill();
  server.closeAllConnections();
  server.close();
}

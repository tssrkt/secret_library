import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const modules = ['js/app.js', 'js/ui.js', 'js/friends-ui.js'];

test('app, library UI, and friends UI share one social runtime module instance', async () => {
  const imports = await Promise.all(modules.map(async (path) => {
    const source = await readFile(new URL('../' + path, import.meta.url), 'utf8');
    const match = source.match(/from ['"]\.\/social-runtime\.js(\?[^'"]*)?['"]/);
    assert.ok(match, path + ' must import the social runtime');
    return { path, specifier: match[1] || '' };
  }));
  assert.equal(new Set(imports.map(({ specifier }) => specifier)).size, 1,
    'different query strings create separate ES module instances and split shared Drive state');
});

test('resume fixture shares the app social runtime module instance', async () => {
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const fixture = await readFile(new URL('./resume-app-fixture.js', import.meta.url), 'utf8');
  const specifier = (source, label) => {
    const match = source.match(/social-runtime\.js(\?[^'\"]*)?/);
    assert.ok(match, label + ' must import the social runtime');
    return match[1] || '';
  };
  assert.equal(specifier(fixture, 'resume fixture'), specifier(app, 'app'),
    'the fixture must patch the same module instance used by app.js, not trigger real Firebase auth');
});

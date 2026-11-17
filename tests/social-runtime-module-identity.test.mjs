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

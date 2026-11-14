import test from 'node:test';
import assert from 'node:assert/strict';
import { countIndexableBooks } from '../js/library-tree.js';

const FOLDER = 'application/vnd.google-apps.folder';

// Drive-like tree: only the files listed here exist.
const tree = {
  'root-1': [
    { id: 'a', name: 'Папка А', mimeType: FOLDER, resourceKey: 'key-a' },
    { id: 'b', name: 'Папка Б', mimeType: FOLDER, resourceKey: 'key-b' },
    { id: 'f1', name: 'книга1.fb2' },
    { id: 'f2', name: 'книга2.fb2' },
    { id: 'f3', name: 'книга3.fb2' },
    { id: 'x1', name: 'не-книга.azw3' },
    { id: 'x2', name: 'не-книга.pdf' },
  ],
  'a': [
    { id: 'f4', name: 'книга4.epub' },
    { id: 'f5', name: 'книга5.epub' },
  ],
  'b': [
    { id: 'f6', name: 'архив1.zip' },
    { id: 'f7', name: 'архив2.zip' },
    { id: 'f8', name: 'архив3.zip' },
    { id: 'f9', name: 'архив4.zip' },
    { id: 'f10', name: 'архив5.zip' },
    { id: 'f11', name: 'книга11.mobi' },
    { id: 'f12', name: 'книга12.mobi' },
  ],
};

function mockListChildren(calls = []) {
  return async (folderId, { resourceKey } = {}) => {
    calls.push([folderId, resourceKey || '']);
    const items = tree[folderId];
    if (!items) throw new Error('unexpected folder: ' + folderId);
    return items;
  };
}

test('counting stops as soon as the minimum is reached', async () => {
  const calls = [];
  const count = await countIndexableBooks('root-1', { minimum: 10, resourceKey: 'key-root', listChildren: mockListChildren(calls) });
  assert.equal(count, 10, 'the count is capped at the requested minimum');
  assert.ok(!calls.some(([folder]) => folder === undefined), 'every visited folder is known');
});

test('formats the site cannot index are not counted', async () => {
  const count = await countIndexableBooks('root-1', { minimum: 100, resourceKey: 'key-root', listChildren: mockListChildren() });
  assert.equal(count, 12, 'only fb2/epub/mobi/zip count; azw3 and pdf are skipped');
});

test('nested folders are traversed with their resource keys', async () => {
  const calls = [];
  await countIndexableBooks('root-1', { minimum: 6, resourceKey: 'key-root', listChildren: mockListChildren(calls) });
  assert.deepEqual(calls[0], ['root-1', 'key-root'], 'the root is read with the passed resource key');
  assert.ok(calls.some(([folder, key]) => folder === 'a' && key === 'key-a'), 'nested folders carry their own resource key');
  assert.ok(calls.some(([folder, key]) => folder === 'b' && key === 'key-b'), 'nested folders carry their own resource key');
});

test('a folder without enough books reports its real count', async () => {
  const count = await countIndexableBooks('a', { minimum: 10, resourceKey: 'key-a', listChildren: mockListChildren() });
  assert.equal(count, 2, 'the real count is returned when the minimum is not met');
});

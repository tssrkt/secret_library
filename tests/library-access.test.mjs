import test from 'node:test';
import assert from 'node:assert/strict';
import { hasMinimumBooks, MINIMUM_LIBRARY_BOOKS } from '../js/library-access.js';

test('access requires at least ten indexed books', () => {
  assert.equal(MINIMUM_LIBRARY_BOOKS, 10);
  assert.equal(hasMinimumBooks({ books: [] }), false);
  assert.equal(hasMinimumBooks({ books: Array.from({ length: 9 }, (_, id) => ({ id })) }), false);
  assert.equal(hasMinimumBooks({ books: Array.from({ length: 10 }, (_, id) => ({ id })) }), true);
  assert.equal(hasMinimumBooks({ books: Array.from({ length: 11 }, (_, id) => ({ id })) }), true);
});

test('missing or malformed index never grants access', () => {
  assert.equal(hasMinimumBooks(null), false);
  assert.equal(hasMinimumBooks(undefined), false);
  assert.equal(hasMinimumBooks({}), false);
  assert.equal(hasMinimumBooks({ books: 10 }), false);
});

test('threshold can be overridden for isolated callers and tests', () => {
  assert.equal(hasMinimumBooks({ books: [{ id: '1' }, { id: '2' }] }, 2), true);
  assert.equal(hasMinimumBooks({ books: [{ id: '1' }] }, 2), false);
});

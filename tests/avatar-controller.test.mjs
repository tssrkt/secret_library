import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvatarController } from '../js/avatar.js';

test('avatar controller falls back to Firebase profile photo when Drive photo fails', async () => {
  const button = { setAttribute() {}, title: '' };
  const placeholder = { hidden: false };
  const image = {
    hidden: true, onload: null, onerror: null, _src: '',
    removeAttribute(name) { if (name === 'src') this._src = ''; },
    set src(value) {
      this._src = value;
      queueMicrotask(() => value === 'drive-photo' ? this.onerror?.() : this.onload?.());
    },
    get src() { return this._src; },
  };
  const avatar = createAvatarController(button, image, placeholder);
  const loaded = await avatar.set({ displayName: 'Ada', photoLink: 'drive-photo', photoURL: 'firebase-photo' });
  assert.equal(loaded, true);
  assert.equal(image.src, 'firebase-photo');
  assert.equal(image.hidden, false);
  assert.equal(placeholder.hidden, true);
});

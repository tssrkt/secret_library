import test from 'node:test';
import assert from 'node:assert/strict';
import { isPendingInvitationResult } from '../js/social-runtime.js';

test('sends email for both new and already saved pending invitations', () => {
  assert.equal(isPendingInvitationResult('Приглашение сохранено.'), true);
  assert.equal(isPendingInvitationResult('Этот пользователь ещё не зарегистрирован. Приглашение уже сохранено.'), true);
  assert.equal(isPendingInvitationResult('Этот пользователь уже зарегистрирован. Доступ предоставлен.'), false);
  assert.equal(isPendingInvitationResult('Этот пользователь уже имеет доступ к вашей библиотеке.'), false);
});

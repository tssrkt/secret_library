import test from 'node:test';
import assert from 'node:assert/strict';
import { invitationMail } from '../functions/invitation-mail.js';

test('invitation email retains DOCX template and substitutes inviter display name', () => {
  const mail = invitationMail('Анна');
  assert.equal(mail.subject, 'Приглашение в «Тайную Библиотеку»');
  assert(!mail.text.includes('{{имя_пригласившего}}'));
  assert(mail.text.includes('Анна'));
  assert(mail.text.includes('https://tssrkt.github.io/secret_library/info.html'));
});

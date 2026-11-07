import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';

const source = readFileSync(new URL('../apps-script-invite/Code.gs', import.meta.url), 'utf8');

function createHarness(inviteeEmail = 'reader@example.com') {
  const values = new Map();
  const sent = [];
  let uuid = 0;
  const context = {
    console,
    Date,
    JSON,
    String,
    Number,
    Array,
    Map,
    Error,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA-256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(String(value)).digest()],
      getUuid: () => (++uuid).toString(16).padStart(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => values.has(key) ? values.get(key) : null,
        setProperty: (key, value) => { values.set(key, String(value)); return this; },
        deleteProperty: (key) => values.delete(key),
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    MailApp: { sendEmail: (message) => sent.push(message) },
  };
  runInNewContext(source, context);
  context.verifyFirebaseUser = (token) => token === 'owner-token'
    ? { localId: 'owner-uid', email: 'owner@example.com' }
    : { localId: 'reader-uid', email: inviteeEmail, emailVerified: true };
  return { context, values, sent };
}

test('invitation cooldown status reads only script properties, not Firestore invitation records', () => {
  const { context, values } = createHarness();
  const email = 'friend@example.com';
  const key = context.reservationKey('reader-uid', email);
  values.set(key, JSON.stringify({ status: 'sent', at: 123456 }));
  context.readPendingInvitationsMany = () => { throw new Error('Firestore should not be queried'); };
  const statuses = context.handleInvitationStatuses({
    idToken: 'x'.repeat(120),
    emails: [email],
  });
  assert.equal(statuses[email].lastSentAt, 123456);
  assert.equal(statuses[email].cooldownUntil, 123456 + 60 * 60 * 1000);
});

test('acceptance token is one-time, email-bound, and notifies the inviter once', () => {
  const { context, sent } = createHarness();
  const issued = context.issueInvitationAcceptanceToken('owner-uid', 'owner@example.com', 'reader@example.com');
  const first = context.handleAcceptInvitation({ token: issued.token, idToken: 'x'.repeat(120) });
  assert.equal(first.accepted, true);
  assert.equal(first.alreadyAccepted, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@example.com');
  const repeated = context.handleAcceptInvitation({ token: issued.token, idToken: 'x'.repeat(120) });
  assert.equal(repeated.accepted, true);
  assert.equal(repeated.alreadyAccepted, true);
  assert.equal(sent.length, 1);
});

test('acceptance token cannot be claimed by a different email', () => {
  const { context } = createHarness('other@example.com');
  const issued = context.issueInvitationAcceptanceToken('owner-uid', 'owner@example.com', 'reader@example.com');
  assert.throws(
    () => context.handleAcceptInvitation({ token: issued.token, idToken: 'x'.repeat(120) }),
    /Войдите через Google/
  );
});

test('a newer invitation invalidates the older token', () => {
  const { context } = createHarness();
  const first = context.issueInvitationAcceptanceToken('owner-uid', 'owner@example.com', 'reader@example.com');
  const second = context.issueInvitationAcceptanceToken('owner-uid', 'owner@example.com', 'reader@example.com');
  assert.throws(
    () => context.handleAcceptInvitation({ token: first.token, idToken: 'x'.repeat(120) }),
    /недействительно|использовано|заменено/
  );
  assert.equal(context.handleAcceptInvitation({ token: second.token, idToken: 'x'.repeat(120) }).accepted, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInvitationLedger,
  normalizeInvitationLedger,
  INVITATION_LEDGER_FILE,
} from '../js/invitation-ledger.js';

test('ledger normalizes email, drops invalid entries, and keeps newest duplicate', () => {
  const result = normalizeInvitationLedger({
    version: 1,
    ownerUid: 'owner-1',
    updatedAt: 10,
    invitations: [
      { inviteeEmail: ' Friend@Example.com ', status: 'pending', createdAt: 1, updatedAt: 2 },
      { inviteeEmail: 'friend@example.com', status: 'accepted', createdAt: 1, updatedAt: 3, acceptedUid: 'friend-1' },
      { inviteeEmail: '', status: 'pending' },
      { inviteeEmail: 'other@example.com', status: 'unknown' },
    ],
  }, 'owner-1');

  assert.equal(result.invitations.length, 2);
  assert.equal(result.invitations.find((item) => item.inviteeEmail === 'friend@example.com').status, 'accepted');
  assert.equal(result.invitations.find((item) => item.inviteeEmail === 'friend@example.com').acceptedUid, 'friend-1');
  assert.equal(result.invitations.find((item) => item.inviteeEmail === 'other@example.com').status, 'pending');
  assert.equal(normalizeInvitationLedger({ version: 1, ownerUid: 'another-owner', invitations: [] }, 'owner-1').invitations.length, 0);
});

test('ledger creates, updates, and reads a private Drive appData file', async () => {
  let stored = null;
  let id = 0;
  const calls = [];
  const ledger = createInvitationLedger({
    listFiles: async (name) => {
      calls.push(['list', name]);
      return stored ? [{ id: stored.id, name }] : [];
    },
    downloadFile: async (fileId) => {
      assert.equal(fileId, stored.id);
      return { json: async () => JSON.parse(stored.json) };
    },
    createFile: async (name, json) => {
      assert.equal(name, INVITATION_LEDGER_FILE);
      stored = { id: 'ledger-' + (++id), json };
      calls.push(['create', name]);
      return { id: stored.id };
    },
    updateFile: async (fileId, json) => {
      assert.equal(fileId, stored.id);
      stored.json = json;
      calls.push(['update', fileId]);
      return { id: fileId };
    },
  });

  await ledger.upsert('owner-1', { inviteeEmail: 'Friend@example.com', status: 'pending', createdAt: 1 });
  const loaded = await ledger.load('owner-1');
  assert.equal(loaded.ledger.invitations.length, 1);
  assert.equal(loaded.ledger.invitations[0].inviteeEmail, 'friend@example.com');

  await ledger.upsert('owner-1', { inviteeEmail: 'friend@example.com', status: 'pending', createdAt: 2 });
  assert.equal((await ledger.load('owner-1')).ledger.invitations.length, 1);

  await ledger.setStatus('owner-1', 'FRIEND@example.com', 'accepted', { acceptedUid: 'friend-uid' });
  const accepted = (await ledger.load('owner-1')).ledger.invitations[0];
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.acceptedUid, 'friend-uid');
  assert.ok(accepted.acceptedAt > 0);
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
  assert.ok(calls.some(([kind]) => kind === 'update'));
});

test('ledger rejects invalid addresses and statuses', async () => {
  const ledger = createInvitationLedger({
    listFiles: async () => [],
    createFile: async () => ({ id: 'unused' }),
  });
  await assert.rejects(() => ledger.upsert('owner-1', { inviteeEmail: 'not-an-email' }), /Некорректный адрес/);
  await assert.rejects(() => ledger.setStatus('owner-1', 'friend@example.com', 'unknown'), /Некорректный статус/);
});

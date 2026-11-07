import {
  listAppDataFiles,
  downloadAppDataFile,
  createAppDataFile,
  updateAppDataFile,
} from './drive.js';

export const INVITATION_LEDGER_FILE = 'secret-library-invitations-v1.json';
const LEDGER_VERSION = 1;

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function acceptedInvitationFriends(ledger) {
  return (Array.isArray(ledger?.invitations) ? ledger.invitations : [])
    .filter((item) => item && item.status === 'accepted' && typeof item.acceptedUid === 'string' && item.acceptedUid)
    .map((item) => ({
      uid: item.acceptedUid,
      email: normalizeEmail(item.inviteeEmail),
      displayName: String(item.acceptedDisplayName || item.inviteeEmail || ''),
    }))
    .filter((item) => item.email);
}

export function invitationLedgerRows(ledger, acceptedEmails = []) {
  const accepted = new Set((acceptedEmails || []).map((email) => String(email || '').trim().toLowerCase()).filter(Boolean));
  return (Array.isArray(ledger?.invitations) ? ledger.invitations : [])
    .filter((item) => item && item.status === 'pending')
    .map((item) => ({
      inviteeEmail: normalizeEmail(item.inviteeEmail),
      ownerUid: String(ledger.ownerUid || ''),
      active: true,
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
      emailSentAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
      source: 'drive-ledger',
    }))
    .filter((item) => item.inviteeEmail && !accepted.has(item.inviteeEmail));
}

export function mergeInvitationRows(primary = [], ledgerRows = [], acceptedEmails = []) {
  const accepted = new Set((acceptedEmails || []).map((email) => String(email || '').trim().toLowerCase()).filter(Boolean));
  const byEmail = new Map();
  for (const item of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(ledgerRows) ? ledgerRows : [])]) {
    const email = normalizeEmail(item?.inviteeEmail);
    if (!email || accepted.has(email)) continue;
    const previous = byEmail.get(email);
    if (!previous || (item.source !== 'drive-ledger' && previous.source === 'drive-ledger')) {
      byEmail.set(email, { ...item, inviteeEmail: email });
    }
  }
  return [...byEmail.values()].sort((a, b) => (Number(b.emailSentAt || b.createdAt) || 0) - (Number(a.emailSentAt || a.createdAt) || 0));
}

function normalizeRecord(record) {
  const email = normalizeEmail(record?.inviteeEmail);
  if (!email || email.length > 254 || !email.includes('@')) return null;
  const status = ['pending', 'accepted', 'revoked'].includes(record.status) ? record.status : 'pending';
  return {
    inviteeEmail: email,
    status,
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
    ...(typeof record.invitationId === 'string' ? { invitationId: record.invitationId } : {}),
    ...(typeof record.acceptedUid === 'string' ? { acceptedUid: record.acceptedUid } : {}),
    ...(typeof record.acceptedDisplayName === 'string' ? { acceptedDisplayName: record.acceptedDisplayName.slice(0, 160) } : {}),
    ...(typeof record.acceptedAt === 'number' && Number.isFinite(record.acceptedAt) ? { acceptedAt: record.acceptedAt } : {}),
  };
}

export function normalizeInvitationLedger(value, ownerUid) {
  if (!value || value.version !== LEDGER_VERSION || value.ownerUid !== ownerUid || !Array.isArray(value.invitations)) {
    return { version: LEDGER_VERSION, ownerUid, updatedAt: Date.now(), invitations: [] };
  }
  const byEmail = new Map();
  for (const raw of value.invitations) {
    const record = normalizeRecord(raw);
    if (!record) continue;
    const previous = byEmail.get(record.inviteeEmail);
    if (!previous || record.updatedAt >= previous.updatedAt) byEmail.set(record.inviteeEmail, record);
  }
  return {
    version: LEDGER_VERSION,
    ownerUid,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
    invitations: [...byEmail.values()].sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

export function createInvitationLedger({ listFiles = listAppDataFiles, downloadFile = downloadAppDataFile,
  createFile = createAppDataFile, updateFile = updateAppDataFile } = {}) {
  async function load(ownerUid) {
    if (typeof ownerUid !== 'string' || !ownerUid) throw new Error('Не указан владелец списка приглашений.');
    const files = await listFiles(INVITATION_LEDGER_FILE);
    const file = files[0];
    if (!file) return { fileId: null, ledger: normalizeInvitationLedger(null, ownerUid) };
    const response = await downloadFile(file.id);
    const value = await response.json();
    return { fileId: file.id, ledger: normalizeInvitationLedger(value, ownerUid) };
  }

  async function save(ownerUid, invitations) {
    const current = await load(ownerUid);
    const ledger = normalizeInvitationLedger({
      version: LEDGER_VERSION,
      ownerUid,
      updatedAt: Date.now(),
      invitations,
    }, ownerUid);
    const json = JSON.stringify(ledger);
    const saved = current.fileId
      ? await updateFile(current.fileId, json)
      : await createFile(INVITATION_LEDGER_FILE, json);
    return { fileId: saved?.id || current.fileId || null, ledger };
  }

  async function upsert(ownerUid, invitation) {
    const { ledger } = await load(ownerUid);
    const record = normalizeRecord({ ...invitation, updatedAt: Date.now() });
    if (!record) throw new Error('Некорректный адрес приглашённого участника.');
    const invitations = ledger.invitations.filter((item) => item.inviteeEmail !== record.inviteeEmail);
    invitations.push(record);
    return save(ownerUid, invitations);
  }

  async function setStatus(ownerUid, email, status, details = {}) {
    if (!['pending', 'accepted', 'revoked'].includes(status)) throw new Error('Некорректный статус приглашения.');
    const { ledger } = await load(ownerUid);
    const normalized = normalizeEmail(email);
    const existing = ledger.invitations.find((item) => item.inviteeEmail === normalized);
    if (!existing) return { fileId: null, ledger };
    const updated = {
      ...existing,
      ...details,
      status,
      updatedAt: Date.now(),
      ...(status === 'accepted' ? { acceptedAt: Number.isFinite(details.acceptedAt) ? details.acceptedAt : Date.now() } : {}),
    };
    return save(ownerUid, ledger.invitations.map((item) => item.inviteeEmail === normalized ? updated : item));
  }

  return { load, save, upsert, setStatus };
}

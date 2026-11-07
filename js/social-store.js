import { normalizeEmail, validateShareEmail, shareId } from './social-model.js?v=20261106-drive-notifications';

export function createSocialStore({ db, sdk, user }) {
  const { doc, collection, collectionGroup, query, where, getDocs, runTransaction,
    serverTimestamp, onSnapshot } = sdk;
  const uid = user.uid;
  const email = normalizeEmail(user.email);
  const founderUid = 'aA89pCYsKNbWWePmAveUVrG34F82';
  const ref = (...path) => doc(db, ...path);
  const data = (snapshot) => snapshot.exists() ? snapshot.data() : null;
  const profileRef = ref('users', uid);
  const pendingRef = (address, owner) => ref('pendingInvites', address, 'shares', owner);
  const relationshipRef = (owner, viewer) => ref('libraryShares', shareId(owner, viewer));
  const newShare = (ownerUid, viewerUid, ownerEmail = ownerUid === uid ? email : '') => ({ ownerUid, viewerUid, ...(ownerEmail ? { ownerEmail: normalizeEmail(ownerEmail) } : {}), active: true, sharedAt: serverTimestamp(), revokedAt: null });
  let disposed = false;
  const ensureCurrent = () => { if (disposed) throw new Error('Сеанс социальной части завершён.'); };
  async function forEachConcurrent(items, limit, callback) {
    for (let offset = 0; offset < items.length; offset += limit) {
      ensureCurrent();
      await Promise.all(items.slice(offset, offset + limit).map(callback));
    }
  }

  async function register() {
    ensureCurrent();
    if (!email || !user.emailVerified) throw new Error('Для социальной части нужен подтверждённый Google email.');
    let createdNewProfile = false;
    await runTransaction(db, async (tx) => {
      const own = data(await tx.get(profileRef));
      const directory = ref('userDirectory', email);
      const existing = data(await tx.get(directory));
      const first = (!own && uid !== founderUid) ? data(await tx.get(ref('pendingInvites', email))) : null;
      createdNewProfile = !own;
      ensureCurrent();
      if (existing && existing.uid !== uid) throw new Error('Этот адрес уже связан с другим пользователем.');
      if (!own && uid !== founderUid && typeof first?.firstOwnerUid !== 'string') {
        throw new Error('Регистрация в Тайной Библиотеке возможна только по приглашению. Попросите участника клуба прислать вам приглашение.');
      }
      const safe = { displayName: (user.displayName || 'Пользователь').slice(0, 160), photoURL: (user.photoURL || '').slice(0, 2048) };
      if (!own) tx.set(profileRef, { ...safe, createdAt: serverTimestamp(), invitedByUid: uid === founderUid ? null : first.firstOwnerUid });
      else tx.set(profileRef, { ...safe, createdAt: own.createdAt, invitedByUid: own.invitedByUid, ...(typeof own.isAdmin === 'boolean' ? { isAdmin: own.isAdmin } : {}) });
      if (!existing) tx.set(directory, { uid });
    });
    // Existing accounts and server-provisioned invitees do not need invitation-tree reads.
    // Keep the claim path only for accounts completing an older, pre-migration invitation.
    if (createdNewProfile) {
      const pending = await getDocs(collection(db, 'pendingInvites', email, 'shares'));
      await forEachConcurrent(pending.docs, 10, (snapshot) => claimInvitation(snapshot.ref));
    }
  }

  async function shareWithEmail(value) {
    ensureCurrent();
    const address = validateShareEmail(value, email);
    const pending = pendingRef(address, uid);
    const firstRef = ref('pendingInvites', address);
    const writeInvitation = (createFirstOwner) => runTransaction(db, async (tx) => {
      const existing = data(await tx.get(pending));
      ensureCurrent();
      if (existing?.active) {
        if (!existing.ownerEmail) tx.update(pending, { ownerEmail: email });
        return 'existing';
      }
      tx.set(pending, { ownerUid: uid, ownerEmail: email, inviteeEmail: address, active: true,
        createdAt: serverTimestamp(), claimedUid: null, claimedAt: null });
      // First inviter is written only when the root document does not yet exist.
      // A create-only rule rejects this write when another invitation created it first.
      if (createFirstOwner) tx.set(firstRef, { firstOwnerUid: uid, createdAt: serverTimestamp() });
      return 'created';
    });
    try {
      const result = await writeInvitation(true);
      return result === 'existing' ? 'Приглашение уже сохранено.' : 'Приглашение сохранено.';
    } catch (error) {
      if (error?.code !== 'permission-denied') throw error;
      // The root already exists: add this owner's invitation without reading the
      // recipient's first-inviter record. The recipient alone can read that root.
      const result = await writeInvitation(false);
      return result === 'existing' ? 'Приглашение уже сохранено.' : 'Приглашение сохранено.';
    }
  }

  async function claimInvitation(invitationRef) {
    ensureCurrent();
    return runTransaction(db, async (tx) => {
      const invite = data(await tx.get(invitationRef));
      if (!invite?.active || invite.claimedUid) return false;
      const share = relationshipRef(invite.ownerUid, uid);
      const existing = data(await tx.get(share));
      ensureCurrent();
      if (!existing?.active) tx.set(share, newShare(invite.ownerUid, uid, invite.ownerEmail || ''));
      tx.update(invitationRef, { claimedUid: uid, claimedAt: serverTimestamp() });
      return true;
    });
  }

  async function setSharing(otherUid, active = true) {
    ensureCurrent();
    if (!otherUid || otherUid === uid) throw new Error('Нельзя поделиться библиотекой с самим собой.');
    return runTransaction(db, async (tx) => {
      const share = relationshipRef(uid, otherUid);
      const existing = data(await tx.get(share));
      ensureCurrent();
      if (Boolean(existing?.active) === active) {
        if (active && !existing.ownerEmail) { tx.update(share, { ownerEmail: email }); return true; }
        return false;
      }
      if (active) tx.set(share, newShare(uid, otherUid));
      else tx.update(share, { active: false, revokedAt: serverTimestamp() });
      return true;
    });
  }

  async function syncShareEmails() {
    ensureCurrent();
    const outgoing = await getDocs(query(collection(db, 'libraryShares'), where('ownerUid', '==', uid)));
    const needingEmail = outgoing.docs.filter((snapshot) => {
      const share = snapshot.data();
      return share.active && !share.ownerEmail;
    });
    await forEachConcurrent(needingEmail, 10, (snapshot) => runTransaction(db, async (tx) => {
      const current = data(await tx.get(snapshot.ref));
      ensureCurrent();
      if (current?.active && !current.ownerEmail) tx.update(snapshot.ref, { ownerEmail: email });
    }));
  }

  async function syncKnownContacts() {
    ensureCurrent();
    const pending = await getDocs(query(collectionGroup(db, 'shares'), where('ownerUid', '==', uid)));
    const contactEmails = new Map();
    for (const snapshot of pending.docs) {
      const invite = snapshot.data();
      if (invite.claimedUid && invite.inviteeEmail && !contactEmails.has(invite.claimedUid)) {
        contactEmails.set(invite.claimedUid, invite.inviteeEmail);
      }
    }
    const contacts = [...contactEmails];
    await forEachConcurrent(contacts, 10, ([contactUid, contactEmail]) => runTransaction(db, async (tx) => {
      const contact = ref('users', uid, 'knownContacts', contactUid);
      const existing = await tx.get(contact);
      ensureCurrent();
      if (!existing.exists()) tx.set(contact, { email: contactEmail });
    }));
  }
  function subscribe(listener) {
    let stopped = false;
    if (!disposed) listener({ invitations: [], acceptedInvitations: [] });
    return () => { stopped = true; void stopped; };
  }

  return { uid, register, shareWithEmail, setSharing, syncShareEmails, syncKnownContacts, subscribe, dispose() { disposed = true; } };
}

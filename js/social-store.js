import { normalizeEmail, validateShareEmail, shareId, friendsModel, notificationsModel } from './social-model.js';

export function createSocialStore({ db, sdk, user }) {
  const { doc, collection, collectionGroup, query, where, getDoc, getDocs, runTransaction,
    serverTimestamp, onSnapshot, writeBatch } = sdk;
  const uid = user.uid;
  const email = normalizeEmail(user.email);
  const founderUid = 'aA89pCYsKNbWWePmAveUVrG34F82';
  let superAdminUid = '';
  const ref = (...path) => doc(db, ...path);
  const data = (snapshot) => snapshot.exists() ? snapshot.data() : null;
  const profileRef = ref('users', uid);
  const pendingRef = (address, owner) => ref('pendingInvites', address, 'shares', owner);
  const relationshipRef = (owner, viewer) => ref('libraryShares', shareId(owner, viewer));
  const newShare = (ownerUid, viewerUid, ownerEmail = ownerUid === uid ? email : '') => ({ ownerUid, viewerUid, ...(ownerEmail ? { ownerEmail: normalizeEmail(ownerEmail) } : {}), active: true, sharedAt: serverTimestamp(), revokedAt: null });
  let disposed = false;
  const ensureCurrent = () => { if (disposed) throw new Error('Сеанс социальной части завершён.'); };

  async function register() {
    ensureCurrent();
    if (!email || !user.emailVerified) throw new Error('Для социальной части нужен подтверждённый Google email.');
    await runTransaction(db, async (tx) => {
      const own = data(await tx.get(profileRef));
      const directory = ref('userDirectory', email);
      const existing = data(await tx.get(directory));
      const first = data(await tx.get(ref('pendingInvites', email)));
      ensureCurrent();
      if (existing && existing.uid !== uid) throw new Error('Этот адрес уже связан с другим пользователем.');
      if (!own && uid !== founderUid && typeof first?.firstOwnerUid !== 'string') {
        throw new Error('Регистрация в Тайной Библиотеке возможна только по приглашению. Попросите участника клуба прислать вам приглашение.');
      }
      const safe = { displayName: (user.displayName || 'Пользователь').slice(0, 160), photoURL: (user.photoURL || '').slice(0, 2048) };
      if (!own) tx.set(profileRef, { ...safe, createdAt: serverTimestamp(), invitedByUid: uid === founderUid ? null : first.firstOwnerUid });
      else tx.update(profileRef, safe);
      if (!existing) tx.set(directory, { uid });
    });
    // The founder UID is fixed in the security model; no email-directory lookup is needed.
    superAdminUid = founderUid;
    const pending = await getDocs(collection(db, 'pendingInvites', email, 'shares'));
    for (const snapshot of pending.docs) {
      ensureCurrent();
      await claimInvitation(snapshot.ref);
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
    for (const snapshot of outgoing.docs) {
      const share = snapshot.data();
      if (!share.active || share.ownerEmail) continue;
      await runTransaction(db, async (tx) => {
        const current = data(await tx.get(snapshot.ref));
        ensureCurrent();
        if (current?.active && !current.ownerEmail) tx.update(snapshot.ref, { ownerEmail: email });
      });
    }
  }

  async function syncKnownContacts() {
    ensureCurrent();
    const pending = await getDocs(query(collectionGroup(db, 'shares'), where('ownerUid', '==', uid)));
    for (const snapshot of pending.docs) {
      const invite = snapshot.data();
      if (!invite.claimedUid) continue;
      await runTransaction(db, async (tx) => {
        const contact = ref('users', uid, 'knownContacts', invite.claimedUid);
        const existing = await tx.get(contact);
        ensureCurrent();
        if (!existing.exists()) tx.set(contact, { email: invite.inviteeEmail });
      });
    }
  }

  async function markSeen(notifications) {
    ensureCurrent();
    const displayed = notifications.slice(0, 50).filter((item) => item.unread);
    // Rules validate each marker against its share; stay below the batch access-call limit.
    for (let offset = 0; offset < displayed.length; offset += 10) {
      ensureCurrent();
      const batch = writeBatch(db);
      for (const item of displayed.slice(offset, offset + 10)) batch.set(ref('users', uid, 'incomingShareReads', item.ownerUid), { seenSharedAt: item.sharedAt });
      await batch.commit();
    }
  }

  function subscribe(listener, onError) {
    const collections = { outgoing: [], incoming: [], invitations: [], contacts: {}, reads: {} };
    const profiles = {};
    let revision = 0;
    let stopped = false;
    const emit = async () => {
      const current = ++revision;
      try {
        const shares = [...collections.outgoing, ...collections.incoming];
        const ids = new Set(shares.filter((item) => item.active).flatMap((item) => [item.ownerUid, item.viewerUid]));
        await Promise.all([...ids].map(async (id) => {
          const profile = data(await getDoc(ref('users', id)));
          profiles[id] = id === superAdminUid ? { ...(profile || {}), isAdmin: true } : profile;
        }));
        if (stopped || disposed || current !== revision) return;
        listener({ friends: friendsModel(uid, shares, profiles, collections.contacts),
          invitations: collections.invitations.filter((item) => item.active === true && !item.claimedUid && item.inviteeEmail),
          notifications: notificationsModel(uid, shares, collections.reads, profiles) });
      } catch (error) { if (!stopped && !disposed) onError(error); }
    };
    const watch = (target, key, map = false) => onSnapshot(target, { includeMetadataChanges: true }, (snapshot) => {
      // Do not present a locally queued write as granted access or a successful read marker.
      if (snapshot.metadata.hasPendingWrites) return;
      collections[key] = map ? Object.fromEntries(snapshot.docs.map((item) => [item.id, item.data()])) : snapshot.docs.map((item) => item.data());
      void emit();
    }, onError);
    const incomingInvites = query(collectionGroup(db, 'shares'), where('inviteeEmail', '==', email));
    const stopIncomingInvites = onSnapshot(incomingInvites, (snapshot) => {
      for (const item of snapshot.docs) {
        const invite = item.data();
        if (invite.active === true && !invite.claimedUid) {
          void claimInvitation(item.ref).catch(onError);
        }
      }
    }, onError);
    const stops = [
      stopIncomingInvites,
      watch(query(collection(db, 'libraryShares'), where('ownerUid', '==', uid)), 'outgoing'),
      watch(query(collection(db, 'libraryShares'), where('viewerUid', '==', uid)), 'incoming'),
      watch(query(collectionGroup(db, 'shares'), where('ownerUid', '==', uid)), 'invitations'),
      watch(collection(db, 'users', uid, 'knownContacts'), 'contacts', true),
      watch(collection(db, 'users', uid, 'incomingShareReads'), 'reads', true),
    ];
    return () => { stopped = true; stops.forEach((stop) => stop()); };
  }
  return { uid, register, shareWithEmail, setSharing, syncShareEmails, syncKnownContacts, markSeen, subscribe, dispose() { disposed = true; } };
}

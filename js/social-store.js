import { normalizeEmail, validateShareEmail, shareId, friendsModel, notificationsModel } from './social-model.js';

export function createSocialStore({ db, sdk, user }) {
  const { doc, collection, collectionGroup, query, where, getDoc, getDocs, runTransaction,
    serverTimestamp, onSnapshot, writeBatch } = sdk;
  const uid = user.uid;
  const email = normalizeEmail(user.email);
  const ref = (...path) => doc(db, ...path);
  const data = (snapshot) => snapshot.exists() ? snapshot.data() : null;
  const profileRef = ref('users', uid);
  const pendingRef = (address, owner) => ref('pendingInvites', address, 'shares', owner);
  const relationshipRef = (owner, viewer) => ref('libraryShares', shareId(owner, viewer));
  const newShare = (ownerUid, viewerUid) => ({ ownerUid, viewerUid, active: true, sharedAt: serverTimestamp(), revokedAt: null });
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
      const safe = { displayName: (user.displayName || 'Пользователь').slice(0, 160), photoURL: (user.photoURL || '').slice(0, 2048) };
      if (!own) tx.set(profileRef, { ...safe, createdAt: serverTimestamp(), invitedByUid: first?.firstOwnerUid || null });
      else tx.update(profileRef, safe);
      if (!existing) tx.set(directory, { uid });
    });
    const pending = await getDocs(collection(db, 'pendingInvites', email, 'shares'));
    for (const snapshot of pending.docs) {
      ensureCurrent();
      await runTransaction(db, async (tx) => {
        const invite = data(await tx.get(snapshot.ref));
        if (!invite?.active || invite.claimedUid) return;
        const share = relationshipRef(invite.ownerUid, uid);
        const existing = data(await tx.get(share));
        ensureCurrent();
        if (!existing?.active) tx.set(share, newShare(invite.ownerUid, uid));
        tx.update(snapshot.ref, { claimedUid: uid, claimedAt: serverTimestamp() });
      });
    }
  }

  async function shareWithEmail(value) {
    ensureCurrent();
    const address = validateShareEmail(value, email);
    return runTransaction(db, async (tx) => {
      const target = data(await tx.get(ref('userDirectory', address)));
      if (target) {
        if (target.uid === uid) throw new Error('Нельзя поделиться библиотекой с самим собой.');
        const share = relationshipRef(uid, target.uid);
        const existing = data(await tx.get(share));
        ensureCurrent();
        tx.set(ref('users', uid, 'knownContacts', target.uid), { email: address });
        if (existing?.active) return 'Этот пользователь уже имеет доступ к вашей библиотеке.';
        tx.set(share, newShare(uid, target.uid));
        return 'Этот пользователь уже зарегистрирован. Доступ предоставлен.';
      }
      const pending = pendingRef(address, uid);
      const existing = data(await tx.get(pending));
      const firstRef = ref('pendingInvites', address);
      const first = data(await tx.get(firstRef));
      ensureCurrent();
      if (existing?.active) return 'Этот пользователь ещё не зарегистрирован. Приглашение уже сохранено.';
      tx.set(pending, { ownerUid: uid, inviteeEmail: address, active: true,
        createdAt: serverTimestamp(), claimedUid: null, claimedAt: null });
      // Immutable first invitation makes attribution enforceable without server code.
      if (!first) tx.set(firstRef, { firstOwnerUid: uid, createdAt: serverTimestamp() });
      return 'Приглашение сохранено.';
    });
  }

  async function setSharing(otherUid, active = true) {
    ensureCurrent();
    if (!otherUid || otherUid === uid) throw new Error('Нельзя поделиться библиотекой с самим собой.');
    return runTransaction(db, async (tx) => {
      const share = relationshipRef(uid, otherUid);
      const existing = data(await tx.get(share));
      ensureCurrent();
      if (Boolean(existing?.active) === active) return false;
      if (active) tx.set(share, newShare(uid, otherUid));
      else tx.update(share, { active: false, revokedAt: serverTimestamp() });
      return true;
    });
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
    const collections = { outgoing: [], incoming: [], contacts: {}, reads: {} };
    const profiles = {};
    let revision = 0;
    let stopped = false;
    const emit = async () => {
      const current = ++revision;
      try {
        const shares = [...collections.outgoing, ...collections.incoming];
        const ids = new Set(shares.filter((item) => item.active).flatMap((item) => [item.ownerUid, item.viewerUid]));
        await Promise.all([...ids].filter((id) => !profiles[id]).map(async (id) => { profiles[id] = data(await getDoc(ref('users', id))); }));
        if (stopped || disposed || current !== revision) return;
        listener({ friends: friendsModel(uid, shares, profiles, collections.contacts), notifications: notificationsModel(uid, shares, collections.reads, profiles) });
      } catch (error) { if (!stopped && !disposed) onError(error); }
    };
    const watch = (target, key, map = false) => onSnapshot(target, { includeMetadataChanges: true }, (snapshot) => {
      // Do not present a locally queued write as granted access or a successful read marker.
      if (snapshot.metadata.hasPendingWrites) return;
      collections[key] = map ? Object.fromEntries(snapshot.docs.map((item) => [item.id, item.data()])) : snapshot.docs.map((item) => item.data());
      void emit();
    }, onError);
    const stops = [
      watch(query(collection(db, 'libraryShares'), where('ownerUid', '==', uid)), 'outgoing'),
      watch(query(collection(db, 'libraryShares'), where('viewerUid', '==', uid)), 'incoming'),
      watch(collection(db, 'users', uid, 'knownContacts'), 'contacts', true),
      watch(collection(db, 'users', uid, 'incomingShareReads'), 'reads', true),
    ];
    return () => { stopped = true; stops.forEach((stop) => stop()); };
  }
  return { uid, register, shareWithEmail, setSharing, syncKnownContacts, markSeen, subscribe, dispose() { disposed = true; } };
}

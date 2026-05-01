import AsyncStorage from '@react-native-async-storage/async-storage';
import firestore from '@react-native-firebase/firestore';

const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const generateSessionId = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/* Backfill sessionId/synced fields onto any session that pre-dates these flags. */
const ensureSessionFields = (parsed) => {
  let modified = false;
  for (const date of Object.keys(parsed)) {
    for (const session of parsed[date]) {
      if (!session.sessionId) { session.sessionId = generateSessionId(); modified = true; }
      if (session.synced === undefined) { session.synced = false; modified = true; }
    }
  }
  return modified;
};

/* Read sessions, batch-write all unsynced ones to Firestore, mark them synced. */
export async function syncSessions() {
  try {
    const petId = await AsyncStorage.getItem('petId');
    if (!petId) return { skipped: true, reason: 'no petId' };

    const raw = await AsyncStorage.getItem('activities');
    if (!raw) {
      await AsyncStorage.setItem('lastSyncAt', String(Date.now()));
      return { uploaded: 0 };
    }

    const parsed = JSON.parse(raw);
    const fieldsBackfilled = ensureSessionFields(parsed);

    const unsynced = [];
    let totalSteps = 0;
    let totalDistance = 0;
    let totalCount = 0;
    let bestSteps = 0;
    let bestDistance = 0;

    for (const date of Object.keys(parsed)) {
      for (const session of parsed[date]) {
        totalSteps    += session.steps    || 0;
        totalDistance += session.distance || 0;
        totalCount    += 1;
        if ((session.steps    || 0) > bestSteps)    bestSteps    = session.steps;
        if ((session.distance || 0) > bestDistance) bestDistance = session.distance;
        if (!session.synced) unsynced.push({ date, session });
      }
    }

    if (unsynced.length === 0 && !fieldsBackfilled) {
      await AsyncStorage.setItem('lastSyncAt', String(Date.now()));
      return { uploaded: 0 };
    }

    const petRef = firestore().collection('pets').doc(petId);
    const sessionsCol = petRef.collection('sessions');
    const batch = firestore().batch();

    for (const { date, session } of unsynced) {
      batch.set(sessionsCol.doc(session.sessionId), {
        sessionId: session.sessionId,
        date,
        timestamp: session.timestamp,
        steps:    session.steps    || 0,
        distance: session.distance || 0,
        duration: session.duration || 0,
        route:    session.route    || [],
        // Firestore disallows nested arrays — wrap each segment as an object
        segments: (session.segments || []).map(seg => ({ points: seg })),
      });
    }

    batch.update(petRef, {
      totalLifetimeSteps: totalSteps,
      totalWalkCount:     totalCount,
      bestWalk:           { steps: bestSteps, distance: bestDistance },
      lastSyncAt:         firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    for (const { session } of unsynced) session.synced = true;
    await AsyncStorage.setItem('activities', JSON.stringify(parsed));
    await AsyncStorage.setItem('lastSyncAt', String(Date.now()));

    return { uploaded: unsynced.length };
  } catch (e) {
    return { error: e?.message };
  }
}

/* Pull all sessions from Firestore back into AsyncStorage (e.g., fresh install + same pet).
   Merges with any local unsynced sessions, de-duped by sessionId. */
export async function restoreSessionsFromCloud() {
  try {
    const petId = await AsyncStorage.getItem('petId');
    if (!petId) return { skipped: true };

    const snap = await firestore()
      .collection('pets').doc(petId)
      .collection('sessions').get();

    const raw = await AsyncStorage.getItem('activities');
    const local = raw ? JSON.parse(raw) : {};
    const localIds = new Set();
    for (const date of Object.keys(local)) {
      for (const session of local[date]) {
        if (session.sessionId) localIds.add(session.sessionId);
      }
    }

    let restored = 0;
    snap.forEach(doc => {
      const cloud = doc.data();
      if (localIds.has(cloud.sessionId)) return;
      const session = {
        sessionId: cloud.sessionId,
        steps:    cloud.steps    || 0,
        distance: cloud.distance || 0,
        duration: cloud.duration || 0,
        route:    cloud.route    || [],
        segments: (cloud.segments || []).map(s => s.points || []),
        timestamp: cloud.timestamp,
        synced: true,
      };
      const date = cloud.date;
      if (!local[date]) local[date] = [];
      local[date].push(session);
      restored++;
    });

    for (const date of Object.keys(local)) {
      local[date].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    }

    await AsyncStorage.setItem('activities', JSON.stringify(local));
    return { restored };
  } catch (e) {
    return { error: e?.message };
  }
}

export async function syncIfStale() {
  try {
    const last = await AsyncStorage.getItem('lastSyncAt');
    const now = Date.now();
    if (!last || now - Number(last) > SYNC_INTERVAL_MS) {
      return await syncSessions();
    }
    return { skipped: true, reason: 'recent sync' };
  } catch (e) {
    return { error: e?.message };
  }
}

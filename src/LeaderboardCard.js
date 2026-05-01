import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, DeviceEventEmitter } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import firestore from '@react-native-firebase/firestore';
import BleStepService from './BleStepService';

const TOP_LIMIT = 10;

function formatSteps(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function LeaderboardCard() {
  const [connected, setConnected] = useState(BleStepService.isConnectedState);
  const [loading, setLoading]     = useState(false);
  const [top, setTop]             = useState([]);
  const [myRank, setMyRank]       = useState(null);
  const [myPetId, setMyPetId]     = useState(null);

  // Track BLE connection state
  useEffect(() => {
    setMyPetId(null);
    AsyncStorage.getItem('petId').then(setMyPetId).catch(() => {});

    const handleConnect = () => setConnected(true);
    const handleDisconnect = () => setConnected(false);

    const unsubDisconnect = BleStepService.onDisconnect(handleDisconnect);
    const { NativeModules, NativeEventEmitter } = require('react-native');
    const emitter = NativeModules.StepCounter
      ? new NativeEventEmitter(NativeModules.StepCounter)
      : null;
    const connSub = emitter?.addListener('BleConnectionUpdate', (state) => {
      if (state === 'connected') handleConnect();
      else handleDisconnect();
    });

    return () => { unsubDisconnect(); connSub?.remove(); };
  }, []);

  const fetchLeaderboard = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    try {
      const snap = await firestore()
        .collection('pets')
        .orderBy('totalLifetimeSteps', 'desc')
        .limit(TOP_LIMIT)
        .get();

      const list = [];
      snap.forEach(doc => list.push(doc.data()));
      setTop(list);

      // Determine my rank if not in top
      const myEntry = list.find(p => p.petId === myPetId);
      if (myEntry) {
        setMyRank(list.indexOf(myEntry) + 1);
      } else if (myPetId) {
        const meDoc = await firestore().collection('pets').doc(myPetId).get();
        const myData = meDoc.data();
        if (myData && typeof myData.totalLifetimeSteps === 'number') {
          const aboveSnap = await firestore()
            .collection('pets')
            .where('totalLifetimeSteps', '>', myData.totalLifetimeSteps)
            .count()
            .get();
          setMyRank({
            outside: true,
            rank: aboveSnap.data().count + 1,
            steps: myData.totalLifetimeSteps,
            petName: myData.petName,
            username: myData.username,
            petColor: myData.petColor,
          });
        } else {
          setMyRank(null);
        }
      }
    } catch (e) {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [connected, myPetId]);

  useEffect(() => { fetchLeaderboard(); }, [fetchLeaderboard]);

  // Listen for local pet color changes — update my row in-place
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('petColorChange', (newColor) => {
      setTop(prev => prev.map(p => p.petId === myPetId ? { ...p, petColor: newColor } : p));
      setMyRank(prev => (prev?.outside ? { ...prev, petColor: newColor } : prev));
    });
    return () => sub.remove();
  }, [myPetId]);

  if (!connected) {
    return (
      <View style={[styles.card, styles.lockedCard]}>
        <Text style={styles.title}>Leaderboard</Text>
        <Text style={styles.lockedText}>Connect your pet to see the leaderboard</Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>Leaderboard</Text>
        {loading && <ActivityIndicator size="small" color="#94a3b8" />}
      </View>

      {top.length === 0 && !loading && (
        <Text style={styles.empty}>No pets on the leaderboard yet</Text>
      )}

      {top.map((entry, i) => {
        const isMe = entry.petId === myPetId;
        return (
          <View key={entry.petId} style={[styles.row, isMe && styles.rowMe]}>
            <Text style={[styles.rank, isMe && styles.textMe]}>{i + 1}</Text>
            <View style={[styles.dot, { backgroundColor: entry.petColor || '#94a3b8' }]} />
            <View style={styles.middle}>
              <Text style={[styles.petName, isMe && styles.textMe]} numberOfLines={1}>
                {entry.petName || 'Unnamed'}
              </Text>
              <Text style={styles.username} numberOfLines={1}>@{entry.username || '—'}</Text>
            </View>
            <Text style={[styles.steps, isMe && styles.textMe]}>
              {formatSteps(entry.totalLifetimeSteps || 0)}
            </Text>
          </View>
        );
      })}

      {myRank?.outside && (
        <>
          <View style={styles.separator} />
          <View style={[styles.row, styles.rowMe]}>
            <Text style={[styles.rank, styles.textMe]}>{myRank.rank}</Text>
            <View style={[styles.dot, { backgroundColor: myRank.petColor || '#94a3b8' }]} />
            <View style={styles.middle}>
              <Text style={[styles.petName, styles.textMe]} numberOfLines={1}>
                {myRank.petName || 'Unnamed'}
              </Text>
              <Text style={styles.username} numberOfLines={1}>@{myRank.username || '—'} · you</Text>
            </View>
            <Text style={[styles.steps, styles.textMe]}>
              {formatSteps(myRank.steps || 0)}
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    marginBottom: 16,
  },
  lockedCard: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0f172a',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  lockedText: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 8,
    textAlign: 'center',
  },
  empty: {
    fontSize: 13,
    color: '#94a3b8',
    textAlign: 'center',
    paddingVertical: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 4,
    gap: 12,
  },
  rowMe: {
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    paddingHorizontal: 10,
  },
  rank: {
    width: 22,
    fontSize: 14,
    fontWeight: '700',
    color: '#64748b',
  },
  dot: {
    width: 24,
    height: 24,
    borderRadius: 6,
  },
  middle: { flex: 1 },
  petName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  username: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 1,
  },
  steps: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
  },
  textMe: {
    color: '#2563eb',
  },
  separator: {
    height: 1,
    backgroundColor: '#e2e8f0',
    marginVertical: 8,
  },
});

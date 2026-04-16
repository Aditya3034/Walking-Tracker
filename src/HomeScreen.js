import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  NativeModules, NativeEventEmitter,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import PetConnectCard from './PetConnectCard';
import BleStepService from './BleStepService';

const { StepCounter } = NativeModules;
const eventEmitter = StepCounter ? new NativeEventEmitter(StepCounter) : null;

export default function HomeScreen({ isActive }) {
  const [pendingTreats, setPendingTreats] = useState(0);
  const [hasDevice, setHasDevice] = useState(false);

  const loadTreats = () => {
    AsyncStorage.getItem('pendingTreats').then(val => {
      setPendingTreats(parseInt(val, 10) || 0);
    }).catch(() => {});
  };

  useEffect(() => { loadTreats(); }, []);
  useEffect(() => { if (isActive) loadTreats(); }, [isActive]);

  // BLE connection status
  useEffect(() => {
    const s = BleStepService.getTrackingStatus();
    setHasDevice(s.hasDevice);

    const unsubDisconnect = BleStepService.onDisconnect(() => setHasDevice(false));
    const connSub = eventEmitter?.addListener('BleConnectionUpdate', state => {
      setHasDevice(state === 'connected');
    });

    return () => {
      unsubDisconnect();
      connSub?.remove();
    };
  }, []);

  const feedPet = async () => {
    if (pendingTreats <= 0 || !hasDevice) return;
    try {
      await BleStepService.writeToDevice('FEED');
      BleStepService.recordFeed();
      setPendingTreats(prev => {
        const updated = Math.max(0, prev - 1);
        AsyncStorage.setItem('pendingTreats', String(updated)).catch(() => {});
        return updated;
      });
    } catch (e) {
      console.warn('Feed failed', e);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>

      <PetConnectCard />

      {pendingTreats > 0 ? (
        <View style={styles.treatsCard}>
          <View style={styles.treatsHeader}>
            <Text style={styles.treatsTitle}>Treats Earned</Text>
            <View style={styles.treatsBadge}>
              <Text style={styles.treatsBadgeText}>{pendingTreats}</Text>
            </View>
          </View>
          <View style={styles.treatDotsRow}>
            {Array.from({ length: Math.min(pendingTreats, 12) }).map((_, i) => (
              <View key={i} style={styles.treatDot} />
            ))}
            {pendingTreats > 12 && (
              <Text style={styles.treatMore}>+{pendingTreats - 12}</Text>
            )}
          </View>
          <TouchableOpacity
            style={[styles.feedButton, (!hasDevice || pendingTreats <= 0) && styles.feedButtonDisabled]}
            onPress={feedPet}
            disabled={!hasDevice || pendingTreats <= 0}
            activeOpacity={0.8}
          >
            <Text style={styles.feedButtonText}>Feed Pet</Text>
          </TouchableOpacity>
          {!hasDevice && (
            <Text style={styles.noDeviceHint}>Connect your pet locket to feed</Text>
          )}
        </View>
      ) : (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>No treats yet</Text>
          <Text style={styles.emptySubText}>Go for a walk to earn treats for your pet!</Text>
        </View>
      )}

    </ScrollView>
  );
}

const C = {
  bg:      '#ffffff',
  card:    '#ffffff',
  primary: '#0f172a',
  warning: '#d97706',
  text:    '#0f172a',
  text3:   '#94a3b8',
};

const card = {
  backgroundColor: C.card,
  borderRadius: 20,
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.06,
  shadowRadius: 8,
  elevation: 2,
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  contentContainer: { padding: 20, paddingBottom: 40 },

  treatsCard: {
    ...card,
    marginTop: 16,
    padding: 20,
    alignItems: 'center',
  },
  treatsHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
  treatsTitle: { fontSize: 14, fontWeight: '700', color: C.text, textTransform: 'uppercase' },
  treatsBadge: {
    backgroundColor: C.warning,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  treatsBadgeText: { fontSize: 13, fontWeight: '800', color: '#fff' },
  treatDotsRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6, marginBottom: 16 },
  treatDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.warning },
  treatMore: { fontSize: 12, color: C.text3, alignSelf: 'center', marginLeft: 4 },
  feedButton: {
    backgroundColor: C.primary,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 12,
  },
  feedButtonDisabled: { opacity: 0.4 },
  feedButtonText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  noDeviceHint: { fontSize: 11, color: C.text3, marginTop: 10 },

  emptyCard: {
    ...card,
    marginTop: 16,
    padding: 32,
    alignItems: 'center',
    gap: 6,
  },
  emptyText: { fontSize: 15, fontWeight: '700', color: C.text },
  emptySubText: { fontSize: 12, color: C.text3, textAlign: 'center' },
});

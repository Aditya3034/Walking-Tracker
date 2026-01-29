import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, PermissionsAndroid,
  Platform, NativeModules, NativeEventEmitter, Alert, ScrollView
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import BleStepService from './BleStepService';

const { StepCounter } = NativeModules;
const eventEmitter = new NativeEventEmitter(StepCounter);

const MAX_STEPS = 1000;

function SemiCircleProgress({ size = 260, strokeWidth = 14, progress }) {
  const radius = (size - strokeWidth) / 2;
  const center = size / 2;
  const circumference = Math.PI * radius;
  const ratio = progress / MAX_STEPS;
  const dashOffset = circumference * (1 - ratio);

  return (
    <Svg width={size} height={size / 2 + strokeWidth}>
      <Path
        d={`M ${strokeWidth / 2}, ${center}
            A ${radius}, ${radius} 0 0 1 ${size - strokeWidth / 2}, ${center}`}
        stroke="#e0e0e0"
        strokeWidth={strokeWidth}
        fill="none"
      />
      <Path
        d={`M ${strokeWidth / 2}, ${center}
            A ${radius}, ${radius} 0 0 1 ${size - strokeWidth / 2}, ${center}`}
        stroke="#27ae60"
        strokeWidth={strokeWidth}
        fill="none"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export default function WalkingTrackerScreen() {
  const [steps, setSteps] = useState(0);
  const [isTracking, setIsTracking] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [bleStatus, setBleStatus] = useState('No device');

  useEffect(() => {
    const sub = eventEmitter.addListener('StepCounterUpdate', (data) => {
      setSteps(Math.round(data));
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    requestAllPermissions();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const s = BleStepService.getTrackingStatus();
      if (s.hasDevice) {
        setBleStatus(`Connected: ${s.deviceName}`);
      } else {
        setBleStatus('No device connected');
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const requestAllPermissions = async () => {
    if (Platform.OS !== 'android') return true;

    const permissions = [];
    if (Platform.Version >= 33)
      permissions.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    if (Platform.Version >= 29)
      permissions.push(PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION);

    const results = await PermissionsAndroid.requestMultiple(permissions);
    return Object.values(results).every(r => r === PermissionsAndroid.RESULTS.GRANTED);
  };

  const toggleTracking = async () => {
    if (isTracking) {
      BleStepService.stopStepTracking();
      await StepCounter.stopBackgroundService();
      StepCounter.stopStepCounter();
      setIsTracking(false);
      setStatus('Stopped');
    } else {
      const granted = await requestAllPermissions();
      if (!granted) return;

      StepCounter.startStepCounter();
      BleStepService.startStepTracking();

      try {
        await StepCounter.startBackgroundService();
        setIsTracking(true);
        setStatus('Tracking');
      } catch {
        BleStepService.stopStepTracking();
        setStatus('Failed');
      }
    }
  };

  const ringProgress = steps % MAX_STEPS;
  const hasDevice = bleStatus.includes('Connected');

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={[styles.card, hasDevice ? styles.cardSuccess : styles.cardWarning]}>
        <Text style={styles.cardIcon}>{hasDevice ? '✅' : '⚠️'}</Text>
        <View>
          <Text style={styles.cardTitle}>Device Status</Text>
          <Text style={styles.cardText}>{bleStatus}</Text>
        </View>
      </View>

      <View style={styles.stepsCard}>
        <SemiCircleProgress progress={ringProgress} />

        <View style={styles.centerSteps}>
          <Text style={styles.stepsNumber}>{steps.toLocaleString()}</Text>
          <Text style={styles.stepsLabel}>Steps</Text>
        </View>

        <View style={[styles.statusBadge, isTracking && styles.statusBadgeActive]}>
          <View style={[styles.statusDot, isTracking && styles.statusDotActive]} />
          <Text style={[styles.statusText, isTracking && styles.statusTextActive]}>
            {status}
          </Text>
        </View>
      </View>

      <TouchableOpacity
        style={[styles.actionButton, isTracking && styles.actionButtonStop]}
        onPress={toggleTracking}
      >
        <Text style={styles.actionButtonText}>
          {isTracking ? 'STOP' : 'START'}
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  contentContainer: { padding: 20 },
  card: {
    flexDirection: 'row', padding: 16, borderRadius: 12,
    backgroundColor: '#fff', marginBottom: 20, borderLeftWidth: 4
  },
  cardSuccess: { borderLeftColor: '#27ae60' },
  cardWarning: { borderLeftColor: '#f39c12' },
  cardIcon: { fontSize: 28, marginRight: 12 },
  cardTitle: { fontSize: 12, color: '#666' },
  cardText: { fontSize: 16, fontWeight: '600' },

  stepsCard: {
    backgroundColor: '#fff',
    padding: 24,
    borderRadius: 20,
    alignItems: 'center',
    marginBottom: 20,
  },
  centerSteps: {
    position: 'absolute',
    top: '38%',
    alignItems: 'center',
  },
  stepsNumber: {
    fontSize: 48,
    fontWeight: '900',
    color: '#2c3e50',
  },
  stepsLabel: {
    fontSize: 14,
    color: '#7f8c8d',
    fontWeight: '600',
  },

  statusBadge: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  statusBadgeActive: { backgroundColor: '#d1f2eb' },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#95a5a6', marginRight: 8 },
  statusDotActive: { backgroundColor: '#27ae60' },
  statusText: { fontWeight: '600', color: '#7f8c8d' },
  statusTextActive: { color: '#27ae60' },

  actionButton: {
    backgroundColor: '#27ae60',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  actionButtonStop: { backgroundColor: '#e74c3c' },
  actionButtonText: { color: '#fff', fontSize: 18, fontWeight: '700' },
});

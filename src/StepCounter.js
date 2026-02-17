import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  PermissionsAndroid,
  Platform,
  NativeModules,
  NativeEventEmitter,
  ScrollView,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import BleStepService from './BleStepService';
import Geolocation from 'react-native-geolocation-service';
import MapView, { Polyline } from 'react-native-maps';

const { StepCounter } = NativeModules;
const eventEmitter = new NativeEventEmitter(StepCounter);

const MAX_STEPS = 100;

/* -------------------- UI COMPONENT -------------------- */

function SemiCircleProgress({ size = 260, strokeWidth = 14, progress }) {
  const radius = (size - strokeWidth) / 2;
  const center = size / 2;
  const circumference = Math.PI * radius;
  const ratio = Math.min(progress / MAX_STEPS, 1);
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

/* -------------------- MAIN SCREEN -------------------- */

export default function WalkingTrackerScreen() {
  const [steps, setSteps] = useState(0);
  const [isTracking, setIsTracking] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [bleStatus, setBleStatus] = useState('No device');

  // NEW: Route state
  const [route, setRoute] = useState([]);
  const watchIdRef = useRef(null);

  // Internal refs
  const sessionOffsetRef = useRef(null);
  const savedStepsRef = useRef(0);

  /* ---------- STEP EVENTS ---------- */

  useEffect(() => {
    const sub = eventEmitter.addListener('StepCounterUpdate', (data) => {
      const rawSteps = Math.round(data);

      if (sessionOffsetRef.current === null) {
        sessionOffsetRef.current = rawSteps;
        setSteps(savedStepsRef.current);
        return;
      }

      const sessionSteps = rawSteps - sessionOffsetRef.current;
      if (sessionSteps >= 0) {
        setSteps(savedStepsRef.current + sessionSteps);
      }
    });

    return () => sub.remove();
  }, []);

  /* ---------- PERMISSIONS ---------- */

  useEffect(() => {
    requestAllPermissions();
  }, []);

  const requestAllPermissions = async () => {
    if (Platform.OS !== 'android') return true;

    const permissions = [];

    if (Platform.Version >= 33)
      permissions.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);

    if (Platform.Version >= 29)
      permissions.push(PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION);

    permissions.push(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);

    const results = await PermissionsAndroid.requestMultiple(permissions);
    return Object.values(results).every(
      r => r === PermissionsAndroid.RESULTS.GRANTED
    );
  };

  /* ---------- BLE STATUS ---------- */

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

  /* ---------- START / STOP ---------- */

  const toggleTracking = async () => {
    if (isTracking) {
      BleStepService.stopStepTracking();
      await StepCounter.stopBackgroundService();
      StepCounter.stopStepCounter();

      if (watchIdRef.current !== null) {
        Geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }

      savedStepsRef.current = steps;
      sessionOffsetRef.current = null;

      setIsTracking(false);
      setStatus('Stopped');
    } else {
      const granted = await requestAllPermissions();
      if (!granted) return;

      sessionOffsetRef.current = null;
      setRoute([]);

      watchIdRef.current = Geolocation.watchPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          setRoute(prev => [...prev, { latitude, longitude }]);
        },
        (err) => console.log('GPS error', err),
        {
          enableHighAccuracy: true,
          distanceFilter: 5,
          interval: 3000,
          fastestInterval: 2000,
        }
      );

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

  /* ---------- DERIVED VALUES ---------- */

  const ringProgress = steps % MAX_STEPS;
  const treats = Math.floor(steps / MAX_STEPS);
  const hasDevice = bleStatus.includes('Connected');
  const ringJustCompleted = ringProgress === 0 && steps > 0;

  /* ---------- FEED PET ---------- */

  const feedPet = async () => {
    if (treats <= 0) return;
    if (!hasDevice) return;

    try {
      BleStepService.writeToDevice('FEED');

      savedStepsRef.current = Math.max(0, savedStepsRef.current - MAX_STEPS);
      setSteps(prev => Math.max(0, prev - MAX_STEPS));
    } catch (e) {
      console.warn('Feed failed', e);
    }
  };

  /* -------------------- UI -------------------- */

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
        <Text style={styles.actionButtonText}>{isTracking ? 'STOP' : 'START'}</Text>
      </TouchableOpacity>

      {/* ROUTE PREVIEW */}
      {route.length > 2 && !isTracking && (
        <View style={{ height: 200, borderRadius: 16, overflow: 'hidden', marginTop: 20 }}>
          <MapView
            style={{ flex: 1 }}
            initialRegion={{
              latitude: route[0].latitude,
              longitude: route[0].longitude,
              latitudeDelta: 0.01,
              longitudeDelta: 0.01,
            }}
            scrollEnabled={false}
            zoomEnabled={false}
          >
            <Polyline
              coordinates={route}
              strokeColor="#ff5a1f"
              strokeWidth={4}
              lineCap="round"
              lineJoin="round"
            />
          </MapView>
        </View>
      )}

      {treats > 0 && (
        <View style={styles.treatsCard}>
          <Text style={styles.treatsTitle}>🍪 Treats Earned</Text>
          <View style={styles.treatsRow}>
            {Array.from({ length: treats }).map((_, i) => (
              <Text key={i} style={styles.treatIcon}>🍪</Text>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.feedButton, (!hasDevice || treats <= 0) && { opacity: 0.5 }]}
            onPress={feedPet}
            disabled={!hasDevice || treats <= 0}
          >
            <Text style={styles.feedButtonText}>🍖 Feed Pet</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

/* -------------------- STYLES -------------------- */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  contentContainer: { padding: 20 },
  card: { flexDirection: 'row', padding: 16, borderRadius: 12, backgroundColor: '#fff', marginBottom: 20, borderLeftWidth: 4 },
  cardSuccess: { borderLeftColor: '#27ae60' },
  cardWarning: { borderLeftColor: '#f39c12' },
  cardIcon: { fontSize: 28, marginRight: 12 },
  cardTitle: { fontSize: 12, color: '#666' },
  cardText: { fontSize: 16, fontWeight: '600' },
  stepsCard: { backgroundColor: '#fff', padding: 24, borderRadius: 20, alignItems: 'center', marginBottom: 20 },
  centerSteps: { position: 'absolute', top: '38%', alignItems: 'center' },
  stepsNumber: { fontSize: 48, fontWeight: '900', color: '#2c3e50' },
  stepsLabel: { fontSize: 14, color: '#7f8c8d', fontWeight: '600' },
  statusBadge: { marginTop: 20, flexDirection: 'row', alignItems: 'center', backgroundColor: '#f5f5f5', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  statusBadgeActive: { backgroundColor: '#d1f2eb' },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#95a5a6', marginRight: 8 },
  statusDotActive: { backgroundColor: '#27ae60' },
  statusText: { fontWeight: '600', color: '#7f8c8d' },
  statusTextActive: { color: '#27ae60' },
  actionButton: { backgroundColor: '#27ae60', paddingVertical: 16, borderRadius: 12, alignItems: 'center', marginTop: 10 },
  actionButtonStop: { backgroundColor: '#e74c3c' },
  actionButtonText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  treatsCard: { marginTop: 20, backgroundColor: '#fff', padding: 16, borderRadius: 16, alignItems: 'center' },
  treatsTitle: { fontSize: 16, fontWeight: '700', marginBottom: 8, color: '#2c3e50' },
  treatsRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  treatIcon: { fontSize: 24, margin: 4 },
  feedButton: { marginTop: 12, backgroundColor: '#f39c12', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20 },
  feedButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});

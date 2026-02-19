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
import Svg, { Path, Polyline, Rect, Circle } from 'react-native-svg';
import BleStepService from './BleStepService';
import Geolocation from 'react-native-geolocation-service';

const { StepCounter } = NativeModules;
const eventEmitter = new NativeEventEmitter(StepCounter);

const MAX_STEPS = 100;

/* -------------------- UTILS -------------------- */

function normalizeRoute(points, width, height, padding = 20) {
  if (!points.length) return [];

  const lats = points.map(p => p.latitude);
  const lngs = points.map(p => p.longitude);

  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  const latRange = maxLat - minLat || 1;
  const lngRange = maxLng - minLng || 1;

  return points.map(p => {
    const x = padding + ((p.longitude - minLng) / lngRange) * (width - padding * 2);
    const y = padding + ((maxLat - p.latitude) / latRange) * (height - padding * 2);
    return { x, y };
  });
}

/* -------------------- UI COMPONENTS -------------------- */

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

function RouteOutline({ route, width = 320, height = 200 }) {
  const points = normalizeRoute(route, width, height);
  if (points.length < 2) return null;

  const polylinePoints = points.map(p => `${p.x},${p.y}`).join(' ');
  const start = points[0];
  const end = points[points.length - 1];

  return (
    <View style={{ alignItems: 'center', marginTop: 20 }}>
      <Svg width={width} height={height}>
        <Rect x="0" y="0" width={width} height={height} rx="16" fill="#0f172a" />

        {/* Glow */}
        <Polyline
          points={polylinePoints}
          fill="none"
          stroke="rgba(255,90,31,0.4)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Main route */}
        <Polyline
          points={polylinePoints}
          fill="none"
          stroke="#ff5a1f"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Start / End dots */}
        <Circle cx={start.x} cy={start.y} r="5" fill="#22c55e" />
        <Circle cx={end.x} cy={end.y} r="5" fill="#ef4444" />
      </Svg>
    </View>
  );
}

/* -------------------- MAIN SCREEN -------------------- */

export default function WalkingTrackerScreen() {
  const [steps, setSteps] = useState(0);
  const [isTracking, setIsTracking] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [bleStatus, setBleStatus] = useState('No device');
  const [route, setRoute] = useState([]);

  const watchIdRef = useRef(null);
  const sessionOffsetRef = useRef(null);
  const savedStepsRef = useRef(0);

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

  const requestAllPermissions = async () => {
    if (Platform.OS !== 'android') return true;

    const permissions = [
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION,
    ];

    const results = await PermissionsAndroid.requestMultiple(permissions);
    return Object.values(results).every(r => r === PermissionsAndroid.RESULTS.GRANTED);
  };

  useEffect(() => {
    const interval = setInterval(() => {
      const s = BleStepService.getTrackingStatus();
      setBleStatus(s.hasDevice ? `Connected: ${s.deviceName}` : 'No device connected');
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const toggleTracking = async () => {
    if (isTracking) {
      Geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;

      BleStepService.stopStepTracking();
      await StepCounter.stopBackgroundService();
      StepCounter.stopStepCounter();

      savedStepsRef.current = steps;
      sessionOffsetRef.current = null;

      setIsTracking(false);
      setStatus('Stopped');
    } else {
      const granted = await requestAllPermissions();
      if (!granted) return;

      setRoute([]);
      sessionOffsetRef.current = null;

      watchIdRef.current = Geolocation.watchPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          setRoute(prev => [...prev, { latitude, longitude }]);
        },
        (err) => console.log('GPS error', err),
        { enableHighAccuracy: true, distanceFilter: 5, interval: 3000 }
      );

      StepCounter.startStepCounter();
      BleStepService.startStepTracking();
      await StepCounter.startBackgroundService();

      setIsTracking(true);
      setStatus('Tracking');
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.stepsCard}>
        <SemiCircleProgress progress={steps % MAX_STEPS} />
        <View style={styles.centerSteps}>
          <Text style={styles.stepsNumber}>{steps}</Text>
          <Text style={styles.stepsLabel}>Steps</Text>
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

      <Text style={{ textAlign: 'center', color: '#999', marginTop: 10 }}>
        GPS points: {route.length}
      </Text>

      {route.length > 1 && <RouteOutline route={route} />}
    </ScrollView>
  );
}

/* -------------------- STYLES -------------------- */

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  contentContainer: { padding: 20 },
  stepsCard: {
    backgroundColor: '#fff',
    padding: 24,
    borderRadius: 20,
    alignItems: 'center',
    marginBottom: 20,
  },
  centerSteps: { position: 'absolute', top: '38%', alignItems: 'center' },
  stepsNumber: { fontSize: 48, fontWeight: '900', color: '#2c3e50' },
  stepsLabel: { fontSize: 14, color: '#7f8c8d', fontWeight: '600' },
  actionButton: {
    backgroundColor: '#27ae60',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 10,
  },
  actionButtonStop: { backgroundColor: '#e74c3c' },
  actionButtonText: { color: '#fff', fontSize: 18, fontWeight: '700' },
});

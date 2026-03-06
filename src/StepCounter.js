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
import Svg, { Path, Polyline, Rect, Circle, Text as SvgText } from 'react-native-svg';
import BleStepService from './BleStepService';
import Geolocation from 'react-native-geolocation-service';

const { StepCounter } = NativeModules;
const eventEmitter = new NativeEventEmitter(StepCounter);

const MAX_STEPS = 100;

/* -------------------- ROUTE HELPERS -------------------- */

function projectRouteRaw(points, scale = 100000) {
  if (!points.length) return [];

  const base = points[0];
  return points.map(p => ({
    x: (p.longitude - base.longitude) * scale,
    y: (base.latitude - p.latitude) * scale,
  }));
}

function followCurrentPoint(points, width, height) {
  if (!points.length) return [];

  const centerX = width / 2;
  const centerY = height / 2;

  const current = points[points.length - 1];

  return points.map(p => ({
    x: p.x - current.x + centerX,
    y: p.y - current.y + centerY,
  }));
}

function normalizeRouteToCard(points, width, height, padding = 24) {
  if (!points.length) return [];

  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const routeWidth = maxX - minX || 1;
  const routeHeight = maxY - minY || 1;

  const availableWidth = width - padding * 2;
  const availableHeight = height - padding * 2;

  // use uniform scale so angles stay correct
  const scale = Math.min(
    availableWidth / routeWidth,
    availableHeight / routeHeight
  );

  // center the route inside the card
  const offsetX = (width - routeWidth * scale) / 2;
  const offsetY = (height - routeHeight * scale) / 2;

  return points.map(p => ({
    x: offsetX + (p.x - minX) * scale,
    y: offsetY + (p.y - minY) * scale,
  }));
}



function getHeading(points) {
  if (points.length < 2) return 0;

  const p1 = points[points.length - 2];
  const p2 = points[points.length - 1];

  const dLon = (p2.longitude - p1.longitude) * Math.PI / 180;

  const lat1 = p1.latitude * Math.PI / 180;
  const lat2 = p2.latitude * Math.PI / 180;

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  const bearing = Math.atan2(y, x) * (180 / Math.PI);

  return (bearing + 360) % 360;
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

function RouteOutline({ route, isTracking, width = 340, height = 260 }) {

  if (route.length < 1) return null;

  const world = projectRouteRaw(route);

  let points;

  if (isTracking) {
  points = followCurrentPoint(world, width, height);
} else {
  points = normalizeRouteToCard(world, width, height, 50);
}

  const polylinePoints = points.map(p => `${p.x},${p.y}`).join(' ');
  const start = points[0];
  const end = points[points.length - 1];

  return (
    <View style={{ alignItems: 'center', marginTop: 20 }}>
      <Svg width={width} height={height}>
        <Rect x="0" y="0" width={width} height={height} rx="16" fill="#ffffff" />

        <Polyline
          points={polylinePoints}
          fill="none"
          stroke="rgba(255, 91, 31, 0)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        <Polyline
          points={polylinePoints}
          fill="none"
          stroke="#000000"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        <Circle cx={start.x} cy={start.y} r="3" fill="#034dd8" />
        <Circle cx={end.x} cy={end.y} r="6" fill="#0098e9" />
      </Svg>
    </View>
  );
}

function DirectionCompass({ route }) {
  const heading = getHeading(route);

  return (
    <View style={{ alignItems: 'center', marginTop: 12 }}>
      <Svg width={60} height={60} viewBox="0 0 60 60">

        <Circle cx="30" cy="30" r="10" fill="#fff" />

        {/* NORTH LABEL */}
        <SvgText
          x="30"
          y="10"
          fontSize="10"
          fill="#333"
          textAnchor="middle"
        >
          N
        </SvgText>

        {/* ARROW */}
        <Path
          d="M30 12 L36 30 L30 26 L24 30 Z"
          fill="#000"
          transform={`rotate(${heading} 30 30)`}
        />

      </Svg>

      <Text style={{ fontSize: 12, color: '#777', marginTop: 4 }}>
        Direction
      </Text>
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

  useEffect(() => {
    const interval = setInterval(() => {
      const s = BleStepService.getTrackingStatus();
      setBleStatus(s.hasDevice ? `Connected: ${s.deviceName}` : 'No device connected');
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const requestAllPermissions = async () => {
    if (Platform.OS !== 'android') return true;

    const results = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION,
    ]);

    return Object.values(results).every(r => r === PermissionsAndroid.RESULTS.GRANTED);
  };

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

  const ringProgress = steps % MAX_STEPS;
  const treats = Math.floor(steps / MAX_STEPS);
  const hasDevice = bleStatus.includes('Connected');

  const feedPet = async () => {
    if (treats <= 0 || !hasDevice) return;

    try {
      BleStepService.writeToDevice('FEED');
      savedStepsRef.current = Math.max(0, savedStepsRef.current - MAX_STEPS);
      setSteps(prev => Math.max(0, prev - MAX_STEPS));
    } catch (e) {
      console.warn('Feed failed', e);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.stepsCard}>
        <SemiCircleProgress progress={ringProgress} />
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
      <DirectionCompass route={route} />

      {route.length >= 1 && (
        <RouteOutline route={route} isTracking={isTracking} />
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
            <Text style={styles.feedButtonText}>Feed Pet</Text>
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

  treatsCard: {
    marginTop: 20,
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 16,
    alignItems: 'center',
  },
  treatsTitle: { fontSize: 16, fontWeight: '700', marginBottom: 8, color: '#2c3e50' },
  treatsRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  treatIcon: { fontSize: 24, margin: 4 },

  feedButton: {
    marginTop: 12,
    backgroundColor: '#f39c12',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
  },
  feedButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
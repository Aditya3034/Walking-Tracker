import React, { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  NativeModules,
  NativeEventEmitter,
  ScrollView,
  AppState,
  Modal,
  Dimensions,
} from 'react-native';
import {
  request,
  requestMultiple,
  PERMISSIONS,
  RESULTS,
} from 'react-native-permissions';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
import Svg, { Path, Polyline, Rect, Circle } from 'react-native-svg';
import BleStepService from './BleStepService';
import Geolocation from 'react-native-geolocation-service';

const { StepCounter } = NativeModules;
if (!StepCounter) {
  console.error(
    '[StepCounter] Native module "StepCounter" is not registered. ' +
    'Ensure StepCounterPackage is added to MainApplication and the app has been rebuilt.'
  );
}
const eventEmitter = new NativeEventEmitter(StepCounter || null);

const MAX_STEPS = 100;
const MAX_ROUTE_POINTS = 500;

/* -------------------- DISTANCE HELPERS -------------------- */

function haversineDistance(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const R = 6371000;
    const φ1 = points[i - 1].latitude * Math.PI / 180;
    const φ2 = points[i].latitude * Math.PI / 180;
    const Δφ = (points[i].latitude - points[i - 1].latitude) * Math.PI / 180;
    const Δλ = (points[i].longitude - points[i - 1].longitude) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    total += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return total; // metres
}

function calcSegmentsDistance(segments) {
  return segments.reduce((sum, seg) => sum + haversineDistance(seg), 0);
}

function formatDistance(metres) {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(2)} km`;
}

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
  const scale = Math.min(
    (width - padding * 2) / routeWidth,
    (height - padding * 2) / routeHeight
  );
  const offsetX = (width - routeWidth * scale) / 2;
  const offsetY = (height - routeHeight * scale) / 2;
  return points.map(p => ({
    x: offsetX + (p.x - minX) * scale,
    y: offsetY + (p.y - minY) * scale,
  }));
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
        d={`M ${strokeWidth / 2}, ${center} A ${radius}, ${radius} 0 0 1 ${size - strokeWidth / 2}, ${center}`}
        stroke="#e0e0e0"
        strokeWidth={strokeWidth}
        fill="none"
      />
      <Path
        d={`M ${strokeWidth / 2}, ${center} A ${radius}, ${radius} 0 0 1 ${size - strokeWidth / 2}, ${center}`}
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

// Accepts routeSegments (array of arrays) and renders each segment as a separate polyline.
// All segments share the same projection so coordinates are consistent.
function RouteOutline({ routeSegments, isTracking, width = 340, height = 260 }) {
  const allPoints = routeSegments.flat();
  if (allPoints.length < 1) return null;

  // Project all points together so segments share a coordinate system
  const world = projectRouteRaw(allPoints);

  const transformed = isTracking
    ? followCurrentPoint(world, width, height)
    : normalizeRouteToCard(world, width, height, 50);

  // Split transformed array back into per-segment slices
  const segmentViews = [];
  let offset = 0;
  for (let i = 0; i < routeSegments.length; i++) {
    segmentViews.push(transformed.slice(offset, offset + routeSegments[i].length));
    offset += routeSegments[i].length;
  }

  const firstPoint = transformed[0];
  const lastPoint = transformed[transformed.length - 1];

  return (
    <View style={{ alignItems: 'center', marginTop: 20 }}>
      <Svg width={width} height={height}>
        <Rect x="0" y="0" width={width} height={height} rx="16" fill="#ffffff" />

        {segmentViews.map((seg, i) => {
          if (seg.length < 2) return null;
          const poly = seg.map(p => `${p.x},${p.y}`).join(' ');
          return (
            <Polyline
              key={i}
              points={poly}
              fill="none"
              stroke="#000000"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}

        {firstPoint && (
          <Circle cx={firstPoint.x} cy={firstPoint.y} r="3" fill="#034dd8" />
        )}
        {allPoints.length > 1 && lastPoint && (
          <Circle cx={lastPoint.x} cy={lastPoint.y} r="6" fill="#0098e9" />
        )}
      </Svg>
    </View>
  );
}

/* -------------------- SESSION SUMMARY MODAL -------------------- */

function SessionSummaryModal({ visible, steps, routeSegments, treatsEarned, onClose }) {
  const treats = treatsEarned || 0;
  const hasRoute = Array.isArray(routeSegments) && routeSegments.flat().length >= 1;
  const routeW = SCREEN_WIDTH - 80;
  const routeH = 200;
  const distanceMetres = Array.isArray(routeSegments) ? calcSegmentsDistance(routeSegments) : 0;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={summaryStyles.overlay}>
        <View style={summaryStyles.sheet}>

          <Text style={summaryStyles.title}>Session Complete</Text>

          {hasRoute && (
            <View style={summaryStyles.routeWrapper}>
              <RouteOutline
                routeSegments={routeSegments}
                isTracking={false}
                width={routeW}
                height={routeH}
              />
            </View>
          )}

          <View style={summaryStyles.statsRow}>
            <View style={summaryStyles.statBox}>
              <Text style={summaryStyles.statValue}>{steps}</Text>
              <Text style={summaryStyles.statLabel}>Steps</Text>
            </View>
            {distanceMetres > 0 && (
              <View style={summaryStyles.statBox}>
                <Text style={summaryStyles.statValue}>{formatDistance(distanceMetres)}</Text>
                <Text style={summaryStyles.statLabel}>Distance</Text>
              </View>
            )}
            {treats > 0 && (
              <View style={summaryStyles.statBox}>
                <Text style={summaryStyles.statValue}>{treats}</Text>
                <Text style={summaryStyles.statLabel}>Treats</Text>
              </View>
            )}
          </View>

          {treats > 0 && (
            <View style={summaryStyles.treatsRow}>
              {Array.from({ length: Math.min(treats, 12) }).map((_, i) => (
                <View key={i} style={summaryStyles.treatDot} />
              ))}
              {treats > 12 && (
                <Text style={summaryStyles.treatsOverflow}>+{treats - 12}</Text>
              )}
            </View>
          )}

          <TouchableOpacity style={summaryStyles.doneButton} onPress={onClose}>
            <Text style={summaryStyles.doneButtonText}>Done</Text>
          </TouchableOpacity>

        </View>
      </View>
    </Modal>
  );
}

/* -------------------- MAIN SCREEN -------------------- */

// trackingState: 'idle' | 'tracking' | 'paused'
export default function WalkingTrackerScreen() {
  const [steps, setSteps] = useState(0);
  const [pendingTreats, setPendingTreats] = useState(0);
  const [trackingState, setTrackingState] = useState('idle');
  const [bleStatus, setBleStatus] = useState('No device');
  const [routeSegments, setRouteSegments] = useState([]);
  const [summaryVisible, setSummaryVisible] = useState(false);
  const [summaryData, setSummaryData] = useState(null);

  const watchIdRef = useRef(null);
  const sessionOffsetRef = useRef(null);
  const savedStepsRef = useRef(0);
  const isSensorStartedRef = useRef(false);
  const isFinishingRef = useRef(false);
  const lastGpsPosRef = useRef(null);
  const sessionTreatsRef = useRef(0); // treats earned in current session (prevents double-counting)

  /* -------- load persisted treats on mount -------- */
  useEffect(() => {
    AsyncStorage.getItem('pendingTreats').then(val => {
      if (val !== null) setPendingTreats(parseInt(val, 10) || 0);
    }).catch(() => {});
  }, []);

  /* -------- step counter event listener -------- */
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
        const totalSteps = savedStepsRef.current + sessionSteps;
        setSteps(totalSteps);

        // Earn a treat for every MAX_STEPS crossed — tracked against sessionTreatsRef to avoid double-counting
        const totalTreatsEarned = Math.floor(totalSteps / MAX_STEPS);
        if (totalTreatsEarned > sessionTreatsRef.current) {
          const newlyEarned = totalTreatsEarned - sessionTreatsRef.current;
          sessionTreatsRef.current = totalTreatsEarned;
          setPendingTreats(prev => {
            const updated = prev + newlyEarned;
            AsyncStorage.setItem('pendingTreats', String(updated)).catch(() => {});
            return updated;
          });
        }
      }
    });
    return () => sub.remove();
  }, []);

  /* -------- BLE status — driven by native events, no polling -------- */
  useEffect(() => {
    // Set initial state
    const s = BleStepService.getTrackingStatus();
    setBleStatus(s.hasDevice ? `Connected: ${s.deviceName}` : 'No device connected');

    const unsubDisconnect = BleStepService.onDisconnect(() => {
      setBleStatus('No device connected');
    });

    // Listen for connect events via native emitter
    const connSub = eventEmitter?.addListener('BleConnectionUpdate', (state) => {
      if (state === 'connected') {
        setBleStatus(`Connected: ${BleStepService.deviceName || 'Pet Locket'}`);
      } else {
        setBleStatus('No device connected');
      }
    });

    return () => {
      unsubDisconnect();
      connSub?.remove();
    };
  }, []);

  /* -------- restore state if background service is still running after app kill -------- */
  useEffect(() => {
    const syncOnMount = async () => {
      try {
        const sessionActive = await AsyncStorage.getItem('sessionInProgress');
        if (sessionActive !== 'true') return; // no interrupted session to restore
        const bgSteps = await StepCounter.getBackgroundSteps();
        if (bgSteps > 0) {
          savedStepsRef.current = bgSteps;
          sessionTreatsRef.current = Math.floor(bgSteps / MAX_STEPS); // don't re-earn treats from restored steps
          setSteps(bgSteps);
          setTrackingState('tracking');

          try {
            const routeJson = await StepCounter.getBackgroundRoute();
            const bgRoute = JSON.parse(routeJson).map(p => ({
              latitude: p.lat,
              longitude: p.lng,
            }));
            if (bgRoute.length > 0) setRouteSegments([[...bgRoute]]);
          } catch (e) {
            console.log('Route restore failed', e);
          }

          sessionOffsetRef.current = null;
          if (!isSensorStartedRef.current) {
            isSensorStartedRef.current = true;
            StepCounter.startStepCounter();
          }
          watchIdRef.current = startGpsWatch();
        }
      } catch (e) {
        console.log('Mount sync failed', e);
      }
    };
    syncOnMount();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------- sync steps when app foregrounds -------- */
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (nextState) => {
      if (nextState === 'active') {
        try {
          const bgSteps = await StepCounter.getBackgroundSteps();
          if (bgSteps > savedStepsRef.current) {
            savedStepsRef.current = bgSteps;
            sessionOffsetRef.current = null;
            sessionTreatsRef.current = Math.floor(bgSteps / MAX_STEPS); // don't re-earn treats from synced steps
            setSteps(bgSteps);
            // Don't override 'paused' — user explicitly paused, background steps are still counted
            setTrackingState(prev => prev === 'idle' ? 'idle' : prev);
          }
        } catch (e) {
          console.log('Background step sync failed', e);
        }
      }
    });
    return () => sub.remove();
  }, []);

  /* -------- GPS watch helper — shared by start, resume, syncOnMount -------- */
  const startGpsWatch = () => {
    lastGpsPosRef.current = null; // reset on each new watch so first point is always accepted
    return Geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;

        // Drop outlier points (stale cached fix, GPS drift).
        // At 1500ms / 3m distanceFilter a real step is never > 50m from the last point.
        if (lastGpsPosRef.current) {
          const dLat = latitude - lastGpsPosRef.current.latitude;
          const dLon = longitude - lastGpsPosRef.current.longitude;
          const approxMeters = Math.sqrt(dLat * dLat + dLon * dLon) * 111000;
          if (approxMeters > 150) {
            lastGpsPosRef.current = { latitude, longitude };
            return;
          }
        }
        lastGpsPosRef.current = { latitude, longitude };

        setRouteSegments(prev => {
          if (!prev.length) return prev;
          const updated = [...prev];
          let last = [...updated[updated.length - 1]];
          if (last.length >= MAX_ROUTE_POINTS) {
            last = last.filter((_, i) => i % 2 === 0);
          }
          last.push({ latitude, longitude });
          updated[updated.length - 1] = last;
          return updated;
        });
      },
      (err) => console.log('GPS error', err),
      { enableHighAccuracy: true, distanceFilter: 3, interval: 1500, fastestInterval: 750 }
    );
  };

  /* -------- permissions -------- */
  const requestAllPermissions = async () => {
    if (Platform.OS === 'android') {
      const perms = [
        PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION,
        PERMISSIONS.ANDROID.ACTIVITY_RECOGNITION,
      ];
      if (Platform.Version >= 33) {
        perms.push(PERMISSIONS.ANDROID.POST_NOTIFICATIONS);
      }
      const results = await requestMultiple(perms);
      const baseGranted = Object.values(results).every(r => r === RESULTS.GRANTED);
      if (!baseGranted) return false;
      if (Platform.Version >= 29) {
        await request(PERMISSIONS.ANDROID.ACCESS_BACKGROUND_LOCATION);
      }
      return true;
    }

    if (Platform.OS === 'ios') {
      const results = await requestMultiple([
        PERMISSIONS.IOS.LOCATION_WHEN_IN_USE,
        PERMISSIONS.IOS.MOTION,
      ]);
      const allGranted = Object.values(results).every(r => r === RESULTS.GRANTED);
      if (!allGranted) return false;
      await request(PERMISSIONS.IOS.LOCATION_ALWAYS);
      return true;
    }

    return true;
  };

  /* -------- session persistence -------- */
  const saveSession = async (finalSteps, finalRoute, finalSegments) => {
    const _d = new Date();
    const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
    const session = {
      steps: finalSteps,
      route: finalRoute,           // flat — backward compat
      segments: finalSegments,     // array of arrays — used for gap rendering
      timestamp: Date.now(),
    };
    try {
      const existing = await AsyncStorage.getItem('activities');
      const parsed = existing ? JSON.parse(existing) : {};
      if (!parsed[today]) parsed[today] = [];
      parsed[today].push(session);
      await AsyncStorage.setItem('activities', JSON.stringify(parsed));
    } catch (e) {
      console.log('Save failed', e);
    }
  };

  /* -------- tracking controls -------- */
  const startTracking = async () => {
    if (!StepCounter) return;
    const granted = await requestAllPermissions();
    if (!granted) return;

    await AsyncStorage.setItem('sessionInProgress', 'true');
    setRouteSegments([[]]); // fresh first segment
    sessionOffsetRef.current = null;
    watchIdRef.current = startGpsWatch();

    if (!isSensorStartedRef.current) {
      isSensorStartedRef.current = true;
      StepCounter.startStepCounter();
    }
    BleStepService.startStepTracking();
    try { await StepCounter.startBackgroundService(); } catch (e) {
      console.warn('startBackgroundService error', e);
    }
    setTrackingState('tracking');
  };

  const pauseTracking = () => {
    // Stop GPS watch — route stops drawing here
    if (watchIdRef.current != null) {
      Geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setTrackingState('paused');
  };

  const resumeTracking = () => {
    // Start a new segment — new points won't be connected to the pre-pause segment
    setRouteSegments(prev => [...prev, []]);
    watchIdRef.current = startGpsWatch();
    setTrackingState('tracking');
  };

  const finishTracking = async () => {
    if (!StepCounter || isFinishingRef.current) return;
    isFinishingRef.current = true;

    const flatRoute = routeSegments.flat();
    // Don't litter the calendar with empty entries
    if (steps > 0 || flatRoute.length > 0) {
      await saveSession(steps, flatRoute, routeSegments);
    }

    if (watchIdRef.current != null) {
      Geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }

    BleStepService.stopStepTracking();
    isSensorStartedRef.current = false;
    StepCounter.stopStepCounter();
    try { await StepCounter.stopBackgroundService(); } catch (e) {
      console.warn('stopBackgroundService error', e);
    }
    try { await StepCounter.clearSessionData(); } catch (e) {
      console.warn('clearSessionData error', e);
    }
    await AsyncStorage.removeItem('sessionInProgress');

    // Show summary before wiping state
    setSummaryData({ steps, routeSegments, treatsEarned: sessionTreatsRef.current });
    setSummaryVisible(true);
  };

  const handleSummaryClose = () => {
    setSummaryVisible(false);
    setSummaryData(null);
    savedStepsRef.current = 0;
    sessionOffsetRef.current = null;
    sessionTreatsRef.current = 0;
    isFinishingRef.current = false;
    setSteps(0);
    setRouteSegments([]);
    setTrackingState('idle');
  };

  /* -------- derived -------- */
  const ringProgress = steps % MAX_STEPS;
  const hasDevice = bleStatus.includes('Connected');
  const isActive = trackingState !== 'idle';

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

  /* -------- derived -------- */
  const allRoutePoints = Array.isArray(routeSegments) ? routeSegments.flat() : [];

  /* -------- render -------- */
  return (
    <>
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>

      {/* Steps ring */}
      <View style={styles.stepsCard}>
        <SemiCircleProgress progress={ringProgress} />
        <View style={styles.centerSteps}>
          <Text style={styles.stepsNumber}>{steps}</Text>
          <Text style={styles.stepsLabel}>Steps</Text>
        </View>
      </View>

      {/* Status badge */}
      {isActive && (
        <View style={[styles.statusBadge, trackingState === 'paused' && styles.statusBadgePaused]}>
          <View style={[styles.statusDot, trackingState === 'paused' && styles.statusDotPaused]} />
          <Text style={[styles.statusBadgeText, trackingState === 'paused' && styles.statusBadgeTextPaused]}>
            {trackingState === 'tracking' ? 'TRACKING' : 'PAUSED'}
          </Text>
        </View>
      )}

      {/* Controls */}
      {trackingState === 'idle' && (
        <TouchableOpacity style={styles.startButton} onPress={startTracking}>
          <Text style={styles.startButtonIcon}>▶</Text>
          <Text style={styles.startButtonText}>START</Text>
        </TouchableOpacity>
      )}

      {trackingState === 'tracking' && (
        <View style={styles.controlRow}>
          <TouchableOpacity style={styles.pauseButton} onPress={pauseTracking}>
            <Text style={styles.controlIcon}>⏸</Text>
            <Text style={styles.controlText}>PAUSE</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.finishButton} onPress={finishTracking}>
            <Text style={styles.controlIcon}>⏹</Text>
            <Text style={styles.controlText}>FINISH</Text>
          </TouchableOpacity>
        </View>
      )}

      {trackingState === 'paused' && (
        <View style={styles.controlRow}>
          <TouchableOpacity style={styles.resumeButton} onPress={resumeTracking}>
            <Text style={styles.controlIcon}>▶</Text>
            <Text style={styles.controlText}>RESUME</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.finishButton} onPress={finishTracking}>
            <Text style={styles.controlIcon}>⏹</Text>
            <Text style={styles.controlText}>FINISH</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* GPS acquiring */}
      {trackingState === 'tracking' && allRoutePoints.length === 0 && (
        <View style={styles.gpsWaiting}>
          <Text style={styles.gpsWaitingText}>Waiting for GPS signal…</Text>
        </View>
      )}

      {/* Route outline */}
      {allRoutePoints.length >= 1 && (
        <RouteOutline
          routeSegments={routeSegments}
          isTracking={trackingState === 'tracking'}
        />
      )}

      {/* Treats */}
      {pendingTreats > 0 && (
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
            style={[styles.feedButton, (!hasDevice || pendingTreats <= 0) && { opacity: 0.4 }]}
            onPress={feedPet}
            disabled={!hasDevice || pendingTreats <= 0}
          >
            <Text style={styles.feedButtonText}>Feed Pet</Text>
          </TouchableOpacity>
        </View>
      )}

    </ScrollView>

    {summaryData && (
      <SessionSummaryModal
        visible={summaryVisible}
        steps={summaryData.steps}
        routeSegments={summaryData.routeSegments}
        treatsEarned={summaryData.treatsEarned}
        onClose={handleSummaryClose}
      />
    )}
    </>
  );
}

/* -------------------- STYLES -------------------- */

const C = {
  bg:        '#f8fafc',
  card:      '#ffffff',
  primary:   '#0f172a',
  accent:    '#2563eb',
  success:   '#059669',
  warning:   '#d97706',
  danger:    '#dc2626',
  text:      '#0f172a',
  text2:     '#475569',
  text3:     '#94a3b8',
  border:    '#e2e8f0',
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

  /* Steps card */
  stepsCard: {
    ...card,
    padding: 24,
    alignItems: 'center',
    marginBottom: 12,
  },
  centerSteps: { position: 'absolute', top: '38%', alignItems: 'center' },
  stepsNumber: { fontSize: 52, fontWeight: '900', color: C.text, letterSpacing: -1 },
  stepsLabel: { fontSize: 12, color: C.text3, fontWeight: '600', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 2 },

  /* Status badge */
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: '#dcfce7',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginBottom: 14,
    gap: 7,
  },
  statusBadgePaused: { backgroundColor: '#fef3c7' },
  statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.success },
  statusDotPaused: { backgroundColor: C.warning },
  statusBadgeText: { fontSize: 11, fontWeight: '700', color: C.success, letterSpacing: 1.5, textTransform: 'uppercase' },
  statusBadgeTextPaused: { color: C.warning },

  /* Start button */
  startButton: {
    backgroundColor: C.success,
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
    shadowColor: C.success,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.28,
    shadowRadius: 8,
    elevation: 4,
  },
  startButtonIcon: { fontSize: 16, color: '#fff' },
  startButtonText: { color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 2, textTransform: 'uppercase' },

  /* Pause / Resume / Finish row */
  controlRow: { flexDirection: 'row', gap: 10, marginBottom: 6 },
  pauseButton: {
    flex: 1,
    backgroundColor: C.warning,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: C.warning,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.22,
    shadowRadius: 6,
    elevation: 3,
  },
  resumeButton: {
    flex: 1,
    backgroundColor: C.success,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: C.success,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.22,
    shadowRadius: 6,
    elevation: 3,
  },
  finishButton: {
    flex: 1,
    backgroundColor: C.danger,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: C.danger,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.22,
    shadowRadius: 6,
    elevation: 3,
  },
  controlIcon: { fontSize: 14, color: '#fff' },
  controlText: { color: '#fff', fontSize: 13, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase' },

  /* GPS waiting */
  gpsWaiting: {
    ...card,
    marginTop: 16,
    padding: 20,
    alignItems: 'center',
  },
  gpsWaitingText: { color: C.text3, fontSize: 13, fontWeight: '500', letterSpacing: 0.3 },

  /* Treats */
  treatsCard: {
    ...card,
    marginTop: 16,
    padding: 20,
    alignItems: 'center',
  },
  treatsHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
  treatsTitle: { fontSize: 14, fontWeight: '700', color: C.text, letterSpacing: 0.5, textTransform: 'uppercase' },
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
  treatsRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  feedButton: {
    backgroundColor: C.primary,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 12,
  },
  feedButtonText: { color: '#fff', fontWeight: '700', fontSize: 13, letterSpacing: 0.5 },
});

const summaryStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: C.card,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 28,
    paddingHorizontal: 24,
    paddingBottom: 44,
    alignItems: 'center',
  },
  title: {
    fontSize: 13,
    fontWeight: '800',
    color: C.text,
    letterSpacing: 2.5,
    textTransform: 'uppercase',
    marginBottom: 20,
  },
  routeWrapper: {
    width: '100%',
    alignItems: 'center',
    marginBottom: 24,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 40,
    marginBottom: 20,
  },
  statBox: { alignItems: 'center' },
  statValue: { fontSize: 42, fontWeight: '900', color: C.text, letterSpacing: -1 },
  statLabel: { fontSize: 11, color: C.text3, fontWeight: '600', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 4 },
  treatsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 6,
    marginBottom: 24,
  },
  treatDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: C.warning },
  treatsOverflow: { fontSize: 13, color: C.text3, alignSelf: 'center', marginLeft: 4 },
  doneButton: {
    backgroundColor: C.primary,
    paddingVertical: 16,
    paddingHorizontal: 56,
    borderRadius: 14,
  },
  doneButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
});

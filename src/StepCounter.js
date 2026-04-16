import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  Linking,
  DeviceEventEmitter,
} from 'react-native';
import {
  request,
  requestMultiple,
  PERMISSIONS,
  RESULTS,
} from 'react-native-permissions';

import Svg, { Path } from 'react-native-svg';
import { WebView } from 'react-native-webview';
import BleStepService from './BleStepService';
import Geolocation from 'react-native-geolocation-service';
import { buildMapboxHTML } from './mapboxHtml';

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

/* -------------------- MAIN SCREEN -------------------- */

// trackingState: 'idle' | 'tracking' | 'paused' | 'finished'
export default function WalkingTrackerScreen() {
  const [steps, setSteps] = useState(0);
  const [pendingTreats, setPendingTreats] = useState(0);
  const [trackingState, setTrackingState] = useState('idle');
  const [routeSegments, setRouteSegments] = useState([]);
  const [gpsWaiting, setGpsWaiting] = useState(false);
  const [petColor, setPetColor] = useState('#EE5514');
  const [scrollEnabled, setScrollEnabled] = useState(true);

  const watchIdRef = useRef(null);
  const sessionOffsetRef = useRef(null);
  const savedStepsRef = useRef(0);
  const isSensorStartedRef = useRef(false);
  const isFinishingRef = useRef(false);
  const lastGpsPosRef = useRef(null);
  const sessionTreatsRef = useRef(0); // treats earned in current session (prevents double-counting)

  const webRef = useRef(null);
  const [initialPos, setInitialPos] = useState({ lat: 19.076, lon: 72.877 });
  const [mapReady, setMapReady] = useState(false);
  // Memoised so petColor/initialPos updates never reload the WebView — color applied via setColor message
  const mapHtml = useMemo(() => buildMapboxHTML(initialPos.lat, initialPos.lon), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [gpsAvailable, setGpsAvailable] = useState(null); // null=unknown, true=ok, false=unavailable
  const sendMsg = (obj) => webRef.current?.postMessage(JSON.stringify(obj));

  /* -------- load persisted treats + petColor on mount -------- */
  useEffect(() => {
    AsyncStorage.getItem('pendingTreats').then(val => {
      if (val !== null) setPendingTreats(parseInt(val, 10) || 0);
    }).catch(() => {});
    AsyncStorage.getItem('petColor').then(val => {
      if (val && val !== '#f1f5f9' && val !== '#ffffff') setPetColor(val);
    }).catch(() => {});

    const sub = DeviceEventEmitter.addListener('petColorChange', color => setPetColor(color));
    return () => sub.remove();
  }, []);

  /* -------- get initial position for map center -------- */
  useEffect(() => {
    Geolocation.getCurrentPosition(
      pos => {
        setInitialPos({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setGpsAvailable(true);
      },
      () => setGpsAvailable(false),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }, []);

  /* -------- set color + handle background-restored session on map load -------- */
  useEffect(() => {
    if (!mapReady) return;
    sendMsg({ type: 'setColor', color: petColor });
    if (trackingState === 'tracking') {
      // App was killed mid-session and restored — start a fresh segment on the map
      sendMsg({ type: 'start' });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady]);

  /* -------- update map color when pet color changes -------- */
  useEffect(() => {
    if (mapReady) sendMsg({ type: 'setColor', color: petColor });
  }, [petColor, mapReady]);

  /* -------- idle GPS watch — keeps dot moving before/between sessions -------- */
  useEffect(() => {
    if (!mapReady || trackingState !== 'idle') return;

    const id = Geolocation.watchPosition(
      pos => {
        setGpsAvailable(true);
        sendMsg({ type: 'position', lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => setGpsAvailable(false),
      { enableHighAccuracy: true, distanceFilter: 0, interval: 2000 }
    );

    return () => Geolocation.clearWatch(id);
  }, [mapReady, trackingState]);

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
        setGpsWaiting(false);
        sendMsg({ type: 'position', lat: latitude, lon: longitude });

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
    setGpsWaiting(true);
    sendMsg({ type: 'start' });
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
    sendMsg({ type: 'pause' });
    setTrackingState('paused');
  };

  const resumeTracking = () => {
    // Start a new segment — new points won't be connected to the pre-pause segment
    setRouteSegments(prev => [...prev, []]);
    sendMsg({ type: 'resume' });
    setGpsWaiting(true);
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
    setGpsWaiting(false);

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

    sendMsg({ type: 'finish' }); // map fitBounds to show full route
    setTrackingState('finished');
  };

  const handleDone = () => {
    sendMsg({ type: 'clear' });
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
  const isFinished = trackingState === 'finished';
  const isActive = trackingState !== 'idle';

  /* -------- render -------- */
  return (
    <>
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer} scrollEnabled={scrollEnabled}>

      {/* Steps ring */}
      <View style={styles.stepsCard}>
        <SemiCircleProgress progress={ringProgress} />
        <View style={styles.centerSteps}>
          <Text style={styles.stepsNumber}>{steps}</Text>
          <Text style={styles.stepsLabel}>Steps</Text>
        </View>
      </View>

      {/* Status badge */}
      {isActive && !isFinished && (
        <View style={[styles.statusBadge, trackingState === 'paused' && styles.statusBadgePaused]}>
          <View style={[styles.statusDot, trackingState === 'paused' && styles.statusDotPaused]} />
          <Text style={[styles.statusBadgeText, trackingState === 'paused' && styles.statusBadgeTextPaused]}>
            {trackingState === 'tracking' ? 'TRACKING' : 'PAUSED'}
          </Text>
        </View>
      )}

      {/* Finished — distance + done */}
      {isFinished && (
        <View style={styles.finishedRow}>
          <View>
            <Text style={styles.finishedDist}>{formatDistance(calcSegmentsDistance(routeSegments))}</Text>
            <Text style={styles.finishedDistLabel}>Distance</Text>
          </View>
          <TouchableOpacity onPress={handleDone} activeOpacity={0.7}>
            <Text style={styles.doneText}>Done</Text>
          </TouchableOpacity>
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

      {/* GPS waiting banner */}
      {gpsWaiting && (
        <View style={styles.gpsBanner}>
          <Text style={styles.gpsBannerTitle}>Waiting for GPS…</Text>
          <Text style={styles.gpsBannerSub}>Make sure location is turned on</Text>
          <TouchableOpacity
            style={styles.gpsBannerBtn}
            onPress={() => {
              if (Platform.OS === 'android') {
                Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS').catch(() => Linking.openSettings());
              } else {
                Linking.openURL('App-Prefs:Privacy&path=LOCATION').catch(() => Linking.openSettings());
              }
            }}
            activeOpacity={0.8}
          >
            <Text style={styles.gpsBannerBtnText}>Open Location Settings</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Live map — always visible */}
      <View
        style={styles.mapCard}
        onTouchStart={() => setScrollEnabled(false)}
        onTouchEnd={() => setScrollEnabled(true)}
        onTouchCancel={() => setScrollEnabled(true)}
      >
        <WebView
          ref={webRef}
          originWhitelist={['*']}
          source={{ html: mapHtml }}
          style={{ flex: 1 }}
          javaScriptEnabled
          domStorageEnabled
          cacheEnabled
          mixedContentMode="always"
          onLoadEnd={() => setMapReady(true)}
          scrollEnabled={false}
          overScrollMode="never"
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        />
        {/* GPS unavailable overlay — shown when idle and location is off */}
        {!isActive && gpsAvailable === false && (
          <View style={styles.mapGpsOverlay}>
            <Text style={styles.mapGpsOverlayText}>Turn on location for accurate tracking</Text>
            <TouchableOpacity
              style={styles.mapGpsOverlayBtn}
              onPress={() => {
                if (Platform.OS === 'android') {
                  Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS').catch(() => Linking.openSettings());
                } else {
                  Linking.openURL('App-Prefs:Privacy&path=LOCATION').catch(() => Linking.openSettings());
                }
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.mapGpsOverlayBtnText}>Open Settings</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>


    </ScrollView>
    </>
  );
}

/* -------------------- STYLES -------------------- */

const C = {
  bg:        '#ffffff',
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
  stepsNumber: { fontSize: 52, fontWeight: '900', color: C.text },
  stepsLabel: { fontSize: 12, color: C.text3, fontWeight: '600', textTransform: 'uppercase', marginTop: 2 },

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
  statusBadgeText: { fontSize: 11, fontWeight: '700', color: C.success, textTransform: 'uppercase' },
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
  startButtonText: { color: '#fff', fontSize: 15, fontWeight: '800', textTransform: 'uppercase' },

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
  controlText: { color: '#fff', fontSize: 13, fontWeight: '700', textTransform: 'uppercase' },

  /* GPS waiting banner */
  gpsBanner: {
    ...card,
    marginTop: 16,
    paddingVertical: 14,
    paddingHorizontal: 18,
    alignItems: 'center',
    gap: 4,
  },
  gpsBannerTitle: { fontSize: 13, fontWeight: '700', color: C.text },
  gpsBannerSub: { fontSize: 11, color: C.text3, marginBottom: 8 },
  gpsBannerBtn: {
    backgroundColor: C.primary,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  gpsBannerBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  /* Live map card */
  mapCard: {
    height: 260,
    marginTop: 20,
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },

  mapGpsOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  mapGpsOverlayText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0f172a',
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  mapGpsOverlayBtn: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
  },
  mapGpsOverlayBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  /* Finished state — distance + done */
  finishedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  finishedDist: { fontSize: 32, fontWeight: '900', color: C.text },
  finishedDistLabel: { fontSize: 11, color: C.text3, fontWeight: '600', textTransform: 'uppercase', marginTop: 2 },
  doneText: { fontSize: 15, fontWeight: '700', color: C.accent },
});

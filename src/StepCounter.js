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
  Dimensions,
  AppState,
  Linking,
  DeviceEventEmitter,
  Animated,
} from 'react-native';
import {
  request,
  requestMultiple,
  PERMISSIONS,
  RESULTS,
} from 'react-native-permissions';
import { WebView } from 'react-native-webview';
import BleStepService from './BleStepService';
import Geolocation from 'react-native-geolocation-service';
import { buildMapboxHTML } from './mapboxHtml';
import { syncSessions } from './syncSessions';

Geolocation.setRNConfiguration({ skipPermissionRequests: true });

const { StepCounter } = NativeModules;
if (!StepCounter) {
  // Native module missing — likely a misconfigured build
}
const eventEmitter = new NativeEventEmitter(StepCounter || null);

const MAX_ROUTE_POINTS = 500;
let lastKnownPos = null; // persists across tab-switch unmount/remount

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

function displayDistance(metres) {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(2)} km`;
}

function formatDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* -------------------- MAIN SCREEN -------------------- */

// trackingState: 'idle' | 'tracking' | 'paused' | 'finished'
export default function WalkingTrackerScreen() {
  const [steps, setSteps] = useState(0);
  const [duration, setDuration] = useState(0);
  const [trackingState, setTrackingState] = useState('idle');
  const [routeSegments, setRouteSegments] = useState([]);
  const [gpsWaiting, setGpsWaiting] = useState(false);
  const [petColor, setPetColor] = useState('#EE5514');

  const watchIdRef = useRef(null);
  const sessionOffsetRef = useRef(null);
  const savedStepsRef = useRef(0);
  const isSensorStartedRef = useRef(false);
  const isFinishingRef = useRef(false);
  const lastGpsPosRef = useRef(null);
  const sessionRestoredRef = useRef(false);  // true when syncOnMount found an interrupted session
  const mapRouteRestoredRef = useRef(false); // true after we've sent restore to the WebView
  const intervalRef = useRef(null);
  const segmentStartRef = useRef(null);  // Date.now() when current tracking segment began
  const accumulatedRef = useRef(0);      // seconds from all completed segments (before last pause)

  const webRef = useRef(null);
  const [initialPos, setInitialPos] = useState(lastKnownPos || { lat: 19.076, lon: 72.877 });
  const [mapReady, setMapReady] = useState(false);
  // Memoised so petColor/initialPos updates never reload the WebView — color applied via setColor message
  const mapHtml = useMemo(() => buildMapboxHTML(initialPos.lat, initialPos.lon, null, SCREEN_HEIGHT * 0.30), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [gpsAvailable, setGpsAvailable] = useState(null); // null=unknown, true=ok, false=unavailable
  const [gpsPermissionResolved, setGpsPermissionResolved] = useState(false);
  const radarAnims = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;
  const [mapSectionHeight, setMapSectionHeight] = useState(0);
  const sendMsg = (obj) => webRef.current?.postMessage(JSON.stringify(obj));

  /* -------- load petColor on mount -------- */
  useEffect(() => {
    AsyncStorage.getItem('petColor').then(val => {
      if (val && val !== '#f1f5f9' && val !== '#ffffff') setPetColor(val);
    }).catch(() => {});

    const sub = DeviceEventEmitter.addListener('petColorChange', color => setPetColor(color));
    return () => sub.remove();
  }, []);

  /* -------- get initial position once on mount -------- */
  useEffect(() => {
    Geolocation.getCurrentPosition(
      pos => {
        lastKnownPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        setInitialPos(lastKnownPos);
        setGpsAvailable(true);
        setGpsPermissionResolved(true);
      },
      () => {
        setGpsAvailable(false);
        setGpsPermissionResolved(true);
      },
      { enableHighAccuracy: true, timeout: 8000, showLocationDialog: false }
    );
  }, []);

  /* -------- set color on map load -------- */
  useEffect(() => {
    if (!mapReady) return;
    sendMsg({ type: 'setColor', color: petColor });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady]);

  /* -------- replay historical route to map after app-kill restore -------- */
  useEffect(() => {
    if (!mapReady || !sessionRestoredRef.current || mapRouteRestoredRef.current) return;
    if (trackingState === 'tracking' && routeSegments.some(s => s.length > 0)) {
      mapRouteRestoredRef.current = true;
      const segments = routeSegments.map(seg => seg.map(p => [p.longitude, p.latitude]));
      sendMsg({ type: 'restore', segments });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, trackingState, routeSegments]);

  /* -------- update map color when pet color changes -------- */
  useEffect(() => {
    if (mapReady) sendMsg({ type: 'setColor', color: petColor });
  }, [petColor, mapReady]);

  /* -------- idle GPS watch — self-healing: restarts every 5s after an error -------- */
  useEffect(() => {
    if (!mapReady || trackingState !== 'idle' || !gpsPermissionResolved) return;

    let watchId = null;
    let retryTimer = null;
    let active = true;

    const startWatch = () => {
      if (!active) return;
      watchId = Geolocation.watchPosition(
        pos => {
          lastKnownPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          setGpsAvailable(true);
          sendMsg({ type: 'position', lat: pos.coords.latitude, lon: pos.coords.longitude });
        },
        () => {
          setGpsAvailable(false);
          Geolocation.clearWatch(watchId);
          watchId = null;
          retryTimer = setTimeout(startWatch, 2000);
        },
        { enableHighAccuracy: true, distanceFilter: 0, interval: 2000, showLocationDialog: false }
      );
    };

    startWatch();

    return () => {
      active = false;
      if (watchId !== null) Geolocation.clearWatch(watchId);
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [mapReady, trackingState, gpsPermissionResolved]);

  /* -------- radar animation — runs while GPS is unavailable -------- */
  useEffect(() => {
    if (gpsAvailable !== false) {
      radarAnims.forEach(a => a.setValue(0));
      return;
    }
    const DURATION = 2000;
    const animations = radarAnims.map(anim =>
      Animated.loop(Animated.timing(anim, { toValue: 1, duration: DURATION, useNativeDriver: true }))
    );
    animations[0].start();
    const t1 = setTimeout(() => animations[1].start(), DURATION / 3);
    const t2 = setTimeout(() => animations[2].start(), (DURATION / 3) * 2);
    return () => {
      animations.forEach(a => a.stop());
      radarAnims.forEach(a => a.setValue(0));
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [gpsAvailable]); // eslint-disable-line react-hooks/exhaustive-deps

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
      }
    });
    return () => sub.remove();
  }, []);


  /* -------- session duration timer — wall-clock based so background time is included -------- */
  useEffect(() => {
    if (trackingState !== 'tracking') {
      clearInterval(intervalRef.current);
      return;
    }
    const tick = () => {
      if (segmentStartRef.current) {
        setDuration(accumulatedRef.current + Math.floor((Date.now() - segmentStartRef.current) / 1000));
      }
    };
    tick(); // immediate update on state change
    intervalRef.current = setInterval(tick, 1000);
    return () => clearInterval(intervalRef.current);
  }, [trackingState]);

  /* -------- respond to HomeScreen requesting current step count -------- */
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('requestStepUpdate', () => {
      DeviceEventEmitter.emit('stepUpdate', stepsRef.current);
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
          sessionRestoredRef.current = true;
          savedStepsRef.current = bgSteps;
          setSteps(bgSteps);
          setTrackingState('tracking');

          try {
            const routeJson = await StepCounter.getBackgroundRoute();
            const bgRoute = JSON.parse(routeJson).map(p => ({
              latitude: p.lat,
              longitude: p.lng,
            }));
            if (bgRoute.length > 0) setRouteSegments([[...bgRoute]]);
          } catch (e) {}

          // Restore duration from persisted timestamps
          try {
            const durData = await AsyncStorage.getItem('sessionDuration');
            if (durData) {
              const { start, accumulated } = JSON.parse(durData);
              accumulatedRef.current = accumulated || 0;
              // Always set a live segment start so the timer can continue
              segmentStartRef.current = start || Date.now();
              if (!start) {
                // Was paused when killed — resume counting from now
                await AsyncStorage.setItem('sessionDuration', JSON.stringify({ start: segmentStartRef.current, accumulated: accumulatedRef.current }));
              }
              setDuration(accumulatedRef.current + Math.floor((Date.now() - segmentStartRef.current) / 1000));
            }
          } catch (_) {}

          sessionOffsetRef.current = null;
          if (!isSensorStartedRef.current) {
            isSensorStartedRef.current = true;
            StepCounter.startStepCounter();
          }
          watchIdRef.current = startGpsWatch();
        }
      } catch (e) {}
    };
    syncOnMount();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------- recalc duration when app foregrounds (catches background time) -------- */
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && segmentStartRef.current) {
        setDuration(accumulatedRef.current + Math.floor((Date.now() - segmentStartRef.current) / 1000));
      }
    });
    return () => sub.remove();
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
            setSteps(bgSteps);
            // Don't override 'paused' — user explicitly paused, background steps are still counted
            setTrackingState(prev => prev === 'idle' ? 'idle' : prev);
          }
        } catch (e) {}
      }
    });
    return () => sub.remove();
  }, []);

  /* -------- GPS watch helper — shared by start, resume, syncOnMount -------- */
  const startGpsWatch = () => {
    lastGpsPosRef.current = null; // reset on each new watch so first point is always accepted
    return Geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;

        // Drop low-accuracy fixes (cold start, cached network location).
        if (accuracy > 25) return;

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
      () => {},
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
  const saveSession = async (finalSteps, finalRoute, finalSegments, finalDuration) => {
    const _d = new Date();
    const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
    const distance = calcSegmentsDistance(finalSegments);
    const sessionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const session = {
      sessionId,
      steps: finalSteps,
      distance,                    // metres
      route: finalRoute,           // flat — backward compat
      segments: finalSegments,     // array of arrays — used for gap rendering
      duration: finalDuration,     // seconds
      timestamp: Date.now(),
      synced: false,
    };
    try {
      const existing = await AsyncStorage.getItem('activities');
      const parsed = existing ? JSON.parse(existing) : {};
      if (!parsed[today]) parsed[today] = [];
      parsed[today].push(session);
      await AsyncStorage.setItem('activities', JSON.stringify(parsed));
    } catch (e) {}
  };

  /* -------- tracking controls -------- */
  const startTracking = async () => {
    if (!StepCounter) return;
    const granted = await requestAllPermissions();
    if (!granted) return;

    await AsyncStorage.setItem('sessionInProgress', 'true');
    segmentStartRef.current = Date.now();
    accumulatedRef.current = 0;
    setDuration(0);
    await AsyncStorage.setItem('sessionDuration', JSON.stringify({ start: segmentStartRef.current, accumulated: 0 }));
    sessionRestoredRef.current = false;
    mapRouteRestoredRef.current = false;
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
    try { await StepCounter.startBackgroundService(); } catch (e) {}
    setTrackingState('tracking');
  };

  const pauseTracking = () => {
    if (segmentStartRef.current) {
      accumulatedRef.current += Math.floor((Date.now() - segmentStartRef.current) / 1000);
      segmentStartRef.current = null;
      AsyncStorage.setItem('sessionDuration', JSON.stringify({ start: null, accumulated: accumulatedRef.current })).catch(() => {});
    }
    // Stop GPS watch — route stops drawing here
    if (watchIdRef.current != null) {
      Geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    sendMsg({ type: 'pause' });
    setTrackingState('paused');
  };

  const resumeTracking = () => {
    segmentStartRef.current = Date.now();
    AsyncStorage.setItem('sessionDuration', JSON.stringify({ start: segmentStartRef.current, accumulated: accumulatedRef.current })).catch(() => {});
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
    const finalDuration = accumulatedRef.current +
      (segmentStartRef.current ? Math.floor((Date.now() - segmentStartRef.current) / 1000) : 0);
    // Don't litter the calendar with empty entries
    if (steps > 0 || flatRoute.length > 0) {
      await saveSession(steps, flatRoute, routeSegments, finalDuration);
      // Push to Firestore now; failures stay unsynced and get retried on next bulk trigger
      syncSessions().catch(() => {});
    }
    await AsyncStorage.removeItem('sessionDuration');

    if (watchIdRef.current != null) {
      Geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setGpsWaiting(false);

    BleStepService.stopStepTracking();
    isSensorStartedRef.current = false;
    StepCounter.stopStepCounter();
    try { await StepCounter.stopBackgroundService(); } catch (e) {}
    try { await StepCounter.clearSessionData(); } catch (e) {}
    await AsyncStorage.removeItem('sessionInProgress');

    sendMsg({ type: 'finish' }); // map fitBounds to show full route
    setTrackingState('finished');
  };

  const handleDone = () => {
    sendMsg({ type: 'clear' });
    savedStepsRef.current = 0;
    sessionOffsetRef.current = null;
    isFinishingRef.current = false;
    sessionRestoredRef.current = false;
    mapRouteRestoredRef.current = false;
    segmentStartRef.current = null;
    accumulatedRef.current = 0;
    setSteps(0);
    setDuration(0);
    DeviceEventEmitter.emit('sessionFinished');
    setRouteSegments([]);
    setTrackingState('idle');
  };

  /* -------- derived -------- */
  const isFinished = trackingState === 'finished';
  const isActive = trackingState !== 'idle';
  const openLocationSettings = () => {
    if (Platform.OS === 'android') {
      Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS').catch(() => Linking.openSettings());
    } else {
      Linking.openURL('App-Prefs:Privacy&path=LOCATION').catch(() => Linking.openSettings());
    }
  };

  /* -------- render -------- */
  return (
    <View style={styles.container}>

      {/* ── MAP — top half ── */}
      <View style={styles.mapSection} onLayout={e => setMapSectionHeight(e.nativeEvent.layout.height)}>
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

        {/* GPS banner — acquiring fix, pinned to top of screen */}
        {gpsWaiting && (
          <View style={styles.gpsCardTop}>
            <Text style={styles.gpsCardText}>Acquiring GPS…</Text>
            <Text style={styles.gpsCardSubText}>Make sure location is on</Text>
            <TouchableOpacity style={styles.gpsCardBtn} onPress={openLocationSettings} activeOpacity={0.8}>
              <Text style={styles.gpsCardBtnText}>Open Settings</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Radar overlay — shown when location is off */}
        {gpsAvailable === false && mapSectionHeight > 0 && (
          <View pointerEvents="none" style={styles.radarOverlay}>
            <View style={[styles.radarCenter, {
              top: (mapSectionHeight - SCREEN_HEIGHT * 0.30) / 2 - 9,
            }]}>
              {radarAnims.map((anim, i) => (
                <Animated.View key={i} style={[styles.radarRing, {
                  opacity: anim.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0.7, 0.45, 0] }),
                  transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 7] }) }],
                }]} />
              ))}
              <View style={styles.radarDot} />
            </View>
          </View>
        )}

        {/* Location off banner — pinned to top of screen */}
        {!isActive && gpsAvailable === false && (
          <View style={styles.gpsCardTop}>
            <Text style={styles.gpsCardText}>Turn on location for accurate tracking</Text>
            <TouchableOpacity style={styles.gpsCardBtn} onPress={openLocationSettings} activeOpacity={0.8}>
              <Text style={styles.gpsCardBtnText}>Open Settings</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Status badge — only once GPS is acquired */}
        {isActive && !isFinished && !gpsWaiting && (
          <View style={[styles.statusBadge, trackingState === 'paused' && styles.statusBadgePaused]}>
            <View style={[styles.statusDot, trackingState === 'paused' && styles.statusDotPaused]} />
            <Text style={[styles.statusText, trackingState === 'paused' && styles.statusTextPaused]}>
              {trackingState === 'tracking' ? 'tracking' : 'paused'}
            </Text>
          </View>
        )}
      </View>

      {/* ── STATS — floating panel over map bottom ── */}
      <View style={styles.statsSection}>

        {/* Gradient: transparent top → white bottom */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {Array.from({ length: 20 }, (_, i) => (
            <View key={i} style={{ flex: 1, backgroundColor: `rgba(255,255,255,${(i / 19) * 0.97})` }} />
          ))}
        </View>

        {/* Steps + meta grouped so they sit close together */}
        <View style={styles.stepsGroup}>
          <View style={styles.stepsBlock}>
            <Text style={styles.stepsNumber}>{steps.toLocaleString()}</Text>
            <Text style={styles.stepsLabel}>steps</Text>
          </View>

          {/* Distance + Duration row */}
          <View style={styles.metaRow}>
            <View style={styles.metaItem}>
              <Text style={styles.metaValue}>{displayDistance(calcSegmentsDistance(routeSegments))}</Text>
              <Text style={styles.metaLabel}>distance</Text>
            </View>
            <View style={styles.metaDivider} />
            <View style={styles.metaItem}>
              <Text style={styles.metaValue}>{formatDuration(duration)}</Text>
              <Text style={styles.metaLabel}>duration</Text>
            </View>
          </View>
        </View>

        {/* Finished row */}
        {isFinished && (
          <View style={styles.finishedRow}>
            <TouchableOpacity style={styles.doneBtn} onPress={handleDone} activeOpacity={0.8}>
              <Text style={styles.doneBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Controls */}
        {trackingState === 'idle' && (
          <TouchableOpacity
            style={[styles.startBtn, gpsAvailable === false && styles.startBtnDisabled]}
            onPress={gpsAvailable === false ? undefined : startTracking}
            activeOpacity={gpsAvailable === false ? 1 : 0.85}
          >
            <Text style={styles.startBtnIcon}>▶</Text>
          </TouchableOpacity>
        )}

        {trackingState === 'tracking' && (
          <View style={styles.controlRow}>
            <TouchableOpacity style={styles.controlBtn} onPress={pauseTracking} activeOpacity={0.8}>
              <Text style={styles.controlBtnIcon}>⏸</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.controlBtn} onPress={finishTracking} activeOpacity={0.8}>
              <Text style={styles.controlBtnIcon}>⏹</Text>
            </TouchableOpacity>
          </View>
        )}

        {trackingState === 'paused' && (
          <View style={styles.controlRow}>
            <TouchableOpacity style={styles.controlBtn} onPress={resumeTracking} activeOpacity={0.8}>
              <Text style={styles.controlBtnIcon}>▶</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.controlBtn} onPress={finishTracking} activeOpacity={0.8}>
              <Text style={styles.controlBtnIcon}>⏹</Text>
            </TouchableOpacity>
          </View>
        )}

      </View>

    </View>
  );
}

/* -------------------- STYLES -------------------- */

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

const C = {
  bg:      '#f8fafc',
  surface: '#ffffff',
  border:  '#e2e8f0',
  text:    '#0f172a',
  text2:   '#475569',
  text3:   '#94a3b8',
  success: '#059669',
  warning: '#d97706',
  danger:  '#dc2626',
};

const styles = StyleSheet.create({
  container: { flex: 1 },

  /* Map — full screen background */
  mapSection: {
    ...StyleSheet.absoluteFillObject,
  },
  statusBadge: {
    position: 'absolute',
    top: 16,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.90)',
    borderWidth: 1,
    borderColor: 'rgba(5,150,105,0.35)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
    gap: 7,
  },
  statusBadgePaused: {
    borderColor: 'rgba(217,119,6,0.35)',
  },
  statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.success },
  statusDotPaused: { backgroundColor: C.warning },
  statusText: { fontSize: 11, fontWeight: '700', color: C.success, letterSpacing: 0.5 },
  statusTextPaused: { color: C.warning },

  radarOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  radarCenter: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radarRing: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: '#2563eb',
  },
  radarDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#2563eb',
  },

  /* GPS banner — acquiring fix, pinned to top of screen */
  gpsCardTop: {
    position: 'absolute',
    top: 8,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    gap: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 4,
    zIndex: 10,
  },

  /* GPS card — location off, in normal flow */
  gpsCard: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  gpsCardText: { fontSize: 13, fontWeight: '600', color: '#0f172a', textAlign: 'center' },
  gpsCardSubText: { fontSize: 12, color: '#64748b', textAlign: 'center' },
  gpsCardBtn: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 10,
    marginTop: 2,
  },
  gpsCardBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  /* Stats — floating panel over bottom of map */
  statsSection: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: SCREEN_HEIGHT * 0.50,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 28,
    paddingBottom: 28,
    gap: 16,
  },
  stepsGroup: { alignItems: 'center', width: '100%', gap: 10 },
  stepsBlock: { alignItems: 'center' },
  stepsNumber: { fontSize: 72, fontWeight: '700', color: C.text, letterSpacing: -2 },
  stepsLabel: { fontSize: 12, fontWeight: '500', color: C.text3, marginTop: 2 },

  /* Distance + Duration row */
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', width: '100%' },
  metaItem: { flex: 1, alignItems: 'center' },
  metaDivider: { width: 1, height: 32, backgroundColor: C.border },
  metaValue: { fontSize: 22, fontWeight: '700', color: C.text },
  metaLabel: { fontSize: 11, fontWeight: '500', color: C.text3, marginTop: 3 },

  /* Finished */
  finishedRow: { alignItems: 'center' },
  doneBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneBtnText: { color: '#fff', fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },

  /* Start button — large black circle */
  startBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 4,
  },
  startBtnIcon: { fontSize: 26, color: '#fff', marginLeft: 4 },
  startBtnDisabled: { backgroundColor: '#94a3b8', shadowOpacity: 0 },

  /* Pause / Resume / Finish — unified black circles */
  controlRow: { flexDirection: 'row', gap: 24, justifyContent: 'center' },
  controlBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 3,
  },
  controlBtnIcon: { fontSize: 24, color: '#fff' },
});

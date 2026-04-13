import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  NativeModules, AppState, Modal, Dimensions, Alert, Linking, Platform,
} from 'react-native';
import Svg, { Polyline, Rect, Circle } from 'react-native-svg';
import { WebView } from 'react-native-webview';
import Geolocation from 'react-native-geolocation-service';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildMapboxHTML } from './mapboxHtml';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

/* -------------------- HELPERS -------------------- */

function haversineDistance(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const R = 6371000;
    const φ1 = points[i-1].latitude * Math.PI / 180;
    const φ2 = points[i].latitude   * Math.PI / 180;
    const Δφ = (points[i].latitude  - points[i-1].latitude)  * Math.PI / 180;
    const Δλ = (points[i].longitude - points[i-1].longitude) * Math.PI / 180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    total += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }
  return total;
}

function calcSegmentsDistance(segments) {
  return segments.reduce((sum, seg) => sum + haversineDistance(seg), 0);
}

function formatDistance(metres) {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(2)} km`;
}

/* -------------------- FINISH MODAL -------------------- */

function projectAndNormalize(segments, w, h, padding = 24) {
  const allRaw = segments.flat();
  if (allRaw.length < 2) return [];
  const base = allRaw[0];
  const world = allRaw.map(p => ({
    x:  (p.longitude - base.longitude) * 100000,
    y: -(p.latitude  - base.latitude)  * 100000,
  }));
  const xs = world.map(p => p.x); const ys = world.map(p => p.y);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const scale = Math.min((w - padding*2) / (maxX - minX || 1), (h - padding*2) / (maxY - minY || 1));
  const ox = (w - (maxX - minX) * scale) / 2;
  const oy = (h - (maxY - minY) * scale) / 2;
  let offset = 0;
  return segments.map(seg => {
    const slice = world.slice(offset, offset + seg.length);
    offset += seg.length;
    return slice.map(p => ({ x: ox + (p.x - minX) * scale, y: oy + (p.y - minY) * scale }));
  });
}

function FinishModal({ visible, routeSegments, routeColor = '#EE5514', onClose }) {
  const w = SCREEN_WIDTH - 80;
  const h = 220;
  const segs = projectAndNormalize(routeSegments, w, h);
  const allPts = segs.flat();
  const first = allPts[0];
  const last  = allPts[allPts.length - 1];
  const distanceMetres = calcSegmentsDistance(routeSegments);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={ms.overlay}>
        <View style={ms.sheet}>
          <Text style={ms.title}>Session Complete</Text>
          {allPts.length >= 2 && (
            <View style={ms.routeWrapper}>
              <Svg width={w} height={h}>
                <Rect x="0" y="0" width={w} height={h} rx="16" fill="#f8fafc" />
                {segs.map((seg, i) => seg.length < 2 ? null : (
                  <Polyline key={i} points={seg.map(p => `${p.x},${p.y}`).join(' ')}
                    fill="none" stroke={routeColor} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                ))}
                {first && <Circle cx={first.x} cy={first.y} r="4" fill="#034dd8" />}
                {last  && <Circle cx={last.x}  cy={last.y}  r="6" fill="#0098e9" />}
              </Svg>
            </View>
          )}
          {distanceMetres > 0 && (
            <View style={ms.statsRow}>
              <View style={ms.statBox}>
                <Text style={ms.statValue}>{formatDistance(distanceMetres)}</Text>
                <Text style={ms.statLabel}>Distance</Text>
              </View>
            </View>
          )}
          <TouchableOpacity style={ms.doneBtn} onPress={onClose}>
            <Text style={ms.doneBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

/* -------------------- MAIN -------------------- */

export default function MapTestScreen({ isActive: tabActive = false }) {
  const webRef = useRef(null);
  const [initialPos, setInitialPos] = useState({ lat: 19.076, lon: 72.877 });
  const [mapReady, setMapReady] = useState(false);
  const [trackingState, setTrackingState] = useState('idle');
  const [routeSegments, setRouteSegments] = useState([]);
  const [summaryVisible, setSummaryVisible] = useState(false);
  const [gpsWaiting, setGpsWaiting] = useState(false);
  const [petColor, setPetColor] = useState('#EE5514');
  const watchIdRef = useRef(null);
  const lastPosRef = useRef(null);
  const isFinishingRef = useRef(false);

  const sendMsg = (obj) => webRef.current?.postMessage(JSON.stringify(obj));

  // Get initial position for map center
  useEffect(() => {
    Geolocation.getCurrentPosition(
      pos => setInitialPos({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, timeout: 8000 }
    );
    AsyncStorage.getItem('petColor').then(val => {
      if (val && val !== '#f1f5f9' && val !== '#ffffff') setPetColor(val);
    }).catch(() => {});
  }, []);

  // Resize map when tab becomes visible
  useEffect(() => {
    if (tabActive && mapReady) sendMsg({ type: 'resize' });
  }, [tabActive]);

  // Send route color whenever map is ready or color changes
  useEffect(() => {
    if (mapReady) sendMsg({ type: 'setColor', color: petColor });
  }, [mapReady, petColor]);

  const startGpsWatch = () => {
    if (watchIdRef.current != null) return;
    lastPosRef.current = null;
    watchIdRef.current = Geolocation.watchPosition(
      pos => {
        const { latitude: lat, longitude: lon } = pos.coords;
        if (lastPosRef.current) {
          const dLat = lat - lastPosRef.current.lat;
          const dLon = lon - lastPosRef.current.lon;
          if (Math.sqrt(dLat*dLat + dLon*dLon) * 111000 > 150) {
            lastPosRef.current = { lat, lon };
            return;
          }
        }
        lastPosRef.current = { lat, lon };
        setGpsWaiting(false);
        sendMsg({ type: 'position', lat, lon });
        setRouteSegments(prev => {
          if (!prev.length) return prev;
          const updated = [...prev];
          let last = [...updated[updated.length - 1]];
          last.push({ latitude: lat, longitude: lon });
          updated[updated.length - 1] = last;
          return updated;
        });
      },
      err => {
        if (err.code === 2) {
          stopGpsWatch();
          setGpsWaiting(true);
          setTrackingState(prev => {
            if (prev === 'tracking') {
              sendMsg({ type: 'pause' });
              return 'paused';
            }
            return prev;
          });
        }
      },
      { enableHighAccuracy: true, distanceFilter: 2, interval: 1500, fastestInterval: 750 }
    );
  };

  const stopGpsWatch = () => {
    if (watchIdRef.current != null) {
      Geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  };

  // Always stream position so dot moves even when idle
  useEffect(() => {
    if (!mapReady) return;
    const idleId = Geolocation.watchPosition(
      pos => sendMsg({ type: 'position', lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, distanceFilter: 2, interval: 2000 }
    );
    return () => Geolocation.clearWatch(idleId);
  }, [mapReady]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active' && mapReady) startGpsWatch();
    });
    return () => sub.remove();
  }, [mapReady]);

  const handleStart = () => {
    Geolocation.getCurrentPosition(
      () => {
        setRouteSegments([[]]);
        sendMsg({ type: 'start' });
        setGpsWaiting(true);
        startGpsWatch();
        setTrackingState('tracking');
      },
      err => {
        const msg = err.code === 1
          ? 'Location permission is required to start tracking.'
          : 'Please enable location services to start tracking.';
        Alert.alert('Location Required', msg, [{ text: 'OK' }]);
      },
      { enableHighAccuracy: false, timeout: 4000 }
    );
  };

  const handlePause = () => {
    stopGpsWatch();
    sendMsg({ type: 'pause' });
    setTrackingState('paused');
  };

  const handleResume = () => {
    setRouteSegments(prev => [...prev, []]);
    sendMsg({ type: 'resume' });
    setGpsWaiting(true);
    startGpsWatch();
    setTrackingState('tracking');
  };

  const handleFinish = () => {
    if (isFinishingRef.current) return;
    isFinishingRef.current = true;
    stopGpsWatch();
    setGpsWaiting(false);
    sendMsg({ type: 'finish' });
    setTrackingState('idle');
    setSummaryVisible(true);
  };

  const handleClose = () => {
    setSummaryVisible(false);
    isFinishingRef.current = false;
    setRouteSegments([]);
    sendMsg({ type: 'clear' });
  };

  return (
    <View style={styles.container}>
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html: buildMapboxHTML(initialPos.lat, initialPos.lon, petColor) }}
        style={StyleSheet.absoluteFill}
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

      {/* Status pill */}
      {trackingState !== 'idle' && (
        <View style={[styles.statusPill, trackingState === 'paused' && styles.statusPillPaused]}>
          <View style={[styles.statusDot, trackingState === 'paused' && styles.statusDotPaused]} />
          <Text style={[styles.statusText, trackingState === 'paused' && styles.statusTextPaused]}>
            {trackingState === 'tracking' ? 'TRACKING' : 'PAUSED'}
          </Text>
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

      {/* Controls */}
      <View style={styles.controls}>
        {trackingState === 'idle' && (
          <TouchableOpacity style={[styles.btn, styles.btnStart]} onPress={handleStart} activeOpacity={0.8}>
            <Text style={styles.btnText}>START</Text>
          </TouchableOpacity>
        )}
        {trackingState === 'tracking' && (
          <>
            <TouchableOpacity style={[styles.btn, styles.btnPause]} onPress={handlePause} activeOpacity={0.8}>
              <Text style={styles.btnText}>PAUSE</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnFinish]} onPress={handleFinish} activeOpacity={0.8}>
              <Text style={styles.btnText}>FINISH</Text>
            </TouchableOpacity>
          </>
        )}
        {trackingState === 'paused' && (
          <>
            <TouchableOpacity style={[styles.btn, styles.btnStart]} onPress={handleResume} activeOpacity={0.8}>
              <Text style={styles.btnText}>RESUME</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnFinish]} onPress={handleFinish} activeOpacity={0.8}>
              <Text style={styles.btnText}>FINISH</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      <FinishModal
        visible={summaryVisible}
        routeSegments={routeSegments}
        routeColor={petColor}
        onClose={handleClose}
      />
    </View>
  );
}

/* -------------------- STYLES -------------------- */

const styles = StyleSheet.create({
  container: { flex: 1 },

  controls: {
    position: 'absolute',
    bottom: 32, left: 20, right: 20,
    flexDirection: 'row',
    gap: 10,
  },
  btn: {
    flex: 1, paddingVertical: 16, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.18, shadowRadius: 6, elevation: 5,
  },
  btnStart:  { backgroundColor: '#059669' },
  btnPause:  { backgroundColor: '#d97706' },
  btnFinish: { backgroundColor: '#dc2626' },
  btnText: { color: '#fff', fontSize: 13, fontWeight: '800', textTransform: 'uppercase' },

  gpsBanner: {
    position: 'absolute',
    bottom: 110, left: 20, right: 20,
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 14, paddingHorizontal: 18,
    alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12, shadowRadius: 8, elevation: 6,
    gap: 4,
  },
  gpsBannerTitle: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  gpsBannerSub: { fontSize: 11, color: '#94a3b8', marginBottom: 8 },
  gpsBannerBtn: {
    backgroundColor: '#0f172a', borderRadius: 10,
    paddingVertical: 10, paddingHorizontal: 20,
  },
  gpsBannerBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  statusPill: {
    position: 'absolute', top: 16,
    alignSelf: 'center', left: '50%',
    transform: [{ translateX: -55 }],
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#dcfce7', borderRadius: 20,
    paddingHorizontal: 14, paddingVertical: 6, gap: 7,
  },
  statusPillPaused: { backgroundColor: '#fef3c7' },
  statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#059669' },
  statusDotPaused: { backgroundColor: '#d97706' },
  statusText: { fontSize: 11, fontWeight: '700', color: '#059669', textTransform: 'uppercase' },
  statusTextPaused: { color: '#d97706' },
});

const ms = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingTop: 28, paddingHorizontal: 24, paddingBottom: 44, alignItems: 'center',
  },
  title: { fontSize: 13, fontWeight: '800', color: '#0f172a', textTransform: 'uppercase', marginBottom: 20 },
  routeWrapper: { width: '100%', alignItems: 'center', marginBottom: 24 },
  statsRow: { flexDirection: 'row', gap: 40, marginBottom: 20 },
  statBox: { alignItems: 'center' },
  statValue: { fontSize: 42, fontWeight: '900', color: '#0f172a' },
  statLabel: { fontSize: 11, color: '#94a3b8', fontWeight: '600', textTransform: 'uppercase', marginTop: 4 },
  doneBtn: { backgroundColor: '#0f172a', paddingVertical: 16, paddingHorizontal: 56, borderRadius: 14 },
  doneBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
});

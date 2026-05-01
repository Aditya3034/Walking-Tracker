import React, { useEffect, useRef, useState, useMemo } from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet, Dimensions, DeviceEventEmitter } from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildMapboxHTML } from './mapboxHtml';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

function formatDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function formatDistance(metres) {
  if (!metres) return '—';
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(2)} km`;
}

export default function SessionDetailModal({ visible, session, onClose }) {
  const webRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);
  const [petColor, setPetColor] = useState('#EE5514');

  // Load pet color (swatch) and react to live changes
  useEffect(() => {
    AsyncStorage.getItem('petColor').then(val => { if (val) setPetColor(val); }).catch(() => {});
    const sub = DeviceEventEmitter.addListener('petColorChange', (c) => setPetColor(c));
    return () => sub.remove();
  }, []);

  // Reset readiness when session changes — forces fresh route inject
  useEffect(() => {
    setMapReady(false);
  }, [session?.sessionId]);

  // Pick a starting centre from the first GPS point we have
  const firstPoint = useMemo(() => {
    if (session?.segments?.length > 0) {
      const seg = session.segments.find(s => s.length > 0);
      return seg ? { lat: seg[0].latitude, lon: seg[0].longitude } : null;
    }
    if (session?.route?.length > 0) {
      return { lat: session.route[0].latitude, lon: session.route[0].longitude };
    }
    return null;
  }, [session?.sessionId]);

  const mapHtml = useMemo(() => firstPoint
    ? buildMapboxHTML(firstPoint.lat, firstPoint.lon, petColor, 0)
    : null,
    [firstPoint, petColor]);

  const source = useMemo(() => mapHtml ? { html: mapHtml } : null, [mapHtml]);

  // When map loads, inject the route data
  useEffect(() => {
    if (!mapReady || !session) return;
    const segments = session.segments && session.segments.length > 0
      ? session.segments.map(seg => seg.map(p => [p.longitude, p.latitude]))
      : [(session.route || []).map(p => [p.longitude, p.latitude])];
    const filtered = segments.filter(s => s.length > 1);
    const segJson = JSON.stringify(filtered);

    const trySetRoute = `
      (function tryDraw(attempt) {
        if (attempt > 60) return;
        if (!window.map || !window.map.isStyleLoaded() || !window.map.getSource('route')) {
          setTimeout(function(){tryDraw(attempt+1)}, 100); return;
        }
        var segs = ${segJson};
        window.allCoords = segs;
        window.map.getSource('route').setData({
          type: 'Feature',
          geometry: { type: 'MultiLineString', coordinates: segs }
        });
        if (segs.length > 0) {
          var flat = segs.reduce(function(a,b){return a.concat(b);}, []);
          if (flat.length > 1) {
            var lngs = flat.map(function(c){return c[0];});
            var lats = flat.map(function(c){return c[1];});
            window.map.fitBounds(
              [[Math.min.apply(null,lngs), Math.min.apply(null,lats)],
               [Math.max.apply(null,lngs), Math.max.apply(null,lats)]],
              { padding: 40, duration: 0 }
            );
          }
        }
      })(0);
      true;
    `;
    webRef.current?.injectJavaScript(trySetRoute);
  }, [mapReady, session]);


  if (!session) return null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.mapWrap}>
          {source ? (
            <WebView
              key={session.sessionId}
              ref={webRef}
              originWhitelist={['*']}
              source={source}
              style={{ flex: 1 }}
              javaScriptEnabled
              domStorageEnabled
              cacheEnabled
              mixedContentMode="always"
              onLoadEnd={() => setMapReady(true)}
              scrollEnabled={false}
            />
          ) : (
            <View style={styles.noRoute}>
              <Text style={styles.noRouteText}>No route recorded for this walk</Text>
            </View>
          )}
        </View>

        <View style={styles.stats}>
          <Stat label="Steps" value={session.steps?.toLocaleString() || '0'} />
          <Stat label="Distance" value={formatDistance(session.distance)} />
          <Stat label="Duration" value={formatDuration(session.duration || 0)} />
        </View>

        <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.85}>
          <Text style={styles.closeBtnText}>Close</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

function Stat({ label, value }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  mapWrap: { height: SCREEN_HEIGHT * 0.6, backgroundColor: '#f1f5f9' },
  noRoute: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  noRouteText: { fontSize: 13, color: '#94a3b8' },
  stats: {
    flexDirection: 'row',
    paddingVertical: 24,
    paddingHorizontal: 28,
    gap: 16,
    justifyContent: 'space-between',
  },
  stat: { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 22, fontWeight: '800', color: '#0f172a' },
  statLabel: { fontSize: 11, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  closeBtn: {
    margin: 24,
    backgroundColor: '#0f172a',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  closeBtnText: { color: '#fff', fontSize: 14, fontWeight: '700', letterSpacing: 0.5 },
});

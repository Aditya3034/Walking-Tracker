import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated,
  Dimensions, Platform, Image, PanResponder, AppState,
} from 'react-native';
import { request, requestMultiple, check, openSettings, PERMISSIONS, RESULTS } from 'react-native-permissions';
import Feather from 'react-native-vector-icons/Feather';
import Svg, { Path } from 'react-native-svg';

const AnimatedPath = Animated.createAnimatedComponent(Path);

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const PERMS = Platform.OS === 'android' ? {
  BLE:      Platform.Version >= 31 ? [PERMISSIONS.ANDROID.BLUETOOTH_SCAN, PERMISSIONS.ANDROID.BLUETOOTH_CONNECT] : [PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION],
  LOCATION: [PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION],
  ACTIVITY: [PERMISSIONS.ANDROID.ACTIVITY_RECOGNITION],
} : {
  BLE:      [PERMISSIONS.IOS.BLUETOOTH],
  LOCATION: [PERMISSIONS.IOS.LOCATION_WHEN_IN_USE],
  ACTIVITY: [PERMISSIONS.IOS.MOTION],
};

const SCREENS = [
  {
    glyph: '⌬',
    accent: '#2563eb',
    title: 'Connect to your pet',
    body:  'Bluetooth lets the app find your pet, sync hunger and steps, and feed it from anywhere in the house.',
    perms: PERMS.BLE,
    interactive: true,
    variant: 'connect',
    hint:    'Slide to connect',
  },
  {
    glyph: '◎',
    accent: '#16a34a',
    title: 'Track your walks',
    body:  'Precise location records the route of every walk so you can see where you went on a map.',
    perms: PERMS.LOCATION,
    interactive: true,
    variant: 'route',
    hint:    'Trace the route',
  },
  {
    glyph: '⬆',
    accent: '#ea580c',
    title: 'Count your steps',
    body:  'Physical activity lets the app count your steps in the background — even when your phone is locked.',
    perms: PERMS.ACTIVITY,
    interactive: true,
    variant: 'step',
    hint:    'Tap 3 times to start counting',
  },
];

/* ============================================================
   Route slider — wavy curve between two waypoint dots; handle follows the curve
   ============================================================ */
const ROUTE_HEIGHT = 90;
const ROUTE_PAD_X  = 18;
const ROUTE_HANDLE = 30;

function buildRoutePoints(width) {
  const inner = Math.max(0, width - ROUTE_PAD_X * 2);
  const midY = ROUTE_HEIGHT / 2;
  const amp  = ROUTE_HEIGHT * 0.32;
  // Hand-tuned multi-bend curve (not pure sine — feels more route-like)
  const N = 80;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = ROUTE_PAD_X + t * inner;
    const wave =
      Math.sin(t * Math.PI * 2.3) * 0.55 +
      Math.sin(t * Math.PI * 5.1 + 0.4) * 0.28 +
      Math.sin(t * Math.PI * 1.1 + 1.2) * 0.30;
    const y = midY + amp * wave * 0.85;
    pts.push({ x, y });
  }
  // Snap endpoints to midY so the dots sit exactly on the path ends
  pts[0].y = midY;
  pts[pts.length - 1].y = midY;
  return pts;
}

function pointsToPathD(pts) {
  if (pts.length === 0) return '';
  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x.toFixed(2)} ${pts[i].y.toFixed(2)}`;
  return d;
}

function totalLengthOf(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i-1].x;
    const dy = pts[i].y - pts[i-1].y;
    l += Math.sqrt(dx*dx + dy*dy);
  }
  return l;
}

function RouteSlider({ onTrigger, accent }) {
  const [containerWidth, setContainerWidth] = useState(0);
  const containerWidthRef = useRef(0);

  // Progress as 0..1
  const progress = useRef(new Animated.Value(0)).current;
  const progressValue = useRef(0);
  const grantOffset = useRef(0);
  const completed = useRef(false);

  // Keep latest onTrigger in a ref — PanResponder is created once and would otherwise capture a stale closure
  const onTriggerRef = useRef(onTrigger);
  useEffect(() => { onTriggerRef.current = onTrigger; }, [onTrigger]);

  useEffect(() => {
    const id = progress.addListener(({ value }) => { progressValue.current = value; });
    return () => progress.removeListener(id);
  }, [progress]);

  const points = useMemo(() => buildRoutePoints(containerWidth || 280), [containerWidth]);
  const pathD = useMemo(() => pointsToPathD(points), [points]);
  const totalLen = useMemo(() => totalLengthOf(points), [points]);

  // Sample for handle position interpolation
  const SAMPLES = 40;
  const { inputRange, xRange, yRange } = useMemo(() => {
    const inp = [], xs = [], ys = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      inp.push(t);
      const p = points[Math.round(t * (points.length - 1))];
      xs.push(p.x - ROUTE_HANDLE / 2);
      ys.push(p.y - ROUTE_HANDLE / 2);
    }
    return { inputRange: inp, xRange: xs, yRange: ys };
  }, [points]);

  const translateX = progress.interpolate({ inputRange, outputRange: xRange });
  const translateY = progress.interpolate({ inputRange, outputRange: yRange });
  const dashOffset = progress.interpolate({ inputRange: [0, 1], outputRange: [totalLen, 0] });

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !completed.current,
      onMoveShouldSetPanResponder: () => !completed.current,
      onPanResponderGrant: () => {
        grantOffset.current = progressValue.current;
        progress.setOffset(progressValue.current);
        progress.setValue(0);
      },
      onPanResponderMove: (_, g) => {
        const w = containerWidthRef.current;
        if (w === 0) return;
        const usable = Math.max(1, w - ROUTE_PAD_X * 2);
        const dxAsProgress = g.dx / usable;
        const clamped = Math.max(-grantOffset.current, Math.min(dxAsProgress, 1 - grantOffset.current));
        progress.setValue(clamped);
      },
      onPanResponderRelease: () => {
        progress.flattenOffset();
        if (progressValue.current >= 0.85) {
          completed.current = true;
          Animated.timing(progress, { toValue: 1, duration: 120, useNativeDriver: false }).start(() => {
            onTriggerRef.current?.();
          });
        } else {
          Animated.spring(progress, { toValue: 0, useNativeDriver: false, friction: 7 }).start();
        }
      },
    })
  ).current;

  const startX = points[0]?.x || 0;
  const endX   = points[points.length - 1]?.x || 0;
  const midY   = ROUTE_HEIGHT / 2;

  return (
    <View
      style={routeStyles.container}
      onLayout={e => {
        const w = e.nativeEvent.layout.width;
        containerWidthRef.current = w;
        setContainerWidth(w);
      }}
    >
      {containerWidth > 0 && (
        <>
          <Svg width={containerWidth} height={ROUTE_HEIGHT}>
            <Path
              d={pathD}
              stroke="#cbd5e1"
              strokeWidth={6}
              strokeLinecap="round"
              strokeDasharray="6,9"
              fill="none"
            />
            <AnimatedPath
              d={pathD}
              stroke={accent}
              strokeWidth={6}
              strokeLinecap="round"
              fill="none"
              strokeDasharray={totalLen}
              strokeDashoffset={dashOffset}
            />
          </Svg>

          {/* Endpoint dots */}
          <View style={[routeStyles.dot, { left: startX - 11, top: midY - 11, borderColor: accent }]}>
            <View style={[routeStyles.dotInner, { backgroundColor: accent }]} />
          </View>
          <View style={[routeStyles.dot, { left: endX - 11, top: midY - 11, borderColor: accent }]}>
            <View style={[routeStyles.dotInner, { backgroundColor: accent }]} />
          </View>

          {/* Draggable handle */}
          <Animated.View
            {...responder.panHandlers}
            style={[
              routeStyles.handle,
              {
                backgroundColor: accent,
                transform: [{ translateX }, { translateY }],
              },
            ]}
          />
        </>
      )}
    </View>
  );
}

const routeStyles = StyleSheet.create({
  container: {
    width: '100%',
    height: ROUTE_HEIGHT,
  },
  dot: {
    position: 'absolute',
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2,
    backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  dotInner: { width: 8, height: 8, borderRadius: 4 },
  handle: {
    position: 'absolute',
    width: ROUTE_HANDLE, height: ROUTE_HANDLE, borderRadius: ROUTE_HANDLE / 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.22,
    shadowRadius: 5,
    elevation: 4,
  },
});

/* ============================================================
   Step tapper — press [+] three times; progress bar fills, then trigger.
   ============================================================ */
function StepTapper({ onTrigger, accent }) {
  const TARGET = 3;
  const [count, setCount] = useState(0);
  const completed = useRef(false);
  const progress = useRef(new Animated.Value(0)).current;
  const numberScale = useRef(new Animated.Value(1)).current;

  const handleTap = () => {
    if (completed.current || count >= TARGET) return;
    const next = count + 1;
    setCount(next);

    Animated.timing(progress, {
      toValue: next / TARGET,
      duration: 260,
      useNativeDriver: false,
    }).start();

    Animated.sequence([
      Animated.timing(numberScale, { toValue: 1.25, duration: 90,  useNativeDriver: true }),
      Animated.timing(numberScale, { toValue: 1,    duration: 130, useNativeDriver: true }),
    ]).start();

    if (next >= TARGET) {
      completed.current = true;
      setTimeout(() => onTrigger?.(), 220);
    }
  };

  const numberColor = count === 0 ? '#94a3b8' : accent;
  const fillWidth = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View style={tapperStyles.container}>
      <View style={tapperStyles.row}>
        <Animated.Text
          style={[
            tapperStyles.number,
            { color: numberColor, transform: [{ scale: numberScale }] },
          ]}
        >
          {count}
        </Animated.Text>
        <TouchableOpacity
          style={[tapperStyles.plusBtn, { backgroundColor: accent }]}
          onPress={handleTap}
          activeOpacity={0.75}
        >
          <Feather name="plus" size={18} color="#fff" />
        </TouchableOpacity>
      </View>

      <View style={tapperStyles.progressTrack}>
        <Animated.View
          style={[tapperStyles.progressFill, { backgroundColor: accent, width: fillWidth }]}
        />
      </View>
    </View>
  );
}

const tapperStyles = StyleSheet.create({
  container: {
    width: '100%',
    alignItems: 'center',
    gap: 18,
    paddingHorizontal: 24,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 22,
  },
  number: {
    fontSize: 72,
    fontWeight: '800',
    letterSpacing: -2,
    minWidth: 72,
    textAlign: 'right',
  },
  plusBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 4,
    elevation: 3,
  },
  progressTrack: {
    width: '70%',
    height: 6,
    borderRadius: 3,
    backgroundColor: '#e2e8f0',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
});

/* Slide-to-connect: drag the handle from pet → phone to trigger BLE permission */
function SlideToConnect({ onTrigger, accent, variant = 'connect' }) {
  if (variant === 'route') {
    return <RouteSlider onTrigger={onTrigger} accent={accent} />;
  }
  if (variant === 'step') {
    return <StepTapper onTrigger={onTrigger} accent={accent} />;
  }
  const trackWidthRef = useRef(0);
  const pan = useRef(new Animated.Value(0)).current;
  const panValue = useRef(0);          // live displayed value (offset + value)
  const grantOffset = useRef(0);       // snapshot of displayed value at gesture start
  const completed = useRef(false);
  const HANDLE = 36;

  const onTriggerRef = useRef(onTrigger);
  useEffect(() => { onTriggerRef.current = onTrigger; }, [onTrigger]);

  useEffect(() => {
    const id = pan.addListener(({ value }) => { panValue.current = value; });
    return () => pan.removeListener(id);
  }, [pan]);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !completed.current,
      onMoveShouldSetPanResponder: () => !completed.current,
      onPanResponderGrant: () => {
        grantOffset.current = panValue.current;
        pan.setOffset(panValue.current);
        pan.setValue(0);
      },
      onPanResponderMove: (_, g) => {
        const maxOffset = Math.max(0, trackWidthRef.current - HANDLE);
        // we want grantOffset + g.dx in [0, maxOffset]
        const clampedDx = Math.max(-grantOffset.current, Math.min(g.dx, maxOffset - grantOffset.current));
        pan.setValue(clampedDx);
      },
      onPanResponderRelease: () => {
        pan.flattenOffset();
        const maxOffset = Math.max(0, trackWidthRef.current - HANDLE);
        if (maxOffset > 0 && panValue.current >= maxOffset * 0.85) {
          completed.current = true;
          Animated.timing(pan, { toValue: maxOffset, duration: 120, useNativeDriver: false }).start(() => {
            onTriggerRef.current?.();
          });
        } else {
          Animated.spring(pan, { toValue: 0, useNativeDriver: false, friction: 7 }).start();
        }
      },
    })
  ).current;

  return (
    <View style={slideStyles.row}>
      <View style={[slideStyles.node, { borderColor: `${accent}55` }]}>
        <Image source={require('./assets/swlogo.png')} style={slideStyles.logo} resizeMode="cover" />
      </View>

      <View
        style={slideStyles.track}
        onLayout={e => {
          trackWidthRef.current = e.nativeEvent.layout.width;
        }}
      >
        <Animated.View
          style={[
            slideStyles.fill,
            { width: Animated.add(pan, new Animated.Value(HANDLE / 2)), backgroundColor: accent },
          ]}
        />
        <Animated.View
          {...responder.panHandlers}
          style={[
            slideStyles.handle,
            { backgroundColor: accent, transform: [{ translateX: pan }] },
          ]}
        >
          <Feather name="chevron-right" size={18} color="#fff" />
        </Animated.View>
      </View>

      <View style={[slideStyles.node, { borderColor: `${accent}55` }]}>
        <Feather name="smartphone" size={26} color={accent} />
      </View>
    </View>
  );
}

const slideStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    paddingHorizontal: 8,
  },
  node: {
    width: 56, height: 56, borderRadius: 14,
    backgroundColor: '#fff',
    borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  logo: { width: 36, height: 36 },
  track: {
    flex: 1,
    height: 6,
    backgroundColor: '#e2e8f0',
    borderRadius: 3,
    marginHorizontal: 6,
    justifyContent: 'center',
    overflow: 'visible',
  },
  fill: {
    position: 'absolute',
    left: 0, top: 0, bottom: 0,
    borderRadius: 3,
  },
  handle: {
    position: 'absolute',
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    top: -15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 4,
    elevation: 3,
  },
});

const isGranted = (r) => r === RESULTS.GRANTED || r === RESULTS.LIMITED;
const isBlocked = (r) => r === RESULTS.BLOCKED || r === RESULTS.UNAVAILABLE;

async function auditPermissions() {
  // returns [{granted, blocked}] per screen
  const out = [];
  for (let i = 0; i < SCREENS.length; i++) {
    let granted = true;
    let blocked = false;
    for (const p of SCREENS[i].perms) {
      const r = await check(p);
      if (!isGranted(r)) granted = false;
      if (isBlocked(r)) blocked = true;
    }
    out.push({ granted, blocked });
  }
  return out;
}

export default function PermissionsOnboarding({ onComplete }) {
  const [index, setIndex] = useState(0);
  const [version, setVersion] = useState(0); // bump to remount interactive widgets after a re-route
  const [blockedScreens, setBlockedScreens] = useState({}); // any failed attempt → blocked UI
  const [skippedScreens, setSkippedScreens] = useState({}); // user explicitly skipped this perm
  const failedAttempts = useRef({}); // per-screen denial count
  const translateX = useRef(new Animated.Value(0)).current;

  const runAudit = async () => {
    const audit = await auditPermissions();
    const blockedMap = {};
    audit.forEach((a, i) => {
      // OS-reported BLOCKED, OR any failed attempt locally
      if (a.blocked || (failedAttempts.current[i] || 0) >= 1) {
        blockedMap[i] = true;
      }
    });
    setBlockedScreens(blockedMap);
    return audit;
  };

  // Initial audit + re-audit when app returns from Settings
  useEffect(() => {
    runAudit().then(audit => {
      const next = findFirstUnresolved(audit, skippedScreens);
      if (next === -1) { onComplete?.(); return; }
      if (next !== 0) setIndex(next);
    });
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      // If user granted any perm via Settings, reset its local attempt counter so it can interact again
      const pre = await auditPermissions();
      pre.forEach((a, i) => { if (a.granted) failedAttempts.current[i] = 0; });
      const audit = await runAudit();
      const next = findFirstUnresolved(audit, skippedScreens);
      if (next === -1) { onComplete?.(); return; }
      if (next !== index) setIndex(next);
      setVersion(v => v + 1);
    });
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    Animated.timing(translateX, {
      toValue: -index * SCREEN_WIDTH,
      duration: 320,
      useNativeDriver: true,
    }).start();
  }, [index, translateX]);

  // Find the first screen that's neither granted nor user-skipped
  const findFirstUnresolved = (audit, skipped) => {
    for (let i = 0; i < audit.length; i++) {
      if (!audit[i].granted && !skipped[i]) return i;
    }
    return -1;
  };

  const handleAllow = async () => {
    const currentIdx = index;
    try {
      const perms = SCREENS[currentIdx].perms;
      if (perms.length > 1) {
        await requestMultiple(perms);
      } else {
        await request(perms[0]);
      }
    } catch (e) { /* user can grant later via settings */ }

    // Did this screen end up granted?
    let stillMissing = false;
    for (const p of SCREENS[currentIdx].perms) {
      const r = await check(p);
      if (!isGranted(r)) { stillMissing = true; break; }
    }
    if (stillMissing) {
      failedAttempts.current[currentIdx] = (failedAttempts.current[currentIdx] || 0) + 1;
    } else {
      failedAttempts.current[currentIdx] = 0;
    }

    const audit = await runAudit();
    const next = findFirstUnresolved(audit, skippedScreens);
    if (next === -1) {
      onComplete?.();
      return;
    }
    if (next !== currentIdx) setIndex(next);
    setVersion(v => v + 1);
  };

  const handleSkip = async () => {
    const currentIdx = index;
    const newSkipped = { ...skippedScreens, [currentIdx]: true };
    setSkippedScreens(newSkipped);

    const audit = await auditPermissions();
    const next = findFirstUnresolved(audit, newSkipped);
    if (next === -1) {
      onComplete?.();
      return;
    }
    if (next !== currentIdx) setIndex(next);
    setVersion(v => v + 1);
  };

  return (
    <View style={styles.container}>
      <View style={styles.dots}>
        {SCREENS.map((_, i) => (
          <View key={i} style={[styles.dot, i === index && styles.dotActive]} />
        ))}
      </View>

      <Animated.View style={[styles.slider, { transform: [{ translateX }] }]}>
        {SCREENS.map((s, i) => (
          <View key={`${s.title}-${version}`} style={styles.screen}>
            {blockedScreens[i] ? (
              <View style={[styles.glyphWrap, { backgroundColor: `${s.accent}14`, borderColor: `${s.accent}33` }]}>
                <Feather name="lock" size={42} color={s.accent} />
              </View>
            ) : s.interactive ? (
              <SlideToConnect
                accent={s.accent}
                variant={s.variant}
                onTrigger={() => { if (i === index) handleAllow(); }}
              />
            ) : (
              <View style={[styles.glyphWrap, { backgroundColor: `${s.accent}14`, borderColor: `${s.accent}33` }]}>
                <Text style={[styles.glyph, { color: s.accent }]}>{s.glyph}</Text>
              </View>
            )}
            <Text style={styles.title}>{s.title}</Text>
            <Text style={styles.body}>
              {blockedScreens[i]
                ? 'This permission was denied. Open Settings to grant it manually — we’ll detect it when you return.'
                : s.body}
            </Text>
            {!blockedScreens[i] && s.interactive && s.hint && (
              <Text style={styles.slideHint}>{s.hint}</Text>
            )}
          </View>
        ))}
      </Animated.View>

      {blockedScreens[index] ? (
        <View style={styles.blockedActions}>
          <TouchableOpacity style={[styles.button, styles.buttonPrimary]} onPress={() => openSettings().catch(() => {})} activeOpacity={0.85}>
            <Text style={styles.buttonText}>Open Settings</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.button, styles.buttonGhost]} onPress={handleSkip} activeOpacity={0.7}>
            <Text style={[styles.buttonText, styles.buttonGhostText]}>Skip</Text>
          </TouchableOpacity>
        </View>
      ) : !SCREENS[index].interactive && (
        <TouchableOpacity style={styles.button} onPress={handleAllow} activeOpacity={0.85}>
          <Text style={styles.buttonText}>Allow</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  dots: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    paddingTop: 24,
    paddingBottom: 12,
  },
  dot: {
    width: 7, height: 7, borderRadius: 4,
    backgroundColor: '#e2e8f0',
  },
  dotActive: { backgroundColor: '#0f172a', width: 24 },
  slider: {
    flex: 1,
    flexDirection: 'row',
    width: SCREEN_WIDTH * SCREENS.length,
  },
  screen: {
    width: SCREEN_WIDTH,
    paddingHorizontal: 36,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 22,
  },
  glyphWrap: {
    width: 110, height: 110, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
    marginBottom: 8,
  },
  glyph: {
    fontSize: 56,
    fontWeight: '300',
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0f172a',
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  body: {
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: 8,
  },
  button: {
    margin: 24,
    backgroundColor: '#0f172a',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  blockedActions: {
    margin: 24,
    gap: 10,
  },
  buttonPrimary: {
    margin: 0,
  },
  buttonGhost: {
    margin: 0,
    backgroundColor: 'transparent',
    paddingVertical: 12,
  },
  buttonGhostText: {
    color: '#64748b',
  },
  slideHint: {
    fontSize: 12,
    color: '#94a3b8',
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 8,
  },
});

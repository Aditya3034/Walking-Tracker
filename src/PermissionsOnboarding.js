import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated,
  Dimensions, Platform,
} from 'react-native';
import { request, PERMISSIONS } from 'react-native-permissions';

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
  },
  {
    glyph: '◎',
    accent: '#16a34a',
    title: 'Track your walks',
    body:  'Precise location records the route of every walk so you can see where you went on a map.',
    perms: PERMS.LOCATION,
  },
  {
    glyph: '⬆',
    accent: '#ea580c',
    title: 'Count your steps',
    body:  'Physical activity lets the app count your steps in the background — even when your phone is locked.',
    perms: PERMS.ACTIVITY,
  },
];

export default function PermissionsOnboarding({ onComplete }) {
  const [index, setIndex] = useState(0);
  const translateX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(translateX, {
      toValue: -index * SCREEN_WIDTH,
      duration: 320,
      useNativeDriver: true,
    }).start();
  }, [index, translateX]);

  const handleAllow = async () => {
    const currentIdx = index;
    if (currentIdx < SCREENS.length - 1) setIndex(currentIdx + 1);
    try {
      for (const p of SCREENS[currentIdx].perms) {
        await request(p);
      }
    } catch (e) { /* user can grant later via settings */ }
    if (currentIdx === SCREENS.length - 1) {
      onComplete?.();
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.dots}>
        {SCREENS.map((_, i) => (
          <View key={i} style={[styles.dot, i === index && styles.dotActive]} />
        ))}
      </View>

      <Animated.View style={[styles.slider, { transform: [{ translateX }] }]}>
        {SCREENS.map((s) => (
          <View key={s.title} style={styles.screen}>
            <View style={[styles.glyphWrap, { backgroundColor: `${s.accent}14`, borderColor: `${s.accent}33` }]}>
              <Text style={[styles.glyph, { color: s.accent }]}>{s.glyph}</Text>
            </View>
            <Text style={styles.title}>{s.title}</Text>
            <Text style={styles.body}>{s.body}</Text>
          </View>
        ))}
      </Animated.View>

      <TouchableOpacity style={styles.button} onPress={handleAllow} activeOpacity={0.85}>
        <Text style={styles.buttonText}>Allow</Text>
      </TouchableOpacity>
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
});

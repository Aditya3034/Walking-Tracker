import React, { useState, useEffect, useRef } from 'react';
import { StatusBar, StyleSheet, View, TouchableOpacity, Text, Animated } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import WalkingTrackerScreen from './src/StepCounter';
import BleConnect from './src/BleConnet';
import ActivitiesScreen from './src/ActivitiesScreen';
import BleStepService from './src/BleStepService';

const TABS = [
  { id: 'tracker',    label: 'Track'  },
  { id: 'bluetooth',  label: 'Device' },
  { id: 'activities', label: 'Log'    },
];


export default function App() {
  const [activeTab, setActiveTab] = useState('tracker');
  const [hungerState, setHungerState] = useState('normal');
  const overlayOpacity = useRef(new Animated.Value(0)).current;
  const overlayColor = useRef(new Animated.Value(0)).current; // 0=amber, 1=red

  useEffect(() => {
    // Ask native service to re-emit BLE + hunger state — restores UI after app reopen
    const { StepCounter } = require('react-native').NativeModules;
    StepCounter?.queryBleState?.()?.catch?.(() => {});
  }, []);

  useEffect(() => {
    const applyHungerState = (state) => {
      setHungerState(state);
      if (state === 'normal') {
        Animated.timing(overlayOpacity, {
          toValue: 0,
          duration: 800,
          useNativeDriver: false,
        }).start();
      } else {
        Animated.parallel([
          Animated.timing(overlayOpacity, {
            toValue: 1,
            duration: 1200,
            useNativeDriver: false,
          }),
          Animated.timing(overlayColor, {
            toValue: state === 'starving' ? 1 : 0,
            duration: 1500,
            useNativeDriver: false,
          }),
        ]).start();
      }
    };

    const unsubscribe = BleStepService.onHungerChange(applyHungerState);

    // Sync immediately in case the native event fired before this listener was registered
    const current = BleStepService.getHungerState();
    if (current !== 'normal') applyHungerState(current);

    return () => unsubscribe();
  }, [overlayOpacity, overlayColor]);

  // Interpolate between amber and red as hunger worsens
  const overlayBg = overlayColor.interpolate({
    inputRange:  [0, 1],
    outputRange: ['rgba(251,191,36,0.18)', 'rgba(220,38,38,0.22)'],
  });

  const headerBg = overlayColor.interpolate({
    inputRange:  [0, 1],
    outputRange: ['rgba(254,243,199,0.9)', 'rgba(254,226,226,0.9)'],
  });

  const isHungry = hungerState !== 'normal';

  return (
    <SafeAreaProvider style={styles.appContainer}>
      <StatusBar barStyle="dark-content" backgroundColor="#fff" />
      <SafeAreaView style={styles.container}>

        {/* Header — tints when hungry */}
        <Animated.View style={[
          styles.header,
          isHungry && { backgroundColor: headerBg, borderBottomColor: 'transparent' },
        ]}>
          <Text style={styles.headerTitle}>SOFTWEAR.PET</Text>
          {isHungry && (
            <Text style={[
              styles.hungerLabel,
              hungerState === 'starving' && styles.hungerLabelStarving,
            ]}>
              {hungerState === 'starving' ? 'VERY HUNGRY' : 'HUNGRY'}
            </Text>
          )}
        </Animated.View>

        <View style={styles.content}>
          {/* Content */}
          {TABS.map(tab => (
            <View
              key={tab.id}
              style={{ flex: 1, display: activeTab === tab.id ? 'flex' : 'none' }}
            >
              {tab.id === 'tracker'    && <WalkingTrackerScreen />}
              {tab.id === 'bluetooth'  && <BleConnect />}
              {tab.id === 'activities' && <ActivitiesScreen isActive={activeTab === 'activities'} />}
            </View>
          ))}

          {/* Hunger overlay — sits on top of content, pointer-events none so taps pass through */}
          {isHungry && (
            <Animated.View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, { backgroundColor: overlayBg, opacity: overlayOpacity }]}
            />
          )}
        </View>

        <View style={styles.tabBar}>
          {TABS.map(tab => {
            const active = activeTab === tab.id;
            return (
              <TouchableOpacity
                key={tab.id}
                style={[styles.tab, active && styles.tabActive]}
                onPress={() => setActiveTab(tab.id)}
                activeOpacity={0.7}
              >
                <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  appContainer: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  container: {
    flex: 1,
  },
  header: {
    backgroundColor: '#ffffff',
    paddingVertical: 18,
    paddingHorizontal: 24,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
    textAlign: 'center',
    letterSpacing: 3,
  },
  hungerLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: '#d97706',
    letterSpacing: 2,
    marginTop: 3,
    textTransform: 'uppercase',
  },
  hungerLabelStarving: {
    color: '#dc2626',
  },
  content: {
    flex: 1,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingBottom: 6,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: 2,
    borderTopColor: 'transparent',
  },
  tabActive: {
    borderTopColor: '#2563eb',
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#94a3b8',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  tabLabelActive: {
    color: '#2563eb',
    fontWeight: '700',
  },
});

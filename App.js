import React, { useState, useEffect, useRef } from 'react';
import { StatusBar, StyleSheet, View, TouchableOpacity, Text, Animated, NativeEventEmitter, NativeModules, ActivityIndicator } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { Platform } from 'react-native';
import { check, PERMISSIONS, RESULTS } from 'react-native-permissions';
import WalkingTrackerScreen from './src/StepCounter';
import ActivitiesScreen from './src/ActivitiesScreen';
import HomeScreen from './src/HomeScreen';
import BleStepService from './src/BleStepService';
import SplashScreen from './src/SplashScreen';
import ConnectPetGate from './src/ConnectPetGate';
import OnboardingScreen from './src/OnboardingScreen';
import PermissionsOnboarding from './src/PermissionsOnboarding';
import SettingsScreen from './src/SettingsScreen';
import { syncSessions, syncIfStale, restoreSessionsFromCloud } from './src/syncSessions';
const TABS = [
  { id: 'home',       label: 'Home'  },
  { id: 'tracker',    label: 'Track' },
  { id: 'activities', label: 'Log'   },
];


export default function App() {
  const [splashDone, setSplashDone] = useState(false);
  const [activeTab, setActiveTab] = useState('home');
  const [hungerState, setHungerState] = useState('normal');
  const overlayOpacity = useRef(new Animated.Value(0)).current;
  const overlayColor = useRef(new Animated.Value(0)).current; // 0=amber, 1=red

  // Routing state — derived from AsyncStorage on mount
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [petId, setPetId] = useState(null);
  const [username, setUsername] = useState(null);
  const [checkingPet, setCheckingPet] = useState(false);
  const [permissionsReady, setPermissionsReady] = useState(false);
  const [permissionsChecked, setPermissionsChecked] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Load cached identity on mount
  useEffect(() => {
    (async () => {
      const [pid, uname] = await Promise.all([
        AsyncStorage.getItem('petId').catch(() => null),
        AsyncStorage.getItem('username').catch(() => null),
      ]);
      setPetId(pid);
      setUsername(uname);
      setIdentityLoaded(true);
      // Background catch-up sync if last upload was >24h ago
      if (pid) syncIfStale().catch(() => {});
    })();
  }, []);

  // Check if BLE + location + activity permissions are all granted (skips onboarding if yes)
  useEffect(() => {
    (async () => {
      try {
        const isGranted = (r) => r === RESULTS.GRANTED || r === RESULTS.LIMITED;
        let allGranted = false;
        if (Platform.OS === 'android') {
          const blePerms = Platform.Version >= 31
            ? [PERMISSIONS.ANDROID.BLUETOOTH_SCAN, PERMISSIONS.ANDROID.BLUETOOTH_CONNECT]
            : [PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION];
          const checks = await Promise.all([
            ...blePerms.map(p => check(p)),
            check(PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION),
            check(PERMISSIONS.ANDROID.ACTIVITY_RECOGNITION),
          ]);
          allGranted = checks.every(isGranted);
        } else {
          const checks = await Promise.all([
            check(PERMISSIONS.IOS.BLUETOOTH),
            check(PERMISSIONS.IOS.LOCATION_WHEN_IN_USE),
            check(PERMISSIONS.IOS.MOTION),
          ]);
          allGranted = checks.every(isGranted);
        }
        setPermissionsReady(allGranted);
      } catch (e) {
        setPermissionsReady(false);
      } finally {
        setPermissionsChecked(true);
      }
    })();
  }, []);

  // Pet ID listener — runs anywhere in the app, decides routing
  useEffect(() => {
    const { StepCounter } = NativeModules;
    if (!StepCounter) return;
    const emitter = new NativeEventEmitter(StepCounter);
    const sub = emitter.addListener('BlePetIdUpdate', async (incomingPetId) => {
      setCheckingPet(true);
      try {
        const cachedPetId = await AsyncStorage.getItem('petId');
        const isPetSwitch = cachedPetId && cachedPetId !== incomingPetId;

        if (isPetSwitch) {
          // Connected to a different pet — wipe stale account-local data.
          // pairedDeviceId is intentionally NOT cleared: the BLE MAC is unchanged
          // when the same physical device is re-flashed with a new Pet ID.
          await AsyncStorage.multiRemove([
            'activities', 'username', 'petName', 'petColor', 'petNameChanged',
            'lastSyncAt',
          ]);
          setUsername(null);
        }

        await AsyncStorage.setItem('petId', incomingPetId);

        if (!auth().currentUser) await auth().signInAnonymously();

        const snap = await firestore().collection('pets').doc(incomingPetId).get();
        const data = snap.data();
        if (data) {
          await AsyncStorage.multiSet([
            ['username', data.username || ''],
            ['petName',  data.petName  || ''],
            ['petNameChanged', data.petNameChanged ? 'true' : 'false'],
          ]);
          if (data.petColor) await AsyncStorage.setItem('petColor', data.petColor);
          // Pull cloud sessions back into AsyncStorage (covers reinstall / new phone)
          await restoreSessionsFromCloud();
          setUsername(data.username || null);
        }
        setPetId(incomingPetId);
        // Connection point — natural sync trigger. Fire-and-forget.
        syncSessions().catch(() => {});
      } catch (e) {
        setPetId(incomingPetId); // still mark petId so onboarding shows on retry
      } finally {
        setCheckingPet(false);
      }
    });
    return () => sub.remove();
  }, []);

  // Device type listener — hardware variant ("badge" / "necklace")
  useEffect(() => {
    const { StepCounter } = NativeModules;
    if (!StepCounter) return;
    const emitter = new NativeEventEmitter(StepCounter);
    const sub = emitter.addListener('BleDeviceTypeUpdate', async (deviceType) => {
      if (!deviceType) return;
      try {
        await AsyncStorage.setItem('deviceType', deviceType);
        const currentPetId = await AsyncStorage.getItem('petId');
        if (currentPetId && auth().currentUser) {
          await firestore().collection('pets').doc(currentPetId)
            .set({ deviceType }, { merge: true });
        }
      } catch (e) {}
    });
    return () => sub.remove();
  }, []);

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

  // Routing decision (after identity loaded from AsyncStorage)
  const showSplash       = !splashDone;
  const showPermissions  = permissionsChecked && !permissionsReady;
  const showChecking     = identityLoaded && permissionsReady && checkingPet && !username;
  const showGate         = identityLoaded && permissionsReady && !petId && !checkingPet;
  const showOnboarding   = identityLoaded && permissionsReady && petId && !username && !checkingPet;
  const showApp          = identityLoaded && permissionsReady && petId && username;

  if (showPermissions) {
    return (
      <SafeAreaProvider style={styles.appContainer}>
        <StatusBar barStyle="dark-content" backgroundColor="#fff" />
        <SafeAreaView style={styles.container}>
          <PermissionsOnboarding onComplete={() => setPermissionsReady(true)} />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (showChecking) {
    return (
      <SafeAreaProvider style={styles.appContainer}>
        <StatusBar barStyle="dark-content" backgroundColor="#fff" />
        <SafeAreaView style={[styles.container, styles.loadingContainer]}>
          <ActivityIndicator size="large" color="#0f172a" />
          <Text style={styles.loadingText}>Reading pet…</Text>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (showGate) {
    return (
      <SafeAreaProvider style={styles.appContainer}>
        <StatusBar barStyle="dark-content" backgroundColor="#fff" />
        {showSplash && <SplashScreen onComplete={() => setSplashDone(true)} />}
        <SafeAreaView style={styles.container}>
          <ConnectPetGate />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (showOnboarding) {
    return (
      <SafeAreaProvider style={styles.appContainer}>
        <StatusBar barStyle="dark-content" backgroundColor="#fff" />
        {showSplash && <SplashScreen onComplete={() => setSplashDone(true)} />}
        <SafeAreaView style={styles.container}>
          <OnboardingScreen
            petId={petId}
            onComplete={({ username: u }) => setUsername(u)}
          />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider style={styles.appContainer}>
      <StatusBar barStyle="dark-content" backgroundColor="#fff" />
      {showSplash && <SplashScreen onComplete={() => setSplashDone(true)} />}
      <SafeAreaView style={styles.container}>

        {/* Header — tints when hungry */}
        <Animated.View style={[
          styles.header,
          isHungry && { backgroundColor: headerBg, borderBottomColor: 'transparent' },
        ]}>
          {activeTab === 'home' && (
            <TouchableOpacity
              style={styles.headerIconLeft}
              onPress={() => setSettingsOpen(true)}
              hitSlop={10}
            >
              <Text style={styles.headerIcon}>⚙</Text>
            </TouchableOpacity>
          )}
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
              {tab.id === 'home'       && <HomeScreen key={petId || 'no-pet'} isActive={activeTab === 'home'} />}
              {tab.id === 'tracker' && <WalkingTrackerScreen key={petId || 'no-pet'} />}
              {tab.id === 'activities' && <ActivitiesScreen key={petId || 'no-pet'} isActive={activeTab === 'activities'} />}
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

      <SettingsScreen
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onLogout={() => {
          setSettingsOpen(false);
          // Reset routing — back to gate. AsyncStorage was already cleared by SettingsScreen.
          setPetId(null);
          setUsername(null);
          setActiveTab('home');
        }}
      />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  appContainer: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  container: {
    flex: 1,
  },
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  loadingText: {
    fontSize: 13,
    color: '#64748b',
    fontWeight: '600',
    letterSpacing: 0.5,
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
  },
  headerIconLeft: {
    position: 'absolute',
    left: 18,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  headerIcon: {
    fontSize: 18,
    color: '#0f172a',
  },
  hungerLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: '#d97706',
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
    textTransform: 'uppercase',
  },
  tabLabelActive: {
    color: '#2563eb',
    fontWeight: '700',
  },
});

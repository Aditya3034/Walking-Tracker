import React, { useState, useEffect, useRef } from 'react';
import { StatusBar, StyleSheet, View, TouchableOpacity, Text, Animated, NativeEventEmitter, NativeModules, BackHandler } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { Platform } from 'react-native';
import { check, PERMISSIONS, RESULTS } from 'react-native-permissions';
import Feather from 'react-native-vector-icons/Feather';
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
  { id: 'home',       icon: 'home'      },
  { id: 'tracker',    icon: 'activity'  },
  { id: 'activities', icon: 'clipboard' },
  { id: 'settings',   icon: 'settings'  },
];

// Determinate-looking progress bar — ramps toward 95% on a fixed curve,
// then visually pegs there until the parent unmounts when work completes.
function FakeProgressBar({ color = '#0f172a' }) {
  const progress = useRef(new Animated.Value(0)).current;
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const listener = progress.addListener(({ value }) => setPct(Math.round(value * 100)));
    Animated.timing(progress, {
      toValue: 0.95,
      duration: 5000,
      useNativeDriver: false,
    }).start();
    return () => progress.removeListener(listener);
  }, [progress]);
  const widthInterp = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  return (
    <View style={progressStyles.wrap}>
      <View style={progressStyles.track}>
        <Animated.View style={[progressStyles.fill, { width: widthInterp, backgroundColor: color }]} />
      </View>
      <Text style={progressStyles.pctText}>{pct}%</Text>
    </View>
  );
}

const progressStyles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    bottom: 40,
    left: 32,
    right: 32,
    alignItems: 'center',
    gap: 6,
  },
  track: {
    width: '100%',
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(15,23,42,0.10)',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 3,
  },
  pctText: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '600',
    letterSpacing: 0.5,
  },
});


export default function App() {
  const [splashDone, setSplashDone] = useState(false);
  const [activeTab, setActiveTab] = useState('home');
  const [prevTabBeforeTracker, setPrevTabBeforeTracker] = useState('home');
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
            'lastSyncAt', 'pendingTreats', 'stepsConvertedToday',
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
          if (typeof data.pendingTreats === 'number') {
            await AsyncStorage.setItem('pendingTreats', String(data.pendingTreats));
          }
          // Restore today's converted steps only if Firestore date matches today (prevents double-claiming yesterday's leftovers)
          if (data.stepsConvertedToday && data.stepsConvertedToday.date) {
            const d = new Date();
            const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            if (data.stepsConvertedToday.date === today) {
              await AsyncStorage.setItem('stepsConvertedToday', JSON.stringify(data.stepsConvertedToday));
            }
          }
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

  // System back button: navigate to home from any other tab; exit if already on home
  useEffect(() => {
    const handleBack = () => {
      if (activeTab !== 'home') {
        setActiveTab('home');
        return true; // intercepted — don't exit
      }
      return false; // on home — let Android handle (exit)
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', handleBack);
    return () => sub.remove();
  }, [activeTab]);

  useEffect(() => {
    let pulseLoop = null;

    const startPulse = (state) => {
      // Stop any prior loop before starting a new one
      if (pulseLoop) pulseLoop.stop();
      // Starving pulses faster + slightly stronger than hungry
      const peak     = state === 'starving' ? 1.0 : 0.85;
      const period   = state === 'starving' ? 900  : 1500; // ms per half-cycle
      pulseLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(overlayOpacity, { toValue: peak, duration: period, useNativeDriver: false }),
          Animated.timing(overlayOpacity, { toValue: 0,    duration: period, useNativeDriver: false }),
        ])
      );
      pulseLoop.start();
    };

    const stopPulse = () => {
      if (pulseLoop) { pulseLoop.stop(); pulseLoop = null; }
      Animated.timing(overlayOpacity, { toValue: 0, duration: 600, useNativeDriver: false }).start();
    };

    const applyHungerState = (state) => {
      setHungerState(state);
      if (state === 'normal') {
        stopPulse();
      } else {
        // Color animates between amber (hungry) and red (starving) — smooth tweens between states
        Animated.timing(overlayColor, {
          toValue: state === 'starving' ? 1 : 0,
          duration: 1200,
          useNativeDriver: false,
        }).start();
        startPulse(state);
      }
    };

    const unsubscribe = BleStepService.onHungerChange(applyHungerState);

    // Sync immediately in case the native event fired before this listener was registered
    const current = BleStepService.getHungerState();
    if (current !== 'normal') applyHungerState(current);

    return () => {
      unsubscribe();
      if (pulseLoop) pulseLoop.stop();
    };
  }, [overlayOpacity, overlayColor]);

  // Pulse peaks alternate with full transparency, so we can use richer tints without crushing contrast.
  const overlayBg = overlayColor.interpolate({
    inputRange:  [0, 1],
    outputRange: ['rgba(251,191,36,0.22)', 'rgba(220,38,38,0.28)'],
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
        <StatusBar
          barStyle="dark-content"
          backgroundColor={
            hungerState === 'starving' ? '#fde2e2' :
            hungerState === 'hungry'   ? '#fef3c7' :
            '#fff'
          }
        />
        {showSplash && <SplashScreen onComplete={() => setSplashDone(true)} />}
        <SafeAreaView style={styles.container}>
          <PermissionsOnboarding onComplete={() => setPermissionsReady(true)} />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (showChecking) {
    return (
      <SafeAreaProvider style={styles.appContainer}>
        <StatusBar
          barStyle="dark-content"
          backgroundColor={
            hungerState === 'starving' ? '#fde2e2' :
            hungerState === 'hungry'   ? '#fef3c7' :
            '#fff'
          }
        />
        {showSplash && <SplashScreen onComplete={() => setSplashDone(true)} />}
        <SafeAreaView style={[styles.container, styles.loadingContainer]}>
          <Text style={styles.loadingText}>Reading pet…</Text>
          <FakeProgressBar />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (showGate) {
    return (
      <SafeAreaProvider style={styles.appContainer}>
        <StatusBar
          barStyle="dark-content"
          backgroundColor={
            hungerState === 'starving' ? '#fde2e2' :
            hungerState === 'hungry'   ? '#fef3c7' :
            '#fff'
          }
        />
        {showSplash && <SplashScreen onComplete={() => setSplashDone(true)} />}
        <SafeAreaView style={styles.container}>
          <ConnectPetGate
            onDevSkip={async () => {
              // TEMP DEV — bypass BLE for emulator UI work; remove before ship
              const fakePetId = 'DEV_SKIP';
              const fakeUsername = 'dev';
              await AsyncStorage.multiSet([
                ['petId', fakePetId],
                ['username', fakeUsername],
                ['petName', 'Dev Pet'],
                ['petColor', '#dc2626'],
              ]);
              setUsername(fakeUsername);
              setPetId(fakePetId);
            }}
          />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (showOnboarding) {
    return (
      <SafeAreaProvider style={styles.appContainer}>
        <StatusBar
          barStyle="dark-content"
          backgroundColor={
            hungerState === 'starving' ? '#fde2e2' :
            hungerState === 'hungry'   ? '#fef3c7' :
            '#fff'
          }
        />
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
      <StatusBar
          barStyle="dark-content"
          backgroundColor={
            hungerState === 'starving' ? '#fde2e2' :
            hungerState === 'hungry'   ? '#fef3c7' :
            '#fff'
          }
        />
      {showSplash && <SplashScreen onComplete={() => setSplashDone(true)} />}
      <SafeAreaView style={styles.container}>

        <View style={styles.content}>
          {/* Content */}
          {TABS.map(tab => (
            <View
              key={tab.id}
              style={{ flex: 1, display: activeTab === tab.id ? 'flex' : 'none' }}
            >
              {tab.id === 'home'       && <HomeScreen key={petId || 'no-pet'} isActive={activeTab === 'home'} />}
              {tab.id === 'tracker' && <WalkingTrackerScreen key={petId || 'no-pet'} onBack={() => setActiveTab(prevTabBeforeTracker)} />}
              {tab.id === 'activities' && <ActivitiesScreen key={petId || 'no-pet'} isActive={activeTab === 'activities'} />}
              {tab.id === 'settings' && (
                <SettingsScreen
                  key={petId || 'no-pet'}
                  onLogout={() => {
                    // Reset routing — back to gate. AsyncStorage was already cleared by SettingsScreen.
                    setPetId(null);
                    setUsername(null);
                    setActiveTab('home');
                  }}
                />
              )}
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

        {activeTab !== 'tracker' && (
        <View style={styles.tabBarWrap}>
          <View style={styles.tabBar}>
            {TABS.map(tab => {
              const active = activeTab === tab.id;
              return (
                <TouchableOpacity
                  key={tab.id}
                  style={styles.tab}
                  onPress={() => {
                    // Remember where we came from so the tracker back button returns there
                    if (tab.id === 'tracker' && activeTab !== 'tracker') {
                      setPrevTabBeforeTracker(activeTab);
                    }
                    setActiveTab(tab.id);
                  }}
                  activeOpacity={0.7}
                >
                  <View style={[styles.tabIconWrap, active && styles.tabIconWrapActive]}>
                    <Feather name={tab.icon} size={22} color="#ffffff" />
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
        )}

      </SafeAreaView>
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
  tabBarWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 30,
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#0f172a',
    borderRadius: 25,
    paddingHorizontal: 28,
    paddingVertical: 16,
    alignItems: 'center',
    gap: 32,
    minWidth: 320,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabIconWrap: {
    width: 60,
    height: 45,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tabIconWrapActive: {
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
});

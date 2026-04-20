import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Platform, Alert, Linking, NativeModules, NativeEventEmitter, ToastAndroid,
  TextInput, Modal, Animated, Image,
} from 'react-native';

import { requestMultiple, PERMISSIONS, RESULTS } from 'react-native-permissions';
import BleStepService from './BleStepService';
import manager from './BleManagerSingleton';

const { StepCounter } = NativeModules;
const nativeEmitter = StepCounter ? new NativeEventEmitter(StepCounter) : null;

const APP_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';

/* ── Radar layout constants ── */
const RADAR_SIZE = 260;
const RC = RADAR_SIZE / 2;          // radar centre
const DEVICE_SIZE = 50;
const RING_RADII = [90, 110, 120];

// Generate device slot positions with a random angle offset so the device
// doesn't always appear in the same spot
function makeDeviceSlots(angleOffsetDeg = 0) {
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (i * 137.508 + angleOffsetDeg) * (Math.PI / 180);
    const r = RING_RADII[i % RING_RADII.length];
    return {
      left: RC + r * Math.cos(angle) - DEVICE_SIZE / 2,
      top:  RC + r * Math.sin(angle) - DEVICE_SIZE / 2,
    };
  });
}

const PET_COLORS = ['#ea580c', '#2563eb', '#16a34a', '#9333ea', '#db2777', '#dc2626'];

/* ── Pet icon: matches swlogo.svg exactly ── */
function PetIcon({ size = 40, borderColor = null, style }) {
  return (
    <Image
      source={require('./assets/swlogo.png')}
      style={[{
        width: size, height: size,
        borderRadius: Math.round(size * 0.22),
        borderWidth: borderColor ? 2.5 : 0,
        borderColor: borderColor || 'transparent',
      }, style]}
      resizeMode="contain"
    />
  );
}

/* ── Animated radar rings ── */
const RING_RADII_ANIM = [40, 70, 100, 130];

function RadarRings({ active, found }) {
  const anims = useRef(RING_RADII_ANIM.map(() => new Animated.Value(0))).current;
  const loopRef = useRef(null);

  useEffect(() => {
    if (!active) {
      loopRef.current?.stop();
      anims.forEach(a => a.setValue(0));
      return;
    }
    if (found) {
      // Stop looping, fade all rings to their static opacity
      loopRef.current?.stop();
      Animated.parallel(
        anims.map(a => Animated.timing(a, { toValue: 1, duration: 300, useNativeDriver: true }))
      ).start();
      return;
    }
    // Pulse loop
    loopRef.current?.stop();
    const loop = Animated.loop(
      Animated.parallel(
        anims.map((anim, i) =>
          Animated.sequence([
            Animated.delay(i * 300),
            Animated.timing(anim, { toValue: 1, duration: 600, useNativeDriver: true }),
            Animated.timing(anim, { toValue: 0.15, duration: 800, useNativeDriver: true }),
          ])
        )
      )
    );
    loopRef.current = loop;
    loop.start();
  }, [active, found]);

  return (
    <>
      {RING_RADII_ANIM.map((r, i) => (
        <Animated.View key={i} pointerEvents="none" style={{
          position: 'absolute',
          width: r * 2, height: r * 2,
          borderRadius: r,
          borderWidth: 1,
          // innermost (i=0, r=30) darkest → outermost (i=3, r=120) lightest
          borderColor: `rgba(0,0,0,${(4 - i) * 0.03})`,
          left: RC - r, top: RC - r,
          opacity: anims[i],
        }} />
      ))}
    </>
  );
}

export default function BleConnect() {
  const [devices, setDevices] = useState([]);          // shown on radar (delayed)
  const [deviceSlots, setDeviceSlots] = useState(() => makeDeviceSlots(0));
  const pendingDevicesRef = useRef([]);                // found by BLE immediately
  const revealTimerRef = useRef(null);
  const [connectedDevice, setConnectedDevice] = useState(null);
  const [, setScanning] = useState(false);
  const [, setStatus] = useState('Initializing...');
  const [bluetoothState, setBluetoothState] = useState('Unknown');
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [petName, setPetName] = useState('');
  const [petColor, setPetColor] = useState(PET_COLORS[0]);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const deviceIdRef = useRef('');

  // Modal state
  const [modalVisible, setModalVisible] = useState(false);
  const [modalPhase, setModalPhase] = useState('idle'); // 'idle'|'scanning'|'connecting'|'connected'

  const bleSubscriptionRef = useRef(null);
  const btRetryTimeoutRef  = useRef(null);
  const scanTimeoutRef     = useRef(null);
  const wasConnectedRef    = useRef(false);
  const isConnectedRef     = useRef(false);
  const closeTimerRef      = useRef(null);
  const modalPhaseRef      = useRef('idle');

  // Keep ref in sync so BleConnectionUpdate handler can read current phase
  useEffect(() => { modalPhaseRef.current = modalPhase; }, [modalPhase]);

  /* ── BLE state listener ── */
  const setupBluetooth = async () => {
    bleSubscriptionRef.current?.remove();
    bleSubscriptionRef.current = manager.onStateChange((state) => {
      setBluetoothState(state);
      if (isConnectedRef.current) return;
      if (state === 'PoweredOn') setStatus('Ready to scan');
      else if (state === 'PoweredOff') { setStatus('Bluetooth is OFF'); setScanning(false); manager.stopDeviceScan(); }
    }, true);
    await checkBluetoothState();
  };

  const initializeBluetooth = async () => {
    const hasPermissions = await requestBluetoothPermissions();
    setPermissionsGranted(hasPermissions);
    if (!hasPermissions) { setStatus('Permissions required'); return; }
    await setupBluetooth();
  };

  useEffect(() => {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    AsyncStorage.getItem('petName').then(val => { if (val) setPetName(val); }).catch(() => {});
    AsyncStorage.getItem('petColor').then(val => { if (val) setPetColor(val); }).catch(() => {});
  }, []);

  useEffect(() => {
    initializeBluetooth();
    StepCounter?.queryBleState?.()?.catch?.(() => {});

    const connSub = nativeEmitter?.addListener('BleConnectionUpdate', async (state) => {
      if (state === 'connected') {
        wasConnectedRef.current = true;
        isConnectedRef.current = true;
        BleStepService.isConnectedState = true;
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const [savedPetName, savedBleName] = await Promise.all([
          AsyncStorage.getItem('petName').catch(() => null),
          AsyncStorage.getItem('bleDeviceName').catch(() => null),
        ]);
        const savedColor = await AsyncStorage.getItem('petColor').catch(() => null);
        const displayName = savedPetName || savedBleName || 'softwear';
        BleStepService.deviceName = displayName;
        if (savedPetName) setPetName(savedPetName);
        if (savedColor) setPetColor(savedColor);
        setConnectedDevice({ id: '', name: displayName });
        setStatus('Connected');

        // If modal is in connecting phase, show connected then auto-close
        if (modalPhaseRef.current === 'connecting') {
          setModalPhase('connected');
          closeTimerRef.current = setTimeout(() => {
            setModalVisible(false);
            setModalPhase('idle');
          }, 1500);
        }
      } else {
        const shouldToast = wasConnectedRef.current;
        wasConnectedRef.current = false;
        isConnectedRef.current = false;
        BleStepService.isConnectedState = false;
        setConnectedDevice(null);
        setDevices([]);
        setStatus('Disconnected');
        if (shouldToast && Platform.OS === 'android') {
          ToastAndroid.show('Pet disconnected', ToastAndroid.SHORT);
        }
      }
    });

    const unsubDisconnect = BleStepService.onDisconnect(() => {
      setConnectedDevice(null);
      setStatus('Disconnected');
    });

    return () => {
      manager.stopDeviceScan();
      bleSubscriptionRef.current?.remove();
      if (btRetryTimeoutRef.current) clearTimeout(btRetryTimeoutRef.current);
      if (scanTimeoutRef.current)    clearTimeout(scanTimeoutRef.current);
      if (closeTimerRef.current)     clearTimeout(closeTimerRef.current);
      if (revealTimerRef.current)    clearTimeout(revealTimerRef.current);
      connSub?.remove();
      unsubDisconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkBluetoothState = async () => {
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      const state = await manager.state();
      setBluetoothState(state);
      if (!isConnectedRef.current) {
        if (state === 'PoweredOn') setStatus('Ready to scan');
        else if (state === 'PoweredOff') setStatus('Turn on Bluetooth');
        else {
          btRetryTimeoutRef.current = setTimeout(async () => {
            if (isConnectedRef.current) return;
            try {
              const s = await manager.state();
              setBluetoothState(s);
              setStatus(s === 'PoweredOn' ? 'Ready to scan' : 'Turn on Bluetooth');
            } catch (e) { setStatus('Bluetooth unavailable'); }
          }, 1000);
        }
      }
    } catch (e) { setStatus('Bluetooth check failed'); }
  };

  const openBluetoothSettings = () => {
    Alert.alert('Enable Bluetooth', 'Please enable Bluetooth from your device settings.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Open Settings', onPress: () =>
        Platform.OS === 'android'
          ? Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS').catch(() => Linking.openSettings())
          : Linking.openSettings()
      },
    ]);
  };

  const startScan = async () => {
    if (!permissionsGranted) {
      const granted = await requestBluetoothPermissions();
      setPermissionsGranted(granted);
      if (!granted) return;
      await setupBluetooth();
    }
    const state = await manager.state();
    if (state !== 'PoweredOn') {
      Alert.alert('Bluetooth Required', 'Please turn on Bluetooth to scan for devices.',
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Open Settings', onPress: openBluetoothSettings }]);
      return;
    }
    setDevices([]);
    setDeviceSlots(makeDeviceSlots(Math.random() * 360));
    pendingDevicesRef.current = [];
    if (revealTimerRef.current) { clearTimeout(revealTimerRef.current); revealTimerRef.current = null; }
    setScanning(true);
    setStatus('Scanning...');
    setModalPhase('scanning');

    manager.startDeviceScan([APP_SERVICE_UUID], null, (error, device) => {
      if (error) {
        setScanning(false);
        if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
        setStatus('Scan failed');
        setModalPhase('idle');
        return;
      }
      if (!device) return;
      // Buffer the device — don't show on radar yet
      if (pendingDevicesRef.current.find(d => d.id === device.id)) return;
      pendingDevicesRef.current = [...pendingDevicesRef.current, device];
      // Reveal on radar after 2.5s so the animation plays first
      if (!revealTimerRef.current) {
        revealTimerRef.current = setTimeout(() => {
          setDevices([...pendingDevicesRef.current]);
          revealTimerRef.current = null;
        }, 2500);
      }
    });

    scanTimeoutRef.current = setTimeout(() => {
      manager.stopDeviceScan();
      setScanning(false);
      setDevices(prev => {
        setStatus(prev.length > 0 ? 'Scan complete' : 'No devices found');
        return prev;
      });
    }, 10000);
  };

  const requestBluetoothPermissions = async () => {
    try {
      let permissions = [];
      if (Platform.OS === 'android') {
        permissions = Platform.Version >= 31
          ? [PERMISSIONS.ANDROID.BLUETOOTH_SCAN, PERMISSIONS.ANDROID.BLUETOOTH_CONNECT]
          : Platform.Version >= 29
            ? [PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION]
            : [PERMISSIONS.ANDROID.ACCESS_COARSE_LOCATION];
      } else {
        permissions = [PERMISSIONS.IOS.BLUETOOTH, PERMISSIONS.IOS.LOCATION_WHEN_IN_USE];
      }
      const results = await requestMultiple(permissions);
      const allGranted = Object.values(results).every(r => r === RESULTS.GRANTED);
      if (!allGranted) {
        Alert.alert('Permissions Required', 'Please grant Bluetooth and Location permissions.',
          [{ text: 'Cancel', style: 'cancel' }, { text: 'Retry', onPress: () => requestBluetoothPermissions() }]);
        return false;
      }
      return true;
    } catch (err) {
      return false;
    }
  };

  const connectToDevice = async (device) => {
    try {
      manager.stopDeviceScan();
      setScanning(false);
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
      setStatus('Connecting...');
      setModalPhase('connecting');

      const bleDeviceName = device.name || device.id;
      await StepCounter.connectBleDevice(device.id);

      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      await AsyncStorage.setItem('bleDeviceName', bleDeviceName).catch(() => {});
      const savedPetName = await AsyncStorage.getItem('petName').catch(() => null);
      const displayName = savedPetName || bleDeviceName;

      wasConnectedRef.current = true;
      isConnectedRef.current = true;
      deviceIdRef.current = device.id;
      BleStepService.setDeviceName(displayName);
      const savedColor = await AsyncStorage.getItem('petColor').catch(() => null);
      if (savedColor) setPetColor(savedColor);
      setConnectedDevice({ id: device.id, name: displayName });
      setStatus('Connected');
    } catch (err) {
      setStatus('Connection failed');
      setModalPhase('scanning'); // go back to radar on failure
      Alert.alert('Connection Failed', err.message || 'Unknown error');
    }
  };

  const disconnectDevice = async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.removeItem('bleDeviceName').catch(() => {});
    await BleStepService.clearDevice();
    setConnectedDevice(null);
    setStatus('Disconnected');
  };

  const openModal = () => {
    setModalPhase('idle');
    setDevices([]);
    setModalVisible(true);
  };

  const closeModal = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    manager.stopDeviceScan();
    setScanning(false);
    setModalVisible(false);
    setModalPhase('idle');
    setDevices([]);
    pendingDevicesRef.current = [];
    if (revealTimerRef.current) { clearTimeout(revealTimerRef.current); revealTimerRef.current = null; }
  };

  const isReady = permissionsGranted && bluetoothState === 'PoweredOn';

  /* ── Scan modal content ── */
  const renderModalContent = () => {
    if (modalPhase === 'connecting' || modalPhase === 'connected') {
      const isConnected = modalPhase === 'connected';
      return (
        <View style={ms.phaseContainer}>
          <PetIcon size={100} borderColor={petColor} style={ms.largeIcon} />
          <Text style={[ms.phaseLabel, isConnected && ms.phaseLabelConnected]}>
            {isConnected ? 'connected' : 'connecting...'}
          </Text>
        </View>
      );
    }

    if (modalPhase === 'scanning') {
      return (
        <View style={ms.radarContainer}>
          <RadarRings active={modalPhase === 'scanning'} found={devices.length > 0} />
          {/* Devices on radar */}
          {devices.slice(0, 6).map((device, i) => (
            <TouchableOpacity
              key={device.id}
              style={[ms.radarDevice, { left: deviceSlots[i].left, top: deviceSlots[i].top }]}
              onPress={() => connectToDevice(device)}
              activeOpacity={0.7}
            >
              <PetIcon size={DEVICE_SIZE} borderColor={petColor} />
            </TouchableOpacity>
          ))}
          {/* Centre locating button */}
          <TouchableOpacity style={ms.centerBtn} activeOpacity={1}>
            <Text style={ms.centerBtnText}>locating</Text>
          </TouchableOpacity>
        </View>
      );
    }

    // idle
    return (
      <View style={ms.idleContainer}>
        <TouchableOpacity
          style={[ms.idleScanBtn, !isReady && ms.centerBtnDisabled]}
          onPress={isReady ? startScan : openBluetoothSettings}
          activeOpacity={0.8}
        >
          <Text style={ms.idleScanBtnText}>{isReady ? 'scan' : 'bt off'}</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Connected view */}
      {connectedDevice ? (
        <View style={styles.connectedContainer}>
          <View style={styles.connectedCard}>
            <PetIcon size={80} borderColor={petColor} />

            <Text style={styles.connectedLabel}>connected</Text>

            {editingName ? (
              <View style={styles.nameEditRow}>
                <TextInput
                  style={styles.nameInput}
                  value={nameInput}
                  onChangeText={setNameInput}
                  autoFocus
                  maxLength={24}
                  placeholder="Name your pet"
                  placeholderTextColor="#94a3b8"
                />
                <TouchableOpacity
                  style={styles.nameSaveBtn}
                  onPress={async () => {
                    const trimmed = nameInput.trim();
                    if (trimmed) {
                      setPetName(trimmed);
                      BleStepService.deviceName = trimmed;
                      setConnectedDevice(prev => prev ? { ...prev, name: trimmed } : prev);
                      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
                      await AsyncStorage.setItem('petName', trimmed).catch(() => {});
                      await BleStepService.writeToDevice(`NAME:${trimmed}`).catch(() => {});
                    }
                    setEditingName(false);
                  }}
                >
                  <Text style={styles.nameSaveBtnText}>Save</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.nameRow}
                onPress={() => { setNameInput(petName); setEditingName(true); }}
              >
                <Text style={styles.connectedName}>{petName || connectedDevice.name}</Text>
                <Text style={styles.editHint}>  edit</Text>
              </TouchableOpacity>
            )}

            {/* Color picker */}
            <View style={styles.colorRow}>
              {PET_COLORS.map(c => (
                <TouchableOpacity
                  key={c}
                  onPress={async () => {
                    setPetColor(c);
                    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
                    await AsyncStorage.setItem('petColor', c).catch(() => {});
                  }}
                  style={[styles.colorSwatch, { backgroundColor: c }, petColor === c && styles.colorSwatchSelected]}
                />
              ))}
            </View>

            <Text style={styles.connectedSub}>Connection maintained in background</Text>
            <TouchableOpacity style={styles.disconnectBtn} onPress={disconnectDevice}>
              <Text style={styles.disconnectBtnText}>DISCONNECT</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        /* Not connected — just show scan trigger */
        <View style={styles.scanTriggerArea}>
          <TouchableOpacity style={styles.scanTriggerBtn} onPress={openModal} activeOpacity={0.8}>
            <Text style={styles.scanTriggerText}>scan</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* BT / permission warnings */}
      {bluetoothState !== 'PoweredOn' && bluetoothState !== 'Unknown' && !connectedDevice && (
        <View style={styles.warningCard}>
          <Text style={styles.warningText}>Bluetooth is {bluetoothState}</Text>
          <TouchableOpacity style={styles.warningBtn} onPress={openBluetoothSettings}>
            <Text style={styles.warningBtnText}>OPEN SETTINGS</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Scan modal */}
      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={closeModal}>
        <View style={ms.backdrop}>
          <View style={ms.card}>
            <TouchableOpacity style={ms.closeBtn} onPress={closeModal}>
              <Text style={ms.closeBtnText}>×</Text>
            </TouchableOpacity>
            {renderModalContent()}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f0f0' },

  // Scan trigger (not connected)
  scanTriggerArea: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scanTriggerBtn: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: '#111',
    alignItems: 'center', justifyContent: 'center',
  },
  scanTriggerText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  // Warnings
  warningCard: {
    position: 'absolute', bottom: 32, left: 24, right: 24,
    backgroundColor: '#fff', borderRadius: 14, padding: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 4,
  },
  warningText: { fontSize: 13, color: '#92400e', fontWeight: '600', flex: 1 },
  warningBtn: { backgroundColor: '#f59e0b', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
  warningBtnText: { color: '#fff', fontWeight: '800', fontSize: 11 },

  // Connected card
  connectedContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  connectedCard: {
    backgroundColor: '#fff', borderRadius: 24, padding: 36,
    alignItems: 'center', width: '100%',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.07, shadowRadius: 16, elevation: 4,
  },
  connectedLabel: { fontSize: 13, color: '#16a34a', fontWeight: '700', marginTop: 18, marginBottom: 6 },
  connectedName: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  connectedSub: { fontSize: 12, color: '#94a3b8', marginTop: 6, marginBottom: 24, textAlign: 'center' },
  disconnectBtn: { backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fecaca', paddingHorizontal: 28, paddingVertical: 12, borderRadius: 10 },
  disconnectBtnText: { color: '#dc2626', fontWeight: '800', fontSize: 11 },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2, marginBottom: 4 },
  editHint: { fontSize: 11, color: '#94a3b8', fontWeight: '500' },
  nameEditRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 8 },
  nameInput: { flex: 1, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 15, fontWeight: '600', color: '#0f172a', backgroundColor: '#f8fafc' },
  nameSaveBtn: { backgroundColor: '#2563eb', paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8 },
  nameSaveBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  colorRow: { flexDirection: 'row', gap: 10, marginTop: 14, marginBottom: 4 },
  colorSwatch: { width: 22, height: 22, borderRadius: 11 },
  colorSwatchSelected: { borderWidth: 2.5, borderColor: '#0f172a' },
});

/* ── Modal styles ── */
const ms = StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  card: {
    width: 320, height: 400,
    backgroundColor: '#fff',
    borderRadius: 24,
    overflow: 'hidden',
  },
  closeBtn: {
    position: 'absolute', top: 16, right: 20, zIndex: 10,
    width: 32, height: 32, alignItems: 'center', justifyContent: 'center',
  },
  closeBtnText: { fontSize: 22, color: '#111', fontWeight: '300', lineHeight: 26 },

  // Idle
  idleContainer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },

  // Radar — absolutely centered in the 320×400 card
  radarContainer: {
    position: 'absolute',
    width: RADAR_SIZE, height: RADAR_SIZE,
    left: (320 - RADAR_SIZE) / 2,
    top: (400 - RADAR_SIZE) / 2,
  },
  radarDevice: { position: 'absolute' },

  // Centre button
  centerBtn: {
    position: 'absolute',
    width: 100, height: 100, borderRadius: 50,
    backgroundColor: '#E8EAF0',
    left: RC - 50, top: RC - 50,
    alignItems: 'center', justifyContent: 'center',
  },
  centerBtnDisabled: { backgroundColor: '#94a3b8' },
  // Non-absolute version for idle — positioned by flexbox in idleContainer
  idleScanBtn: {
    width: 100, height: 100, borderRadius: 50,
    backgroundColor: '#111',
    alignItems: 'center', justifyContent: 'center',
  },
  centerBtnText: { color: '#111111', fontSize: 13, fontWeight: '600' },
  idleScanBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  // Connecting / connected
  phaseContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  largeIcon: { marginBottom: 20 },
  phaseLabel: { fontSize: 13, color: '#94a3b8', fontWeight: '500' },
  phaseLabelConnected: { color: '#16a34a', fontWeight: '700' },
});

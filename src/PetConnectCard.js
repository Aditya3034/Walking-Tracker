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
const RC = RADAR_SIZE / 2;
const DEVICE_SIZE = 50;
const RING_RADII = [90, 110, 120];

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
      loopRef.current?.stop();
      Animated.parallel(
        anims.map(a => Animated.timing(a, { toValue: 1, duration: 300, useNativeDriver: true }))
      ).start();
      return;
    }
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
          borderColor: `rgba(0,0,0,${(4 - i) * 0.03})`,
          left: RC - r, top: RC - r,
          opacity: anims[i],
        }} />
      ))}
    </>
  );
}

export default function PetConnectCard() {
  const [devices, setDevices] = useState([]);
  const [deviceSlots, setDeviceSlots] = useState(() => makeDeviceSlots(0));
  const pendingDevicesRef = useRef([]);
  const revealTimerRef = useRef(null);
  const [connectedDevice, setConnectedDevice] = useState(null);
  const [, setScanning] = useState(false);
  const [, setStatus] = useState('Initializing...');
  const [bluetoothState, setBluetoothState] = useState('Unknown');
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [petName, setPetName] = useState('');
  const [petColor, setPetColor] = useState(PET_COLORS[0]);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const deviceIdRef = useRef('');

  const [modalVisible, setModalVisible] = useState(false);
  const [modalPhase, setModalPhase] = useState('idle');

  const bleSubscriptionRef = useRef(null);
  const btRetryTimeoutRef  = useRef(null);
  const scanTimeoutRef     = useRef(null);
  const wasConnectedRef    = useRef(false);
  const isConnectedRef     = useRef(false);
  const closeTimerRef      = useRef(null);
  const modalPhaseRef      = useRef('idle');

  useEffect(() => { modalPhaseRef.current = modalPhase; }, [modalPhase]);

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
      if (pendingDevicesRef.current.find(d => d.id === device.id)) return;
      pendingDevicesRef.current = [...pendingDevicesRef.current, device];
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
          ? [PERMISSIONS.ANDROID.BLUETOOTH_SCAN, PERMISSIONS.ANDROID.BLUETOOTH_CONNECT, PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION]
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
      setModalPhase('scanning');
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

  /* ── Modal content ── */
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
          <Text style={ms.idleScanBtnText}>{isReady ? 'scan' : 'turn on bluetooth'}</Text>
        </TouchableOpacity>
      </View>
    );
  };

  /* ── Inline card ── */
  return (
    <>
      <View style={cs.card}>
        {connectedDevice ? (
          <>
            <View style={cs.left}>
              <PetIcon size={34} borderColor={petColor} />
              <TouchableOpacity
                style={cs.nameRow}
                onPress={() => { setNameInput(petName || connectedDevice.name); setEditModalVisible(true); }}
              >
                <Text style={cs.petName}>{petName || connectedDevice.name}</Text>
                <Text style={cs.editHint}>  edit</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={cs.disconnectBtn} onPress={disconnectDevice}>
              <Text style={cs.disconnectText}>disconnect</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <View style={cs.left}>
              <PetIcon size={34} borderColor={null} style={{ opacity: 0.45 }} />
              <Text style={cs.connectLabel}>Connect your pet</Text>
            </View>
            <TouchableOpacity style={cs.connectBtn} onPress={openModal} activeOpacity={0.8}>
              <Text style={cs.connectBtnText}>Connect</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Edit modal */}
      <Modal visible={editModalVisible} transparent animationType="fade" onRequestClose={() => setEditModalVisible(false)}>
        <View style={em.backdrop}>
          <View style={em.sheet}>
            <Text style={em.title}>Edit Pet</Text>

            <PetIcon size={64} borderColor={petColor} style={{ marginBottom: 20 }} />

            <Text style={em.label}>Name</Text>
            <TextInput
              style={em.input}
              value={nameInput}
              onChangeText={setNameInput}
              autoFocus
              maxLength={24}
              placeholder="Name your pet"
              placeholderTextColor="#94a3b8"
            />

            <Text style={em.label}>Color</Text>
            <View style={em.colorRow}>
              {PET_COLORS.map(c => (
                <TouchableOpacity
                  key={c}
                  onPress={() => setPetColor(c)}
                  style={[em.swatch, { backgroundColor: c }, petColor === c && em.swatchSelected]}
                />
              ))}
            </View>

            <View style={em.btnRow}>
              <TouchableOpacity style={em.cancelBtn} onPress={() => setEditModalVisible(false)}>
                <Text style={em.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={em.saveBtn}
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
                  const AsyncStorage = require('@react-native-async-storage/async-storage').default;
                  await AsyncStorage.setItem('petColor', petColor).catch(() => {});
                  setEditModalVisible(false);
                }}
              >
                <Text style={em.saveBtnText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

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
    </>
  );
}

/* ── Card styles ── */
const cs = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  connectLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0f172a',
  },
  connectBtn: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 10,
  },
  connectBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  petName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
  },
  editHint: { fontSize: 11, color: '#94a3b8', fontWeight: '500' },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  disconnectBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fef2f2',
  },
  disconnectText: { fontSize: 11, color: '#dc2626', fontWeight: '700' },
});

/* ── Edit modal styles ── */
const em = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheet: {
    width: 320,
    backgroundColor: '#fff',
    borderRadius: 24,
    paddingHorizontal: 28,
    paddingVertical: 28,
    alignItems: 'center',
  },
  title: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0f172a',
    textTransform: 'uppercase',
    marginBottom: 20,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94a3b8',
    textTransform: 'uppercase',
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  input: {
    width: '100%',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    fontWeight: '600',
    color: '#0f172a',
    backgroundColor: '#f8fafc',
    marginBottom: 20,
  },
  colorRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 28,
  },
  swatch: { width: 26, height: 26, borderRadius: 13 },
  swatchSelected: { borderWidth: 3, borderColor: '#0f172a' },
  btnRow: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center',
  },
  cancelBtnText: { fontSize: 14, fontWeight: '600', color: '#64748b' },
  saveBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: '#0f172a',
    alignItems: 'center',
  },
  saveBtnText: { fontSize: 14, fontWeight: '700', color: '#fff' },
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

  idleContainer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },

  radarContainer: {
    position: 'absolute',
    width: RADAR_SIZE, height: RADAR_SIZE,
    left: (320 - RADAR_SIZE) / 2,
    top: (400 - RADAR_SIZE) / 2,
  },
  radarDevice: { position: 'absolute' },

  centerBtn: {
    position: 'absolute',
    width: 100, height: 100, borderRadius: 50,
    backgroundColor: '#E8EAF0',
    left: RC - 50, top: RC - 50,
    alignItems: 'center', justifyContent: 'center',
  },
  centerBtnDisabled: { backgroundColor: '#94a3b8' },
  idleScanBtn: {
    width: 100, height: 100, borderRadius: 50,
    backgroundColor: '#111',
    alignItems: 'center', justifyContent: 'center',
  },
  centerBtnText: { color: '#111111', fontSize: 13, fontWeight: '600' },
  idleScanBtnText: { color: '#fff', fontSize: 11, fontWeight: '600', textAlign: 'center', paddingHorizontal: 10 },

  phaseContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  largeIcon: { marginBottom: 20 },
  phaseLabel: { fontSize: 13, color: '#94a3b8', fontWeight: '500' },
  phaseLabelConnected: { color: '#16a34a', fontWeight: '700' },
});

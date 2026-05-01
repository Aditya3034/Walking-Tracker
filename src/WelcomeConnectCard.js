import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Platform, Alert, Linking, NativeModules,
  ActivityIndicator, Animated, Image, AppState,
} from 'react-native';
import { requestMultiple, PERMISSIONS, RESULTS } from 'react-native-permissions';
import manager from './BleManagerSingleton';

const { StepCounter } = NativeModules;
const APP_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';

export default function WelcomeConnectCard() {
  const [bluetoothState, setBluetoothState] = useState('Unknown');
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [devices, setDevices] = useState([]);
  const [status, setStatus] = useState('Tap scan to find your pet');

  const stateSubRef = useRef(null);
  const scanTimeoutRef = useRef(null);
  const pulseAnim = useRef(new Animated.Value(0)).current;

  /* -------- mount: permissions + BT state -------- */
  useEffect(() => {
    (async () => {
      const granted = await requestBluetoothPermissions();
      setPermissionsGranted(granted);
      if (granted) attachStateListener();
    })();

    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') checkBluetoothState();
    });

    return () => {
      stateSubRef.current?.remove();
      appStateSub?.remove();
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
      manager.stopDeviceScan();
    };
  }, []);

  /* -------- pulse animation while scanning -------- */
  useEffect(() => {
    if (!scanning) {
      pulseAnim.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 1400, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [scanning, pulseAnim]);

  const attachStateListener = () => {
    stateSubRef.current?.remove();
    stateSubRef.current = manager.onStateChange((state) => {
      setBluetoothState(state);
      if (state === 'PoweredOff') {
        setStatus('Bluetooth is off');
        setScanning(false);
        manager.stopDeviceScan();
      } else if (state === 'PoweredOn') {
        setStatus('Tap scan to find your pet');
      }
    }, true);
  };

  const checkBluetoothState = async () => {
    try {
      const state = await manager.state();
      setBluetoothState(state);
    } catch (e) {}
  };

  const requestBluetoothPermissions = async () => {
    try {
      const perms = Platform.OS === 'android'
        ? (Platform.Version >= 31
            ? [PERMISSIONS.ANDROID.BLUETOOTH_SCAN, PERMISSIONS.ANDROID.BLUETOOTH_CONNECT]
            : [PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION])
        : [PERMISSIONS.IOS.BLUETOOTH];
      const results = await requestMultiple(perms);
      return Object.values(results).every(r => r === RESULTS.GRANTED);
    } catch { return false; }
  };

  const openBluetoothSettings = () => {
    Platform.OS === 'android'
      ? Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS').catch(() => Linking.openSettings())
      : Linking.openSettings();
  };

  const startScan = async () => {
    if (!permissionsGranted) {
      const granted = await requestBluetoothPermissions();
      setPermissionsGranted(granted);
      if (!granted) return;
      attachStateListener();
    }
    if (bluetoothState !== 'PoweredOn') {
      Alert.alert('Bluetooth Required', 'Please turn on Bluetooth to scan for devices.',
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Open Settings', onPress: openBluetoothSettings }]);
      return;
    }

    // Auto-unpair any system-bonded softwear-* device so it advertises again
    try { await StepCounter?.unpairExistingPets?.(); } catch {}

    setDevices([]);
    setScanning(true);
    setStatus('Scanning…');

    manager.startDeviceScan([APP_SERVICE_UUID], null, (error, device) => {
      if (error) {
        setScanning(false);
        setStatus('Scan failed');
        return;
      }
      if (!device) return;
      setDevices(prev => prev.find(d => d.id === device.id) ? prev : [...prev, device]);
    });

    scanTimeoutRef.current = setTimeout(() => {
      manager.stopDeviceScan();
      setScanning(false);
      setDevices(prev => {
        setStatus(prev.length > 0 ? `Found ${prev.length} pet${prev.length > 1 ? 's' : ''}` : 'No pets found nearby');
        return prev;
      });
    }, 8000);
  };

  const connectToDevice = async (device) => {
    try {
      manager.stopDeviceScan();
      setScanning(false);
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
      setConnecting(true);
      setStatus('Connecting to your pet…');
      await StepCounter.connectBleDevice(device.id);
      // Remember this BLE address so home-screen scans only show this pet
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        await AsyncStorage.setItem('pairedDeviceId', device.id);
      } catch {}
      // App.js handles the rest: Pet ID read → Firestore check → routing
    } catch (err) {
      setConnecting(false);
      setStatus('Connection failed');
      Alert.alert('Connection Failed', err?.message || 'Could not connect to pet.');
    }
  };

  const buttonLabel = !permissionsGranted
    ? 'Grant permissions'
    : bluetoothState !== 'PoweredOn'
      ? 'Turn on Bluetooth'
      : scanning ? 'Scanning…' : 'Scan for pet';

  const buttonAction = !permissionsGranted
    ? async () => { const g = await requestBluetoothPermissions(); setPermissionsGranted(g); if (g) attachStateListener(); }
    : bluetoothState !== 'PoweredOn'
      ? openBluetoothSettings
      : startScan;

  const buttonDisabled = scanning || connecting;

  const pulseScale = pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 4] });
  const pulseOpacity = pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0] });

  return (
    <View style={styles.container}>
      {/* Pulsing radar */}
      <View style={styles.radarWrap}>
        {scanning && (
          <Animated.View style={[styles.pulse, { transform: [{ scale: pulseScale }], opacity: pulseOpacity }]} />
        )}
        <View style={styles.iconCore}>
          <Image source={require('./assets/swlogo.png')} style={styles.icon} resizeMode="contain" />
        </View>
      </View>

      <Text style={styles.status}>{status}</Text>

      {/* Devices list */}
      {devices.length > 0 && !connecting && (
        <View style={styles.deviceList}>
          {devices.map(d => (
            <TouchableOpacity
              key={d.id}
              style={styles.deviceRow}
              onPress={() => connectToDevice(d)}
              activeOpacity={0.7}
            >
              <Text style={styles.deviceName}>{d.name || 'Unnamed pet'}</Text>
              <Text style={styles.deviceConnect}>Connect</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {connecting && (
        <View style={styles.connecting}>
          <ActivityIndicator color="#0f172a" />
        </View>
      )}

      <TouchableOpacity
        style={[styles.button, buttonDisabled && styles.buttonDisabled]}
        onPress={buttonDisabled ? undefined : buttonAction}
        activeOpacity={buttonDisabled ? 1 : 0.85}
      >
        {scanning
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.buttonText}>{buttonLabel}</Text>}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 24,
    paddingBottom: 36,
    alignItems: 'center',
  },
  radarWrap: {
    width: 160,
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 32,
  },
  pulse: {
    position: 'absolute',
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#2563eb',
  },
  iconCore: {
    width: 88,
    height: 88,
    borderRadius: 22,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 3,
  },
  icon: { width: 56, height: 56 },
  status: {
    fontSize: 14,
    color: '#64748b',
    fontWeight: '500',
    marginBottom: 20,
    textAlign: 'center',
  },
  deviceList: {
    width: '100%',
    gap: 8,
    marginBottom: 16,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  deviceName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0f172a',
  },
  deviceConnect: {
    fontSize: 12,
    fontWeight: '700',
    color: '#2563eb',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  connecting: {
    paddingVertical: 20,
  },
  button: {
    marginTop: 'auto',
    width: '100%',
    backgroundColor: '#0f172a',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  buttonDisabled: {
    backgroundColor: '#94a3b8',
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});

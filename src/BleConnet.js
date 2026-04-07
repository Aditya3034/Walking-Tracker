import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Platform, ActivityIndicator, Alert, Linking, NativeModules, NativeEventEmitter, ToastAndroid,
} from 'react-native';
import { requestMultiple, PERMISSIONS, RESULTS } from 'react-native-permissions';
import BleStepService from './BleStepService';
import manager from './BleManagerSingleton';

const { StepCounter } = NativeModules;
const nativeEmitter = StepCounter ? new NativeEventEmitter(StepCounter) : null;

// Filter scan to only show our pet device
const APP_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';

const C = {
  bg: '#f8fafc', card: '#ffffff', primary: '#2563eb', success: '#16a34a',
  warning: '#d97706', danger: '#dc2626', text: '#0f172a', text2: '#475569',
  text3: '#94a3b8', border: '#e2e8f0', amber: '#fef3c7', amberBorder: '#f59e0b',
  green: '#f0fdf4',
};

export default function BleConnect() {
  const [devices, setDevices] = useState([]);
  const [connectedDevice, setConnectedDevice] = useState(null); // { id, name }
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState('Initializing...');
  const [bluetoothState, setBluetoothState] = useState('Unknown');
  const [permissionsGranted, setPermissionsGranted] = useState(false);

  const bleSubscriptionRef = useRef(null);
  const btRetryTimeoutRef  = useRef(null);
  const scanTimeoutRef     = useRef(null);
  const wasConnectedRef    = useRef(false);
  const isConnectedRef     = useRef(false);

  /* -------- BLE state listener -------- */
  const setupBluetooth = async () => {
    bleSubscriptionRef.current?.remove();
    bleSubscriptionRef.current = manager.onStateChange((state) => {
      setBluetoothState(state);
      if (isConnectedRef.current) return; // never overwrite 'Connected' status
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
    initializeBluetooth();

    // Ask native service to re-emit current BLE + hunger state — handles app reopen
    // BleConnectionUpdate listener below will update UI when the event fires
    StepCounter?.queryBleState?.()?.catch?.(() => {});

    // Listen for native connection updates (fires on connect, disconnect, and queryBleState)
    const connSub = nativeEmitter?.addListener('BleConnectionUpdate', async (state) => {
      if (state === 'connected') {
        wasConnectedRef.current = true;
        isConnectedRef.current = true;
        BleStepService.isConnectedState = true;
        // Restore persisted name if JS-side name was lost (app reopen)
        if (!BleStepService.deviceName) {
          const AsyncStorage = require('@react-native-async-storage/async-storage').default;
          const saved = await AsyncStorage.getItem('bleDeviceName').catch(() => null);
          BleStepService.deviceName = saved || 'Pet Locket';
        }
        setConnectedDevice({ id: '', name: BleStepService.deviceName });
        setStatus('Connected');
      } else {
        const shouldToast = wasConnectedRef.current;
        wasConnectedRef.current = false;
        isConnectedRef.current = false;
        BleStepService.isConnectedState = false;
        setConnectedDevice(null);
        setDevices([]); // clear stale scan results so old device isn't tappable
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
    setScanning(true);
    setStatus('Scanning...');

    // Filter by service UUID so only PetLocket devices appear
    manager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        console.error('Scan error:', error);
        setScanning(false);
        if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
        setStatus('Scan failed');
        return;
      }
      if (!device) return;
      setDevices(prev => {
        if (prev.find(d => d.id === device.id)) return prev;
        return [...prev, device];
      });
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
      console.error('Permission error:', err);
      return false;
    }
  };

  const connectToDevice = async (device) => {
    try {
      manager.stopDeviceScan();
      setScanning(false);
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
      setStatus('Connecting...');

      const name = device.name || device.id;

      // Hand off to native service — it owns the connection from here
      await StepCounter.connectBleDevice(device.id);

      // Persist name so it survives app reopen
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      await AsyncStorage.setItem('bleDeviceName', name).catch(() => {});

      wasConnectedRef.current = true;
      isConnectedRef.current = true;
      BleStepService.setDeviceName(name);
      setConnectedDevice({ id: device.id, name });
      setStatus('Connected');
    } catch (err) {
      console.error('Connection failed:', err);
      setStatus('Connection failed');
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

  const isReady = permissionsGranted && bluetoothState === 'PoweredOn';
  const displayStatus = connectedDevice ? 'Connected' : status;
  const isStatusGood = !!connectedDevice || isReady;

  return (
    <View style={styles.container}>
      {/* Status Header */}
      <View style={[styles.statusHeader, isStatusGood ? styles.statusReady : styles.statusNotReady]}>
        <View style={[styles.statusDot, { backgroundColor: isStatusGood ? C.success : C.warning }]} />
        <Text style={[styles.statusText, { color: isStatusGood ? C.success : C.warning }]}>{displayStatus}</Text>
      </View>

      {/* Warnings */}
      {bluetoothState !== 'PoweredOn' && bluetoothState !== 'Unknown' && (
        <View style={styles.warningCard}>
          <View style={styles.warningRow}>
            <View style={[styles.warnDot, { backgroundColor: C.warning }]} />
            <Text style={styles.warningText}>Bluetooth is {bluetoothState}</Text>
          </View>
          <TouchableOpacity style={styles.warningButton} onPress={openBluetoothSettings}>
            <Text style={styles.warningButtonText}>OPEN SETTINGS</Text>
          </TouchableOpacity>
        </View>
      )}

      {!permissionsGranted && (
        <View style={styles.warningCard}>
          <View style={styles.warningRow}>
            <View style={[styles.warnDot, { backgroundColor: C.warning }]} />
            <Text style={styles.warningText}>Permissions not granted</Text>
          </View>
          <TouchableOpacity
            style={styles.warningButton}
            onPress={async () => {
              const granted = await requestBluetoothPermissions();
              setPermissionsGranted(granted);
              if (granted) await setupBluetooth();
            }}
          >
            <Text style={styles.warningButtonText}>GRANT PERMISSIONS</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Connected or Scan UI */}
      {connectedDevice ? (
        <View style={styles.connectedContainer}>
          <View style={styles.connectedCard}>
            <View style={styles.connectedIconRing}>
              <View style={styles.connectedIconDot} />
            </View>
            <Text style={styles.connectedTitle}>Device Connected</Text>
            <Text style={styles.connectedName}>{connectedDevice.name}</Text>
            <Text style={styles.connectedInfo}>
              Connection is maintained in the background
            </Text>
            <TouchableOpacity style={styles.disconnectButton} onPress={disconnectDevice}>
              <Text style={styles.disconnectButtonText}>DISCONNECT</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <>
          <TouchableOpacity
            style={[styles.scanButton, (!isReady || scanning) && styles.scanButtonDisabled]}
            onPress={startScan}
            disabled={!isReady || scanning}
          >
            {scanning ? (
              <View style={styles.scanButtonInner}>
                <ActivityIndicator size="small" color="#fff" style={{ marginRight: 10 }} />
                <Text style={styles.scanButtonText}>SCANNING</Text>
              </View>
            ) : (
              <Text style={styles.scanButtonText}>SCAN FOR DEVICES</Text>
            )}
          </TouchableOpacity>

          <FlatList
            data={devices}
            keyExtractor={item => item.id}
            contentContainerStyle={styles.listContainer}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.deviceCard} onPress={() => connectToDevice(item)} activeOpacity={0.7}>
                <View style={styles.deviceIconBox}><View style={styles.deviceIconDot} /></View>
                <View style={styles.deviceInfo}>
                  <Text style={styles.deviceName}>{item.name || 'Unknown Device'}</Text>
                  <Text style={styles.deviceId}>{item.id.substring(0, 20)}...</Text>
                </View>
                <Text style={styles.deviceArrow}>›</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              !scanning ? (
                <View style={styles.emptyContainer}>
                  <View style={styles.emptyIconBox}>
                    <View style={styles.emptySignalBar} />
                    <View style={[styles.emptySignalBar, { height: 10 }]} />
                    <View style={[styles.emptySignalBar, { height: 16 }]} />
                  </View>
                  <Text style={styles.emptyTitle}>No Devices Found</Text>
                  <Text style={styles.emptyText}>
                    {isReady ? 'Tap "Scan for Devices" to find your Pet Locket' : 'Enable Bluetooth and grant permissions first'}
                  </Text>
                </View>
              ) : null
            }
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  statusHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: C.border, gap: 8 },
  statusReady: { backgroundColor: C.green },
  statusNotReady: { backgroundColor: '#fffbeb' },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase' },
  warningCard: { backgroundColor: '#fffbeb', margin: 16, padding: 16, borderRadius: 12, borderLeftWidth: 3, borderLeftColor: C.amberBorder },
  warningRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 },
  warnDot: { width: 8, height: 8, borderRadius: 4 },
  warningText: { fontSize: 13, color: '#92400e', fontWeight: '600' },
  warningButton: { backgroundColor: C.amberBorder, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center' },
  warningButtonText: { color: '#fff', fontWeight: '800', fontSize: 11, letterSpacing: 1.5 },
  scanButton: { backgroundColor: C.primary, margin: 16, paddingVertical: 18, borderRadius: 12, alignItems: 'center', elevation: 3, shadowColor: C.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8 },
  scanButtonDisabled: { backgroundColor: C.text3, shadowColor: '#000', shadowOpacity: 0.05 },
  scanButtonInner: { flexDirection: 'row', alignItems: 'center' },
  scanButtonText: { color: '#fff', fontSize: 13, fontWeight: '800', letterSpacing: 2 },
  listContainer: { paddingHorizontal: 16, paddingTop: 4 },
  deviceCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, padding: 16, borderRadius: 12, marginBottom: 10, borderWidth: 1, borderColor: C.border, elevation: 1 },
  deviceIconBox: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#eff6ff', alignItems: 'center', justifyContent: 'center', marginRight: 14, borderWidth: 1, borderColor: '#bfdbfe' },
  deviceIconDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: C.primary },
  deviceInfo: { flex: 1 },
  deviceName: { fontSize: 15, fontWeight: '700', color: C.text, marginBottom: 3 },
  deviceId: { fontSize: 11, color: C.text3, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  deviceArrow: { fontSize: 22, color: C.text3, fontWeight: '300' },
  emptyContainer: { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 40 },
  emptyIconBox: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, marginBottom: 20, opacity: 0.25 },
  emptySignalBar: { width: 8, height: 6, borderRadius: 2, backgroundColor: C.text },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: C.text2, marginBottom: 8 },
  emptyText: { fontSize: 13, color: C.text3, textAlign: 'center', lineHeight: 20 },
  connectedContainer: { flex: 1, justifyContent: 'center', padding: 24 },
  connectedCard: { backgroundColor: C.card, padding: 36, borderRadius: 20, alignItems: 'center', borderWidth: 1, borderColor: C.border, elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 12 },
  connectedIconRing: { width: 72, height: 72, borderRadius: 36, backgroundColor: C.green, borderWidth: 2, borderColor: '#bbf7d0', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  connectedIconDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.success },
  connectedTitle: { fontSize: 18, fontWeight: '800', color: C.success, marginBottom: 6, letterSpacing: 0.5 },
  connectedName: { fontSize: 15, color: C.text, marginBottom: 10, fontWeight: '600' },
  connectedInfo: { fontSize: 13, color: C.text3, textAlign: 'center', marginBottom: 28, lineHeight: 20 },
  disconnectButton: { backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fecaca', paddingHorizontal: 32, paddingVertical: 13, borderRadius: 10 },
  disconnectButtonText: { color: C.danger, fontWeight: '800', fontSize: 12, letterSpacing: 1.5 },
});

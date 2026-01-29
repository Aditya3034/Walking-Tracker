import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  PermissionsAndroid,
  Platform,
  ActivityIndicator,
  Alert,
  // ScrollView,
  Linking,
} from 'react-native';
import { Buffer } from 'buffer';
import BleStepService from './BleStepService';
import RNAndroidLocationEnabler from 'react-native-android-location-enabler';

import manager from './BleManagerSingleton';

const APP_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

export default function BleConnect() {
  const [devices, setDevices] = useState([]);
  const [connectedDevice, setConnectedDevice] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState('Initializing...');
  const [bluetoothState, setBluetoothState] = useState('Unknown');
  const [permissionsGranted, setPermissionsGranted] = useState(false);

useEffect(() => {
  initializeBluetooth();

  // Restore connection state if already connected
  const status = BleStepService.getTrackingStatus();
  if (status.hasDevice && BleStepService.connectedDevice) {
    setConnectedDevice(BleStepService.connectedDevice);
    setStatus('Connected');
  }

  return () => {
    manager.stopDeviceScan();
  };
}, []);



  // const initializeBluetooth = async () => {
  //   const hasPermissions = await requestBluetoothPermissions();
  //   setPermissionsGranted(hasPermissions);

  //   if (!hasPermissions) {
  //     setStatus('Permissions required');
  //     return;
  //   }

  //   const state = await manager.state();
  //   setBluetoothState(state);

  //   if (state !== 'PoweredOn') {
  //     setStatus('Turn on Bluetooth');
  //   } else {
  //     setStatus('Ready to scan');
  //   }

  //   const subscription = manager.onStateChange((state) => {
  //     setBluetoothState(state);

  //     if (state === 'PoweredOn') {
  //       setStatus('Ready to scan');
  //     } else if (state === 'PoweredOff') {
  //       setStatus('Bluetooth is OFF');
  //       setScanning(false);
  //       manager.stopDeviceScan();
  //     }
  //   }, true);

  //   return () => subscription.remove();
  // };
  const initializeBluetooth = async () => {
    const hasPermissions = await requestBluetoothPermissions();
    setPermissionsGranted(hasPermissions);

    if (!hasPermissions) {
      setStatus('Permissions required');
      return;
    }

    // Check Bluetooth state with retry
    await checkBluetoothState();

    // Listen for Bluetooth state changes
    const subscription = manager.onStateChange((state) => {
      console.log('Bluetooth state changed:', state);
      setBluetoothState(state);

      if (state === 'PoweredOn') {
        setStatus('Ready to scan');
      } else if (state === 'PoweredOff') {
        setStatus('Bluetooth is OFF');
        setScanning(false);
        manager.stopDeviceScan();
      }
    }, true); // true = emit current state immediately

    return () => subscription.remove();
  };

  const checkBluetoothState = async () => {
    try {
      // Wait a bit for manager to initialize
      await new Promise(resolve => setTimeout(resolve, 500));

      const state = await manager.state();
      console.log('Current Bluetooth state:', state);
      setBluetoothState(state);

      if (state === 'PoweredOn') {
        setStatus('Ready to scan');
      } else if (state === 'PoweredOff') {
        setStatus('Turn on Bluetooth');
      } else {
        // For other states like 'Unknown', retry once
        setTimeout(async () => {
          const retryState = await manager.state();
          console.log('Retry Bluetooth state:', retryState);
          setBluetoothState(retryState);
          if (retryState === 'PoweredOn') {
            setStatus('Ready to scan');
          } else {
            setStatus('Turn on Bluetooth');
          }
        }, 1000);
      }
    } catch (error) {
      console.error('Error checking Bluetooth state:', error);
      setStatus('Bluetooth check failed');
    }
  };

  const openBluetoothSettings = () => {
    // For Android, we need to use native methods
    if (Platform.OS === 'android') {
      Alert.alert(
        'Enable Bluetooth',
        'Please enable Bluetooth from your device settings.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Open Settings',
            // onPress: () => {
            //   // This will work on Android
            //   const { NativeModules } = require('react-native');
            //   if (NativeModules.IntentLauncher) {
            //     NativeModules.IntentLauncher.openSettings();
            //   } else {
            //     // Fallback: use Linking
            //     import('react-native').then(({ Linking }) => {
            //       Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS');
            //     });
            //   }
            // }
            onPress: () => {
              Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS')
                .catch(() => {
                  // Fallback to general settings
                  Linking.openSettings();
                });
            }
          }
        ]
      );
    }
  };

  const ensureLocationEnabled = async () => {
    try {
      await RNAndroidLocationEnabler.promptForEnableLocationIfNeeded({
        interval: 10000,
        fastInterval: 5000,
      });
      return true;
    } catch {
      return false;
    }
  };

  const startScan = async () => {
    if (!permissionsGranted) {
      const hasPermissions = await requestBluetoothPermissions();
      setPermissionsGranted(hasPermissions);
      if (!hasPermissions) return;
      const locationEnabled = await ensureLocationEnabled();
      if (!locationEnabled) {
        Alert.alert('Location Required', 'Please enable location services');
        return;
      }
    }

    // Re-check Bluetooth state before scanning
    const state = await manager.state();
    console.log('Bluetooth state before scan:', state);

    if (state !== 'PoweredOn') {
      Alert.alert(
        'Bluetooth Required',
        'Please turn on Bluetooth to scan for devices.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: openBluetoothSettings }
        ]
      );
      return;
    }

    setDevices([]);
    setScanning(true);
    setStatus('Scanning...');
    console.log('🔍 Starting BLE scan...');

    manager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        console.error('Scan error:', error);
        setScanning(false);
        setStatus('Scan failed');
        return;
      }

      if (!device) return;

      console.log('Found device:', device.name || 'Unknown', device.id);

      setDevices(prev => {
        if (prev.find(d => d.id === device.id)) return prev;
        return [...prev, device];
      });
    });

    setTimeout(() => {
      manager.stopDeviceScan();
      setScanning(false);
      console.log('Scan stopped');
      setStatus('Scan complete');
    }, 10000);
  };
  const requestBluetoothPermissions = async () => {
    if (Platform.OS !== 'android') return true;

    try {
      const apiLevel = Platform.Version;
      let permissions = [];

      if (apiLevel >= 31) {
        permissions = [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ];
      } else if (apiLevel >= 29) {
        permissions = [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
      } else {
        permissions = [PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION];
      }

      const results = await PermissionsAndroid.requestMultiple(permissions);
      const allGranted = Object.values(results).every(
        result => result === PermissionsAndroid.RESULTS.GRANTED
      );

      if (!allGranted) {
        Alert.alert(
          'Permissions Required',
          'Please grant Bluetooth and Location permissions.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Retry', onPress: () => requestBluetoothPermissions() }
          ]
        );
        return false;
      }

      return true;
    } catch (err) {
      console.error('Permission error:', err);
      return false;
    }
  };

  // const startScan = async () => {
  //   if (!permissionsGranted) {
  //     const hasPermissions = await requestBluetoothPermissions();
  //     setPermissionsGranted(hasPermissions);
  //     if (!hasPermissions) return;
  //   }

  //   const state = await manager.state();
  //   if (state !== 'PoweredOn') {
  //     Alert.alert(
  //       'Bluetooth Required',
  //       'Please turn on Bluetooth',
  //       [
  //         { text: 'Cancel', style: 'cancel' },
  //         {
  //           text: 'Enable',
  //           onPress: async () => {
  //             try {
  //               await manager.enable();
  //             } catch (err) {
  //               console.log('Enable error:', err);
  //             }
  //           }
  //         }
  //       ]
  //     );
  //     return;
  //   }

  //   setDevices([]);
  //   setScanning(true);
  //   setStatus('Scanning...');

  //   manager.startDeviceScan(null, null, (error, device) => {
  //     if (error) {
  //       console.error('Scan error:', error);
  //       setScanning(false);
  //       setStatus('Scan failed');
  //       return;
  //     }

  //     if (!device) return;

  //     setDevices(prev => {
  //       if (prev.find(d => d.id === device.id)) return prev;
  //       return [...prev, device];
  //     });
  //   });

  //   setTimeout(() => {
  //     manager.stopDeviceScan();
  //     setScanning(false);
  //     setStatus(devices.length > 0 ? 'Scan complete' : 'No devices found');
  //   }, 10000);
  // };

  const connectToDevice = async (device) => {
    try {
      manager.stopDeviceScan();
      setScanning(false);
      setStatus(`Connecting...`);

      const connected = await device.connect();
      await connected.discoverAllServicesAndCharacteristics();

      const services = await connected.services();
      const hasPetLocketService = services.some(
        s => s.uuid.toLowerCase() === APP_SERVICE_UUID.toLowerCase()
      );

      if (!hasPetLocketService) {
        setStatus('Wrong device');
        await connected.cancelConnection();
        Alert.alert('Wrong Device', 'This is not a Pet Locket device.');
        return;
      }

      await connected.writeCharacteristicWithResponseForService(
        APP_SERVICE_UUID,
        CHARACTERISTIC_UUID,
        Buffer.from('CONNECTED').toString('base64')
      );

      BleStepService.setConnectedDevice(connected);
      setConnectedDevice(connected);
      setStatus('Connected');
    } catch (err) {
      console.error('Connection failed:', err);
      setStatus('Connection failed');
      Alert.alert('Connection Failed', err.message);
    }
  };

  const disconnectDevice = async () => {
    if (connectedDevice) {
      try {
        BleStepService.clearDevice();
        await connectedDevice.cancelConnection();
        setConnectedDevice(null);
        setStatus('Disconnected');
      } catch (err) {
        console.error('Disconnect failed:', err);
      }
    }
  };

  const isReady = permissionsGranted && bluetoothState === 'PoweredOn';

  return (
    <View style={styles.container}>
      {/* Status Header */}
      <View style={[styles.statusHeader, isReady ? styles.statusReady : styles.statusNotReady]}>
        <Text style={styles.statusIcon}>{isReady ? '✅' : '⚠️'}</Text>
        <Text style={styles.statusText}>{status}</Text>
      </View>

      {/* Warnings */}
      {/* Warnings */}
      {bluetoothState !== 'PoweredOn' && bluetoothState !== 'Unknown' && (
        <View style={styles.warningCard}>
          <Text style={styles.warningText}>⚠️ Bluetooth is {bluetoothState}</Text>
          <TouchableOpacity
            style={styles.warningButton}
            onPress={openBluetoothSettings}
          >
            <Text style={styles.warningButtonText}>Open Bluetooth Settings</Text>
          </TouchableOpacity>
        </View>
      )}

      {!permissionsGranted && (
        <View style={styles.warningCard}>
          <Text style={styles.warningText}>⚠️ Permissions not granted</Text>
          <TouchableOpacity
            style={styles.warningButton}
            onPress={async () => {
              const granted = await requestBluetoothPermissions();
              setPermissionsGranted(granted);
            }}
          >
            <Text style={styles.warningButtonText}>Grant Permissions</Text>
          </TouchableOpacity>
        </View>
      )}
      {/* Connected Device or Scan UI */}
      {connectedDevice ? (
        <View style={styles.connectedContainer}>
          <View style={styles.connectedCard}>
            <Text style={styles.connectedIcon}>✅</Text>
            <Text style={styles.connectedTitle}>Device Connected</Text>
            <Text style={styles.connectedName}>
              {connectedDevice.name || connectedDevice.id}
            </Text>
            <Text style={styles.connectedInfo}>
              You can now track steps in the Tracker tab
            </Text>
            <TouchableOpacity
              style={styles.disconnectButton}
              onPress={disconnectDevice}
            >
              <Text style={styles.disconnectButtonText}>Disconnect</Text>
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
            <Text style={styles.scanButtonText}>
              {scanning ? '🔄 Scanning...' : '🔍 Scan for Devices'}
            </Text>
          </TouchableOpacity>

          {scanning && (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#2196f3" />
              <Text style={styles.loadingText}>Looking for devices...</Text>
            </View>
          )}

          <FlatList
            data={devices}
            keyExtractor={item => item.id}
            contentContainerStyle={styles.listContainer}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.deviceCard}
                onPress={() => connectToDevice(item)}
              >
                <View style={styles.deviceIcon}>
                  <Text style={styles.deviceIconText}>📱</Text>
                </View>
                <View style={styles.deviceInfo}>
                  <Text style={styles.deviceName}>
                    {item.name || 'Unknown Device'}
                  </Text>
                  <Text style={styles.deviceId}>{item.id.substring(0, 20)}...</Text>
                </View>
                <Text style={styles.deviceArrow}>›</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              !scanning ? (
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyIcon}>📡</Text>
                  <Text style={styles.emptyText}>
                    {isReady
                      ? 'Tap "Scan for Devices" to find your Pet Locket'
                      : 'Enable Bluetooth and grant permissions first'}
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
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  statusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  statusReady: {
    backgroundColor: '#f0fdf4',
  },
  statusNotReady: {
    backgroundColor: '#fffbeb',
  },
  statusIcon: {
    fontSize: 20,
    marginRight: 8,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2c3e50',
  },
  warningCard: {
    backgroundColor: '#fff3cd',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#f39c12',
  },
  warningText: {
    fontSize: 14,
    color: '#856404',
    marginBottom: 12,
    fontWeight: '600',
  },
  warningButton: {
    backgroundColor: '#f39c12',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  warningButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  scanButton: {
    backgroundColor: '#2196f3',
    margin: 16,
    padding: 18,
    borderRadius: 12,
    alignItems: 'center',
    elevation: 3,
    shadowColor: '#2196f3',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  scanButtonDisabled: {
    backgroundColor: '#ccc',
    shadowColor: '#000',
  },
  scanButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#666',
  },
  listContainer: {
    padding: 16,
  },
  deviceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  deviceIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#e3f2fd',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  deviceIconText: {
    fontSize: 24,
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#2c3e50',
    marginBottom: 4,
  },
  deviceId: {
    fontSize: 12,
    color: '#95a5a6',
  },
  deviceArrow: {
    fontSize: 24,
    color: '#ccc',
  },
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyIcon: {
    fontSize: 64,
    marginBottom: 16,
    opacity: 0.3,
  },
  emptyText: {
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  connectedContainer: {
    flex: 1,
    justifyContent: 'center',
    padding: 20,
  },
  connectedCard: {
    backgroundColor: '#fff',
    padding: 32,
    borderRadius: 16,
    alignItems: 'center',
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  connectedIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  connectedTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#27ae60',
    marginBottom: 8,
  },
  connectedName: {
    fontSize: 16,
    color: '#2c3e50',
    marginBottom: 12,
    fontWeight: '600',
  },
  connectedInfo: {
    fontSize: 14,
    color: '#7f8c8d',
    textAlign: 'center',
    marginBottom: 24,
  },
  disconnectButton: {
    backgroundColor: '#e74c3c',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 10,
  },
  disconnectButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
  },
});


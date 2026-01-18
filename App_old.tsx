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
} from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

const manager = new BleManager();

// esp32 uuid whitelist
const APP_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

export default function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState('Idle');

  useEffect(() => {
    requestPermissionsAndScan();

    return () => {
      manager.stopDeviceScan();
      if (connectedDevice) {
        connectedDevice.cancelConnection().catch(() => {});
      }
      manager.destroy();
    };
  }, [connectedDevice]);

  const requestPermissionsAndScan = async () => {
    if (Platform.OS === 'android') {
      await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
    }

    startScan();
  };

  const startScan = () => {
    setDevices([]);
    setScanning(true);
    setStatus('Scanning for devices...');
    console.log('🔍 Scanning for BLE devices');

    manager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        console.error('Scan error:', error);
        setScanning(false);
        return;
      }

      if (!device) return;

      setDevices(prev => {
        if (prev.find(d => d.id === device.id)) return prev;
        return [...prev, device];
      });
    });
  };

  const connectToDevice = async (device: Device) => {
    try {
      manager.stopDeviceScan();
      setScanning(false);
      setStatus(`Connecting to ${device.name || device.id}...`);

      console.log('🔗 Connecting to', device.name || device.id);

      const connected = await device.connect();
      await connected.discoverAllServicesAndCharacteristics();

      const services = await connected.services();
      console.log(
        '🧩 Services:',
        services.map(s => s.uuid)
      );

      const hasPetLocketService = services.some(
        s => s.uuid.toLowerCase() === APP_SERVICE_UUID.toLowerCase()
      );

      if (!hasPetLocketService) {
        console.log('❌ Not a Pet Locket device');
        setStatus('Not a Pet Locket device');
        await connected.cancelConnection();
        return;
      }

      // send message to chip
      await connected.writeCharacteristicWithResponseForService(
        APP_SERVICE_UUID,
        CHARACTERISTIC_UUID,
        Buffer.from('CONNECTED').toString('base64')
      );

      console.log('📤 Sent CONNECTED to ESP32');

      setConnectedDevice(connected);
      setStatus('🐾 Pet Locket Connected');
    } catch (err) {
      console.error('❌ Connection failed:', err);
      setStatus('Connection failed');
    }
  };

  const disconnectDevice = async () => {
    if (connectedDevice) {
      try {
        await connectedDevice.cancelConnection();
        setConnectedDevice(null);
        setStatus('Disconnected');
        startScan();
      } catch (err) {
        console.error('❌ Disconnect failed:', err);
      }
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>🐾 Pet Locket BLE</Text>
      <Text style={styles.status}>{status}</Text>

      {!connectedDevice ? (
        <>
          {scanning && <ActivityIndicator size="large" />}

          <FlatList
            data={devices}
            keyExtractor={item => item.id}
            contentContainerStyle={{ paddingTop: 12 }}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.deviceCard}
                onPress={() => connectToDevice(item)}
              >
                <Text style={styles.deviceName}>
                  {item.name || 'Unknown Device'}
                </Text>
                <Text style={styles.deviceId}>{item.id}</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              !scanning ? (
                <Text style={styles.empty}>No devices found</Text>
              ) : null
            }
          />
        </>
      ) : (
        <View style={styles.connectedBox}>
          <Text style={styles.connectedTitle}>✅ Connected</Text>
          <Text>{connectedDevice.name || connectedDevice.id}</Text>
          <TouchableOpacity
            style={styles.disconnectButton}
            onPress={disconnectDevice}
          >
            <Text style={styles.disconnectButtonText}>Disconnect</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#ffffff',
    color: '#333',
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 6,
  },
  status: {
    fontSize: 14,
    color: '#555',
    marginBottom: 12,
  },
  deviceCard: {
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#7f9cfdff',
    marginBottom: 10,
  },
  deviceName: {
    fontSize: 16,
    fontWeight: '600',
  },
  deviceId: {
    fontSize: 12,
    color: '#555',
    marginTop: 4,
  },
  empty: {
    textAlign: 'center',
    marginTop: 40,
    color: '#888',
  },
  connectedBox: {
    marginTop: 40,
    padding: 20,
    borderRadius: 14,
    backgroundColor: '#dcfce7',
    alignItems: 'center',
  },
  connectedTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 6,
    color: '#16a34a',
  },
  disconnectButton: {
    marginTop: 14,
    paddingVertical: 10,
    paddingHorizontal: 20,
    backgroundColor: '#ef4444',
    borderRadius: 8,
  },
  disconnectButtonText: {
    color: '#ffffff',
    fontWeight: '600',
    textAlign: 'center',
  },
});
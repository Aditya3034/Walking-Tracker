import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Alert, ActivityIndicator,
  NativeModules,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import auth from '@react-native-firebase/auth';

const { StepCounter } = NativeModules;

const KEYS_TO_CLEAR = [
  'petId',
  'username',
  'petName',
  'petColor',
  'petNameChanged',
  'bleDeviceName',
  'pairedDeviceId',
  'activities',
  'lastSyncAt',
  'sessionInProgress',
  'sessionDuration',
];

export default function SettingsScreen({ visible, onClose, onLogout }) {
  const [loggingOut, setLoggingOut] = useState(false);

  const confirmLogout = () => {
    Alert.alert(
      'Log out?',
      'You\'ll need to reconnect your pet to sign back in. Local data will be cleared, but anything synced to the cloud is safe.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Log out', style: 'destructive', onPress: doLogout },
      ]
    );
  };

  const doLogout = async () => {
    setLoggingOut(true);
    try {
      try { await StepCounter?.disconnectBleDevice?.(); } catch {}
      try { await auth().signOut(); } catch {}
      await AsyncStorage.multiRemove(KEYS_TO_CLEAR);
      onLogout?.();
    } catch (e) {
      Alert.alert('Logout failed', 'Please try again.');
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Settings</Text>
          <TouchableOpacity onPress={onClose} hitSlop={10}>
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.body}>
          <TouchableOpacity
            style={[styles.row, loggingOut && styles.rowDisabled]}
            onPress={loggingOut ? undefined : confirmLogout}
            activeOpacity={0.7}
          >
            {loggingOut
              ? <ActivityIndicator color="#dc2626" />
              : <Text style={styles.rowDanger}>Log out</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0f172a',
    letterSpacing: -0.3,
  },
  close: {
    fontSize: 22,
    color: '#64748b',
    paddingHorizontal: 4,
  },
  body: { padding: 16 },
  row: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#fee2e2',
    paddingVertical: 16,
    paddingHorizontal: 18,
    borderRadius: 12,
    alignItems: 'center',
  },
  rowDisabled: { opacity: 0.6 },
  rowDanger: {
    fontSize: 14,
    fontWeight: '700',
    color: '#dc2626',
    letterSpacing: 0.3,
  },
});

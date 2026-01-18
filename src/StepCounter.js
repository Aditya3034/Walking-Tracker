import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, PermissionsAndroid,
  Platform, NativeModules, NativeEventEmitter, Alert, ScrollView
} from 'react-native';
import BleStepService from './BleStepService';

const { StepCounter } = NativeModules;
const eventEmitter = new NativeEventEmitter(StepCounter);

export default function WalkingTrackerScreen() {
  const [steps, setSteps] = useState(0);
  const [isTracking, setIsTracking] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [bleStatus, setBleStatus] = useState('No device');

  useEffect(() => {
    const subscription = eventEmitter.addListener('StepCounterUpdate', (data) => {
      setSteps(Math.round(data));
    });
    return () => subscription?.remove();
  }, []);

  useEffect(() => {
    requestAllPermissions();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const status = BleStepService.getTrackingStatus();
      if (status.hasDevice) {
        setBleStatus(`Connected: ${status.deviceName}`);
      } else {
        setBleStatus('No device connected');
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const requestAllPermissions = async () => {
    if (Platform.OS !== 'android') {
      setStatus('Ready');
      return true;
    }

    const permissions = [];

    if (Platform.Version >= 33) {
      permissions.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    }

    if (Platform.Version >= 29) {
      permissions.push(PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION);
    }

    if (permissions.length === 0) {
      setStatus('Ready');
      return true;
    }

    try {
      const results = await PermissionsAndroid.requestMultiple(permissions);
      
      const allGranted = Object.values(results).every(
        result => result === PermissionsAndroid.RESULTS.GRANTED
      );

      if (allGranted) {
        setStatus('Ready');
        return true;
      } else {
        setStatus('Permissions needed');
        Alert.alert(
          'Permissions Required',
          'Please grant all permissions for step tracking.',
          [{ text: 'OK' }]
        );
        return false;
      }
    } catch (err) {
      console.error('Permission error:', err);
      setStatus('Permission error');
      return false;
    }
  };

  const toggleTracking = async () => {
    try {
      if (isTracking) {
        BleStepService.stopStepTracking();
        await StepCounter.stopBackgroundService();
        StepCounter.stopStepCounter();
        setIsTracking(false);
        setStatus('Stopped');
      } else {
        const granted = await requestAllPermissions();
        if (!granted) {
          Alert.alert('Permissions Required', 'Please enable all permissions');
          return;
        }

        StepCounter.startStepCounter();
        BleStepService.startStepTracking();

        try {
          await StepCounter.startBackgroundService();
          setIsTracking(true);
          setStatus('Tracking');
        } catch (error) {
          console.error('Service start error:', error);
          BleStepService.stopStepTracking();
          Alert.alert(
            'Service Start Failed',
            'Please keep app open while starting',
            [{
              text: 'OK',
              onPress: () => {
                StepCounter.stopStepCounter();
                setStatus('Failed');
              }
            }]
          );
        }
      }
    } catch (error) {
      console.error('Tracking error:', error);
      BleStepService.stopStepTracking();
      Alert.alert('Error', error.message || 'Failed to toggle tracking');
    }
  };

  const hasDevice = bleStatus.includes('Connected');

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      {/* Connection Status Card */}
      <View style={[styles.card, hasDevice ? styles.cardSuccess : styles.cardWarning]}>
        <Text style={styles.cardIcon}>{hasDevice ? '✅' : '⚠️'}</Text>
        <View style={styles.cardContent}>
          <Text style={styles.cardTitle}>Device Status</Text>
          <Text style={styles.cardText}>{bleStatus}</Text>
        </View>
      </View>

      {/* Steps Display */}
      <View style={styles.stepsCard}>
        <Text style={styles.stepsNumber}>{steps.toLocaleString()}</Text>
        <Text style={styles.stepsLabel}>Steps Today</Text>
        
        {/* Status Badge */}
        <View style={[styles.statusBadge, isTracking && styles.statusBadgeActive]}>
          <View style={[styles.statusDot, isTracking && styles.statusDotActive]} />
          <Text style={[styles.statusText, isTracking && styles.statusTextActive]}>
            {status}
          </Text>
        </View>
      </View>

      {/* Action Button */}
      <TouchableOpacity
        style={[styles.actionButton, isTracking && styles.actionButtonStop]}
        onPress={toggleTracking}
        activeOpacity={0.8}
      >
        <Text style={styles.actionButtonIcon}>
          {isTracking ? '⏹' : '▶️'}
        </Text>
        <Text style={styles.actionButtonText}>
          {isTracking ? 'STOP TRACKING' : 'START TRACKING'}
        </Text>
      </TouchableOpacity>

      {/* Info Card */}
      <View style={styles.infoCard}>
        <Text style={styles.infoText}>
          💡 Connect your Pet Locket device in the Device tab first
        </Text>
        <Text style={styles.infoSubtext}>
          Android {Platform.Version} • Background tracking enabled
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  contentContainer: {
    padding: 20,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
    borderLeftWidth: 4,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  cardSuccess: {
    borderLeftColor: '#27ae60',
    backgroundColor: '#f0fdf4',
  },
  cardWarning: {
    borderLeftColor: '#f39c12',
    backgroundColor: '#fffbeb',
  },
  cardIcon: {
    fontSize: 32,
    marginRight: 12,
  },
  cardContent: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 12,
    color: '#666',
    textTransform: 'uppercase',
    fontWeight: '600',
    marginBottom: 4,
  },
  cardText: {
    fontSize: 16,
    color: '#2c3e50',
    fontWeight: '600',
  },
  stepsCard: {
    backgroundColor: '#fff',
    padding: 32,
    borderRadius: 16,
    alignItems: 'center',
    marginBottom: 20,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  stepsNumber: {
    fontSize: 64,
    fontWeight: '900',
    color: '#2c3e50',
    marginBottom: 8,
  },
  stepsLabel: {
    fontSize: 16,
    color: '#7f8c8d',
    fontWeight: '600',
    marginBottom: 16,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  statusBadgeActive: {
    backgroundColor: '#d1f2eb',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#95a5a6',
    marginRight: 8,
  },
  statusDotActive: {
    backgroundColor: '#27ae60',
  },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#7f8c8d',
  },
  statusTextActive: {
    color: '#27ae60',
  },
  actionButton: {
    backgroundColor: '#27ae60',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 18,
    borderRadius: 12,
    marginBottom: 20,
    elevation: 4,
    shadowColor: '#27ae60',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
  },
  actionButtonStop: {
    backgroundColor: '#e74c3c',
    shadowColor: '#e74c3c',
  },
  actionButtonIcon: {
    fontSize: 20,
    marginRight: 8,
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  infoCard: {
    backgroundColor: '#e3f2fd',
    padding: 16,
    borderRadius: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#2196f3',
  },
  infoText: {
    fontSize: 14,
    color: '#1565c0',
    marginBottom: 8,
    fontWeight: '500',
  },
  infoSubtext: {
    fontSize: 12,
    color: '#64b5f6',
  },
});
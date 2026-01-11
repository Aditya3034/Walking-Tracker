import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, PermissionsAndroid, 
  Platform, NativeModules, NativeEventEmitter, Alert
} from 'react-native';

const { StepCounter } = NativeModules;
const eventEmitter = new NativeEventEmitter(StepCounter);

export default function WalkingTrackerScreen() {
  const [steps, setSteps] = useState(0);
  const [isTracking, setIsTracking] = useState(false);
  const [status, setStatus] = useState('Ready');

  useEffect(() => {
    const subscription = eventEmitter.addListener('StepCounterUpdate', (data) => {
      setSteps(Math.round(data));
    });
    return () => subscription?.remove();
  }, []);

  useEffect(() => {
    requestAllPermissions();
  }, []);

  const requestAllPermissions = async () => {
    if (Platform.OS !== 'android') {
      setStatus('✅ Ready (iOS)');
      return true;
    }

    const permissions = [];

    // Android 13+ needs notification permission
    if (Platform.Version >= 33) {
      permissions.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    }

    // Android 10+ needs activity recognition
    if (Platform.Version >= 29) {
      permissions.push(PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION);
    }

    if (permissions.length === 0) {
      setStatus('✅ Ready');
      return true;
    }

    try {
      const results = await PermissionsAndroid.requestMultiple(permissions);
      
      const allGranted = Object.values(results).every(
        result => result === PermissionsAndroid.RESULTS.GRANTED
      );

      if (allGranted) {
        setStatus('✅ Permissions Granted');
        return true;
      } else {
        setStatus('⚠️ Some Permissions Denied');
        Alert.alert(
          'Permissions Required',
          'Please grant all permissions for step tracking to work properly.',
          [{ text: 'OK' }]
        );
        return false;
      }
    } catch (err) {
      console.error('Permission error:', err);
      setStatus('❌ Permission Error');
      return false;
    }
  };

  const toggleTracking = async () => {
    try {
      if (isTracking) {
        // Stop tracking
        await StepCounter.stopBackgroundService();
        StepCounter.stopStepCounter();
        setIsTracking(false);
        setStatus('⏸️ Stopped');
      } else {
        // Check permissions first
        const granted = await requestAllPermissions();
        if (!granted) {
          Alert.alert('Permissions Required', 'Please enable all permissions to continue');
          return;
        }

        // Start foreground sensor
        StepCounter.startStepCounter();

        // Start background service
        try {
          await StepCounter.startBackgroundService();
          setIsTracking(true);
          setStatus('🔄 Tracking Active');
        } catch (error) {
          console.error('Service start error:', error);
          Alert.alert(
            'Service Start Failed',
            'Please keep the app open while starting tracking on Android 14+',
            [
              {
                text: 'OK',
                onPress: () => {
                  StepCounter.stopStepCounter();
                  setStatus('❌ Failed to Start');
                }
              }
            ]
          );
        }
      }
    } catch (error) {
      console.error('Tracking error:', error);
      Alert.alert('Error', error.message || 'Failed to toggle tracking');
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>🏃 Walking Tracker</Text>
      
      <Text style={styles.statusText}>{status}</Text>
      
      <Text style={styles.steps}>{steps.toLocaleString()}</Text>
      <Text style={styles.label}>Total Steps</Text>

      <TouchableOpacity 
        style={[styles.startButton, isTracking && styles.stopButton]}
        onPress={toggleTracking}
      >
        <Text style={styles.buttonText}>
          {isTracking ? '⏹️ STOP TRACKING' : '▶️ START TRACKING'}
        </Text>
      </TouchableOpacity>

      <Text style={styles.info}>
        Works on Android 7-16 • Foreground + Background
      </Text>
      
      <Text style={styles.version}>
        Android {Platform.Version} • API {Platform.constants.Version}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f9fa',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 30,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#2c3e50',
    marginBottom: 30,
  },
  statusText: {
    fontSize: 18,
    color: '#27ae60',
    marginBottom: 30,
    fontWeight: '600',
  },
  steps: {
    fontSize: 72,
    fontWeight: '900',
    color: '#2c3e50',
    marginBottom: 10,
  },
  label: {
    fontSize: 18,
    color: '#7f8c8d',
    marginBottom: 50,
  },
  startButton: {
    backgroundColor: '#27ae60',
    paddingHorizontal: 40,
    paddingVertical: 20,
    borderRadius: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
  },
  stopButton: {
    backgroundColor: '#e74c3c',
  },
  buttonText: {
    color: 'white',
    fontSize: 20,
    fontWeight: 'bold',
    textTransform: 'uppercase',
  },
  info: {
    fontSize: 14,
    color: '#95a5a6',
    marginTop: 20,
  },
  version: {
    fontSize: 12,
    color: '#bdc3c7',
    marginTop: 10,
  },
});
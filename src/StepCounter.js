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

  // Listen for step updates
  useEffect(() => {
    const subscription = eventEmitter.addListener('StepCounterUpdate', (data) => {
      setSteps(Math.round(data));
    });
    return () => subscription?.remove();
  }, []);

  // Auto-request permission on mount
  useEffect(() => {
    requestPermission();
  }, []);

  const requestPermission = async () => {
    if (Platform.OS === 'android' && Platform.Version >= 29) {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION,
          {
            title: 'Step Counter Permission',
            message: 'Allow step counting?',
            buttonNeutral: 'Ask Me Later',
            buttonNegative: 'Cancel',
            buttonPositive: 'OK',
          }
        );
        if (granted === PermissionsAndroid.RESULTS.GRANTED) {
          setStatus('✅ Permission Granted');
        } else {
          setStatus('❌ Permission Denied');
        }
      } catch (err) {
        setStatus('⚠️ Permission Error');
      }
    } else {
      setStatus('✅ Permission OK');
    }
  };
    const toggleTracking = async () => {
    try {
        if (isTracking) {
        // Stop EVERYTHING
        StepCounter.stopStepCounter();
        StepCounter.stopBackgroundService();
        setIsTracking(false);
        setStatus('⏸️ Stopped');
        } else {
        // Permission check first
        if (Platform.OS === 'android' && Platform.Version >= 29) {
            const granted = await PermissionsAndroid.check(
            PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION
            );
            if (!granted) {
            const result = await PermissionsAndroid.request(
                PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION
            );
            if (result !== PermissionsAndroid.RESULTS.GRANTED) {
                Alert.alert('Permission Required');
                return;
            }
            }
        }
        
        // ✅ START BOTH: Foreground + Background Service
        StepCounter.startStepCounter();
        StepCounter.startBackgroundService();  // ← THIS MAKES NOTIFICATION APPEAR
        setIsTracking(true);
        setStatus('🔄 Background Active + Notification');
        }
    } catch (error) {
        Alert.alert('Error', error.message);
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

      <Text style={styles.info}>Works in foreground + background</Text>
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
});

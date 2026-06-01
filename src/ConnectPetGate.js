import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import WelcomeConnectCard from './WelcomeConnectCard';

export default function ConnectPetGate({ onDevSkip }) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Welcome to softwear.pet</Text>
        <Text style={styles.subtitle}>Connect your pet to begin</Text>
      </View>
      <WelcomeConnectCard />
      {/* TEMP DEV — emulator can't BLE; remove before ship */}
      {onDevSkip && (
        <TouchableOpacity onPress={onDevSkip} style={styles.devSkip}>
          <Text style={styles.devSkipText}>Skip (dev)</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  header:    { paddingTop: 48, paddingHorizontal: 28, alignItems: 'center', marginBottom: 8 },
  title:     { fontSize: 24, fontWeight: '800', color: '#0f172a', marginBottom: 6, letterSpacing: -0.3 },
  subtitle:  { fontSize: 14, color: '#64748b' },
  devSkip:   { alignSelf: 'center', marginTop: 12, marginBottom: 24, paddingVertical: 8, paddingHorizontal: 16 },
  devSkipText: { fontSize: 13, color: '#94a3b8', textDecorationLine: 'underline' },
});

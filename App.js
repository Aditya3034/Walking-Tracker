import React, { useState } from 'react';
import { StatusBar, StyleSheet, View, TouchableOpacity, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import WalkingTrackerScreen from './src/StepCounter';
import BleConnect from './src/BleConnet';

export default function App() {
  const [activeTab, setActiveTab] = useState('tracker'); // 'tracker' or 'bluetooth'

  return (
    <SafeAreaProvider style={styles.appContainer}>
      <StatusBar barStyle="dark-content" backgroundColor="#fff" />
      <SafeAreaView style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>🐾 Pet Fitness Tracker</Text>
        </View>

        {/* Tab Content */}
        <View style={styles.content}>
          {activeTab === 'tracker' ? (
            <WalkingTrackerScreen />
          ) : (
            <BleConnect />
          )}
        </View>

        {/* Bottom Tab Bar */}
        <View style={styles.tabBar}>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'tracker' && styles.tabActive]}
            onPress={() => setActiveTab('tracker')}
          >
            <Text style={[styles.tabIcon, activeTab === 'tracker' && styles.tabIconActive]}>
              🏃
            </Text>
            <Text style={[styles.tabLabel, activeTab === 'tracker' && styles.tabLabelActive]}>
              Tracker
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tab, activeTab === 'bluetooth' && styles.tabActive]}
            onPress={() => setActiveTab('bluetooth')}
          >
            <Text style={[styles.tabIcon, activeTab === 'bluetooth' && styles.tabIconActive]}>
              📡
            </Text>
            <Text style={[styles.tabLabel, activeTab === 'bluetooth' && styles.tabLabelActive]}>
              Device
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  appContainer: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  container: {
    flex: 1,
  },
  header: {
    backgroundColor: '#fff',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#2c3e50',
    textAlign: 'center',
  },
  content: {
    flex: 1,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
    paddingBottom: 8,
    paddingTop: 8,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
  },
  tabActive: {
    borderTopWidth: 3,
    borderTopColor: '#2196f3',
  },
  tabIcon: {
    fontSize: 24,
    marginBottom: 4,
    opacity: 0.5,
  },
  tabIconActive: {
    opacity: 1,
  },
  tabLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#999',
  },
  tabLabelActive: {
    color: '#2196f3',
  },
});
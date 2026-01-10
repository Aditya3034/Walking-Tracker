import React from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import WalkingTrackerScreen from './src/StepCounter';

export default function App() {
  return (
    <SafeAreaProvider style={styles.appContainer}>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.container}>
        <WalkingTrackerScreen />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  appContainer: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
});

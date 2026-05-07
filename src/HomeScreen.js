import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  NativeModules, NativeEventEmitter, DeviceEventEmitter,
  Modal, TextInput, KeyboardAvoidingView, Platform, Pressable,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Circle } from 'react-native-svg';
import PetConnectCard from './PetConnectCard';
import BleStepService from './BleStepService';
import LeaderboardCard from './LeaderboardCard';

const { StepCounter } = NativeModules;
const eventEmitter = StepCounter ? new NativeEventEmitter(StepCounter) : null;

const DEFAULT_GOAL = 10000;
const STEPS_PER_TREAT = 1000; // steps needed to earn 1 treat

/* -------------------- CIRCULAR PROGRESS -------------------- */

function CircularProgress({ size = 170, strokeWidth = 13, steps, goal, color }) {
  const radius = (size - strokeWidth) / 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = Math.min(steps / Math.max(goal, 1), 1);
  const dashOffset = circumference * (1 - ratio);

  return (
    <Svg width={size} height={size}>
      <Circle
        cx={center} cy={center} r={radius}
        stroke="#e2e8f0" strokeWidth={strokeWidth} fill="none"
      />
      <Circle
        cx={center} cy={center} r={radius}
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        rotation="-90"
        origin={`${center}, ${center}`}
      />
    </Svg>
  );
}

/* -------------------- MAIN SCREEN -------------------- */

export default function HomeScreen({ isActive }) {
  const [hasDevice, setHasDevice] = useState(false);
  const [completedTodaySteps, setCompletedTodaySteps] = useState(0);
  const [convertedStepsToday, setConvertedStepsToday] = useState(0);
  const [pendingTreats, setPendingTreats] = useState(0);
  const [stepGoal, setStepGoal] = useState(DEFAULT_GOAL);
  const [petColor, setPetColor] = useState('#EE5514');
  const [goalModalVisible, setGoalModalVisible] = useState(false);
  const [goalInput, setGoalInput] = useState('');

  const todayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const loadCompletedSteps = async () => {
    try {
      const raw = await AsyncStorage.getItem('activities');
      if (!raw) { setCompletedTodaySteps(0); return; }
      const parsed = JSON.parse(raw);
      const todaySessions = parsed[todayKey()] || [];
      const total = todaySessions.reduce((sum, s) => sum + (s.steps || 0), 0);
      setCompletedTodaySteps(total);
    } catch {
      setCompletedTodaySteps(0);
    }
  };

  // stepsConvertedToday is stored as { date, steps } — auto-resets when date changes
  const loadConvertedSteps = async () => {
    try {
      const raw = await AsyncStorage.getItem('stepsConvertedToday');
      if (!raw) { setConvertedStepsToday(0); return; }
      const parsed = JSON.parse(raw);
      if (parsed.date !== todayKey()) {
        setConvertedStepsToday(0);
      } else {
        setConvertedStepsToday(parsed.steps || 0);
      }
    } catch {
      setConvertedStepsToday(0);
    }
  };

  /* -------- initial load -------- */
  useEffect(() => {
    loadCompletedSteps();
    loadConvertedSteps();
    AsyncStorage.getItem('pendingTreats').then(val => {
      setPendingTreats(parseInt(val, 10) || 0);
    }).catch(() => {});
    AsyncStorage.getItem('stepGoal').then(val => {
      if (val) setStepGoal(parseInt(val, 10) || DEFAULT_GOAL);
    }).catch(() => {});
    AsyncStorage.getItem('petColor').then(val => {
      if (val && val !== '#f1f5f9' && val !== '#ffffff') setPetColor(val);
    }).catch(() => {});

    const colorSub = DeviceEventEmitter.addListener('petColorChange', color => setPetColor(color));
    return () => colorSub.remove();
  }, []);

  /* -------- refresh on tab focus -------- */
  useEffect(() => {
    if (isActive) {
      loadCompletedSteps();
      loadConvertedSteps();
    }
  }, [isActive]);

  /* -------- refresh daily total when a session finishes on Track screen -------- */
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('sessionFinished', () => {
      loadCompletedSteps();
    });
    return () => sub.remove();
  }, []);

  /* -------- BLE connection status -------- */
  useEffect(() => {
    const s = BleStepService.getTrackingStatus();
    setHasDevice(s.hasDevice);
    const unsubDisconnect = BleStepService.onDisconnect(() => setHasDevice(false));
    const connSub = eventEmitter?.addListener('BleConnectionUpdate', state => {
      setHasDevice(state === 'connected');
    });
    return () => { unsubDisconnect(); connSub?.remove(); };
  }, []);

  /* -------- convert steps to treats -------- */
  const handleConvert = async () => {
    if (convertibleTreats <= 0) return;
    const stepsUsed = convertibleTreats * STEPS_PER_TREAT;
    const newConverted = convertedStepsToday + stepsUsed;
    const newTreats = pendingTreats + convertibleTreats;

    setConvertedStepsToday(newConverted);
    setPendingTreats(newTreats);

    try {
      await AsyncStorage.setItem('stepsConvertedToday', JSON.stringify({ date: todayKey(), steps: newConverted }));
      await AsyncStorage.setItem('pendingTreats', String(newTreats));
    } catch (e) {}
  };

  /* -------- feed pet -------- */
  const feedPet = async () => {
    if (pendingTreats <= 0 || !hasDevice) return;
    try {
      await BleStepService.writeToDevice('FEED');
      BleStepService.recordFeed();
      const newTreats = Math.max(0, pendingTreats - 1);
      setPendingTreats(newTreats);
      AsyncStorage.setItem('pendingTreats', String(newTreats)).catch(() => {});
    } catch (e) {}
  };

  /* -------- goal modal -------- */
  const openGoalModal = () => {
    setGoalInput(String(stepGoal));
    setGoalModalVisible(true);
  };

  const saveGoal = () => {
    const parsed = parseInt(goalInput, 10);
    if (!parsed || parsed < 1) return;
    setStepGoal(parsed);
    AsyncStorage.setItem('stepGoal', String(parsed)).catch(() => {});
    setGoalModalVisible(false);
  };

  /* -------- derived -------- */
  const availableSteps = Math.max(0, completedTodaySteps - convertedStepsToday);
  const convertibleTreats = Math.floor(availableSteps / STEPS_PER_TREAT);
  const pct = Math.min(Math.round((completedTodaySteps / Math.max(stepGoal, 1)) * 100), 100);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>

      <PetConnectCard />

      <LeaderboardCard />

      {/* Daily Steps Card */}
      <View style={styles.stepsCard}>
        <View style={styles.ringWrap}>
          <CircularProgress steps={completedTodaySteps} goal={stepGoal} color={petColor} />
          <View style={styles.ringCenter}>
            <Text style={styles.stepsNumber}>{completedTodaySteps.toLocaleString()}</Text>
            <Text style={styles.stepsLabel}>Today's Steps</Text>
          </View>
        </View>
        <View style={styles.goalRow}>
          <Text style={styles.goalText}>{pct}% of {stepGoal.toLocaleString()} goal</Text>
          <TouchableOpacity onPress={openGoalModal} activeOpacity={0.7}>
            <Text style={styles.setGoalBtn}>Set Goal</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Steps to Convert Card */}
      <View style={styles.convertCard}>
        <View style={styles.convertTop}>
          <View>
            <Text style={styles.convertTitle}>Steps to Convert</Text>
            <Text style={styles.convertSteps}>{availableSteps.toLocaleString()}</Text>
            <Text style={styles.convertSub}>
              {convertibleTreats > 0
                ? `= ${convertibleTreats} treat${convertibleTreats > 1 ? 's' : ''}`
                : `${STEPS_PER_TREAT - (availableSteps % STEPS_PER_TREAT)} more steps for next treat`}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.convertBtn, convertibleTreats === 0 && styles.convertBtnDisabled]}
            onPress={handleConvert}
            disabled={convertibleTreats === 0}
            activeOpacity={0.8}
          >
            <Text style={styles.convertBtnText}>Convert</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Treats Card */}
      <View style={styles.treatsCard}>
        <View style={styles.treatsHeader}>
          <Text style={styles.treatsTitle}>Treats</Text>
          <View style={[styles.treatsBadge, pendingTreats === 0 && styles.treatsBadgeEmpty]}>
            <Text style={styles.treatsBadgeText}>{pendingTreats}</Text>
          </View>
        </View>

        {pendingTreats > 0 ? (
          <View style={styles.treatDotsRow}>
            {Array.from({ length: Math.min(pendingTreats, 12) }).map((_, i) => (
              <View key={i} style={styles.treatDot} />
            ))}
            {pendingTreats > 12 && (
              <Text style={styles.treatMore}>+{pendingTreats - 12}</Text>
            )}
          </View>
        ) : (
          <Text style={styles.noTreatsText}>No treats yet — convert your steps above</Text>
        )}

        <TouchableOpacity
          style={[styles.feedButton, (!hasDevice || pendingTreats === 0) && styles.feedButtonDisabled]}
          onPress={feedPet}
          disabled={!hasDevice || pendingTreats === 0}
          activeOpacity={0.8}
        >
          <Text style={styles.feedButtonText}>Feed Pet</Text>
        </TouchableOpacity>
        {!hasDevice && (
          <Text style={styles.noDeviceHint}>Connect your pet locket to feed</Text>
        )}
      </View>

      {/* Set Goal Modal */}
      <Modal
        visible={goalModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setGoalModalVisible(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setGoalModalVisible(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <Pressable style={styles.modalCard} onPress={() => {}}>
              <Text style={styles.modalTitle}>Daily Step Goal</Text>
              <Text style={styles.modalSub}>Set how many steps you want to hit each day</Text>
              <TextInput
                style={styles.modalInput}
                value={goalInput}
                onChangeText={setGoalInput}
                keyboardType="number-pad"
                placeholder="e.g. 10000"
                placeholderTextColor="#94a3b8"
                maxLength={6}
                autoFocus
              />
              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={styles.modalCancel}
                  onPress={() => setGoalModalVisible(false)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.modalSave}
                  onPress={saveGoal}
                  activeOpacity={0.8}
                >
                  <Text style={styles.modalSaveText}>Save</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

    </ScrollView>
  );
}

/* -------------------- STYLES -------------------- */

const C = {
  bg:      '#ffffff',
  card:    '#ffffff',
  primary: '#0f172a',
  accent:  '#2563eb',
  success: '#059669',
  warning: '#d97706',
  text:    '#0f172a',
  text2:   '#475569',
  text3:   '#94a3b8',
  border:  '#e2e8f0',
};

const card = {
  backgroundColor: C.card,
  borderRadius: 20,
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.06,
  shadowRadius: 8,
  elevation: 2,
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  contentContainer: { padding: 20, paddingBottom: 40 },

  /* Daily Steps Card */
  stepsCard: {
    ...card,
    marginTop: 16,
    padding: 24,
    alignItems: 'center',
  },
  ringWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  ringCenter: {
    position: 'absolute',
    alignItems: 'center',
  },
  stepsNumber: { fontSize: 36, fontWeight: '900', color: C.text },
  stepsLabel: { fontSize: 11, color: C.text3, fontWeight: '600', textTransform: 'uppercase', marginTop: 2 },
  goalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingHorizontal: 4,
  },
  goalText: { fontSize: 13, color: C.text2, fontWeight: '500' },
  setGoalBtn: { fontSize: 13, fontWeight: '700', color: C.accent },

  /* Steps to Convert Card */
  convertCard: {
    ...card,
    marginTop: 12,
    padding: 20,
  },
  convertTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  convertTitle: { fontSize: 11, fontWeight: '700', color: C.text3, textTransform: 'uppercase', marginBottom: 4 },
  convertSteps: { fontSize: 30, fontWeight: '900', color: C.text },
  convertSub: { fontSize: 12, color: C.text3, marginTop: 2 },
  convertBtn: {
    backgroundColor: C.primary,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 12,
  },
  convertBtnDisabled: { opacity: 0.35 },
  convertBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  /* Treats Card */
  treatsCard: {
    ...card,
    marginTop: 12,
    padding: 20,
    alignItems: 'center',
  },
  treatsHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14, alignSelf: 'stretch' },
  treatsTitle: { fontSize: 11, fontWeight: '700', color: C.text3, textTransform: 'uppercase', flex: 1 },
  treatsBadge: {
    backgroundColor: C.warning,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
    minWidth: 28,
    alignItems: 'center',
  },
  treatsBadgeEmpty: { backgroundColor: C.border },
  treatsBadgeText: { fontSize: 13, fontWeight: '800', color: '#fff' },
  treatDotsRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6, marginBottom: 16 },
  treatDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.warning },
  treatMore: { fontSize: 12, color: C.text3, alignSelf: 'center', marginLeft: 4 },
  noTreatsText: { fontSize: 12, color: C.text3, textAlign: 'center', marginBottom: 16 },
  feedButton: {
    backgroundColor: C.primary,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 12,
  },
  feedButtonDisabled: { opacity: 0.4 },
  feedButtonText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  noDeviceHint: { fontSize: 11, color: C.text3, marginTop: 10 },

  /* Goal Modal */
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 24,
    width: '100%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 20,
    elevation: 8,
  },
  modalTitle: { fontSize: 17, fontWeight: '800', color: C.text, marginBottom: 4 },
  modalSub: { fontSize: 12, color: C.text3, marginBottom: 20 },
  modalInput: {
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 22,
    fontWeight: '700',
    color: C.text,
    marginBottom: 20,
    textAlign: 'center',
  },
  modalButtons: { flexDirection: 'row', gap: 10 },
  modalCancel: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: C.border,
    alignItems: 'center',
  },
  modalCancelText: { fontSize: 14, fontWeight: '600', color: C.text2 },
  modalSave: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: C.primary,
    alignItems: 'center',
  },
  modalSaveText: { fontSize: 14, fontWeight: '700', color: '#fff' },
});

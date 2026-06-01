import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import firestore from '@react-native-firebase/firestore';

const USERNAME_REGEX = /^[A-Za-z._]{2,15}$/;
const PETNAME_REGEX  = /^[\S\s]{2,15}$/;

export default function OnboardingScreen({ petId, onComplete }) {
  const [username, setUsername] = useState('');
  const [petName, setPetName]   = useState('');
  const [error, setError]       = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setError('');
    const u = username.trim();
    const p = petName.trim();

    if (!USERNAME_REGEX.test(u)) {
      setError('Username must be 2-15 characters. Letters, dots and underscores only.');
      return;
    }
    if (p.length < 2 || p.length > 15) {
      setError('Pet name must be 2-15 characters.');
      return;
    }

    setSubmitting(true);
    try {
      const deviceType = await AsyncStorage.getItem('deviceType');
      await firestore().runTransaction(async (transaction) => {
        const usernameRef = firestore().collection('usernames').doc(u);
        const snap = await transaction.get(usernameRef);
        if (snap.data() !== undefined) throw new Error('USERNAME_TAKEN');

        transaction.set(usernameRef, { petId });
        transaction.set(firestore().collection('pets').doc(petId), {
          petId,
          username: u,
          petName: p,
          petColor: '#EE5514',
          petNameChanged: false,
          ...(deviceType ? { deviceType } : {}),
          totalLifetimeSteps: 0,
          totalWalkCount: 0,
          pendingTreats: 0,
          joinDate: firestore.FieldValue.serverTimestamp(),
          lastSyncAt: firestore.FieldValue.serverTimestamp(),
        });
      });

      await AsyncStorage.multiSet([
        ['username', u],
        ['petName',  p],
      ]);
      onComplete({ username: u, petName: p });
    } catch (e) {
      if (e.message === 'USERNAME_TAKEN') {
        setError('That username is taken. Try another.');
      } else {
        setError('Could not save. Check your internet and try again.');
      }
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.inner}>
        <Text style={styles.title}>Welcome</Text>
        <Text style={styles.subtitle}>Set up your pet to get started.</Text>

        <Text style={styles.label}>Username</Text>
        <TextInput
          style={styles.input}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="e.g. kunal_t"
          placeholderTextColor="#94a3b8"
          maxLength={15}
        />
        <Text style={styles.hint}>2-15 characters. Letters, dots, underscores. Cannot be changed later.</Text>

        <Text style={styles.label}>Pet name</Text>
        <TextInput
          style={styles.input}
          value={petName}
          onChangeText={setPetName}
          placeholder="e.g. Mochi"
          placeholderTextColor="#94a3b8"
          maxLength={15}
        />
        <Text style={styles.hint}>2-15 characters.</Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.button, submitting && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
          activeOpacity={0.85}
        >
          {submitting
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.buttonText}>Continue</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  inner:     { flex: 1, padding: 28, justifyContent: 'center' },
  title:     { fontSize: 28, fontWeight: '800', color: '#0f172a', marginBottom: 6 },
  subtitle:  { fontSize: 14, color: '#64748b', marginBottom: 32 },
  label:     { fontSize: 12, fontWeight: '700', color: '#0f172a', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  input:     {
    backgroundColor: '#f1f5f9', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16,
    fontSize: 15, color: '#0f172a', marginBottom: 4,
  },
  hint:      { fontSize: 11, color: '#94a3b8', marginBottom: 20 },
  error:     { fontSize: 13, color: '#dc2626', marginBottom: 12, textAlign: 'center' },
  button:    {
    backgroundColor: '#0f172a', borderRadius: 14, paddingVertical: 16,
    alignItems: 'center', marginTop: 12,
  },
  buttonDisabled: { backgroundColor: '#94a3b8' },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: '700', letterSpacing: 0.5 },
});

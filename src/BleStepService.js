import { NativeModules, NativeEventEmitter } from 'react-native';
import { Buffer } from 'buffer';

const { StepCounter } = NativeModules;
// Guard: NativeEventEmitter requires a non-null module; if the native module is missing
// (e.g. app not rebuilt after adding the package) avoid a crash at import time.
const eventEmitter = StepCounter ? new NativeEventEmitter(StepCounter) : null;

const APP_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

class BleStepService {
  constructor() {
    this.connectedDevice = null;
    this.stepSubscription = null;
    this.isTracking = false;
  }

  /* ---------- CONNECTION MANAGEMENT ---------- */

  setConnectedDevice(device) {
    this.connectedDevice = device;
    console.log('✅ BLE Device set:', device?.name || device?.id);

    device.onDisconnected((error) => {
      console.log('❌ BLE Disconnected:', error?.message || 'OK');
      this.clearDevice();
    });
  }

  clearDevice() {
    this.stopStepTracking();
    this.connectedDevice = null;
  }

  getDevice() {
    return this.connectedDevice;
  }

  isConnected() {
    return !!this.connectedDevice;
  }

  /* ---------- LOW-LEVEL WRITE ---------- */

  async writeRaw(message) {
    if (!this.connectedDevice) {
      console.warn('⚠️ No BLE device connected');
      return false;
    }

    try {
      await this.connectedDevice.writeCharacteristicWithResponseForService(
        APP_SERVICE_UUID,
        CHARACTERISTIC_UUID,
        Buffer.from(message, 'utf8').toString('base64')
      );
      console.log(`📤 Sent to ESP32: ${message}`);
      return true;
    } catch (error) {
      console.error('❌ BLE write failed:', error);
      return false;
    }
  }

  /* ---------- COMMANDS (PET CONTROL) ---------- */

  async writeToDevice(command) {
    // For commands like "FEED"
    return this.writeRaw(command);
  }

  /* ---------- STEP STREAMING ---------- */

  async sendStepCount(steps) {
    const message = `STEPS:${Math.round(steps)}`;
    return this.writeRaw(message);
  }

  startStepTracking() {
    if (this.isTracking) return;
    if (!this.connectedDevice) {
      console.warn('⚠️ Cannot start tracking - no BLE device');
      return;
    }
    if (!eventEmitter) {
      console.warn('⚠️ Cannot start tracking - StepCounter native module unavailable');
      return;
    }

    this.stepSubscription = eventEmitter.addListener(
      'StepCounterUpdate',
      (steps) => {
        this.sendStepCount(steps);
      }
    );

    this.isTracking = true;
    console.log('🏃 Step tracking started');
  }

  stopStepTracking() {
    if (this.stepSubscription) {
      this.stepSubscription.remove();
      this.stepSubscription = null;
    }
    this.isTracking = false;
    console.log('⏸️ Step tracking stopped');
  }

  /* ---------- STATUS FOR UI ---------- */

  getTrackingStatus() {
    return {
      isTracking: this.isTracking,
      hasDevice: !!this.connectedDevice,
      deviceName:
        this.connectedDevice?.name ||
        this.connectedDevice?.id ||
        null,
    };
  }
}

export default new BleStepService();

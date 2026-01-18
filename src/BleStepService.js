import { NativeModules, NativeEventEmitter } from 'react-native';
import { Buffer } from 'buffer';

const { StepCounter } = NativeModules;
const eventEmitter = new NativeEventEmitter(StepCounter);

const APP_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

class BleStepService {
  constructor() {
    this.connectedDevice = null;
    this.stepSubscription = null;
    this.isTracking = false;
  }

  setConnectedDevice(device) {
    this.connectedDevice = device;
    console.log('✅ BLE Device set:', device?.name || device?.id);
  }

  clearDevice() {
    this.stopStepTracking();
    this.connectedDevice = null;
  }

  async sendStepCount(steps) {
    if (!this.connectedDevice) {
      console.warn('⚠️ No BLE device connected');
      return false;
    }

    try {
      const message = `STEPS:${Math.round(steps)}`;
      await this.connectedDevice.writeCharacteristicWithResponseForService(
        APP_SERVICE_UUID,
        CHARACTERISTIC_UUID,
        Buffer.from(message).toString('base64')
      );
      console.log(`📤 Sent to ESP32: ${message}`);
      return true;
    } catch (error) {
      console.error('❌ Failed to send steps:', error);
      return false;
    }
  }

  startStepTracking() {
    if (this.isTracking) {
      console.warn('⚠️ Already tracking steps');
      return;
    }

    if (!this.connectedDevice) {
      console.warn('⚠️ Cannot start tracking - no BLE device connected');
      return;
    }

    this.stepSubscription = eventEmitter.addListener('StepCounterUpdate', (steps) => {
      this.sendStepCount(steps);
    });

    this.isTracking = true;
    console.log('🏃 Step tracking started - sending to BLE device');
  }

  stopStepTracking() {
    if (this.stepSubscription) {
      this.stepSubscription.remove();
      this.stepSubscription = null;
    }
    this.isTracking = false;
    console.log('⏸️ Step tracking stopped');
  }

  getTrackingStatus() {
    return {
      isTracking: this.isTracking,
      hasDevice: !!this.connectedDevice,
      deviceName: this.connectedDevice?.name || this.connectedDevice?.id || null
    };
  }
}

// Singleton instance
export default new BleStepService();
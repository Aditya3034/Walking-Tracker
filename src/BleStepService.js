import { NativeModules, NativeEventEmitter } from 'react-native';

const { StepCounter } = NativeModules;
const eventEmitter = StepCounter ? new NativeEventEmitter(StepCounter) : null;

class BleStepService {
  constructor() {
    this.isConnectedState    = false;
    this.deviceName          = null;
    this.hungerState         = 'normal';
    this.hungerListeners     = [];
    this.disconnectListeners = [];

    if (eventEmitter) {
      // Hunger state pushed from ESP32 via native service
      eventEmitter.addListener('BleHungerUpdate', (msg) => {
        this._handleHungerNotification(msg);
      });

      // Connection state changes from native GATT
      eventEmitter.addListener('BleConnectionUpdate', (state) => {
        if (state === 'connected') {
          this.isConnectedState = true;
        } else {
          this.isConnectedState = false;
          this.deviceName = null;
          this._setHungerState('normal');
          this.disconnectListeners.forEach(fn => { try { fn(); } catch (e) {} });
        }
      });
    }
  }

  /* ---------- CONNECTION ---------- */

  // Called by BleConnet when user picks device from scan list
  setDeviceName(name) {
    this.deviceName = name;
    this.isConnectedState = true;
  }

  async clearDevice() {
    if (StepCounter?.disconnectBleDevice) {
      try { await StepCounter.disconnectBleDevice(); } catch (e) {}
    }
    this.isConnectedState = false;
    this.deviceName = null;
    this._setHungerState('normal');
    this.disconnectListeners.forEach(fn => { try { fn(); } catch (e) {} });
  }

  onDisconnect(callback) {
    this.disconnectListeners.push(callback);
    return () => {
      this.disconnectListeners = this.disconnectListeners.filter(fn => fn !== callback);
    };
  }

  /* ---------- HUNGER ---------- */

  _handleHungerNotification(msg) {
    if (msg === 'HUNGRY')  this._setHungerState('hungry');
    if (msg === 'STARVING') this._setHungerState('starving');
    if (msg === 'FEEDING') this._setHungerState('normal');
    if (msg === 'NORMAL')  this._setHungerState('normal');
  }

  _setHungerState(state) {
    const uiState = state === 'feeding' ? 'normal' : state;
    if (this.hungerState === uiState) return;
    this.hungerState = uiState;
    this.hungerListeners.forEach(fn => fn(uiState));
  }

  getHungerState() { return this.hungerState; }

  onHungerChange(callback) {
    this.hungerListeners.push(callback);
    return () => {
      this.hungerListeners = this.hungerListeners.filter(fn => fn !== callback);
    };
  }

  /* ---------- FEED ---------- */

  recordFeed() {
    this._setHungerState('normal');
  }

  /* ---------- WRITE ---------- */

  async writeToDevice(command) {
    if (!StepCounter?.writeBleCommand) return false;
    try {
      await StepCounter.writeBleCommand(command);
      return true;
    } catch (e) {
      console.error('writeBleCommand failed:', e);
      return false;
    }
  }

  async writeRaw(message) {
    return this.writeToDevice(message);
  }

  /* ---------- STATUS ---------- */

  isConnected() { return this.isConnectedState; }

  getTrackingStatus() {
    return {
      isTracking: false,
      hasDevice:  this.isConnectedState,
      deviceName: this.deviceName,
    };
  }

  /* ---------- STEP TRACKING (native service handles streaming) ---------- */
  startStepTracking() {}
  stopStepTracking() {}
}

export default new BleStepService();

// package com.walkingtracker

// import com.facebook.react.bridge.ReactApplicationContext
// import com.facebook.react.bridge.ReactContextBaseJavaModule
// import com.facebook.react.bridge.ReactMethod
// import com.facebook.react.bridge.Promise
// import com.facebook.react.modules.core.DeviceEventManagerModule
// import android.content.Context
// import android.content.Intent
// import android.hardware.Sensor
// import android.hardware.SensorEvent
// import android.hardware.SensorEventListener
// import android.hardware.SensorManager
// import android.os.Build
// import android.util.Log

// class StepCounterModule(reactContext: ReactApplicationContext) : 
//     ReactContextBaseJavaModule(reactContext), SensorEventListener {
    
//     private val sensorManager: SensorManager = 
//         reactContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
//     private val stepCounterSensor: Sensor? = 
//         sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
    
//     // Track baseline for foreground sensor too
//     private var initialStepCount = -1
//     private var currentSteps = 0

//     override fun getName(): String = "StepCounter"

//     @ReactMethod
//     fun startStepCounter() {
//         stepCounterSensor?.let { 
//             initialStepCount = -1  // Reset baseline
//             currentSteps = 0
//             sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
//             Log.d("StepCounter", "Foreground sensor started")
//         }
//     }

//     @ReactMethod
//     fun stopStepCounter() {
//         sensorManager.unregisterListener(this)
//         initialStepCount = -1
//         currentSteps = 0
//         Log.d("StepCounter", "Foreground sensor stopped")
//     }

//     @ReactMethod
//     fun startBackgroundService(promise: Promise) {
//         try {
//             val serviceIntent = Intent(reactApplicationContext, StepCounterService::class.java)
            
//             if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
//                 reactApplicationContext.startForegroundService(serviceIntent)
//             } else {
//                 reactApplicationContext.startService(serviceIntent)
//             }
            
//             promise.resolve(true)
//             Log.d("StepCounter", "Background service started successfully")
            
//         } catch (e: IllegalStateException) {
//             Log.e("StepCounter", "Cannot start service from background: ${e.message}")
//             promise.reject(
//                 "SERVICE_START_FAILED", 
//                 "Cannot start service from background. Keep app open while starting.",
//                 e
//             )
            
//         } catch (e: SecurityException) {
//             Log.e("StepCounter", "Permission denied: ${e.message}")
//             promise.reject(
//                 "PERMISSION_DENIED", 
//                 "Missing required permissions",
//                 e
//             )
            
//         } catch (e: Exception) {
//             Log.e("StepCounter", "Service start error: ${e.message}")
//             promise.reject(
//                 "UNKNOWN_ERROR", 
//                 "Failed to start service: ${e.message}",
//                 e
//             )
//         }
//     }

//     @ReactMethod
//     fun stopBackgroundService(promise: Promise) {
//         try {
//             val serviceIntent = Intent(reactApplicationContext, StepCounterService::class.java)
//             reactApplicationContext.stopService(serviceIntent)
//             promise.resolve(true)
//             Log.d("StepCounter", "Background service stopped")
//         } catch (e: Exception) {
//             Log.e("StepCounter", "Error stopping service: ${e.message}")
//             promise.reject("STOP_FAILED", "Failed to stop service", e)
//         }
//     }

//     override fun onSensorChanged(event: SensorEvent?) {
//         event?.let {
//             if (it.sensor.type == Sensor.TYPE_STEP_COUNTER) {
//                 val totalSteps = it.values[0].toInt()
                
//                 // First reading - set baseline
//                 if (initialStepCount < 0) {
//                     initialStepCount = totalSteps
//                     currentSteps = 0
//                 } else {
//                     // Calculate steps since sensor started
//                     currentSteps = totalSteps - initialStepCount
//                     if (currentSteps < 0) {
//                         // Phone was rebooted
//                         initialStepCount = totalSteps
//                         currentSteps = 0
//                     }
//                 }
                
//                 sendEvent("StepCounterUpdate", currentSteps.toDouble())
//             }
//         }
//     }

//     private fun sendEvent(eventName: String, steps: Double) {
//         reactApplicationContext
//             .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
//             .emit(eventName, steps)
//     }

//     override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
// }






package com.walkingtracker

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.modules.core.DeviceEventManagerModule
import android.content.Context
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.util.Log
import kotlin.math.sqrt
import kotlin.math.abs

class StepCounterModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), SensorEventListener {

    init {
        // Share context with the background service so it can emit events to JS
        StepCounterService.setReactContext(reactContext)
    }
    
    private val sensorManager: SensorManager = 
        reactContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    
    private val stepCounterSensor: Sensor? = 
        sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
    private val accelerometerSensor: Sensor? = 
        sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    
    // Tracking variables
    private var hardwareStepCount = -1
    private var initialHardwareSteps = -1
    private var algorithmStepCount = 0
    private var fusedStepCount = 0
    
    // Algorithm parameters
    private var lastAcceleration = 9.81f
    private var currentAcceleration = 9.81f
    private var lastStepTime = 0L
    private val stepThreshold = 3.0f
    private val minStepInterval = 250L
    private val maxStepInterval = 2000L
    private var isWalking = false

    override fun getName(): String = "StepCounter"

    @ReactMethod
    fun startStepCounter() {
        hardwareStepCount = -1
        initialHardwareSteps = -1
        algorithmStepCount = 0
        fusedStepCount = 0

        // Tell service not to emit StepCounterUpdate (this module will)
        StepCounterService.foregroundModuleActive = true
        sendActionToService(StepCounterService.ACTION_FOREGROUND_ACTIVE)

        stepCounterSensor?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
        }
        accelerometerSensor?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        }
    }

    @ReactMethod
    fun stopStepCounter() {
        sensorManager.unregisterListener(this)
        hardwareStepCount = -1
        initialHardwareSteps = -1
        algorithmStepCount = 0
        fusedStepCount = 0

        // Let service emit steps again now that foreground module stopped
        StepCounterService.foregroundModuleActive = false
        sendActionToService(StepCounterService.ACTION_FOREGROUND_INACTIVE)
    }

    @ReactMethod
    fun startBackgroundService(promise: Promise) {
        try {
            // Start the service as foreground first
            val serviceIntent = Intent(reactApplicationContext, StepCounterService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactApplicationContext.startForegroundService(serviceIntent)
            } else {
                reactApplicationContext.startService(serviceIntent)
            }
            // Then signal it to start tracking sensors + GPS
            sendActionToService(StepCounterService.ACTION_START_TRACKING)
            StepCounterService.trackingActive = true
            promise.resolve(true)
        } catch (e: IllegalStateException) {
            promise.reject("SERVICE_START_FAILED", "Cannot start service from background.", e)
        } catch (e: SecurityException) {
            promise.reject("PERMISSION_DENIED", "Missing permissions", e)
        } catch (e: Exception) {
            promise.reject("UNKNOWN_ERROR", "Failed to start: ${e.message}", e)
        }
    }

    @ReactMethod
    fun stopBackgroundService(promise: Promise) {
        try {
            sendActionToService(StepCounterService.ACTION_STOP_TRACKING)
            sendActionToService(StepCounterService.ACTION_FOREGROUND_INACTIVE)
            StepCounterService.foregroundModuleActive = false
            StepCounterService.trackingActive = false
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("STOP_FAILED", "Failed to stop service", e)
        }
    }

    @ReactMethod
    fun getBackgroundSteps(promise: Promise) {
        val prefs = reactApplicationContext.getSharedPreferences(
            StepCounterService.PREFS_NAME, android.content.Context.MODE_PRIVATE
        )
        promise.resolve(prefs.getInt(StepCounterService.PREFS_STEPS_KEY, 0))
    }

    @ReactMethod
    fun getBackgroundRoute(promise: Promise) {
        val prefs = reactApplicationContext.getSharedPreferences(
            StepCounterService.PREFS_NAME, android.content.Context.MODE_PRIVATE
        )
        promise.resolve(prefs.getString(StepCounterService.PREFS_ROUTE_KEY, "[]"))
    }

    /* -------- BLE Bridge -------- */

    @ReactMethod
    fun connectBleDevice(deviceId: String, promise: Promise) {
        try {
            // Persist so service auto-reconnects after app kill
            reactApplicationContext.getSharedPreferences(
                StepCounterService.PREFS_NAME, Context.MODE_PRIVATE
            ).edit().putString(StepCounterService.BLE_PREFS_KEY, deviceId).apply()

            val intent = Intent(reactApplicationContext, StepCounterService::class.java)
            intent.action = StepCounterService.ACTION_CONNECT_BLE
            intent.putExtra("deviceId", deviceId)
            reactApplicationContext.startService(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("BLE_CONNECT_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun disconnectBleDevice(promise: Promise) {
        try {
            reactApplicationContext.getSharedPreferences(
                StepCounterService.PREFS_NAME, Context.MODE_PRIVATE
            ).edit().remove(StepCounterService.BLE_PREFS_KEY).apply()

            val intent = Intent(reactApplicationContext, StepCounterService::class.java)
            intent.action = StepCounterService.ACTION_DISCONNECT_BLE
            reactApplicationContext.startService(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("BLE_DISCONNECT_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun writeBleCommand(command: String, promise: Promise) {
        try {
            val intent = Intent(reactApplicationContext, StepCounterService::class.java)
            intent.action = StepCounterService.ACTION_WRITE_BLE
            intent.putExtra("command", command)
            reactApplicationContext.startService(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("BLE_WRITE_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun getBleHungerState(promise: Promise) {
        val prefs = reactApplicationContext.getSharedPreferences(
            StepCounterService.PREFS_NAME, Context.MODE_PRIVATE
        )
        promise.resolve(prefs.getString(StepCounterService.BLE_HUNGER_KEY, "NORMAL"))
    }

    @ReactMethod
    fun clearSessionData(promise: Promise) {
        try {
            sendActionToService(StepCounterService.ACTION_CLEAR_SESSION)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("CLEAR_FAILED", e.message, e)
        }
    }

    // Triggers BleConnectionUpdate + BleHungerUpdate events so JS can sync state on reopen
    @ReactMethod
    fun queryBleState(promise: Promise) {
        try {
            sendActionToService(StepCounterService.ACTION_QUERY_BLE_STATE)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("QUERY_FAILED", e.message, e)
        }
    }

    private fun sendActionToService(action: String) {
        val intent = Intent(reactApplicationContext, StepCounterService::class.java)
        intent.action = action
        reactApplicationContext.startService(intent)
    }

    // Required by RN event emitter
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    override fun onSensorChanged(event: SensorEvent?) {
        event?.let {
            when (it.sensor.type) {
                Sensor.TYPE_STEP_COUNTER -> handleHardwareSteps(it)
                Sensor.TYPE_ACCELEROMETER -> handleAccelerometer(it)
            }
        }
    }

    private fun handleHardwareSteps(event: SensorEvent) {
        val totalSteps = event.values[0].toInt()
        
        if (initialHardwareSteps < 0) {
            initialHardwareSteps = totalSteps
            hardwareStepCount = 0
        } else {
            hardwareStepCount = totalSteps - initialHardwareSteps
            if (hardwareStepCount < 0) {
                initialHardwareSteps = totalSteps
                hardwareStepCount = 0
            }
        }
        
        fuseStepCounts()
    }

    private fun handleAccelerometer(event: SensorEvent) {
        val x = event.values[0]
        val y = event.values[1]
        val z = event.values[2]

        currentAcceleration = sqrt(x * x + y * y + z * z)
        isWalking = currentAcceleration in 8.5f..14.0f

        if (isWalking) {
            // detectStepFromAccelerometer calls fuseStepCounts() only when a step is detected
            detectStepFromAccelerometer(currentAcceleration, System.currentTimeMillis())
        }
        // Do NOT call fuseStepCounts() here — that would emit an event on every ~50Hz sample

        lastAcceleration = currentAcceleration
    }

    private fun detectStepFromAccelerometer(acceleration: Float, currentTime: Long) {
        val timeSinceLastStep = currentTime - lastStepTime
        val accelerationDelta = abs(acceleration - lastAcceleration)
        
        if (accelerationDelta > stepThreshold && 
            timeSinceLastStep > minStepInterval &&
            timeSinceLastStep < maxStepInterval) {
            
            algorithmStepCount++
            lastStepTime = currentTime
            fuseStepCounts()
        }
    }

    private fun fuseStepCounts() {
        val newFused = when {
            stepCounterSensor != null && hardwareStepCount >= 0 -> {
                if (algorithmStepCount > 0) {
                    val diff = abs(hardwareStepCount - algorithmStepCount)
                    if (diff < 15) {
                        ((hardwareStepCount * 0.7) + (algorithmStepCount * 0.3)).toInt()
                    } else {
                        maxOf(hardwareStepCount, algorithmStepCount)
                    }
                } else {
                    hardwareStepCount
                }
            }
            algorithmStepCount > 0 -> algorithmStepCount
            else -> 0
        }

        // Only emit when the count actually changes to avoid flooding JS
        if (newFused != fusedStepCount) {
            fusedStepCount = newFused
            sendEvent("StepCounterUpdate", fusedStepCount.toDouble())
        } else {
            fusedStepCount = newFused
        }
    }

    private fun sendEvent(eventName: String, steps: Double) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, steps)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
}
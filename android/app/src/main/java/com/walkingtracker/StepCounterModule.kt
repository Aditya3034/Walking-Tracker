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

class StepCounterModule(reactContext: ReactApplicationContext) : 
    ReactContextBaseJavaModule(reactContext), SensorEventListener {
    
    private val sensorManager: SensorManager = 
        reactContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val stepCounterSensor: Sensor? = 
        sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)

    override fun getName(): String = "StepCounter"

    @ReactMethod
    fun startStepCounter() {
        stepCounterSensor?.let { 
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
            Log.d("StepCounter", "Foreground sensor started")
        }
    }

    @ReactMethod
    fun stopStepCounter() {
        sensorManager.unregisterListener(this)
        Log.d("StepCounter", "Foreground sensor stopped")
    }

    @ReactMethod
    fun startBackgroundService(promise: Promise) {
        try {
            val serviceIntent = Intent(reactApplicationContext, StepCounterService::class.java)
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactApplicationContext.startForegroundService(serviceIntent)
            } else {
                reactApplicationContext.startService(serviceIntent)
            }
            
            promise.resolve(true)
            Log.d("StepCounter", "Background service started successfully")
            
        } catch (e: IllegalStateException) {
            // Android 14+ throws this when app is in background
            Log.e("StepCounter", "Cannot start service from background: ${e.message}")
            promise.reject(
                "SERVICE_START_FAILED", 
                "Cannot start service from background. Keep app open while starting.",
                e
            )
            
        } catch (e: SecurityException) {
            // Missing permissions
            Log.e("StepCounter", "Permission denied: ${e.message}")
            promise.reject(
                "PERMISSION_DENIED", 
                "Missing required permissions",
                e
            )
            
        } catch (e: Exception) {
            // Any other error
            Log.e("StepCounter", "Service start error: ${e.message}")
            promise.reject(
                "UNKNOWN_ERROR", 
                "Failed to start service: ${e.message}",
                e
            )
        }
    }

    @ReactMethod
    fun stopBackgroundService(promise: Promise) {
        try {
            val serviceIntent = Intent(reactApplicationContext, StepCounterService::class.java)
            reactApplicationContext.stopService(serviceIntent)
            promise.resolve(true)
            Log.d("StepCounter", "Background service stopped")
        } catch (e: Exception) {
            Log.e("StepCounter", "Error stopping service: ${e.message}")
            promise.reject("STOP_FAILED", "Failed to stop service", e)
        }
    }

    override fun onSensorChanged(event: SensorEvent?) {
        event?.let {
            if (it.sensor.type == Sensor.TYPE_STEP_COUNTER) {
                sendEvent("StepCounterUpdate", it.values[0].toDouble())
            }
        }
    }

    private fun sendEvent(eventName: String, steps: Double) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, steps)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
}
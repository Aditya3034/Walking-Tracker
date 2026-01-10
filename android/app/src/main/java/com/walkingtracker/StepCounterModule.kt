package com.walkingtracker

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.content.Intent      // ← ADD THIS
import android.os.Build         // ← ADD THIS

class StepCounterModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext), SensorEventListener {
    
    private val sensorManager: SensorManager = reactContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val stepCounterSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)

    override fun getName(): String = "StepCounter"

    @ReactMethod
    fun startStepCounter() {
        stepCounterSensor?.let { 
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
        }
    }

    @ReactMethod
    fun stopStepCounter() {
        sensorManager.unregisterListener(this)
    }

    override fun onSensorChanged(event: SensorEvent?) {
        event?.let {
            if (it.sensor.type == Sensor.TYPE_STEP_COUNTER) {
                sendEvent("StepCounterUpdate", it.values[0].toDouble())
            }
        }
    }

    @ReactMethod
    fun startBackgroundService() {
        val serviceIntent = Intent(reactApplicationContext, StepCounterService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactApplicationContext.startForegroundService(serviceIntent)
        } else {
            reactApplicationContext.startService(serviceIntent)
        }
    }

    @ReactMethod
    fun stopBackgroundService() {
        val serviceIntent = Intent(reactApplicationContext, StepCounterService::class.java)
        reactApplicationContext.stopService(serviceIntent)
    }

    private fun sendEvent(eventName: String, steps: Double) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, steps)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
}

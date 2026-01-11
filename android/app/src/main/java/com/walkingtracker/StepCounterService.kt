package com.walkingtracker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

class StepCounterService : Service(), SensorEventListener {
    
    private lateinit var sensorManager: SensorManager
    private var stepCounterSensor: Sensor? = null
    private var notificationManager: NotificationManager? = null
    private var currentSteps = 0
    
    companion object {
        const val CHANNEL_ID = "StepCounterChannel"
        const val NOTIFICATION_ID = 1001
        private const val TAG = "StepCounterService"
    }

    override fun onCreate() {
        super.onCreate()
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        stepCounterSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
        notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            val notification = createNotification(currentSteps)
            
            // Handle different Android versions for foreground service
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> {
                    // Android 14+ (API 34+) - requires service type
                    startForeground(
                        NOTIFICATION_ID, 
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH
                    )
                }
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> {
                    // Android 10-13 (API 29-33)
                    startForeground(NOTIFICATION_ID, notification)
                }
                else -> {
                    // Android 7-9 (API 24-28)
                    startForeground(NOTIFICATION_ID, notification)
                }
            }
            
            // Register sensor listener
            stepCounterSensor?.let {
                sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
                Log.d(TAG, "Step counter sensor registered")
            } ?: run {
                Log.e(TAG, "No step counter sensor available")
                stopSelf() // Stop service if no sensor
            }
            
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start foreground service: ${e.message}", e)
            stopSelf()
        }
        
        return START_STICKY // Auto-restart if killed
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Step Counter",
                NotificationManager.IMPORTANCE_LOW
            ).apply { 
                description = "Tracks your steps 24/7"
                setSound(null, null)
                setShowBadge(false)
            }
            notificationManager?.createNotificationChannel(channel)
        }
    }

    private fun createNotification(steps: Int): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntentFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        
        val pendingIntent = PendingIntent.getActivity(
            this, 
            0, 
            launchIntent ?: Intent(this, javaClass), 
            pendingIntentFlags
        )
        
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Walking Tracker")
            .setContentText("Steps today: $steps")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setSilent(true)
            .build()
    }

    override fun onSensorChanged(event: SensorEvent?) {
        event?.let {
            if (it.sensor.type == Sensor.TYPE_STEP_COUNTER) {
                currentSteps = it.values[0].toInt()
                updateNotification()
            }
        }
    }

    private fun updateNotification() {
        val notification = createNotification(currentSteps)
        notificationManager?.notify(NOTIFICATION_ID, notification)
    }

    override fun onDestroy() {
        super.onDestroy()
        sensorManager.unregisterListener(this)
        Log.d(TAG, "Service destroyed")
    }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
}
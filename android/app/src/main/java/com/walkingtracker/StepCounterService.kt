// package com.walkingtracker

// import android.app.Notification
// import android.app.NotificationChannel
// import android.app.NotificationManager
// import android.app.PendingIntent
// import android.app.Service
// import android.content.Context
// import android.content.Intent
// import android.content.pm.ServiceInfo
// import android.hardware.Sensor
// import android.hardware.SensorEvent
// import android.hardware.SensorEventListener
// import android.hardware.SensorManager
// import android.os.Build
// import android.os.IBinder
// import android.util.Log
// import androidx.core.app.NotificationCompat

// class StepCounterService : Service(), SensorEventListener {
    
//     private lateinit var sensorManager: SensorManager
//     private var stepCounterSensor: Sensor? = null
//     private var notificationManager: NotificationManager? = null
    
//     // NEW: Track baseline and session steps
//     private var initialStepCount = -1  // Steps when service started
//     private var currentSteps = 0       // Steps since service started
    
//     companion object {
//         const val CHANNEL_ID = "StepCounterChannel"
//         const val NOTIFICATION_ID = 1001
//         private const val TAG = "StepCounterService"
//     }

//     override fun onCreate() {
//         super.onCreate()
//         sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
//         stepCounterSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
//         notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
//         createNotificationChannel()
//     }

//     override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
//         try {
//             val notification = createNotification(currentSteps)
            
//             when {
//                 Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> {
//                     startForeground(
//                         NOTIFICATION_ID, 
//                         notification,
//                         ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH
//                     )
//                 }
//                 Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> {
//                     startForeground(NOTIFICATION_ID, notification)
//                 }
//                 else -> {
//                     startForeground(NOTIFICATION_ID, notification)
//                 }
//             }
            
//             stepCounterSensor?.let {
//                 sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
//                 Log.d(TAG, "Step counter sensor registered")
//             } ?: run {
//                 Log.e(TAG, "No step counter sensor available")
//                 stopSelf()
//             }
            
//         } catch (e: Exception) {
//             Log.e(TAG, "Failed to start foreground service: ${e.message}", e)
//             stopSelf()
//         }
        
//         return START_STICKY
//     }

//     private fun createNotificationChannel() {
//         if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
//             val channel = NotificationChannel(
//                 CHANNEL_ID,
//                 "Step Counter",
//                 NotificationManager.IMPORTANCE_LOW
//             ).apply { 
//                 description = "Tracks your steps 24/7"
//                 setSound(null, null)
//                 setShowBadge(false)
//             }
//             notificationManager?.createNotificationChannel(channel)
//         }
//     }

//     private fun createNotification(steps: Int): Notification {
//         val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
//         val pendingIntentFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
//             PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
//         } else {
//             PendingIntent.FLAG_UPDATE_CURRENT
//         }
        
//         val pendingIntent = PendingIntent.getActivity(
//             this, 
//             0, 
//             launchIntent ?: Intent(this, javaClass), 
//             pendingIntentFlags
//         )
        
//         return NotificationCompat.Builder(this, CHANNEL_ID)
//             .setContentTitle("Walking Tracker")
//             .setContentText("Steps: $steps")  // Removed "today" since it's session-based
//             .setSmallIcon(android.R.drawable.ic_menu_compass)
//             .setContentIntent(pendingIntent)
//             .setOngoing(true)
//             .setPriority(NotificationCompat.PRIORITY_LOW)
//             .setCategory(NotificationCompat.CATEGORY_SERVICE)
//             .setSilent(true)
//             .build()
//     }

//     override fun onSensorChanged(event: SensorEvent?) {
//         event?.let {
//             if (it.sensor.type == Sensor.TYPE_STEP_COUNTER) {
//                 val totalSteps = it.values[0].toInt()
                
//                 // First reading - set baseline
//                 if (initialStepCount < 0) {
//                     initialStepCount = totalSteps
//                     currentSteps = 0
//                     Log.d(TAG, "Baseline set: $initialStepCount")
//                 } else {
//                     // Calculate steps since service started
//                     currentSteps = totalSteps - initialStepCount
//                     if (currentSteps < 0) {
//                         // Phone was rebooted - reset baseline
//                         initialStepCount = totalSteps
//                         currentSteps = 0
//                     }
//                 }
                
//                 updateNotification()
//             }
//         }
//     }

//     private fun updateNotification() {
//         val notification = createNotification(currentSteps)
//         notificationManager?.notify(NOTIFICATION_ID, notification)
//     }

//     override fun onDestroy() {
//         super.onDestroy()
//         sensorManager.unregisterListener(this)
//         // Reset for next session
//         initialStepCount = -1
//         currentSteps = 0
//         Log.d(TAG, "Service destroyed")
//     }

//     override fun onBind(intent: Intent?): IBinder? = null
//     override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
// }










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
import kotlin.math.sqrt
import kotlin.math.abs

class StepCounterService : Service(), SensorEventListener {
    
    private lateinit var sensorManager: SensorManager
    private var notificationManager: NotificationManager? = null
    
    // Sensors (may be null on some devices)
    private var stepCounterSensor: Sensor? = null
    private var accelerometerSensor: Sensor? = null
    private var gyroscopeSensor: Sensor? = null
    
    // Operating mode
    private var useHardwareSensor = false
    private var useAccelerometerOnly = false
    
    // Step tracking
    private var hardwareStepCount = -1
    private var initialHardwareSteps = -1
    private var algorithmStepCount = 0
    private var fusedStepCount = 0
    
    // Accelerometer-based detection
    private var lastAcceleration = 9.81f
    private var currentAcceleration = 9.81f
    private var lastStepTime = 0L
    private val stepThreshold = 3.0f
    private val minStepInterval = 250L
    private val maxStepInterval = 2000L
    
    // Activity detection
    private var isWalking = false
    private var isDriving = false
    private var consecutiveSteps = 0
    private var lastActivityCheck = 0L
    
    // Gyroscope for noise filtering
    private var rotationMagnitude = 0f
    
    companion object {
        const val CHANNEL_ID = "StepCounterChannel"
        const val NOTIFICATION_ID = 1001
        private const val TAG = "StepCounterService"
        
        private const val DRIVING_THRESHOLD = 4.0f
        private const val WALKING_ACCEL_MIN = 8.5f
        private const val WALKING_ACCEL_MAX = 14.0f
    }

    override fun onCreate() {
        super.onCreate()
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        
        // Check sensor availability
        stepCounterSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
        accelerometerSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        gyroscopeSensor = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
        
        // Determine operating mode
        when {
            stepCounterSensor != null -> {
                useHardwareSensor = true
                useAccelerometerOnly = false
                Log.i(TAG, "✅ Hardware step counter available - HIGH ACCURACY MODE")
            }
            accelerometerSensor != null -> {
                useHardwareSensor = false
                useAccelerometerOnly = true
                Log.i(TAG, "⚠️ No hardware step counter - ACCELEROMETER-ONLY MODE")
            }
            else -> {
                Log.e(TAG, "❌ NO SENSORS AVAILABLE - Cannot track steps!")
            }
        }
        
        notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (stepCounterSensor == null && accelerometerSensor == null) {
            Log.e(TAG, "Device has no compatible sensors - stopping service")
            showErrorNotification("Your device doesn't support step counting")
            stopSelf()
            return START_NOT_STICKY
        }
        
        try {
            val notification = createNotification(fusedStepCount, getAccuracyLevel())
            
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> {
                    startForeground(NOTIFICATION_ID, notification, 
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH)
                }
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> {
                    startForeground(NOTIFICATION_ID, notification)
                }
                else -> {
                    startForeground(NOTIFICATION_ID, notification)
                }
            }
            
            registerSensors()
            
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start service: ${e.message}", e)
            stopSelf()
        }
        
        return START_STICKY
    }

    private fun registerSensors() {
        var sensorsRegistered = 0
        
        stepCounterSensor?.let {
            val success = sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
            if (success) {
                sensorsRegistered++
                Log.d(TAG, "✅ Hardware step counter registered")
            } else {
                Log.w(TAG, "⚠️ Failed to register hardware step counter")
                stepCounterSensor = null
                useHardwareSensor = false
                useAccelerometerOnly = true
            }
        }
        
        accelerometerSensor?.let {
            val success = sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
            if (success) {
                sensorsRegistered++
                Log.d(TAG, "✅ Accelerometer registered")
            } else {
                Log.e(TAG, "❌ Failed to register accelerometer")
            }
        }
        
        gyroscopeSensor?.let {
            val success = sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
            if (success) {
                sensorsRegistered++
                Log.d(TAG, "✅ Gyroscope registered")
            }
        }
        
        if (sensorsRegistered == 0) {
            Log.e(TAG, "❌ No sensors could be registered!")
            showErrorNotification("Sensor registration failed")
            stopSelf()
        } else {
            Log.i(TAG, "✅ $sensorsRegistered sensor(s) registered successfully")
        }
    }

    override fun onSensorChanged(event: SensorEvent?) {
        event?.let {
            when (it.sensor.type) {
                Sensor.TYPE_STEP_COUNTER -> handleHardwareSteps(it)
                Sensor.TYPE_ACCELEROMETER -> handleAccelerometer(it)
                Sensor.TYPE_GYROSCOPE -> handleGyroscope(it)
            }
        }
    }

    private fun handleHardwareSteps(event: SensorEvent) {
        val totalSteps = event.values[0].toInt()
        
        if (initialHardwareSteps < 0) {
            initialHardwareSteps = totalSteps
            hardwareStepCount = 0
            Log.d(TAG, "Baseline set: $initialHardwareSteps")
        } else {
            hardwareStepCount = totalSteps - initialHardwareSteps
            if (hardwareStepCount < 0) {
                initialHardwareSteps = totalSteps
                hardwareStepCount = 0
                Log.w(TAG, "Sensor reset detected - resetting baseline")
            }
        }
        
        fuseStepCounts()
    }

    private fun handleAccelerometer(event: SensorEvent) {
        val x = event.values[0]
        val y = event.values[1]
        val z = event.values[2]
        
        currentAcceleration = sqrt(x * x + y * y + z * z)
        
        val currentTime = System.currentTimeMillis()
        if (currentTime - lastActivityCheck > 500) {
            detectActivity(currentAcceleration)
            lastActivityCheck = currentTime
        }
        
        if (isWalking && !isDriving) {
            detectStepFromAccelerometer(currentAcceleration, currentTime)
        }
        
        lastAcceleration = currentAcceleration
    }

    private fun handleGyroscope(event: SensorEvent) {
        val x = event.values[0]
        val y = event.values[1]
        val z = event.values[2]
        
        rotationMagnitude = sqrt(x * x + y * y + z * z)
        isDriving = rotationMagnitude > DRIVING_THRESHOLD
    }

    private fun detectActivity(acceleration: Float) {
        val isCurrentlyWalking = acceleration in WALKING_ACCEL_MIN..WALKING_ACCEL_MAX
        
        if (isCurrentlyWalking) {
            consecutiveSteps++
            if (consecutiveSteps > 2) {
                isWalking = true
            }
        } else {
            consecutiveSteps = 0
            if (!isCurrentlyWalking && consecutiveSteps == 0) {
                isWalking = false
            }
        }
    }

    private fun detectStepFromAccelerometer(acceleration: Float, currentTime: Long) {
        val timeSinceLastStep = currentTime - lastStepTime
        val accelerationDelta = abs(acceleration - lastAcceleration)
        
        if (accelerationDelta > stepThreshold && 
            timeSinceLastStep > minStepInterval &&
            timeSinceLastStep < maxStepInterval) {
            
            algorithmStepCount++
            lastStepTime = currentTime
            
            Log.v(TAG, "Step detected | Algorithm: $algorithmStepCount")
            fuseStepCounts()
        }
    }

    private fun fuseStepCounts() {
        fusedStepCount = when {
            useHardwareSensor && hardwareStepCount >= 0 -> {
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
            useAccelerometerOnly -> algorithmStepCount
            else -> maxOf(hardwareStepCount, algorithmStepCount, 0)
        }
        
        updateNotification()
    }

    private fun getAccuracyLevel(): String {
        return when {
            useHardwareSensor && gyroscopeSensor != null -> "🎯 High"
            useHardwareSensor -> "📊 Good"
            useAccelerometerOnly -> "⚠️ Standard"
            else -> "❓ Unknown"
        }
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

    private fun createNotification(steps: Int, accuracy: String): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntentFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        
        val pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent ?: Intent(this, javaClass), pendingIntentFlags
        )
        
        val statusIcon = if (isWalking) "🚶" else ""
        
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Walking Tracker $accuracy")
            .setContentText("Steps: $steps $statusIcon")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setSilent(true)
            .build()
    }

    private fun showErrorNotification(message: String) {
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Step Tracker Error")
            .setContentText(message)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .build()
        
        notificationManager?.notify(NOTIFICATION_ID + 1, notification)
    }

    private fun updateNotification() {
        try {
            val notification = createNotification(fusedStepCount, getAccuracyLevel())
            notificationManager?.notify(NOTIFICATION_ID, notification)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to update notification: ${e.message}")
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        sensorManager.unregisterListener(this)
        
        hardwareStepCount = -1
        initialHardwareSteps = -1
        algorithmStepCount = 0
        fusedStepCount = 0
        
        Log.d(TAG, "Service destroyed")
    }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
        Log.d(TAG, "Sensor accuracy changed: $accuracy")
    }
}
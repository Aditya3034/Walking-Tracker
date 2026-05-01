package com.walkingtracker

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.lang.ref.WeakReference
import java.util.UUID
import kotlin.math.abs
import kotlin.math.sqrt

class StepCounterService : Service(), SensorEventListener {

    /* ============================================================
       STEP COUNTER
       ============================================================ */
    private lateinit var sensorManager: SensorManager
    private var notificationManager: NotificationManager? = null

    private var stepCounterSensor: Sensor? = null
    private var accelerometerSensor: Sensor? = null
    private var gyroscopeSensor: Sensor? = null

    private var useHardwareSensor = false
    private var useAccelerometerOnly = false

    private var hardwareStepCount = -1
    private var initialHardwareSteps = -1
    private var algorithmStepCount = 0
    private var fusedStepCount = 0

    private var lastAcceleration = 9.81f
    private var currentAcceleration = 9.81f
    private var lastStepTime = 0L
    private val stepThreshold = 3.0f
    private val minStepInterval = 250L
    private val maxStepInterval = 2000L

    private var isWalking = false
    private var isDriving = false
    private var consecutiveSteps = 0
    private var idleFrames = 0
    private var lastActivityCheck = 0L
    private var rotationMagnitude = 0f

    /* ============================================================
       GPS
       ============================================================ */
    private var locationManager: LocationManager? = null
    private val routePoints = mutableListOf<Pair<Double, Double>>()

    private var lastAcceptedLocation: Location? = null

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            // Reject low-accuracy fixes (e.g. network/wifi guesses)
            if (location.hasAccuracy() && location.accuracy > 30f) return

            // Reject spikes — same 150m threshold used on the JS side
            val last = lastAcceptedLocation
            if (last != null && last.distanceTo(location) > 150f) {
                lastAcceptedLocation = location  // update anchor so next real point isn't blocked
                return
            }

            lastAcceptedLocation = location
            routePoints.add(Pair(location.latitude, location.longitude))
            persistRoute()
        }
        @Deprecated("Deprecated in API 29")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) { Log.w(TAG, "GPS provider disabled") }
    }

    /* ============================================================
       BLE GATT CLIENT
       ============================================================ */
    private var bluetoothGatt: BluetoothGatt? = null
    private var writeChar: BluetoothGattCharacteristic? = null
    private var bleConnected = false
    private var currentDeviceId: String? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var reconnectRunnable: Runnable? = null

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                Log.i(TAG, "BLE connected — discovering services")
                gatt.discoverServices()
            } else {
                Log.i(TAG, "BLE disconnected status=$status")
                bleConnected = false
                writeChar = null
                // Clear stored hunger so it doesn't show stale overlay on next app open
                getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit().putString(BLE_HUNGER_KEY, "NORMAL").apply()
                emitToJs("BleConnectionUpdate", "disconnected")
                currentDeviceId?.let { scheduleReconnect(it) }
            }
        }

        @SuppressLint("MissingPermission")
        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                Log.e(TAG, "Service discovery failed: $status")
                return
            }
            val service = gatt.getService(BLE_SERVICE_UUID) ?: run {
                Log.e(TAG, "Pet service not found on device")
                return
            }
            writeChar = service.getCharacteristic(BLE_WRITE_UUID)

            // Enable notifications on NOTIFY characteristic
            val notifyChar = service.getCharacteristic(BLE_NOTIFY_UUID)
            if (notifyChar != null) {
                gatt.setCharacteristicNotification(notifyChar, true)
                val descriptor = notifyChar.getDescriptor(BLE_CCCD_UUID)
                if (descriptor != null) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                    } else {
                        @Suppress("DEPRECATION")
                        descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        @Suppress("DEPRECATION")
                        gatt.writeDescriptor(descriptor)
                    }
                }
            }

            bleConnected = true
            emitToJs("BleConnectionUpdate", "connected")
            // Write CONNECTED so ESP32 replies with current hunger state
            mainHandler.postDelayed({ writeBle("CONNECTED") }, 300)

            // Read Pet ID (fires onCharacteristicRead callback below)
            val petIdChar = service.getCharacteristic(BLE_PETID_UUID)
            if (petIdChar != null) {
                Log.d(TAG, "petIdChar found on device, will read in 500ms")
                mainHandler.postDelayed({
                    try {
                        val ok = gatt.readCharacteristic(petIdChar)
                        Log.d(TAG, "petId read requested, success=$ok")
                    } catch (e: Exception) { Log.w(TAG, "petId read threw: ${e.message}") }
                }, 500)
            } else {
                Log.w(TAG, "petIdChar NOT found on device — ESP32 firmware likely missing the new characteristic")
            }
        }

        // API 33+
        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int
        ) {
            if (status == BluetoothGatt.GATT_SUCCESS && characteristic.uuid == BLE_PETID_UUID) {
                val petId = String(value).trim()
                Log.d(TAG, "Pet ID read: $petId")
                emitToJs("BlePetIdUpdate", petId)
            }
        }

        // API < 33
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int
        ) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU &&
                status == BluetoothGatt.GATT_SUCCESS &&
                characteristic.uuid == BLE_PETID_UUID) {
                val petId = String(characteristic.value).trim()
                Log.d(TAG, "Pet ID read: $petId")
                emitToJs("BlePetIdUpdate", petId)
            }
        }

        // API 33+
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            handleBleNotification(String(value).trim())
        }

        // API < 33
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                handleBleNotification(characteristic.getStringValue(0)?.trim() ?: return)
            }
        }
    }

    private fun handleBleNotification(msg: String) {
        Log.d(TAG, "BLE notify: $msg")
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(BLE_HUNGER_KEY, msg).apply()
        emitToJs("BleHungerUpdate", msg)
    }

    @SuppressLint("MissingPermission")
    fun connectBle(deviceId: String) {
        reconnectRunnable?.let { mainHandler.removeCallbacks(it) }
        reconnectRunnable = null

        bluetoothGatt?.close()
        bluetoothGatt = null
        bleConnected = false
        writeChar = null

        currentDeviceId = deviceId

        try {
            val btManager = getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            val adapter = btManager?.adapter
            if (adapter == null || !adapter.isEnabled) {
                Log.e(TAG, "Bluetooth not available")
                return
            }
            val device = adapter.getRemoteDevice(deviceId)
            Log.i(TAG, "Connecting to BLE: $deviceId")
            bluetoothGatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                device.connectGatt(this, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
            } else {
                @Suppress("DEPRECATION")
                device.connectGatt(this, false, gattCallback)
            }
        } catch (e: Exception) {
            Log.e(TAG, "BLE connect error: ${e.message}")
        }
    }

    @SuppressLint("MissingPermission")
    fun disconnectBle() {
        reconnectRunnable?.let { mainHandler.removeCallbacks(it) }
        reconnectRunnable = null
        currentDeviceId = null
        bluetoothGatt?.disconnect()
        bluetoothGatt?.close()
        bluetoothGatt = null
        bleConnected = false
        writeChar = null
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(BLE_HUNGER_KEY, "NORMAL").apply()
        emitToJs("BleConnectionUpdate", "disconnected")
    }

    @SuppressLint("MissingPermission")
    fun writeBle(message: String) {
        val gatt = bluetoothGatt ?: return
        val char = writeChar ?: return
        if (!bleConnected) return
        try {
            val bytes = message.toByteArray(Charsets.UTF_8)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                gatt.writeCharacteristic(char, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
            } else {
                @Suppress("DEPRECATION")
                char.value = bytes
                @Suppress("DEPRECATION")
                gatt.writeCharacteristic(char)
            }
        } catch (e: Exception) {
            Log.e(TAG, "BLE write error: ${e.message}")
        }
    }

    private fun scheduleReconnect(deviceId: String) {
        reconnectRunnable?.let { mainHandler.removeCallbacks(it) }
        reconnectRunnable = Runnable {
            if (currentDeviceId != null && !bleConnected) {
                Log.i(TAG, "Auto-reconnecting to $deviceId")
                connectBle(deviceId)
            }
        }
        mainHandler.postDelayed(reconnectRunnable!!, 3000)
    }

    /* ============================================================
       COMPANION / CONSTANTS
       ============================================================ */
    companion object {
        const val CHANNEL_ID = "StepCounterChannel"
        const val NOTIFICATION_ID = 1001
        const val PREFS_NAME = "StepTracker"
        const val PREFS_STEPS_KEY = "background_steps"
        const val PREFS_ROUTE_KEY = "background_route"
        const val BLE_PREFS_KEY       = "ble_device_id"
        const val BLE_HUNGER_KEY      = "ble_hunger_state"
        const val PREFS_TRACKING_KEY  = "tracking_active"
        private const val TAG = "StepCounterService"

        private const val DRIVING_THRESHOLD   = 4.0f
        private const val WALKING_ACCEL_MIN   = 8.5f
        private const val WALKING_ACCEL_MAX   = 14.0f

        val BLE_SERVICE_UUID = UUID.fromString("4fafc201-1fb5-459e-8fcc-c5c9c331914b")
        val BLE_WRITE_UUID   = UUID.fromString("beb5483e-36e1-4688-b7f5-ea07361b26a8")
        val BLE_NOTIFY_UUID  = UUID.fromString("beb5483e-36e1-4688-b7f5-ea07361b26a9")
        val BLE_PETID_UUID   = UUID.fromString("beb5483e-36e1-4688-b7f5-ea07361b26aa")
        val BLE_CCCD_UUID    = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        const val ACTION_CONNECT_BLE         = "com.walkingtracker.CONNECT_BLE"
        const val ACTION_DISCONNECT_BLE      = "com.walkingtracker.DISCONNECT_BLE"
        const val ACTION_WRITE_BLE           = "com.walkingtracker.WRITE_BLE"
        const val ACTION_FOREGROUND_ACTIVE   = "com.walkingtracker.FOREGROUND_ACTIVE"
        const val ACTION_FOREGROUND_INACTIVE = "com.walkingtracker.FOREGROUND_INACTIVE"
        const val ACTION_QUERY_BLE_STATE     = "com.walkingtracker.QUERY_BLE_STATE"
        const val ACTION_CLEAR_SESSION       = "com.walkingtracker.CLEAR_SESSION"
        const val ACTION_START_TRACKING      = "com.walkingtracker.START_TRACKING"
        const val ACTION_STOP_TRACKING       = "com.walkingtracker.STOP_TRACKING"

        // True when StepCounterModule (foreground) has its own sensors active
        // — service skips emitting StepCounterUpdate to avoid double-counting
        @Volatile var foregroundModuleActive = false

        // True when a walk session is actively in progress
        @Volatile var trackingActive = false

        private var reactContextRef: WeakReference<ReactApplicationContext>? = null
        fun setReactContext(context: ReactApplicationContext) {
            reactContextRef = WeakReference(context)
        }
    }

    /* ============================================================
       SERVICE LIFECYCLE
       ============================================================ */
    override fun onCreate() {
        super.onCreate()
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager

        stepCounterSensor  = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
        accelerometerSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        gyroscopeSensor    = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)

        when {
            stepCounterSensor != null -> { useHardwareSensor = true;  useAccelerometerOnly = false }
            accelerometerSensor != null -> { useHardwareSensor = false; useAccelerometerOnly = true }
            else -> Log.e(TAG, "No sensors available")
        }

        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Handle commands sent from StepCounterModule
        when (intent?.action) {
            ACTION_CONNECT_BLE -> {
                val deviceId = intent.getStringExtra("deviceId") ?: return START_STICKY
                ensureForeground()
                connectBle(deviceId)
                return START_STICKY
            }
            ACTION_DISCONNECT_BLE -> {
                disconnectBle()
                return START_STICKY
            }
            ACTION_WRITE_BLE -> {
                val command = intent.getStringExtra("command") ?: return START_STICKY
                writeBle(command)
                return START_STICKY
            }
            ACTION_FOREGROUND_ACTIVE -> {
                foregroundModuleActive = true
                return START_STICKY
            }
            ACTION_FOREGROUND_INACTIVE -> {
                foregroundModuleActive = false
                return START_STICKY
            }
            ACTION_QUERY_BLE_STATE -> {
                if (bleConnected) {
                    emitToJs("BleConnectionUpdate", "connected")
                    val hunger = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .getString(BLE_HUNGER_KEY, "NORMAL") ?: "NORMAL"
                    emitToJs("BleHungerUpdate", hunger)
                } else {
                    // Explicitly sync JS to disconnected — clears stale "connected" UI
                    emitToJs("BleConnectionUpdate", "disconnected")
                    emitToJs("BleHungerUpdate", "NORMAL")
                }
                return START_STICKY
            }
            ACTION_CLEAR_SESSION -> {
                hardwareStepCount = -1; initialHardwareSteps = -1
                algorithmStepCount = 0; fusedStepCount = 0
                routePoints.clear()
                lastAcceptedLocation = null
                trackingActive = false
                getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .remove(PREFS_STEPS_KEY)
                    .remove(PREFS_ROUTE_KEY)
                    .putBoolean(PREFS_TRACKING_KEY, false)
                    .apply()
                return START_STICKY
            }
            ACTION_START_TRACKING -> {
                trackingActive = true
                getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit().putBoolean(PREFS_TRACKING_KEY, true).apply()
                if (!foregroundModuleActive) {
                    registerSensors()
                    startLocationTracking()
                }
                return START_STICKY
            }
            ACTION_STOP_TRACKING -> {
                trackingActive = false
                getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit().putBoolean(PREFS_TRACKING_KEY, false).apply()
                if (!foregroundModuleActive) {
                    sensorManager.unregisterListener(this)
                    locationManager?.removeUpdates(locationListener)
                    routePoints.clear()
                }
                return START_STICKY
            }
        }

        // Normal start (sensors + GPS)
        if (stepCounterSensor == null && accelerometerSensor == null) {
            Log.e(TAG, "No sensors — stopping")
            stopSelf()
            return START_NOT_STICKY
        }

        try {
            val notification = createNotification(fusedStepCount)
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
                    startForeground(NOTIFICATION_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
                else -> startForeground(NOTIFICATION_ID, notification)
            }
            isForeground = true
            // On service restart (intent == null), read persisted flag so sensors/GPS
            // resume automatically after Android kills and restarts the service mid-session
            val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            if (intent == null) {
                trackingActive = prefs.getBoolean(PREFS_TRACKING_KEY, false)
            }
            if (trackingActive) {
                registerSensors()
                startLocationTracking()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Service start failed: ${e.message}")
            stopSelf()
        }

        // Auto-reconnect to last BLE device if stored
        val savedId = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(BLE_PREFS_KEY, null)
        if (savedId != null && !bleConnected) {
            mainHandler.postDelayed({ connectBle(savedId) }, 1500)
        }

        return START_STICKY
    }

    private var isForeground = false
    private fun ensureForeground() {
        if (isForeground) return
        try {
            val notification = createNotification(fusedStepCount)
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
                    startForeground(NOTIFICATION_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
                else -> startForeground(NOTIFICATION_ID, notification)
            }
            isForeground = true
        } catch (e: Exception) {
            Log.e(TAG, "ensureForeground failed: ${e.message}")
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        sensorManager.unregisterListener(this)
        locationManager?.removeUpdates(locationListener)
        routePoints.clear()

        reconnectRunnable?.let { mainHandler.removeCallbacks(it) }
        bluetoothGatt?.disconnect()
        bluetoothGatt?.close()
        bluetoothGatt = null

        hardwareStepCount = -1; initialHardwareSteps = -1
        algorithmStepCount = 0; fusedStepCount = 0
        consecutiveSteps = 0; idleFrames = 0; isWalking = false

        // Don't wipe steps/route here — JS reads them via getBackgroundSteps/getBackgroundRoute
        // They are cleared by JS after the session is saved (finishTracking flow)
        Log.d(TAG, "Service destroyed")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /* ============================================================
       GPS
       ============================================================ */
    private fun startLocationTracking() {
        try {
            val provider = if (locationManager?.isProviderEnabled(LocationManager.GPS_PROVIDER) == true)
                LocationManager.GPS_PROVIDER else LocationManager.NETWORK_PROVIDER
            locationManager?.requestLocationUpdates(provider, 1500L, 3f, locationListener)
        } catch (e: SecurityException) {
            Log.e(TAG, "GPS permission denied: ${e.message}")
        } catch (e: Exception) {
            Log.e(TAG, "GPS start failed: ${e.message}")
        }
    }

    private fun persistRoute() {
        val json = buildString {
            append("[")
            routePoints.forEachIndexed { i, (lat, lng) ->
                if (i > 0) append(",")
                append("""{"lat":$lat,"lng":$lng}""")
            }
            append("]")
        }
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString(PREFS_ROUTE_KEY, json).apply()
    }

    /* ============================================================
       SENSORS
       ============================================================ */
    private fun registerSensors() {
        var registered = 0
        stepCounterSensor?.let {
            if (sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)) registered++
            else { stepCounterSensor = null; useHardwareSensor = false; useAccelerometerOnly = true }
        }
        accelerometerSensor?.let {
            if (sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)) registered++
        }
        gyroscopeSensor?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
        }
        if (registered == 0) { stopSelf() }
    }

    override fun onSensorChanged(event: SensorEvent?) {
        event?.let {
            when (it.sensor.type) {
                Sensor.TYPE_STEP_COUNTER  -> handleHardwareSteps(it)
                Sensor.TYPE_ACCELEROMETER -> handleAccelerometer(it)
                Sensor.TYPE_GYROSCOPE     -> handleGyroscope(it)
            }
        }
    }

    private fun handleHardwareSteps(event: SensorEvent) {
        val total = event.values[0].toInt()
        if (initialHardwareSteps < 0) { initialHardwareSteps = total; hardwareStepCount = 0 }
        else {
            hardwareStepCount = total - initialHardwareSteps
            if (hardwareStepCount < 0) { initialHardwareSteps = total; hardwareStepCount = 0 }
        }
        fuseStepCounts()
    }

    private fun handleAccelerometer(event: SensorEvent) {
        val x = event.values[0]; val y = event.values[1]; val z = event.values[2]
        currentAcceleration = sqrt(x * x + y * y + z * z)
        val now = System.currentTimeMillis()
        if (now - lastActivityCheck > 500) { detectActivity(currentAcceleration); lastActivityCheck = now }
        if (isWalking && !isDriving) detectStepFromAccelerometer(currentAcceleration, now)
        lastAcceleration = currentAcceleration
    }

    private fun handleGyroscope(event: SensorEvent) {
        val x = event.values[0]; val y = event.values[1]; val z = event.values[2]
        rotationMagnitude = sqrt(x * x + y * y + z * z)
        isDriving = rotationMagnitude > DRIVING_THRESHOLD
    }

    private fun detectActivity(acc: Float) {
        if (acc in WALKING_ACCEL_MIN..WALKING_ACCEL_MAX) {
            if (++consecutiveSteps > 2) isWalking = true
        } else {
            consecutiveSteps = 0
            if (idleFrames++ > 5) { isWalking = false; idleFrames = 0 }
        }
    }

    private fun detectStepFromAccelerometer(acc: Float, now: Long) {
        val elapsed = now - lastStepTime
        if (abs(acc - lastAcceleration) > stepThreshold &&
            elapsed > minStepInterval && elapsed < maxStepInterval) {
            algorithmStepCount++
            lastStepTime = now
            fuseStepCounts()
        }
    }

    private fun fuseStepCounts() {
        fusedStepCount = when {
            useHardwareSensor && hardwareStepCount >= 0 -> {
                if (algorithmStepCount > 0 && abs(hardwareStepCount - algorithmStepCount) < 15)
                    ((hardwareStepCount * 0.7) + (algorithmStepCount * 0.3)).toInt()
                else maxOf(hardwareStepCount, algorithmStepCount)
            }
            useAccelerometerOnly -> algorithmStepCount
            else -> maxOf(hardwareStepCount, algorithmStepCount, 0)
        }

        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putInt(PREFS_STEPS_KEY, fusedStepCount).apply()

        // Send steps to ESP32 via BLE (service always owns the BLE connection)
        if (bleConnected) writeBle("STEPS:$fusedStepCount")

        // Only emit StepCounterUpdate when the foreground module is NOT active.
        // When foreground module is active it has its own sensors and emits steps itself.
        // Emitting from both causes double-counting in JS.
        if (!foregroundModuleActive) {
            emitToJs("StepCounterUpdate", fusedStepCount.toDouble())
        }

        updateNotification()
    }

    /* ============================================================
       HELPERS
       ============================================================ */
    private fun emitToJs(event: String, value: Any) {
        val ctx = reactContextRef?.get() ?: return
        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                ?.emit(event, value)
        } catch (e: Exception) {
            Log.w(TAG, "emit $event failed: ${e.message}")
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "Step Counter", NotificationManager.IMPORTANCE_LOW)
                .apply { description = "Tracks steps & pet"; setSound(null, null); setShowBadge(false) }
            notificationManager?.createNotificationChannel(ch)
        }
    }

    private fun createNotification(steps: Int): Notification {
        val pi = PendingIntent.getActivity(
            this, 0,
            packageManager.getLaunchIntentForPackage(packageName) ?: Intent(this, javaClass),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            else PendingIntent.FLAG_UPDATE_CURRENT
        )
        val bleStatus = if (bleConnected) " · Pet connected" else ""
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Walking Tracker")
            .setContentText("Steps: $steps$bleStatus")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(pi)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setSilent(true)
            .build()
    }

    private fun updateNotification() {
        try {
            notificationManager?.notify(NOTIFICATION_ID, createNotification(fusedStepCount))
        } catch (e: Exception) { Log.e(TAG, "Notification update failed: ${e.message}") }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
}

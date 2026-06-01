# softwear.pet — Technical Reference

Complete functional spec for the Walking Tracker app + ESP32 firmware.

> **Maintenance:** keep this doc in sync after every functionality addition or change to either the app or the ESP32 firmware. Cross-reference [project_launch_checklist](.claude/memory/project_launch_checklist.md) and [project_leaderboard_plan](.claude/memory/project_leaderboard_plan.md) when planning.

---

## 1. Overview

**softwear.pet** is a step-tracking app paired with a custom ESP32-based pet device. Each device has a unique Pet ID that *is* the user's account identity — no email or social login.

**Stack**
- **App:** React Native (Android first, iOS deferred)
- **Hardware:** ESP32-C3 with OLED, BLE peripheral
- **Cloud:** Firebase Anonymous Auth + Firestore (Spark free tier today)

**Identity model:** pet-centric. ESP32 Pet ID = account. Pet device IS the password.

---

## 2. ESP32 Firmware

File: [esp32/src/main.cpp](esp32/src/main.cpp)

### 2.1 Unique device identifiers (set per unit at flash time)

| `#define` | Format | Example | Purpose |
|---|---|---|---|
| `PET_ID` | `KOS` + 6 digits | `KOS000001` | Pet-centric account identity |
| `DEVICE_TYPE` | `badge` \| `necklace` | `badge` | Hardware variant for inventory/UX |

Both are exposed as read-only BLE characteristics. Production firmware flasher must swap these per unit.

### 2.2 BLE service & characteristics

**Service UUID:** `4fafc201-1fb5-459e-8fcc-c5c9c331914b`

| UUID | Property | Purpose | Payload |
|---|---|---|---|
| `beb5483e-36e1-4688-b7f5-ea07361b26a8` | WRITE | Command channel | `FEED`, `CONNECTED`, `NAME:<newName>` |
| `beb5483e-36e1-4688-b7f5-ea07361b26a9` | NOTIFY | Pet state changes | `NORMAL` \| `HUNGRY` \| `STARVING` \| `FEEDING` |
| `beb5483e-36e1-4688-b7f5-ea07361b26aa` | READ | Pet ID | `KOS000001` |
| `beb5483e-36e1-4688-b7f5-ea07361b26ab` | READ | Device type | `badge` \| `necklace` |

CCCD descriptor: `00002902-0000-1000-8000-00805f9b34fb` (standard).

### 2.3 Pet mood state machine

States: `PET_NORMAL`, `PET_HUNGRY`, `PET_STARVING`, `PET_FEEDING`.

| Transition | Trigger |
|---|---|
| NORMAL → HUNGRY | 2 hours elapsed without feeding |
| HUNGRY → STARVING | 30 minutes after entering HUNGRY |
| any → FEEDING | `FEED` command received |
| FEEDING → NORMAL | 3-second feed animation completes; elapsed hunger reset to 0 |

Mood transitions emit a NOTIFY with the new state name.

### 2.4 Eye animation system

OLED renders two filled ellipses (left/right eyes) at varying rotation, position, and openness. Eye states include `NEUTRAL`, `SURPRISED`, `SAD`, `SUSPICIOUS`, `LEFT`, `RIGHT`, `UP`, `DOWN`, `EXCITED`, plus dedicated `HUNGRY`, `STARVING`, `HAPPY` (only triggered by mood).

- **NORMAL:** idle pool of states 0–8 cycled randomly every 3–7s
- **HUNGRY:** `STATE_HUNGRY` with slow blink + 2px jitter every 400ms
- **STARVING:** `STATE_STARVING` with shake bursts (2s on, 5s off, ±8px alternating)
- **FEEDING:** `STATE_HAPPY` with star spawn if recovering from hunger (6 fixed positions, 200ms pulse)
- **EXCITED:** rapid blink + sine-wave vertical bounce

Eye transitions lerp over 150ms.

### 2.5 Command handlers

Received via BLE write characteristic:

- **`FEED`** → mood becomes `FEEDING`, plays happy eye animation, resets persisted hunger
- **`CONNECTED`** → device immediately replies with current mood state via NOTIFY
- **`NAME:<newName>`** → updates BLE advertising name + persists to NVS

### 2.6 Persistence (NVS / Preferences)

| Namespace | Key | Stored |
|---|---|---|
| `pet` | `elapsed` | Hunger elapsed time in ms (saved every 5s during HUNGRY/STARVING) |
| `pet` | (device name) | Custom BLE name from `NAME:*` command |

Hunger restores across power-off — device knows mood state on boot.

---

## 3. Android Native Layer

Path: [android/app/src/main/java/com/walkingtracker/](android/app/src/main/java/com/walkingtracker/)

### 3.1 StepCounterService (foreground service)

Persistent service for step counting, GPS tracking, BLE GATT client. Survives app close.

**Foreground service types:** `health | location | connectedDevice`.

#### Step counting

- **Primary:** hardware `TYPE_STEP_COUNTER` sensor — cumulative count, service tracks baseline + delta
- **Fallback:** `TYPE_ACCELEROMETER` + `TYPE_GYROSCOPE` hybrid with custom algorithm (threshold 3.0 m/s², 250–2000ms inter-step interval)
- **Fusion:** if both available → 70% hardware + 30% algorithm weighted average; if counts diverge > 15 steps, take `max()`
- Emits `StepCounterUpdate` event to JS on every change (not every sample)

#### GPS

- `GPS_PROVIDER` primary, `NETWORK_PROVIDER` fallback
- 1.5s update interval, 3m distance filter
- Accuracy filter: drop points > 30m
- Spike filter: drop jumps > 150m
- Route persisted to SharedPreferences `background_route` as JSON

#### BLE GATT client

On connect: discover services → read Pet ID → read device type → enable notifications → write `CONNECTED`.

On notify: parse mood (NORMAL/HUNGRY/STARVING/FEEDING) → save to SharedPreferences `ble_hunger_state` → emit `BleHungerUpdate`.

Sends `STEPS:<count>` to device on every fused step update while connected.

Auto-reconnect: 3-second delay on disconnect.

#### Service actions (intents)

| Action | Purpose |
|---|---|
| `ACTION_CONNECT_BLE` | Start GATT connection to saved MAC |
| `ACTION_DISCONNECT_BLE` | Close GATT, clear BLE state |
| `ACTION_START_TRACKING` | Begin sensor + GPS collection |
| `ACTION_STOP_TRACKING` | End collection |
| `ACTION_CLEAR_SESSION` | Reset step counters, clear route |
| `ACTION_WRITE_BLE` | Forward write command (FEED, NAME:*) |
| `ACTION_FOREGROUND_ACTIVE` | Service pauses emission (JS foreground module takes over) |
| `ACTION_QUERY_BLE_STATE` | Force re-emit of cached BLE + hunger state |

### 3.2 StepCounterModule (JS bridge)

JS-callable methods exposed via NativeModules:

| Method | Purpose |
|---|---|
| `startStepCounter()` / `stopStepCounter()` | Foreground sensor registration |
| `startBackgroundService()` / `stopBackgroundService()` | Launch/stop the foreground service |
| `getBackgroundSteps()` / `getBackgroundRoute()` | Read SharedPreferences from service |
| `connectBleDevice(deviceId)` / `disconnectBleDevice()` | BLE control |
| `writeBleCommand(command)` | Forward FEED / NAME:* / etc. |
| `getBleHungerState()` | Read cached hunger state |
| `clearSessionData()` | Reset step + route state |
| `queryBleState()` | Force re-emit of BLE state (for app reopen) |
| `unpairExistingPets()` | Remove bonded `softwear-*` devices from system pairing |

### 3.3 JS events emitted

| Event | Payload | Source |
|---|---|---|
| `StepCounterUpdate` | number (fused steps) | Sensor fusion |
| `BleConnectionUpdate` | `'connected'` \| `'disconnected'` | GATT callback |
| `BlePetIdUpdate` | string Pet ID | BLE characteristic read |
| `BleDeviceTypeUpdate` | string `'badge'` \| `'necklace'` | BLE characteristic read |
| `BleHungerUpdate` | `NORMAL` \| `HUNGRY` \| `STARVING` \| `FEEDING` | BLE NOTIFY |

---

## 4. React Native App Structure

### 4.1 Routing (`App.js`)

Gates evaluated in order:

1. **Splash** — animated logo on mount until `splashDone`
2. **PermissionsOnboarding** — 3-screen carousel (BLE → Location → Activity)
3. **ConnectPetGate** — BLE scan/connect UI; has dev-skip button for emulator UI work
4. **OnboardingScreen** — username (2-15 chars, `[A-Za-z._]`) + pet name (2-15 chars, any)
5. **Checking** — "Reading pet…" indicator while Firestore lookup runs
6. **Main app** — bottom tab nav with 4 tabs

**System back button (Android):** intercepted by `BackHandler` in `App.js`. From any tab other than `home`, returns to `home`. From `home`, falls through to default behavior (app exits).

**Tracker in-screen back button:** floating black circular button at top-left of the Tracker screen (visible whenever `onBack` is provided). Returns to whichever tab the user was on right before tapping the Tracker tab (tracked in `prevTabBeforeTracker` state; defaults to `home`).

### 4.2 Bottom tab bar

Floating black pill (rounded-rectangle, `borderRadius: 36`). 4 tabs, Feather icons:

| Tab | Feather icon | Component |
|---|---|---|
| home | `home` | HomeScreen |
| tracker | `activity` | StepCounter (Tracker) |
| activities | `clipboard` | ActivitiesScreen |
| settings | `settings` | SettingsScreen |

Active state: translucent white circle behind icon.

### 4.3 Screens

#### HomeScreen ([src/HomeScreen.js](src/HomeScreen.js))

- **PetConnectCard** — BLE scan/connect, pet name + color editor
- **Step ring** (no card) — circular progress with today's step count centered; `/goal` + edit icon below if goal set; "Set goal" link if not set
- **Steps to Convert card** — converts 1000 steps → 1 treat
- **Treats card** — pending treat count, dot grid, Feed button (writes `FEED` over BLE)
- **LeaderboardCard** — top 10 pets by `totalLifetimeSteps`, user's rank shown if outside top 10

Goal modal:
- Empty input on save → goal cleared (removed from AsyncStorage, falls back to "Set goal" link)
- Non-empty numeric → saved

#### Tracker / StepCounter ([src/StepCounter.js](src/StepCounter.js))

States: `idle` → `tracking` → `paused` → `finished`.

- **Map:** Mapbox WebView via `buildMapboxHTML()` ([src/mapboxHtml.js](src/mapboxHtml.js))
- **GPS:** self-healing watch — restarts every 2s on error; rejects accuracy > 25m, spikes > 150m
- **Route segments:** new array entry on pause/resume → renders as separate polylines (no false connections)
- **Decimation:** route points capped at 500 per segment (every-other drop if exceeded)
- **Persistence:** `sessionInProgress`, `sessionDuration {start, accumulated}` in AsyncStorage — resumes mid-session after app kill
- **Save:** finalized session appended to `activities` keyed by date `YYYY-MM-DD`, emits `sessionFinished` event
- **Controls:** Feather `play` / `pause` / `square` icons in circular buttons
- **Stats row:** distance (m/km) | duration (mm:ss or hh:mm) | speed (km/h, derived live from distance ÷ duration)
- **User position marker:** blue dot (white outline + blue fill) by default. When BLE pet device is connected → swaps to a circular pet-logo marker (`src/assets/swlogo.png`) with a ~2.5px ring in the user's `petColor`. Sent to the Mapbox WebView via a `setMarker` message; live updates on color change and connect/disconnect.

#### ActivitiesScreen ([src/ActivitiesScreen.js](src/ActivitiesScreen.js))

- Month calendar grid; active days show route trace inside the cell
- Tap day → detail sheet with all sessions for that date
- Per-session card: route thumbnail, steps, distance (haversine), duration
- Stats: total steps/distance/duration/session-count

#### SettingsScreen ([src/SettingsScreen.js](src/SettingsScreen.js))

- Rendered as a full tab (no longer a modal)
- Logout button — clears AsyncStorage keys, signs out Firebase, disconnects BLE, returns to gate

### 4.4 Supporting components

| Component | Purpose |
|---|---|
| [PetConnectCard.js](src/PetConnectCard.js) | BLE scan (10s timeout), radar UI, pet name/color edit modal |
| [LeaderboardCard.js](src/LeaderboardCard.js) | Locked until BLE connected; top-10 Firestore query + rank-of-self |
| [BleStepService.js](src/BleStepService.js) | Singleton event relay for BLE events; tracks `isConnected`, hunger state |
| [WelcomeConnectCard.js](src/WelcomeConnectCard.js) | Used inside ConnectPetGate; scan + connect entry |
| [SplashScreen.js](src/SplashScreen.js) | Animated boot screen |
| [PermissionsOnboarding.js](src/PermissionsOnboarding.js) | 3-page perm request carousel |

### 4.5 Pet ID flow (App.js listener)

On `BlePetIdUpdate`:
1. Compare incoming Pet ID with cached `petId` in AsyncStorage
2. If different → **pet switch** → wipe `activities`, `username`, `petName`, `petColor`, `petNameChanged`, `lastSyncAt`, `pendingTreats`, `stepsConvertedToday` (NOT `pairedDeviceId` — same physical device may have new Pet ID)
3. Save new `petId`
4. Anonymous sign-in if not yet authed
5. Fetch `pets/{petId}` from Firestore
6. If doc exists → restore `username`, `petName`, `petColor`, `pendingTreats`, `stepsConvertedToday` (only if date matches today, local time), call `restoreSessionsFromCloud()`
7. Trigger `syncSessions()` fire-and-forget

### 4.6 Device type flow

On `BleDeviceTypeUpdate`:
1. Save to AsyncStorage `deviceType`
2. Merge into Firestore `pets/{petId}.deviceType` (if signed in + petId known)

---

## 5. Data Layer

### 5.1 AsyncStorage keys (complete list)

| Key | Type | Description |
|---|---|---|
| `petId` | string | Pet ID from BLE (`KOS...`) |
| `username` | string | Account username |
| `petName` | string | Pet display name |
| `petColor` | hex string | Pet UI color (default `#EE5514`) |
| `petNameChanged` | `'true'` | Lock flag — pet name only editable once |
| `deviceType` | string | `badge` or `necklace` (from firmware) |
| `bleDeviceName` | string | Last connected BLE advertised name |
| `pairedDeviceId` | string | Bluetooth MAC for auto-reconnect |
| `activities` | JSON | `{ "YYYY-MM-DD": [session, ...] }` |
| `stepGoal` | string number | Daily step target (deleted if unset) |
| `pendingTreats` | string number | Unfed treats earned |
| `stepsConvertedToday` | JSON `{date, steps}` | Today's already-converted steps (prevents re-claim) |
| `sessionInProgress` | `'true'` | Tracking-active flag |
| `sessionDuration` | JSON `{start, accumulated}` | Pause/resume duration math |
| `lastSyncAt` | string ms | Last cloud sync timestamp |

### 5.2 Firestore schema

```
pets/{petId}
├─ petId            string   (== document id)
├─ username         string   (2-15, [A-Za-z._], globally unique)
├─ petName          string   (2-15, any)
├─ petColor         string   ("#EE5514" default)
├─ petNameChanged   boolean
├─ deviceType       string   ("badge" | "necklace")
├─ totalLifetimeSteps   number
├─ totalWalkCount   number
├─ bestWalk         {steps: number, distance: number}
├─ pendingTreats    number
├─ stepsConvertedToday  {date: "YYYY-MM-DD", steps: number}
├─ joinDate         timestamp
├─ lastSyncAt       timestamp
└─ sessions/{sessionId}
   ├─ sessionId     string
   ├─ date          "YYYY-MM-DD"
   ├─ timestamp     number (ms)
   ├─ steps         number
   ├─ distance      number (m)
   ├─ duration      number (s)
   ├─ route         [{latitude, longitude}]      (legacy)
   └─ segments      [{points: [[lon, lat], ...]}]  (gap-aware)

usernames/{username}
└─ petId  string   (uniqueness index — points back to owning pet)
```

### 5.3 Firestore security rules ([firestore.rules](firestore.rules))

| Path | Read | Write |
|---|---|---|
| `pets/{petId}` | authed | authed AND `resource.data.petId == petId` |
| `pets/{petId}/sessions/{sid}` | authed | authed |
| `pets/{petId}/petStats/{statId}` | authed | authed |
| `usernames/{username}` | authed | authed |
| anything else | denied | denied |

> ⚠ Known issue: any authed user can `read` any pet's full session history (route data included). Pre-launch hardening required — see [project_launch_checklist](.claude/memory/project_launch_checklist.md).

### 5.4 Sync strategy ([src/syncSessions.js](src/syncSessions.js))

**Triggers:**
- On BLE Pet ID connect (fire-and-forget)
- On app open if `lastSyncAt > 24h ago` (`syncIfStale()`)
- Per-action writes for treats (immediate Firestore merge on convert/feed)

**Flow:**
1. Read `activities` from AsyncStorage
2. Backfill missing `sessionId` (UUID) and `synced: false` flags
3. Batch-write all unsynced sessions
4. Update pet doc: `totalLifetimeSteps`, `totalWalkCount`, `bestWalk`, `lastSyncAt`, `deviceType`
5. Mark sessions `synced: true`, persist back

**Restore (`restoreSessionsFromCloud`):** pulls all cloud sessions on Pet ID connect, de-dupes by `sessionId`, merges into local `activities`. Covers reinstall / new phone.

---

## 6. Permissions

### 6.1 Android (AndroidManifest.xml)

`INTERNET`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `ACTIVITY_RECOGNITION`, `BLUETOOTH`, `BLUETOOTH_ADMIN`, `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_HEALTH`, `FOREGROUND_SERVICE_LOCATION`, `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `POST_NOTIFICATIONS`, `WAKE_LOCK`.

### 6.2 iOS (Info.plist)

`NSLocationWhenInUseUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription`, `NSMotionUsageDescription`, `NSBluetoothAlwaysUsageDescription`, `NSBluetoothPeripheralUsageDescription`. `UIBackgroundModes: [location, fetch]`. `UIAppFonts: [Feather.ttf]`.

### 6.3 Runtime requests (PermissionsOnboarding)

| Platform | Requested |
|---|---|
| Android 31+ | `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT`, then `ACCESS_FINE_LOCATION`, then `ACTIVITY_RECOGNITION`, then `POST_NOTIFICATIONS` (33+) |
| Android < 31 | `ACCESS_FINE_LOCATION` (covers BLE too), then `ACTIVITY_RECOGNITION` |
| iOS | `BLUETOOTH`, `LOCATION_WHEN_IN_USE`, `MOTION` (location-always requested after in-use granted) |

---

## 7. Build / Native Config

**Android:**
- Feather font: `android/app/build.gradle` includes `project.ext.vectoricons = { iconFontNames: ['Feather.ttf'] }` + `apply from: file("../../node_modules/react-native-vector-icons/fonts.gradle")`
- Firebase via `google-services.json` + `apply plugin: "com.google.gms.google-services"`
- Foreground service declared with `foregroundServiceType="health|location|connectedDevice"`

**iOS:** deferred — no physical iPhone for BLE testing. Info.plist + Podfile pre-configured.

**ESP32:** PlatformIO project. Upload via `pio run -d esp32 -t upload`.

---

## 8. Notable Behaviors & Gotchas

1. **Step count double-source guard** — `foregroundModuleActive` flag prevents both the service and JS foreground module from emitting simultaneously
2. **Session resume after app kill** — `sessionInProgress` + `sessionDuration` + native service state allow seamless resume
3. **Pet switch keeps `pairedDeviceId`** — physical BLE MAC unchanged if ESP32 is re-flashed
4. **Hunger persistence** — elapsed time saved every 5s during HUNGRY/STARVING; survives ESP32 reboot
5. **Route segment gaps** — pause creates new segment entry; renderer draws separate polylines (no straight-line cheating)
6. **GPS spike rejection** — both native (Kotlin) and JS sides filter >150m jumps
7. **Treat atomicity** — convert is local-immediate + fire-and-forget cloud merge. No server-side double-spend protection yet (cheating possible)
8. **Color broadcast** — `DeviceEventEmitter.emit('petColorChange', color)` updates HomeScreen, Tracker, Activities, Leaderboard simultaneously
9. **Hunger overlay** — animated amber → red tint over content; `pointerEvents: 'none'` so taps pass through
10. **Pet name locking** — `petNameChanged` flag set after first edit; name field disabled thereafter to prevent identity confusion
11. **`stepsConvertedToday` date guard** — uses local `YYYY-MM-DD`; traveling user crossing a date line may see odd reset

---

## 9. Current State (snapshot)

**Tabs:** home, tracker, activities, settings (Settings is now a real tab, not a modal)
**Goal:** user-settable; cleared on empty input
**Steps per treat:** 1000
**Default pet color:** `#EE5514` (orange)
**Bottom nav:** floating black rounded-rectangle pill with Feather icons
**No app header** (removed; settings moved into bottom nav)

---

## 10. Pending / Open

- Lifetime stats display (currently per-day/session only)
- Calorie tracking (needs user profile: weight/height/age)
- iOS build setup (~4 manual Xcode steps)
- JSON data export
- ESP32 STARVING state polish
- Share walk photo feature (camera + route overlay baked into photo)
- BLE disconnect recovery when phone BT off (ESP32 doesn't re-advertise)
- Server-side anti-cheat for leaderboard
- Firestore rules tightening (per-pet session read isolation)
- OTA firmware update mechanism

See [project_pending_features](.claude/memory/project_pending_features.md), [project_launch_checklist](.claude/memory/project_launch_checklist.md), and [project_share_photo_feature](.claude/memory/project_share_photo_feature.md) for details.

# softwear.pet — Technical Reference

Complete functional spec for the Walking Tracker app + pet firmware.

> **Maintenance:** keep this doc in sync after every functionality addition or change to either the app or the pet firmware. Cross-reference [project_launch_checklist](.claude/memory/project_launch_checklist.md) and [project_leaderboard_plan](.claude/memory/project_leaderboard_plan.md) when planning.

---

## 1. Overview

**softwear.pet** is a step-tracking app paired with a custom ESP32-based pet device. Each device has a unique Pet ID that *is* the user's account identity — no email or social login.

**Stack**
- **App:** React Native (Android first, iOS deferred)
- **Hardware:** Two firmware ports of the same pet — XIAO ESP32-C3 (original) and XIAO nRF52840 (current, better battery life). Both use identical BLE wire protocol, so the app is agnostic to which chip is inside.
- **Cloud:** Firebase Anonymous Auth + Firestore (Spark free tier today)

**Identity model:** pet-centric. ESP32 Pet ID = account. Pet device IS the password.

---

## 2. Pet Firmware

Two implementations exist. Both **preserve identical BLE UUIDs, command strings, and notify payloads** so the app doesn't care which one is inside.

| Firmware | File | Status | Notes |
|---|---|---|---|
| ESP32-C3 (original) | [esp32c3/src/main.cpp](esp32c3/src/main.cpp) | maintained | Two build envs (`dev` / `battery`) via `pio run -e <env>` |
| nRF52840 (current) | [nrf52840/src/main.cpp](nrf52840/src/main.cpp) | active port | Better BLE power efficiency (~3-6× longer battery life). Same two envs. Uses Bluefruit BLE + InternalFS/LittleFS + TinyUSB CDC |

The sections below describe the shared functional spec; where the implementation differs, both are noted.

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

### 2.6 Persistence

| Chip | Backend | Files/keys |
|---|---|---|
| ESP32-C3 | `Preferences` (NVS) | Namespace `pet`, keys `elapsed` + device name |
| nRF52840 | `InternalFS` (LittleFS) | Files `elapsed.bin` + `devname.txt` |

Same semantics on both: hunger elapsed time saved every 5s during HUNGRY/STARVING, custom device name saved on `NAME:*` command. Hunger state restores across power-off — device knows mood on boot.

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
2. **PermissionsOnboarding** — 3-screen carousel (BLE → Location → Activity). Each screen has an interactive trigger (slide-to-connect for BLE, trace-the-route for Location, tap-3-times for Activity) instead of a generic "Allow" button. After every trigger the app re-audits all three permissions; if any is still missing, it jumps back to the first missing screen and remounts the interactive widget so the user can retry. If a permission is permanently denied (`RESULTS.BLOCKED`), that screen swaps the interactive widget for a lock icon + "Open Settings" button (deep-linked via `openSettings()` from react-native-permissions). When the app returns to foreground (`AppState` change to `active`), the audit re-runs — if the user granted via Settings, the flow advances or completes automatically.
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
| Android 31+ | `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT`, then `ACCESS_FINE_LOCATION`, then `ACTIVITY_RECOGNITION` |
| Android < 31 | `ACCESS_FINE_LOCATION` (covers BLE too), then `ACTIVITY_RECOGNITION` |
| iOS | `BLUETOOTH`, `LOCATION_WHEN_IN_USE`, `MOTION` (location-always requested after in-use granted) |

### 6.4 POST_NOTIFICATIONS — pending implementation

`POST_NOTIFICATIONS` is declared in [AndroidManifest.xml:20](android/app/src/main/AndroidManifest.xml#L20) but **not requested at runtime anywhere** — not in PermissionsOnboarding, not in App.js, not in native code.

**Impact on Android 13+ (API 33+):** `POST_NOTIFICATIONS` is a dangerous permission requiring explicit runtime grant. Without it:

| Notification type | Shows without runtime grant? |
|---|---|
| Foreground-service notification ("softwear.pet is tracking…") | ✅ Yes — Android exempts foreground-service notifications when the service has a foreground type. Current service declares `health \| location \| connectedDevice`, so the tracking banner appears. |
| User-fired notifications (BLE disconnect alert, treats earned, pet is hungry, daily goal reached) | ❌ Silently dropped |
| FCM / push notifications (if added later) | ❌ Silently dropped |

**Plan when adding:**

Two implementation approaches:

- **Option A (least invasive):** add `POST_NOTIFICATIONS` to the existing `PERMS.ACTIVITY` group in [PermissionsOnboarding.js](src/PermissionsOnboarding.js) so it's requested alongside `ACTIVITY_RECOGNITION` during the "Count your steps" tap screen on Android 33+. One extra system dialog appears within the existing onboarding flow.
- **Option B (more polished):** add a 4th screen to the carousel with its own interactive metaphor (bell ringing, pet calling for attention). Feels more intentional but adds another step to onboarding.

**When to do this:** before launching any feature that actually sends notifications. The current code doesn't fire user-visible notifications, so deferring is safe for now. Required pre-launch.

**iOS equivalent:** request `PERMISSIONS.IOS.NOTIFICATIONS` from `react-native-permissions`, or use `@react-native-firebase/messaging` and call `requestPermission()`. Same deferral logic applies.

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
**Active firmware:** nRF52840 port complete and verified on hardware (BLE, FEED, notifications, persistence, Pet ID, USB CDC). ESP32-C3 firmware still maintained as reference/fallback. See §2 for both file paths.

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
- **Focus mode — trade steps for screen time** (see §12 for full spec)
- **Community Mode — pet-to-pet social via BLE** (see §13 for full spec)
- **POST_NOTIFICATIONS runtime request** (see §6.4) — declared in manifest but not requested in onboarding; needed for Android 13+ before any user-fired notifications will appear
- **Battery % on OLED + BLE characteristic** — requires 2× 1MΩ voltage divider on any ADC pin (see §14.6). No external components needed beyond the resistors. Applies to both ESP32-C3 and nRF52840 firmware.

See [project_pending_features](.claude/memory/project_pending_features.md), [project_launch_checklist](.claude/memory/project_launch_checklist.md), and [project_share_photo_feature](.claude/memory/project_share_photo_feature.md) for details.

---

## 11. Hardware Roadmap (planned)

The current dev unit ships with OLED + BLE + Pet ID only. Step counting today is done on the phone's sensors. The planned hardware adds on-device step counting + optional health sensors so the device works both **standalone** (pedometer + pet) and as a **companion** to the app (which adds GPS routes, history, leaderboard).

### 11.1 Front badge — primary device

Worn pinned to clothing or on a lanyard. Self-contained.

| Component | Part | Role |
|---|---|---|
| MCU | ESP32-C3 | BLE + firmware host (existing) |
| Display | SSD1306 128×64 OLED | Pet eyes + on-device readouts (existing) |
| Step counter | **Bosch BMA400** | On-chip step counting + activity recognition. I²C, ~14µA idle |
| Touch input | **TTP223 capacitive touch button** | Single tactile input — short / long press gestures |
| Battery | 3.7V LiPo, ~100–300 mAh | Sized for ~1 week battery life |
| Charging | TP4056 + USB-C | Standard hobby charging IC |
| Magnetic connector | 4-pin pogo (VCC / GND / SDA / SCL) | For optional back plate |

### 11.2 Back magnetic plate — optional health accessory

Sandwiches the t-shirt between itself and the front badge. Skin contact via magnetic coupling. **Passive — no battery, no MCU.** Powered + read by the front badge through the 4-pin pogo connector.

| Component | Part | Role |
|---|---|---|
| Pulse oximeter | **MAX30102** | Heart rate + SpO2 via PPG. Needs skin contact, which is why it lives here, not on the badge |

Sold as a separate SKU ("Pet + Health") or as an optional upgrade.

### 11.3 Touch gestures (TTP223)

| Gesture | Action |
|---|---|
| **Short tap** (< 400ms) | OLED shows today's step count for ~5 s |
| **Long press** (≥ 1s) | OLED triggers a 15 s HR + SpO2 reading and displays it (requires back plate attached) |

Single-vs-double-tap detection is avoided — adds latency to every tap. Short-press / long-press is unambiguous and zero-latency.

### 11.4 On-device step counting behavior

- BMA400 counts on-chip continuously (low power)
- ESP32 polls step register periodically + on touch
- Device tracks a **monotonically increasing cumulative count** — does not slice into days. The app does the day-slicing using its own timezone, so the device doesn't need to know what time it is
- Cumulative count persisted to ESP32 NVS every minute so it survives reboots
- New BLE characteristic exposes the live count to the app
- Sync: on phone connect, app pulls cumulative count + timestamp delta and merges into local activity buckets

### 11.5 HR / SpO2 behavior

- Only available when the back plate is detected (I²C probe at MAX30102's `0x57`)
- On-demand sampling only — long-press on the badge OR app `READ_HR` command → 15 s sample → result returned via BLE notify
- Continuous monitoring is a future enhancement (needs larger battery + aggressive duty cycling)
- Detached / reattached gracefully — front badge auto-detects via I²C presence

### 11.6 Power budget (estimated)

| Source | Draw |
|---|---|
| BMA400 idle | ~14 µA |
| TTP223 idle | ~3 µA |
| ESP32 deep sleep + BLE advertising every 1 s | ~50–200 µA avg |
| OLED on tap (~5 s × 5 mA) | ~7 µAh per look |
| HR sample (1–2 mA × 15 s) | ~30 µAh per reading |

Target ~1 week life on a 100 mAh LiPo with regular use.

### 11.7 New BLE characteristics required

To support the planned hardware, the BLE service will gain:

| UUID (TBD) | Property | Purpose | Payload |
|---|---|---|---|
| TBD | READ + NOTIFY | Cumulative step count + timestamp | `{count, ts}` |
| TBD | WRITE | Trigger HR/SpO2 sample | `READ_HR` |
| TBD | NOTIFY | HR/SpO2 result | `{bpm, spo2}` |
| TBD | READ | Back-plate attached status | `'attached'` \| `'detached'` |

These will be assigned alongside the existing service UUID `4fafc201-1fb5-459e-8fcc-c5c9c331914b`.

### 11.8 App-side changes when hardware ships

1. New BLE listener for device step count → merge with phone-side count (de-dupe by timestamp; prefer device when connected)
2. New HR card on HomeScreen — "Take a reading" button, gated on back-plate-attached state
3. Surface device-counted vs phone-counted step source in UI
4. Step-goal celebrations could fire from device directly when goal hit, even with no phone
5. Sync logic: on connect, pull cumulative count + slice into days using local timezone

### 11.9 Why this architecture

- **Standalone capability** — phone is optional, not mandatory. Differentiator vs apps-only competitors
- **Modular health** — HR needs skin contact, so it goes on the back plate. Splitting lets you ship the badge first, add health later
- **One battery** — back plate is passive. Cheaper, less complex, one charging port for the user
- **Fail-soft** — detach back plate (washing the shirt, sweaty workout) → pet personality + steps keep working, only HR goes dark
- **Identity model preserved** — front badge owns the Pet ID; back plate is just a sensor module

### 11.10 Ship order

1. **v1** — Front badge with BMA400 in-badge step counter + on-device OLED step readout via TTP223 short-press. Validate pet companion concept + step accuracy on chest position
2. **v2** — Magnetic back plate with MAX30102. Long-press triggers vitals reading. Sold as accessory or "Pet + Health" SKU
3. **v3** — Continuous HR (with bigger battery), additional sensors on back plate (skin temp, advanced SpO2), OTA firmware updates over BLE

### 11.11 Open risks

- Pogo pin contact reliability through fabric over time (sweat, lint, repeated reattach)
- Step accuracy on chest-pinned badge is ~90–95% (acceptable for casual fitness, not competitive)
- Manufacturing the 2-piece magnetic assembly adds ~6 months to ship if pursued at v1 launch
- Back plate hygiene / cleaning workflow needs design
- Bosch BMA400 / MAX30102 sensor library quality on ESP32-C3 needs verification

### 11.12 Hardware shopping list (for prototyping)

| Component | Part | ~Cost (India) | Source |
|---|---|---|---|
| MCU dev board | ESP32-C3 | already have | — |
| OLED | SSD1306 128×64 | already have | — |
| Accelerometer | SmartElex BMA400 breakout | ₹252 | Robocraze |
| Pulse oximeter | MAX30102 breakout | ₹500–700 | various |
| Touch button | TTP223 module | ₹50–100 | various |
| Magnetic pogo connector | 4-pin magnetic pogo | $2–5 | AliExpress (KCD / Yujian) |
| Battery | 3.7 V LiPo, 100–300 mAh | ₹200–400 | various |
| Charging IC | TP4056 module | ₹50–80 | various |

See [project_hardware_roadmap](.claude/memory/project_hardware_roadmap.md) for the full design rationale.

### 11.13 Bench-test findings (2026-06-15)

Standalone bench tests of both sensors paired to a XIAO ESP32-C3. Test sketches preserved under [hardware-tests/](hardware-tests/).

#### BMA400 — ✅ Validated

- **Step counter:** 32 steps detected over 30s of walking with breakout held in hand. Activity correctly reports `walking` / `still` / `running`.
- **Algorithm:** Bosch on-chip step detector via SparkFun BMA400 library. **Must explicitly call** `enableInterrupt(BMA400_STEP_COUNTER_INT_EN)` even when polling — otherwise count never increments.
- **Quirks:** ~5–7 step "lock-on" period at the start of each walking session — no count reported until the chip confirms the walking pattern, then incremental updates begin. Industry-standard behavior.
- **I²C clock:** 100 kHz works reliably even with marginal wiring. 400 kHz also fine when wires are solid.
- **Step count persistence:** survives soft-reset only if BMA400 keeps power. Cumulative count is in chip RAM, not NVS.

#### MAX30102 — Position-dependent

| Position | Result | Verdict |
|---|---|---|
| **Fingertip** | HR 100–107 BPM stable, SpO2 99.4% avg, 21/25 readings valid | ✅ Works perfectly |
| **Chest (bare skin, taped)** | **0/24 valid readings** in 60s. Correlation 0.0–0.86 (random). | ❌ Not usable |
| **Temple** | LEDs saturate at default brightness — reduce to `ledBrightness=20`. SpO2 99–100%, HR doubled (algorithm issue). | ⚠️ Algorithm tuning required |

**The chest-PPG result kills the planned magnetic back-plate-with-PPG architecture.** Chest skin is thicker, blood vessels are deeper, and breathing motion drowns the ~1 Hz heartbeat under a ~0.2 Hz envelope. The signal correlation oscillates randomly — algorithm correctly refuses to report a value.

This is a fundamental physics limitation, not a software bug. **No medical-grade chest HR product uses PPG** (Polar / Garmin / Wahoo all use ECG via electrodes). For a chest form factor, you'd need to swap MAX30102 for an ECG chip (AD8232 etc.).

#### HR algorithm comparison at fingertip

Three algorithms tested with identical input data:

| Algorithm | HR | SpO2 | Notes |
|---|---|---|---|
| SparkFun PBA (`max30102/`) | ~80 BPM accurate, noisy | ❌ none | Simple peak detector |
| Maxim RD117 (`max30102-maxim/`) | **160 BPM (DOUBLED, wrong)** | ✅ 99% | Picks up dicrotic notch as a separate beat — confidently lies (`valid=1` for wrong numbers) |
| **aromring RF (`max30102-aromring/`)** | **101 BPM correct + stable** | ✅ 99.4% | Linear regression + autocorrelation. Conservative validity flag — admits when signal is bad |

**Production choice: aromring RF.** When `valid=1`, the reading can be trusted. When invalid, the app suppresses display rather than showing garbage.

Source: vendored from [aromring/MAX30102_by_RF](https://github.com/aromring/MAX30102_by_RF) under MIT-style license. Files live in [hardware-tests/max30102-aromring/src/algorithm_by_RF.{h,cpp}](hardware-tests/max30102-aromring/src/).

#### Wiring lessons learned

- Loose dupont jumper wires on through-hole pads cause **address-ACK-only with register-read failure** (`Error 263` from ESP32 I²C driver). Symptoms: I²C scanner sees the device, library `begin()` fails.
- Fix: solder pin headers; never rely on friction fit.
- 100 kHz I²C is more tolerant of marginal wiring than 400 kHz. Drop the clock when debugging.
- ESP32-C3 SDA = D4 (GPIO 6), SCL = D5 (GPIO 7). Easy to swap by accident.

#### Implications for §11 ship order

The ship order above (v1 badge → v2 magnetic HR back plate → v3 continuous HR) **needs revision**. v2 with PPG-on-chest does not work. Realistic v2 options:

1. **Fingertip accessory** — a small ring or clip that the user touches against finger for spot HR/SpO2 readings, pairs with badge via BLE
2. **Wristband variant** — different form factor, PPG against inside-of-wrist (Apple Watch zone) — likely works but untested here
3. **Drop HR ambitions** — keep the badge as a step counter + pet companion. Lean into that brand
4. **ECG back plate** — swap MAX30102 for AD8232. Different sensor entirely, gives HR (not SpO2), works on chest

Recommendation pending product direction decision.

### 11.14 Wristband variant (alternative v2 form factor)

If the product pivots to a wristband (or wristband-companion) instead of badge-only, the architecture changes substantially. This section captures the design.

#### Why wristband works where chest didn't

The MAX30102 PPG sensor was designed for **fingertip / wrist** contact — same body location class as Apple Watch and Fitbit. Inside-of-wrist (radial artery zone) has:
- Thin skin over superficial arteries → strong PPG signal
- Less breathing-motion interference than chest
- Standardised mechanical contact via strap tension

Bench-test data for fingertip (proxy for inside-of-wrist) showed: 21/25 valid readings, HR stable 100-107 BPM, SpO2 99.4% (with the aromring algorithm). Production-grade results.

#### Recommended MCU: nRF52840 (NOT ESP32-C3)

The ESP32-C3 is great for prototyping but power-hungry for wearables. Industry standard for fitness bands is **Nordic nRF52840** (used by Fitbit, Garmin, Whoop, Oura, Apple AirTag).

| | ESP32-C3 | nRF52840 |
|---|---|---|
| BLE radio peak | ~80 mA | ~5 mA |
| Deep sleep | ~5 µA | ~1.5 µA |
| Battery life on 500 mAh (typical wearable load) | ~7-14 days | **3-6 weeks** |
| Arduino + PlatformIO support | ✅ | ✅ |
| Cost (chip) | ~$2-3 | ~$2-5 |

**Drop-in dev board: Seeed Studio XIAO BLE nRF52840** — same 21×17.5 mm form factor as the XIAO ESP32-C3, same Arduino-friendly toolchain.

| Board | Price | Onboard sensors |
|---|---|---|
| XIAO BLE (nRF52840) | ~₹800-1200 | None |
| **XIAO BLE Sense (nRF52840 Sense)** | **~₹1500-2000** | **LSM6DS3TR-C** 6-axis IMU + microphone |

The Sense variant **eliminates the separate BMA400 breakout** — LSM6DS3TR-C has its own onboard step counter. Saves PCB space, fewer parts, simpler manufacturing. Different library (`Seeed_Arduino_LSM6DS3`), step-counting code is a ~half-day rewrite.

#### Code portability from existing ESP32-C3 prototype

Most code carries over with minimal changes:

```cpp
// XIAO ESP32-C3:  Wire.begin(6, 7);
// XIAO BLE:       Wire.begin();              // Default pins are correct

// platformio.ini change:
[env:xiao_ble_sense]
platform = nordicnrf52
board    = seeed_xiao_ble_sense
framework = arduino
```

Same MAX30102 library, same aromring algorithm (pure C++ math), same I²C bus model. BMA400 → LSM6DS3 swap requires library change.

#### Battery life expectations (XIAO BLE Sense + 500 mAh)

| Use case | Expected life |
|---|---|
| Step counting + BLE advertising | **3-4 weeks** |
| + Spot HR readings (long-press triggered) | **2-3 weeks** |
| + Always-connected BLE to phone | **1-2 weeks** |
| + Continuous HR monitoring (24/7) | **3-5 days** |

#### Wristband form factor implications

- **Strap mechanism:** standard 18-22mm watch strap pins. Off-the-shelf bands fit
- **OLED placement:** small (~0.96") display on top, like Fitbit Inspire or Mi Band
- **TTP223 touch:** still works on a wristband — gestures (short = steps, long = HR)
- **MAX30102 placement:** sensor window faces down toward inside of wrist, presses against skin via strap tension
- **Pet personality:** the OLED eyes still work — just on the wrist instead of a badge on the chest
- **Pet ID identity:** unchanged — wristband ESP32/nRF still owns the `KOS` Pet ID. Account model survives.

#### Components shopping list for wristband prototype

| Component | Part | ~Cost (India) | Source |
|---|---|---|---|
| MCU board | **XIAO BLE Sense (nRF52840)** | ₹1500-2000 | Robu / Robocraze / Seeed |
| Pulse oximeter | MAX30102 (already have) | ₹124 | Robocraze |
| Step counter | LSM6DS3TR-C (onboard XIAO BLE Sense — no separate breakout) | included | — |
| Touch button | TTP223 module | ₹50-100 | various |
| OLED | SSD1306 0.96" 128×64 (already have) | included | — |
| Battery | LiPo 500 mAh | ₹300-500 | various |
| Charging IC | TP4056 module | ₹50-80 | various |
| Strap | 18-22mm silicone watch strap | ₹100-300 | Amazon / sports shop |

#### Decision drivers for badge vs wristband

| | Badge | Wristband |
|---|---|---|
| HR/SpO2 viable | ❌ chest PPG doesn't work | ✅ wrist PPG works |
| Step accuracy | ~90-95% (chest position) | ~95-98% (wrist — industry standard) |
| Visibility for OLED eyes (the "pet") | ✅ visible to others | ⚠️ hidden under sleeve usually |
| Fashion accessory feel | ✅ unique | ⚠️ competes with smartwatches |
| Battery life | Smaller battery, longer life | 500 mAh, 1-3 weeks |
| BOM cost | Lower (no strap, no waterproofing) | Higher (~₹500 more for strap + sealing) |
| Market positioning | "Pet companion" — novel | "Fitness band with personality" — crowded market |

Both are viable products with different identities. The wristband path delivers the full feature set (steps + HR + SpO2) but at the cost of becoming "a fitness band with a pet on it" rather than "a pet you wear."

---

## 12. Focus Mode — Trade Steps for Screen Time (planned feature)

A signature engagement feature that turns the pet into a gatekeeper of phone screen time. The user "buys" screen time by walking — the pet enforces healthy digital habits.

### 12.1 Concept

- **Earn rate** (tunable): e.g. **100 steps → 5 minutes of screen time**
- Steps are converted into "screen-time credits" stored on the pet device
- When the user opens the app (or specific apps), screen-time credits start counting down
- When credits hit zero, phone goes into focus mode (specific apps locked, or full-screen "go for a walk" overlay)
- User walks more → earns more credits → unlocks more screen time
- Pet's mood mirrors the user's balance — happy when balance is healthy, sad when locked out

### 12.2 Pet personality integration

This feature deepens the pet-as-companion identity. The pet isn't just a step counter — it's a friend that *cares* about your health. When you've used up your credits, the pet's OLED eyes go sad. When you've banked plenty of steps, the eyes are happy. Reinforces the emotional bond that justifies wearing a physical device.

### 12.3 Conversion model

Initial values to tune in beta:

| Steps banked | Screen-time earned |
|---|---|
| 100 | 5 min |
| 500 | 25 min |
| 1,000 | 50 min |
| 5,000 | 4 h 10 min |
| 10,000 (daily target) | 8 h 20 min |

Notes:
- Daily reset OR rolling 24h window — TBD via user testing
- Bonus modes: 2× rate during morning walks (positive habit reinforcement), or `treats` (existing feature) can also be spent for screen time
- "Emergency override" — let user borrow X minutes without walking, but pet gets sad → guilt mechanic without total lockout

### 12.4 Technical architecture

**Pet device (firmware):**
- NVS field: `step_bank` (uint32, cumulative unspent steps)
- NVS field: `screen_time_remaining_sec` (uint32, credits not yet redeemed)
- New BLE characteristic: read `step_bank` + `screen_time_remaining_sec`, write `redeem` command (converts bank → time)

**App (React Native):**
- New screen `src/FocusScreen.js` with "Earn / Spend / Status" UI
- Listens to BLE characteristic updates, displays balance
- Triggers OS-level screen-time enforcement when credits run out

**OS-level enforcement options:**

| Platform | API | Capability |
|---|---|---|
| **Android** | Digital Wellbeing / Accessibility Service | Can block specific apps when locked. Requires "Usage Access" permission |
| **iOS** | Family Controls + Screen Time API | More restrictive — works best in parental control / Focus mode contexts. Requires special entitlement from Apple |
| **In-app only (simplest)** | Just gate the softwear.pet app's own features behind credits | No OS integration needed. Limited impact — user can still use other apps freely |

### 12.5 UX considerations

**This is a high-friction feature.** Locking phone usage without consent is a one-star-review feature. Mitigations:

- **Opt-in only.** Toggle in Settings → Focus Mode. Off by default.
- **Per-app whitelisting.** Phone, messages, maps always accessible. Only entertainment / social / games gated.
- **Emergency override.** "Force unlock for 15 min" button — usable, but pet shows disappointment. Allows escape valve without breaking immersion.
- **Daily ceiling.** Don't lock the phone for more than 8 hours/day even if user has zero credits. Hard backstop.
- **Parental-control framing.** Position as "for kids who want screen-time discipline" rather than "for adults trying to break phone addiction" — lowers expectation friction.

### 12.6 Comparable products + differentiation

| Product | Mechanism | Our edge |
|---|---|---|
| **Forest** | Pomodoro trees that "die" if you switch apps | Software-only; no physical reward |
| **One Sec** | Mindful breathing before opening flagged apps | Friction, not earning |
| **Brick** (physical NFC lock) | Tap NFC tag to unlock apps for a session | Static reward, no exercise tie-in |
| **Apple Screen Time / Digital Wellbeing** | OS-native limits | Punitive, no positive reinforcement |
| **softwear.pet (us)** | **Walk to earn → pet personality + physical wearable** | **Unique pairing of fitness + focus** |

### 12.7 Implementation order

1. **Phase 1 — in-app only (no OS hooks):** Focus screen gates softwear.pet's own features behind step credits. Validates the loop without platform friction.
2. **Phase 2 — Android Digital Wellbeing integration:** Lock 3rd-party apps when credits run out. Android first because the API is more permissive.
3. **Phase 3 — iOS Screen Time integration:** Apply for Apple's Family Controls entitlement (notoriously hard for non-parental-control apps). Or pivot to "kids/family" SKU on iOS.
4. **Phase 4 — pet OLED reactions:** Pet eye states reflect balance (happy when ≥30 min credits, neutral 5–30 min, sad < 5 min, sleeping if locked).

### 12.8 Risks

- **App Store rejection** if framed wrong — Apple is strict about apps that "limit other apps." Position carefully (parental control, voluntary focus).
- **User backlash** if defaults are aggressive. Default to off.
- **Cheating** — user takes phone off body to game the system. Mitigate by requiring the pet to be BLE-connected to earn credits.
- **iOS implementation complexity** — Family Controls entitlement is hard to obtain. Plan around Android-first launch for this feature.

### 12.9 Why this fits softwear.pet uniquely

Every other "screen time limit" app feels punitive. With the pet:
- It's not "the app stopping me," it's "my pet asking me to take a walk"
- The pet visibly suffers when I'm doom-scrolling → emotional buy-in
- Walking has a clear in-world reward (the pet is happy + I get screen time)
- Physical wearable enforces "is the user actually walking" — prevents step-spoofing better than a software-only solution

This is the kind of feature that gets users to talk about the product. **Strong differentiator candidate for v2 marketing.**

---

## 13. Community Mode — Pet-to-Pet Social (planned feature)

When two pet devices are in the same physical vicinity (~10 m BLE range), they can detect each other and trigger a real-world "meeting" between the two users' pets. Optionally, the pets briefly connect and play synchronized animations to mark the moment.

This is **a feature no other wearable does** — Apple Watch, Fitbit, Whoop, Garmin all ignore each other. Pet-to-pet detection turns the device into a social object mediated by being physically near another user.

### 13.1 Core concept

User toggles **Community Mode** on in the app:

- Pet starts **broadcasting** its Pet ID (or a rotating ephemeral ID) over BLE advertising
- Pet also **scans** for other pets nearby
- When two pets detect each other → encounter event logged
- Encounters sync to phone → Firestore → both users see "your pet met X" in their app
- Optional: pets briefly connect and play synchronized happy-eye animation in real-time

### 13.2 Privacy-first defaults

- **Default: OFF.** Pet does not broadcast or scan unless user explicitly toggles on
- Stays off in private contexts (work, doctor visits, etc.) — user controls
- **Rotating ephemeral IDs** to prevent BLE-scanner tracking by strangers (like Apple AirTags' MAC randomization). Cloud resolves ephemeral → real Pet ID
- First-meeting consent: optionally prompt "approve unknown pet as friend?" before linking encounter

### 13.3 Dual-role BLE — phone + pets simultaneously

Both ESP32-C3 and nRF52840 support **dual-role BLE** — a single chip can be peripheral + central simultaneously. The phone connection is unaffected by community-mode scanning.

| Chip | Concurrent BLE connections |
|---|---|
| ESP32-C3 | up to 9 |
| nRF52840 | up to 20 |

Pet maintains its phone-side connection (peripheral role) while concurrently scanning for and optionally briefly connecting to other pets (central / observer role). The two roles do not conflict.

### 13.4 Two architectures

#### Architecture A — Scan-only (Phase 1)

The simpler, more reliable model.

```
Pet A advertises Pet ID "KOS000001"
Pet B advertises Pet ID "KOS000042"
Both pets scan in 5-sec bursts every 60 sec

Pet A sees "KOS000042" in its scan results, RSSI ≈ -65 dBm (~5m)
→ Logs encounter: { otherPetId: "KOS000042", timestamp: now, rssi: -65 }

Pet B sees "KOS000001" the same way → logs symmetric encounter

On next phone sync:
→ Encounter pushed to Firestore as pets/{petId}/encounters/{encounterId}
→ App shows both users: "Your pet met X today"
```

No direct connection between pets. Just passive detection.

#### Architecture B — Brief direct connection (Phase 2)

The "magical moment" upgrade.

```
Pet A detects Pet B in range AND RSSI strong enough (>-70 dBm)
→ Pet A initiates BLE connection to Pet B
→ They exchange a small data packet (pet name, mood, "hello")
→ Both pet OLEDs simultaneously display excited eye animation
→ Disconnect after ~5 seconds
→ Encounter logged with extra data (other pet's name, mood, etc.)
```

Visible, instant, emotional. Worth the extra complexity for v2.

### 13.5 Battery impact

| State | Avg current added | Battery hit |
|---|---|---|
| Community Mode OFF (default) | 0 | 0% |
| Community Mode ON, burst-scan 5s/60s | +3 mA (ESP32-C3) / +0.5 mA (nRF52840) | ~30% / ~10% |

Realistic 500 mAh battery life with Community Mode ON all day:
- ESP32-C3: ~5-10 days
- **nRF52840: ~2.5-5 weeks** ← much smoother for this feature

### 13.6 Firmware design

**Advertising packet:**
```cpp
BLEAdvertisementData adv;
adv.setName(MY_PET_ID);  // e.g. "KOS000001" — or rotating ephemeral ID
adv.setManufacturerData(...);  // optional extras: mood, treat count
pAdvertising->setAdvertisementData(adv);
pAdvertising->start();  // only when community mode is ON
```

**Burst scanner (FreeRTOS task on ESP32):**
```cpp
xTaskCreate([](void*) {
  while (1) {
    if (communityModeEnabled) {
      BLEScan* scan = BLEDevice::getScan();
      scan->setActiveScan(true);
      scan->start(5, [](BLEScanResults results) {
        for (int i = 0; i < results.getCount(); i++) {
          BLEAdvertisedDevice d = results.getDevice(i);
          String name = d.getName().c_str();
          if (name.startsWith("KOS") && name != MY_PET_ID) {
            logEncounter(name, d.getRSSI());
          }
        }
      }, false);
    }
    vTaskDelay(pdMS_TO_TICKS(60000));  // wait 60 sec
  }
}, "petScan", 4096, NULL, 1, NULL);
```

**On-device encounter buffer:**
- Ring buffer in RAM (last ~20 encounters)
- Persist to NVS every minute
- Flush to phone on next BLE sync, clear buffer

### 13.7 App + Firestore schema

**New BLE characteristics:**
- READ `community_mode_enabled` (boolean)
- WRITE `set_community_mode` (boolean) — phone tells device to turn on/off
- READ `encounters` (JSON array of recent encounters) — phone reads to sync to Firestore

**Firestore additions:**
```
pets/{petId}/encounters/{encounterId}
  ├─ otherPetId         "KOS000042"
  ├─ timestamp          serverTimestamp
  ├─ duration_sec       ~30 (estimated from how long in range)
  ├─ rssi_avg           -65 dBm — rough distance estimate
  └─ location           { lat, lng } (if phone was connected at the time)
```

**App UI additions:**
- New "Community" tab or section in Settings
- Toggle: "Community Mode" with explanation copy
- New "Friends" screen — list of pets met
- Per-pet detail: name, owner, last seen, encounter count
- Optional: encounter map showing where you've met other pets

### 13.8 Built-on-encounter features

Once the encounter primitive exists, layer:

| Feature | Mechanic |
|---|---|
| **Friends list** | Pets met multiple times → become friends |
| **Visit bonus** | Each new encounter awards both pets +5 treats |
| **Encounter map** | Map view of where you've met other pets |
| **Friendship streaks** | Met yesterday + today + tomorrow = streak rewards |
| **Group walk** | Pets that walk together (continuously in range while both tracking) earn shared steps |
| **Pet trades** | Optional in-app: send treats to a pet you've met |
| **Real-world meetups** | App suggests: "There's a softwear.pet user at this café — go say hi" (with mutual opt-in) |

### 13.9 UX considerations

- **OLED indicator** when scanning is active — small radar icon in the corner. Pet eyes do subtle "looking around" animation
- **First encounter prompt** — when pet meets a stranger's pet, ask "approve as friend?" before storing identifying data
- **Visit cooldown** — same pet within 1 hour doesn't generate duplicate encounters (avoid spam)
- **RSSI threshold** — only count encounter if pets were within ~5m (RSSI > -70 dBm), filters out cafe / gym noise
- **Min encounter duration** — both pets must see each other for 30+ sec before logging. Filters fleeting passes

### 13.10 Implementation order

1. **Phase 1 (post-launch v1):** Detect-only, scan-only, encounter logging. Validate the social mechanic resonates with users.
2. **Phase 2 (v1.5):** Add the "magical moment" — pets briefly connect, exchange greeting, sync OLED animations.
3. **Phase 3 (v2):** Build out social graph features — friends list, encounter map, group walks, visit bonuses.
4. **Phase 4 (v2.5):** Cloud-mediated features — pet-to-pet treat sending, encounter location memory, friendship streaks.

### 13.11 Risks

- **Privacy controversy** — broadcasting a unique device ID can be tracked. Use ephemeral rotating IDs (re-derive every N hours, cloud-resolves) like AirTags. Document clearly in privacy policy.
- **Battery surprise** — clearly communicate the ~30% battery cost in the app toggle UI.
- **False positives in dense areas** — RSSI threshold + minimum duration filtering required.
- **Trolling** — strangers' pets meet too often becomes spam. Visit cooldown + first-meeting consent mitigates.

### 13.12 Why this fits softwear.pet uniquely

Every other wearable measures **the wearer in isolation**. With Community Mode, your pet becomes **a social object**:
- Brings physical-world serendipity back into a digital product
- Reinforces the "your pet is a real character" identity
- Pets feel alive when they react to other pets in real time
- Mirrors how pets actually behave in real life (sniff each other, get excited at meetings)

Pairs naturally with [§12 Focus Mode](#12-focus-mode--trade-steps-for-screen-time-planned-feature): both features encourage the user to **be present in the physical world** rather than glued to their phone.

**Best ROI on the nRF52840 chip** (Phase 1+ all become much more practical with its sub-mA scanning current).

---

## 14. Hardware Wiring Reference

Complete pin-by-pin wiring for the prototype hardware. All components share a **single I²C bus** on the XIAO ESP32-C3 (SDA = D4 / GPIO 6, SCL = D5 / GPIO 7), so adding sensors doesn't add new wiring paths beyond power and ground.

### 14.1 Base wiring — XIAO ESP32-C3 + TP4056 charging + LiPo + OLED

The minimum wearable stack: MCU, battery, charging management, display. 8 wires total.

#### Power flow

```
USB-C charger ──► TP4056 (charge management) ──► LiPo battery
                       │
                       ├──► XIAO VUSB (3.5-4.2V from battery or ~5V from USB)
                       │
                       └──► XIAO GND
                              │
                              └──► onboard LDO regulates to 3.3V
                                     │
                                     └──► OLED VCC + sensor VIN
```

#### Connection 1 — TP4056 ↔ LiPo battery (2 wires)

| TP4056 pad | LiPo wire | Notes |
|---|---|---|
| **B+** | Red (+ positive) | Solder or JST connector |
| **B-** | Black (− negative) | ⚠️ Reversing destroys battery + module |

#### Connection 2 — TP4056 ↔ XIAO (2 wires)

| TP4056 pad | XIAO pin | Function |
|---|---|---|
| **OUT+** | **VUSB** (bottom-right corner, opposite end from USB-C) | 3.5-4.2V from battery |
| **OUT-** | **GND** | Ground |

#### Connection 3 — XIAO ↔ OLED (4 wires)

| XIAO pin | OLED pin | Function |
|---|---|---|
| **3V3** | **VCC** | ⚠️ NOT 5V — OLED is 3.3V only |
| **GND** | **GND** | Ground |
| **D4** (GPIO 6) | **SDA** | I²C data (shared bus) |
| **D5** (GPIO 7) | **SCL** | I²C clock (shared bus) |

#### Connection 4 — USB-C charger ↔ TP4056

Plug USB-C cable into the TP4056's USB-C port (not the XIAO's). The TP4056 routes power through its protection circuit.

#### XIAO ESP32-C3 pinout reference

Hold the XIAO with USB-C at the top:

```
        ┌── USB-C ──┐
   D0 ─┤            ├─ D10 / MOSI
   D1 ─┤            ├─ D9  / MISO
   D2 ─┤            ├─ D8  / SCK
   D3 ─┤            ├─ D7  / RX
  D4* ─┤            ├─ 3V3   ← OLED VCC, sensor VIN
  D5* ─┤            ├─ GND   ← common ground
   D6 ─┤            ├─ VUSB  ← TP4056 OUT+
        └───────────┘
                                    * D4 = SDA (GPIO 6)
                                    * D5 = SCL (GPIO 7)
```

#### Assembly order + sanity checks

1. Solder battery wires to TP4056 (B+ = red, B- = black)
2. **Multimeter check:** TP4056 OUT+ to OUT- should read LiPo voltage (3.7-4.2V). If 0V or negative → polarity wrong
3. Solder TP4056 OUT+ → XIAO VUSB, OUT- → XIAO GND
4. Solder OLED: VCC → XIAO 3V3, GND → GND, SDA → D4, SCL → D5
5. Power on: XIAO boots, OLED shows pet eyes
6. Plug USB-C into TP4056 — red LED lights = charging; goes off/green = full

#### Common mistakes

| Mistake | Result |
|---|---|
| OLED VCC to XIAO VUSB (5V) instead of 3V3 | OLED damaged (max input 3.3V) |
| TP4056 OUT+ to XIAO 3V3 instead of VUSB | Undervoltage; XIAO doesn't work |
| LiPo polarity reversed on TP4056 | Battery + TP4056 destroyed |
| SDA / SCL swapped on OLED | I²C scanner finds nothing; OLED blank |
| No common ground between TP4056 and XIAO | XIAO doesn't power on |

---

### 14.2 Adding the BMA400 accelerometer

The BMA400 provides on-device step counting + activity recognition (walking/still/running). Shares the I²C bus with the OLED — same SDA + SCL lines, different I²C address (`0x14` vs OLED's `0x3C`).

**Extra wires needed:** 4 wires for power + I²C, plus 1 for CS (must be tied HIGH to force I²C mode). Optional: 1-2 wires for interrupt pins if you want event-driven reads.

#### BMA400 ↔ XIAO wiring

| BMA400 pad | XIAO pin | Function |
|---|---|---|
| **3V3** | **3V3** | 3.3V power (shared with OLED) |
| **GND** | **GND** | Ground (shared with OLED) |
| **SDA/PICO** | **D4** (GPIO 6) | I²C data — same wire as OLED SDA |
| **SCL/SCK** | **D5** (GPIO 7) | I²C clock — same wire as OLED SCL |
| **CS** | **3V3** | ⚠️ Must be HIGH to force I²C mode (breakout may auto-tie if using Qwiic JST) |
| **ADR/POCI** | **GND** (or floating) | Sets I²C address to `0x14`; tie to 3V3 for `0x15` |
| INT1, INT2 | (any GPIO, optional) | Interrupt output for "step detected" events — poll-based works without this |

**Shorter alternative** using Qwiic JST: plug a Qwiic-to-jumper cable into the BMA400 breakout, connect the 4 wires (red 3V3, black GND, blue SDA, yellow SCL) to the XIAO. CS and ADR are auto-configured internally.

#### I²C bus after BMA400 is added

Running the I²C scanner should now find:
```
0x14 <- BMA400
0x3C <- OLED
```

No address conflicts — both devices coexist on the same 2 wires.

#### CS pad — critical detail

If you're using the through-hole pads (not JST), the CS pin **must** be tied to 3.3V. Otherwise the BMA400 boots in SPI mode and won't respond to I²C. Simplest: solder a small wire bridge from BMA400's CS pad to its own 3V3 pad — no separate wire to XIAO needed.

#### Firmware requirement

The BMA400's step counter must be **explicitly enabled** even for polling — this is a Bosch quirk. Without this call the step count stays at 0 forever:

```cpp
bma400_step_int_conf config = { .int_chan = BMA400_UNMAP_INT_PIN };
accel.setStepCounterInterrupt(&config);
accel.enableInterrupt(BMA400_STEP_COUNTER_INT_EN, true);
```

See [hardware-tests/bma400/src/main.cpp](hardware-tests/bma400/src/main.cpp) for the full example.

---

### 14.3 Adding the MAX30102 HR / SpO2 sensor

Provides heart rate + blood oxygen saturation via optical PPG. Requires **direct skin contact** at fingertip (best), wrist inside (good), or temple (works with LED tuning). **Chest position does not work** — see §11.13 for the bench-test evidence.

Shares the I²C bus with the OLED + BMA400 — same SDA + SCL lines, different address (`0x57`).

**Extra wires needed:** 4 wires. INT / IRD / RD pins are typically left unconnected for basic HR + SpO2.

#### MAX30102 ↔ XIAO wiring

| MAX30102 pad | XIAO pin | Function |
|---|---|---|
| **VIN** | **3V3** | 3.3V power (shared with OLED, BMA400) |
| **GND** | **GND** | Ground (shared) |
| **SCL** | **D5** (GPIO 7) | I²C clock — same wire as OLED SCL, BMA400 SCL |
| **SDA** | **D4** (GPIO 6) | I²C data — same wire as OLED SDA, BMA400 SDA |
| INT | (any GPIO, optional) | Interrupt on sample ready — polling works without |
| IRD | leave unconnected | LED current control (internal to chip in default config) |
| RD | leave unconnected | LED current control (internal to chip in default config) |

#### Voltage-level detail

The MAX30102 chip is nominally 1.8V logic internally, but the SDA/SCL/INT pins tolerate **up to 3.6V** per the datasheet. ESP32-C3 outputs 3.3V → within spec, **no level shifter needed**.

If the module's silkscreen says "requires 1.8V logic" — that's a conservative note for 5V Arduino users. For 3.3V ESP32 hardware, direct connection works.

Most GY-MAX30102 breakouts (green PCB with gold pads) also include an onboard 1.8V regulator + I²C pull-ups, so the chip's internal domain is fed cleanly regardless of your input.

#### I²C bus with all three sensors

Running the I²C scanner with everything wired should find:

```
0x14 <- BMA400
0x3C <- OLED
0x57 <- MAX30102
```

Three devices sharing 2 wires. This is why I²C is used everywhere in wearables — massive wiring simplicity.

#### Recommended algorithm

The SparkFun MAX3010x library ships two peak-detection algorithms:
- **PBA (`heartRate.h`)** — simple, gives HR only, noisy but accurate value
- **Maxim RD117 (`spo2_algorithm.h`)** — has a known bug: HR reported at **2× true value** due to dicrotic notch double-counting

Recommended: use **aromring's RF algorithm** ([hardware-tests/max30102-aromring/](hardware-tests/max30102-aromring/)). Autocorrelation-based, gives correct HR + SpO2 with proper validity flags. Vendored in this repo.

#### Power consumption

MAX30102 is not a "leave on 24/7" chip — LEDs draw ~600 µA to 2 mA continuously. For battery-powered wearables:

- **On-demand mode (recommended):** wake chip → sample 15 sec → shutdown. Total energy per reading: ~30 µAh.
- **Continuous monitoring:** always on. ~1-2 mA average. Cuts wearable battery life by ~50%.

For the badge concept, on-demand is triggered by long-press on the TTP223 touch sensor.

---

### 14.4 Full wiring diagram — all three sensors + OLED

Once everything is stacked on the shared I²C bus, wiring is:

```
                                ┌─────────────────┐
   USB-C ─────────────────────► │  TP4056 module  │
                                │                 │
                            ┌───┤  B+ ─── LiPo +  │
                            │   │  B- ─── LiPo −  │
                            │   │                 │
                            │   │  OUT+ ──┐       │
                            │   │  OUT- ──┼┐      │
                            │   └─────────│┼──────┘
                            │             ││
                            │             ▼▼
                            │        ┌──────────────────────┐
                            │        │  XIAO ESP32-C3       │
                            │        │                      │
                            │        │  VUSB ← OUT+         │
                            │        │  GND  ← OUT-         │
                            │        │                      │
                            │        │  3V3  ──┐            │
                            │        │  GND  ──┼─┐          │
                            │        │  D4   ──┼─┼─┐        │
                            │        │  D5   ──┼─┼─┼─┐      │
                            │        └─────────┼─┼─┼─┼──────┘
                            │                  │ │ │ │
                    ┌───────┼──────────────────┴─┴─┴─┴──┐  (shared 4-wire bus)
                    │       │                            │
              ┌─────▼───┐   │   ┌────────┐    ┌───────────▼──┐
              │  OLED    │   │   │ BMA400 │    │ MAX30102     │
              │ (0x3C)   │   │   │ (0x14) │    │ (0x57)       │
              │          │   │   │        │    │              │
              │ VCC ← 3V3│   │   │3V3←3V3 │    │ VIN ← 3V3    │
              │ GND ← GND│   │   │GND←GND │    │ GND ← GND    │
              │ SDA ← D4 │   │   │SDA← D4 │    │ SDA ← D4     │
              │ SCL ← D5 │   │   │SCL← D5 │    │ SCL ← D5     │
              └──────────┘   │   │ CS ← 3V3│   └──────────────┘
                             │   │(force  │
                             │   │  I²C)  │
                             │   └────────┘
                             │
                             (all share the same 4 wires)
```

Total wire count:
- Battery → TP4056: 2
- TP4056 → XIAO: 2
- XIAO → 3 sensors + OLED (parallel taps of same 4 lines): effectively 4 wires shared
- **~12 wires** for a fully-featured badge, all through the same 4-wire I²C bus + 2 power wires.

That's the power of I²C — you can keep adding sensors (temperature, magnetometer, ambient light, EEPROM) without adding wire count.

---

### 14.5 Common assembly workflow

For the perfboard or PCB prototype:

1. **Solder pin headers or JST connectors** to every module (XIAO, TP4056, OLED, BMA400, MAX30102). Never rely on friction-fit dupont wires — they cause the `Error 263` I²C failures we hit during bench testing.
2. **Route power first** — battery to TP4056 to XIAO. Verify with multimeter.
3. **Add I²C rails** — 4 wires (3V3, GND, SDA, SCL) that fan out to each device. Physically bridge them at a single row/column on the perfboard.
4. **Add each I²C device one at a time**, running the I²C scanner after each addition. Confirm the new address appears before moving on.
5. **Test firmware end-to-end** — OLED animates, BMA400 counts steps, MAX30102 reports HR when finger applied.

---

### 14.6 Battery % monitoring — voltage divider

Applies to **both** ESP32-C3 and nRF52840. Neither chip can measure battery voltage directly (the onboard LDO regulates VDD to 3.3V regardless of battery state), so a simple resistor divider is required.

**Parts**
- 2× 1 MΩ resistors (through-hole 1/8W or SMD 0603 — value matters more than package)

**Wiring**
```
Battery (+) ──► R1 (1 MΩ) ──┬──► ADC pin (e.g. XIAO A0)
                             │
                             R2 (1 MΩ)
                             │
                            GND
```

Tap the divider **after the slide switch**, on the VUSB rail — that way the divider draws no current when the pet is off.

**Why 1 MΩ specifically:** the divider draws only ~2 µA continuously, negligible battery drain. Anything smaller (e.g. 10 kΩ) would draw ~200 µA constantly and shorten runtime.

**Firmware (both chips, minor pin differences)**
```cpp
float readBatteryVoltage() {
  int raw = analogRead(A0);
  float pinVolts = raw * (3.3f / 1023.0f);
  return pinVolts * 2.0f;              // undo the /2 divider
}

int batteryPercent() {
  float v = readBatteryVoltage();
  if (v >= 4.15f) return 100;
  if (v <= 3.30f) return 0;
  return (int)((v - 3.30f) / (4.15f - 3.30f) * 100.0f);
}
```

**Display** — render on OLED as `85%` or a small battery-icon glyph. Read every ~5s, redraw only on change to avoid flicker. Also expose via a new BLE characteristic so the app can show it in the pet status UI.

**Notes**
- On ESP32-C3, average 5-10 samples per measurement — the ADC is noisier than the nRF52's
- Calibrate the 4.15V / 3.30V endpoints against the specific LiPo cell in your build; different chemistries have slightly different discharge curves
- Under load (BLE active) the voltage sags by ~50-100mV — accept this or measure during idle windows only

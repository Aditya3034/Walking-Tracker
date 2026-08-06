// ============================================================
//  softwear.pet — XIAO nRF52840 Sense firmware
//  Port of esp32c3/src/main.cpp preserving BLE wire protocol byte-for-byte.
//
//  Key differences from ESP32-C3 version:
//    - BLE stack: Bluefruit (nRF SoftDevice) instead of Arduino ESP32 BLE
//    - Persistence: InternalFS/LittleFS instead of Preferences NVS
//    - Serial console: Adafruit_TinyUSB instead of native ESP32 CDC
//    - No setCpuFrequencyMhz — nRF52 runs at fixed 64 MHz
//    - I²C default pins on XIAO nRF52 already D4/D5 (call Wire.begin() no args)
//
//  What's preserved (must NOT change — the app depends on these):
//    - Service UUID + characteristic UUIDs
//    - Command strings: FEED / CONNECTED / NAME:*
//    - Notify payload strings: NORMAL / HUNGRY / STARVING / FEEDING
//    - Pet ID format + device type strings
//    - Hunger + starving intervals
// ============================================================

#include <Adafruit_TinyUSB.h>    // Required by framework's Wire library
#include <Arduino.h>
#include <bluefruit.h>
#include <U8g2lib.h>
#include <Wire.h>
#include <Adafruit_LittleFS.h>
#include <InternalFileSystem.h>

using namespace Adafruit_LittleFS_Namespace;

/* ============================================================
   LOG MACROS — same pattern as esp32c3/. No-ops in battery build.
   ============================================================ */
#ifdef ENABLE_SERIAL_LOGS
  #define LOG_INIT()   Serial.begin(115200)
  #define LOG(msg)     Serial.println(msg)
  #define LOGF(...)    Serial.printf(__VA_ARGS__)
#else
  #define LOG_INIT()
  #define LOG(msg)
  #define LOGF(...)
#endif

/* ============================================================
   PET ID — set per unit before flashing.
   Format: "KOS" + 6 digits.
   ============================================================ */
#define PET_ID "KOS000004"

/* ============================================================
   DEVICE TYPE — "badge" or "necklace"
   ============================================================ */
#define DEVICE_TYPE "badge"

/* ---------------- BLE UUIDs (MUST match ESP32-C3 firmware) ---------------- */
// Bluefruit takes UUIDs as arrays of 16 bytes in reverse order.
// Original string: 4fafc201-1fb5-459e-8fcc-c5c9c331914b
static const uint8_t SERVICE_UUID[16] = {
  0x4b, 0x91, 0x31, 0xc3, 0xc9, 0xc5, 0xcc, 0x8f,
  0x9e, 0x45, 0xb5, 0x1f, 0x01, 0xc2, 0xaf, 0x4f
};
// beb5483e-36e1-4688-b7f5-ea07361b26a8 (WRITE)
static const uint8_t CHR_WRITE_UUID[16] = {
  0xa8, 0x26, 0x1b, 0x36, 0x07, 0xea, 0xf5, 0xb7,
  0x88, 0x46, 0xe1, 0x36, 0x3e, 0x48, 0xb5, 0xbe
};
// beb5483e-36e1-4688-b7f5-ea07361b26a9 (NOTIFY)
static const uint8_t CHR_NOTIFY_UUID[16] = {
  0xa9, 0x26, 0x1b, 0x36, 0x07, 0xea, 0xf5, 0xb7,
  0x88, 0x46, 0xe1, 0x36, 0x3e, 0x48, 0xb5, 0xbe
};
// beb5483e-36e1-4688-b7f5-ea07361b26aa (READ Pet ID)
static const uint8_t CHR_PETID_UUID[16] = {
  0xaa, 0x26, 0x1b, 0x36, 0x07, 0xea, 0xf5, 0xb7,
  0x88, 0x46, 0xe1, 0x36, 0x3e, 0x48, 0xb5, 0xbe
};
// beb5483e-36e1-4688-b7f5-ea07361b26ab (READ device type)
static const uint8_t CHR_DEVICETYPE_UUID[16] = {
  0xab, 0x26, 0x1b, 0x36, 0x07, 0xea, 0xf5, 0xb7,
  0x88, 0x46, 0xe1, 0x36, 0x3e, 0x48, 0xb5, 0xbe
};

/* ---------------- OLED ---------------- */
// XIAO nRF52840 default I²C: SDA = D4 (P0.05), SCL = D5 (P0.04)
// Wire.begin() with no args picks these up automatically.
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

/* ---------------- BLE OBJECTS ---------------- */
BLEService        svcPet(SERVICE_UUID);
BLECharacteristic chrWrite(CHR_WRITE_UUID);
BLECharacteristic chrNotify(CHR_NOTIFY_UUID);
BLECharacteristic chrPetId(CHR_PETID_UUID);
BLECharacteristic chrDeviceType(CHR_DEVICETYPE_UUID);

/* ---------------- PET & EYE STATES ---------------- */
enum PetMood { PET_NORMAL, PET_HUNGRY, PET_STARVING, PET_FEEDING };
PetMood petMood  = PET_NORMAL;
PetMood prevMood = PET_NORMAL;

enum EyeState {
  STATE_NEUTRAL, STATE_SURPRISED, STATE_SAD,
  STATE_SUSPICIOUS, STATE_LEFT, STATE_RIGHT, STATE_UP,
  STATE_DOWN, STATE_EXCITED,
  STATE_HUNGRY, STATE_STARVING, STATE_HAPPY,
  STATE_COUNT
};

/* ---------------- TIMING & CONSTANTS ---------------- */
const int screenWidth  = 128, screenHeight = 64;
const int eyeBaseWidth = 30,  eyeBaseHeight = 44, eyeSpacing = 16;
const int blinkDuration = 220, transitionDuration = 150;

const unsigned long HUNGER_INTERVAL   = 7200000;  // 2 hours
const unsigned long STARVING_INTERVAL = 1800000;  // .5 hour after hungry
const unsigned long FEED_ANIM_DURATION = 3000;
const unsigned long PERSIST_INTERVAL  = 5000;

unsigned long lastBlinkTime = 0, lastStateChangeTime = 0;
unsigned long transitionStartTime = 0, feedingStartTime = 0;
unsigned long lastFedTime = 0, lastPersistTime = 0;

bool feedShowStars = false;

/* ---------------- NOTIFY HELPER ---------------- */
void notifyApp(const char* state) {
  chrNotify.notify((const uint8_t*)state, strlen(state));
}

/* ---------------- ANIMATION VARIABLES ---------------- */
bool isBlinking = false, isTransitioning = false;
byte blinkState = 0;
EyeState currentEyeState = STATE_NEUTRAL;
EyeState targetEyeState  = STATE_NEUTRAL;

float leftEyeWidth,  leftEyeHeight,  rightEyeWidth,  rightEyeHeight;
float leftOffsetX,   leftOffsetY,    rightOffsetX,   rightOffsetY;
float leftAngle,     rightAngle;
float leftTargetWidth,  leftTargetHeight,  rightTargetWidth,  rightTargetHeight;
float leftTargetOffsetX, leftTargetOffsetY, rightTargetOffsetX, rightTargetOffsetY;
float leftTargetAngle,  rightTargetAngle;
int   centerX, centerY, leftEyeX, rightEyeX, eyeY;

/* ---------------- EXCITED BOUNCE ---------------- */
float excitedBounceY = 0;

void updateExcitedBounce(unsigned long now) {
  if (currentEyeState == STATE_EXCITED) {
    excitedBounceY = sin((float)now / 35.0f) * 4.0f;
  } else {
    excitedBounceY = 0;
  }
}

/* ---------------- STARS (feeding animation) ---------------- */
struct Star { int x, y, size; unsigned long spawnTime; };
const int MAX_STARS = 6;
Star stars[MAX_STARS];
int  starCount = 0;

const int STAR_POS[MAX_STARS][2] = {
  {8,  6},  {118, 6},
  {4,  32}, {122, 32},
  {10, 56}, {116, 56}
};

void spawnStars() {
  starCount = MAX_STARS;
  for (int i = 0; i < MAX_STARS; i++) {
    stars[i].x         = STAR_POS[i][0];
    stars[i].y         = STAR_POS[i][1];
    stars[i].size      = (i % 3 == 0) ? 5 : 3;
    stars[i].spawnTime = millis();
  }
}

void clearStars() { starCount = 0; }

void drawStar(int x, int y, int r) {
  u8g2.drawLine(x, y - r, x, y + r);
  u8g2.drawLine(x - r, y, x + r, y);
  int d = r * 7 / 10;
  u8g2.drawLine(x - d, y - d, x + d, y + d);
  u8g2.drawLine(x + d, y - d, x - d, y + d);
}

void renderStars(unsigned long now) {
  for (int i = 0; i < starCount; i++) {
    unsigned long age = now - stars[i].spawnTime;
    int r = ((age / 200) % 2 == 0) ? stars[i].size : stars[i].size / 2 + 1;
    drawStar(stars[i].x, stars[i].y, r);
  }
}

/* ---------------- HUNGER SHAKE ---------------- */
void setEyeState(EyeState newState);
void forceEyeState(EyeState newState);

int shakeOffset = 0;
unsigned long lastShakeTime    = 0;
unsigned long shakeburstStart  = 0;
bool shakeBurstActive          = false;
bool shakeRight                = true;
unsigned long nextShakeBurst   = 0;

void updateHungerShake(unsigned long now) {
  if (petMood == PET_STARVING) {
    if (!shakeBurstActive) {
      shakeOffset = 0;
      if (now >= nextShakeBurst) {
        shakeBurstActive = true;
        shakeburstStart  = now;
        lastShakeTime    = now;
        shakeRight       = true;
        shakeOffset      = 8;
      }
    } else {
      if (now - shakeburstStart > 2000) {
        shakeBurstActive = false;
        shakeOffset      = 0;
        nextShakeBurst   = now + 5000 + random(1000);
      } else {
        if (now - lastShakeTime > 70) {
          shakeRight    = !shakeRight;
          shakeOffset   = shakeRight ? 8 : -8;
          lastShakeTime = now;
        }
      }
    }
  } else if (petMood == PET_HUNGRY) {
    shakeBurstActive = false;
    if (now - lastShakeTime > 400) {
      shakeOffset   = (shakeOffset == 0) ? 2 : 0;
      lastShakeTime = now;
    }
  } else {
    shakeOffset      = 0;
    shakeBurstActive = false;
  }
}

/* ---------------- PERSISTENCE (LittleFS on internal flash) ---------------- */
// File paths in the internal FS
static const char* FN_ELAPSED    = "elapsed.bin";
static const char* FN_DEVICENAME = "devname.txt";

void persistHungerState() {
  uint32_t elapsed = millis() - lastFedTime;
  Adafruit_LittleFS_Namespace::File f(InternalFS);
  if (f.open(FN_ELAPSED, FILE_O_WRITE)) {
    // Truncate any existing data before writing new value
    f.close();
    InternalFS.remove(FN_ELAPSED);
    if (f.open(FN_ELAPSED, FILE_O_WRITE)) {
      f.write((const uint8_t*)&elapsed, sizeof(elapsed));
      f.close();
    }
  }
}

void clearPersistedHunger() {
  InternalFS.remove(FN_ELAPSED);
}

uint32_t loadPersistedElapsed() {
  uint32_t elapsed = 0;
  Adafruit_LittleFS_Namespace::File f(InternalFS);
  if (f.open(FN_ELAPSED, FILE_O_READ)) {
    f.read((uint8_t*)&elapsed, sizeof(elapsed));
    f.close();
  }
  return elapsed;
}

void persistDeviceName(const char* name) {
  InternalFS.remove(FN_DEVICENAME);
  Adafruit_LittleFS_Namespace::File f(InternalFS);
  if (f.open(FN_DEVICENAME, FILE_O_WRITE)) {
    f.write((const uint8_t*)name, strlen(name));
    f.close();
  }
}

String loadDeviceName() {
  String result = "";
  Adafruit_LittleFS_Namespace::File f(InternalFS);
  if (f.open(FN_DEVICENAME, FILE_O_READ)) {
    while (f.available()) {
      result += (char)f.read();
    }
    f.close();
  }
  return result;
}

/* ---------------- CONNECTION STATE ---------------- */
bool bleConnected = false;
unsigned long bleStatusShowUntil = 0;
const unsigned long BLE_STATUS_DURATION = 2000;

// 5-sec advertising window after boot / disconnect
unsigned long advertisingStartTime = 0;
bool advertisingActive = true;
const unsigned long ADVERTISING_WINDOW = 60000;  // 60s during dev; drop to 5s for battery

/* ---------------- BLE CALLBACKS ---------------- */
void onBleConnect(uint16_t conn_handle) {
  bleConnected = true;
  bleStatusShowUntil = millis() + BLE_STATUS_DURATION;
  LOG("BLE connected");

  // TODO: request slower connection interval for power savings once basic
  // connectivity is verified. Skipping for now to isolate connect-time issues.
  (void)conn_handle;
}

void onBleDisconnect(uint16_t conn_handle, uint8_t reason) {
  (void)conn_handle;
  (void)reason;
  bleConnected = false;
  bleStatusShowUntil = millis() + BLE_STATUS_DURATION;
  LOG("BLE disconnected");
  delay(500);
  // Re-open the 5-sec advertising window
  Bluefruit.Advertising.start(0);   // 0 = advertise indefinitely; loop() enforces cutoff
  advertisingStartTime = millis();
  advertisingActive = true;
}

/* ---------------- BLE WRITE CALLBACK ---------------- */
void onWriteCommand(uint16_t conn_handle, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
  (void)conn_handle;
  (void)chr;

  // Bluefruit gives us raw bytes; make a null-terminated copy for String comparisons
  char buf[33];
  uint16_t n = (len < sizeof(buf) - 1) ? len : (sizeof(buf) - 1);
  memcpy(buf, data, n);
  buf[n] = '\0';
  String value = String(buf);

  LOGF("BLE write: %s\n", buf);

  if (value == "FEED") {
    bool wasHungry   = (petMood == PET_HUNGRY || petMood == PET_STARVING);
    petMood          = PET_FEEDING;
    feedingStartTime = millis();
    lastFedTime      = millis();
    clearPersistedHunger();
    notifyApp("FEEDING");
    feedShowStars = wasHungry;
    if (feedShowStars) spawnStars();
  } else if (value == "CONNECTED") {
    if (petMood == PET_STARVING) notifyApp("STARVING");
    else if (petMood == PET_HUNGRY) notifyApp("HUNGRY");
    else notifyApp("NORMAL");
  } else if (value.startsWith("NAME:")) {
    String newName = value.substring(5);
    newName.trim();
    if (newName.length() > 0 && newName.length() <= 28) {
      persistDeviceName(newName.c_str());
      Bluefruit.setName(newName.c_str());
    }
  }
}

/* ---------------- EYE DIMENSIONS ---------------- */
void updateEyeDimensions(EyeState state,
                         float &lw, float &lh, float &rw, float &rh,
                         float &lx, float &ly, float &rx, float &ry,
                         float &la, float &ra) {
  lw = rw = eyeBaseWidth; lh = rh = eyeBaseHeight;
  lx = ly = rx = ry = la = ra = 0;

  switch (state) {
    case STATE_SURPRISED:
      lw *= 1.3; lh = lw; rw *= 1.3; rh = rw;
      break;
    case STATE_SAD:
      lh *= 0.7; rh *= 0.7; ly = ry = 8; la = 0; ra = 0;
      break;
    case STATE_HUNGRY:
      lh *= 0.63; rh *= 0.63;
      ly = 10;    ry = 10;
      lx = 4;     rx = -4;
      break;
    case STATE_STARVING:
      lh *= 0.63; rh *= 0.63;
      ly = 10;    ry = 10;
      lx = 4;     rx = -4;
      break;
    case STATE_HAPPY:
      lw *= 1.25; lh *= 1.25;
      rw *= 1.25; rh *= 1.25;
      ly = -6;    ry = -6;
      break;
    case STATE_SUSPICIOUS: break;
    case STATE_LEFT:
      lx = -10; rx = -14;
      lw *= 0.72; lh *= 0.72;
      rw *= 0.88; rh *= 0.92;
      break;
    case STATE_RIGHT:
      lx =  14; rx =  10;
      rw *= 0.72; rh *= 0.72;
      lw *= 0.88; lh *= 0.92;
      break;
    case STATE_UP:
      ly = ry = -14;
      lw *= 1.15; rw *= 1.15;
      lh *= 0.70; rh *= 0.70;
      break;
    case STATE_DOWN:
      ly = ry = 14;
      lw *= 1.15; rw *= 1.15;
      lh *= 0.70; rh *= 0.70;
      break;
    case STATE_EXCITED:
      lw *= 1.3;  rw *= 1.3;
      break;
    default: break;
  }
}

void setEyeState(EyeState newState) {
  if (newState == targetEyeState) return;
  targetEyeState      = newState;
  isTransitioning     = true;
  transitionStartTime = millis();
  updateEyeDimensions(newState,
    leftTargetWidth, leftTargetHeight, rightTargetWidth, rightTargetHeight,
    leftTargetOffsetX, leftTargetOffsetY, rightTargetOffsetX, rightTargetOffsetY,
    leftTargetAngle, rightTargetAngle);
}

void forceEyeState(EyeState newState) {
  targetEyeState      = newState;
  currentEyeState     = newState;
  isTransitioning     = false;
  updateEyeDimensions(newState,
    leftTargetWidth, leftTargetHeight, rightTargetWidth, rightTargetHeight,
    leftTargetOffsetX, leftTargetOffsetY, rightTargetOffsetX, rightTargetOffsetY,
    leftTargetAngle, rightTargetAngle);
  leftEyeWidth   = leftTargetWidth;   leftEyeHeight  = leftTargetHeight;
  rightEyeWidth  = rightTargetWidth;  rightEyeHeight = rightTargetHeight;
  leftOffsetX    = leftTargetOffsetX; leftOffsetY    = leftTargetOffsetY;
  rightOffsetX   = rightTargetOffsetX; rightOffsetY  = rightTargetOffsetY;
  leftAngle      = leftTargetAngle;   rightAngle     = rightTargetAngle;
}

/* ---------------- DRAWING ---------------- */
void drawFilledEllipse(int x0, int y0, int w, int h, float angle) {
  int a = w / 2, b = h / 2;
  if (b <= 0) return;
  for (int y = -b; y <= b; y++) {
    float rel = (float)y / b;
    int hw = a * sqrt(1.0 - rel * rel);
    if (angle == 0) {
      u8g2.drawHLine(x0 - hw, y0 + y, hw * 2);
    } else {
      float s = sin(angle), c = cos(angle);
      int x1 = x0 + (-hw * c - y * s), y1 = y0 + (-hw * s + y * c);
      int x2 = x0 + ( hw * c - y * s), y2 = y0 + ( hw * s + y * c);
      u8g2.drawLine(x1, y1, x2, y2);
    }
  }
}

/* ---------------- SETUP ---------------- */
void setup() {
  LOG_INIT();

  // I²C on default XIAO nRF52 pins (D4 = SDA, D5 = SCL)
  Wire.begin();

  u8g2.begin();
  u8g2.setContrast(128);
  centerX   = screenWidth / 2;
  centerY   = screenHeight / 2;
  leftEyeX  = centerX - eyeSpacing / 2 - eyeBaseWidth / 2;
  rightEyeX = centerX + eyeSpacing / 2 + eyeBaseWidth / 2;
  eyeY      = centerY;

  leftEyeWidth  = rightEyeWidth  = eyeBaseWidth;
  leftEyeHeight = rightEyeHeight = eyeBaseHeight;

  // Persistence
  InternalFS.begin();
  uint32_t savedElapsed = loadPersistedElapsed();
  lastFedTime = millis() - savedElapsed;

  // Bluefruit BLE setup — must .begin() before any Bluefruit.getAddr() call
  Bluefruit.begin();
  Bluefruit.setTxPower(4);   // dBm; 4 = default, +/-40 dB range on nRF52

  // Determine BLE advertising name — persisted or MAC-derived
  String savedName = loadDeviceName();
  char bleName[32];
  if (savedName.length() > 0) {
    strncpy(bleName, savedName.c_str(), sizeof(bleName) - 1);
    bleName[sizeof(bleName) - 1] = '\0';
  } else {
    uint8_t mac[6];
    Bluefruit.getAddr(mac);
    // MAC bytes are stored in reverse order; use the low two bytes for the suffix
    snprintf(bleName, sizeof(bleName), "softwear-%02X%02X", mac[1], mac[0]);
  }
  Bluefruit.setName(bleName);
  Bluefruit.Periph.setConnectCallback(onBleConnect);
  Bluefruit.Periph.setDisconnectCallback(onBleDisconnect);

  // Service + characteristics
  svcPet.begin();

  chrWrite.setProperties(CHR_PROPS_WRITE | CHR_PROPS_WRITE_WO_RESP);
  chrWrite.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  chrWrite.setMaxLen(32);
  chrWrite.setWriteCallback(onWriteCommand);
  chrWrite.begin();

  chrNotify.setProperties(CHR_PROPS_NOTIFY);
  // Both open — value read is via notify, but the CCCD (enable notify) needs write access
  chrNotify.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  chrNotify.setMaxLen(32);
  chrNotify.begin();

  chrPetId.setProperties(CHR_PROPS_READ);
  chrPetId.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  chrPetId.setMaxLen(strlen(PET_ID));
  chrPetId.begin();
  chrPetId.write(PET_ID, strlen(PET_ID));

  chrDeviceType.setProperties(CHR_PROPS_READ);
  chrDeviceType.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  chrDeviceType.setMaxLen(strlen(DEVICE_TYPE));
  chrDeviceType.begin();
  chrDeviceType.write(DEVICE_TYPE, strlen(DEVICE_TYPE));

  // Advertising
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addService(svcPet);
  Bluefruit.Advertising.addName();
  Bluefruit.Advertising.restartOnDisconnect(false);   // We control this manually
  Bluefruit.Advertising.setInterval(160, 244);        // 100–152.5 ms (units of 0.625 ms)
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);                     // 0 = indefinite; loop() enforces window
  advertisingStartTime = millis();

  lastPersistTime = millis();
  LOG("Setup complete");
}

/* ---------------- LOOP ---------------- */
void loop() {
  unsigned long now = millis();

  // 0. BLE advertising window cutoff — stop after 5 sec to save battery
  if (advertisingActive && !bleConnected && now - advertisingStartTime > ADVERTISING_WINDOW) {
    Bluefruit.Advertising.stop();
    advertisingActive = false;
    LOG("Advertising stopped (5-sec window elapsed)");
  }

  // 1. MOOD LOGIC
  if (petMood == PET_FEEDING) {
    setEyeState(STATE_HAPPY);
    if (now - feedingStartTime > FEED_ANIM_DURATION) {
      petMood       = PET_NORMAL;
      feedShowStars = false;
      clearStars();
    }
  }
  else if (now - lastFedTime > HUNGER_INTERVAL + STARVING_INTERVAL) {
    petMood = PET_STARVING;
    setEyeState(STATE_STARVING);
  }
  else if (now - lastFedTime > HUNGER_INTERVAL) {
    petMood = PET_HUNGRY;
    setEyeState(STATE_HUNGRY);
  }
  else {
    petMood = PET_NORMAL;
    if (!isTransitioning && now - lastStateChangeTime > (unsigned long)random(3000, 7000)) {
      EyeState pick = (EyeState)random(STATE_EXCITED + 1);
      setEyeState(pick);
      lastStateChangeTime = now;
    }
  }

  // 2. NOTIFY APP ON MOOD CHANGE
  if (petMood != prevMood) {
    if (petMood == PET_HUNGRY)   notifyApp("HUNGRY");
    if (petMood == PET_STARVING) notifyApp("STARVING");
    if (petMood == PET_NORMAL && prevMood != PET_FEEDING) notifyApp("NORMAL");
    prevMood = petMood;
  }

  // 3. PERSIST HUNGER
  if ((petMood == PET_HUNGRY || petMood == PET_STARVING) && now - lastPersistTime > PERSIST_INTERVAL) {
    persistHungerState();
    lastPersistTime = now;
  }

  // 4. HUNGER SHAKE + EXCITED BOUNCE
  updateHungerShake(now);
  updateExcitedBounce(now);

  // 5. BLINK
  if (petMood != PET_FEEDING && !(petMood == PET_STARVING && shakeBurstActive)) {
    unsigned long blinkInterval = (petMood == PET_HUNGRY || petMood == PET_STARVING)
      ? (unsigned long)random(6000, 10000)
      : (currentEyeState == STATE_EXCITED)
        ? (unsigned long)random(400, 900)
        : (unsigned long)random(2000, 5000);
    if (!isBlinking && now - lastBlinkTime > blinkInterval) {
      isBlinking = true; blinkState = 1; lastBlinkTime = now;
    }
    if (isBlinking && now - lastBlinkTime > blinkDuration / 4) {
      blinkState++;
      if (blinkState > 3) { isBlinking = false; blinkState = 0; }
      lastBlinkTime = now;
    }
  } else {
    isBlinking = false; blinkState = 0;
  }

  // 6. TRANSITION LERPING
  if (isTransitioning) {
    float p = (float)(now - transitionStartTime) / transitionDuration;
    if (p >= 1.0) { p = 1.0; isTransitioning = false; currentEyeState = targetEyeState; }
    leftEyeWidth    += (leftTargetWidth    - leftEyeWidth)    * p;
    leftEyeHeight   += (leftTargetHeight   - leftEyeHeight)   * p;
    rightEyeWidth   += (rightTargetWidth   - rightEyeWidth)   * p;
    rightEyeHeight  += (rightTargetHeight  - rightEyeHeight)  * p;
    leftOffsetX     += (leftTargetOffsetX  - leftOffsetX)     * p;
    leftOffsetY     += (leftTargetOffsetY  - leftOffsetY)     * p;
    rightOffsetX    += (rightTargetOffsetX - rightOffsetX)    * p;
    rightOffsetY    += (rightTargetOffsetY - rightOffsetY)    * p;
    leftAngle       += (leftTargetAngle    - leftAngle)       * p;
    rightAngle      += (rightTargetAngle   - rightAngle)      * p;
  }

  // 7. RENDER
  u8g2.clearBuffer();

  float openness = 1.0;
  if (isBlinking) openness = (blinkState == 2) ? 0.05 : 0.5;

  int lxDraw = leftEyeX  + (int)leftOffsetX  + shakeOffset;
  int rxDraw = rightEyeX + (int)rightOffsetX + shakeOffset;

  int bounce = (int)excitedBounceY;
  drawFilledEllipse(lxDraw, eyeY + (int)leftOffsetY  + bounce, leftEyeWidth,  leftEyeHeight  * openness, leftAngle);
  drawFilledEllipse(rxDraw, eyeY + (int)rightOffsetY + bounce, rightEyeWidth, rightEyeHeight * openness, rightAngle);

  if (petMood == PET_FEEDING && feedShowStars) {
    renderStars(now);
  }

  if (now < bleStatusShowUntil) {
    const char* msg = bleConnected ? "connected" : "disconnected";
    u8g2.setFont(u8g2_font_6x10_tf);
    int textW = u8g2.getStrWidth(msg);
    u8g2.drawStr((screenWidth - textW) / 2, screenHeight - 2, msg);
  }

  u8g2.sendBuffer();
  delay(16);
}

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <U8g2lib.h>
#include <Wire.h>
#include <Preferences.h>
#include "esp_mac.h"
#include "esp_gap_ble_api.h"

/* ============================================================
   PET ID — UNIQUE PER DEVICE
   !!  CHANGE THIS BEFORE FLASHING EACH PRODUCTION UNIT  !!
   Format: "KOS" + 6 digits (e.g., KOS000001, KOS000002, ...)
   ============================================================ */
#define PET_ID "KOS000001"

/* ---------------- BLE CONFIG ---------------- */
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define NOTIFY_UUID         "beb5483e-36e1-4688-b7f5-ea07361b26a9"
#define PETID_UUID          "beb5483e-36e1-4688-b7f5-ea07361b26aa"

/* ---------------- OLED ---------------- */
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

/* ---------------- PERSISTENCE ---------------- */
Preferences prefs;

/* ---------------- PET & EYE STATES ---------------- */
enum PetMood { PET_NORMAL, PET_HUNGRY, PET_STARVING, PET_FEEDING };
PetMood petMood  = PET_NORMAL;
PetMood prevMood = PET_NORMAL;

enum EyeState {
  STATE_NEUTRAL, STATE_SURPRISED, STATE_SAD,
  STATE_SUSPICIOUS, STATE_LEFT, STATE_RIGHT, STATE_UP,
  STATE_DOWN, STATE_EXCITED,
  // Dedicated states (not in random idle pool)
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


// Whether stars should show during current feed animation
bool feedShowStars = false;

/* ---------------- BLE NOTIFY CHAR ---------------- */
BLECharacteristic *pNotifyChar = nullptr;

void notifyApp(const char* state) {
  if (!pNotifyChar) return;
  pNotifyChar->setValue(state);
  pNotifyChar->notify();
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
    // Sine wave: period ~220ms, amplitude ±4px
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

// Fixed star positions so they don't flicker — spawn once on FEED
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

// 4-point star: two crossed lines + diagonal lines
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
void setEyeState(EyeState newState);   // forward declaration
void forceEyeState(EyeState newState); // forward declaration

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

/* ---------------- PERSISTENCE HELPERS ---------------- */
void persistHungerState() {
  prefs.putULong("elapsed", millis() - lastFedTime);
}

void clearPersistedHunger() {
  prefs.putULong("elapsed", 0);
}

/* ---------------- CONNECTION STATE ---------------- */
bool bleConnected = false;
unsigned long bleStatusShowUntil = 0;
const unsigned long BLE_STATUS_DURATION = 2000;

/* ---------------- BLE SERVER CALLBACKS ---------------- */
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *pServer) override {
    bleConnected = true;
    bleStatusShowUntil = millis() + BLE_STATUS_DURATION;
  }
  void onDisconnect(BLEServer *pServer) override {
    bleConnected = false;
    bleStatusShowUntil = millis() + BLE_STATUS_DURATION;
    delay(500);
    BLEDevice::getAdvertising()->start();
  }
};

/* ---------------- BLE CHARACTERISTIC CALLBACK ---------------- */
class MyCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pChar) {
    String value = pChar->getValue().c_str();
    if (value == "FEED") {
      bool wasHungry   = (petMood == PET_HUNGRY || petMood == PET_STARVING);
      petMood          = PET_FEEDING;
      feedingStartTime = millis();
      lastFedTime      = millis();
      clearPersistedHunger();
      notifyApp("FEEDING");
      // Stars only when recovering from hunger; happy eyes only when already normal
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
        prefs.putString("deviceName", newName.c_str());
        esp_ble_gap_set_device_name(newName.c_str());
      }
    }
  }
};

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
      // Wide eyes (not tall) — energy comes from the bounce, not size
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
  u8g2.begin();
  centerX   = screenWidth / 2;
  centerY   = screenHeight / 2;
  leftEyeX  = centerX - eyeSpacing / 2 - eyeBaseWidth / 2;
  rightEyeX = centerX + eyeSpacing / 2 + eyeBaseWidth / 2;
  eyeY      = centerY;

  leftEyeWidth  = rightEyeWidth  = eyeBaseWidth;
  leftEyeHeight = rightEyeHeight = eyeBaseHeight;

  prefs.begin("pet", false);
  unsigned long savedElapsed = prefs.getULong("elapsed", 0);
  lastFedTime = millis() - savedElapsed;

  String savedName = prefs.getString("deviceName", "");
  char bleName[32];
  if (savedName.length() > 0) {
    strncpy(bleName, savedName.c_str(), sizeof(bleName) - 1);
    bleName[sizeof(bleName) - 1] = '\0';
  } else {
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_BT);
    snprintf(bleName, sizeof(bleName), "softwear-%02X%02X", mac[4], mac[5]);
  }

  BLEDevice::init(bleName);
  BLEServer  *pServer  = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());
  BLEService *pService = pServer->createService(SERVICE_UUID);

  BLECharacteristic *pWriteChar = pService->createCharacteristic(
    CHARACTERISTIC_UUID, BLECharacteristic::PROPERTY_WRITE);
  pWriteChar->setCallbacks(new MyCallbacks());

  pNotifyChar = pService->createCharacteristic(
    NOTIFY_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  pNotifyChar->addDescriptor(new BLE2902());

  BLECharacteristic *pPetIdChar = pService->createCharacteristic(
    PETID_UUID, BLECharacteristic::PROPERTY_READ);
  pPetIdChar->setValue(PET_ID);

  pService->start();
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->start();

  lastPersistTime = millis();
}

/* ---------------- LOOP ---------------- */
void loop() {
  unsigned long now = millis();

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
      EyeState pick = (EyeState)random(STATE_EXCITED + 1);  // states 0..8 (idle pool)
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

  // 5. BLINK — disabled while feeding; hungry blinks slowly; starving blinks only when calm
  if (petMood != PET_FEEDING && !(petMood == PET_STARVING && shakeBurstActive)) {
    unsigned long blinkInterval = (petMood == PET_HUNGRY || petMood == PET_STARVING)
      ? (unsigned long)random(6000, 10000)
      : (currentEyeState == STATE_EXCITED)
        ? (unsigned long)random(400, 900)   // rapid blinking when excited
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

  // Stars only when recovering from hunger
  if (petMood == PET_FEEDING && feedShowStars) {
    renderStars(now);
  }

  // BLE connection status text — shown briefly on connect/disconnect
  if (now < bleStatusShowUntil) {
    const char* msg = bleConnected ? "connected" : "disconnected";
    u8g2.setFont(u8g2_font_6x10_tf);
    int textW = u8g2.getStrWidth(msg);
    u8g2.drawStr((screenWidth - textW) / 2, screenHeight - 2, msg);
  }

  u8g2.sendBuffer();
  delay(16);
}

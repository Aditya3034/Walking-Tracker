#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <U8g2lib.h>
#include <Wire.h>
#include <Preferences.h>

/* ---------------- BLE CONFIG ---------------- */
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define NOTIFY_UUID         "beb5483e-36e1-4688-b7f5-ea07361b26a9"

/* ---------------- OLED ---------------- */
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

/* ---------------- PERSISTENCE ---------------- */
Preferences prefs;

/* ---------------- PET & EYE STATES ---------------- */
enum PetMood { PET_NORMAL, PET_HUNGRY, PET_FEEDING };
PetMood petMood  = PET_NORMAL;
PetMood prevMood = PET_NORMAL;

enum EyeState {
  STATE_NEUTRAL, STATE_ANGRY, STATE_SURPRISED, STATE_SAD,
  STATE_SUSPICIOUS, STATE_LEFT, STATE_RIGHT, STATE_UP,
  STATE_DOWN, STATE_SLEEPY,
  // New dedicated states
  STATE_HUNGRY, STATE_HAPPY,
  STATE_COUNT
};

/* ---------------- TIMING & CONSTANTS ---------------- */
const int screenWidth  = 128, screenHeight = 64;
const int eyeBaseWidth = 30,  eyeBaseHeight = 44, eyeSpacing = 16;
const int blinkDuration = 220, transitionDuration = 150;

const unsigned long HUNGER_INTERVAL   = 15000;
const unsigned long STARVING_INTERVAL = 30000;
const unsigned long FEED_ANIM_DURATION = 3000; // extended for star show
const unsigned long PERSIST_INTERVAL  = 5000;

unsigned long lastBlinkTime = 0, lastStateChangeTime = 0;
unsigned long transitionStartTime = 0, feedingStartTime = 0;
unsigned long lastFedTime = 0, lastPersistTime = 0;

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
  u8g2.drawLine(x, y - r, x, y + r);          // vertical
  u8g2.drawLine(x - r, y, x + r, y);          // horizontal
  int d = r * 7 / 10;
  u8g2.drawLine(x - d, y - d, x + d, y + d);  // diagonal /
  u8g2.drawLine(x + d, y - d, x - d, y + d);  // diagonal (backslash)
}

void renderStars(unsigned long now) {
  for (int i = 0; i < starCount; i++) {
    // Twinkle: alternate full / half size every 200ms
    unsigned long age = now - stars[i].spawnTime;
    int r = ((age / 200) % 2 == 0) ? stars[i].size : stars[i].size / 2 + 1;
    drawStar(stars[i].x, stars[i].y, r);
  }
}

/* ---------------- HUNGER SHAKE ---------------- */
// When hungry, eyes jitter slightly left-right
int shakeOffset = 0;
unsigned long lastShakeTime = 0;
const unsigned long SHAKE_INTERVAL = 400;

void updateHungerShake(unsigned long now) {
  if (petMood != PET_HUNGRY) { shakeOffset = 0; return; }
  if (now - lastShakeTime > SHAKE_INTERVAL) {
    shakeOffset = (shakeOffset == 0) ? 2 : 0;
    lastShakeTime = now;
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
      petMood          = PET_FEEDING;
      feedingStartTime = millis();
      lastFedTime      = millis();
      clearPersistedHunger();
      spawnStars();
      notifyApp("FEEDING");
    } else if (value == "CONNECTED") {
      // App just connected — reply with current hunger state so UI syncs immediately
      if (petMood == PET_HUNGRY) notifyApp("HUNGRY");
      else notifyApp("NORMAL");
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
    case STATE_ANGRY:
      la = -0.5; ra = 0.5; lw *= 0.8; rw *= 0.8;
      break;

    case STATE_SURPRISED:
      lw *= 1.3; lh = lw; rw *= 1.3; rh = rw;
      break;

    case STATE_SAD:
      lh *= 0.7; rh *= 0.7; ly = ry = 8; la = 0; ra = 0;
      break;

    // HUNGRY: droopy, narrow, tilted inward — clearly miserable
    case STATE_HUNGRY:
      lh *= 0.55; rh *= 0.55;   // very flat / droopy
      lw *= 0.85; rw *= 0.85;   // slightly narrower
      ly = 10;    ry = 10;       // pushed down
      la = 0.35;  ra = -0.35;    // strong inward tilt
      break;

    // HAPPY: tall wide eyes, slight upward offset — big bright expression
    case STATE_HAPPY:
      lw *= 1.25; lh *= 1.25;
      rw *= 1.25; rh *= 1.25;
      ly = -6;    ry = -6;       // lifted up
      la = -0.1;  ra = 0.1;      // gentle outward tilt
      break;

    case STATE_SUSPICIOUS: break;
    case STATE_LEFT:   lx = -10; rx = -12; break;
    case STATE_RIGHT:  lx =  12; rx =  10; break;
    case STATE_UP:     ly = ry = -12; break;
    case STATE_DOWN:   ly = ry =  12; break;
    case STATE_SLEEPY: lh *= 0.4; break;
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

// XO marks drawn over eyes when hungry (teary X)
void drawHungryMarks() {
  int lx = leftEyeX  + (int)leftOffsetX  + shakeOffset;
  int rx = rightEyeX + (int)rightOffsetX + shakeOffset;
  int yl = eyeY + (int)leftOffsetY;
  int yr = eyeY + (int)rightOffsetY;
  int d = 5;
  // Left eye: tiny X above
  u8g2.drawLine(lx - d, yl - (int)(leftEyeHeight/2) - 6,
                lx + d, yl - (int)(leftEyeHeight/2) - 2);
  u8g2.drawLine(lx + d, yl - (int)(leftEyeHeight/2) - 6,
                lx - d, yl - (int)(leftEyeHeight/2) - 2);
  // Right eye: tiny X above
  u8g2.drawLine(rx - d, yr - (int)(rightEyeHeight/2) - 6,
                rx + d, yr - (int)(rightEyeHeight/2) - 2);
  u8g2.drawLine(rx + d, yr - (int)(rightEyeHeight/2) - 6,
                rx - d, yr - (int)(rightEyeHeight/2) - 2);
}

// Small tear drops below each eye when hungry
void drawTears() {
  int lx = leftEyeX  + (int)leftOffsetX  + shakeOffset;
  int rx = rightEyeX + (int)rightOffsetX + shakeOffset;
  int tearY = eyeY + (int)(leftEyeHeight / 2) + 4;
  // Teardrop = small filled triangle pointing down
  u8g2.drawLine(lx - 2, tearY,     lx + 2, tearY);
  u8g2.drawLine(lx - 2, tearY,     lx,     tearY + 4);
  u8g2.drawLine(lx + 2, tearY,     lx,     tearY + 4);
  u8g2.drawLine(rx - 2, tearY,     rx + 2, tearY);
  u8g2.drawLine(rx - 2, tearY,     rx,     tearY + 4);
  u8g2.drawLine(rx + 2, tearY,     rx,     tearY + 4);
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

  BLEDevice::init("PetLocket");
  BLEServer  *pServer  = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());
  BLEService *pService = pServer->createService(SERVICE_UUID);

  BLECharacteristic *pWriteChar = pService->createCharacteristic(
    CHARACTERISTIC_UUID, BLECharacteristic::PROPERTY_WRITE);
  pWriteChar->setCallbacks(new MyCallbacks());

  pNotifyChar = pService->createCharacteristic(
    NOTIFY_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  pNotifyChar->addDescriptor(new BLE2902());

  pService->start();
  BLEDevice::getAdvertising()->start();

  lastPersistTime = millis();
}

/* ---------------- LOOP ---------------- */
void loop() {
  unsigned long now = millis();

  // 1. MOOD LOGIC
  if (petMood == PET_FEEDING) {
    setEyeState(STATE_HAPPY);
    if (now - feedingStartTime > FEED_ANIM_DURATION) {
      petMood = PET_NORMAL;
      clearStars();
    }
  }
  else if (now - lastFedTime > HUNGER_INTERVAL) {
    petMood = PET_HUNGRY;
    setEyeState(STATE_HUNGRY);
  }
  else {
    petMood = PET_NORMAL;
    if (!isTransitioning && now - lastStateChangeTime > (unsigned long)random(3000, 7000)) {
      // Don't randomly pick HUNGRY or HAPPY states — those are mood-driven only
      EyeState pick;
      do { pick = (EyeState)random(STATE_SLEEPY + 1); } while (pick == STATE_HUNGRY || pick == STATE_HAPPY);
      setEyeState(pick);
      lastStateChangeTime = now;
    }
  }

  // 2. NOTIFY APP ON MOOD CHANGE
  if (petMood != prevMood) {
    if (petMood == PET_HUNGRY) notifyApp("HUNGRY");
    if (petMood == PET_NORMAL && prevMood != PET_FEEDING) notifyApp("NORMAL");
    prevMood = petMood;
  }

  // 3. PERSIST HUNGER
  if (petMood == PET_HUNGRY && now - lastPersistTime > PERSIST_INTERVAL) {
    persistHungerState();
    lastPersistTime = now;
  }

  // 4. HUNGER SHAKE
  updateHungerShake(now);

  // 5. BLINK — disabled while feeding or hungry
  if (petMood != PET_FEEDING && petMood != PET_HUNGRY) {
    if (!isBlinking && now - lastBlinkTime > (unsigned long)random(2000, 5000)) {
      isBlinking = true; blinkState = 1; lastBlinkTime = now;
    }
    if (isBlinking && now - lastBlinkTime > blinkDuration / 4) {
      blinkState++;
      if (blinkState > 3) { isBlinking = false; blinkState = 0; }
      lastBlinkTime = now;
    }
  } else {
    isBlinking = false; blinkState = 0; // reset mid-blink frames for feeding/hungry
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

  drawFilledEllipse(lxDraw, eyeY + (int)leftOffsetY,  leftEyeWidth,  leftEyeHeight  * openness, leftAngle);
  drawFilledEllipse(rxDraw, eyeY + (int)rightOffsetY, rightEyeWidth, rightEyeHeight * openness, rightAngle);

  // Hungry extras: tears only
  if (petMood == PET_HUNGRY) {
    drawTears();
  }

  // Feeding extras: stars around screen
  if (petMood == PET_FEEDING) {
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

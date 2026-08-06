// ============================================================
//  IMU + PDM hardware test for XIAO nRF52840 Sense
//
//  What this does:
//    - Powers the onboard LSM6DS3TR-C IMU (6-axis)
//    - Reads accel at 26 Hz, detects steps via magnitude threshold
//    - Powers the onboard PDM mic, reads samples, prints RMS level
//    - Prints step count + mic level to Serial every 250 ms
//
//  Walk around → you should see the step counter climb.
//  Say something / clap → you should see the mic RMS spike.
// ============================================================

#include <Adafruit_TinyUSB.h>
#include <Arduino.h>
#include <Wire.h>
#include <PDM.h>
#include <math.h>

/* ---------- LSM6DS3TR-C on Wire1 ---------- */
static uint8_t       LSM_ADDR      = 0x6A;   // may be flipped to 0x6B on some units
static const uint8_t REG_WHO_AM_I  = 0x0F;
static const uint8_t REG_CTRL1_XL  = 0x10;
static const uint8_t REG_OUTX_L_XL = 0x28;

static void lsmWrite(uint8_t reg, uint8_t val) {
  Wire1.beginTransmission(LSM_ADDR);
  Wire1.write(reg);
  Wire1.write(val);
  Wire1.endTransmission();
}

static uint8_t lsmRead(uint8_t reg) {
  Wire1.beginTransmission(LSM_ADDR);
  Wire1.write(reg);
  Wire1.endTransmission(false);
  Wire1.requestFrom(LSM_ADDR, (uint8_t)1);
  return Wire1.available() ? Wire1.read() : 0;
}

static void lsmReadAccel(int16_t &x, int16_t &y, int16_t &z) {
  Wire1.beginTransmission(LSM_ADDR);
  Wire1.write(REG_OUTX_L_XL);
  Wire1.endTransmission(false);
  Wire1.requestFrom(LSM_ADDR, (uint8_t)6);
  uint8_t b[6] = {0};
  for (int i = 0; i < 6 && Wire1.available(); i++) b[i] = Wire1.read();
  x = (int16_t)(b[0] | (b[1] << 8));
  y = (int16_t)(b[2] | (b[3] << 8));
  z = (int16_t)(b[4] | (b[5] << 8));
}

/* ---------- Step detection ---------- */
static uint32_t stepCount = 0;
static float    magEma    = 1.0f;     // running average of magnitude (gravity)
static bool     abovePeak = false;
static uint32_t lastStepMs = 0;
static const float STEP_THRESHOLD_G = 0.25f;   // dev over gravity that counts as a peak
static const uint32_t STEP_DEBOUNCE_MS = 250;

/* ---------- PDM mic ---------- */
static volatile int16_t pdmBuf[512];
static volatile int     pdmSampleCount = 0;
static volatile int32_t pdmSquareSum   = 0;

void onPdmData() {
  int n = PDM.available();
  if (n > (int)sizeof(pdmBuf)) n = sizeof(pdmBuf);
  PDM.read((void*)pdmBuf, n);
  int samples = n / 2;
  int32_t sumSq = 0;
  for (int i = 0; i < samples; i++) {
    int32_t s = pdmBuf[i];
    sumSq += s * s;
  }
  pdmSquareSum   += sumSq;
  pdmSampleCount += samples;
}

/* Cached init state — printed in loop() until USB monitor connects. */
static uint8_t g_whoami = 0;
static bool    g_pdmOk = false;

/* ---------- Setup ---------- */
void setup() {
  Serial.begin(115200);
  // Wait up to 5 sec for USB monitor to attach. Bail out if it doesn't.
  uint32_t t0 = millis();
  while (!Serial && (millis() - t0) < 5000) delay(50);

  Serial.println();
  Serial.println("=== IMU + PDM Test ===");

  // Power the IMU. On XIAO nRF52840 Sense, P1.08 (Arduino pin 15) is the 6D_PWR
  // switch. Some units enable HIGH, some LOW — we try both.
  pinMode(PIN_LSM6DS3TR_C_POWER, OUTPUT);
  Wire1.begin();
  delay(20);

  // Try HIGH → probe both addresses; then LOW → probe both.
  const uint8_t polarities[2] = {HIGH, LOW};
  const uint8_t addrs[2]      = {0x6A, 0x6B};
  for (int p = 0; p < 2 && g_whoami == 0; p++) {
    digitalWrite(PIN_LSM6DS3TR_C_POWER, polarities[p]);
    delay(100);
    for (int a = 0; a < 2; a++) {
      LSM_ADDR = addrs[a];
      uint8_t w = lsmRead(REG_WHO_AM_I);
      Serial.print("Probe pwr="); Serial.print(polarities[p]);
      Serial.print(" addr=0x"); Serial.print(addrs[a], HEX);
      Serial.print(" -> 0x"); Serial.println(w, HEX);
      if (w == 0x6A || w == 0x69) {
        g_whoami = w;
        goto imu_found;
      }
    }
  }
imu_found:
  if (g_whoami) {
    lsmWrite(REG_CTRL1_XL, 0x20);  // 26 Hz, +/-2g
  }

  // Start PDM mic (1 channel, 16 kHz)
  PDM.onReceive(onPdmData);
  g_pdmOk = PDM.begin(1, 16000);
  if (g_pdmOk) PDM.setGain(80);   // Higher gain — was 30, too quiet

  Serial.print("PDM ok=");
  Serial.println(g_pdmOk ? "yes" : "no");
  Serial.println("Walk to see steps climb. Talk / clap to see mic RMS.");
}

/* ---------- Loop ---------- */
static uint32_t lastPrintMs = 0;

void loop() {
  int16_t ax, ay, az;
  lsmReadAccel(ax, ay, az);

  // Convert to g (FS=2g -> 16384 LSB/g on LSM6DS3)
  float gx = ax / 16384.0f;
  float gy = ay / 16384.0f;
  float gz = az / 16384.0f;
  float mag = sqrtf(gx*gx + gy*gy + gz*gz);

  // Running average as gravity baseline
  magEma = magEma * 0.95f + mag * 0.05f;
  float dev = mag - magEma;
  uint32_t now = millis();

  if (dev > STEP_THRESHOLD_G && !abovePeak && (now - lastStepMs) > STEP_DEBOUNCE_MS) {
    abovePeak = true;
    stepCount++;
    lastStepMs = now;
  } else if (dev < STEP_THRESHOLD_G * 0.5f) {
    abovePeak = false;
  }

  // Print at 2 Hz (slower = cleaner USB output)
  if (now - lastPrintMs >= 500) {
    lastPrintMs = now;

    noInterrupts();
    int32_t sq  = pdmSquareSum;
    int     cnt = pdmSampleCount;
    pdmSquareSum   = 0;
    pdmSampleCount = 0;
    interrupts();

    int micRms = 0;
    if (cnt > 0) micRms = (int)sqrtf((float)sq / cnt);

    char line[160];
    snprintf(line, sizeof(line),
             "who=0x%02X pdm=%d | steps=%lu | ax=%+.2f ay=%+.2f az=%+.2f |g|=%.2f | mic=%d",
             g_whoami, g_pdmOk ? 1 : 0,
             (unsigned long)stepCount, gx, gy, gz, mag, micRms);
    Serial.println(line);
  }

  delay(38);  // ~26 Hz sample rate
}

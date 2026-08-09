// ============================================================
//  IMU + PDM hardware test for XIAO nRF52840 Sense
//
//  Uses Seeed's official LSM6DS3 driver (handles the power-gate
//  sequence + Wire1 init specific to the XIAO Sense automatically).
//
//  Walk around → step counter climbs (magnitude threshold).
//  Say something / clap → mic RMS spikes.
// ============================================================

#include <Adafruit_TinyUSB.h>
#include <Arduino.h>
#include <LSM6DS3.h>
#include <PDM.h>
#include <math.h>

/* Seeed LSM6DS3 lib picks the right bus + power gate for XIAO Sense. */
static LSM6DS3 imu(I2C_MODE, 0x6A);
static bool    g_imuOk = false;
static bool    g_pdmOk = false;

/* ---------- Step detection ---------- */
static uint32_t stepCount = 0;
static float    magEma    = 1.0f;
static bool     abovePeak = false;
static uint32_t lastStepMs = 0;
static const float STEP_THRESHOLD_G = 0.25f;
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

/* ---------- Setup ---------- */
void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && (millis() - t0) < 5000) delay(50);

  Serial.println();
  Serial.println("=== IMU + PDM Test (Seeed LSM6DS3 driver) ===");

  // Seeed LSM6DS3 lib powers up the IMU and initializes Wire1 internally.
  g_imuOk = (imu.begin() == 0);
  Serial.print("IMU init: "); Serial.println(g_imuOk ? "OK" : "FAILED");

  // Start PDM mic (1 channel, 16 kHz)
  PDM.onReceive(onPdmData);
  g_pdmOk = PDM.begin(1, 16000);
  if (g_pdmOk) PDM.setGain(80);

  Serial.print("PDM init: "); Serial.println(g_pdmOk ? "OK" : "FAILED");
  Serial.println("Walk to see steps climb. Talk / clap to see mic RMS.");
  Serial.println();
}

/* ---------- Loop ---------- */
static uint32_t lastPrintMs = 0;

void loop() {
  float gx = 0, gy = 0, gz = 0;
  if (g_imuOk) {
    gx = imu.readFloatAccelX();
    gy = imu.readFloatAccelY();
    gz = imu.readFloatAccelZ();
  }
  float mag = sqrtf(gx*gx + gy*gy + gz*gz);

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
             "imu=%d pdm=%d | steps=%lu | ax=%+.2f ay=%+.2f az=%+.2f |g|=%.2f | mic=%d",
             g_imuOk ? 1 : 0, g_pdmOk ? 1 : 0,
             (unsigned long)stepCount, gx, gy, gz, mag, micRms);
    Serial.println(line);
  }

  delay(38);
}

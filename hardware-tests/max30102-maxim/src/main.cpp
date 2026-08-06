// MAX30102 HR + SpO2 using Maxim's official RD117 algorithm
//
// Hardware:
//   XIAO ESP32-C3
//   MAX30102 PPG breakout
//
// Wiring: same as max30102 test — VIN→3V3, GND→GND, SDA→D4, SCL→D5
//
// Algorithm:
//   - Maxim's reference SpO2 algorithm (spo2_algorithm.cpp, bundled with SparkFun lib)
//   - Configures sensor: 100Hz sample rate, 4× averaging → 25 effective sps
//   - Buffers 100 samples (4 seconds) of red + IR
//   - Recomputes HR and SpO2 every 1 second using a sliding window
//     (drop oldest 25, append newest 25, recompute)
//   - Returns validity flag — knows when the reading is junk (no finger, motion, etc.)
//
// Expected to be more robust than the PBA peak-detection algorithm in `max30102/`,
// especially under motion. Also provides SpO2 (oxygen saturation) which PBA does not.

#include <Arduino.h>
#include <Wire.h>
#include "MAX30105.h"
#include "spo2_algorithm.h"

MAX30105 sensor;

uint32_t irBuffer[100];
uint32_t redBuffer[100];
int32_t  bufferLength;
int32_t  spo2;
int8_t   validSPO2;
int32_t  heartRate;
int8_t   validHeartRate;

void setup() {
  Serial.begin(115200);
  delay(2000);

  Serial.println();
  Serial.println("==== MAX30102 — Maxim RD117 algorithm ====");

  Wire.begin(6, 7);
  Wire.setClock(100000);  // slow & robust — 400kHz fails on marginal wiring

  if (!sensor.begin(Wire, I2C_SPEED_STANDARD)) {
    Serial.println("MAX30102 not found!");
    while (1) delay(1000);
  }
  Serial.println("Sensor OK.");

  // Configure for HR + SpO2 mode at 25 effective sps (100Hz / 4-avg)
  byte ledBrightness = 60;   // 0-255 → 0-50 mA. 60 = ~12mA, standard for fingertip
  byte sampleAverage = 4;    // hardware averaging
  byte ledMode       = 2;    // 1=Red only, 2=Red+IR (HR+SpO2), 3=Red+IR+Green
  byte sampleRate    = 100;  // Hz before averaging
  int  pulseWidth    = 411;  // longer = more sensitive, ~411µs gives 18-bit resolution
  int  adcRange      = 4096; // ADC full-scale

  sensor.setup(ledBrightness, sampleAverage, ledMode, sampleRate, pulseWidth, adcRange);

  Serial.println("Place finger or hold sensor against skin.");
  Serial.println("First reading takes 4 seconds; updates every 1 second after.");
  Serial.println();
}

void loop() {
  bufferLength = 100;  // 100 samples = 4 seconds at 25 sps

  // Fill the buffer initially
  for (int i = 0; i < bufferLength; i++) {
    while (!sensor.available()) sensor.check();
    redBuffer[i] = sensor.getRed();
    irBuffer[i]  = sensor.getIR();
    sensor.nextSample();
  }

  // First HR+SpO2 calc on the 4-second window
  maxim_heart_rate_and_oxygen_saturation(
    irBuffer, bufferLength, redBuffer,
    &spo2, &validSPO2, &heartRate, &validHeartRate
  );

  // Now: continuous mode, sliding window of 100 samples, recompute every 25 new samples (~1s)
  while (1) {
    // Shift the most-recent 75 samples to the front
    for (int i = 25; i < 100; i++) {
      redBuffer[i - 25] = redBuffer[i];
      irBuffer[i - 25]  = irBuffer[i];
    }
    // Collect 25 new samples into the tail
    for (int i = 75; i < 100; i++) {
      while (!sensor.available()) sensor.check();
      redBuffer[i] = sensor.getRed();
      irBuffer[i]  = sensor.getIR();
      sensor.nextSample();
    }

    // Recompute
    maxim_heart_rate_and_oxygen_saturation(
      irBuffer, bufferLength, redBuffer,
      &spo2, &validSPO2, &heartRate, &validHeartRate
    );

    // Report
    Serial.printf("HR=%3ld bpm (valid=%d)  |  SpO2=%3ld %% (valid=%d)  |  IR=%lu\n",
                  (long)heartRate, validHeartRate,
                  (long)spo2, validSPO2,
                  (unsigned long)irBuffer[99]);
  }
}

// MAX30102 HR + SpO2 using aromring's improved algorithm
//
// Hardware:
//   XIAO ESP32-C3 + MAX30102 PPG breakout (same wiring as the other tests)
//
// Algorithm:
//   Robert Fraczkiewicz's "RF" algorithm (algorithm_by_RF.cpp/h).
//   Uses linear regression + autocorrelation instead of simple peak detection.
//   Designed to fix the dicrotic-notch doubling bug in Maxim's stock algorithm.
//
//   Buffer: 100 samples (4s at 25 Hz)
//   Recompute: every 1 second (slide window by 25 samples)
//   Output: HR (int BPM), SpO2 (float %), validity flags, ratio, correlation
//
// We use SparkFun's I2C driver to talk to the chip (proven to work) but
// the RF algorithm to crunch the numbers.

#include <Arduino.h>
#include <Wire.h>
#include "MAX30105.h"
#include "algorithm_by_RF.h"

MAX30105 sensor;

uint32_t irBuffer[BUFFER_SIZE];    // BUFFER_SIZE = 100
uint32_t redBuffer[BUFFER_SIZE];

float    spo2;
int8_t   validSPO2;
int32_t  heartRate;
int8_t   validHR;
float    ratio, correl;

void setup() {
  Serial.begin(115200);
  delay(2000);

  Serial.println();
  Serial.println("==== MAX30102 — aromring RF algorithm ====");

  Wire.begin(6, 7);
  Wire.setClock(100000);

  if (!sensor.begin(Wire, I2C_SPEED_STANDARD)) {
    Serial.println("MAX30102 not found!");
    while (1) delay(1000);
  }
  Serial.println("Sensor OK.");

  // Same config as Maxim test — 100 Hz × 4-avg = 25 Hz effective, matches algorithm FS
  byte ledBrightness = 60;
  byte sampleAverage = 4;
  byte ledMode       = 2;
  byte sampleRate    = 100;
  int  pulseWidth    = 411;
  int  adcRange      = 4096;
  sensor.setup(ledBrightness, sampleAverage, ledMode, sampleRate, pulseWidth, adcRange);

  Serial.println();
  Serial.println("Place finger / contact site. First reading in ~4 sec.");
  Serial.println();
}

void loop() {
  // Initial fill: 100 samples = 4 seconds
  for (int i = 0; i < BUFFER_SIZE; i++) {
    while (!sensor.available()) sensor.check();
    redBuffer[i] = sensor.getRed();
    irBuffer[i]  = sensor.getIR();
    sensor.nextSample();
  }

  rf_heart_rate_and_oxygen_saturation(
    irBuffer, BUFFER_SIZE, redBuffer,
    &spo2, &validSPO2, &heartRate, &validHR,
    &ratio, &correl
  );

  // Sliding-window updates: 25 new samples (~1s) per refresh
  while (1) {
    for (int i = 25; i < BUFFER_SIZE; i++) {
      redBuffer[i - 25] = redBuffer[i];
      irBuffer[i - 25]  = irBuffer[i];
    }
    for (int i = BUFFER_SIZE - 25; i < BUFFER_SIZE; i++) {
      while (!sensor.available()) sensor.check();
      redBuffer[i] = sensor.getRed();
      irBuffer[i]  = sensor.getIR();
      sensor.nextSample();
    }

    rf_heart_rate_and_oxygen_saturation(
      irBuffer, BUFFER_SIZE, redBuffer,
      &spo2, &validSPO2, &heartRate, &validHR,
      &ratio, &correl
    );

    Serial.printf("HR=%3ld bpm (v=%d) | SpO2=%5.1f %% (v=%d) | corr=%.2f | IR=%lu\n",
                  (long)heartRate, validHR,
                  spo2, validSPO2,
                  correl,
                  (unsigned long)irBuffer[BUFFER_SIZE - 1]);
  }
}

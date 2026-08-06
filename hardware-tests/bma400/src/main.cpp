// BMA400 step counter + activity recognition — validated bench test
//
// Hardware:
//   XIAO ESP32-C3
//   BMA400 breakout (SparkFun-style with Qwiic JST or pin headers)
//
// Wiring (I2C):
//   BMA400 3V3 -> XIAO 3V3
//   BMA400 GND -> XIAO GND
//   BMA400 SDA -> XIAO D4 (GPIO 6)
//   BMA400 SCL -> XIAO D5 (GPIO 7)
//   BMA400 CS  -> XIAO 3V3 (tie HIGH to force I2C mode; not needed if using Qwiic JST)
//   BMA400 ADR -> floating (defaults to 0x14) or GND
//
// Validated 2026-06-15: 32 steps detected in 30 seconds of walking. Activity correctly
// reports "walking" / "still" / "running".
//
// Notes:
//   - Step counter requires explicit enable via enableInterrupt(BMA400_STEP_COUNTER_INT_EN).
//     Setting BMA400_UNMAP_INT_PIN means we don't use a hardware interrupt pin; we poll instead.
//   - First ~5-7 steps after walking starts are silent — the chip "locks on" to the
//     walking pattern before reporting. This is normal Bosch behavior.
//   - Step count is cumulative; resets only on soft reset / power cycle.

#include <Arduino.h>
#include <Wire.h>
#include "SparkFun_BMA400_Arduino_Library.h"

BMA400 accel;

void setup() {
  Serial.begin(115200);
  delay(2000);

  Serial.println();
  Serial.println("==== BMA400 Step Counter ====");

  Wire.begin(6, 7);
  Wire.setClock(100000);  // 100kHz — robust, BMA400 supports up to 1MHz

  while (accel.beginI2C(0x14) != BMA400_OK) {
    Serial.println("BMA400 not found, retrying...");
    delay(1000);
  }
  Serial.println("BMA400 connected.");

  accel.setMode(BMA400_MODE_NORMAL);
  delay(100);

  // Step counter must be explicitly enabled even when polling (no hardware interrupt pin)
  bma400_step_int_conf config = { .int_chan = BMA400_UNMAP_INT_PIN };
  accel.setStepCounterInterrupt(&config);
  accel.enableInterrupt(BMA400_STEP_COUNTER_INT_EN, true);

  Serial.println("Step counter enabled. Walk to begin counting.");
  Serial.println();
}

void loop() {
  uint32_t steps = 0;
  uint8_t activity = 0;

  if (accel.getStepCount(&steps, &activity) == BMA400_OK) {
    const char* actStr = "?";
    switch (activity) {
      case BMA400_STILL_ACT: actStr = "still";   break;
      case BMA400_WALK_ACT:  actStr = "walking"; break;
      case BMA400_RUN_ACT:   actStr = "running"; break;
    }
    Serial.printf("Steps: %lu   |   Activity: %s\n", (unsigned long)steps, actStr);
  }

  delay(500);
}

// MAX30102 heart rate measurement using SparkFun's PBA peak-detection algorithm
//
// Hardware:
//   XIAO ESP32-C3
//   MAX30102 PPG breakout (green PCB, "GY-MAX30102" style)
//
// Wiring (I2C):
//   MAX30102 VIN -> XIAO 3V3
//   MAX30102 GND -> XIAO GND
//   MAX30102 SDA -> XIAO D4 (GPIO 6)
//   MAX30102 SCL -> XIAO D5 (GPIO 7)
//   MAX30102 INT, IRD, RD -> not connected
//
// Validated 2026-06-15:
//   - Fingertip: clean PPG signal, baseline IR ~196k vs ~1.3k open air (150x)
//   - Bare chest (taped flat): elevated walking BPM (~95-115) vs resting (~70-75)
//   - Algorithm: SparkFun PBA (peak-and-beat-average) — adequate at rest, noisy under motion
//
// Known limitations:
//   - PBA algorithm has poor motion artifact rejection. For production use,
//     swap to Maxim's official RD117 algorithm (handles SpO2 too).
//   - Chest signal noisier than fingertip — wasn't the chip's design target.
//   - Continuous mode draws ~600µA-2mA on LEDs; use on-demand sampling for wearables.

#include <Arduino.h>
#include <Wire.h>
#include "MAX30105.h"      // SparkFun library — MAX30105/MAX30102 share the API
#include "heartRate.h"     // PBA peak detection

MAX30105 sensor;

const byte RATE_SIZE = 8;
byte rates[RATE_SIZE];
byte rateSpot = 0;
long lastBeat = 0;
float beatsPerMinute = 0;
int beatAvg = 0;
int beatCount = 0;

void setup() {
  Serial.begin(115200);
  delay(2000);

  Serial.println();
  Serial.println("==== MAX30102 BPM Test ====");

  Wire.begin(6, 7);
  Wire.setClock(400000);

  if (!sensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("MAX30102 not found!");
    while (1) delay(1000);
  }
  Serial.println("MAX30102 connected.");

  sensor.setup();
  sensor.setPulseAmplitudeRed(0x0A);   // dim red — we mostly need IR for HR
  sensor.setPulseAmplitudeIR(0x40);    // brighter IR for stronger PPG signal

  Serial.println();
  Serial.println("Place finger on dark window. Stay still ~15-20s for BPM to stabilize.");
  Serial.println();
}

void loop() {
  long ir = sensor.getIR();

  if (checkForBeat(ir)) {
    long delta = millis() - lastBeat;
    lastBeat = millis();

    beatsPerMinute = 60.0 / (delta / 1000.0);

    if (beatsPerMinute > 30 && beatsPerMinute < 220) {
      rates[rateSpot++] = (byte)beatsPerMinute;
      rateSpot %= RATE_SIZE;
      beatCount++;

      int sum = 0;
      int n = beatCount < RATE_SIZE ? beatCount : RATE_SIZE;
      for (int i = 0; i < n; i++) sum += rates[i];
      beatAvg = sum / n;

      Serial.printf("Beat #%-3d  instant=%5.1f BPM  averaged=%3d BPM\n",
                    beatCount, beatsPerMinute, beatAvg);
    }
  }

  static uint32_t lastStatus = 0;
  if (millis() - lastStatus > 2000) {
    lastStatus = millis();
    if (ir < 50000) Serial.println("(no finger / contact lost)");
  }
}

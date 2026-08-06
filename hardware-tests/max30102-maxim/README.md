# MAX30102 — Maxim RD117 Algorithm

Same sensor as `max30102/`, but uses **Maxim's official reference algorithm** instead of SparkFun's simpler PBA peak-detection. More robust under motion, and computes both HR + **SpO2**.

## Wiring

| MAX30102 pin | XIAO ESP32-C3 |
|---|---|
| VIN | 3V3 |
| GND | GND |
| SDA | D4 (GPIO 6) |
| SCL | D5 (GPIO 7) |

Same as the basic `max30102/` test.

## Run

```sh
pio run -t upload
pio device monitor
```

## How it works

- Sensor configured at 100 Hz × 4-average = **25 effective samples/sec**
- Collects a **100-sample (4-second)** buffer of red + IR
- Calls `maxim_heart_rate_and_oxygen_saturation()` — Maxim's reference algorithm
- After initial 4s warmup, recomputes every 1 second using a sliding window
- Returns separate **validity flags** — when the signal is too noisy or no contact, validity = 0

## Expected output

```
HR= 72 bpm (valid=1)  |  SpO2= 98 %% (valid=1)  |  IR=196243
HR= 71 bpm (valid=1)  |  SpO2= 97 %% (valid=1)  |  IR=196401
...
```

`valid=0` means the algorithm rejected the sample — useful for filtering bad data in your app.

## Why this is better than PBA (`max30102/`)

| Metric | PBA (heartRate.h) | Maxim RD117 (spo2_algorithm.h) |
|---|---|---|
| Detection | Peak-per-sample | 4-second FIR-filtered window |
| BPM stability under motion | Poor (instant BPM 30-200 range) | Better — algorithm rejects noisy windows |
| SpO2 | ❌ Not supported | ✅ Yes (via red/IR ratio) |
| Validity signal | ❌ | ✅ Per-reading boolean |
| Update rate | Every detected beat | Every 1 second (smooth) |
| CPU load | Very low | Moderate (FIR filter + peak find on 100 samples) |
| Use case | Fingertip, mostly still | Production wearable, motion-tolerant |

## When to choose which

- **PBA (`max30102/`)** → simplest, fastest visual feedback, fingertip use
- **Maxim RD117 (this folder)** → production firmware, SpO2 needed, motion expected (chest position during walking)

For the badge product, this Maxim implementation is the foundation to build on.

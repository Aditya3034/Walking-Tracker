# MAX30102 — aromring RF Algorithm

Third (and best) HR algorithm test. Uses Robert Fraczkiewicz's "RF" algorithm from [`aromring/MAX30102_by_RF`](https://github.com/aromring/MAX30102_by_RF), an open-source improvement over Maxim's reference algorithm.

## Why this exists

Earlier tests showed:
- **PBA (`max30102/`):** accurate HR (~80 BPM resting) but noisy, no SpO2
- **Maxim RD117 (`max30102-maxim/`):** great SpO2 but **HR doubled** (160 instead of 80) due to dicrotic-notch confusion

The RF algorithm fixes the doubling bug using:
- **Linear regression** to estimate baseline before peak detection
- **Autocorrelation** for period estimation — robust to dicrotic notch
- **Quality scoring** via correlation coefficient (0.0–1.0)

## Wiring

| MAX30102 pin | XIAO ESP32-C3 |
|---|---|
| VIN | 3V3 |
| GND | GND |
| SDA | D4 (GPIO 6) |
| SCL | D5 (GPIO 7) |

## Run

```sh
pio run -t upload
pio device monitor
```

## Expected output

```
HR= 78 bpm (v=1) | SpO2= 98.5 % (v=1) | corr=0.92 | IR=226411
HR= 79 bpm (v=1) | SpO2= 98.3 % (v=1) | corr=0.94 | IR=226203
...
```

- `corr` is the autocorrelation strength of the IR signal — >0.7 means a clean periodic heartbeat. Below ~0.5 means too much noise / motion.
- Use `corr` as your real-time quality indicator in production firmware.

## Files

- `src/algorithm_by_RF.cpp/.h` — vendored from aromring's repo (no PIO library available)
- `src/main.cpp` — uses SparkFun's MAX30102 I²C driver + aromring's algorithm

## Comparison vs other algorithms

| Test folder | Algorithm | HR accuracy | SpO2 | Motion handling | Notes |
|---|---|---|---|---|---|
| `max30102/` | SparkFun PBA (peak detection) | ✅ accurate but noisy | ❌ none | poor | Simplest, good for fingertip |
| `max30102-maxim/` | Maxim RD117 (FIR + threshold) | ❌ doubled at fingertip | ✅ accurate | moderate | Bug: dicrotic notch counted as separate beat |
| `max30102-aromring/` (this) | aromring RF (regression + autocorrelation) | ✅ accurate | ✅ accurate | best | Production-grade. **Use this for the badge.** |

## Tuning

`algorithm_by_RF.h` defines:
- `FS = 25` — sample rate. Must match the sensor's effective sample rate.
- `ST = 4` — buffer duration in seconds. If changed, also update `sum_X2` in the header.
- `MIN_HR = 40`, `MAX_HR = 180` — clamp range. Below 40 or above 180 returns invalid.

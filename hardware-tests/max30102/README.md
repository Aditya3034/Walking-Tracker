# MAX30102 — Heart Rate Test

Bench test of the MAX30102 PPG sensor for heart rate detection, paired with an XIAO ESP32-C3.

## Wiring

| MAX30102 pin | XIAO ESP32-C3 |
|---|---|
| VIN | 3V3 |
| GND | GND |
| SDA | D4 (GPIO 6) |
| SCL | D5 (GPIO 7) |
| INT, IRD, RD | not connected |

I²C address: `0x57`. Compatible with ESP32 at 3.3V directly (SDA/SCL tolerate up to 3.6V per datasheet).

## Run

```sh
pio run -t upload
pio device monitor
```

Place finger lightly on the dark window. Stay still ~15-20 seconds for BPM to stabilize.

## Expected output

```
Beat #1    instant=72.7 BPM  averaged= 72 BPM
Beat #2    instant=78.5 BPM  averaged= 75 BPM
...
Beat #20   instant=74.8 BPM  averaged= 73 BPM
```

## Validated

2026-06-15:
- **Fingertip:** clean PPG signal, baseline IR ~196k vs ~1.3k in open air (150× difference confirms skin contact)
- **Bare chest (taped):** resting ~70-75 BPM, walking ~95-115 BPM. Correct physiological elevation, but noisier signal.

## Known limitations of the current PBA algorithm

The SparkFun library uses a simple peak-detection (PBA = Peripheral Beat Amplitude) algorithm. Adequate at rest, but:

- Poor motion artifact rejection — instant BPM jitters 30-200 during walking
- No SpO2 calculation
- No signal quality metric

## Next: switch to Maxim's RD117 algorithm

Maxim publishes a reference algorithm that handles:
- Better motion artifact rejection
- True SpO2 calculation from red/IR ratio
- Quality scoring

Implementation: replace `checkForBeat(ir)` calls with periodic batch processing of 100 sample buffers through `maxim_heart_rate_and_oxygen_saturation()`.

## Power notes

- Continuous sampling at default rate: ~600 µA - 2 mA average (LEDs)
- For wearables: power down between readings. Sample for 15 sec on demand → sleep
- 100 mAh battery → ~50-100 readings per day comfortably

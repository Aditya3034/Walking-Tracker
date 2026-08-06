# BMA400 — Step Counter Test

Bench test of the Bosch BMA400 accelerometer's on-chip step counter, paired with an XIAO ESP32-C3.

## Wiring

| BMA400 pin | XIAO ESP32-C3 |
|---|---|
| 3V3 | 3V3 |
| GND | GND |
| SDA | D4 (GPIO 6) |
| SCL | D5 (GPIO 7) |
| CS | 3V3 (tie HIGH for I²C mode; skip if using Qwiic JST connector) |
| ADR | floating or GND → address `0x14` |

If using the Qwiic JST connector, ignore CS and ADR — handled internally on the breakout.

## Run

```sh
pio run -t upload
pio device monitor
```

## Expected output

After walking for ~10 seconds (the BMA400 needs a "lock-on" period to confirm walking pattern):

```
Steps: 0   |   Activity: still
Steps: 7   |   Activity: walking
Steps: 9   |   Activity: walking
Steps: 11   |   Activity: walking
...
```

## Validated

2026-06-15 — 32 steps detected in 30 seconds of walking. Activity correctly reports `walking` / `still` / `running`. Step accuracy at chest position estimated ~90-95%.

## Notes

- Step counter must be explicitly enabled via `enableInterrupt(BMA400_STEP_COUNTER_INT_EN)`. The chip won't count without this.
- First ~5-7 steps after walking starts are silent — the chip "locks on" to the walking pattern before reporting. Normal Bosch behavior.
- Cumulative count; resets only on soft reset / power cycle.
- Low power: BMA400 idle ~14 µA at 12.5 Hz ODR.

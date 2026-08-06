# nRF52840 firmware — softwear.pet

Successor firmware to [`esp32c3/`](../esp32c3/), targeting the **Seeed XIAO nRF52840 Sense**.

## Why this migration

The XIAO ESP32-C3 works but has poor power efficiency for wearables (~22 hours per 800 mAh charge). The nRF52840 chip is designed for battery-powered BLE devices — same code with the same optimizations should hit 3-6 days per charge.

See [TECHNICAL.md §11.14](../TECHNICAL.md#1114-wristband-variant-alternative-v2-form-factor) for the full rationale.

## Board

- **Seeed XIAO nRF52840 Sense** — nRF52840 chip + onboard LSM6DS3TR-C IMU + PDM microphone
- Same 21 × 17.8mm form factor as XIAO ESP32-C3 (drop-in physical replacement)
- Framework: Arduino via Adafruit's nRF52 core

## Build environments

```sh
pio run -e dev -t upload         # USB CDC on, Serial.println works, +10-15 mA
pio run -e battery -t upload     # USB CDC off, silent, production-ready
```

If auto-flash fails (common on first flash after switching modes):
1. **Double-tap RESET** — enters UF2 bootloader, board appears as a USB mass storage drive
2. Or hold BOOT + press RESET + release BOOT
3. Re-run `pio run -t upload`

## Current status

**Toolchain bringup phase.** The firmware in [`src/main.cpp`](src/main.cpp) is a minimal blink + serial test to verify:
- ✅ Adafruit nRF52 core installed correctly
- ✅ PlatformIO can compile for this board
- ✅ Board flashes without errors
- ✅ LED responds to `digitalWrite`
- ✅ Serial output works in dev build

Once bringup passes, we port the following from `esp32c3/`:

| Feature | Portability | Notes |
|---|---|---|
| OLED via u8g2 | ✅ Direct port | Library is platform-agnostic |
| Pet mood state machine | ✅ Direct port | Pure logic — no chip-specific calls |
| Eye animations | ✅ Direct port | Same math + u8g2 rendering |
| BLE (advertise + GATT server + notify) | ⚠️ **Rewrite required** | ESP32 uses `BLEDevice`; nRF52 uses `Bluefruit` from Adafruit_nRFCrypto lib. Same UUIDs, same protocol, different API surface |
| Persistence (elapsed hunger time) | ⚠️ Small change | `Preferences` (ESP32) → `InternalFS` or LittleFS (nRF52) |
| `setCpuFrequencyMhz(80)` | ⚠️ Not applicable | nRF52 handles frequency differently — remove call |
| `esp_ble_gap_update_conn_params` | ⚠️ Different API | `Bluefruit.Periph.setConnInterval(min, max)` on nRF52 |
| Auto-restart advertising on disconnect | ✅ Direct port | Bluefruit has equivalent callbacks |

## BLE interface — must remain identical to ESP32-C3

**Critical for app compatibility.** The app doesn't know or care which chip is inside; it only sees BLE UUIDs and data.

| BLE identifier | Value — MUST NOT CHANGE |
|---|---|
| Service UUID | `4fafc201-1fb5-459e-8fcc-c5c9c331914b` |
| WRITE characteristic | `beb5483e-36e1-4688-b7f5-ea07361b26a8` |
| NOTIFY characteristic | `beb5483e-36e1-4688-b7f5-ea07361b26a9` |
| READ Pet ID | `beb5483e-36e1-4688-b7f5-ea07361b26aa` |
| READ device type | `beb5483e-36e1-4688-b7f5-ea07361b26ab` |
| Command strings | `FEED`, `CONNECTED`, `NAME:<name>` |
| Notify payloads | `NORMAL`, `HUNGRY`, `STARVING`, `FEEDING` |

Any drift from these breaks the app's ability to talk to the pet.

## What NOT to change during the port

- Pet ID format (`KOS` + 6 digits)
- Device type strings (`badge` / `necklace`)
- OLED eye rendering (visual continuity)
- Hunger interval + starving interval defaults (2 hrs / 30 min)
- Hunger elapsed time persistence semantics

## Wiring (unchanged from ESP32-C3)

The XIAO nRF52840 Sense has the same pinout as the XIAO ESP32-C3. All the wiring in [TECHNICAL.md §14](../TECHNICAL.md#14-hardware-wiring-reference) applies exactly as-is:

- OLED VCC → 3V3
- OLED GND → GND
- OLED SDA → D4 (default I²C SDA on nRF52)
- OLED SCL → D5 (default I²C SCL on nRF52)
- TP4056 OUT+ → VUSB
- TP4056 OUT- → GND
- Power switch inline with VUSB

Note: on nRF52 Arduino core, use `Wire.begin()` with no arguments — default pins are already D4/D5.

## Next steps

1. **Flash blink test** to verify toolchain and hardware
2. **Port OLED code** — easiest port (u8g2 works identically)
3. **Port BLE code** — biggest chunk of work (~4-8 hours)
4. **Port persistence** — small library swap
5. **Port hunger logic + eyes** — trivial once OLED works
6. **Battery-life test** — should hit 3-6 days on 800 mAh

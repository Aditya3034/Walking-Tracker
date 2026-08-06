# Hardware tests

Standalone PlatformIO sketches used to bench-test each sensor in isolation before integrating them into the main badge firmware.

Both sensors target the XIAO ESP32-C3 and share the same I²C bus (SDA = GPIO 6, SCL = GPIO 7). The full badge firmware will combine them.

## Sensors

| Folder | Sensor | Status | Purpose in badge |
|---|---|---|---|
| [bma400/](bma400/) | Bosch BMA400 accelerometer | ✅ Validated | On-device step counting + activity recognition |
| [max30102/](max30102/) | Maxim MAX30102 PPG sensor | ✅ Validated (chest position) | Heart rate (and SpO2 in future) via magnetic back plate |

## Validation summary (2026-06-15)

- **BMA400:** 32 steps detected in 30s of walking with breakout in hand. Activity correctly reports `walking` / `still`.
- **MAX30102:** Fingertip clean PPG signal. Chest position correctly detects resting HR (~70-75 BPM) vs walking HR (~95-115 BPM). Current algorithm is noisy under motion — see roadmap below.

## Next

1. **Algorithm upgrade** — port Maxim's official RD117 algorithm into the MAX30102 sketch. Handles motion artifacts + adds SpO2.
2. **Combined sketch** — both sensors on the same bus, both reading simultaneously. Verify no I²C address conflicts (`0x14` vs `0x57`).
3. **Sensor fusion** — feed BMA400 motion data into the HR algorithm for active rejection during walking.
4. **BLE integration** — expose step count + HR/SpO2 over the badge's existing BLE service.

## Related

- Main badge firmware: [../esp32/](../esp32/) and [../esp32c3/](../esp32c3/)
- Hardware roadmap: [../TECHNICAL.md](../TECHNICAL.md) § 11

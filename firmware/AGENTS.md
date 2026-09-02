# Firmware — Agent Instructions

Extends the root `AGENTS.md`. These rules apply when working inside the `firmware/` folder.

## Stack
- Language: C++ (Arduino framework)
- Platform: PlatformIO, target board `adafruit_feather_esp32_v2`
- Key libraries: `ESP32Servo`, `Adafruit GFX`, `Adafruit SSD1306`, `NimBLE-Arduino`

## File Header Convention
Add this header at the top of every new `.cpp` or `.h` file:

```cpp
/*
 * <filename>
 * Project: Colloquy of Mobiles Virtual Simulation — Phygital
 * Author: Thomas J McLeish
 * License: MIT
 *
 * Prototype firmware module.
 */
```

## Commenting Convention (Prototype Mode)
- Comment verbosely enough that wiring assumptions, mapping math, and protocol behavior are obvious.
- Add comments before non-trivial logic blocks.
- Keep comments current when behavior changes.
- Explain "why" and hardware assumptions, not only "what".
- When possible, phrase comments so non-programmers can infer system behavior.

## Documentation Convention
- Use Doxygen-style comments (`/** ... */`) for non-trivial functions.
- Each documented function should include: purpose, parameter descriptions, return value, and side effects.
- Document units and expected ranges for constants and values where ambiguity is possible (`ms`, `usec`, `degrees`, ADC counts).
- Prefer explicit docs over minimal comments when behavior affects hardware safety.

## Firmware Development Rules
- Keep constants near the top of each file and name them clearly.
- Prefer explicit range clamps for command and actuator outputs.
- Use serial debug telemetry in early development.
- Fail safely: when invalid input arrives, ignore or clamp instead of crashing.
- Keep loop logic non-blocking.

## Hardware Reference (Current)
- Active servo model: `MG996R` (high torque, metal gear, dual ball bearing, positional).
- Datasheet snapshot stored at `firmware/docs/mg996r-servo.md`.
- `firmware/docs/ls-3006-servo-datasheet.md` describes the **superseded** LS-3006 and is kept only for history. Do not wire or calibrate from it.
- Wire mapping (MG996R standard): `Brown=GND`, `Red=V+`, `Orange=Signal`. The old `Black/Red/Yellow` mapping belonged to the LS-3006.
- Signal pin: `GPIO13` (`SERVO_PIN`). Note this is also `LED_BUILTIN` on this board, so the user LED flickers with the PWM.
- Firmware pulse configuration: `SERVO_MIN_US = 500`, `SERVO_MAX_US = 2500`, 50 Hz, angle clamp `0..180` degrees. `write(90)` / 1500 µs is neutral.
- **Open safety question:** `firmware/docs/mg996r-servo.md` records the part's full-range sweep as ~`1000..2000 usec` over ~120 degrees of travel, which is narrower than what the firmware commands. Bench-test the endpoints before treating the extremes as safe, and record the result in that document.
- `setup()` runs a full-span boot sweep (center -> min -> max -> center, ~3 s) on every reset, ignoring the calibration pot. Any change to the range or the sweep must keep that fact documented in `README.md`.
- Servo supply: `4.8 V - 7.2 V` from a dedicated supply with common ground; stall current ~`2.5 A`. Never drive from an ESP32 pin or the 3.3 V rail.
- OLED module available: `GM12864` (`SSD1306-compatible`, `128x64`, I2C).
- OLED references: `firmware/docs/gm12864-oled-module.md`, expected address `0x3C` (alternate `0x3D`).
- I2C pins come from the board variant symbols `SDA`/`SCL`, never from hard-coded GPIO numbers. On `adafruit_feather_esp32_v2` those resolve to GPIO22 and GPIO20, but code and docs should keep using the labels so the firmware ports to other boards unchanged.
- `Wire.setClock(OLED_I2C_FAST_HZ)` runs the bus at 1 MHz, above the 100/400 kHz the GM12864 notes list. It works on the bench module; suspect it first if a different panel garbles.
- Built-in NeoPixel is used as a liveness heartbeat. `PIN_NEOPIXEL` comes from the variant; `NEOPIXEL_POWER` does **not** exist in the `adafruit_feather_esp32_v2` variant (it defines `NEOPIXEL_I2C_POWER = 2`), so the local `#define NEOPIXEL_POWER 2` fallback in `main.cpp` is what takes effect. GPIO2 gates power to both the NeoPixel and the STEMMA QT I2C port.

## Serial Protocol
See the **Command And Telemetry Protocol (Shared Contract)** section in the root `AGENTS.md`. Firmware must emit telemetry and accept commands in exactly that format. Adding or renaming a telemetry key means editing three `snprintf` format strings here, the dashboard's `TELEMETRY_KEYS` whitelist, and the tables in the root `AGENTS.md` and `README.md`.

## BLE Transport
- Library: `h2zero/NimBLE-Arduino` (lighter than the default ESP32 BLE stack).
- Service: Nordic UART Service (NUS) — emulates a serial port over BLE so no protocol changes are needed.
- Device advertising name: `"Colloquy Pointer"` — used to identify the device in the Web Bluetooth picker.
- NUS Service UUID: `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`
- RX characteristic (host → device, write): `6E400002-B5A3-F393-E0A9-E50E24DCCA9E`
- TX characteristic (device → host, notify): `6E400003-B5A3-F393-E0A9-E50E24DCCA9E`
- USB serial and BLE operate simultaneously; telemetry is broadcast to both transports.
- Advertising restarts automatically on client disconnect (no power cycle needed to reconnect).
- `processIncomingCharacter(char c)` is the shared command parser — both serial and BLE RX paths call it, so command behavior is identical on both transports.

## Validation Workflow
1. Build with `pio run` from inside `firmware/`.
2. Upload with `pio run -t upload`.
3. Monitor with `pio device monitor -b 460800` (or bare `pio device monitor`; `monitor_speed = 460800` is set in both `platformio.ini` files). At 115200 the output is garbage.
4. Verify one feature at a time (servo movement, pot scaling, protocol, safety behaviors).
5. Follow the gated checkpoint ladder in `README.md` when hardware is in the loop, and keep the horn off the servo until the boot sweep has been observed as quiet at both endpoints.

# Firmware — Agent Instructions

Extends the root `AGENTS.md`. These rules apply when working inside the `firmware/` folder.

## Stack
- Language: C++ (Arduino framework)
- Platform: PlatformIO, target board `adafruit_feather_esp32_v2`
- Key libraries: `ESP32Servo`, `Adafruit GFX`, `Adafruit SSD1306`

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
- Active servo model: `LS-3006`.
- Market label may read: `Plastic Gear Analog Servo - 360`.
- Datasheet snapshot stored at `firmware/docs/ls-3006-servo-datasheet.md`.
- Control pulse baseline: `1500 usec` neutral, `800 -> 2200 usec` supported pulse width range.
- Observed wire mapping: `Black=GND`, `Red=V+`, `Yellow=Signal` (Hitec-style order).
- For prototype safety, begin with conservative firmware limits and expand only after physical validation.
- Expected electrical load can exceed `1A` near stall; ensure servo power design is adequate and grounds are common.
- Treat datasheet/label claims as provisional until bench-tested; confirm whether behavior is positional or continuous rotation.
- OLED module available: `GM12864` (`SSD1306-compatible`, `128x64`, I2C).
- OLED references: `firmware/docs/gm12864-oled-module.md`, expected address `0x3C` (alternate `0x3D`).
- For `adafruit_feather_esp32_v2`, use board I2C defaults (`SDA=22`, `SCL=20`) and prefer pin labels `SDA`/`SCL` over raw GPIO numbers in docs and code.

## Serial Protocol Guidance
- Use newline-terminated command frames for easy testing.
- During prototype stage, accept plain numeric commands first.
- Expand protocol only after baseline control path is stable.

## Validation Workflow
1. Build with `pio run` from inside `firmware/`.
2. Upload with `pio run -t upload`.
3. Monitor with `pio device monitor -b 115200`.
4. Verify one feature at a time (servo movement, pot scaling, protocol, safety behaviors).

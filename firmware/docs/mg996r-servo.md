# MG996R High Torque Metal Gear Servo - Technical Reference

Source: product datasheet and specification supplied by project owner on 2026-03-08.

## Product Overview
- Part number: `MG996R`
- Marketed name: `MG996R High Torque Metal Gear Dual Ball Bearing Servo`
- Type: Positional servo (digital control circuit, positional feedback built-in)
- Upgraded successor to the MG995; improved shock-proofing, redesigned PCB/IC

## 1. Electrical Specifications

| Parameter | At 4.8 V | At 6 V |
|---|---|---|
| Stall torque | 9.4 kgf·cm | 11 kgf·cm |
| Operating speed (no load) | 0.17 s / 60° | 0.14 s / 60° |
| Running current | 500 mA – 900 mA | 500 mA – 900 mA |
| Stall current | ~2.5 A | ~2.5 A |

- Operating voltage range: `4.8 V – 7.2 V`
- **Do not power from an ESP32 logic pin or 3.3 V rail.** Use a dedicated servo supply (5 V recommended for prototype) with a shared GND to the ESP32.
- Size a power supply or fuse to handle stall current peaks of **2.5 A**.

## 2. Mechanical Specification

- Total rotation: **~120° (±60° from center)**
- Weight: `55 g`
- Body dimensions (approx): `40.7 × 19.7 × 42.9 mm`
- Mounting width (including ears): `~53.6 mm`
- Height including horn: `~42–47 mm`
- Gear train: Metal gear, double ball bearing output shaft
- Temperature range (operating): `0 °C – 55 °C`

## 3. Control Specification

| Parameter | Value |
|---|---|
| Control type | PWM (pulse-width modulation) |
| PWM period | ~20 ms (50 Hz) |
| Neutral pulse | 1500 µs |
| Full-range pulse sweep | ~1000 µs – ~2000 µs |
| Dead band width | 5 µs |

The MG996R is a **positional** servo. Pulse width maps to absolute output shaft angle.
The internal feedback circuit holds the commanded position without continuous controller input.
No external PID or position loop is required.

## 4. Wire Colors

| Color | Function |
|---|---|
| Orange | PWM signal input |
| Red | VCC (positive supply) |
| Brown | Ground |

Connector: 3-pin S-type female header — compatible with Futaba, JR, GWS, Hitec, Spektrum, and similar RC receivers.
Cable length: `30 cm`.

## 5. Firmware Pulse Calibration (This Project)

The ESP32Servo library maps `write(0)` → `SERVO_MIN_US` and `write(180)` → `SERVO_MAX_US` using a
linear scale over the library's fixed 0–180° internal range.

To produce correct physical output from the MG996R's 120° range, the firmware uses:

```cpp
constexpr int   SERVO_MIN_US  = 1000;   // write(0)   → 1000 µs (physical 0°)
constexpr int   SERVO_MAX_US  = 2500;   // calibration anchor
constexpr float SERVO_MAX_ANGLE = 120.0f; // physical travel limit
```

**Why `SERVO_MAX_US = 2500`?**

The ESP32Servo library's interpolation formula is:

```
pulse_us = MIN_US + (angle / 180) × (MAX_US - MIN_US)
```

Setting `MAX_US = 2500` makes `write(120)` produce:

```
1000 + (120/180) × (2500 - 1000) = 1000 + 1000 = 2000 µs
```

This maps the servo's maximum mechanical travel (120°) to exactly 2000 µs —
the upper end of the standard servo duty cycle range.
Because `SERVO_MAX_ANGLE` clamps all commanded angles to 120°, the servo
never receives a pulse above 2000 µs in normal operation.

**Center position:** `write(60)` → 1500 µs (neutral).

## 6. Implementation Notes For This Project

- Servo starts at center (60°) on power-up to avoid uncontrolled startup sweep.
- Command range `-100` to `+100` maps to `0°` to `120°` via the potentiometer-scaled span.
- Pot at minimum: full 120° sweep. Pot at maximum: servo holds 60° (center).
- The `servo.write()` call is suppressed when the integer angle has not changed,
  preventing unnecessary PWM recalculation and audible buzzing.
- Stall current (2.5 A) is significantly higher than the LS-3006; verify that
  the power supply and wiring can deliver this without voltage sag that could
  reset the ESP32.

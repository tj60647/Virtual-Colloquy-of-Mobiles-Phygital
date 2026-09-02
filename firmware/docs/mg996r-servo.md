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

The ESP32Servo library maps `write(0)` → `SERVO_MIN_US` and `write(180)` → `SERVO_MAX_US`
using a linear scale over the library's fixed 0–180° internal range:

```
pulse_us = MIN_US + (angle / 180) × (MAX_US - MIN_US)
```

The firmware in `firmware/src/main.cpp` currently sets:

```cpp
constexpr int   SERVO_MIN_US    = 500;    // write(0)   → 500 µs
constexpr int   SERVO_MAX_US    = 2500;   // write(180) → 2500 µs
constexpr float SERVO_MIN_ANGLE = 0.0f;
constexpr float SERVO_MAX_ANGLE = 180.0f;
```

**Center position:** `write(90)` → 1500 µs (neutral).

The control path holds float precision all the way to the hardware boundary:
`applyServoOutput()` computes an angle, `pulseWidthFromAngle()` converts it, and
`writeMicroseconds()` is called only when the integer pulse width actually changes.

### Unresolved conflict — read before trusting the endpoints

Sections 2 and 3 above, taken from the supplied specification, describe the MG996R as
having **~120° of travel over a ~1000–2000 µs sweep**. The firmware above commands
**0–180° over 500–2500 µs**. Both statements cannot be true of the same part.

Nobody has bench-tested the endpoints and recorded the answer. Until somebody does:

- Assume the extremes of the commanded range may drive the servo into its mechanical end
  stops, where it draws stall current (~2.5 A) continuously and heats up.
- If the 1000–2000 µs figure is correct, the corresponding safe subset of the *command*
  range at full pot span is roughly **-50 to +50**:

  ```
  c = -50 → angle  45° → 500 + (45/180) × 2000  = 1000 µs
  c = +50 → angle 135° → 500 + (135/180) × 2000 = 2000 µs
  ```

- Note that the `setup()` boot sweep drives the **full** 0–180° span on every reset and
  ignores the calibration pot, so the endpoints are exercised at every power-up whether or
  not you command them.

When the bench test happens, replace this warning with the measured result: the pulse width
at each mechanical limit, and the total travel in degrees.

## 6. Implementation Notes For This Project

- The servo is moved to center (90°, 1500 µs) as soon as it is attached in `setup()`, so it
  starts from a known position while the pot filter warms up.
- `setup()` then runs a three-second boot sweep at the full span — center → min → max →
  center — before `loop()` begins. This is a deliberate travel check, not a glitch.
- Command range `-100` to `+100` maps across the potentiometer-scaled span, centered on 90°.
- Pot at minimum: full 0–180° sweep. Pot at maximum: span collapses and the servo holds 90°.
- The active range is snapped to 5° increments with 1.5° of hysteresis, so `rn`/`rx`
  telemetry steps cleanly instead of jittering. The servo angle itself is not snapped.
- The `writeMicroseconds()` call is suppressed when the pulse width has not changed,
  preventing unnecessary PWM updates and audible buzzing.
- Stall current (2.5 A) is significantly higher than the LS-3006 this project previously
  used; verify that the power supply and wiring can deliver this without voltage sag that
  could reset the ESP32.

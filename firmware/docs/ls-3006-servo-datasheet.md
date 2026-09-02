# LS-3006 Plastic Gear Analog Servo - Technical Data Sheet

> **Superseded. Do not wire or calibrate from this document.**
> This project moved to the MG996R. The current part, its wire colors
> (`Brown`/`Red`/`Orange`, not the `Black`/`Red`/`Yellow` below) and the firmware pulse
> calibration are documented in [`mg996r-servo.md`](mg996r-servo.md). This file is retained
> for history only.

Source provided by project owner on 2026-03-07.

## Product And Vendor
- Part number: `LS-3006`
- Marketed name seen on part listing: `Plastic Gear Analog Servo - 360`
- Vendor: `Leo Sales Ltd.`
- Location: `Richmond, BC, Canada`
- Support email: `support@leosales.com`

## Field Notes (Prototype)
- The provided specification may be unreliable or inconsistent.
- The part may be a Hitec-style clone based on wiring and labeling.
- Wire definitions observed on this unit:
	- `Black`: ground (`-`)
	- `Red`: supply (`+`)
	- `Yellow`: signal
- Wiring order is reported as Hitec-compatible.
- Because the label includes `360`, do not assume classic positional-servo behavior until verified on bench.

## 1. Environmental Conditions
- Storage temperature range: `-20C` to `60C`
- Operating temperature range: `-10C` to `50C`
- Operating voltage range: `4.5V` to `6.0V`

## 2. Standard Test Environment
- Temperature: `25 +/- 5C`
- Humidity: `65 +/- 10%`

## 3. Appearance Inspection
- Outline drawing reference: `40.820.138`

## 4. Electrical Performance
At 4.8V:
- Operating speed (no load): `0.14 sec / 60 deg`
- Running current (no load): `250 mA`
- Stall torque (locked): `5.5 kg-cm`
- Stall current (locked): `1.3 A`
- Idle current (stopped): `4 mA`

At 6.0V:
- Operating speed (no load): `0.12 sec / 60 deg`
- Running current (no load): `300 mA`
- Stall torque (locked): `6 kg-cm`
- Stall current (locked): `1.5 A`
- Idle current (stopped): `5 mA`

## 5. Mechanical Specification
- Overall dimensions reference: `40.820.138`
- Limit angle: `180 deg +/- 10 deg`
- Weight: `40 +/- 1 g`
- Connector wire gauge: `#28 PVC`
- Connector wire length: `300 +/- 5 mm`
- Horn gear spline: `25T / psi5.80` (recorded as provided)
- Horn types: `Cross, disc, HX HEX, Type aticle` (recorded as provided)
- Reduction ratio: `240:1`

## 6. Control Specification
- Control system: `Change pulse width`
- Amplifier type: `Analog control`
- Operating travel: `360 deg (at 1000 -> 2000 usec)` (recorded as provided)
- Neutral position: `1500 usec`
- Dead band width: `4 usec`
- Rotating direction: `anticlockwise (at 1500 -> 2000 usec)`
- Pulse width range: `800 -> 2200 usec`
- Maximum travel: `about 165 deg (at 800 -> 2200 usec)`

## 7. Physical Dimensions
- Body length: `40.8 mm`
- Body width: `20.1 mm`
- Body height: `38 mm`
- Approximate total length with mounting ears: `48.2 mm`

## Implementation Notes For This Project
- Start conservatively in firmware to avoid mechanical end-stop stress.
- Use `1500 usec` as neutral reference for midpoint checks.
- Do not power servo directly from an ESP32 logic pin; use appropriate servo supply and shared ground.
- During bring-up, verify whether this unit behaves as a positional servo or a continuous-rotation servo:
	- Positional servo: command maps to angle and holds position.
	- Continuous-rotation servo: pulse width maps to direction/speed around `1500 usec` neutral.
# Design Student Quickstart

This guide explains how to run the pointer prototype without needing prior coding or electronics experience.

## What This Device Does
- A value from your computer (WebSerial or Serial Monitor) tells the pointer where to move.
- A potentiometer (knob) scales how far the pointer can travel.
- A mode switch chooses between:
  - `Serial mode`: follows commands from your computer.
  - `Oscillation mode`: moves automatically back and forth for testing.
- An OLED (if connected) shows live status so you can see what the firmware thinks is happening.

## Safety First
- Power the servo from a proper servo supply (4.5V to 6.0V), not from an ESP32 signal pin.
- Always connect grounds together: ESP32 GND and servo power GND must be common.
- If the servo buzzes loudly or strains at endpoints, stop and reduce range settings.

## Wiring Overview
Servo (LS-3006 style wiring):
- `Black` -> `GND`
- `Red` -> `Servo V+` (external 5V typical)
- `Yellow` -> signal pin (`GPIO13` in this project)

Potentiometer:
- Center wiper -> `A0`
- One side -> `3.3V`
- Other side -> `GND`

Mode switch (uses internal pull-up):
- Recommended 3-pin SPDT toggle:
  - Center/common pin -> `GPIO12`
  - One outer pin -> `GND`
  - Other outer pin -> leave unconnected
- Alternate 2-pin switch:
  - One side -> `GPIO12`
  - Other side -> `GND`
- Logic:
  - Not connected to GND (HIGH) = `Serial mode`
  - Connected to GND (LOW) = `Oscillation mode`

OLED (GM12864, I2C):
- `VCC` -> `3.3V`
- `GND` -> `GND`
- `SDA` -> board `SDA` pin (Feather ESP32 V2 maps this to GPIO22)
- `SCL` -> board `SCL` pin (Feather ESP32 V2 maps this to GPIO20)
- Address is usually `0x3C` (alternate `0x3D`)

## Build, Upload, Monitor
From the project folder:
- Build: `pio run`
- Upload: `pio run -t upload`
- Monitor: `pio device monitor -b 115200`

## How To Test In 5 Minutes
1. Turn on power and open serial monitor.
2. Confirm startup messages appear.
3. Put switch in `Oscillation mode` to check smooth movement.
4. Turn potentiometer and verify motion range changes.
5. Switch to `Serial mode`.
6. Send test commands with newline, for example:
   - `0`
   - `50`
   - `-50`
   - `100`

## What The Status Lines Mean
Example:
`command=-23.5,mode=serial,guard=ok,potRaw=2012,servoAngleDeg=78.2`

- `command`: control value currently used by firmware (-100 to +100)
- `mode`: `serial` or `osc`
- `guard`: `ok` or `timeout` (timeout means serial data stopped, so firmware forced neutral)
- `potRaw`: potentiometer ADC reading (0 to 4095)
- `servoAngleDeg`: target servo angle sent by firmware

## Troubleshooting
- No OLED text:
  - Check SDA/SCL wiring and GND.
  - Module may be on `0x3D` instead of `0x3C`.
- Servo does not move:
  - Check external power and shared ground.
  - Confirm yellow signal wire goes to the configured servo pin.
- Servo moves in wrong direction:
  - This can happen with clone variants; note behavior and we can invert mapping in code.
- Status shows `guard=timeout` in serial mode:
  - Send commands more frequently, newline-terminated.

## Vocabulary (Plain Language)
- `Open-loop`: the firmware sends commands but does not read true servo position feedback.
- `PWM pulse`: timing signal used to tell the servo where/how to move.
- `Neutral`: midpoint command where no extreme motion is requested.

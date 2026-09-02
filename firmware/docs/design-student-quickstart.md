# Design Student Quickstart

This guide explains how to run the pointer prototype without needing prior coding or electronics experience.

## What This Device Does
- A value from your computer tells the pointer where to move. It can arrive over the USB
  cable or over Bluetooth — the device treats both the same way.
- A potentiometer (knob) scales how far the pointer can travel.
- A mode switch chooses between:
  - `Command mode`: follows commands from your computer.
  - `Oscillation mode`: moves automatically back and forth for testing.
- An OLED (if connected) shows live status so you can see what the firmware thinks is happening.
- The small built-in NeoPixel breathes white the whole time the device is running. If it
  stops breathing, the device has locked up or lost power.

## Safety First
- Power the servo from a proper servo supply (the MG996R accepts `4.8V` to `7.2V`; `5V` is
  what this project uses), not from an ESP32 signal pin or the `3.3V` rail.
- Always connect grounds together: ESP32 GND and servo power GND must be common.
- If the servo buzzes loudly or strains at endpoints, cut power. Do not wait for it to
  settle — a stalled MG996R draws around `2.5A` and heats up.
- **The pointer sweeps its whole range every time the device boots**, before it starts
  listening to anything. The knob does not limit that sweep. Keep the horn off the servo
  until you have watched one boot sweep and are happy with the arc.

## Wiring Overview
Servo (MG996R standard wire colors):
- `Brown` -> `GND`
- `Red` -> `Servo V+` (external `5V` typical)
- `Orange` -> signal pin (`GPIO13` in this project)

If you are reading an older sheet that says black/red/yellow, that was the LS-3006 this
project used before. It is not the servo on the bench now.

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
  - Not connected to GND (HIGH) = `Command mode`
  - Connected to GND (LOW) = `Oscillation mode`

OLED (GM12864, I2C):
- `VCC` -> `3.3V`
- `GND` -> `GND`
- `SDA` -> the pin labeled `SDA` on your board
- `SCL` -> the pin labeled `SCL` on your board
- Address is usually `0x3C` (alternate `0x3D`)

Use the labels, not GPIO numbers. The firmware asks the board which pins those are, so the
same code works on a different ESP32 board without edits.

## Build, Upload, Monitor
From the project folder:
- Build: `pio run`
- Upload: `pio run -t upload`
- Monitor: `pio device monitor -b 460800`

The speed matters. At `115200` you will see nonsense characters, which looks exactly like a
broken board and is not one.

## How To Test In 5 Minutes
1. With the horn off the servo, turn on power and open the serial monitor at `460800`.
2. Confirm startup messages appear and the NeoPixel is breathing.
3. Watch the three-second boot sweep: center, minimum, maximum, center. Listen for buzzing
   at the ends. If it is quiet, fit the horn.
4. Put the switch in `Oscillation mode` to check smooth movement. The motion is slow and
   deliberate — accelerate, cruise, brake, reverse — not a fast wiggle.
5. Turn the potentiometer and verify the motion range changes.
6. Switch to `Command mode`.
7. Send test commands with newline, for example:
   - `0`
   - `50`
   - `-50`
   - `100`

## What The Status Lines Mean
The device sends short lines, twenty times a second. Example:

`c=-23.5,m=s,g=0,p=2012,pr=2015,a=78.2,rn=0,rx=180,sm=0.0,sx=180.0,pw=1369,lu=310`

The ones to watch:

- `c`: control value currently used by the firmware (`-100` to `+100`)
- `m`: `s` = command mode, `o` = oscillation mode
- `g`: `0` = ok, `1` = timeout (commands stopped, so the firmware forced neutral)
- `p`: potentiometer reading after filtering (`0` to `4095`) — this is the one that moves
  the servo
- `pr`: the same reading before filtering; watch it jump around while `p` stays calm
- `a`: target servo angle the firmware asked for, in degrees
- `rn` / `rx`: the range the knob is currently allowing, in degrees, in 5-degree steps
- `pw`: the actual pulse width sent to the servo, in microseconds

Once a second you will also see a `lps=...,fv=...` line (loop rate and firmware version) and
a longer `perf=1,...` line of timing diagnostics. You can ignore both unless you are chasing
a performance problem. The full list of fields is in the project's root `AGENTS.md`.

## Troubleshooting
- No OLED text:
  - Check SDA/SCL wiring and GND.
  - Module may be on `0x3D` instead of `0x3C`.
- Serial monitor shows nonsense characters:
  - The speed is wrong. It must be `460800`.
- Servo does not move:
  - Check external power and shared ground.
  - Confirm the orange signal wire goes to the configured servo pin (`GPIO13`).
  - Confirm the NeoPixel is breathing. If it is not, the board is not running.
- Servo moves in wrong direction:
  - This can happen with clone variants; note behavior and we can invert mapping in code.
- Status shows `g=1` in command mode:
  - That is the timeout guard. Send commands more frequently, newline-terminated.

## Vocabulary (Plain Language)
- `Open-loop`: the firmware sends commands but does not read true servo position feedback.
- `PWM pulse`: timing signal used to tell the servo where/how to move.
- `Neutral`: midpoint command where no extreme motion is requested.

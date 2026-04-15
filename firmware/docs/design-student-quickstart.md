# Design Student Quickstart

This guide is the fastest path to seeing the pointer move. It covers only what you need to get started. For full wiring diagrams, hardware specs, and the camera-tracking context, see the main `README.md`.

## What This Device Does
- A value from your computer (the browser dashboard, or Serial Monitor) tells the pointer where to move.
- A potentiometer (knob) scales how far the pointer can travel.
- A mode switch chooses between:
  - `Serial mode`: follows commands from your computer.
  - `Oscillation mode`: moves automatically back and forth for testing.
- An OLED (if connected) shows live status so you can see what the firmware thinks is happening.

## Safety First
- Power the servo from a proper servo supply (4.5V to 6.0V), not from an ESP32 signal pin.
- Always connect grounds together: ESP32 GND and servo power GND must be common.
- If the servo buzzes loudly or strains at endpoints, stop and reduce range settings.

## Wiring and Build
See the **Wiring** and **Build and Run** sections in `README.md` for full details.

Quick reference:
- Servo signal wire → `GPIO13`
- Potentiometer wiper → `A0`
- Mode switch → `GPIO12` and `GND`
- Build: `pio run` | Upload: `pio run -t upload` | Monitor: `pio device monitor -b 115200`

## How To Test In 5 Minutes
1. Turn on power and open the serial monitor or browser dashboard.
2. Confirm startup messages appear.
3. Put switch in `Oscillation mode` to check smooth movement.
4. Turn potentiometer and verify motion range changes.
5. Switch to `Serial mode`.
6. Send test commands (newline-terminated), for example:
   - `0`
   - `50`
   - `-50`
   - `100`

## What The Telemetry Lines Mean
Example:
```
c=-23,m=s,g=0,p=2012,a=78,rn=45,rx=135
```

| Key | Field | Example | Meaning |
|-----|-------|---------|---------|
| `c` | command | `-23` | control value currently used by firmware (-100 to +100) |
| `m` | mode | `s` | `s` = serial, `o` = oscillation |
| `g` | guard | `0` | `0` = ok, `1` = timeout (no commands received, firmware forced neutral) |
| `p` | potRaw | `2012` | potentiometer ADC reading (0 to 4095) |
| `a` | angle | `78` | target servo angle in degrees |
| `rn` | rangeMin | `45` | minimum angle of pot-scaled travel range |
| `rx` | rangeMax | `135` | maximum angle of pot-scaled travel range |

The browser dashboard displays these same values with expanded labels for readability.

## Troubleshooting
- No OLED text:
  - Check SDA/SCL wiring and GND.
  - Module may be on `0x3D` instead of `0x3C`.
- Servo does not move:
  - Check external power and shared ground.
  - Confirm yellow signal wire goes to the configured servo pin.
- Servo moves in wrong direction:
  - This can happen with clone variants; note behavior and we can invert mapping in code.
- Telemetry shows `g=1` in serial mode:
  - Send commands more frequently, newline-terminated.

## Vocabulary (Plain Language)
- `Open-loop`: the firmware sends commands but does not read true servo position feedback.
- `PWM pulse`: timing signal used to tell the servo where/how to move.
- `Neutral`: midpoint command where no extreme motion is requested.
- `Guard / timeout`: if no command arrives for 1500 ms in serial mode, the firmware forces the command to 0 (neutral) as a safety measure.

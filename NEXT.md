# Next

Updated: 2026-11-22

## Where it stands

The pointer works as a teaching rig: ESP32 firmware (PlatformIO) drives an MG996R servo from a number between -100 and 100, sent from the browser dashboard over USB (WebSerial) or Bluetooth, and streams back what it did. The firmware was last changed in March 2026; the last commits, on 2 and 3 September, brought the lab manual in line with the servo on the bench and adopted the repository's naming.

## Next step

Bench-test the servo's end points and write the result down. The firmware commands 500 to 2500 µs across 0° to 180°, while `firmware/docs/mg996r-servo.md` gives about 1000 to 2000 µs across about 120°. With nothing attached to the shaft, step the command out from 0 toward each end and note where the servo buzzes or stalls. Then set `SERVO_MIN_US` / `SERVO_MAX_US` in `firmware/src/main.cpp` to the measured range, and update the README's table and its "Read this before you power the servo" section.

## After that

- Decide whether the boot sweep should respect the calibration knob instead of running full span every time.
- When the protocol changes, change all four written copies of it (README, `AGENTS.md`, `dashboard/README.md`, `firmware/docs/design-student-quickstart.md`).

## Blocked or waiting

- The bench test needs the rig in hand.

## Open questions

- Is the rig being used in a class this term, and does it need anything before then?
- This plan was drafted by Claude on 2026-11-22 from the code and its history. Is the next step right?

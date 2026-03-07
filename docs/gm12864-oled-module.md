# GM12864 I2C OLED Module Notes

Source provided by project owner on 2026-03-07.

## Module Identity
- Module family: `GM12864`
- Controller: `SSD1306-compatible`
- Display type: `Monochrome OLED`
- Resolution: `128x64`

## Electrical
- Supply voltage: `3.3V` to `5.0V`
- Logic level: `3.3V compatible`
- Interface: `I2C`
- Default address: `0x3C`
- Alternate address: `0x3D`
- Typical power: `~20 mA`
- Pull-ups: board includes I2C pull-up resistors

## Bus And Interface
- Supported bus speeds: `100 kHz`, `400 kHz`
- Typical 4-pin header:
  - `GND`: Ground
  - `VCC`: Power
  - `SCL`: I2C clock
  - `SDA`: I2C data

## Typical ESP32 Wiring (provided)
- `VCC -> 3.3V`
- `GND -> GND`
- `SCL -> GPIO22`
- `SDA -> GPIO21`

## Project Board Mapping (Adafruit Feather ESP32 V2)
- Use the board-defined I2C pins:
  - `SDA = GPIO22`
  - `SCL = GPIO20`
- On this board, prefer connecting to pins labeled `SDA` and `SCL`.

## Software Compatibility
- Known-compatible libraries:
  - `Adafruit_SSD1306`
  - `U8g2`
  - `SSD1306Wire`

## Project Usage Notes
- Firmware should try `0x3C` first, then `0x3D`.
- Keep display optional: if not detected, continue operating with Serial telemetry.
- Display is intended for live status/debug output during prototype bring-up.
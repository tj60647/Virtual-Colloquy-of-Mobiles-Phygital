# Colloquy of Mobiles Virtual Simulation — Phygital — Agent Instructions

This project is in a prototyping phase.

## Repository Layout

- `firmware/` — PlatformIO ESP32 firmware (runs on the physical device). See `firmware/AGENTS.md` for firmware-specific rules.
- `dashboard/` — Next.js web app (browser UI; host for both Web Serial and Web Bluetooth). See `dashboard/AGENTS.md` for dashboard-specific rules.
- `platformio.ini` (root) — redirecting duplicate of `firmware/platformio.ini`. Both files must be edited together.
- `vercel.json` (root) and `dashboard/vercel.json` — two Vercel configs in two different schemas. See the README.

Both subprojects have their own `AGENTS.md` that extends these shared rules.

## Working Directory Discipline

This repository has two active command contexts (`firmware` and `dashboard`).
To avoid running the right command in the wrong folder, always use explicit
directory scoping for terminal commands.

- Before build/run commands, confirm current directory with `Get-Location`.
- For dashboard commands, run from `dashboard/`.
- For PlatformIO/firmware commands, run from repository root (where `platformio.ini` lives), not from `dashboard/`.
- Prefer one-liners that set location explicitly instead of relying on terminal state.
	- Dashboard example: `cd dashboard; npm run dev`
	- Dashboard type-check: `cd dashboard; npx tsc --noEmit`
	- Firmware build: `cd ..; C:\Users\tj\.platformio\penv\Scripts\platformio.exe run --environment adafruit_feather_esp32_v2`
- If a command fails with a directory-context error (for example `NotPlatformIOProjectError`), immediately retry from the correct directory and note the correction.

## Audience
- Primary audience includes design students with little or no coding/electronics background.
- Prefer plain-language explanations and avoid jargon unless terms are explained.
- Make status output and docs instructional, not only diagnostic.

## Goals
- Move quickly and verify hardware behavior incrementally.
- Prefer readable code and rich debug output over heavy optimization.
- Keep decisions reversible until hardware behavior is validated.

## Author And License
- Author: Thomas J McLeish
- License: MIT
- New source files should include a file header with the project name, author, and MIT license reference.
- Each subproject's `AGENTS.md` defines the language-appropriate header format.

## General Commenting Convention
- Comment verbosely enough that intent, assumptions, and behavior are obvious.
- Explain "why" and design decisions, not only "what".
- Keep comments current when behavior changes.
- When possible, phrase comments so non-programmers can infer system behavior.

## Command And Telemetry Protocol (Shared Contract)

This protocol is the interface between `firmware/` and `dashboard/`. Both sides must stay in
sync with this spec, and so must `README.md`, `dashboard/README.md` and
`firmware/docs/design-student-quickstart.md`, which restate parts of it.

The same protocol runs over both transports: USB serial at `460800` baud and BLE Nordic UART
Service. `processIncomingCharacter()` in the firmware is the single command parser for both,
and `emitTelemetryFrame()` broadcasts every telemetry frame to both.

### Commands — dashboard → device
One value per line, newline-terminated. Plain integer or float, clamped to `-100..100`.
```
37\n
-50\n
0\n
```
The firmware also accepts the prefixed forms `cmd:37`, `cmd=37`, `pos:-50`, `pos=-50` for
manual Serial Monitor use. Parsing is strict: anything else on the line — including trailing
text after a valid number — is rejected outright, so stray digits in debug output cannot be
read as motion commands.

### Telemetry — device → dashboard
Compact comma-separated key=value pairs, one frame per line, newline-terminated. Three
frame types are emitted. Together they carry **29 distinct keys**, which is exactly the set
in the dashboard's `TELEMETRY_KEYS` whitelist. Keep those two in step.

**Status frame — 20 Hz, 12 keys.**
```
c=-100.0,m=o,g=1,p=4095,pr=4095,a=180.0,rn=180,rx=180,sm=180.0,sx=0.0,pw=2500,lu=2000\n
```

| Key | Field | Values / Units |
|-----|-------|----------------|
| `c` | commanded position | -100.0..100.0 (1 dp) |
| `m` | control mode | `s` = serial/command, `o` = oscillation |
| `g` | safety guard active | `1` = timeout/guard active, `0` = ok |
| `p` | potentiometer ADC, filtered (box → EMA) | 0..4095 — drives the servo |
| `pr` | potentiometer ADC, raw | 0..4095 — unfiltered debug reference |
| `a` | applied servo angle | degrees, 0.0..180.0 (1 dp) |
| `rn` | active range minimum | degrees, snapped to 5° steps |
| `rx` | active range maximum | degrees, snapped to 5° steps |
| `sm` | unsnapped range minimum | degrees (1 dp) — debug reference |
| `sx` | unsnapped range maximum | degrees (1 dp) — debug reference |
| `pw` | pulse width written to the servo | µs (500 = 0°, 1500 = 90°, 2500 = 180°) |
| `lu` | previous loop's active-work duration | µs |

**Version frame — 1 Hz, 2 keys.**
```
lps=498,fv=0.1.0\n
```

| Key | Field | Values / Units |
|-----|-------|----------------|
| `lps` | measured loop rate | loops per second |
| `fv` | firmware version (`FIRMWARE_VERSION`) | string |

**Performance frame — 1 Hz, 16 keys.** Worst-case task durations in the last window.
```
perf=1,lp=2001,lpa=2000,lpm=2456,lu=310,lm=980,si=4,cm=3,ps=27,so=6,st=190,od=9800,odr=310,odx=9500,odb=1180,hb=90\n
```

| Key | Field | Values / Units |
|-----|-------|----------------|
| `perf` | frame marker | always `1` |
| `lp` | most recent loop period | µs |
| `lpa` | mean loop period over the window | µs |
| `lpm` | worst loop period over the window | µs |
| `lu` | previous loop's active-work duration | µs (also in the status frame) |
| `lm` | worst loop active-work duration | µs |
| `si` | worst `processSerialInput()` | µs |
| `cm` | worst `updateControlModeAndCommand()` | µs |
| `ps` | worst `updatePotSample()` | µs |
| `so` | worst `applyServoOutput()` | µs |
| `st` | worst `printStatus()` | µs |
| `od` | worst `refreshOledStatus()` | µs |
| `odr` | worst OLED framebuffer render | µs |
| `odx` | worst OLED I2C transfer | µs |
| `odb` | most bytes pushed over I2C in one refresh | bytes |
| `hb` | worst `updateHeartbeat()` | µs |

### Parsing rules
- Split each line on `,` to get key=value pairs.
- Split each pair on `=` to get key and value.
- Ignore any line that yields no key=value pairs (startup banners, OLED messages, boot-sweep
  narration).
- Ignore unrecognized keys rather than failing the whole line.
- All values are numeric except `m`, which is a single character string.
- Merge frames into state; do not replace it. Each frame carries only part of the key set,
  and omitted fields remain valid from the last frame that carried them.

## Scope Priority
- Prioritize proving behavior over architecture purity.
- Add abstractions only when repetition or complexity justifies them.
- Keep decisions reversible until behavior is validated.
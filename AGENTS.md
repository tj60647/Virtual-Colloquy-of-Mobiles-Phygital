# Colloquy of Mobiles Virtual Simulation — Phygital — Agent Instructions

This project is in a prototyping phase.

## Repository Layout

- `firmware/` — PlatformIO ESP32 firmware (runs on the physical device). See `firmware/AGENTS.md` for firmware-specific rules.
- `dashboard/` — Next.js web app (browser UI / WebSerial host). See `dashboard/AGENTS.md` for dashboard-specific rules.

Both subprojects have their own `AGENTS.md` that extends these shared rules.

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

## Serial Protocol (Shared Contract)

This protocol is the interface between `firmware/` and `dashboard/`. Both sides must stay in sync with this spec.

### Commands — dashboard → device
One value per line, newline-terminated. Plain integer or float in the range `-100..100`.
```
37\n
-50\n
0\n
```
The firmware also accepts prefixed forms (`cmd:37`, `pos=-50`) for manual Serial Monitor use.

### Telemetry — device → dashboard
Compact comma-separated key=value pairs, one frame per line, newline-terminated.
```
c=37,m=s,g=0,p=2048,a=112,rn=45,rx=135\n
```

| Key | Field | Values / Units |
|-----|-------|----------------|
| `c` | commanded position | -100..100 |
| `m` | control mode | `s` = serial, `o` = oscillation |
| `g` | safety guard active | `1` = timeout/guard active, `0` = ok |
| `p` | potentiometer ADC average | 0..4095 |
| `a` | applied servo angle | degrees (0..180) |
| `rn` | range minimum angle (pot-scaled) | degrees (0..180) |
| `rx` | range maximum angle (pot-scaled) | degrees (0..180) |

### Parsing rules
- Split each line on `,` to get key=value pairs.
- Split each pair on `=` to get key and value.
- Ignore any line that does not match the pattern (startup banners, OLED messages, etc.).
- All values are numeric except `m` which is a single character string.

## Scope Priority
- Prioritize proving behavior over architecture purity.
- Add abstractions only when repetition or complexity justifies them.
- Keep decisions reversible until behavior is validated.
# Phygital Dashboard — the browser console for the pointer rig

Next.js 14 (App Router) web app that connects to the Colloquy of Mobiles Phygital pointer
firmware, sends it position commands and plots the telemetry it sends back. It talks to the
device two ways — Web Serial over USB and Web Bluetooth over BLE — and behaves the same on
both.

The device-side half lives in `../firmware/`. The protocol both halves implement is written
down once in `../AGENTS.md`; the hardware and the checkpoint ladder are in `../README.md`.

## Why This Is A Separate Folder

Keeping this app in `dashboard/` separates:

- firmware build/upload (`platformio.ini` + `firmware/src/`)
- web build/deploy (`dashboard/package.json`)

This prevents dependency and tooling conflicts.

## Scripts

| Script | Command | What it does |
|---|---|---|
| `dev` | `next dev` | Development server on `http://localhost:3000` |
| `build` | `next build` | Production build |
| `start` | `next start` | Serve the production build |

There is no lint or test script. Type-check with `npx tsc --noEmit`.

## Local Run

From `dashboard/`:

- `npm install`
- `npm run dev`
- open `http://localhost:3000` in Chrome or Edge

## Features

- **USB connect** over Web Serial at `460800` baud, with the port picker filtered to four
  USB vendor IDs (`0x239a`, `0x10c4`, `0x1a86`, `0x0403`).
- **Bluetooth connect** over Web Bluetooth, with the device picker filtered to the Nordic
  UART Service so only `Colloquy Pointer` devices appear.
- Connection failures translated into plain-language advice rather than raw exception text.
- Newline-terminated commands, always formatted to one decimal place.
- Manual command slider and text box, bounded to the currently reachable command envelope.
- Auto drive mode: a host-side trapezoidal generator streaming commands at 20 Hz or 50 Hz,
  with editable maximum velocity and acceleration and synchronized velocity, acceleration
  and position graphs.
- Live telemetry panel with fixed-axis sparklines, a command → angle → pulse-width signal
  chain row, and a stale-feed warning if nothing arrives for five seconds while connected.
- Performance diagnostics panel: all 16 keys of the firmware's 1 Hz performance frame, each
  with a 15-second sparkline showing window average and latest value.
- Servo position dial showing spec range, device active range, target sub-range, live angle
  and command preview.
- Optional rolling serial history, off by default because it costs a render per line.

## Browser Requirements

Web Serial and Web Bluetooth are both Chromium-only and both require a secure context:

- `https://` in production
- `http://localhost` in local development

The page checks for `navigator.serial` and `navigator.bluetooth` separately and disables the
button whose API is missing, so one transport still works when the other does not.

## Firmware Compatibility

The dashboard parses the compact `key=value` telemetry defined in `../AGENTS.md`. The
firmware emits three frame types carrying 29 distinct keys in total, and the
`TELEMETRY_KEYS` whitelist in `app/page.tsx` accepts exactly those 29:

```
c=-100.0,m=o,g=1,p=4095,pr=4095,a=180.0,rn=180,rx=180,sm=180.0,sx=0.0,pw=2500,lu=2000
lps=498,fv=0.1.0
perf=1,lp=2001,lpa=2000,lpm=2456,lu=310,lm=980,si=4,cm=3,ps=27,so=6,st=190,od=9800,odr=310,odx=9500,odb=1180,hb=90
```

Frames are merged into state rather than replacing it, so a key stays valid until a later
frame carries a new value for it. Lines with no `key=value` pairs — startup banners, the
OLED detection message — are ignored. Unknown keys are dropped rather than failing the line.

Adding a telemetry key means editing the firmware's format string, this whitelist, and the
tables in `../AGENTS.md` and `../README.md`.

## Vercel Deploy

1. Import this repository into Vercel.
2. Set **Root Directory** to `dashboard`.
3. Framework preset: **Next.js**.
4. Leave defaults, or use:
   - Install command: `npm install`
   - Build command: `npm run build`
   - Output: Next.js default output
5. Deploy.

`dashboard/vercel.json` pins framework and build commands so preview and production stay
consistent. Note that the repository root also carries a legacy-schema `vercel.json` that
builds this app from the root; only one of the two is in force, depending on whether the
Vercel project's Root Directory is set. See the Vercel section of `../README.md`.

### Vercel CLI (optional)

From the repository root:

- `cd dashboard`
- `npx vercel`

# Colloquy of Mobiles Virtual Simulation Phygital — WebSerial Dashboard

Web dashboard for testing the Colloquy of Mobiles Virtual Simulation Phygital firmware over WebSerial.

## Why This Is A Separate Folder
Keeping this app in `dashboard/` separates:
- firmware build/upload (`platformio.ini` + `src/`)
- web build/deploy (`dashboard/package.json`)

This prevents dependency and tooling conflicts.

## Features
- Connect/disconnect over WebSerial
- Send newline-terminated commands
- Quick buttons for common command values
- Parse and display firmware telemetry fields
- Show latest raw line and rolling serial history

## Local Run
From `dashboard/`:
- `npm install`
- `npm run dev`
- open `http://localhost:3000`

## Vercel Deploy
1. Import this repository into Vercel.
2. Set **Root Directory** to `dashboard`.
3. Framework preset: **Next.js**.
4. Leave defaults or use:
	- Install command: `npm install`
	- Build command: `npm run build`
	- Output: Next.js default output
5. Deploy.

### Vercel CLI (optional)
From repository root:
- `cd dashboard`
- `npx vercel`

The included `dashboard/vercel.json` pins framework/build commands so preview
and production deployments stay consistent.

## Browser Requirements
WebSerial is available in Chromium-based browsers and requires a secure context:
- `https://` production
- `http://localhost` local dev

## Firmware Compatibility
The dashboard expects telemetry lines in this style:
`command=...,mode=...,guard=...,potRaw=...,rangeMinDeg=...,rangeMaxDeg=...,servoAngleDeg=...`

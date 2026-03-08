# Virtual Colloquy WebSerial Dashboard

Web dashboard for testing the Virtual Colloquy Direction Indicator firmware over WebSerial.

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
2. Set the project root to `dashboard`.
3. Build command: `npm run build`
4. Output uses Next.js defaults.

## Browser Requirements
WebSerial is available in Chromium-based browsers and requires a secure context:
- `https://` production
- `http://localhost` local dev

## Firmware Compatibility
The dashboard expects telemetry lines in this style:
`command=...,mode=...,guard=...,potRaw=...,rangeMinDeg=...,rangeMaxDeg=...,servoAngleDeg=...`

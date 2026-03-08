# Dashboard — Agent Instructions

Extends the root `AGENTS.md`. These rules apply when working inside the `dashboard/` folder.

## Stack
- Framework: Next.js 14 (App Router)
- Language: TypeScript
- Runtime: Browser (WebSerial API + Web Bluetooth API for device communication)

## File Header Convention
Add this header at the top of every new `.ts` or `.tsx` file:

```ts
/*
 * <filename>
 * Project: Colloquy of Mobiles Virtual Simulation — Phygital
 * Author: Thomas J McLeish
 * License: MIT
 *
 * Prototype dashboard module.
 */
```

## WebSerial Guidance
- Check `navigator.serial` availability before use; the API is not available in all browsers.
- Use newline-terminated frames to match the firmware serial protocol.
- Handle port disconnection gracefully — device may be unplugged at any time.

## Web Bluetooth (BLE) Guidance
- Check `navigator.bluetooth` availability before use; requires Chromium on `https://` or `localhost`.
- The firmware advertises as Nordic UART Service (NUS). Filter on the NUS service UUID so only Colloquy Pointer devices appear in the picker.
- NUS Service UUID: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- RX characteristic (browser → device, write): `6e400002-b5a3-f393-e0a9-e50e24dcca9e`
- TX characteristic (device → browser, notify): `6e400003-b5a3-f393-e0a9-e50e24dcca9e`
- BLE notifications may not align with newline boundaries — buffer partial frames and split on `\n` the same way as the serial reader.
- Web Bluetooth types are declared locally in `dashboard/types/webbluetooth.d.ts`.
- `transportType` state (`"serial" | "ble" | null`) controls which transport `sendCommand()` uses.

## Development Workflow
1. Install dependencies: `npm install` from inside `dashboard/`.
2. Start dev server: `npm run dev`.
3. Open `http://localhost:3000` in a WebSerial-compatible browser (Chrome or Edge).

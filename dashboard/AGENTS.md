# Dashboard — Agent Instructions

Extends the root `AGENTS.md`. These rules apply when working inside the `dashboard/` folder.

## Stack
- Framework: Next.js 14 (App Router)
- Language: TypeScript
- Runtime: Browser (WebSerial API for device communication)

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
- The browser WebSerial API is the primary communication channel to the ESP32 device.
- Always check `navigator.serial` availability before use; the API is not available in all browsers.
- Use newline-terminated frames to match the firmware serial protocol.
- Handle port disconnection gracefully — device may be unplugged at any time.

## Development Workflow
1. Install dependencies: `npm install` from inside `dashboard/`.
2. Start dev server: `npm run dev`.
3. Open `http://localhost:3000` in a WebSerial-compatible browser (Chrome or Edge).

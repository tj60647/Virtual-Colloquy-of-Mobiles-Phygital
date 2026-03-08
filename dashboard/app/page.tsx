"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Telemetry = {
  command?: string;
  mode?: string;
  guard?: string;
  potRaw?: string;
  rangeMinDeg?: string;
  rangeMaxDeg?: string;
  servoAngleDeg?: string;
};

type ConnectErrorInfo = {
  summary: string;
  tips: string[];
};

const SERIAL_PORT_FILTERS = [
  // Adafruit (native USB boards)
  { usbVendorId: 0x239a },
  // Silicon Labs CP210x USB-UART
  { usbVendorId: 0x10c4 },
  // WCH CH34x USB-UART
  { usbVendorId: 0x1a86 },
  // FTDI USB-UART
  { usbVendorId: 0x0403 }
];

function parseTelemetry(line: string): Telemetry {
  const out: Telemetry = {};
  line.split(",").forEach((part) => {
    const [k, v] = part.split("=");
    if (!k || v === undefined) {
      return;
    }
    const key = k.trim() as keyof Telemetry;
    out[key] = v.trim();
  });
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pointForDegree(deg: number, radius: number): { x: number; y: number } {
  const centerX = 160;
  const centerY = 150;
  const angleRad = ((180 - deg) * Math.PI) / 180;
  return {
    x: centerX + radius * Math.cos(angleRad),
    y: centerY - radius * Math.sin(angleRad)
  };
}

function arcPolyline(minDeg: number, maxDeg: number, radius: number): string {
  const start = clamp(minDeg, 0, 180);
  const end = clamp(maxDeg, 0, 180);
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const steps = Math.max(8, Math.round((to - from) / 2));
  const points: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const d = from + (to - from) * t;
    const p = pointForDegree(d, radius);
    points.push(`${p.x},${p.y}`);
  }
  return points.join(" ");
}

function explainConnectError(error: unknown): ConnectErrorInfo {
  const fallback = {
    summary: "Connection failed.",
    tips: [
      "Close other serial tools (PlatformIO monitor, Arduino monitor, terminal apps).",
      "Unplug/replug the board USB cable and try Connect again.",
      "Confirm this page is running in a Chromium browser over HTTPS or localhost."
    ]
  };

  if (!(error instanceof Error)) {
    return fallback;
  }

  const message = (error.message || "").toLowerCase();
  const name = (error.name || "").toLowerCase();

  if (name.includes("notfound") || message.includes("user cancelled")) {
    return {
      summary: "Port selection was canceled.",
      tips: ["Click Connect Device and choose the board COM port in the chooser."]
    };
  }

  if (message.includes("failed to open serial port") || message.includes("open serial port")) {
    return {
      summary: "Port could not be opened (likely already in use).",
      tips: [
        "Close PlatformIO/terminal serial monitor first (only one app can own the port).",
        "Disconnect any app that may already be connected to the same COM port.",
        "Then click Connect Device again."
      ]
    };
  }

  if (name.includes("security") || message.includes("secure context")) {
    return {
      summary: "Browser blocked WebSerial for security context reasons.",
      tips: ["Use Chrome/Edge on https:// or http://localhost."]
    };
  }

  return {
    summary: `Connect failed: ${error.message}`,
    tips: fallback.tips
  };
}

export default function Page() {
  const [supported, setSupported] = useState(false);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Disconnected");
  const [connectTips, setConnectTips] = useState<string[]>([]);
  const [commandInput, setCommandInput] = useState("0");
  const [lastLine, setLastLine] = useState("Waiting for serial data...");
  const [telemetry, setTelemetry] = useState<Telemetry>({});
  const [history, setHistory] = useState<string[]>([]);

  const portRef = useRef<any>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);

  useEffect(() => {
    setSupported(Boolean(navigator.serial));
  }, []);

  const guardBadgeClass = useMemo(() => {
    return telemetry.guard === "timeout" ? "badge warn" : "badge ok";
  }, [telemetry.guard]);

  const rangeMinDeg = useMemo(() => toNumber(telemetry.rangeMinDeg, 0), [telemetry.rangeMinDeg]);
  const rangeMaxDeg = useMemo(() => toNumber(telemetry.rangeMaxDeg, 180), [telemetry.rangeMaxDeg]);
  const currentAngleDeg = useMemo(() => toNumber(telemetry.servoAngleDeg, 90), [telemetry.servoAngleDeg]);
  const commandValue = useMemo(() => clamp(toNumber(commandInput, 0), -100, 100), [commandInput]);

  const previewAngleDeg = useMemo(() => {
    const min = Math.min(rangeMinDeg, rangeMaxDeg);
    const max = Math.max(rangeMinDeg, rangeMaxDeg);
    const center = (min + max) * 0.5;
    const halfSpan = (max - min) * 0.5;
    return clamp(center + (commandValue / 100) * halfSpan, 0, 180);
  }, [commandValue, rangeMinDeg, rangeMaxDeg]);

  const rangePoints = useMemo(
    () => arcPolyline(rangeMinDeg, rangeMaxDeg, 120),
    [rangeMinDeg, rangeMaxDeg]
  );

  const fullArcPoints = useMemo(() => arcPolyline(0, 180, 120), []);

  const currentTip = useMemo(() => pointForDegree(currentAngleDeg, 108), [currentAngleDeg]);
  const previewTip = useMemo(() => pointForDegree(previewAngleDeg, 96), [previewAngleDeg]);
  const rangeMinTip = useMemo(() => pointForDegree(rangeMinDeg, 126), [rangeMinDeg]);
  const rangeMaxTip = useMemo(() => pointForDegree(rangeMaxDeg, 126), [rangeMaxDeg]);

  async function connect() {
    if (!navigator.serial) {
      setStatus("WebSerial unavailable in this browser context");
      return;
    }

    try {
      setConnectTips([]);
      setStatus("Requesting port...");
      const port = await navigator.serial.requestPort({ filters: SERIAL_PORT_FILTERS });
      await port.open({ baudRate: 115200 });
      portRef.current = port;

      if (!port.readable || !port.writable) {
        throw new Error("Serial stream unavailable");
      }

      readerRef.current = port.readable.getReader();
      writerRef.current = port.writable.getWriter();

      setConnected(true);
      setStatus("Connected at 115200 baud");

      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await readerRef.current.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          setLastLine(line);
          setTelemetry(parseTelemetry(line));
          setHistory((prev) => [line, ...prev].slice(0, 60));
        }
      }
    } catch (error) {
      const info = explainConnectError(error);
      setStatus(info.summary);
      setConnectTips(info.tips);
      setConnected(false);
    }
  }

  async function disconnect() {
    try {
      await readerRef.current?.cancel();
      readerRef.current?.releaseLock();
      writerRef.current?.releaseLock();
      await portRef.current?.close();
    } catch {
      // Ignore close errors to avoid trapping user in connected state.
    } finally {
      readerRef.current = null;
      writerRef.current = null;
      portRef.current = null;
      setConnected(false);
      setStatus("Disconnected");
      setConnectTips([]);
    }
  }

  async function sendCommand(raw: string) {
    if (!writerRef.current) {
      setStatus("Not connected");
      return;
    }

    const text = `${raw.trim()}\n`;
    await writerRef.current.write(new TextEncoder().encode(text));
  }

  return (
    <main>
      <h1>Virtual Colloquy Device Dashboard</h1>
      <p>
        Use this page to connect over WebSerial, send test commands, and observe live firmware
        telemetry.
      </p>

      <div className="grid">
        <section className="card">
          <h2>Connection</h2>
          <div className="row" style={{ marginBottom: 10 }}>
            <button className="primary" onClick={connect} disabled={!supported || connected}>
              Connect Device
            </button>
            <button onClick={disconnect} disabled={!connected}>
              Disconnect
            </button>
          </div>
          <div className={telemetry.guard === "timeout" ? "badge warn" : "badge ok"}>{status}</div>
          {connectTips.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {connectTips.map((tip, index) => (
                <p key={`${tip}-${index}`} style={{ marginTop: index === 0 ? 0 : 6 }}>
                  {index + 1}. {tip}
                </p>
              ))}
            </div>
          )}
          {!supported && (
            <p style={{ marginTop: 10 }}>
              WebSerial requires a supported Chromium browser over HTTPS or localhost.
            </p>
          )}
        </section>

        <section className="card">
          <h2>Send Command</h2>
          <div className="row" style={{ marginBottom: 10 }}>
            <input
              type="text"
              value={commandInput}
              onChange={(e) => setCommandInput(e.target.value)}
              placeholder="Example: 0, 25, -50"
            />
            <button className="primary" disabled={!connected} onClick={() => sendCommand(commandInput)}>
              Send
            </button>
          </div>
          <label className="dial-label" htmlFor="command-slider">
            Position command ({commandValue.toFixed(0)})
          </label>
          <input
            id="command-slider"
            type="range"
            min={-100}
            max={100}
            step={1}
            value={commandValue}
            onChange={(e) => setCommandInput(e.target.value)}
          />
          <div className="row">
            {[-100, -50, 0, 50, 100].map((v) => (
              <button key={v} disabled={!connected} onClick={() => sendCommand(String(v))}>
                {v}
              </button>
            ))}
          </div>
          <p style={{ marginTop: 10 }}>Commands are sent newline-terminated to match firmware parsing.</p>
        </section>

        <section className="card">
          <h2>Live Telemetry</h2>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className={guardBadgeClass}>guard: {telemetry.guard ?? "n/a"}</span>
          </div>
          <div className="kv">
            <span>command</span>
            <code>{telemetry.command ?? "-"}</code>
          </div>
          <div className="kv">
            <span>mode</span>
            <code>{telemetry.mode ?? "-"}</code>
          </div>
          <div className="kv">
            <span>potRaw</span>
            <code>{telemetry.potRaw ?? "-"}</code>
          </div>
          <div className="kv">
            <span>range (deg)</span>
            <code>
              {telemetry.rangeMinDeg ?? "-"} to {telemetry.rangeMaxDeg ?? "-"}
            </code>
          </div>
          <div className="kv">
            <span>servoAngleDeg</span>
            <code>{telemetry.servoAngleDeg ?? "-"}</code>
          </div>
        </section>

        <section className="card" style={{ gridColumn: "1 / -1" }}>
          <h2>Servo Range Dial</h2>
          <p style={{ marginBottom: 10 }}>
            White arc is full 0-180 range. Green arc is active virtual range from potentiometer.
            Orange needle is live servo angle. Dashed needle is the command preview.
          </p>
          <div className="dial-wrap">
            <svg viewBox="0 0 320 170" className="dial" role="img" aria-label="Servo range dial">
              <polyline className="dial-track" points={fullArcPoints} />
              <polyline className="dial-range" points={rangePoints} />

              <line x1="160" y1="150" x2={rangeMinTip.x} y2={rangeMinTip.y} className="dial-bound" />
              <line x1="160" y1="150" x2={rangeMaxTip.x} y2={rangeMaxTip.y} className="dial-bound" />

              <line x1="160" y1="150" x2={previewTip.x} y2={previewTip.y} className="dial-preview" />
              <line x1="160" y1="150" x2={currentTip.x} y2={currentTip.y} className="dial-current" />
              <circle cx="160" cy="150" r="6" className="dial-hub" />

              <text x="20" y="160" className="dial-tick">0</text>
              <text x="152" y="24" className="dial-tick">90</text>
              <text x="292" y="160" className="dial-tick">180</text>
            </svg>
            <div className="dial-stats">
              <div className="kv"><span>virtual min</span><code>{Math.round(rangeMinDeg)} deg</code></div>
              <div className="kv"><span>virtual max</span><code>{Math.round(rangeMaxDeg)} deg</code></div>
              <div className="kv"><span>live angle</span><code>{Math.round(currentAngleDeg)} deg</code></div>
              <div className="kv"><span>command preview</span><code>{Math.round(previewAngleDeg)} deg</code></div>
            </div>
          </div>
        </section>

        <section className="card">
          <h2>Latest Raw Line</h2>
          <div className="log">{lastLine}</div>
        </section>

        <section className="card" style={{ gridColumn: "1 / -1" }}>
          <h2>Recent Serial History</h2>
          <div className="log">
            {history.length === 0 ? "No lines received yet." : history.map((line, i) => <div key={`${line}-${i}`}>{line}</div>)}
          </div>
        </section>
      </div>
    </main>
  );
}

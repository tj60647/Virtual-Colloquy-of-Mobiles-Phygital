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

type DashboardDriveMode = "manual" | "oscillator";

const SERIAL_PORT_FILTERS = [
  { usbVendorId: 0x239a },
  { usbVendorId: 0x10c4 },
  { usbVendorId: 0x1a86 },
  { usbVendorId: 0x0403 }
];

const COMMAND_MIN = -100;
const COMMAND_MAX = 100;
const DASHBOARD_DRIVE_HZ = 20;
const PROFILE_GRAPH_WIDTH = 280;
const PROFILE_GRAPH_HEIGHT = 96;
const PROFILE_GRAPH_SAMPLES = 120;

function parseTelemetry(line: string): Telemetry {
  const out: Telemetry = {};
  line.split(",").forEach((part) => {
    const [k, v] = part.split("=");
    if (!k || v === undefined) {
      return;
    }
    out[k.trim() as keyof Telemetry] = v.trim();
  });
  return out;
}

function explainConnectError(error: unknown): ConnectErrorInfo {
  const fallback = {
    summary: "Connection failed.",
    tips: [
      "Close other serial tools (PlatformIO monitor, Arduino monitor, terminal apps).",
      "Unplug/replug the board USB cable and try Connect again.",
      "Confirm this page runs in Chromium over HTTPS or localhost."
    ]
  };

  if (!(error instanceof Error)) {
    return fallback;
  }

  const msg = (error.message || "").toLowerCase();
  const name = (error.name || "").toLowerCase();

  if (name.includes("notfound") || msg.includes("user cancelled")) {
    return { summary: "Port selection was canceled.", tips: ["Choose your board COM port and retry."] };
  }

  if (msg.includes("open serial port")) {
    return {
      summary: "Port could not be opened (likely in use).",
      tips: [
        "Close PlatformIO/terminal serial monitor first.",
        "Only one application can own a serial port at a time.",
        "Reconnect after releasing the COM port."
      ]
    };
  }

  if (name.includes("security") || msg.includes("secure context")) {
    return { summary: "Browser security blocked WebSerial.", tips: ["Use Chrome/Edge on https:// or localhost."] };
  }

  return { summary: `Connect failed: ${error.message}`, tips: fallback.tips };
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

function q(value: number): number {
  return Number(value.toFixed(2));
}

function pointForDegree(deg: number, radius: number): { x: number; y: number } {
  const centerX = 160;
  const centerY = 150;
  const angleRad = ((180 - deg) * Math.PI) / 180;
  return {
    x: q(centerX + radius * Math.cos(angleRad)),
    y: q(centerY - radius * Math.sin(angleRad))
  };
}

function arcPolyline(minDeg: number, maxDeg: number, radius: number): string {
  const from = Math.min(clamp(minDeg, 0, 180), clamp(maxDeg, 0, 180));
  const to = Math.max(clamp(minDeg, 0, 180), clamp(maxDeg, 0, 180));
  const steps = Math.max(8, Math.round((to - from) / 2));
  const points: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const d = from + ((to - from) * i) / steps;
    const p = pointForDegree(d, radius);
    points.push(`${p.x},${p.y}`);
  }
  return points.join(" ");
}

// Estimate one full trapezoid oscillation period analytically so the preview graph
// can display complete cycles regardless of amplitude / velocity / accel settings.
function estimateTrapezoidPeriodSec(amplitude: number, maxVel: number, maxAccel: number): number {
  if (amplitude < 0.001 || maxVel < 0.001 || maxAccel < 0.001) {
    return 10;
  }
  const dRamp = (maxVel * maxVel) / (2 * maxAccel);
  const totalTravel = 2 * amplitude;
  const tRamp = maxVel / maxAccel;
  const tHalf = 2 * dRamp >= totalTravel
    ? Math.sqrt(totalTravel / maxAccel)
    : tRamp + (totalTravel - 2 * dRamp) / maxVel;
  return 2 * tHalf;
}

function buildTrapezoidProfilePoints(amplitude: number, maxVel: number, maxAccel: number): string {
  const safeAmplitude = clamp(amplitude, 0, 100);
  const safeMaxVel = Math.max(0, maxVel);
  const safeMaxAccel = Math.max(0, maxAccel);

  // Simulate enough real-time steps to cover ~2.2 complete cycles, then downsample.
  const estimatedPeriod = estimateTrapezoidPeriodSec(safeAmplitude, safeMaxVel, safeMaxAccel);
  const displayDuration = Math.min(estimatedPeriod * 2.2, 600);
  const dt = 1 / DASHBOARD_DRIVE_HZ;
  const totalSteps = Math.ceil(displayDuration / dt);

  let pos = 0;
  let vel = 0;
  let target = safeAmplitude;
  const rawSamples: number[] = new Array(totalSteps);

  for (let step = 0; step < totalSteps; step += 1) {
    if (safeAmplitude < 0.001 || safeMaxVel < 0.001 || safeMaxAccel < 0.001) {
      rawSamples[step] = 0;
    } else {
      if (Math.abs(pos - target) < 0.5 && Math.abs(vel) < 0.5) {
        target = target > 0 ? -safeAmplitude : safeAmplitude;
      }

      const distance = target - pos;
      const direction = distance >= 0 ? 1 : -1;
      const brakingDistance = (vel * vel) / (2 * safeMaxAccel);
      const desiredVelMag = Math.abs(distance) <= Math.abs(brakingDistance)
        ? Math.sqrt(Math.max(0, 2 * safeMaxAccel * Math.abs(distance)))
        : safeMaxVel;
      const desiredVel = direction * desiredVelMag;
      const maxDv = safeMaxAccel * dt;

      vel += clamp(desiredVel - vel, -maxDv, maxDv);
      vel = clamp(vel, -safeMaxVel, safeMaxVel);
      pos = clamp(pos + vel * dt, -safeAmplitude, safeAmplitude);

      if ((pos >= safeAmplitude && vel > 0) || (pos <= -safeAmplitude && vel < 0)) {
        target = -target;
      }
      rawSamples[step] = pos;
    }
  }

  const points: string[] = [];
  for (let i = 0; i < PROFILE_GRAPH_SAMPLES; i += 1) {
    const idx = Math.min(Math.floor((i / (PROFILE_GRAPH_SAMPLES - 1)) * (totalSteps - 1)), totalSteps - 1);
    const x = q((i / (PROFILE_GRAPH_SAMPLES - 1)) * PROFILE_GRAPH_WIDTH);
    const y = q((1 - (rawSamples[idx] - COMMAND_MIN) / (COMMAND_MAX - COMMAND_MIN)) * PROFILE_GRAPH_HEIGHT);
    points.push(`${x},${y}`);
  }

  return points.join(" ");
}

export default function Page() {
  const [supported, setSupported] = useState(false);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Disconnected");
  const [connectTips, setConnectTips] = useState<string[]>([]);
  const [commandInput, setCommandInput] = useState("0");
  const [driveMode, setDriveMode] = useState<DashboardDriveMode>("manual");
  const [oscAmplitude, setOscAmplitude] = useState(100);
  const [maxVel, setMaxVel] = useState(8);
  const [maxAccel, setMaxAccel] = useState(8);
  const [servoSpecRangeDeg, setServoSpecRangeDeg] = useState(180);
  const [lastLine, setLastLine] = useState("Waiting for serial data...");
  const [telemetry, setTelemetry] = useState<Telemetry>({});
  const [history, setHistory] = useState<string[]>([]);
  const [lastRxAt, setLastRxAt] = useState("-");

  const portRef = useRef<any>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const driveTimeRef = useRef(0);
  const trapPositionRef = useRef(0);
  const trapVelocityRef = useRef(0);
  const trapTargetRef = useRef(100);
  const sendBusyRef = useRef(false);

  useEffect(() => {
    setSupported(Boolean(navigator.serial));
  }, []);

  const guardBadgeClass = useMemo(() => (telemetry.guard === "timeout" ? "badge warn" : "badge ok"), [telemetry.guard]);

  const rangeMinDeg = useMemo(() => toNumber(telemetry.rangeMinDeg, 0), [telemetry.rangeMinDeg]);
  const rangeMaxDeg = useMemo(() => toNumber(telemetry.rangeMaxDeg, 180), [telemetry.rangeMaxDeg]);
  const currentAngleDeg = useMemo(() => toNumber(telemetry.servoAngleDeg, 90), [telemetry.servoAngleDeg]);
  const commandValue = useMemo(() => clamp(toNumber(commandInput, 0), COMMAND_MIN, COMMAND_MAX), [commandInput]);

  const previewAngleDeg = useMemo(() => {
    const min = Math.min(rangeMinDeg, rangeMaxDeg);
    const max = Math.max(rangeMinDeg, rangeMaxDeg);
    const center = (min + max) * 0.5;
    const halfSpan = (max - min) * 0.5;
    return clamp(center + (commandValue / 100) * halfSpan, 0, 180);
  }, [commandValue, rangeMinDeg, rangeMaxDeg]);

  const servoSpecMin = clamp(90 - servoSpecRangeDeg * 0.5, 0, 180);
  const servoSpecMax = clamp(90 + servoSpecRangeDeg * 0.5, 0, 180);

  const activeSpanDeg = Math.abs(rangeMaxDeg - rangeMinDeg);
  const activeRangeCenterDeg = (rangeMinDeg + rangeMaxDeg) * 0.5;
  const fullArcPoints = useMemo(() => arcPolyline(0, 180, 120), []);
  const rangePoints = useMemo(() => arcPolyline(rangeMinDeg, rangeMaxDeg, 120), [rangeMinDeg, rangeMaxDeg]);
  const specPoints = useMemo(() => arcPolyline(servoSpecMin, servoSpecMax, 120), [servoSpecMin, servoSpecMax]);
  const currentTip = useMemo(() => pointForDegree(currentAngleDeg, 108), [currentAngleDeg]);
  const previewTip = useMemo(() => pointForDegree(previewAngleDeg, 96), [previewAngleDeg]);
  const rangeMinTip = useMemo(() => pointForDegree(rangeMinDeg, 126), [rangeMinDeg]);
  const rangeMaxTip = useMemo(() => pointForDegree(rangeMaxDeg, 126), [rangeMaxDeg]);
  const activeCenterTip = useMemo(() => pointForDegree(activeRangeCenterDeg, 120), [activeRangeCenterDeg]);
  const motionProfilePoints = useMemo(
    () => buildTrapezoidProfilePoints(oscAmplitude, maxVel, maxAccel),
    [oscAmplitude, maxVel, maxAccel]
  );

  async function sendCommand(raw: string) {
    if (!writerRef.current || sendBusyRef.current) {
      return;
    }
    sendBusyRef.current = true;
    try {
      await writerRef.current.write(new TextEncoder().encode(`${raw.trim()}\n`));
    } finally {
      sendBusyRef.current = false;
    }
  }

  function stepTrapezoid(dt: number): number {
    const amplitude = clamp(oscAmplitude, 0, 100);
    const accel = Math.max(0, maxAccel);
    const vmax = Math.max(0, maxVel);
    if (amplitude < 0.001 || vmax < 0.001 || accel < 0.001) {
      trapVelocityRef.current = 0;
      trapPositionRef.current = clamp(trapPositionRef.current, -amplitude, amplitude);
      return trapPositionRef.current;
    }

    let pos = trapPositionRef.current;
    let vel = trapVelocityRef.current;
    let target = trapTargetRef.current;

    if (Math.abs(pos - target) < 0.5 && Math.abs(vel) < 0.5) {
      target = target > 0 ? -amplitude : amplitude;
      trapTargetRef.current = target;
    }

    const distance = target - pos;
    const direction = distance >= 0 ? 1 : -1;
    const brakingDistance = (vel * vel) / (2 * accel);
    const desiredVelMag = Math.abs(distance) <= Math.abs(brakingDistance)
      ? Math.sqrt(Math.max(0, 2 * accel * Math.abs(distance)))
      : vmax;
    const desiredVel = direction * desiredVelMag;

    const maxDv = accel * dt;
    vel += clamp(desiredVel - vel, -maxDv, maxDv);
    vel = clamp(vel, -vmax, vmax);
    pos = clamp(pos + vel * dt, -amplitude, amplitude);

    if ((pos >= amplitude && vel > 0) || (pos <= -amplitude && vel < 0)) {
      trapTargetRef.current = -target;
    }

    trapPositionRef.current = pos;
    trapVelocityRef.current = vel;
    return pos;
  }

  useEffect(() => {
    if (!(connected && driveMode === "oscillator")) {
      return;
    }
    const periodMs = 1000 / DASHBOARD_DRIVE_HZ;
    const timer = window.setInterval(() => {
      const dt = periodMs / 1000;
      const cmd = stepTrapezoid(dt);
      const rounded = Math.round(clamp(cmd, COMMAND_MIN, COMMAND_MAX));
      setCommandInput(String(rounded));
      void sendCommand(String(rounded));
    }, periodMs);

    return () => window.clearInterval(timer);
  }, [connected, driveMode, oscAmplitude, maxVel, maxAccel]);

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
          setHistory((prev) => [line, ...prev].slice(0, 120));
          setLastRxAt(new Date().toLocaleTimeString());
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
      // Ignore cleanup errors.
    } finally {
      readerRef.current = null;
      writerRef.current = null;
      portRef.current = null;
      setConnected(false);
      setStatus("Disconnected");
      setConnectTips([]);
      driveTimeRef.current = 0;
    }
  }

  function activateDriveMode(next: DashboardDriveMode) {
    setDriveMode(next);
    if (next === "oscillator") {
      const amplitude = Math.abs(oscAmplitude);
      const initial = clamp(toNumber(commandInput, 0), -amplitude, amplitude);
      trapPositionRef.current = initial;
      trapVelocityRef.current = 0;
      trapTargetRef.current = initial >= 0 ? -amplitude : amplitude;
      driveTimeRef.current = 0;
    }
  }

  return (
    <main className="console-page compact-console">
      <h1>Virtual Colloquy Console</h1>
      <p>Focused controls: connect, stream data, oscillator profile, and servo arc.</p>

      <div className="compact-layout">
        <div className="left-stack">
          <section className="card panel-tight">
            <h2>1) Connection</h2>
            <div className="row" style={{ marginBottom: 8 }}>
              <button className="primary" onClick={connect} disabled={!supported || connected}>Connect</button>
              <button onClick={disconnect} disabled={!connected}>Disconnect</button>
            </div>
            <div className={connected ? "badge ok" : "badge warn"}>{status}</div>
            {!supported && <p style={{ marginTop: 8 }}>WebSerial needs Chromium on localhost/https.</p>}
            {connectTips.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {connectTips.slice(0, 2).map((tip, index) => (
                  <p key={`${tip}-${index}`} style={{ marginTop: index === 0 ? 0 : 4 }}>{tip}</p>
                ))}
              </div>
            )}
          </section>

          <section className="card panel-tight">
            <h2>2) Streaming Data</h2>
            <div className="kv"><span>last receive</span><code>{lastRxAt}</code></div>
            <div className="kv"><span>mode</span><code>{telemetry.mode ?? "-"}</code></div>
            <div className="kv"><span>guard</span><span className={guardBadgeClass}>{telemetry.guard ?? "n/a"}</span></div>
            <div className="kv"><span>command</span><code>{telemetry.command ?? "-"}</code></div>
            <div className="kv"><span>servo angle</span><code>{Math.round(currentAngleDeg)} deg</code></div>
            <div className="kv"><span>range</span><code>{Math.round(rangeMinDeg)} to {Math.round(rangeMaxDeg)} deg</code></div>
            <div className="kv"><span>potRaw</span><code>{telemetry.potRaw ?? "-"}</code></div>
            <div className="log log-small" style={{ marginTop: 8 }}>{lastLine}</div>
          </section>

          <section className="card panel-tight">
            <h2>3) Serial History</h2>
            <details>
              <summary>Show recent lines</summary>
              <div className="log history-log" style={{ marginTop: 8 }}>
                {history.length === 0 ? "No lines received yet." : history.map((line, i) => <div key={`${line}-${i}`}>{line}</div>)}
              </div>
            </details>
          </section>
        </div>

        <section className="card panel-tight">
          <h2>4) Oscillator / Motion Profile</h2>
          <div className="row" style={{ marginBottom: 8 }}>
            <button className={driveMode === "manual" ? "primary" : ""} onClick={() => activateDriveMode("manual")}>Manual</button>
            <button className={driveMode === "oscillator" ? "primary" : ""} onClick={() => activateDriveMode("oscillator")}>Oscillator @ {DASHBOARD_DRIVE_HZ} Hz</button>
          </div>
          <label className="dial-label" htmlFor="command-slider">Command ({Math.round(commandValue)})</label>
          <input id="command-slider" type="range" min={COMMAND_MIN} max={COMMAND_MAX} step={1} value={commandValue} onChange={(e) => setCommandInput(e.target.value)} disabled={driveMode === "oscillator"} />
          <div className="row" style={{ marginTop: 8, marginBottom: 10 }}>
            <input type="text" value={commandInput} onChange={(e) => setCommandInput(e.target.value)} disabled={driveMode === "oscillator"} placeholder="-100 to 100" />
            <button className="primary" disabled={!connected || driveMode === "oscillator"} onClick={() => sendCommand(commandInput)}>Send</button>
          </div>
          <div className="kv"><span>amplitude (units)</span><input type="number" min={0} max={100} step={1} value={oscAmplitude} onChange={(e) => setOscAmplitude(clamp(Number(e.target.value), 0, 100))} disabled={driveMode !== "oscillator"} /></div>
          <div className="kv"><span>max velocity (units/s)</span><input type="number" min={0} max={20} step={0.5} value={maxVel} onChange={(e) => setMaxVel(clamp(Number(e.target.value), 0, 20))} disabled={driveMode !== "oscillator"} /></div>
          <div className="kv"><span>max acceleration (units/s²)</span><input type="number" min={0} max={20} step={0.5} value={maxAccel} onChange={(e) => setMaxAccel(clamp(Number(e.target.value), 0, 20))} disabled={driveMode !== "oscillator"} /></div>
          <div className="profile-graph" aria-label="Trapezoidal motion profile preview">
            <div className="profile-graph-head"><span>trapezoidal command profile</span></div>
            <svg viewBox={`0 0 ${PROFILE_GRAPH_WIDTH} ${PROFILE_GRAPH_HEIGHT}`} role="img" aria-label="Command versus time graph">
              <line x1="0" y1={PROFILE_GRAPH_HEIGHT / 2} x2={PROFILE_GRAPH_WIDTH} y2={PROFILE_GRAPH_HEIGHT / 2} className="profile-midline" />
              <polyline points={motionProfilePoints} className="profile-wave" />
            </svg>
          </div>
        </section>

        <section className="card panel-tight servo-panel">
          <h2>5) Servo Position Diagram</h2>
          <div className="dial-legend">
            <span><svg width="16" height="8"><polyline points="0,4 16,4" stroke="#8e6da9" strokeWidth="2" strokeDasharray="3 2" fill="none"/></svg>spec range</span>
            <span><svg width="16" height="8"><polyline points="0,4 16,4" stroke="#007f5f" strokeWidth="3" fill="none"/></svg>active range</span>
            <span><svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke="#c85f2f" strokeWidth="2"/></svg>live angle</span>
            <span><svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke="#0b6aa8" strokeWidth="2" strokeDasharray="3 2"/></svg>cmd preview</span>
            <span><svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke="#6d6b64" strokeWidth="1.5" strokeDasharray="2 2"/></svg>cmd zero</span>
          </div>
          <div className="dial-wrap dial-wrap-compact">
            <svg viewBox="0 0 320 170" className="dial" role="img" aria-label="Servo range dial">
              <polyline className="dial-track" points={fullArcPoints} />
              <polyline className="dial-spec" points={specPoints} />
              <polyline className="dial-range" points={rangePoints} />
              <line x1="160" y1="150" x2={rangeMinTip.x} y2={rangeMinTip.y} className="dial-bound" />
              <line x1="160" y1="150" x2={rangeMaxTip.x} y2={rangeMaxTip.y} className="dial-bound" />
              <line x1="160" y1="150" x2={activeCenterTip.x} y2={activeCenterTip.y} className="dial-center" />
              <line x1="160" y1="150" x2={previewTip.x} y2={previewTip.y} className="dial-preview" />
              <line x1="160" y1="150" x2={currentTip.x} y2={currentTip.y} className="dial-current" />
              <circle cx="160" cy="150" r="6" className="dial-hub" />
              <text x="8" y="167" className="dial-tick">0°</text>
              <text x="160" y="16" className="dial-tick" style={{ textAnchor: "middle" }}>90°</text>
              <text x="312" y="167" className="dial-tick" style={{ textAnchor: "end" }}>180°</text>
            </svg>
            <div className="dial-stats">
              <div className="kv"><span>command domain</span><code>{COMMAND_MIN} to {COMMAND_MAX}</code></div>
              <div className="kv"><span>active span</span><code>{Math.round(activeSpanDeg)} deg</code></div>
              <div className="kv"><span>preview angle</span><code>{Math.round(previewAngleDeg)} deg</code></div>
              <div className="kv"><span>live angle</span><code>{Math.round(currentAngleDeg)} deg</code></div>
              <div className="kv"><span>servo spec range</span><input type="number" min={0} max={220} step={1} value={servoSpecRangeDeg} onChange={(e) => setServoSpecRangeDeg(clamp(Number(e.target.value), 0, 220))} /></div>
              <div className="kv"><span>spec min/max</span><code>{Math.round(servoSpecMin)} to {Math.round(servoSpecMax)} deg</code></div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

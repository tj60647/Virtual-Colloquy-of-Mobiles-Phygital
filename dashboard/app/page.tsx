"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// Short keys match the compact telemetry protocol defined in the root AGENTS.md.
type Telemetry = {
  c?: string;   // commanded position
  m?: string;   // mode (s=serial, o=oscillation)
  g?: string;   // guard active (1=timeout, 0=ok)
  p?: string;   // pot ADC — stage-2 filtered (EMA of box average); what the servo uses
  pr?: string;  // pot ADC — raw, unfiltered; compare to p to measure filter effectiveness
  a?: string;   // applied servo angle (degrees)
  rn?: string;  // range minimum angle (degrees) — snapped to 5° steps for display
  rx?: string;  // range maximum angle (degrees) — snapped to 5° steps for display
  sm?: string;  // servo range min (degrees) — unsnapped debug reference from EMA path
  sx?: string;  // servo range max (degrees) — unsnapped debug reference from EMA path
  pw?: string;  // PWM pulse width µs sent to servo hardware (500=0°, 1500=90°, 2500=180°)
  fv?: string;  // firmware version string (e.g. "0.1.0") — sent once/sec in lps= line
  lps?: string; // loop rate (loops per second) — sent once/sec alongside fv
  lu?: string;  // loop active-work duration (microseconds)
  perf?: string; // performance diagnostics frame marker (1 when perf frame is present)
  lp?: string;   // loop period (microseconds)
  lpa?: string;  // average loop period over diagnostics window (microseconds)
  lpm?: string;  // maximum loop period over diagnostics window (microseconds)
  lm?: string;   // max loop work duration in last diagnostics window (microseconds)
  si?: string;   // max processSerialInput() duration in diagnostics window (microseconds)
  cm?: string;   // max updateControlModeAndCommand() duration in diagnostics window (microseconds)
  ps?: string;   // max updatePotSample() duration in diagnostics window (microseconds)
  so?: string;   // max applyServoOutput() duration in diagnostics window (microseconds)
  st?: string;   // max printStatus() duration in diagnostics window (microseconds)
  od?: string;   // max refreshOledStatus() duration in diagnostics window (microseconds)
  odr?: string;  // max OLED framebuffer render time in diagnostics window (microseconds)
  odx?: string;  // max OLED transfer time in diagnostics window (microseconds)
  odb?: string;  // max OLED transfer volume in diagnostics window (bytes written over I2C)
  hb?: string;   // max updateHeartbeat() duration in diagnostics window (microseconds)
};

type ConnectErrorInfo = {
  summary: string;
  tips: string[];
};

type DashboardDriveMode = "manual" | "oscillator";

// Shared packet key whitelist. Only these keys are accepted into telemetry state.
const TELEMETRY_KEYS = new Set<keyof Telemetry>([
  "c", "m", "g", "p", "pr", "a", "rn", "rx", "sm", "sx", "pw", "fv", "lps", "lu",
  "perf", "lp", "lpa", "lpm", "lm", "si", "cm", "ps", "so", "st", "od", "odr", "odx", "odb", "hb"
]);

const SERIAL_PORT_FILTERS = [
  { usbVendorId: 0x239a },
  { usbVendorId: 0x10c4 },
  { usbVendorId: 0x1a86 },
  { usbVendorId: 0x0403 }
];
const SERIAL_BAUD_RATE = 460800;

// Nordic UART Service (NUS) — standard BLE serial emulation UUIDs.
// The firmware advertises this service; the dashboard filters on it so
// only Colloquy Pointer devices appear in the browser picker.
const NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // browser → device
const NUS_TX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // device → browser (notify)

const COMMAND_MIN = -100;
const COMMAND_MAX = 100;
const DEFAULT_DASHBOARD_DRIVE_HZ = 20;
const AUTO_MOTION_RATE_OPTIONS = [20, 50] as const;
const PROFILE_GRAPH_WIDTH = 360;
const PROFILE_GRAPH_HEIGHT = 99;
const PROFILE_PLOT_PAD_LEFT = 58;
const PROFILE_PLOT_PAD_RIGHT = 8;
const PROFILE_PLOT_PAD_TOP = 8;
const PROFILE_PLOT_PAD_BOTTOM = 18;
const PROFILE_GRAPH_SAMPLES = 120;
const SPARK_MAX_POINTS = 80;
const PERF_SPARK_WINDOW_MS = 15000;
const PW_GRAPH_VIEWBOX_WIDTH = 1000;
const PW_GRAPH_VIEWBOX_HEIGHT = 280;
const PW_GRAPH_PAD_LEFT = 76;
const PW_GRAPH_PAD_RIGHT = 14;
const PW_GRAPH_PAD_TOP = 18;
const PW_GRAPH_PAD_BOTTOM = 52;
const PW_GRAPH_WINDOW_MS = 10000;
const PW_GRAPH_MIN_US = 500;
const PW_GRAPH_MAX_US = 2500;

type TimedSample = {
  tMs: number;
  value: number;
};

type MotionProfilePreview = {
  velocityPoints: string;
  accelerationPoints: string;
  positionPoints: string;
  phaseBoundariesX: number[];
  accelSec: number;
  cruiseSec: number;
  decelSec: number;
  halfCycleSec: number;
  fullCycleSec: number;
  peakVelocity: number;
  peakAcceleration: number;
  peakPosition: number;
};

type MotionProfileSample = {
  phaseSec: number;
  position: number;
  velocity: number;
  acceleration: number;
};

// Fixed domain bounds for streaming sparklines.
const SPARK_BOUNDS = {
  c: { min: -100, max: 100  },
  a: { min: 0,    max: 180  },
  pw: { min: PW_GRAPH_MIN_US, max: PW_GRAPH_MAX_US },
} as const;

// Fixed domain bounds for performance diagnostics sparklines.
const PERF_SPARK_BOUNDS = {
  lps: { min: 0, max: 600 },
  lp: { min: 0, max: 4000 },
  lpa: { min: 0, max: 4000 },
  lpm: { min: 0, max: 12000 },
  lu: { min: 0, max: 4000 },
  lm: { min: 0, max: 35000 },
  si: { min: 0, max: 2000 },
  cm: { min: 0, max: 2000 },
  ps: { min: 0, max: 2000 },
  so: { min: 0, max: 2000 },
  st: { min: 0, max: 5000 },
  od: { min: 0, max: 35000 },
  odr: { min: 0, max: 10000 },
  odx: { min: 0, max: 35000 },
  odb: { min: 0, max: 1400 },
  hb: { min: 0, max: 2000 },
} as const;
type SparkKey = keyof typeof SPARK_BOUNDS;
type PerfSparkKey = keyof typeof PERF_SPARK_BOUNDS;

type SparkHistories = Record<SparkKey, number[]>;
type PerfSparkHistories = Record<PerfSparkKey, TimedSample[]>;

/**
 * Build an SVG polyline points string for a sparkline.
 * bounds are fixed (not auto-scaled) so the baseline is stable.
 */
function sparkPoints(
  values: number[],
  minVal: number,
  maxVal: number,
  width = 400,
  height = 28
): string {
  if (values.length < 2) return "";
  return values
    .map((v, i) => {
      const x = q((i / (values.length - 1)) * width);
      const y = q((1 - (v - minVal) / (maxVal - minVal)) * height);
      return `${x},${y}`;
    })
    .join(" ");
}

// Time-based sparkline points: x-axis is elapsed wall time over a fixed window.
function timedSparkPoints(
  samples: TimedSample[],
  nowMs: number,
  minVal: number,
  maxVal: number,
  width = 400,
  height = 28,
  windowMs = PERF_SPARK_WINDOW_MS
): string {
  if (samples.length < 2) {
    return "";
  }
  const startMs = nowMs - windowMs;
  const visible = samples.filter((s) => s.tMs >= startMs && s.tMs <= nowMs);
  if (visible.length < 2) {
    return "";
  }
  return visible
    .map((s) => {
      const x = q(clamp((s.tMs - startMs) / windowMs, 0, 1) * width);
      const y = q((1 - (s.value - minVal) / (maxVal - minVal)) * height);
      return `${x},${y}`;
    })
    .join(" ");
}

// Compute running average over the visible time window used by the perf sparkline.
function timedWindowAverage(
  samples: TimedSample[],
  nowMs: number,
  windowMs = PERF_SPARK_WINDOW_MS
): number | null {
  if (samples.length === 0) {
    return null;
  }
  const startMs = nowMs - windowMs;
  const visible = samples.filter((s) => s.tMs >= startMs && s.tMs <= nowMs);
  if (visible.length === 0) {
    return null;
  }
  const sum = visible.reduce((acc, s) => acc + s.value, 0);
  return sum / visible.length;
}

function pwY(valueUs: number): number {
  const plotHeight = PW_GRAPH_VIEWBOX_HEIGHT - PW_GRAPH_PAD_TOP - PW_GRAPH_PAD_BOTTOM;
  const ratio = (valueUs - PW_GRAPH_MIN_US) / (PW_GRAPH_MAX_US - PW_GRAPH_MIN_US);
  return q(PW_GRAPH_PAD_TOP + (1 - ratio) * plotHeight);
}

function pwXFromTime(tMs: number, nowMs: number): number {
  const plotWidth = PW_GRAPH_VIEWBOX_WIDTH - PW_GRAPH_PAD_LEFT - PW_GRAPH_PAD_RIGHT;
  const windowStartMs = nowMs - PW_GRAPH_WINDOW_MS;
  const ratio = (tMs - windowStartMs) / PW_GRAPH_WINDOW_MS;
  return q(PW_GRAPH_PAD_LEFT + clamp(ratio, 0, 1) * plotWidth);
}

function pwPlotMidY(): number {
  return pwY(1500);
}

function pwPlotLeftX(): number {
  return PW_GRAPH_PAD_LEFT;
}

function pwPlotRightX(): number {
  return PW_GRAPH_VIEWBOX_WIDTH - PW_GRAPH_PAD_RIGHT;
}

// Build points from timestamped samples so the x-axis is true elapsed time,
// not just "N latest points". This keeps the graph width fixed at 10 seconds.
function pulseWidthGraphPoints(samples: TimedSample[], nowMs: number): string {
  if (samples.length < 2) {
    return "";
  }
  const windowStartMs = nowMs - PW_GRAPH_WINDOW_MS;
  const visible = samples.filter((s) => s.tMs >= windowStartMs && s.tMs <= nowMs);
  if (visible.length < 2) {
    return "";
  }
  return visible
    .map((s) => `${pwXFromTime(s.tMs, nowMs)},${pwY(s.value)}`)
    .join(" ");
}

// Returns null for lines that contain no key=value pairs (startup banners,
// debug prints, etc.) so callers can skip updating telemetry state entirely.
function parseTelemetry(line: string): Telemetry | null {
  const out: Telemetry = {};
  line.split(",").forEach((part) => {
    const [k, v] = part.split("=");
    if (!k || v === undefined) {
      return;
    }
    const key = k.trim() as keyof Telemetry;
    if (!TELEMETRY_KEYS.has(key)) {
      return;
    }
    out[key] = v.trim();
  });
  // If nothing was parsed it was a plain-text line with no key=value pairs.
  return Object.keys(out).length > 0 ? out : null;
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

function explainBleConnectError(error: unknown): ConnectErrorInfo {
  const fallback: ConnectErrorInfo = {
    summary: "Bluetooth connection failed.",
    tips: [
      "Make sure the device is powered on and advertising.",
      "Use Chrome or Edge on a supported platform.",
      "Confirm the page is served over HTTPS or localhost."
    ]
  };
  if (!(error instanceof Error)) {
    return fallback;
  }
  const msg = (error.message || "").toLowerCase();
  const name = (error.name || "").toLowerCase();
  if (name.includes("notfound") || msg.includes("user cancelled")) {
    return { summary: "Bluetooth picker was closed.", tips: ["Select the Colloquy Pointer device and try again."] };
  }
  if (name.includes("security") || msg.includes("secure context")) {
    return { summary: "Browser blocked Web Bluetooth.", tips: ["Use Chrome/Edge on https:// or localhost."] };
  }
  if (msg.includes("gatt")) {
    return { summary: "GATT connection failed.", tips: ["Device may already be connected elsewhere. Power cycle the device and retry."] };
  }
  return { summary: `Bluetooth failed: ${error.message}`, tips: fallback.tips };
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

function buildMotionProfilePreview(amplitude: number, maxVel: number, maxAccel: number): MotionProfilePreview {
  const safeAmplitude = clamp(amplitude, 0, 100);
  const safeMaxVel = Math.max(0, maxVel);
  const safeMaxAccel = Math.max(0, maxAccel);

  const velToY = (v: number): number => {
    if (safeMaxVel < 0.001) {
      return q(PROFILE_GRAPH_HEIGHT * 0.5);
    }
    return q((1 - (v + safeMaxVel) / (2 * safeMaxVel)) * PROFILE_GRAPH_HEIGHT);
  };

  const accToY = (a: number): number => {
    if (safeMaxAccel < 0.001) {
      return q(PROFILE_GRAPH_HEIGHT * 0.5);
    }
    return q((1 - (a + safeMaxAccel) / (2 * safeMaxAccel)) * PROFILE_GRAPH_HEIGHT);
  };

  const posToY = (p: number): number => {
    if (safeAmplitude < 0.001) {
      return q(PROFILE_GRAPH_HEIGHT * 0.5);
    }
    return q((1 - (p + safeAmplitude) / (2 * safeAmplitude)) * PROFILE_GRAPH_HEIGHT);
  };

  if (safeAmplitude < 0.001 || safeMaxVel < 0.001 || safeMaxAccel < 0.001) {
    const velFlatY = velToY(0);
    const accFlatY = accToY(0);
    return {
      velocityPoints: `0,${velFlatY} ${PROFILE_GRAPH_WIDTH},${velFlatY}`,
      accelerationPoints: `0,${accFlatY} ${PROFILE_GRAPH_WIDTH},${accFlatY}`,
      positionPoints: `0,${posToY(0)} ${PROFILE_GRAPH_WIDTH},${posToY(0)}`,
      phaseBoundariesX: [],
      accelSec: 0,
      cruiseSec: 0,
      decelSec: 0,
      halfCycleSec: 0,
      fullCycleSec: 0,
      peakVelocity: 0,
      peakAcceleration: 0,
      peakPosition: safeAmplitude,
    };
  }

  const totalTravel = safeAmplitude * 2;
  const tRampToMaxVel = safeMaxVel / safeMaxAccel;
  const dRampAtMaxVel = 0.5 * safeMaxAccel * tRampToMaxVel * tRampToMaxVel;

  const triangular = dRampAtMaxVel * 2 >= totalTravel;
  const accelSec = triangular ? Math.sqrt(totalTravel / safeMaxAccel) : tRampToMaxVel;
  const cruiseDistance = triangular ? 0 : totalTravel - 2 * dRampAtMaxVel;
  const cruiseSec = triangular ? 0 : cruiseDistance / safeMaxVel;
  const decelSec = accelSec;
  const halfCycleSec = accelSec + cruiseSec + decelSec;
  const fullCycleSec = halfCycleSec * 2;
  const peakVel = safeMaxAccel * accelSec;

  const xFromSec = (sec: number): number => q((sec / fullCycleSec) * PROFILE_GRAPH_WIDTH);

  // Exact piecewise velocity profile over one full loop (A -> B -> A).
  const t0 = 0;
  const t1 = accelSec;
  const t2 = accelSec + cruiseSec;
  const t3 = halfCycleSec;
  const t4 = halfCycleSec + accelSec;
  const t5 = halfCycleSec + accelSec + cruiseSec;
  const t6 = fullCycleSec;

  const velocityPoints = [
    `${xFromSec(t0)},${velToY(0)}`,
    `${xFromSec(t1)},${velToY(peakVel)}`,
    `${xFromSec(t2)},${velToY(peakVel)}`,
    `${xFromSec(t3)},${velToY(0)}`,
    `${xFromSec(t4)},${velToY(-peakVel)}`,
    `${xFromSec(t5)},${velToY(-peakVel)}`,
    `${xFromSec(t6)},${velToY(0)}`,
  ];

  // Exact step acceleration profile. Duplicate x at boundaries to force
  // vertical transitions and avoid fake sloped gaps from interpolation.
  const accelerationPoints = [
    `${xFromSec(t0)},${accToY(0)}`,
    `${xFromSec(t0)},${accToY(safeMaxAccel)}`,
    `${xFromSec(t1)},${accToY(safeMaxAccel)}`,
    `${xFromSec(t1)},${accToY(0)}`,
    `${xFromSec(t2)},${accToY(0)}`,
    `${xFromSec(t2)},${accToY(-safeMaxAccel)}`,
    `${xFromSec(t4)},${accToY(-safeMaxAccel)}`,
    `${xFromSec(t4)},${accToY(0)}`,
    `${xFromSec(t5)},${accToY(0)}`,
    `${xFromSec(t5)},${accToY(safeMaxAccel)}`,
    `${xFromSec(t6)},${accToY(safeMaxAccel)}`,
    `${xFromSec(t6)},${accToY(0)}`,
  ];

  const phaseBoundariesSec = [
    accelSec,
    accelSec + cruiseSec,
    halfCycleSec,
    halfCycleSec + accelSec,
    halfCycleSec + accelSec + cruiseSec,
  ];
  const phaseBoundariesX = phaseBoundariesSec.map((sec) => q((sec / fullCycleSec) * PROFILE_GRAPH_WIDTH));

  // Position curve p(t) across one full A->B->A cycle in command units.
  const dAccel = 0.5 * safeMaxAccel * accelSec * accelSec;
  const dCruise = peakVel * cruiseSec;
  const positionAtSec = (sec: number): number => {
    const t = clamp(sec, 0, fullCycleSec);
    if (t <= t1) {
      return -safeAmplitude + 0.5 * safeMaxAccel * t * t;
    }
    if (t <= t2) {
      return -safeAmplitude + dAccel + peakVel * (t - t1);
    }
    if (t <= t3) {
      const dt = t - t2;
      return -safeAmplitude + dAccel + dCruise + peakVel * dt - 0.5 * safeMaxAccel * dt * dt;
    }
    if (t <= t4) {
      const dt = t - t3;
      return safeAmplitude - 0.5 * safeMaxAccel * dt * dt;
    }
    if (t <= t5) {
      return safeAmplitude - dAccel - peakVel * (t - t4);
    }
    const dt = t - t5;
    return safeAmplitude - dAccel - dCruise - peakVel * dt + 0.5 * safeMaxAccel * dt * dt;
  };
  const positionPoints = Array.from({ length: PROFILE_GRAPH_SAMPLES }, (_, i) => {
    const sec = (i / (PROFILE_GRAPH_SAMPLES - 1)) * fullCycleSec;
    const x = xFromSec(sec);
    const y = posToY(positionAtSec(sec));
    return `${x},${y}`;
  });

  return {
    velocityPoints: velocityPoints.join(" "),
    accelerationPoints: accelerationPoints.join(" "),
    positionPoints: positionPoints.join(" "),
    phaseBoundariesX,
    accelSec,
    cruiseSec,
    decelSec,
    halfCycleSec,
    fullCycleSec,
    peakVelocity: peakVel,
    peakAcceleration: safeMaxAccel,
    peakPosition: safeAmplitude,
  };
}

/**
 * Sample the trapezoidal profile at a specific elapsed time.
 * Returns instantaneous velocity and acceleration for marker display.
 */
function sampleMotionProfile(profile: MotionProfilePreview, timeSec: number): MotionProfileSample {
  if (profile.fullCycleSec <= 0.0001) {
    return { phaseSec: 0, position: 0, velocity: 0, acceleration: 0 };
  }

  const full = profile.fullCycleSec;
  const phase = ((timeSec % full) + full) % full;

  const t1 = profile.accelSec;
  const t2 = profile.accelSec + profile.cruiseSec;
  const t3 = profile.halfCycleSec;
  const t4 = profile.halfCycleSec + profile.accelSec;
  const t5 = profile.halfCycleSec + profile.accelSec + profile.cruiseSec;

  const vmax = profile.peakVelocity;
  const amax = profile.peakAcceleration;
  const pmax = profile.peakPosition;
  const dAccel = 0.5 * amax * profile.accelSec * profile.accelSec;
  const dCruise = vmax * profile.cruiseSec;

  if (phase < t1) {
    return {
      phaseSec: phase,
      position: -pmax + 0.5 * amax * phase * phase,
      velocity: amax * phase,
      acceleration: amax,
    };
  }
  if (phase < t2) {
    return {
      phaseSec: phase,
      position: -pmax + dAccel + vmax * (phase - t1),
      velocity: vmax,
      acceleration: 0,
    };
  }
  if (phase < t3) {
    const dt = phase - t2;
    return {
      phaseSec: phase,
      position: -pmax + dAccel + dCruise + vmax * dt - 0.5 * amax * dt * dt,
      velocity: vmax - amax * dt,
      acceleration: -amax,
    };
  }
  if (phase < t4) {
    const dt = phase - t3;
    return {
      phaseSec: phase,
      position: pmax - 0.5 * amax * dt * dt,
      velocity: -amax * dt,
      acceleration: -amax,
    };
  }
  if (phase < t5) {
    return {
      phaseSec: phase,
      position: pmax - dAccel - vmax * (phase - t4),
      velocity: -vmax,
      acceleration: 0,
    };
  }

  const dt = phase - t5;
  return {
    phaseSec: phase,
    position: pmax - dAccel - dCruise - vmax * dt + 0.5 * amax * dt * dt,
    velocity: -vmax + amax * dt,
    acceleration: amax,
  };
}

export default function Page() {
  const [supported, setSupported] = useState(false);
  const [bleSupported, setBleSupported] = useState(false);
  const [connected, setConnected] = useState(false);
  const [transportType, setTransportType] = useState<"serial" | "ble" | null>(null);
  const [status, setStatus] = useState("Disconnected");
  const [connectTips, setConnectTips] = useState<string[]>([]);
  const [commandInput, setCommandInput] = useState("0");
  const [driveMode, setDriveMode] = useState<DashboardDriveMode>("manual");
  const [autoMotionHz, setAutoMotionHz] = useState<number>(DEFAULT_DASHBOARD_DRIVE_HZ);
  const [maxVel, setMaxVel] = useState(25);
  const [maxAccel, setMaxAccel] = useState(25);
  const servoSpecRangeDeg = 180;
  const [targetSweepDeg, setTargetSweepDeg] = useState(180);
  const [targetSweepOffsetDeg, setTargetSweepOffsetDeg] = useState(0);
  const [diagramFlipDirection, setDiagramFlipDirection] = useState(false);
  const [diagramZeroIsUp, setDiagramZeroIsUp] = useState(true);
  const [trackSerialHistory, setTrackSerialHistory] = useState(false);
  const [lastLine, setLastLine] = useState("Waiting for serial data...");
  const [telemetry, setTelemetry] = useState<Telemetry>({});
  const [history, setHistory] = useState<string[]>([]);
  const [sparkHistories, setSparkHistories] = useState<SparkHistories>({ c: [], a: [], pw: [] });
  const [perfSparkHistories, setPerfSparkHistories] = useState<PerfSparkHistories>({
    lps: [], lp: [], lpa: [], lpm: [], lu: [], lm: [], si: [], cm: [], ps: [], so: [], st: [], od: [], odr: [], odx: [], odb: [], hb: []
  });
  const [pwHistory, setPwHistory] = useState<TimedSample[]>([]);
  const [lastRxAt, setLastRxAt] = useState("-");
  // True when connected but no telemetry frame has arrived in the last 5 seconds.
  // Displayed as a warning badge so the student knows the device may be frozen.
  const [stale, setStale] = useState(false);

  const portRef = useRef<any>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  // BLE refs — hold references to the connected GATT device and characteristics.
  const bleDeviceRef = useRef<BluetoothDevice | null>(null);
  const bleRxCharRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);
  // bleTxCharRef + bleTxListenerRef must be stored so the listener can be
  // removed on disconnect.  Without explicit removal, each reconnect adds
  // another anonymous listener — those pile up and eventually freeze the tab.
  const bleTxCharRef     = useRef<BluetoothRemoteGATTCharacteristic | null>(null);
  const bleTxListenerRef = useRef<((event: Event) => void) | null>(null);
  // BLE line-buffer stored in a ref so the named listener function doesn't
  // close over a stale local variable from a previous connect call.
  const bleBufRef        = useRef("");
  // Epoch time (ms) of the last successfully processed telemetry line.
  // Using a ref avoids re-renders and keeps staleness checks off the render path.
  const lastRxMsRef      = useRef(0);
  const driveTimeRef = useRef(0);
  const prevProfileCycleSecRef = useRef<number | null>(null);
  const sendBusyRef = useRef(false);

  useEffect(() => {
    setSupported(Boolean(navigator.serial));
    setBleSupported(Boolean(navigator.bluetooth));
  }, []);

  // Keep history buffers empty unless tracking is explicitly enabled.
  useEffect(() => {
    if (!trackSerialHistory) {
      setHistory([]);
      setLastLine("History tracking is off.");
    }
  }, [trackSerialHistory]);

  // Periodically check whether telemetry has gone silent while connected.
  // If no frame arrives for >5 s, mark the feed as stale so the student can
  // see the device may be frozen rather than silently watching a frozen readout.
  useEffect(() => {
    if (!connected) {
      setStale(false);
      return;
    }
    const timer = window.setInterval(() => {
      setStale(lastRxMsRef.current > 0 && Date.now() - lastRxMsRef.current > 5000);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [connected]);

  // g=1 means guard/timeout active; g=0 means ok.
  const guardBadgeClass = useMemo(() => (telemetry.g === "1" ? "badge warn" : "badge ok"), [telemetry.g]);
  const perfStreamActive =
    telemetry.perf === "1" ||
    telemetry.lp !== undefined ||
    telemetry.lpa !== undefined ||
    telemetry.lpm !== undefined ||
    telemetry.lm !== undefined ||
    telemetry.si !== undefined ||
    telemetry.cm !== undefined ||
    telemetry.ps !== undefined ||
    telemetry.so !== undefined ||
    telemetry.st !== undefined ||
    telemetry.od !== undefined ||
    telemetry.odr !== undefined ||
    telemetry.odx !== undefined ||
    telemetry.odb !== undefined ||
    telemetry.hb !== undefined;

  const rangeMinDeg = useMemo(() => toNumber(telemetry.rn, 0), [telemetry.rn]);
  const rangeMaxDeg = useMemo(() => toNumber(telemetry.rx, 180), [telemetry.rx]);
  const currentAngleDeg = useMemo(() => toNumber(telemetry.a, 90), [telemetry.a]);
  const commandValue = useMemo(() => clamp(toNumber(commandInput, 0), COMMAND_MIN, COMMAND_MAX), [commandInput]);
  const requestedSweepDeg = useMemo(() => clamp(targetSweepDeg, 0, 180), [targetSweepDeg]);
  const servoSpecMin = clamp(90 - servoSpecRangeDeg * 0.5, 0, 180);
  const servoSpecMax = clamp(90 + servoSpecRangeDeg * 0.5, 0, 180);

  const activeSpanDeg = Math.abs(rangeMaxDeg - rangeMinDeg);
  const activeRangeMinDeg = Math.min(rangeMinDeg, rangeMaxDeg);
  const activeRangeMaxDeg = Math.max(rangeMinDeg, rangeMaxDeg);
  const activeRangeCenterDeg = (rangeMinDeg + rangeMaxDeg) * 0.5;
  const effectiveSweepDeg = useMemo(
    () => Math.min(requestedSweepDeg, activeSpanDeg),
    [requestedSweepDeg, activeSpanDeg]
  );
  const commandLimitPercent = useMemo(() => {
    if (activeSpanDeg <= 0.001) {
      return 0;
    }
    return clamp((effectiveSweepDeg / activeSpanDeg) * 100, 0, 100);
  }, [effectiveSweepDeg, activeSpanDeg]);

  const minTargetOffsetDeg = useMemo(() => {
    const half = effectiveSweepDeg * 0.5;
    const minFromActive = activeRangeMinDeg + half - activeRangeCenterDeg;
    const minFromSpec = servoSpecMin + half - activeRangeCenterDeg;
    return Math.max(minFromActive, minFromSpec);
  }, [effectiveSweepDeg, activeRangeMinDeg, activeRangeCenterDeg, servoSpecMin]);

  const maxTargetOffsetDeg = useMemo(() => {
    const half = effectiveSweepDeg * 0.5;
    const maxFromActive = activeRangeMaxDeg - half - activeRangeCenterDeg;
    const maxFromSpec = servoSpecMax - half - activeRangeCenterDeg;
    return Math.min(maxFromActive, maxFromSpec);
  }, [effectiveSweepDeg, activeRangeMaxDeg, activeRangeCenterDeg, servoSpecMax]);

  const normalizedMinTargetOffsetDeg = useMemo(
    () => Math.min(minTargetOffsetDeg, maxTargetOffsetDeg),
    [minTargetOffsetDeg, maxTargetOffsetDeg]
  );
  const normalizedMaxTargetOffsetDeg = useMemo(
    () => Math.max(minTargetOffsetDeg, maxTargetOffsetDeg),
    [minTargetOffsetDeg, maxTargetOffsetDeg]
  );

  const effectiveTargetOffsetDeg = useMemo(
    () => clamp(targetSweepOffsetDeg, normalizedMinTargetOffsetDeg, normalizedMaxTargetOffsetDeg),
    [targetSweepOffsetDeg, normalizedMinTargetOffsetDeg, normalizedMaxTargetOffsetDeg]
  );
  const targetCenterDeg = activeRangeCenterDeg + effectiveTargetOffsetDeg;

  const targetMinDeg = useMemo(() => {
    const half = effectiveSweepDeg * 0.5;
    return clamp(targetCenterDeg - half, activeRangeMinDeg, activeRangeMaxDeg);
  }, [effectiveSweepDeg, targetCenterDeg, activeRangeMinDeg, activeRangeMaxDeg]);

  const targetMaxDeg = useMemo(() => {
    const half = effectiveSweepDeg * 0.5;
    return clamp(targetCenterDeg + half, activeRangeMinDeg, activeRangeMaxDeg);
  }, [effectiveSweepDeg, targetCenterDeg, activeRangeMinDeg, activeRangeMaxDeg]);

  const commandLowerBound = useMemo(() => {
    const activeHalfSpan = activeSpanDeg * 0.5;
    if (activeHalfSpan <= 0.001) {
      return 0;
    }
    return clamp(((targetMinDeg - activeRangeCenterDeg) / activeHalfSpan) * 100, COMMAND_MIN, COMMAND_MAX);
  }, [targetMinDeg, activeRangeCenterDeg, activeSpanDeg]);

  const commandUpperBound = useMemo(() => {
    const activeHalfSpan = activeSpanDeg * 0.5;
    if (activeHalfSpan <= 0.001) {
      return 0;
    }
    return clamp(((targetMaxDeg - activeRangeCenterDeg) / activeHalfSpan) * 100, COMMAND_MIN, COMMAND_MAX);
  }, [targetMaxDeg, activeRangeCenterDeg, activeSpanDeg]);

  const commandLowerBoundPercent = useMemo(
    () => q(((commandLowerBound - COMMAND_MIN) / (COMMAND_MAX - COMMAND_MIN)) * 100),
    [commandLowerBound]
  );
  const commandUpperBoundPercent = useMemo(
    () => q(((commandUpperBound - COMMAND_MIN) / (COMMAND_MAX - COMMAND_MIN)) * 100),
    [commandUpperBound]
  );
  const lowerBoundLabelStyle = useMemo(() => {
    const edgeInsetPercent = 2.5;
    if (commandLowerBound <= -90) {
      return { left: `${edgeInsetPercent}%`, transform: "translateX(0)" };
    }
    return { left: `${commandLowerBoundPercent}%` };
  }, [commandLowerBound, commandLowerBoundPercent]);

  const upperBoundLabelStyle = useMemo(() => {
    const edgeInsetPercent = 97.5;
    if (commandUpperBound >= 90) {
      return { left: `${edgeInsetPercent}%`, transform: "translateX(-100%)" };
    }
    return { left: `${commandUpperBoundPercent}%` };
  }, [commandUpperBound, commandUpperBoundPercent]);

  const limitedCommandValue = useMemo(
    () => clamp(commandValue, commandLowerBound, commandUpperBound),
    [commandValue, commandLowerBound, commandUpperBound]
  );

  const previewAngleDeg = useMemo(() => {
    const activeHalfSpan = activeSpanDeg * 0.5;
    if (activeHalfSpan <= 0.001) {
      return activeRangeCenterDeg;
    }
    const desiredAngle = activeRangeCenterDeg + (limitedCommandValue / 100) * activeHalfSpan;
    return clamp(desiredAngle, targetMinDeg, targetMaxDeg);
  }, [activeSpanDeg, activeRangeCenterDeg, limitedCommandValue, targetMinDeg, targetMaxDeg]);

  const commandToTargetAngleDeg = (command: number): number => {
    const activeHalfSpan = activeSpanDeg * 0.5;
    if (activeHalfSpan <= 0.001) {
      return activeRangeCenterDeg;
    }
    const desiredAngle = activeRangeCenterDeg + (clamp(command, COMMAND_MIN, COMMAND_MAX) / 100) * activeHalfSpan;
    return clamp(desiredAngle, targetMinDeg, targetMaxDeg);
  };

  // Convert a firmware command (-100..100 in active-range frame) into the
  // target-frame command where 0 is target center and +/-100 reaches target
  // min/max. This makes displayed command data follow sweep offset transforms.
  const liveTargetCommandValue = useMemo(() => {
    const firmwareCmd = clamp(toNumber(telemetry.c, 0), COMMAND_MIN, COMMAND_MAX);
    const activeHalfSpan = activeSpanDeg * 0.5;
    const desiredAngle = activeHalfSpan <= 0.001
      ? activeRangeCenterDeg
      : activeRangeCenterDeg + (firmwareCmd / 100) * activeHalfSpan;
    const targetHalfSpan = (targetMaxDeg - targetMinDeg) * 0.5;
    if (targetHalfSpan <= 0.001) {
      return 0;
    }
    return clamp(((desiredAngle - targetCenterDeg) / targetHalfSpan) * 100, COMMAND_MIN, COMMAND_MAX);
  }, [telemetry.c, activeSpanDeg, activeRangeCenterDeg, targetCenterDeg, targetMinDeg, targetMaxDeg]);

  const mapDiagramAngle = (deg: number): number => {
    if (diagramZeroIsUp) {
      // In "0 is up" mode, map the zero-reference angle to 90deg (top of dial)
      // and display signed offsets around that runtime reference.
      const relative = deg - zeroReferenceDeg;
      const signed = diagramFlipDirection ? -relative : relative;
      return clamp(90 + signed, 0, 180);
    }
    return clamp(diagramFlipDirection ? 180 - deg : deg, 0, 180);
  };

  const formatAngleForDiagram = (deg: number): string => {
    if (diagramZeroIsUp) {
      const signed = Math.round((diagramFlipDirection ? -1 : 1) * (deg - zeroReferenceDeg));
      return `${signed > 0 ? "+" : ""}${signed} deg`;
    }
    const mapped = mapDiagramAngle(deg);
    return `${Math.round(mapped)} deg`;
  };

  const fmtSignedDeg = (value: number): string => {
    const rounded = Math.round(value);
    return `${rounded > 0 ? "+" : ""}${rounded}°`;
  };

  const leftTickLabel = diagramZeroIsUp
    ? fmtSignedDeg(diagramFlipDirection ? 90 : -90)
    : `${Math.round(mapDiagramAngle(0))}°`;
  const topTickLabel = diagramZeroIsUp ? "0°" : `${Math.round(mapDiagramAngle(90))}°`;
  const rightTickLabel = diagramZeroIsUp
    ? fmtSignedDeg(diagramFlipDirection ? -90 : 90)
    : `${Math.round(mapDiagramAngle(180))}°`;

  const zeroReferenceDeg = activeRangeCenterDeg;
  const fullArcPoints = useMemo(() => arcPolyline(0, 180, 122), []);
  const specPoints = useMemo(() => arcPolyline(mapDiagramAngle(servoSpecMin), mapDiagramAngle(servoSpecMax), 122), [servoSpecMin, servoSpecMax, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const rangePoints = useMemo(() => arcPolyline(mapDiagramAngle(rangeMinDeg), mapDiagramAngle(rangeMaxDeg), 118), [rangeMinDeg, rangeMaxDeg, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const activeSpanPoints = useMemo(() => arcPolyline(mapDiagramAngle(rangeMinDeg), mapDiagramAngle(rangeMaxDeg), 116), [rangeMinDeg, rangeMaxDeg, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const targetPoints = useMemo(() => arcPolyline(mapDiagramAngle(targetMinDeg), mapDiagramAngle(targetMaxDeg), 114), [targetMinDeg, targetMaxDeg, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const specMinTip = useMemo(() => pointForDegree(mapDiagramAngle(servoSpecMin), 124), [servoSpecMin, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const specMaxTip = useMemo(() => pointForDegree(mapDiagramAngle(servoSpecMax), 124), [servoSpecMax, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const currentTip = useMemo(() => pointForDegree(mapDiagramAngle(currentAngleDeg), 108), [currentAngleDeg, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const previewTip = useMemo(() => pointForDegree(mapDiagramAngle(previewAngleDeg), 96), [previewAngleDeg, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const rangeMinTip = useMemo(() => pointForDegree(mapDiagramAngle(rangeMinDeg), 126), [rangeMinDeg, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const rangeMaxTip = useMemo(() => pointForDegree(mapDiagramAngle(rangeMaxDeg), 126), [rangeMaxDeg, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const targetMinTip = useMemo(() => pointForDegree(mapDiagramAngle(targetMinDeg), 118), [targetMinDeg, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const targetMaxTip = useMemo(() => pointForDegree(mapDiagramAngle(targetMaxDeg), 118), [targetMaxDeg, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const targetMinLabelTip = useMemo(() => pointForDegree(mapDiagramAngle(targetMinDeg), 132), [targetMinDeg, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const targetMaxLabelTip = useMemo(() => pointForDegree(mapDiagramAngle(targetMaxDeg), 132), [targetMaxDeg, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const targetCenterTip = useMemo(() => pointForDegree(mapDiagramAngle(targetCenterDeg), 116), [targetCenterDeg, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const activeCenterTip = useMemo(() => pointForDegree(mapDiagramAngle(activeRangeCenterDeg), 120), [activeRangeCenterDeg, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const motionProfile = useMemo(
    () => buildMotionProfilePreview((commandUpperBound - commandLowerBound) * 0.5, maxVel, maxAccel),
    [commandLowerBound, commandUpperBound, maxVel, maxAccel]
  );
  const receivedTargetPosition = useMemo(() => {
    const targetHalfSpan = (targetMaxDeg - targetMinDeg) * 0.5;
    if (targetHalfSpan <= 0.001 || motionProfile.peakPosition <= 0.001) {
      return 0;
    }
    const normalized = (currentAngleDeg - targetCenterDeg) / targetHalfSpan;
    return clamp(normalized * motionProfile.peakPosition, -motionProfile.peakPosition, motionProfile.peakPosition);
  }, [currentAngleDeg, targetCenterDeg, targetMinDeg, targetMaxDeg, motionProfile.peakPosition]);
  const transitionCommands = useMemo(() => {
    const lower = commandLowerBound;
    const upper = commandUpperBound;
    const span = upper - lower;
    if (span <= 0.001 || motionProfile.accelSec <= 0 || motionProfile.peakAcceleration <= 0) {
      return null;
    }

    // Distance covered during accel (same magnitude as decel) in command units.
    const accelDistance = clamp(
      0.5 * motionProfile.peakAcceleration * motionProfile.accelSec * motionProfile.accelSec,
      0,
      span * 0.5
    );
    return {
      accelEnd: lower + accelDistance,
      decelStart: upper - accelDistance,
    };
  }, [commandLowerBound, commandUpperBound, motionProfile.accelSec, motionProfile.peakAcceleration]);
  const accelTransitionTip = useMemo(() => {
    if (!transitionCommands) {
      return null;
    }
    const angleDeg = commandToTargetAngleDeg(transitionCommands.accelEnd);
    return pointForDegree(mapDiagramAngle(angleDeg), 112);
  }, [transitionCommands, activeSpanDeg, activeRangeCenterDeg, targetMinDeg, targetMaxDeg, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);
  const decelTransitionTip = useMemo(() => {
    if (!transitionCommands) {
      return null;
    }
    const angleDeg = commandToTargetAngleDeg(transitionCommands.decelStart);
    return pointForDegree(mapDiagramAngle(angleDeg), 112);
  }, [transitionCommands, activeSpanDeg, activeRangeCenterDeg, targetMinDeg, targetMaxDeg, diagramFlipDirection, diagramZeroIsUp, zeroReferenceDeg]);

  const profilePlotWidth = PROFILE_GRAPH_WIDTH - PROFILE_PLOT_PAD_LEFT - PROFILE_PLOT_PAD_RIGHT;
  const profilePlotHeight = PROFILE_GRAPH_HEIGHT - PROFILE_PLOT_PAD_TOP - PROFILE_PLOT_PAD_BOTTOM;
  const profilePlotX0 = PROFILE_PLOT_PAD_LEFT;
  const profilePlotX1 = PROFILE_GRAPH_WIDTH - PROFILE_PLOT_PAD_RIGHT;
  const profilePlotY0 = PROFILE_PLOT_PAD_TOP;
  const profilePlotYMid = q(PROFILE_PLOT_PAD_TOP + profilePlotHeight * 0.5);
  const profilePlotY1 = PROFILE_GRAPH_HEIGHT - PROFILE_PLOT_PAD_BOTTOM;
  const profileLeftHalfX = q(profilePlotX0 + profilePlotWidth * 0.25);
  const profileRightHalfX = q(profilePlotX0 + profilePlotWidth * 0.75);
  const profilePlotTransform = `translate(${PROFILE_PLOT_PAD_LEFT}, ${PROFILE_PLOT_PAD_TOP}) scale(${q(profilePlotWidth / PROFILE_GRAPH_WIDTH)}, ${q(profilePlotHeight / PROFILE_GRAPH_HEIGHT)})`;

  // Generated marker: model-phase point from the same oscillator clock used
  // by command generation (cmd preview side).
  const generatedProfileSample = sampleMotionProfile(motionProfile, driveTimeRef.current);
  const generatedMarkerBaseX = motionProfile.fullCycleSec > 0.0001
    ? q((generatedProfileSample.phaseSec / motionProfile.fullCycleSec) * PROFILE_GRAPH_WIDTH)
    : 0;
  const generatedPositionMarkerBaseY = motionProfile.peakPosition > 0.0001
    ? q((1 - (generatedProfileSample.position + motionProfile.peakPosition) / (2 * motionProfile.peakPosition)) * PROFILE_GRAPH_HEIGHT)
    : q(PROFILE_GRAPH_HEIGHT * 0.5);
  const generatedVelocityMarkerBaseY = motionProfile.peakVelocity > 0.0001
    ? q((1 - (generatedProfileSample.velocity + motionProfile.peakVelocity) / (2 * motionProfile.peakVelocity)) * PROFILE_GRAPH_HEIGHT)
    : q(PROFILE_GRAPH_HEIGHT * 0.5);
  const generatedAccelMarkerBaseY = motionProfile.peakAcceleration > 0.0001
    ? q((1 - (generatedProfileSample.acceleration + motionProfile.peakAcceleration) / (2 * motionProfile.peakAcceleration)) * PROFILE_GRAPH_HEIGHT)
    : q(PROFILE_GRAPH_HEIGHT * 0.5);

  // Received-position marker: latest measured angle mapped into target-position units.
  // It shares X with the generated state (current profile time) so Y deviation is easy to read.
  const positionMarkerBaseY = motionProfile.peakPosition > 0.0001
    ? q((1 - (clamp(receivedTargetPosition, -motionProfile.peakPosition, motionProfile.peakPosition) + motionProfile.peakPosition) / (2 * motionProfile.peakPosition)) * PROFILE_GRAPH_HEIGHT)
    : q(PROFILE_GRAPH_HEIGHT * 0.5);
  const profileScaleX = profilePlotWidth / PROFILE_GRAPH_WIDTH;
  const profileScaleY = profilePlotHeight / PROFILE_GRAPH_HEIGHT;
  const generatedPositionMarkerX = q(profilePlotX0 + generatedMarkerBaseX * profileScaleX);
  const generatedPositionMarkerY = q(profilePlotY0 + generatedPositionMarkerBaseY * profileScaleY);
  const generatedVelocityMarkerX = q(profilePlotX0 + generatedMarkerBaseX * profileScaleX);
  const generatedVelocityMarkerY = q(profilePlotY0 + generatedVelocityMarkerBaseY * profileScaleY);
  const generatedAccelMarkerX = q(profilePlotX0 + generatedMarkerBaseX * profileScaleX);
  const generatedAccelMarkerY = q(profilePlotY0 + generatedAccelMarkerBaseY * profileScaleY);
  const positionMarkerX = q(profilePlotX0 + generatedMarkerBaseX * profileScaleX);
  const positionMarkerY = q(profilePlotY0 + positionMarkerBaseY * profileScaleY);
  const pwNowMs = Date.now();
  const pwPoints = useMemo(() => pulseWidthGraphPoints(pwHistory, pwNowMs), [pwHistory, pwNowMs]);
  const perfSparkPointsFor = (key: PerfSparkKey): string => timedSparkPoints(
    perfSparkHistories[key],
    pwNowMs,
    PERF_SPARK_BOUNDS[key].min,
    PERF_SPARK_BOUNDS[key].max
  );
  const perfWindowAverageFor = (key: PerfSparkKey): number | null =>
    timedWindowAverage(perfSparkHistories[key], pwNowMs);
  const formatPerfValue = (key: PerfSparkKey, value: number): string => {
    if (key === "lps") {
      return value.toFixed(1);
    }
    if (key === "odb") {
      return `${Math.round(value)} B`;
    }
    return `${Math.round(value)} us`;
  };
  const perfDisplayValue = (key: PerfSparkKey): string => {
    const avg = perfWindowAverageFor(key);
    const latestRaw = telemetry[key];
    const latest = latestRaw === undefined ? null : Number(latestRaw);

    const avgText = avg === null ? null : formatPerfValue(key, avg);
    const latestText = latest !== null && Number.isFinite(latest) ? formatPerfValue(key, latest) : null;

    if (avgText !== null && latestText !== null) {
      return `${avgText} | ${latestText}`;
    }
    if (avgText !== null) {
      return avgText;
    }
    if (latestText !== null) {
      return latestText;
    }
    return "-";
  };

  async function sendCommand(raw: string) {
    const bounded = clamp(toNumber(raw, 0), commandLowerBound, commandUpperBound);
    // Format to one decimal place (e.g. "37.0", "-50.0") so the value is
    // always unambiguous on the wire. Firmware accepts floats, so "37.0\n"
    // parses identically to "37\n".
    const payload = `${bounded.toFixed(1)}\n`;
    if (transportType === "serial") {
      if (!writerRef.current || sendBusyRef.current) {
        return;
      }
      sendBusyRef.current = true;
      try {
        await writerRef.current.write(new TextEncoder().encode(payload));
      } finally {
        sendBusyRef.current = false;
      }
    } else if (transportType === "ble") {
      if (!bleRxCharRef.current || sendBusyRef.current) {
        return;
      }
      sendBusyRef.current = true;
      try {
        await bleRxCharRef.current.writeValueWithoutResponse(new TextEncoder().encode(payload));
      } finally {
        sendBusyRef.current = false;
      }
    }
  }

  useEffect(() => {
    if (driveMode !== "oscillator") {
      prevProfileCycleSecRef.current = motionProfile.fullCycleSec;
      return;
    }

    const previousCycleSec = prevProfileCycleSecRef.current;
    const nextCycleSec = motionProfile.fullCycleSec;
    if (previousCycleSec !== null && previousCycleSec > 0.0001 && nextCycleSec > 0.0001) {
      // Keep normalized cycle progress continuous when profile timing changes
      // (for example after max velocity/acceleration edits).
      const previousPhaseSec = ((driveTimeRef.current % previousCycleSec) + previousCycleSec) % previousCycleSec;
      const phaseUnit = previousPhaseSec / previousCycleSec;
      driveTimeRef.current = phaseUnit * nextCycleSec;
    }

    prevProfileCycleSecRef.current = nextCycleSec;
  }, [motionProfile.fullCycleSec, driveMode]);

  useEffect(() => {
    if (!(connected && driveMode === "oscillator")) {
      return;
    }
    const periodMs = 1000 / autoMotionHz;
    const timer = window.setInterval(() => {
      const dt = periodMs / 1000;
      driveTimeRef.current += dt;
      const cycleSample = sampleMotionProfile(motionProfile, driveTimeRef.current);
      const center = (commandLowerBound + commandUpperBound) * 0.5;
      const cmd = clamp(center + cycleSample.position, COMMAND_MIN, COMMAND_MAX);
      const formatted = cmd.toFixed(1);
      setCommandInput(formatted);
      void sendCommand(formatted);
    }, periodMs);

    return () => window.clearInterval(timer);
  }, [connected, driveMode, autoMotionHz, commandLowerBound, commandUpperBound, motionProfile]);

  async function connect() {
    if (!navigator.serial) {
      setStatus("WebSerial unavailable in this browser context");
      return;
    }
    try {
      setConnectTips([]);
      setStatus("Requesting port...");
      const port = await navigator.serial.requestPort({ filters: SERIAL_PORT_FILTERS });
      await port.open({ baudRate: SERIAL_BAUD_RATE });
      portRef.current = port;

      if (!port.readable || !port.writable) {
        throw new Error("Serial stream unavailable");
      }

      readerRef.current = port.readable.getReader();
      writerRef.current = port.writable.getWriter();
      setTransportType("serial");
      setConnected(true);
      setStatus(`Connected via USB at ${SERIAL_BAUD_RATE} baud`);
      lastRxMsRef.current = 0;

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
          if (trackSerialHistory) {
            setLastLine(line);
          }
          const parsed = parseTelemetry(line);
          if (parsed !== null) {
            setTelemetry((prev) => ({ ...prev, ...parsed }));
            setSparkHistories((prev) => {
              const push = (arr: number[], v: string | undefined): number[] => {
                if (v === undefined) return arr;
                const n = Number(v);
                if (!Number.isFinite(n)) return arr;
                return [...arr, n].slice(-SPARK_MAX_POINTS);
              };
              return {
                c: push(prev.c, parsed.c),
                a: push(prev.a, parsed.a),
                pw: push(prev.pw, parsed.pw),
              };
            });
            setPerfSparkHistories((prev) => {
              const nowMs = Date.now();
              const pushTimed = (arr: TimedSample[], v: string | undefined): TimedSample[] => {
                const trimmed = arr.filter((s) => s.tMs >= nowMs - PERF_SPARK_WINDOW_MS - 2000);
                if (v === undefined) {
                  return trimmed;
                }
                const n = Number(v);
                if (!Number.isFinite(n)) {
                  return trimmed;
                }
                return [...trimmed, { tMs: nowMs, value: n }];
              };
              return {
                lps: pushTimed(prev.lps, parsed.lps),
                lp: pushTimed(prev.lp, parsed.lp),
                lpa: pushTimed(prev.lpa, parsed.lpa),
                lpm: pushTimed(prev.lpm, parsed.lpm),
                lu: pushTimed(prev.lu, parsed.lu),
                lm: pushTimed(prev.lm, parsed.lm),
                si: pushTimed(prev.si, parsed.si),
                cm: pushTimed(prev.cm, parsed.cm),
                ps: pushTimed(prev.ps, parsed.ps),
                so: pushTimed(prev.so, parsed.so),
                st: pushTimed(prev.st, parsed.st),
                od: pushTimed(prev.od, parsed.od),
                odr: pushTimed(prev.odr, parsed.odr),
                odx: pushTimed(prev.odx, parsed.odx),
                odb: pushTimed(prev.odb, parsed.odb),
                hb: pushTimed(prev.hb, parsed.hb),
              };
            });
            if (parsed.pw !== undefined) {
              const n = Number(parsed.pw);
              if (Number.isFinite(n)) {
                const nowMs = Date.now();
                setPwHistory((prev) => [...prev, { tMs: nowMs, value: n }].filter((s) => s.tMs >= nowMs - PW_GRAPH_WINDOW_MS - 2000));
              }
            }
          }
          if (trackSerialHistory) {
            setHistory((prev) => [line, ...prev].slice(0, 120));
          }
          setLastRxAt(new Date().toLocaleTimeString());
          lastRxMsRef.current = Date.now();
          setStale(false);
        }
      }
    } catch (error) {
      const info = explainConnectError(error);
      setStatus(info.summary);
      setConnectTips(info.tips);
      setConnected(false);
      setTransportType(null);
    }
  }

  async function connectBle() {
    if (!navigator.bluetooth) {
      setStatus("Web Bluetooth unavailable in this browser context");
      return;
    }
    try {
      setConnectTips([]);
      setStatus("Opening Bluetooth picker...");
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [NUS_SERVICE_UUID] }],
        optionalServices: [NUS_SERVICE_UUID]
      });
      bleDeviceRef.current = device;
      setStatus("Connecting via Bluetooth...");
      const server = await device.gatt!.connect();
      const service = await server.getPrimaryService(NUS_SERVICE_UUID);
      const txChar = await service.getCharacteristic(NUS_TX_CHAR_UUID);
      const rxChar = await service.getCharacteristic(NUS_RX_CHAR_UUID);
      bleRxCharRef.current = rxChar;

      // Subscribe to telemetry notifications from the device.
      // BLE notifications may not align with newline boundaries, so buffer
      // partial frames the same way as the serial reader.
      bleTxCharRef.current = txChar;
      bleBufRef.current = "";
      lastRxMsRef.current = 0;
      await txChar.startNotifications();
      // Name the listener and store it in a ref so it can be removed on
      // disconnect.  An anonymous listener added here can never be removed,
      // which means every reconnect adds another active listener — they pile
      // up and each one calls setState 5+ times per 50 ms frame, eventually
      // freezing the browser tab.
      const bleListener = (event: Event) => {
        const char = event.target as BluetoothRemoteGATTCharacteristic;
        const text = new TextDecoder().decode(char.value ?? new DataView(new ArrayBuffer(0)));
        bleBufRef.current += text;
        const lines = bleBufRef.current.split(/\r?\n/);
        bleBufRef.current = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          if (trackSerialHistory) {
            setLastLine(line);
          }
          const parsedBle = parseTelemetry(line);
          if (parsedBle !== null) {
            setTelemetry((prev) => ({ ...prev, ...parsedBle }));
            setSparkHistories((prev) => {
              const push = (arr: number[], v: string | undefined): number[] => {
                if (v === undefined) return arr;
                const n = Number(v);
                if (!Number.isFinite(n)) return arr;
                return [...arr, n].slice(-SPARK_MAX_POINTS);
              };
              return {
                c: push(prev.c, parsedBle.c),
                a: push(prev.a, parsedBle.a),
                pw: push(prev.pw, parsedBle.pw),
              };
            });
            setPerfSparkHistories((prev) => {
              const nowMs = Date.now();
              const pushTimed = (arr: TimedSample[], v: string | undefined): TimedSample[] => {
                const trimmed = arr.filter((s) => s.tMs >= nowMs - PERF_SPARK_WINDOW_MS - 2000);
                if (v === undefined) {
                  return trimmed;
                }
                const n = Number(v);
                if (!Number.isFinite(n)) {
                  return trimmed;
                }
                return [...trimmed, { tMs: nowMs, value: n }];
              };
              return {
                lps: pushTimed(prev.lps, parsedBle.lps),
                lp: pushTimed(prev.lp, parsedBle.lp),
                lpa: pushTimed(prev.lpa, parsedBle.lpa),
                lpm: pushTimed(prev.lpm, parsedBle.lpm),
                lu: pushTimed(prev.lu, parsedBle.lu),
                lm: pushTimed(prev.lm, parsedBle.lm),
                si: pushTimed(prev.si, parsedBle.si),
                cm: pushTimed(prev.cm, parsedBle.cm),
                ps: pushTimed(prev.ps, parsedBle.ps),
                so: pushTimed(prev.so, parsedBle.so),
                st: pushTimed(prev.st, parsedBle.st),
                od: pushTimed(prev.od, parsedBle.od),
                odr: pushTimed(prev.odr, parsedBle.odr),
                odx: pushTimed(prev.odx, parsedBle.odx),
                odb: pushTimed(prev.odb, parsedBle.odb),
                hb: pushTimed(prev.hb, parsedBle.hb),
              };
            });
            if (parsedBle.pw !== undefined) {
              const n = Number(parsedBle.pw);
              if (Number.isFinite(n)) {
                const nowMs = Date.now();
                setPwHistory((prev) => [...prev, { tMs: nowMs, value: n }].filter((s) => s.tMs >= nowMs - PW_GRAPH_WINDOW_MS - 2000));
              }
            }
          }
          if (trackSerialHistory) {
            setHistory((prev) => [line, ...prev].slice(0, 120));
          }
          setLastRxAt(new Date().toLocaleTimeString());
          lastRxMsRef.current = Date.now();
          setStale(false);
        }
      };
      bleTxListenerRef.current = bleListener;
      txChar.addEventListener("characteristicvaluechanged", bleListener);

      device.addEventListener("gattserverdisconnected", () => {
        // Remove the named TX listener before clearing refs. This is the
        // critical cleanup step that prevents listener accumulation across
        // multiple disconnect/reconnect cycles.
        if (bleTxListenerRef.current && bleTxCharRef.current) {
          try { void bleTxCharRef.current.stopNotifications(); } catch { /* ignore */ }
          bleTxCharRef.current.removeEventListener("characteristicvaluechanged", bleTxListenerRef.current);
        }
        bleTxListenerRef.current = null;
        bleTxCharRef.current = null;
        bleDeviceRef.current = null;
        bleRxCharRef.current = null;
        setConnected(false);
        setTransportType(null);
        setStatus("Bluetooth disconnected");
      });

      setTransportType("ble");
      setConnected(true);
      setStatus(`Connected via Bluetooth — ${device.name ?? "Colloquy Pointer"}`);
    } catch (error) {
      const info = explainBleConnectError(error);
      setStatus(info.summary);
      setConnectTips(info.tips);
      setConnected(false);
      setTransportType(null);
    }
  }

  async function disconnect() {
    if (transportType === "ble") {
      try {
        // Stop notifications and remove the listener before disconnecting so
        // it cannot fire during or after teardown.
        if (bleTxListenerRef.current && bleTxCharRef.current) {
          try { void bleTxCharRef.current.stopNotifications(); } catch { /* ignore */ }
          bleTxCharRef.current.removeEventListener("characteristicvaluechanged", bleTxListenerRef.current);
        }
        bleDeviceRef.current?.gatt?.disconnect();
      } catch {
        // Ignore cleanup errors.
      } finally {
        bleTxListenerRef.current = null;
        bleTxCharRef.current = null;
        bleDeviceRef.current = null;
        bleRxCharRef.current = null;
      }
    } else {
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
      }
    }
    setConnected(false);
    setTransportType(null);
    setStatus("Disconnected");
    setConnectTips([]);
    driveTimeRef.current = 0;
  }

  function activateDriveMode(next: DashboardDriveMode) {
    setDriveMode(next);
    if (next === "oscillator") {
      driveTimeRef.current = 0;
    }
  }

  // Keep the command textbox within the currently valid command envelope.
  useEffect(() => {
    setCommandInput((prev) => {
      const bounded = clamp(toNumber(prev, 0), commandLowerBound, commandUpperBound);
      return bounded.toFixed(1);
    });
  }, [commandLowerBound, commandUpperBound]);

  // Clamp target offset whenever active span/sweep changes.
  useEffect(() => {
    setTargetSweepOffsetDeg((prev) => clamp(prev, normalizedMinTargetOffsetDeg, normalizedMaxTargetOffsetDeg));
  }, [normalizedMinTargetOffsetDeg, normalizedMaxTargetOffsetDeg]);

  // If sweep target changes while in manual mode, push an updated clamped
  // command immediately so physical motion follows the new target envelope.
  useEffect(() => {
    if (!(connected && driveMode === "manual")) {
      return;
    }
    if (telemetry.m === "o") {
      return; // firmware switch is in oscillation mode; serial commands are ignored.
    }
    const bounded = clamp(toNumber(commandInput, 0), commandLowerBound, commandUpperBound);
    void sendCommand(bounded.toFixed(1));
  }, [commandLowerBound, commandUpperBound, connected, driveMode, telemetry.m]);

  return (
    <main className="console-page compact-console">
      <div className="console-header">
        <h1>Virtual Colloquy Console</h1>
        <p>Focused controls: connect, stream data, motion profile, and servo arc.</p>
      </div>

      <div className="compact-layout">
        <div className="left-stack">
          <section className="card panel-tight">
            <h2>Connection</h2>
            <div className="row" style={{ marginBottom: 8 }}>
              <button className="primary" onClick={connect} disabled={!supported || connected} title="Connect via USB cable">
                USB Connect
              </button>
              <button className="primary" onClick={connectBle} disabled={!bleSupported || connected} title="Connect via Bluetooth (BLE)">
                Bluetooth Connect
              </button>
              <button onClick={disconnect} disabled={!connected}>Disconnect</button>
            </div>
            <div className={connected ? "badge ok" : "badge warn"}>{status}</div>
            {!supported && !bleSupported && <p style={{ marginTop: 8 }}>WebSerial and Web Bluetooth both need Chromium on localhost/https.</p>}
            {!supported && bleSupported && <p style={{ marginTop: 8 }}>USB requires Chromium. Bluetooth is available.</p>}
            {supported && !bleSupported && <p style={{ marginTop: 8 }}>Bluetooth requires Chromium. USB is available.</p>}
            {connectTips.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {connectTips.slice(0, 2).map((tip, index) => (
                  <p key={`${tip}-${index}`} style={{ marginTop: index === 0 ? 0 : 4 }}>{tip}</p>
                ))}
              </div>
            )}
          </section>

          <section className="card panel-tight">
                <h1>Colloquy of Mobiles Virtual Simulation Phygital</h1>
            <div className="kv"><span>last receive</span><code>{lastRxAt}</code></div>
            <div className="kv"><span>firmware</span><code>{telemetry.fv ?? "-"}</code></div>
            <div className="kv">
              <span>track serial history</span>
              <input
                type="checkbox"
                checked={trackSerialHistory}
                onChange={(e) => setTrackSerialHistory(e.target.checked)}
                aria-label="Track serial history"
              />
            </div>
            {connected && stale && (
              <div className="badge warn" style={{ marginBottom: 4 }}>no data — device may be frozen</div>
            )}
            <div className="kv"><span>mode</span><code>{telemetry.m === "o" ? "motion profile" : telemetry.m === "s" ? "serial" : "-"}</code></div>
            <div className="kv"><span>guard</span><span className={guardBadgeClass}>{telemetry.g === "1" ? "timeout" : telemetry.g === "0" ? "ok" : "n/a"}</span></div>
            <div className="kv kv-spark">
              <span>command (target frame)</span>
              <span className="spark-cell">
                <svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">
                  <line x1="0" y1="14" x2="200" y2="14" className="spark-mid" />
                  {sparkHistories.c.length > 1 && <polyline points={sparkPoints(sparkHistories.c, SPARK_BOUNDS.c.min, SPARK_BOUNDS.c.max)} className="spark-line" />}
                </svg>
                <code>{liveTargetCommandValue.toFixed(1)}</code>
              </span>
            </div>
            <div className="kv kv-spark">
              <span>servo angle</span>
              <span className="spark-cell">
                <svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">
                  {sparkHistories.a.length > 1 && <polyline points={sparkPoints(sparkHistories.a, SPARK_BOUNDS.a.min, SPARK_BOUNDS.a.max)} className="spark-line spark-line-angle" />}
                </svg>
                <code>{formatAngleForDiagram(currentAngleDeg)}</code>
              </span>
            </div>
            {/* Signal chain: shows the full cmd → angle → pulse path so the
                entire mapping from dashboard command to servo hardware is visible. */}
            <div className="kv">
              <span>signal chain</span>
              <code>
                {liveTargetCommandValue.toFixed(1)} → {formatAngleForDiagram(currentAngleDeg)} → {telemetry.pw ? `${telemetry.pw} µs` : "?"}
              </code>
            </div>
            <div className="kv"><span>range</span><code>{formatAngleForDiagram(activeRangeMinDeg)} – {formatAngleForDiagram(activeRangeMaxDeg)}</code></div>
            <div className="kv kv-spark">
              <span>pulse width</span>
              <span className="spark-cell">
                <svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">
                  <line
                    x1="0"
                    y1={q((1 - (1500 - SPARK_BOUNDS.pw.min) / (SPARK_BOUNDS.pw.max - SPARK_BOUNDS.pw.min)) * 28)}
                    x2="200"
                    y2={q((1 - (1500 - SPARK_BOUNDS.pw.min) / (SPARK_BOUNDS.pw.max - SPARK_BOUNDS.pw.min)) * 28)}
                    className="spark-mid"
                  />
                  {sparkHistories.pw.length > 1 && <polyline points={sparkPoints(sparkHistories.pw, SPARK_BOUNDS.pw.min, SPARK_BOUNDS.pw.max)} className="spark-line spark-line-pw" />}
                </svg>
                <code>{telemetry.pw ? `${telemetry.pw} µs` : "-"}</code>
              </span>
            </div>
          </section>

          {trackSerialHistory && (
            <section className="card panel-tight">
              <h2>Serial History</h2>
              <div className="log log-small" style={{ marginBottom: 8 }}>{lastLine}</div>
              <details>
                <summary>Show recent lines</summary>
                <div className="log history-log" style={{ marginTop: 8 }}>
                  {history.length === 0 ? "No lines received yet." : history.map((line, i) => <div key={`${line}-${i}`}>{line}</div>)}
                </div>
              </details>
            </section>
          )}
        </div>

        <div className="perf-stack">
          <section className="card panel-tight perf-panel-card">
            <h2>Performance Diagnostics</h2>
              <div className="perf-grid">
                <div className="kv"><span>perf stream</span><code>{perfStreamActive ? "active" : "waiting"}</code></div>
                <div className="kv"><span>value format</span><code>avg | latest</code></div>
                <div className="kv kv-spark"><span>loop/sec (avg)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.lps.length > 1 && <polyline points={perfSparkPointsFor("lps")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("lps")}</code></span></div>
                <div className="kv kv-spark"><span>loop period latest (lp)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.lp.length > 1 && <polyline points={perfSparkPointsFor("lp")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("lp")}</code></span></div>
                <div className="kv kv-spark"><span>loop period window avg (lpa)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.lpa.length > 1 && <polyline points={perfSparkPointsFor("lpa")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("lpa")}</code></span></div>
                <div className="kv kv-spark"><span>loop period window max (lpm)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.lpm.length > 1 && <polyline points={perfSparkPointsFor("lpm")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("lpm")}</code></span></div>
                <div className="kv kv-spark"><span>loop duration (lu avg)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.lu.length > 1 && <polyline points={perfSparkPointsFor("lu")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("lu")}</code></span></div>
                <div className="kv kv-spark"><span>max loop work (lm avg)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.lm.length > 1 && <polyline points={perfSparkPointsFor("lm")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("lm")}</code></span></div>
                <div className="kv kv-spark"><span>serial in (si avg)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.si.length > 1 && <polyline points={perfSparkPointsFor("si")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("si")}</code></span></div>
                <div className="kv kv-spark"><span>mode update (cm avg)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.cm.length > 1 && <polyline points={perfSparkPointsFor("cm")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("cm")}</code></span></div>
                <div className="kv kv-spark"><span>pot sample (ps avg)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.ps.length > 1 && <polyline points={perfSparkPointsFor("ps")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("ps")}</code></span></div>
                <div className="kv kv-spark"><span>servo out (so avg)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.so.length > 1 && <polyline points={perfSparkPointsFor("so")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("so")}</code></span></div>
                <div className="kv kv-spark"><span>status emit (st avg)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.st.length > 1 && <polyline points={perfSparkPointsFor("st")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("st")}</code></span></div>
                <div className="kv kv-spark"><span>oled draw (od avg)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.od.length > 1 && <polyline points={perfSparkPointsFor("od")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("od")}</code></span></div>
                <div className="kv kv-spark"><span>oled render (odr avg)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.odr.length > 1 && <polyline points={perfSparkPointsFor("odr")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("odr")}</code></span></div>
                <div className="kv kv-spark"><span>oled transfer (odx avg)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.odx.length > 1 && <polyline points={perfSparkPointsFor("odx")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("odx")}</code></span></div>
                <div className="kv kv-spark"><span>oled bytes (odb avg)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.odb.length > 1 && <polyline points={perfSparkPointsFor("odb")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("odb")}</code></span></div>
                <div className="kv kv-spark"><span>heartbeat (hb avg)</span><span className="spark-cell"><svg className="spark" viewBox="0 0 200 28" preserveAspectRatio="none" aria-hidden="true">{perfSparkHistories.hb.length > 1 && <polyline points={perfSparkPointsFor("hb")} className="spark-line spark-line-lu" />}</svg><code>{perfDisplayValue("hb")}</code></span></div>
              </div>
          </section>
        </div>

        <div className="motion-stack">
        <section className="card panel-tight">
          <h2>Motion Profile</h2>
          <div className="row" style={{ marginBottom: 8 }}>
            <button className={driveMode === "manual" ? "primary" : ""} onClick={() => activateDriveMode("manual")}>Manual</button>
            {AUTO_MOTION_RATE_OPTIONS.map((hz) => (
              <button
                key={`auto-rate-${hz}`}
                className={driveMode === "oscillator" && autoMotionHz === hz ? "primary" : ""}
                onClick={() => {
                  setAutoMotionHz(hz);
                  activateDriveMode("oscillator");
                }}
                title={`Run auto motion at ${hz} Hz`}
              >
                Auto {hz} Hz
              </button>
            ))}
          </div>
          <label className="dial-label" htmlFor="command-slider">Command ({limitedCommandValue.toFixed(1)})</label>
          <div className="command-slider-wrap">
            <input
              id="command-slider"
              className="command-slider"
              type="range"
              min={COMMAND_MIN}
              max={COMMAND_MAX}
              step={0.1}
              value={limitedCommandValue}
              onChange={(e) => setCommandInput(e.target.value)}
              disabled={driveMode === "oscillator"}
              style={{
                background: `linear-gradient(to right,
                  #d9d4c7 0%,
                  #d9d4c7 ${commandLowerBoundPercent}%,
                  #007f5f ${commandLowerBoundPercent}%,
                  #007f5f ${commandUpperBoundPercent}%,
                  #d9d4c7 ${commandUpperBoundPercent}%,
                  #d9d4c7 100%)`
              }}
            />
            <div className="command-bound-marker" style={{ left: `${commandLowerBoundPercent}%` }} aria-hidden="true" />
            <div className="command-bound-marker" style={{ left: `${commandUpperBoundPercent}%` }} aria-hidden="true" />
            <div className="command-bound-label" style={lowerBoundLabelStyle} aria-hidden="true">
              {commandLowerBound.toFixed(1)}
            </div>
            <div className="command-bound-label" style={upperBoundLabelStyle} aria-hidden="true">
              {commandUpperBound.toFixed(1)}
            </div>
          </div>
          <div className="row command-send-row" style={{ marginTop: 8, marginBottom: 10 }}>
            <input type="text" value={commandInput} onChange={(e) => setCommandInput(e.target.value)} disabled={driveMode === "oscillator"} placeholder="-100 to 100" />
            <button className="primary" disabled={!connected || driveMode === "oscillator"} onClick={() => sendCommand(commandInput)}>Send</button>
          </div>
          <div className="kv"><span>max velocity (units/s)</span><input type="number" min={0} max={200} step={0.5} value={maxVel} onChange={(e) => setMaxVel(clamp(Number(e.target.value), 0, 200))} /></div>
          <div className="kv"><span>max acceleration (units/s²)</span><input type="number" min={0} max={200} step={0.5} value={maxAccel} onChange={(e) => setMaxAccel(clamp(Number(e.target.value), 0, 200))} /></div>
          <div className="profile-graph" aria-label="Trapezoidal motion profile preview">
            <div className="profile-subgraph-wrap">
              <div className="profile-subgraph-title">velocity v(t)</div>
              <svg viewBox={`0 0 ${PROFILE_GRAPH_WIDTH} ${PROFILE_GRAPH_HEIGHT}`} role="img" aria-label="Velocity versus time graph">
                <rect
                  x={profilePlotX0}
                  y={profilePlotY0}
                  width={profilePlotWidth}
                  height={profilePlotHeight}
                  className="profile-plot-boundary"
                />
                <g transform={profilePlotTransform}>
                  <line x1="0" y1="0" x2={PROFILE_GRAPH_WIDTH} y2="0" className="profile-limitline" />
                  <line x1="0" y1={PROFILE_GRAPH_HEIGHT / 2} x2={PROFILE_GRAPH_WIDTH} y2={PROFILE_GRAPH_HEIGHT / 2} className="profile-midline" />
                  <line x1="0" y1={PROFILE_GRAPH_HEIGHT} x2={PROFILE_GRAPH_WIDTH} y2={PROFILE_GRAPH_HEIGHT} className="profile-limitline" />
                  {motionProfile.phaseBoundariesX.map((x) => (
                    <line key={`v-boundary-${x}`} x1={x} y1="0" x2={x} y2={PROFILE_GRAPH_HEIGHT} className="profile-phase-divider" />
                  ))}
                  <polyline points={motionProfile.velocityPoints} className="profile-wave profile-wave-velocity" />
                </g>
                {driveMode === "oscillator" && <circle cx={generatedVelocityMarkerX} cy={generatedVelocityMarkerY} r="3.8" className="profile-marker profile-marker-generated" />}
                <text x="6" y={q(profilePlotY0 + 4)} className="profile-axis-label">+{motionProfile.peakVelocity.toFixed(1)} u/s</text>
                <text x="6" y={q(profilePlotYMid - 2)} className="profile-axis-label">0.0 u/s</text>
                <text x="6" y={q(profilePlotY1 - 2)} className="profile-axis-label">-{motionProfile.peakVelocity.toFixed(1)} u/s</text>
                <text x={profileLeftHalfX} y={q(profilePlotY0 + 10)} textAnchor="middle" className="profile-segment-label">A</text>
                <text x={profileRightHalfX} y={q(profilePlotY0 + 10)} textAnchor="middle" className="profile-segment-label">B</text>
                <text x={profilePlotX0} y={q(profilePlotY1 + 12)} className="profile-axis-label">t=0</text>
                <text x={profilePlotX1} y={q(profilePlotY1 + 12)} textAnchor="end" className="profile-axis-label">t=max</text>
              </svg>
            </div>
            <div className="profile-subgraph-wrap" style={{ marginTop: 8 }}>
              <div className="profile-subgraph-title">acceleration a(t)</div>
              <svg viewBox={`0 0 ${PROFILE_GRAPH_WIDTH} ${PROFILE_GRAPH_HEIGHT}`} role="img" aria-label="Acceleration versus time graph">
                <rect
                  x={profilePlotX0}
                  y={profilePlotY0}
                  width={profilePlotWidth}
                  height={profilePlotHeight}
                  className="profile-plot-boundary"
                />
                <g transform={profilePlotTransform}>
                  <line x1="0" y1="0" x2={PROFILE_GRAPH_WIDTH} y2="0" className="profile-limitline" />
                  <line x1="0" y1={PROFILE_GRAPH_HEIGHT / 2} x2={PROFILE_GRAPH_WIDTH} y2={PROFILE_GRAPH_HEIGHT / 2} className="profile-midline" />
                  <line x1="0" y1={PROFILE_GRAPH_HEIGHT} x2={PROFILE_GRAPH_WIDTH} y2={PROFILE_GRAPH_HEIGHT} className="profile-limitline" />
                  {motionProfile.phaseBoundariesX.map((x) => (
                    <line key={`a-boundary-${x}`} x1={x} y1="0" x2={x} y2={PROFILE_GRAPH_HEIGHT} className="profile-phase-divider" />
                  ))}
                  <polyline points={motionProfile.accelerationPoints} className="profile-wave profile-wave-accel" />
                </g>
                {driveMode === "oscillator" && <circle cx={generatedAccelMarkerX} cy={generatedAccelMarkerY} r="3.8" className="profile-marker profile-marker-generated" />}
                <text x="6" y={q(profilePlotY0 + 4)} className="profile-axis-label">+{motionProfile.peakAcceleration.toFixed(1)} u/s²</text>
                <text x="6" y={q(profilePlotYMid - 2)} className="profile-axis-label">0.0 u/s²</text>
                <text x="6" y={q(profilePlotY1 - 2)} className="profile-axis-label">-{motionProfile.peakAcceleration.toFixed(1)} u/s²</text>
                <text x={profileLeftHalfX} y={q(profilePlotY0 + 10)} textAnchor="middle" className="profile-segment-label">A</text>
                <text x={profileRightHalfX} y={q(profilePlotY0 + 10)} textAnchor="middle" className="profile-segment-label">B</text>
                <text x={profilePlotX0} y={q(profilePlotY1 + 12)} className="profile-axis-label">t=0</text>
                <text x={profilePlotX1} y={q(profilePlotY1 + 12)} textAnchor="end" className="profile-axis-label">t=max</text>
              </svg>
            </div>
            <div className="profile-subgraph-wrap" style={{ marginTop: 8 }}>
              <div className="profile-subgraph-title">position p(t)</div>
              <svg viewBox={`0 0 ${PROFILE_GRAPH_WIDTH} ${PROFILE_GRAPH_HEIGHT}`} role="img" aria-label="Position versus time graph">
                <rect
                  x={profilePlotX0}
                  y={profilePlotY0}
                  width={profilePlotWidth}
                  height={profilePlotHeight}
                  className="profile-plot-boundary"
                />
                <g transform={profilePlotTransform}>
                  <line x1="0" y1="0" x2={PROFILE_GRAPH_WIDTH} y2="0" className="profile-limitline" />
                  <line x1="0" y1={PROFILE_GRAPH_HEIGHT / 2} x2={PROFILE_GRAPH_WIDTH} y2={PROFILE_GRAPH_HEIGHT / 2} className="profile-midline" />
                  <line x1="0" y1={PROFILE_GRAPH_HEIGHT} x2={PROFILE_GRAPH_WIDTH} y2={PROFILE_GRAPH_HEIGHT} className="profile-limitline" />
                  {motionProfile.phaseBoundariesX.map((x) => (
                    <line key={`p-boundary-${x}`} x1={x} y1="0" x2={x} y2={PROFILE_GRAPH_HEIGHT} className="profile-phase-divider" />
                  ))}
                  <polyline points={motionProfile.positionPoints} className="profile-wave profile-wave-position" />
                </g>
                {driveMode === "oscillator" && <circle cx={generatedPositionMarkerX} cy={generatedPositionMarkerY} r="3.8" className="profile-marker profile-marker-generated" />}
                {driveMode === "oscillator" && <circle cx={positionMarkerX} cy={positionMarkerY} r="3.0" className="profile-marker profile-marker-live profile-marker-position" />}
                <text x="6" y={q(profilePlotY0 + 4)} className="profile-axis-label">+{motionProfile.peakPosition.toFixed(1)} u</text>
                <text x="6" y={q(profilePlotYMid - 2)} className="profile-axis-label">0.0 u</text>
                <text x="6" y={q(profilePlotY1 - 2)} className="profile-axis-label">-{motionProfile.peakPosition.toFixed(1)} u</text>
                <text x={profileLeftHalfX} y={q(profilePlotY0 + 10)} textAnchor="middle" className="profile-segment-label">A</text>
                <text x={profileRightHalfX} y={q(profilePlotY0 + 10)} textAnchor="middle" className="profile-segment-label">B</text>
                <text x={profilePlotX0} y={q(profilePlotY1 + 12)} className="profile-axis-label">t=0</text>
                <text x={profilePlotX1} y={q(profilePlotY1 + 12)} textAnchor="end" className="profile-axis-label">t=max</text>
              </svg>
            </div>
            <div className="profile-graph-meta">
              <span>vmax {motionProfile.peakVelocity.toFixed(1)} u/s</span>
              <span>amax {motionProfile.peakAcceleration.toFixed(1)} u/s²</span>
              <span>accel {motionProfile.accelSec.toFixed(2)}s</span>
              <span>cruise {motionProfile.cruiseSec.toFixed(2)}s</span>
              <span>decel {motionProfile.decelSec.toFixed(2)}s</span>
              <span>A→B {motionProfile.halfCycleSec.toFixed(2)}s</span>
              <span>A→B→A {motionProfile.fullCycleSec.toFixed(2)}s</span>
            </div>
          </div>
        </section>
        </div>

        <div className="servo-stack">
        <section className="card panel-tight servo-panel">
          <h2>Servo Position Diagram</h2>
          <div className="dial-legend">
            <span><svg width="16" height="8"><polyline points="0,4 16,4" stroke="#8e6da9" strokeWidth="3" fill="none"/></svg>spec range</span>
            <span><svg width="16" height="8"><polyline points="0,4 16,4" stroke="#007f5f" strokeWidth="3" fill="none"/></svg>active range</span>
            <span><svg width="16" height="8"><polyline points="0,4 16,4" stroke="#2f8f78" strokeWidth="2" strokeDasharray="5 3" fill="none"/></svg>device active span</span>
            <span><svg width="16" height="8"><polyline points="0,4 16,4" stroke="#2f5f9e" strokeWidth="3" fill="none"/></svg>target range</span>
            <span><svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke="#c85f2f" strokeWidth="2"/></svg>live angle</span>
            <span><svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke="#0b6aa8" strokeWidth="2" strokeDasharray="3 2"/></svg>cmd preview</span>
            <span><svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke="#6d6b64" strokeWidth="1.5" strokeDasharray="2 2"/></svg>cmd zero</span>
            <span><svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke="#b7791f" strokeWidth="1.5" strokeDasharray="3 2"/></svg>accel transitions</span>
          </div>
          <div className="dial-wrap dial-wrap-compact">
            <svg viewBox="0 0 320 170" className="dial" role="img" aria-label="Servo range dial">
              <polyline className="dial-track" points={fullArcPoints} />
              <polyline className="dial-spec" points={specPoints} />
              <polyline className="dial-range" points={rangePoints} />
              <polyline className="dial-device-span" points={activeSpanPoints} />
              <polyline className="dial-target" points={targetPoints} />
              <line x1="160" y1="150" x2={specMinTip.x} y2={specMinTip.y} className="dial-spec-bound" />
              <line x1="160" y1="150" x2={specMaxTip.x} y2={specMaxTip.y} className="dial-spec-bound" />
              <line x1="160" y1="150" x2={rangeMinTip.x} y2={rangeMinTip.y} className="dial-bound" />
              <line x1="160" y1="150" x2={rangeMaxTip.x} y2={rangeMaxTip.y} className="dial-bound" />
              <line x1="160" y1="150" x2={targetMinTip.x} y2={targetMinTip.y} className="dial-target-bound" />
              <line x1="160" y1="150" x2={targetMaxTip.x} y2={targetMaxTip.y} className="dial-target-bound" />
              {accelTransitionTip && <line x1="160" y1="150" x2={accelTransitionTip.x} y2={accelTransitionTip.y} className="dial-accel-transition" />}
              {decelTransitionTip && <line x1="160" y1="150" x2={decelTransitionTip.x} y2={decelTransitionTip.y} className="dial-accel-transition" />}
              <text x={targetMinLabelTip.x} y={targetMinLabelTip.y} className="dial-ab-label" textAnchor="middle" dominantBaseline="middle">A</text>
              <text x={targetMaxLabelTip.x} y={targetMaxLabelTip.y} className="dial-ab-label" textAnchor="middle" dominantBaseline="middle">B</text>
              <line x1="160" y1="150" x2={targetCenterTip.x} y2={targetCenterTip.y} className="dial-target-center" />
              <line x1="160" y1="150" x2={activeCenterTip.x} y2={activeCenterTip.y} className="dial-center" />
              <line x1="160" y1="150" x2={previewTip.x} y2={previewTip.y} className="dial-preview" />
              <line x1="160" y1="150" x2={currentTip.x} y2={currentTip.y} className="dial-current" />
              <circle cx="160" cy="150" r="6" className="dial-hub" />
              <text x="8" y="167" className="dial-tick">{leftTickLabel}</text>
              <text x="160" y="16" className="dial-tick" style={{ textAnchor: "middle" }}>{topTickLabel}</text>
              <text x="312" y="167" className="dial-tick" style={{ textAnchor: "end" }}>{rightTickLabel}</text>
            </svg>
            <div className="dial-stats">
              <div className="dial-stats-col" aria-label="Servo controls">
                <div className="dial-stats-title">controls</div>
                <div className="kv"><span>flip direction</span><input type="checkbox" checked={diagramFlipDirection} onChange={(e) => setDiagramFlipDirection(e.target.checked)} /></div>
                <div className="kv"><span>0 is up</span><input type="checkbox" checked={diagramZeroIsUp} onChange={(e) => setDiagramZeroIsUp(e.target.checked)} /></div>
                <div className="kv"><span>target sweep</span><input type="number" min={0} max={180} step={1} value={targetSweepDeg} onChange={(e) => setTargetSweepDeg(clamp(Number(e.target.value), 0, 180))} /></div>
                <div className="kv"><span>target sweep offset</span><input type="number" min={Math.round(normalizedMinTargetOffsetDeg)} max={Math.round(normalizedMaxTargetOffsetDeg)} step={1} value={targetSweepOffsetDeg} onChange={(e) => setTargetSweepOffsetDeg(clamp(Number(e.target.value), normalizedMinTargetOffsetDeg, normalizedMaxTargetOffsetDeg))} /></div>
                <div className="kv"><span>target min/max</span><code>{formatAngleForDiagram(targetMinDeg)} to {formatAngleForDiagram(targetMaxDeg)}</code></div>
              </div>
              <div className="dial-stats-col" aria-label="Servo readouts">
                <div className="dial-stats-title">readouts</div>
                <div className="kv"><span>effective sweep</span><code>{Math.round(effectiveSweepDeg)} deg</code></div>
                <div className="kv"><span>effective offset</span><code>{effectiveTargetOffsetDeg > 0 ? "+" : ""}{Math.round(effectiveTargetOffsetDeg)} deg</code></div>
                <div className="kv"><span>device active span</span><code>{Math.round(activeSpanDeg)} deg</code></div>
                <div className="kv"><span>preview angle</span><code>{formatAngleForDiagram(previewAngleDeg)}</code></div>
                <div className="kv"><span>live angle</span><code>{formatAngleForDiagram(currentAngleDeg)}</code></div>
                <div className="kv"><span>servo spec</span><code>{formatAngleForDiagram(servoSpecMin)} to {formatAngleForDiagram(servoSpecMax)}</code></div>
              </div>
            </div>
          </div>
          <div className="pw-graph" aria-label="Servo pulse width history">
            <div className="pw-graph-head">
              <span>pulse width over time (10 second window)</span>
              <code>{PW_GRAPH_MIN_US} to {PW_GRAPH_MAX_US} µs</code>
            </div>
            <svg viewBox={`0 0 ${PW_GRAPH_VIEWBOX_WIDTH} ${PW_GRAPH_VIEWBOX_HEIGHT}`} role="img" aria-label="Pulse width versus time graph">
              <line x1={pwPlotLeftX()} y1={pwY(2500)} x2={pwPlotRightX()} y2={pwY(2500)} className="pw-grid" />
              <line x1={pwPlotLeftX()} y1={pwY(2250)} x2={pwPlotRightX()} y2={pwY(2250)} className="pw-grid" />
              <line x1={pwPlotLeftX()} y1={pwY(2000)} x2={pwPlotRightX()} y2={pwY(2000)} className="pw-grid" />
              <line x1={pwPlotLeftX()} y1={pwY(1750)} x2={pwPlotRightX()} y2={pwY(1750)} className="pw-grid" />
              <line x1={pwPlotLeftX()} y1={pwPlotMidY()} x2={pwPlotRightX()} y2={pwPlotMidY()} className="pw-midline" />
              <line x1={pwPlotLeftX()} y1={pwY(1250)} x2={pwPlotRightX()} y2={pwY(1250)} className="pw-grid" />
              <line x1={pwPlotLeftX()} y1={pwY(1000)} x2={pwPlotRightX()} y2={pwY(1000)} className="pw-grid" />

              <line x1={pwPlotLeftX()} y1={PW_GRAPH_PAD_TOP} x2={pwPlotLeftX()} y2={PW_GRAPH_VIEWBOX_HEIGHT - PW_GRAPH_PAD_BOTTOM} className="pw-axis" />
              <line x1={pwPlotLeftX()} y1={PW_GRAPH_VIEWBOX_HEIGHT - PW_GRAPH_PAD_BOTTOM} x2={pwPlotRightX()} y2={PW_GRAPH_VIEWBOX_HEIGHT - PW_GRAPH_PAD_BOTTOM} className="pw-axis" />

              <line x1={pwPlotLeftX()} y1={PW_GRAPH_PAD_TOP} x2={pwPlotLeftX()} y2={PW_GRAPH_VIEWBOX_HEIGHT - PW_GRAPH_PAD_BOTTOM} className="pw-grid-vertical" />
              <line x1={q(pwPlotLeftX() + (pwPlotRightX() - pwPlotLeftX()) * 0.2)} y1={PW_GRAPH_PAD_TOP} x2={q(pwPlotLeftX() + (pwPlotRightX() - pwPlotLeftX()) * 0.2)} y2={PW_GRAPH_VIEWBOX_HEIGHT - PW_GRAPH_PAD_BOTTOM} className="pw-grid-vertical" />
              <line x1={q(pwPlotLeftX() + (pwPlotRightX() - pwPlotLeftX()) * 0.4)} y1={PW_GRAPH_PAD_TOP} x2={q(pwPlotLeftX() + (pwPlotRightX() - pwPlotLeftX()) * 0.4)} y2={PW_GRAPH_VIEWBOX_HEIGHT - PW_GRAPH_PAD_BOTTOM} className="pw-grid-vertical" />
              <line x1={q(pwPlotLeftX() + (pwPlotRightX() - pwPlotLeftX()) * 0.6)} y1={PW_GRAPH_PAD_TOP} x2={q(pwPlotLeftX() + (pwPlotRightX() - pwPlotLeftX()) * 0.6)} y2={PW_GRAPH_VIEWBOX_HEIGHT - PW_GRAPH_PAD_BOTTOM} className="pw-grid-vertical" />
              <line x1={q(pwPlotLeftX() + (pwPlotRightX() - pwPlotLeftX()) * 0.8)} y1={PW_GRAPH_PAD_TOP} x2={q(pwPlotLeftX() + (pwPlotRightX() - pwPlotLeftX()) * 0.8)} y2={PW_GRAPH_VIEWBOX_HEIGHT - PW_GRAPH_PAD_BOTTOM} className="pw-grid-vertical" />
              <line x1={pwPlotRightX()} y1={PW_GRAPH_PAD_TOP} x2={pwPlotRightX()} y2={PW_GRAPH_VIEWBOX_HEIGHT - PW_GRAPH_PAD_BOTTOM} className="pw-grid-vertical" />

              <text x={PW_GRAPH_PAD_LEFT - 10} y={pwY(2500) + 5} className="pw-label" textAnchor="end">2500</text>
              <text x={PW_GRAPH_PAD_LEFT - 10} y={pwY(2000) + 5} className="pw-label" textAnchor="end">2000</text>
              <text x={PW_GRAPH_PAD_LEFT - 10} y={pwY(1500) + 5} className="pw-label" textAnchor="end">1500</text>
              <text x={PW_GRAPH_PAD_LEFT - 10} y={pwY(1000) + 5} className="pw-label" textAnchor="end">1000</text>
              <text x={PW_GRAPH_PAD_LEFT - 10} y={pwY(500) + 5} className="pw-label" textAnchor="end">500</text>

              <text x={pwPlotLeftX()} y={PW_GRAPH_VIEWBOX_HEIGHT - 18} className="pw-label" textAnchor="start">-10s</text>
              <text x={q(pwPlotLeftX() + (pwPlotRightX() - pwPlotLeftX()) * 0.5)} y={PW_GRAPH_VIEWBOX_HEIGHT - 18} className="pw-label" textAnchor="middle">-5s</text>
              <text x={pwPlotRightX()} y={PW_GRAPH_VIEWBOX_HEIGHT - 18} className="pw-label" textAnchor="end">now</text>
              <text x={12} y={q((PW_GRAPH_VIEWBOX_HEIGHT - PW_GRAPH_PAD_BOTTOM + PW_GRAPH_PAD_TOP) * 0.5)} className="pw-axis-title" textAnchor="middle" transform={`rotate(-90, 12, ${q((PW_GRAPH_VIEWBOX_HEIGHT - PW_GRAPH_PAD_BOTTOM + PW_GRAPH_PAD_TOP) * 0.5)})`}>pulse width (µs)</text>
              <text x={q((pwPlotLeftX() + pwPlotRightX()) * 0.5)} y={PW_GRAPH_VIEWBOX_HEIGHT - 4} className="pw-axis-title" textAnchor="middle">time (last 10 seconds)</text>

              {pwPoints && (
                <polyline
                  points={pwPoints}
                  className="pw-wave"
                />
              )}
              {!pwPoints && (
                <text
                  x={q((pwPlotLeftX() + pwPlotRightX()) * 0.5)}
                  y={q((PW_GRAPH_PAD_TOP + PW_GRAPH_VIEWBOX_HEIGHT - PW_GRAPH_PAD_BOTTOM) * 0.5)}
                  className="pw-empty"
                  textAnchor="middle"
                >
                  waiting for pulse width telemetry
                </text>
              )}
            </svg>
          </div>
        </section>
        </div>
      </div>
    </main>
  );
}

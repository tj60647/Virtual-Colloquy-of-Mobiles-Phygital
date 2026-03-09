/*
 * main.cpp
 * Project: Colloquy of Mobiles Virtual Simulation — Phygital
 * Author: Thomas J McLeish
 * License: MIT
 *
 * Prototype firmware module.
 */

#include <Arduino.h>
#include <Wire.h>
#include <ESP32Servo.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <NimBLEDevice.h>
#include <Adafruit_NeoPixel.h>

/**
 * Module overview:
 * - Receives newline-delimited serial commands in the range -100..100.
 * - Supports a hardware switch to choose serial control vs test oscillation mode.
 * - Reads a potentiometer to scale active servo span for calibration.
 * - Drives an MG996R servo in open loop.
 * - Reports runtime status over USB Serial, BLE (Nordic UART Service), and optional SSD1306 OLED.
 * - Commands are accepted identically over USB or BLE — same protocol, same behavior.
 */

/**
 * Wiring quick reference (prototype bench setup)
 *
 * Servo (MG996R, standard wire colors):
 * - Brown  -> GND (common ground with ESP32)
 * - Red    -> External servo supply V+ (4.8–7.2 V; use dedicated supply, not ESP32 3.3 V)
 * - Orange -> SERVO_PIN (GPIO13 signal)
 *
 * Potentiometer:
 * - Wiper (center pin) -> POT_PIN (A0)
 * - Outer pin          -> 3.3V
 * - Outer pin          -> GND
 *
 * Mode switch (INPUT_PULLUP logic):
 * - Recommended 3-pin SPDT toggle wiring:
 *   - Center/common pin -> MODE_SWITCH_PIN (GPIO12)
 *   - One outer pin     -> GND  (this side selects oscillation mode)
 *   - Other outer pin   -> not connected
 * - Alternate 2-pin switch wiring:
 *   - One pin -> MODE_SWITCH_PIN (GPIO12)
 *   - One pin -> GND
 * - Logic result:
 *   - HIGH/open (not tied to GND) = serial control mode
 *   - LOW/closed (tied to GND)    = oscillation test mode
 *
 * OLED (GM12864 SSD1306-compatible, optional):
 * - VCC -> 3.3V
 * - GND -> GND
 * - SDA -> board SDA pin (I2C_SDA_PIN)
 * - SCL -> board SCL pin (I2C_SCL_PIN)
 */
constexpr uint8_t SERVO_PIN = 13;
constexpr uint8_t POT_PIN = A0;
constexpr uint8_t MODE_SWITCH_PIN = 12;
// Use board variant I2C defaults to avoid hardcoding generic ESP32 pin maps.
constexpr uint8_t I2C_SDA_PIN = SDA;
constexpr uint8_t I2C_SCL_PIN = SCL;

// MG996R pulse calibration.
//
// The MG996R travels approximately 180° total (90° each side of center) across
// a standard 0.5 ms – 2.5 ms pulse range at 50 Hz.
//
// ESP32Servo maps write(0)→MIN_US and write(180)→MAX_US internally (0–180
// degree range hard-coded in the library). To make write(0)=500 µs and
// write(180)=2500 µs we set MIN_US=500 and MAX_US=2500. 
// This gives the servo a full 2000 µs span to work with.
// The angle clamp on [SERVO_MIN_ANGLE, SERVO_MAX_ANGLE] ensures we never
// actually command above 180°, so the servo never sees more than 2500 µs.
//
// Dead band: 5 µs (datasheet) — very fine resolution.
constexpr int SERVO_MIN_US = 500; 
constexpr int SERVO_MAX_US = 2500;  

// Physical rotation range of the MG996R.
// Center is 90° (half of 180°). Potentiometer at maximum collapses travel to center.
constexpr float SERVO_MIN_ANGLE = 0.0f;
constexpr float SERVO_MAX_ANGLE = 180.0f;

constexpr float COMMAND_MIN = -100.0f;
constexpr float COMMAND_MAX = 100.0f;

// Potentiometer controls how much of the available servo span is used.
// User request mapping:
// - pot at 0    => full range (span scale = 1.0) -> servo sweeps 0°..180°
// - pot at max  => zero range, hold center (90°) (span scale = 0.0)
constexpr float CALIBRATION_SPAN_MIN_SCALE = 0.0f;
constexpr float CALIBRATION_SPAN_MAX_SCALE = 1.0f;

// Pot ADC endpoint calibration.
// Real knobs often do not reach 0 or 4095 at their mechanical limits because
// of tolerances and resistor end-stop behavior. We remap the usable interval
// [POT_ADC_FLOOR, POT_ADC_CEILING] to [0..1] so the full servo span is still
// reachable at both ends.
//
// Example with defaults below:
// - EMA <= 120  => treated as 0.0 (full span)
// - EMA >= 3975 => treated as 1.0 before inversion (collapsed span)
//
// Tune these on bench if needed:
// 1) Turn pot to one hard stop, note stable p= in telemetry -> floor.
// 2) Turn to the other hard stop, note stable p= -> ceiling.
// 3) Set floor slightly above observed minimum and ceiling slightly below
//    observed maximum so endpoints are reachable without jitter chatter.
constexpr float POT_ADC_FLOOR = 120.0f;
constexpr float POT_ADC_CEILING = 3975.0f;

// 64 samples gives a wider averaging window to better reject BLE radio
// interference, which causes ESP32 ADC spikes that outlast shorter windows.
constexpr size_t POT_RUNNING_AVERAGE_SAMPLES = 64;

constexpr size_t SERIAL_BUFFER_LEN = 64;
constexpr size_t TELEMETRY_FRAME_BUFFER_LEN = 160;
constexpr uint32_t STATUS_PRINT_INTERVAL_MS = 50; // 20 Hz — matches dashboard oscillator drive rate
// Keep OLED responsive; partial redraw logic in refreshOledStatus() limits
// redraw work by only updating changed value fields.
constexpr uint32_t OLED_REFRESH_INTERVAL_MS = 250;
constexpr uint32_t SERIAL_COMMAND_TIMEOUT_MS = 1500;

// Fixed loop tick rate: 500 Hz (2 ms floor per iteration).
// The spin-wait at the top of loop() ensures a minimum period between
// iterations. Benefits:
//   - EMA dt is always >= 2 ms, so the 125 ms time constant is predictable.
//   - The BLE FreeRTOS task gets scheduled during the idle spin window
//     instead of preempting mid-analogRead, keeping ADC timing clean.
//   - All millis()-gated tasks (telemetry, OLED, heartbeat) fire more evenly.
constexpr uint32_t LOOP_TICK_US = 2000;

/**
 * Wait until the next fixed-rate loop deadline.
 *
 * Deadline model (nextTickUs) is easier to reason about than "last tick" and
 * is robust across micros() wrap-around by using signed time deltas.
 *
 * Behavior:
 * - First call initializes the first deadline one tick in the future.
 * - If we are late by a small amount, skip missed deadlines until the next
 *   future slot (catch-up without long blocking).
 * - If we are very late (>8 ticks), re-anchor one tick ahead of now.
 */
void waitForNextTick() {
  static uint32_t nextTickUs = 0;
  static bool initialized = false;

  const uint32_t nowUs = micros();

  if (!initialized) {
    nextTickUs = nowUs + LOOP_TICK_US;
    initialized = true;
  }

  const int32_t lateUs = static_cast<int32_t>(nowUs - nextTickUs);
  if (lateUs >= 0) {
    if (static_cast<uint32_t>(lateUs) > LOOP_TICK_US * 8u) {
      nextTickUs = nowUs + LOOP_TICK_US;
    } else {
      do {
        nextTickUs += LOOP_TICK_US;
      } while (static_cast<int32_t>(nowUs - nextTickUs) >= 0);
    }
    return;
  }

  while (static_cast<int32_t>(micros() - nextTickUs) < 0) {
    // Busy-wait until the scheduled deadline.
  }
  nextTickUs += LOOP_TICK_US;
}

// Human-readable firmware version shown on the OLED and startup banner.
// Increment manually when behaviour-changing changes are flashed.
constexpr char FIRMWARE_VERSION[] = "0.1.0";

// Snap the displayed range bounds (rn/rx) to this increment as the user turns
// the calibration knob. The servo itself moves continuously at full resolution.
constexpr float RANGE_DISPLAY_STEP_DEG = 5.0f;

// EMA time constant in microseconds (125 ms).
// The ADC is sampled every loop iteration — thousands of times per second —
// so the filter accumulates many samples, but the alpha applied each update
// is proportional to the actual elapsed time between calls. This means the
// settling time is always 125 ms of real wall-clock regardless of loop speed
// or BLE stack preemption. A deliberate knob turn takes 300+ ms, so the
// filter follows intentional changes while rejecting noise bursts.
// alpha per update = dt_us / (POT_EMA_TAU_US + dt_us)
constexpr float POT_EMA_TAU_US = 125000.0f;

// Minimum time to run the pot EMA filter before trusting the output.
// Four time constants (4 × 125 ms = 500 ms) means the EMA is at ~98% of its
// final value — effectively settled. The servo is held at center during this
// window and does not move until potEmaSettled is set at the end of setup().
constexpr uint32_t POT_EMA_SETTLE_MS = 500;

// Hysteresis margin applied around each snap boundary. Without this a
// filtered reading hovering within 1 ADC count of a 5-degree boundary
// will toggle back and forth every frame. 1.5 degrees on each side gives
// a 3-degree dead zone — invisible on a physical knob, eliminates toggling.
constexpr float SNAP_HYSTERESIS_DEG = 1.5f;

// Trapezoidal oscillation: pointer travels between -OSCILLATION_AMPLITUDE and
// +OSCILLATION_AMPLITUDE with a velocity-limited, acceleration-limited profile.
// Units are command space (-100..100), so these are command-units/sec and
// command-units/sec² respectively. With defaults of 5/5 the pointer takes
// ~41 sec per one-way pass (1 sec accel + 39 sec coast + 1 sec decel).
constexpr float OSCILLATION_AMPLITUDE  = 100.0f;
constexpr float OSC_MAX_VELOCITY       = 5.0f;  // command units per second
constexpr float OSC_MAX_ACCEL          = 5.0f;  // command units per second²

// Built-in NeoPixel heartbeat — slow white breathing pulse proves the device
// is alive and looping. PIN_NEOPIXEL and NEOPIXEL_POWER are defined by the
// Adafruit Feather ESP32 V2 board variant. Fallbacks are here for safety.
#ifndef PIN_NEOPIXEL
#define PIN_NEOPIXEL 0
#endif
#ifndef NEOPIXEL_POWER
#define NEOPIXEL_POWER 2
#endif
constexpr uint32_t HEARTBEAT_INTERVAL_MS    = 50;   // 20 Hz update — clean divisor of 1000 ms
constexpr uint32_t HEARTBEAT_PERIOD_MS      = 3000; // one full breathe cycle
constexpr uint8_t  HEARTBEAT_MAX_BRIGHTNESS = 20;   // 0–255; subtle, not blinding

Adafruit_NeoPixel neoPixel(1, PIN_NEOPIXEL, NEO_GRB + NEO_KHZ800);

enum class ControlMode {
  Serial,
  Oscillation,
};

// BLE: Nordic UART Service (NUS) — well-established convention for serial-over-BLE.
// Two characteristics mirror the USB serial protocol exactly:
//   RX char (host writes here)  = commands coming in
//   TX char (device notifies)   = telemetry going out
// The dashboard discovers the device by filtering on the NUS service UUID.
constexpr const char* BLE_DEVICE_NAME  = "Colloquy Pointer";
constexpr const char* NUS_SERVICE_UUID = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr const char* NUS_RX_CHAR_UUID = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"; // host -> device
constexpr const char* NUS_TX_CHAR_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"; // device -> host

NimBLECharacteristic* bleTxCharacteristic = nullptr;
bool bleClientConnected = false;

Servo pointerServo;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);

char serialBuffer[SERIAL_BUFFER_LEN] = {0};
size_t serialBufferPos = 0;

float commandedPosition = 0.0f;
float appliedAngle = 90.0f;  // start at center of MG996R 180° range
uint16_t lastPotRaw = 0;     // raw ADC sample, preserved for debug telemetry (pr=)
uint16_t lastPotAverage = 0; // box-filter output (stage 1)
float    lastPotEma = 0.0f;  // EMA output (stage 2) — this is what the servo uses
float lastSpanScale = 1.0f;
float lastExpectedMinAngle = SERVO_MIN_ANGLE;
float lastExpectedMaxAngle = SERVO_MAX_ANGLE;
uint32_t lastStatusPrintMs = 0;
uint32_t lastOledRefreshMs = 0;
uint32_t lastHeartbeatMs   = 0;
uint32_t lastPotEmaUs      = 0;  // micros() timestamp of last EMA update
uint32_t lastLoopDurationUs = 0; // loop active-work duration from prior iteration (microseconds)
uint32_t lastLoopPeriodUs = 0;   // loop-to-loop period (microseconds)
uint32_t lastValidSerialCommandMs = 0;
int      lastAppliedPulseWidthUs = -1; // tracks last pulse width sent to servo; -1 forces first write
ControlMode currentMode = ControlMode::Serial;
bool oledAvailable = false;
uint8_t oledAddress = 0;
bool oledDirtyRegionActive = false;
uint8_t oledDirtyXMin = 127;
uint8_t oledDirtyXMax = 0;
uint8_t oledDirtyPageMin = 7;
uint8_t oledDirtyPageMax = 0;
bool oledStatusLayoutDrawn = false;
ControlMode oledShownMode = ControlMode::Serial;
bool oledShownGuard = false;
int oledShownCommandTenths = 32767;
int oledShownRangeMinDeg = 1000;
int oledShownRangeMaxDeg = 1000;
int oledShownAngleDeg = 1000;
bool serialTimeoutGuardActive = false;
uint16_t potFilterBuffer[POT_RUNNING_AVERAGE_SAMPLES] = {0};
size_t potFilterIndex = 0;
uint32_t potFilterSum = 0;
bool potFilterInitialized = false;

// True once the ADC filter has been running for POT_EMA_SETTLE_MS.
// applyServoOutput() returns early until this is set so the servo does not
// chase an unsettled pot reading during the first half-second after boot.
bool potEmaSettled = false;

// Unsnapped range reference — derived directly from the continuous EMA output.
// This is retained for diagnostics (sm/sx telemetry) so we can inspect what
// the filters are doing under the hood.
//
// Active servo control now uses the snapped bounds in
// lastExpectedMinAngle/Max (rn/rx telemetry) to intentionally quantize the
// envelope to 5-degree steps with hysteresis.
float lastServoMinAngle = SERVO_MIN_ANGLE;
float lastServoMaxAngle = SERVO_MAX_ANGLE;

/**
 * Convert angle values to nearest whole-degree integer for user-facing output.
 *
 * @param angleDeg Angle value in degrees.
 * @return Rounded whole-degree integer.
 */
int toWholeDegrees(float angleDeg) {
  return static_cast<int>(roundf(angleDeg));
}

/**
 * Snap an angle to the nearest fixed degree increment.
 *
 * Used to quantize the displayed range bounds (rn/rx) so the dashboard shows
 * clean step changes as the calibration knob is adjusted, rather than a
 * continuous jittery float stream. The servo output angle is NOT snapped —
 * it moves at full continuous resolution.
 * For example, with increment=5: 92.3 -> 90, 93.0 -> 95.
 *
 * @param angleDeg Continuous angle value in degrees.
 * @param increment Step size in degrees (e.g. 5).
 * @return Angle snapped to the nearest multiple of increment.
 */
float snapToNearestIncrement(float angleDeg, float increment) {
  return roundf(angleDeg / increment) * increment;
}

/**
 * Snap with hysteresis: like snapToNearestIncrement but adds a dead zone
 * around each bucket boundary so a noisy reading cannot toggle between
 * two adjacent snap values every frame.
 *
 * The boundary between two adjacent snap values is at their midpoint.
 * A new snap value is only committed when the continuous reading has moved
 * at least SNAP_HYSTERESIS_DEG past that midpoint — effectively widening
 * the "staying" region and narrowing the "switching" region.
 *
 * Example (5-degree step, 1.5-degree hysteresis):
 *   Currently at 85 deg. Switch to 90 only when reading >= 89.0 deg.
 *   Currently at 90 deg. Switch to 85 only when reading <= 86.0 deg.
 *
 * @param angleDeg     Continuous angle in degrees.
 * @param increment    Snap step size in degrees.
 * @param lastSnapped  Previous snapped output to compare against.
 * @return             New snapped value, or lastSnapped if inside dead zone.
 */
float snapWithHysteresis(float angleDeg, float increment, float lastSnapped) {
  const float newSnapped = roundf(angleDeg / increment) * increment;
  if (fabsf(newSnapped - lastSnapped) < 0.001f) {
    // Already in the same bucket — no change.
    return lastSnapped;
  }
  // midpoint between the two candidate snap values
  const float boundary = (newSnapped + lastSnapped) * 0.5f;
  if (newSnapped > lastSnapped) {
    // Moving higher: only commit once we're past boundary + margin.
    return (angleDeg >= boundary + SNAP_HYSTERESIS_DEG) ? newSnapped : lastSnapped;
  } else {
    // Moving lower: only commit once we're past boundary - margin.
    return (angleDeg <= boundary - SNAP_HYSTERESIS_DEG) ? newSnapped : lastSnapped;
  }
}

/**
 * Clamp a floating-point value into an explicit inclusive range.
 *
 * @param value Input value to clamp.
 * @param minimum Minimum allowed value.
 * @param maximum Maximum allowed value.
 * @return Clamped value in [minimum, maximum].
 */
float clampf(float value, float minimum, float maximum) {
  if (value < minimum) {
    return minimum;
  }
  if (value > maximum) {
    return maximum;
  }
  return value;
}

/**
 * Convert a servo angle in degrees (0..180 API space) to pulse width in microseconds.
 *
 * This keeps the control path at float precision until the final write boundary,
 * where the hardware API requires integer microseconds.
 */
int pulseWidthFromAngle(float angleDeg) {
  const float clampedAngle = clampf(angleDeg, 0.0f, 180.0f);
  const float pulse = static_cast<float>(SERVO_MIN_US) +
                      (clampedAngle / 180.0f) * static_cast<float>(SERVO_MAX_US - SERVO_MIN_US);
  return static_cast<int>(roundf(pulse));
}

/**
 * Convert command space (-100..100) to normalized actuator space (-1..1).
 *
 * @param commandValue Command value from serial or synthetic mode input.
 * @return Normalized command in [-1.0, 1.0].
 */
float normalizedFromCommand(float commandValue) {
  const float clamped = clampf(commandValue, COMMAND_MIN, COMMAND_MAX);
  const float unit = (clamped - COMMAND_MIN) / (COMMAND_MAX - COMMAND_MIN);
  return (unit * 2.0f) - 1.0f;
}

/**
 * Read potentiometer and convert ADC code into servo-span scale factor.
 *
 * Two-stage filter pipeline:
 *   Stage 1 — box (running-average) filter over POT_RUNNING_AVERAGE_SAMPLES.
 *             Fast spike rejection: removes sample-to-sample ADC jitter and
 *             short BLE radio noise bursts that last less than the box window.
 *   Stage 2 — time-based exponential moving average (EMA).
 *             Settling time is always POT_EMA_TAU_US (125 ms) of real
 *             wall-clock time. Alpha is recomputed each call as:
 *               alpha = dt_us / (POT_EMA_TAU_US + dt_us)
 *             This is a first-order approximation of 1 - e^(-dt/tau) and
 *             gives the correct time constant regardless of loop speed.
 *             If dt is zero (same microsecond as last call), the EMA is
 *             skipped for that sample to avoid a divide-by-zero alpha of 0.
 *
 * Called every loop() iteration so the filter accumulates the maximum
 * number of ADC samples — thousands per second — giving it real data to
 * work with over the full 125 ms time window.
 *
 * lastPotRaw is written before filtering for debug telemetry (pr=).
 * lastPotAverage holds the stage-1 box output.
 * lastPotEma holds the stage-2 EMA output — this value drives the servo.
 *
 * @return Span scale in [CALIBRATION_SPAN_MIN_SCALE, CALIBRATION_SPAN_MAX_SCALE].
 */
float readCalibrationSpanScale() {
  const uint16_t potRaw = analogRead(POT_PIN);
  lastPotRaw = potRaw;  // preserve raw sample — never overwrite this

  if (!potFilterInitialized) {
    // Seed both filter stages from the first sample so startup is stable.
    for (size_t i = 0; i < POT_RUNNING_AVERAGE_SAMPLES; ++i) {
      potFilterBuffer[i] = potRaw;
      potFilterSum += potRaw;
    }
    potFilterInitialized = true;
    potFilterIndex = 0;
    lastPotAverage = potRaw;
    lastPotEma     = static_cast<float>(potRaw);
    lastPotEmaUs   = micros();
  } else {
    // Stage 1: box filter — slide the window forward.
    potFilterSum -= potFilterBuffer[potFilterIndex];
    potFilterBuffer[potFilterIndex] = potRaw;
    potFilterSum += potRaw;
    potFilterIndex = (potFilterIndex + 1) % POT_RUNNING_AVERAGE_SAMPLES;
    const uint16_t boxAvg =
        static_cast<uint16_t>(potFilterSum / POT_RUNNING_AVERAGE_SAMPLES);
    lastPotAverage = boxAvg;

    // Stage 2: time-based EMA.
    // alpha = dt_us / (tau_us + dt_us) so the time constant is exactly
    // POT_EMA_TAU_US of real time regardless of loop rate.
    const uint32_t nowUs = micros();
    const float    dtUs  = static_cast<float>(nowUs - lastPotEmaUs);
    if (dtUs > 0.0f) {
      lastPotEmaUs = nowUs;
      const float alpha = dtUs / (POT_EMA_TAU_US + dtUs);
      lastPotEma = lastPotEma * (1.0f - alpha) +
                   static_cast<float>(boxAvg) * alpha;
    }
  }

  const float adcSpan = POT_ADC_CEILING - POT_ADC_FLOOR;
  const float unit = (adcSpan > 1.0f)
      ? clampf((lastPotEma - POT_ADC_FLOOR) / adcSpan, 0.0f, 1.0f)
      : clampf(lastPotEma / 4095.0f, 0.0f, 1.0f);
  const float inverted = 1.0f - unit;
  return clampf(inverted, CALIBRATION_SPAN_MIN_SCALE,
                CALIBRATION_SPAN_MAX_SCALE);
}

/**
 * Compute expected minimum and maximum reachable angle for current span scale.
 *
 * @param spanScale Current calibration span scale in [0, 1].
 * @param minAngleOut Output pointer for computed minimum angle.
 * @param maxAngleOut Output pointer for computed maximum angle.
 */
void expectedServoRangeFromScale(float spanScale, float* minAngleOut,
                                 float* maxAngleOut) {
  const float center = (SERVO_MIN_ANGLE + SERVO_MAX_ANGLE) * 0.5f;
  const float maxTravelFromCenter =
      ((SERVO_MAX_ANGLE - SERVO_MIN_ANGLE) * 0.5f) * spanScale;

  if (minAngleOut != nullptr) {
    *minAngleOut = clampf(center - maxTravelFromCenter, SERVO_MIN_ANGLE,
                          SERVO_MAX_ANGLE);
  }
  if (maxAngleOut != nullptr) {
    *maxAngleOut = clampf(center + maxTravelFromCenter, SERVO_MIN_ANGLE,
                          SERVO_MAX_ANGLE);
  }
}

/**
 * Parse the first numeric token from a command line.
 *
 * Accepted examples: "37", "pos=37", "cmd:-22.5"
 *
 * @param line Null-terminated command line string.
 * @param outValue Parsed float output when parsing succeeds.
 * @return True when a valid numeric token is parsed.
 */
bool tryParseCommandLine(const char* line, float* outValue) {
  if (line == nullptr || outValue == nullptr) {
    return false;
  }

  // Packet definition (strict):
  //   1) plain numeric token only: "37", "-22.5", "+10"
  //   2) prefixed numeric token:   "cmd:37", "cmd=37", "pos:-22.5", "pos=-22.5"
  // Any other text is rejected. This prevents accidental digits in debug strings
  // from being interpreted as motion commands.
  auto skipSpaces = [](const char* s) -> const char* {
    while (*s == ' ' || *s == '\t') {
      ++s;
    }
    return s;
  };

  auto parseStrictFloat = [&](const char* s, float* parsedOut) -> bool {
    if (s == nullptr || parsedOut == nullptr) {
      return false;
    }
    s = skipSpaces(s);
    char* endPtr = nullptr;
    const float parsed = strtof(s, &endPtr);
    if (endPtr == s) {
      return false;
    }
    const char* tail = skipSpaces(endPtr);
    if (*tail != '\0') {
      return false;
    }
    *parsedOut = parsed;
    return true;
  };

  const char* scan = skipSpaces(line);

  // Plain numeric form.
  if (parseStrictFloat(scan, outValue)) {
    return true;
  }

  // Prefixed forms for serial-monitor convenience.
  if ((strncmp(scan, "cmd:", 4) == 0) || (strncmp(scan, "cmd=", 4) == 0)) {
    return parseStrictFloat(scan + 4, outValue);
  }
  if ((strncmp(scan, "pos:", 4) == 0) || (strncmp(scan, "pos=", 4) == 0)) {
    return parseStrictFloat(scan + 4, outValue);
  }

  return false;
}

/**
 * Process a single incoming character through the shared line buffer.
 *
 * Extracted so both USB serial and BLE RX paths use identical parsing logic.
 * A command sent over BLE behaves exactly the same as one sent over USB.
 *
 * Side effects:
 * - Updates `commandedPosition` on valid parse.
 * - Updates `lastValidSerialCommandMs` to service timeout guard.
 */
void processIncomingCharacter(char c) {
  if (c == '\n' || c == '\r') {
    if (serialBufferPos == 0) {
      return;
    }
    serialBuffer[serialBufferPos] = '\0';
    float parsedCommand = 0.0f;
    if (tryParseCommandLine(serialBuffer, &parsedCommand)) {
      commandedPosition = clampf(parsedCommand, COMMAND_MIN, COMMAND_MAX);
      lastValidSerialCommandMs = millis();
      serialTimeoutGuardActive = false;
    }
    serialBufferPos = 0;
    serialBuffer[0] = '\0';
    return;
  }
  if (serialBufferPos < (SERIAL_BUFFER_LEN - 1)) {
    serialBuffer[serialBufferPos++] = c;
  } else {
    // Overflow guard: reset buffer and wait for next line.
    serialBufferPos = 0;
    serialBuffer[0] = '\0';
  }
}

/**
 * BLE server callbacks: track connection state and restart advertising on disconnect.
 *
 * Restarting advertising after disconnect means the dashboard can reconnect
 * without power-cycling the device.
 */
class BleServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* /*server*/) override {
    bleClientConnected = true;
    Serial.println("BLE: dashboard connected.");
  }
  void onDisconnect(NimBLEServer* server) override {
    bleClientConnected = false;
    Serial.println("BLE: dashboard disconnected — restarting advertising.");
    server->startAdvertising();
  }
};

/**
 * BLE RX characteristic callback: feed incoming bytes into the shared line buffer.
 *
 * BLE writes may arrive in any chunk size, so each byte is forwarded to
 * processIncomingCharacter() which handles newline detection and parsing.
 */
class BleRxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic) override {
    const std::string data = characteristic->getValue();
    for (const char c : data) {
      processIncomingCharacter(c);
    }
  }
};

/**
 * Consume incoming serial bytes into the shared line buffer.
 *
 * Side effects:
 * - Updates `commandedPosition` on valid parse.
 * - Updates `lastValidSerialCommandMs` to service timeout guard.
 */
void processSerialInput() {
  while (Serial.available() > 0) {
    processIncomingCharacter(static_cast<char>(Serial.read()));
  }
}

/**
 * Sample the potentiometer every loop and update the cached span-scale and
 * snapped range bounds.
 *
 * Sampling every loop maximises the number of ADC readings fed into the
 * two-stage filter, giving it the most data to work with across the full
 * 125 ms EMA time window. The filter output changes slowly by design —
 * the CPU cost of a single analogRead() per loop iteration is acceptable.
 *
 * Side effects:
 * - Calls readCalibrationSpanScale() which advances the box filter and EMA.
 * - Updates lastSpanScale, lastExpectedMinAngle, lastExpectedMaxAngle.
 */
void updatePotSample() {
  const float prevSnappedMin = lastExpectedMinAngle;
  const float prevSnappedMax = lastExpectedMaxAngle;

  const float spanScale = readCalibrationSpanScale();
  lastSpanScale = spanScale;
  // Compute the continuous (unsnapped) range for debug telemetry (sm/sx).
  expectedServoRangeFromScale(spanScale, &lastServoMinAngle, &lastServoMaxAngle);

  // Snap from the unsnapped reference for active control + display telemetry
  // (rn= / rx= fields and OLED). Hysteresis prevents chattering at boundaries.
  lastExpectedMinAngle = snapWithHysteresis(lastServoMinAngle, RANGE_DISPLAY_STEP_DEG, prevSnappedMin);
  lastExpectedMaxAngle = snapWithHysteresis(lastServoMaxAngle, RANGE_DISPLAY_STEP_DEG, prevSnappedMax);
}

/**
 * Apply the current command to the servo using cached span-scale.
 *
 * Runs every loop() iteration for responsive command tracking, but skips
 * the servo.writeMicroseconds() call when the target pulse width has not changed.
 * This avoids redundant PWM updates and reduces servo chatter.
 *
 * Side effects:
 * - Updates appliedAngle.
 * - Calls pointerServo.write() only when integer angle changes.
 */
void applyServoOutput() {
  // Hold servo still until the pot EMA filter has settled after boot.
  // Without this guard the first ~500 ms of loop() would chase an unsettled
  // filter value and make the servo jump unpredictably on power-up.
  if (!potEmaSettled) {
    return;
  }

  // Use the snapped range for active servo control. This intentionally makes
  // the envelope move in 5-degree increments with hysteresis, suppressing
  // sub-degree drift from the EMA path.
  const float servoCenter   = (lastExpectedMinAngle + lastExpectedMaxAngle) * 0.5f;
  const float servoHalfSpan = (lastExpectedMaxAngle - lastExpectedMinAngle) * 0.5f;
  const float normalized    = normalizedFromCommand(commandedPosition);
  appliedAngle = clampf(servoCenter + normalized * servoHalfSpan,
                        SERVO_MIN_ANGLE, SERVO_MAX_ANGLE);

  // Keep internal math at float precision and quantize only at the hardware
  // boundary where the API requires integer microseconds.
  const int targetPulseWidthUs = pulseWidthFromAngle(appliedAngle);
  if (targetPulseWidthUs != lastAppliedPulseWidthUs) {
    pointerServo.writeMicroseconds(targetPulseWidthUs);
    lastAppliedPulseWidthUs = targetPulseWidthUs;
  }
}

/**
 * Generate a trapezoidal motion command for oscillation test mode.
 *
 * The pointer accelerates at OSC_MAX_ACCEL toward the current endpoint,
 * cruises at OSC_MAX_VELOCITY, then decelerates to a stop at the endpoint
 * before reversing. This gives clean back-and-forth motion with defined
 * ramp-up and ramp-down behavior — easier to observe than a sine wave.
 *
 * State is held in static locals so it persists across loop() calls without
 * needing global variables.
 *
 * @return Current command value in approximately [-OSCILLATION_AMPLITUDE, +OSCILLATION_AMPLITUDE].
 */
float getOscillationCommand() {
  static float position  = 0.0f;
  static float velocity  = 0.0f;
  static float target    = OSCILLATION_AMPLITUDE;
  static uint32_t lastMs = 0;

  const uint32_t now = millis();
  // Clamp dt to 100ms maximum to prevent large jumps after pauses or on startup.
  const float dt = clampf(static_cast<float>(now - lastMs) * 0.001f, 0.0f, 0.1f);
  lastMs = now;

  if (dt <= 0.0f) {
    return position;
  }

  const float distToTarget = target - position;
  const float dirToTarget  = (distToTarget >= 0.0f) ? 1.0f : -1.0f;

  // Minimum distance needed to decelerate from current speed to zero.
  const float stoppingDist = (velocity * velocity) / (2.0f * OSC_MAX_ACCEL);

  float accel;
  if (fabsf(distToTarget) <= stoppingDist + 0.01f) {
    // Close enough that we must start braking to hit the endpoint cleanly.
    accel = -dirToTarget * OSC_MAX_ACCEL;
  } else if (fabsf(velocity) < OSC_MAX_VELOCITY) {
    // Below cruise speed — keep accelerating.
    accel = dirToTarget * OSC_MAX_ACCEL;
  } else {
    // At cruise speed — coast.
    accel = 0.0f;
  }

  velocity += accel * dt;
  velocity  = clampf(velocity, -OSC_MAX_VELOCITY, OSC_MAX_VELOCITY);
  position += velocity * dt;
  position  = clampf(position, -OSCILLATION_AMPLITUDE, OSCILLATION_AMPLITUDE);

  // When we arrive at the endpoint (close and nearly stopped), snap, then reverse.
  if (fabsf(distToTarget) < 0.5f && fabsf(velocity) < 0.5f) {
    position = target;
    velocity = 0.0f;
    target   = -target;
  }

  return position;
}

/**
 * Resolve active control mode and enforce runtime safety behavior.
 *
 * Behavior:
 * - Switch LOW => oscillation mode.
 * - Switch HIGH => serial mode.
 * - In serial mode, if command stream times out for SERIAL_COMMAND_TIMEOUT_MS,
 *   force neutral command (0.0) and mark guard active.
 */
void updateControlModeAndCommand() {
  // Switch uses INPUT_PULLUP: LOW means "oscillation test" mode selected.
  const bool switchIsLow = digitalRead(MODE_SWITCH_PIN) == LOW;
  currentMode = switchIsLow ? ControlMode::Oscillation : ControlMode::Serial;

  if (currentMode == ControlMode::Oscillation) {
    commandedPosition = getOscillationCommand();
    serialTimeoutGuardActive = false;
    return;
  }

  // Runtime guard for open-loop serial control: if command stream stalls,
  // force a neutral command instead of leaving the actuator at stale intent.
  const uint32_t elapsedMs = millis() - lastValidSerialCommandMs;
  if (elapsedMs > SERIAL_COMMAND_TIMEOUT_MS) {
    commandedPosition = 0.0f;
    serialTimeoutGuardActive = true;
  }
}

/**
 * Emit one telemetry frame over all active transports.
 *
 * Serial and BLE must carry the same key=value payload so the dashboard sees
 * identical data regardless of connection type. Newline framing is added per
 * transport to preserve line-based parsing.
 *
 * @param frame Null-terminated telemetry frame without trailing newline.
 */
void emitTelemetryFrame(const char* frame) {
  if (frame == nullptr) {
    return;
  }

  // Serial line framing.
  Serial.println(frame);

  // BLE line framing using the same payload bytes plus '\n'.
  if (bleClientConnected && bleTxCharacteristic != nullptr) {
    char frameNl[TELEMETRY_FRAME_BUFFER_LEN + 2];
    const int written = snprintf(frameNl, sizeof(frameNl), "%s\n", frame);
    if (written <= 0) {
      return;
    }
    size_t bytesToSend = static_cast<size_t>(written);
    if (bytesToSend >= sizeof(frameNl)) {
      bytesToSend = sizeof(frameNl) - 1;
    }
    bleTxCharacteristic->setValue(reinterpret_cast<uint8_t*>(frameNl), bytesToSend);
    bleTxCharacteristic->notify();
  }
}

/**
 * Emit periodic telemetry to serial monitor.
 *
 * Format: compact key=value pairs as defined in the root AGENTS.md protocol spec.
 * Example: c=37,m=s,g=0,p=2048,a=112,rn=45,rx=135
 *
 * Keys:
 *   c  = commanded position (-100..100)
 *   m  = control mode (s=serial, o=oscillation)
 *   g  = safety guard active (1=timeout, 0=ok)
 *   p  = potentiometer ADC average (0..4095)
 *   a  = applied servo angle in degrees (0..180)
 *   rn = pot-scaled range minimum angle in degrees (0..180)
 *   rx = pot-scaled range maximum angle in degrees (0..180)
 *   lu = previous loop active-work duration in microseconds
 */
void printStatus() {
  const uint32_t now = millis();
  if (now - lastStatusPrintMs < STATUS_PRINT_INTERVAL_MS) {
    return;
  }

  lastStatusPrintMs = now;

  // Build the telemetry frame once and route to all active transports.
  // Frame budget check (buffer is 160 bytes):
  // c=-100.0,m=o,g=1,p=4095,pr=4095,a=180.0,rn=180,rx=180,sm=180.0,sx=0.0,pw=2500,lu=2000
  // = ~95 chars + null = 96 — fits comfortably.
  //
  // Float fields (1 decimal place) expose sub-degree values that integer-only
  // logging was hiding. The control path writes pulse width directly from the
  // float angle, so `pw` now reflects the exact commanded hardware pulse width.
  //   c=  — commanded position as received (float, 1dp)
  //   a=  — appliedAngle before pulse-width conversion (float, 1dp)
  //   sm= — range min from unsnapped EMA path (float, 1dp, debug reference)
  //   sx= — range max from unsnapped EMA path (float, 1dp, debug reference)
  // rn=/rx= remain integers — they are intentionally snapped to 5° steps.
  // p=/pr= remain integer ADC counts — already higher resolution than needed.
  char frame[TELEMETRY_FRAME_BUFFER_LEN];
  const unsigned int pulseWidthUs = static_cast<unsigned int>(lastAppliedPulseWidthUs);
  const unsigned long loopDurationUs = static_cast<unsigned long>(lastLoopDurationUs);
  snprintf(frame, sizeof(frame),
           "c=%.1f,m=%c,g=%d,p=%u,pr=%u,a=%.1f,rn=%d,rx=%d,sm=%.1f,sx=%.1f,pw=%u,lu=%lu",
           commandedPosition,
           currentMode == ControlMode::Oscillation ? 'o' : 's',
           serialTimeoutGuardActive ? 1 : 0,
           static_cast<unsigned int>(lastPotEma),
           static_cast<unsigned int>(lastPotRaw),
           appliedAngle,
           toWholeDegrees(lastExpectedMinAngle),
           toWholeDegrees(lastExpectedMaxAngle),
           lastServoMinAngle,
           lastServoMaxAngle,
           pulseWidthUs,
           loopDurationUs);

  emitTelemetryFrame(frame);
}

/**
 * Initialize BLE with Nordic UART Service (NUS).
 *
 * NUS emulates a serial port over BLE using two characteristics:
 * - RX (host writes, device reads): commands
 * - TX (device notifies host):      telemetry
 *
 * The device advertises by NUS UUID so the dashboard Web Bluetooth picker
 * can filter to show only Colloquy Pointer devices.
 * After a client disconnects, advertising restarts automatically via
 * BleServerCallbacks::onDisconnect(), so no power cycle is needed to reconnect.
 */
void initBle() {
  NimBLEDevice::init(BLE_DEVICE_NAME);
  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new BleServerCallbacks());

  NimBLEService* service = server->createService(NUS_SERVICE_UUID);

  // RX: host writes commands here. WRITE_NR = write without response (lower latency).
  NimBLECharacteristic* rxChar = service->createCharacteristic(
      NUS_RX_CHAR_UUID,
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
  );
  rxChar->setCallbacks(new BleRxCallbacks());

  // TX: device sends telemetry frame notifications here.
  bleTxCharacteristic = service->createCharacteristic(
      NUS_TX_CHAR_UUID,
      NIMBLE_PROPERTY::NOTIFY
  );

  service->start();
  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(NUS_SERVICE_UUID);
  advertising->start();

  Serial.print("BLE initialized. Advertising as \"");
  Serial.print(BLE_DEVICE_NAME);
  Serial.println("\".");
}

/**
 * Initialize optional SSD1306 OLED on board-default I2C pins.
 *
 * Probe order: 0x3C then 0x3D.
 * If no OLED is found, firmware continues with serial-only telemetry.
 */
void initOled() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(400000);

  if (oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    oledAvailable = true;
    oledAddress = 0x3C;
  } else if (oled.begin(SSD1306_SWITCHCAPVCC, 0x3D)) {
    oledAvailable = true;
    oledAddress = 0x3D;
  }

  if (!oledAvailable) {
    Serial.println("OLED not detected at 0x3C/0x3D; continuing without display.");
    return;
  }

  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);
  oled.println("Virtual Colloquy");
  oled.print("fw v");
  oled.println(FIRMWARE_VERSION);
  oled.println("OLED online");
  oled.print("I2C 0x");
  oled.println(oledAddress, HEX);
  oled.display();

  Serial.print("OLED detected at 0x");
  Serial.println(oledAddress, HEX);

  // Reset incremental redraw state after startup splash.
  oledDirtyRegionActive = false;
  oledStatusLayoutDrawn = false;
}

/**
 * Mark a rectangular OLED region as dirty (needs transfer to panel).
 *
 * Coordinates are in pixel space. SSD1306 memory is page-based (8 px tall),
 * so y ranges are converted into page ranges for transfer.
 */
void markOledDirtyRect(uint8_t x, uint8_t y, uint8_t w, uint8_t h) {
  if (w == 0 || h == 0) {
    return;
  }

  const uint8_t x0 = static_cast<uint8_t>(min<int>(127, x));
  const uint8_t x1 = static_cast<uint8_t>(min<int>(127, static_cast<int>(x) + static_cast<int>(w) - 1));
  const uint8_t p0 = static_cast<uint8_t>(min<int>(7, y / 8));
  const uint8_t p1 = static_cast<uint8_t>(min<int>(7, (static_cast<int>(y) + static_cast<int>(h) - 1) / 8));

  if (!oledDirtyRegionActive) {
    oledDirtyRegionActive = true;
    oledDirtyXMin = x0;
    oledDirtyXMax = x1;
    oledDirtyPageMin = p0;
    oledDirtyPageMax = p1;
    return;
  }

  oledDirtyXMin = min<uint8_t>(oledDirtyXMin, x0);
  oledDirtyXMax = max<uint8_t>(oledDirtyXMax, x1);
  oledDirtyPageMin = min<uint8_t>(oledDirtyPageMin, p0);
  oledDirtyPageMax = max<uint8_t>(oledDirtyPageMax, p1);
}

/**
 * Send a command sequence to the SSD1306 over I2C.
 */
void oledSendCommands(const uint8_t* cmds, size_t count) {
  if (cmds == nullptr || count == 0) {
    return;
  }
  Wire.beginTransmission(oledAddress);
  Wire.write(0x00);
  for (size_t i = 0; i < count; ++i) {
    Wire.write(cmds[i]);
  }
  Wire.endTransmission();
}

/**
 * Flush only dirty pages/columns from the local framebuffer to the OLED.
 *
 * Adafruit_SSD1306 keeps a full local framebuffer. Instead of calling
 * display() (full transfer), this copies only the dirty bounding region.
 */
void flushOledDirtyRegion() {
  if (!oledAvailable || !oledDirtyRegionActive) {
    return;
  }

  uint8_t* buffer = oled.getBuffer();
  if (buffer == nullptr) {
    oledDirtyRegionActive = false;
    return;
  }

  const uint8_t xStart = oledDirtyXMin;
  const uint8_t xEnd = oledDirtyXMax;

  for (uint8_t page = oledDirtyPageMin; page <= oledDirtyPageMax; ++page) {
    const uint8_t windowCmds[] = { 0x21, xStart, xEnd, 0x22, page, page };
    oledSendCommands(windowCmds, sizeof(windowCmds));

    const size_t rowOffset = static_cast<size_t>(page) * 128u;
    size_t src = rowOffset + xStart;
    size_t remaining = static_cast<size_t>(xEnd - xStart + 1);

    // Keep each packet small so it is safe with conservative I2C buffer sizes.
    while (remaining > 0) {
      const size_t chunk = min<size_t>(remaining, 16u);
      Wire.beginTransmission(oledAddress);
      Wire.write(0x40);
      Wire.write(buffer + src, chunk);
      Wire.endTransmission();
      src += chunk;
      remaining -= chunk;
    }
  }

  oledDirtyRegionActive = false;
}

/**
 * Draw a dynamic OLED value field by clearing only that row segment first.
 *
 * This avoids clearing the full display buffer on every refresh. We keep
 * static labels intact and only rewrite value regions that changed.
 */
void drawOledValueRow(uint8_t y, uint8_t valueX, const char* valueText) {
  const int16_t clearWidth = 128 - valueX;
  oled.fillRect(valueX, y, clearWidth, 8, SSD1306_BLACK);
  oled.setCursor(valueX, y);
  oled.print(valueText);
  markOledDirtyRect(valueX, y, static_cast<uint8_t>(clearWidth), 8);
}

/**
 * Refresh OLED status panel at a bounded update rate.
 *
 * Side effects:
 * - Draws mode, guard state, command, potentiometer value, and angle.
 * - Returns immediately when OLED is unavailable.
 */
void refreshOledStatus() {
  if (!oledAvailable) {
    return;
  }

  const uint32_t now = millis();
  if (now - lastOledRefreshMs < OLED_REFRESH_INTERVAL_MS) {
    return;
  }
  lastOledRefreshMs = now;

  bool dirty = false;
  if (!oledStatusLayoutDrawn) {
    oled.clearDisplay();
    oled.setCursor(0, 0);
    oled.println("Virtual Colloquy");
    oled.print("fw v");
    oled.println(FIRMWARE_VERSION);
    oled.setCursor(0, 16);
    oled.println("Control mode:");
    oled.setCursor(0, 24);
    oled.println("Safety guard:");
    oled.setCursor(0, 32);
    oled.println("Command:");
    oled.setCursor(0, 40);
    oled.println("Range:");
    oled.setCursor(0, 48);
    oled.println("Angle deg:");
    oledStatusLayoutDrawn = true;
    markOledDirtyRect(0, 0, 128, 64);
    dirty = true;
  }

  const ControlMode modeNow = currentMode;
  const bool guardNow = serialTimeoutGuardActive;
  const int commandTenthsNow = static_cast<int>(roundf(commandedPosition * 10.0f));
  const int rangeMinNow = toWholeDegrees(lastExpectedMinAngle);
  const int rangeMaxNow = toWholeDegrees(lastExpectedMaxAngle);
  const int angleNow = toWholeDegrees(appliedAngle);

  if (modeNow != oledShownMode) {
    drawOledValueRow(16, 78, modeNow == ControlMode::Oscillation ? "osc" : "serial");
    oledShownMode = modeNow;
    dirty = true;
  }

  if (guardNow != oledShownGuard) {
    drawOledValueRow(24, 74, guardNow ? "timeout" : "ok");
    oledShownGuard = guardNow;
    dirty = true;
  }

  if (commandTenthsNow != oledShownCommandTenths) {
    char valueBuf[16];
    snprintf(valueBuf, sizeof(valueBuf), "%.1f", commandedPosition);
    drawOledValueRow(32, 52, valueBuf);
    oledShownCommandTenths = commandTenthsNow;
    dirty = true;
  }

  if (rangeMinNow != oledShownRangeMinDeg || rangeMaxNow != oledShownRangeMaxDeg) {
    char valueBuf[24];
    snprintf(valueBuf, sizeof(valueBuf), "%d-%d", rangeMinNow, rangeMaxNow);
    drawOledValueRow(40, 38, valueBuf);
    oledShownRangeMinDeg = rangeMinNow;
    oledShownRangeMaxDeg = rangeMaxNow;
    dirty = true;
  }

  if (angleNow != oledShownAngleDeg) {
    char valueBuf[12];
    snprintf(valueBuf, sizeof(valueBuf), "%d", angleNow);
    drawOledValueRow(48, 62, valueBuf);
    oledShownAngleDeg = angleNow;
    dirty = true;
  }

  if (dirty) {
    flushOledDirtyRegion();
  }
}

/**
 * Pulse the built-in NeoPixel with a slow white breathing animation.
 *
 * Brightness follows a sine wave so the transition is smooth and gradual.
 * Running at ~30 Hz keeps CPU cost negligible (one pixel = ~50 µs of WS2812
 * signal per show() call).
 * This is a pure liveness indicator — if the heartbeat stops the device has
 * locked up or lost power.
 */
void updateHeartbeat() {
  const uint32_t now = millis();
  if (now - lastHeartbeatMs < HEARTBEAT_INTERVAL_MS) {
    return;
  }
  lastHeartbeatMs = now;

  const float phase = (static_cast<float>(now % HEARTBEAT_PERIOD_MS) /
                       static_cast<float>(HEARTBEAT_PERIOD_MS)) *
                      2.0f * PI;
  const float brightness = (sinf(phase) + 1.0f) * 0.5f *
                            static_cast<float>(HEARTBEAT_MAX_BRIGHTNESS);
  const uint8_t b = static_cast<uint8_t>(brightness);
  neoPixel.setPixelColor(0, neoPixel.Color(b, b, b));
  neoPixel.show();
}

/**
 * Three-second boot sweep to confirm servo is alive and range is correct.
 *
 * Sequence: center → minimum → maximum → center.
 * Uses the snapped active control range (lastExpectedMinAngle/Max) so the
 * sweep matches the same quantized envelope used during runtime.
 *
 * Call once from setup() after the EMA warmup, before loop() starts.
 * Total blocking time: ~3 seconds (500 + 1000 + 1000 + 500 ms).
 */
void runBootSweep() {
  const int centerAngle = static_cast<int>((lastExpectedMinAngle + lastExpectedMaxAngle) * 0.5f);
  const int minAngle    = static_cast<int>(lastExpectedMinAngle);
  const int maxAngle    = static_cast<int>(lastExpectedMaxAngle);

  Serial.print("Boot sweep: range ");
  Serial.print(minAngle);
  Serial.print("\u00b0\u2013");
  Serial.print(maxAngle);
  Serial.println("\u00b0 | center \u2192 min \u2192 max \u2192 center");

  pointerServo.write(centerAngle);  delay(500);
  pointerServo.write(minAngle);     delay(1000);
  pointerServo.write(maxAngle);     delay(1000);
  pointerServo.write(centerAngle);  delay(500);

  // Update tracking globals so loop() starts from a known position.
  appliedAngle = static_cast<float>(centerAngle);
  lastAppliedPulseWidthUs = pulseWidthFromAngle(appliedAngle);
  Serial.println("Boot sweep complete.");
}

/**
 * Arduino setup entry point for one-time peripheral initialization.
 */
void setup() {
  Serial.begin(115200);
  delay(250);

  // Enable and initialise the built-in NeoPixel.
  // NEOPIXEL_POWER must be driven HIGH before calling neoPixel.begin() or
  // the LED will not be powered. Turn it off immediately so startup is clean.
  pinMode(NEOPIXEL_POWER, OUTPUT);
  digitalWrite(NEOPIXEL_POWER, HIGH);
  neoPixel.begin();
  neoPixel.clear();
  neoPixel.show();

  analogReadResolution(12);
  pinMode(POT_PIN, INPUT);
  pinMode(MODE_SWITCH_PIN, INPUT_PULLUP);

  initOled();
  initBle();

  pointerServo.setPeriodHertz(50);
  pointerServo.attach(SERVO_PIN, SERVO_MIN_US, SERVO_MAX_US);

  // Move immediately to center so the servo starts from a known position
  // while the pot filter warms up. applyServoOutput() is not used here
  // because potEmaSettled is still false at this point.
  {
    const int bootCenter = static_cast<int>((SERVO_MIN_ANGLE + SERVO_MAX_ANGLE) * 0.5f);
    pointerServo.write(bootCenter);
    appliedAngle = static_cast<float>(bootCenter);
    lastAppliedPulseWidthUs = pulseWidthFromAngle(appliedAngle);
  }

  // Pump the ADC filter for POT_EMA_SETTLE_MS (4 × tau = 500 ms) so the EMA
  // has reached a stable value before the servo tracks it.
  // delay(1) between samples yields to the FreeRTOS scheduler so the
  // BLE stack and watchdog timer are not starved during this blocking period.
  Serial.println("Warming up pot filter...");
  {
    const uint32_t warmupStartMs = millis();
    while (millis() - warmupStartMs < POT_EMA_SETTLE_MS) {
      lastSpanScale = readCalibrationSpanScale();
      delay(1);
    }
    // Start with a predictable full-span default (rn=0, rx=180).
    // The live pot-driven range will take over in loop() as updatePotSample()
    // runs, but startup/boot-sweep behavior begins from the known defaults.
    lastServoMinAngle = SERVO_MIN_ANGLE;
    lastServoMaxAngle = SERVO_MAX_ANGLE;
    lastExpectedMinAngle = SERVO_MIN_ANGLE;
    lastExpectedMaxAngle = SERVO_MAX_ANGLE;
    Serial.println("Pot filter settled.");
  }

  // Run the 3-second boot sweep to confirm servo travel, then unlock normal operation.
  runBootSweep();
  potEmaSettled = true;

  commandedPosition = 0.0f;
  lastValidSerialCommandMs = millis();
  serialTimeoutGuardActive = true;

  Serial.println("Colloquy of Mobiles Virtual Simulation Phygital ready.");
  Serial.println("Send newline-terminated commands in range -100..100.");
  Serial.println("Example commands: 0, 25, -40, 100");
  Serial.println("Mode switch HIGH = serial control; LOW = automatic oscillation test.");
}

/**
 * Arduino main loop entry point — runs at a fixed 500 Hz tick rate.
 *
 * The tick scheduler at the top paces the loop to exactly 2 ms minimum
 * per iteration. Work non-blocking: each subsystem checks its own timer
 * and returns immediately if it is not yet due.
 */
void loop() {
  // NOTE: This scheduler keeps phase-coherent deadlines, but it cannot force
  // 500 Hz when loop work itself exceeds 2 ms. In that case lps will read <500.
  waitForNextTick();

  const uint32_t loopStartUs = micros();
  static uint32_t prevLoopStartUs = 0;
  if (prevLoopStartUs != 0) {
    lastLoopPeriodUs = loopStartUs - prevLoopStartUs;
  }
  prevLoopStartUs = loopStartUs;

  // 1-second diagnostics accumulators (max task duration per window).
  static uint32_t maxProcessSerialUs = 0;
  static uint32_t maxModeUpdateUs = 0;
  static uint32_t maxPotSampleUs = 0;
  static uint32_t maxServoOutputUs = 0;
  static uint32_t maxPrintStatusUs = 0;
  static uint32_t maxOledUs = 0;
  static uint32_t maxHeartbeatUs = 0;
  static uint32_t maxLoopWorkUs = 0;

  // Keep lastLoopDurationUs as the prior loop's measured duration until the
  // end of this loop, so telemetry reports a real, non-zero previous sample.
  const uint32_t loopWorkStartUs = loopStartUs;

  uint32_t taskStartUs = micros();
  processSerialInput();
  const uint32_t processSerialUs = micros() - taskStartUs;
  if (processSerialUs > maxProcessSerialUs) {
    maxProcessSerialUs = processSerialUs;
  }

  taskStartUs = micros();
  updateControlModeAndCommand();
  const uint32_t modeUpdateUs = micros() - taskStartUs;
  if (modeUpdateUs > maxModeUpdateUs) {
    maxModeUpdateUs = modeUpdateUs;
  }

  taskStartUs = micros();
  updatePotSample();    // every tick — feeds ADC samples into the 125 ms EMA window
  const uint32_t potSampleUs = micros() - taskStartUs;
  if (potSampleUs > maxPotSampleUs) {
    maxPotSampleUs = potSampleUs;
  }

  taskStartUs = micros();
  applyServoOutput();   // every tick, but servo.write() only on angle change
  const uint32_t servoOutputUs = micros() - taskStartUs;
  if (servoOutputUs > maxServoOutputUs) {
    maxServoOutputUs = servoOutputUs;
  }

  taskStartUs = micros();
  printStatus();
  const uint32_t printStatusUs = micros() - taskStartUs;
  if (printStatusUs > maxPrintStatusUs) {
    maxPrintStatusUs = printStatusUs;
  }

  taskStartUs = micros();
  refreshOledStatus();
  const uint32_t oledUs = micros() - taskStartUs;
  if (oledUs > maxOledUs) {
    maxOledUs = oledUs;
  }

  taskStartUs = micros();
  updateHeartbeat();
  const uint32_t heartbeatUs = micros() - taskStartUs;
  if (heartbeatUs > maxHeartbeatUs) {
    maxHeartbeatUs = heartbeatUs;
  }

  // Emit a 1 Hz diagnostics line with the loop rate and firmware version.
  // lps= uses elapsed wall time across the 1-second window instead of a
  // fixed 1000 ms assumption, avoiding bucket-boundary math artifacts.
  // fv= (firmware version) is sent here rather than in every 20 Hz frame
  // because it never changes — once the dashboard receives it once, the
  // merge-semantics update keeps it displayed indefinitely.
  static uint32_t dbgCount = 0;
  static uint32_t dbgLastMs = 0;
  const uint32_t nowMs = millis();
  ++dbgCount;
  if (nowMs - dbgLastMs >= 1000) {
    const uint32_t elapsedMs = (dbgLastMs == 0) ? 1000u : (nowMs - dbgLastMs);
    const uint32_t loopsPerSecond = static_cast<uint32_t>((static_cast<float>(dbgCount) * 1000.0f / static_cast<float>(elapsedMs)) + 0.5f);
    char lpsFrame[32];
    snprintf(lpsFrame, sizeof(lpsFrame), "lps=%u,fv=%s", loopsPerSecond, FIRMWARE_VERSION);
    emitTelemetryFrame(lpsFrame);

    // perf=1 frame reports max task durations in the same window.
    // Keys:
    // lp = loop period (most recent) in us
    // lu = previous loop active-work duration in us
    // lm = max loop active-work duration in window in us
    // si/cm/ps/so/st/od/hb = max task duration in window in us
    char perfFrame[TELEMETRY_FRAME_BUFFER_LEN];
    snprintf(perfFrame, sizeof(perfFrame),
             "perf=1,lp=%lu,lu=%lu,lm=%lu,si=%lu,cm=%lu,ps=%lu,so=%lu,st=%lu,od=%lu,hb=%lu",
             static_cast<unsigned long>(lastLoopPeriodUs),
             static_cast<unsigned long>(lastLoopDurationUs),
             static_cast<unsigned long>(maxLoopWorkUs),
             static_cast<unsigned long>(maxProcessSerialUs),
             static_cast<unsigned long>(maxModeUpdateUs),
             static_cast<unsigned long>(maxPotSampleUs),
             static_cast<unsigned long>(maxServoOutputUs),
             static_cast<unsigned long>(maxPrintStatusUs),
             static_cast<unsigned long>(maxOledUs),
             static_cast<unsigned long>(maxHeartbeatUs));
    emitTelemetryFrame(perfFrame);

    dbgCount = 0;
    dbgLastMs = nowMs;
    maxProcessSerialUs = 0;
    maxModeUpdateUs = 0;
    maxPotSampleUs = 0;
    maxServoOutputUs = 0;
    maxPrintStatusUs = 0;
    maxOledUs = 0;
    maxHeartbeatUs = 0;
    maxLoopWorkUs = 0;
  }

  lastLoopDurationUs = micros() - loopWorkStartUs;
  if (lastLoopDurationUs > maxLoopWorkUs) {
    maxLoopWorkUs = lastLoopDurationUs;
  }
}
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

/**
 * Module overview:
 * - Receives newline-delimited serial commands in the range -100..100.
 * - Supports a hardware switch to choose serial control vs test oscillation mode.
 * - Reads a potentiometer to scale active servo span for calibration.
 * - Drives an LS-3006 servo in open loop.
 * - Reports runtime status over USB Serial, BLE (Nordic UART Service), and optional SSD1306 OLED.
 * - Commands are accepted identically over USB or BLE — same protocol, same behavior.
 */

/**
 * Wiring quick reference (prototype bench setup)
 *
 * Servo (LS-3006, Hitec-style wire colors):
 * - Black  -> GND (common ground with ESP32)
 * - Red    -> External servo supply V+ (typically 5V)
 * - Yellow -> SERVO_PIN (GPIO13 signal)
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

// LS-3006 exact travel/pulse specs are not yet confirmed, so start conservative.
constexpr int SERVO_MIN_US = 1000;
constexpr int SERVO_MAX_US = 2000;
// For prototype calibration behavior, assume logical 0..180 degree span.
// Potentiometer at maximum will collapse travel to center (~90 deg).
constexpr float SERVO_MIN_ANGLE = 0.0f;
constexpr float SERVO_MAX_ANGLE = 180.0f;

constexpr float COMMAND_MIN = -100.0f;
constexpr float COMMAND_MAX = 100.0f;

// Potentiometer controls how much of the available servo span is used.
// User request mapping:
// - pot at 0    => full range (span scale = 1.0)
// - pot at max  => zero range, hold center (~90 deg) (span scale = 0.0)
constexpr float CALIBRATION_SPAN_MIN_SCALE = 0.0f;
constexpr float CALIBRATION_SPAN_MAX_SCALE = 1.0f;
constexpr size_t POT_RUNNING_AVERAGE_SAMPLES = 32;

constexpr size_t SERIAL_BUFFER_LEN = 64;
constexpr uint32_t STATUS_PRINT_INTERVAL_MS = 50; // 20 Hz — matches dashboard oscillator drive rate
constexpr uint32_t OLED_REFRESH_INTERVAL_MS = 250;
constexpr uint32_t SERIAL_COMMAND_TIMEOUT_MS = 1500;

// Snap the displayed range bounds (rn/rx) to this increment as the user turns
// the calibration knob. The servo itself moves continuously at full resolution.
constexpr float RANGE_DISPLAY_STEP_DEG = 5.0f;

// Trapezoidal oscillation: pointer travels between -OSCILLATION_AMPLITUDE and
// +OSCILLATION_AMPLITUDE with a velocity-limited, acceleration-limited profile.
// Units are command space (-100..100), so these are command-units/sec and
// command-units/sec² respectively. With defaults of 5/5 the pointer takes
// ~41 sec per one-way pass (1 sec accel + 39 sec coast + 1 sec decel).
constexpr float OSCILLATION_AMPLITUDE  = 100.0f;
constexpr float OSC_MAX_VELOCITY       = 5.0f;  // command units per second
constexpr float OSC_MAX_ACCEL          = 5.0f;  // command units per second²

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
float appliedAngle = 90.0f;
uint16_t lastPotRaw = 0;
uint16_t lastPotAverage = 0;
float lastSpanScale = 1.0f;
float lastExpectedMinAngle = SERVO_MIN_ANGLE;
float lastExpectedMaxAngle = SERVO_MAX_ANGLE;
uint32_t lastStatusPrintMs = 0;
uint32_t lastOledRefreshMs = 0;
uint32_t lastValidSerialCommandMs = 0;
ControlMode currentMode = ControlMode::Serial;
bool oledAvailable = false;
uint8_t oledAddress = 0;
bool serialTimeoutGuardActive = false;
uint16_t potFilterBuffer[POT_RUNNING_AVERAGE_SAMPLES] = {0};
size_t potFilterIndex = 0;
uint32_t potFilterSum = 0;
bool potFilterInitialized = false;

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
 * ADC assumptions:
 * - 12-bit resolution (`0..4095`)
 * - Input pin tied to user calibration potentiometer
 *
 * @param potRawOut Optional output pointer for raw ADC capture.
 * @return Span scale in [CALIBRATION_SPAN_MIN_SCALE, CALIBRATION_SPAN_MAX_SCALE].
 */
float readCalibrationSpanScale(uint16_t* potRawOut) {
  const uint16_t potRaw = analogRead(POT_PIN);
  lastPotRaw = potRaw;

  if (!potFilterInitialized) {
    // Initialize the running-average window to the first sample to avoid
    // startup transients that would otherwise shrink range temporarily.
    for (size_t i = 0; i < POT_RUNNING_AVERAGE_SAMPLES; ++i) {
      potFilterBuffer[i] = potRaw;
      potFilterSum += potRaw;
    }
    potFilterInitialized = true;
    potFilterIndex = 0;
  } else {
    potFilterSum -= potFilterBuffer[potFilterIndex];
    potFilterBuffer[potFilterIndex] = potRaw;
    potFilterSum += potRaw;
    potFilterIndex = (potFilterIndex + 1) % POT_RUNNING_AVERAGE_SAMPLES;
  }

  const uint16_t potAverage =
      static_cast<uint16_t>(potFilterSum / POT_RUNNING_AVERAGE_SAMPLES);
  lastPotAverage = potAverage;

  if (potRawOut != nullptr) {
    *potRawOut = potAverage;
  }

  const float unit = static_cast<float>(potAverage) / 4095.0f;
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

  // Accept the first numeric token in a line, e.g. "37", "pos=37", "cmd:-22.5".
  const char* scan = line;
  while (*scan != '\0') {
    if ((*scan >= '0' && *scan <= '9') || *scan == '-' || *scan == '+') {
      break;
    }
    ++scan;
  }

  if (*scan == '\0') {
    return false;
  }

  char* endPtr = nullptr;
  const float parsed = strtof(scan, &endPtr);
  if (endPtr == scan) {
    return false;
  }

  *outValue = parsed;
  return true;
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
 * Apply the current command to the servo after calibration mapping.
 *
 * Side effects:
 * - Reads current potentiometer value.
 * - Updates `appliedAngle` and writes to servo driver.
 */
void applyServoOutput() {
  const float spanScale = readCalibrationSpanScale(&lastPotRaw);
  lastSpanScale = spanScale;
  expectedServoRangeFromScale(spanScale, &lastExpectedMinAngle,
                              &lastExpectedMaxAngle);
  // Snap the range endpoints to the nearest increment. This quantizes away
  // ADC noise from the pot before it propagates into the servo output.
  // Everything downstream — including the servo command — uses these snapped
  // values, so the jitter is eliminated at the source.
  lastExpectedMinAngle = snapToNearestIncrement(lastExpectedMinAngle, RANGE_DISPLAY_STEP_DEG);
  lastExpectedMaxAngle = snapToNearestIncrement(lastExpectedMaxAngle, RANGE_DISPLAY_STEP_DEG);

  // Derive the applied angle from the snapped bounds, not from raw spanScale.
  // This keeps the servo output consistent with what rn/rx report.
  const float snappedCenter   = (lastExpectedMinAngle + lastExpectedMaxAngle) * 0.5f;
  const float snappedHalfSpan = (lastExpectedMaxAngle - lastExpectedMinAngle) * 0.5f;
  const float normalized      = normalizedFromCommand(commandedPosition);
  appliedAngle = clampf(snappedCenter + normalized * snappedHalfSpan,
                        SERVO_MIN_ANGLE, SERVO_MAX_ANGLE);
  pointerServo.write(static_cast<int>(appliedAngle));
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
 */
void printStatus() {
  const uint32_t now = millis();
  if (now - lastStatusPrintMs < STATUS_PRINT_INTERVAL_MS) {
    return;
  }

  lastStatusPrintMs = now;

  // Build the telemetry frame once and route to all active transports.
  // Using snprintf ensures the frame is a proper null-terminated string
  // that can be sent to Serial and BLE without duplication.
  char frame[64];
  snprintf(frame, sizeof(frame),
           "c=%d,m=%c,g=%d,p=%u,a=%d,rn=%d,rx=%d",
           static_cast<int>(roundf(commandedPosition)),
           currentMode == ControlMode::Oscillation ? 'o' : 's',
           serialTimeoutGuardActive ? 1 : 0,
           static_cast<unsigned int>(lastPotAverage),
           toWholeDegrees(appliedAngle),
           toWholeDegrees(lastExpectedMinAngle),
           toWholeDegrees(lastExpectedMaxAngle));

  Serial.println(frame);

  // Notify BLE client if one is connected. Append \n so the dashboard
  // line-split parser treats this the same as a USB serial line.
  if (bleClientConnected && bleTxCharacteristic != nullptr) {
    char frameNl[66];
    snprintf(frameNl, sizeof(frameNl), "%s\n", frame);
    bleTxCharacteristic->setValue(reinterpret_cast<uint8_t*>(frameNl), strlen(frameNl));
    bleTxCharacteristic->notify();
  }
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
  oled.println("OLED online");
  oled.print("I2C 0x");
  oled.println(oledAddress, HEX);
  oled.display();

  Serial.print("OLED detected at 0x");
  Serial.println(oledAddress, HEX);
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

  oled.clearDisplay();
  oled.setCursor(0, 0);
  oled.println("Virtual Colloquy");

  oled.print("Control mode: ");
  oled.println(currentMode == ControlMode::Oscillation ? "osc" : "serial");

  oled.print("Safety guard: ");
  oled.println(serialTimeoutGuardActive ? "timeout" : "ok");

  oled.print("Command: ");
  oled.println(commandedPosition, 1);

  oled.print("Range: ");
  oled.print(toWholeDegrees(lastExpectedMinAngle));
  oled.print("-");
  oled.println(toWholeDegrees(lastExpectedMaxAngle));

  oled.print("Angle deg: ");
  oled.println(toWholeDegrees(appliedAngle));

  oled.display();
}

/**
 * Arduino setup entry point for one-time peripheral initialization.
 */
void setup() {
  Serial.begin(115200);
  delay(250);

  analogReadResolution(12);
  pinMode(POT_PIN, INPUT);
  pinMode(MODE_SWITCH_PIN, INPUT_PULLUP);

  initOled();
  initBle();

  pointerServo.setPeriodHertz(50);
  pointerServo.attach(SERVO_PIN, SERVO_MIN_US, SERVO_MAX_US);

  commandedPosition = 0.0f;
  lastValidSerialCommandMs = millis();
  serialTimeoutGuardActive = true;
  applyServoOutput();

  Serial.println("Colloquy of Mobiles Virtual Simulation Phygital ready.");
  Serial.println("Send newline-terminated commands in range -100..100.");
  Serial.println("Example commands: 0, 25, -40, 100");
  Serial.println("Mode switch HIGH = serial control; LOW = automatic oscillation test.");
}

/**
 * Arduino main loop entry point.
 *
 * Keeps work non-blocking by handling input, mode resolution, output update,
 * and periodic telemetry each pass.
 */
void loop() {
  processSerialInput();
  updateControlModeAndCommand();
  applyServoOutput();
  printStatus();
  refreshOledStatus();
}
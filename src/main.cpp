/*
 * main.cpp
 * Project: Virtual Colloquy Direction Indicator
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

namespace {

/**
 * Module overview:
 * - Receives newline-delimited serial commands in the range -100..100.
 * - Supports a hardware switch to choose serial control vs test oscillation mode.
 * - Reads a potentiometer to scale active servo span for calibration.
 * - Drives an LS-3006 servo in open loop.
 * - Reports runtime status over Serial and optional SSD1306 OLED.
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
constexpr float SERVO_MIN_ANGLE = 30.0f;
constexpr float SERVO_MAX_ANGLE = 150.0f;

constexpr float COMMAND_MIN = -100.0f;
constexpr float COMMAND_MAX = 100.0f;

// Potentiometer controls how much of the available servo span is used.
constexpr float CALIBRATION_SPAN_MIN_SCALE = 0.35f;
constexpr float CALIBRATION_SPAN_MAX_SCALE = 1.00f;

constexpr size_t SERIAL_BUFFER_LEN = 64;
constexpr uint32_t STATUS_PRINT_INTERVAL_MS = 200;
constexpr uint32_t OLED_REFRESH_INTERVAL_MS = 250;
constexpr uint32_t SERIAL_COMMAND_TIMEOUT_MS = 1500;

constexpr float OSCILLATION_AMPLITUDE = 100.0f;
constexpr float OSCILLATION_PERIOD_MS = 3000.0f;

enum class ControlMode {
  Serial,
  Oscillation,
};

Servo pointerServo;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);

char serialBuffer[SERIAL_BUFFER_LEN] = {0};
size_t serialBufferPos = 0;

float commandedPosition = 0.0f;
float appliedAngle = 90.0f;
uint16_t lastPotRaw = 0;
uint32_t lastStatusPrintMs = 0;
uint32_t lastOledRefreshMs = 0;
uint32_t lastValidSerialCommandMs = 0;
ControlMode currentMode = ControlMode::Serial;
bool oledAvailable = false;
uint8_t oledAddress = 0;
bool serialTimeoutGuardActive = false;

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
  if (potRawOut != nullptr) {
    *potRawOut = potRaw;
  }

  const float unit = static_cast<float>(potRaw) / 4095.0f;
  return CALIBRATION_SPAN_MIN_SCALE +
         unit * (CALIBRATION_SPAN_MAX_SCALE - CALIBRATION_SPAN_MIN_SCALE);
}

/**
 * Map a command value to a bounded servo angle based on live span scaling.
 *
 * @param commandValue Command value expected in -100..100 range.
 * @param spanScale Pot-derived multiplier for available travel.
 * @return Target servo angle in [SERVO_MIN_ANGLE, SERVO_MAX_ANGLE].
 */
float commandToServoAngle(float commandValue, float spanScale) {
  const float center = (SERVO_MIN_ANGLE + SERVO_MAX_ANGLE) * 0.5f;
  const float maxTravelFromCenter =
      ((SERVO_MAX_ANGLE - SERVO_MIN_ANGLE) * 0.5f) * spanScale;

  const float normalized = normalizedFromCommand(commandValue);
  const float angle = center + normalized * maxTravelFromCenter;
  return clampf(angle, SERVO_MIN_ANGLE, SERVO_MAX_ANGLE);
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
 * Consume incoming serial bytes into line-buffered command frames.
 *
 * Side effects:
 * - Updates `commandedPosition` on valid parse.
 * - Updates `lastValidSerialCommandMs` to service timeout guard.
 * - Clears buffer on line completion or overflow to stay non-blocking.
 */
void processSerialInput() {
  while (Serial.available() > 0) {
    const char c = static_cast<char>(Serial.read());

    if (c == '\n' || c == '\r') {
      if (serialBufferPos == 0) {
        continue;
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
      continue;
    }

    if (serialBufferPos < (SERIAL_BUFFER_LEN - 1)) {
      serialBuffer[serialBufferPos++] = c;
    } else {
      // Overflow guard: reset buffer and wait for next line.
      serialBufferPos = 0;
      serialBuffer[0] = '\0';
    }
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
  appliedAngle = commandToServoAngle(commandedPosition, spanScale);
  pointerServo.write(static_cast<int>(appliedAngle));
}

/**
 * Produce a smooth test command for oscillation mode.
 *
 * @return Synthetic command in approximately [-OSCILLATION_AMPLITUDE, +OSCILLATION_AMPLITUDE].
 */
float getOscillationCommand() {
  const float phase =
      static_cast<float>(millis()) * (2.0f * PI / OSCILLATION_PERIOD_MS);
  return sinf(phase) * OSCILLATION_AMPLITUDE;
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
 * Output fields include command, mode, guard state, potentiometer raw ADC,
 * and currently applied angle.
 */
void printStatus() {
  const uint32_t now = millis();
  if (now - lastStatusPrintMs < STATUS_PRINT_INTERVAL_MS) {
    return;
  }

  lastStatusPrintMs = now;

  Serial.print("command=");
  Serial.print(commandedPosition, 2);
  Serial.print(",mode=");
  Serial.print(currentMode == ControlMode::Oscillation ? "osc" : "serial");
  Serial.print(",guard=");
  Serial.print(serialTimeoutGuardActive ? "timeout" : "ok");
  Serial.print(",potRaw=");
  Serial.print(lastPotRaw);
  Serial.print(",servoAngleDeg=");
  Serial.println(appliedAngle, 1);
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

  oled.print("Pot raw: ");
  oled.println(lastPotRaw);

  oled.print("Angle deg: ");
  oled.println(appliedAngle, 1);

  oled.print("I2C: 0x");
  oled.println(oledAddress, HEX);

  oled.display();
}

}  // namespace

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

  pointerServo.setPeriodHertz(50);
  pointerServo.attach(SERVO_PIN, SERVO_MIN_US, SERVO_MAX_US);

  commandedPosition = 0.0f;
  lastValidSerialCommandMs = millis();
  serialTimeoutGuardActive = true;
  applyServoOutput();

  Serial.println("Virtual Colloquy Direction Indicator ready.");
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
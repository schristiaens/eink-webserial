// Minimal driver for the 1.54" 200x200 B/W panel (SSD1681) on the Waveshare
// ESP32-S3-ePaper-1.54. Init sequence, LUT, and RAM layout are ported from
// Waveshare's own epaper_driver_bsp.cpp so orientation matches their demos.
//
// Image buffer: 5000 bytes, row-major, 25 bytes per row, MSB = leftmost pixel,
// bit 1 = white, bit 0 = black.
#pragma once
#include <Arduino.h>
#include <SPI.h>

namespace epd {

// Pins from Waveshare user_config.h (identical on V1 and V2 boards).
constexpr int PIN_PWR = 6;    // e-paper 3V3 enable, LOW = on
constexpr int PIN_BUSY = 8;   // HIGH = busy
constexpr int PIN_RST = 9;
constexpr int PIN_DC = 10;
constexpr int PIN_CS = 11;
constexpr int PIN_SCK = 12;
constexpr int PIN_MOSI = 13;

constexpr int WIDTH = 200;
constexpr int HEIGHT = 200;
constexpr size_t BUFFER_BYTES = WIDTH * HEIGHT / 8;
constexpr uint32_t BUSY_TIMEOUT_MS = 10000;

const uint8_t LUT_FULL[159] = {
    0x80, 0x48, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x40, 0x48, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x80, 0x48, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x40, 0x48, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x0A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x08, 0x01, 0x00, 0x08, 0x01, 0x00, 0x02,
    0x0A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x00, 0x00, 0x00,
    0x22, 0x17, 0x41, 0x00, 0x32, 0x20,
};

inline const SPISettings kSpi(10000000, MSBFIRST, SPI_MODE0);

inline bool waitIdle() {
  uint32_t start = millis();
  while (digitalRead(PIN_BUSY) == HIGH) {
    if (millis() - start > BUSY_TIMEOUT_MS) return false;
    delay(5);
  }
  return true;
}

inline void command(uint8_t c) {
  digitalWrite(PIN_DC, LOW);
  digitalWrite(PIN_CS, LOW);
  SPI.beginTransaction(kSpi);
  SPI.transfer(c);
  SPI.endTransaction();
  digitalWrite(PIN_CS, HIGH);
}

inline void data(const uint8_t* p, size_t n) {
  digitalWrite(PIN_DC, HIGH);
  digitalWrite(PIN_CS, LOW);
  SPI.beginTransaction(kSpi);
  SPI.writeBytes(p, n);
  SPI.endTransaction();
  digitalWrite(PIN_CS, HIGH);
}

inline void data(uint8_t d) { data(&d, 1); }

// Power rail and pins. Call once from setup().
inline void begin() {
  pinMode(PIN_PWR, OUTPUT);
  digitalWrite(PIN_PWR, LOW);
  pinMode(PIN_CS, OUTPUT);
  digitalWrite(PIN_CS, HIGH);
  pinMode(PIN_DC, OUTPUT);
  pinMode(PIN_RST, OUTPUT);
  digitalWrite(PIN_RST, HIGH);
  pinMode(PIN_BUSY, INPUT);
  SPI.begin(PIN_SCK, -1, PIN_MOSI, -1);
  delay(10);
}

// Hardware reset + full-refresh init. Needed before every refresh because
// the panel is put into deep sleep afterwards and only a reset wakes it.
inline bool init() {
  digitalWrite(PIN_RST, HIGH);
  delay(50);
  digitalWrite(PIN_RST, LOW);
  delay(20);
  digitalWrite(PIN_RST, HIGH);
  delay(50);

  if (!waitIdle()) return false;
  command(0x12);  // software reset
  if (!waitIdle()) return false;

  command(0x01);  // driver output control
  const uint8_t gate[] = {0xC7, 0x00, 0x01};
  data(gate, sizeof(gate));

  command(0x11);  // data entry mode: X increment, Y decrement
  data(0x01);

  command(0x44);  // RAM X window: bytes 0..24
  const uint8_t x[] = {0x00, (WIDTH - 1) >> 3};
  data(x, sizeof(x));
  command(0x45);  // RAM Y window: 199..0
  const uint8_t y[] = {(HEIGHT - 1) & 0xFF, (HEIGHT - 1) >> 8, 0x00, 0x00};
  data(y, sizeof(y));

  command(0x3C);  // border waveform
  data(0x01);
  command(0x18);  // internal temperature sensor
  data(0x80);
  command(0x22);  // load temperature + waveform
  data(0xB1);
  command(0x20);

  command(0x4E);  // RAM X counter
  data(0x00);
  command(0x4F);  // RAM Y counter
  const uint8_t yc[] = {(HEIGHT - 1) & 0xFF, (HEIGHT - 1) >> 8};
  data(yc, sizeof(yc));
  if (!waitIdle()) return false;

  command(0x32);  // waveform LUT
  data(LUT_FULL, 153);
  if (!waitIdle()) return false;
  command(0x3F);
  data(LUT_FULL[153]);
  command(0x03);  // gate voltage
  data(LUT_FULL[154]);
  command(0x04);  // source voltage
  data(&LUT_FULL[155], 3);
  command(0x2C);  // VCOM
  data(LUT_FULL[158]);
  return true;
}

// Full refresh with the given 5000-byte buffer, then deep sleep.
inline bool show(const uint8_t* image) {
  if (!init()) return false;
  command(0x24);  // write B/W RAM
  data(image, BUFFER_BYTES);
  command(0x22);
  data(0xC7);
  command(0x20);  // master activation
  bool ok = waitIdle();
  command(0x10);  // deep sleep mode 1; RAM retained, needs reset to wake
  data(0x01);
  delay(10);
  return ok;
}

}  // namespace epd

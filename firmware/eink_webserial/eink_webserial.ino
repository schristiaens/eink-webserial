// E-ink uploader firmware for the Waveshare ESP32-S3-ePaper-1.54.
// Receives a 200x200 1-bit image over USB serial and draws it.
//
// Replies (one line each):
//   EPD-WEBSERIAL v1 200x200   handshake answer to '?', also printed at boot
//   BUSY                       frame received, panel refreshing
//   OK <ms>                    refresh done
//   ERR checksum|timeout|panel
#include "epd.h"
#include "frame_parser.h"

static constexpr int PIN_BAT_HOLD = 17;  // keeps the board on when running from battery
static const char* kHello = "EPD-WEBSERIAL v1 200x200";

static frame::Parser parser;

void setup() {
  pinMode(PIN_BAT_HOLD, OUTPUT);
  digitalWrite(PIN_BAT_HOLD, HIGH);

  Serial.setRxBufferSize(8192);  // whole frame fits; must precede begin()
  Serial.begin(115200);
  epd::begin();
  Serial.println(kHello);
}

static void showFrame() {
  Serial.println("BUSY");
  uint32_t start = millis();
  bool ok = epd::show(parser.image());
  if (ok) {
    Serial.printf("OK %lu\n", (unsigned long)(millis() - start));
  } else {
    Serial.println("ERR panel");
  }
}

void loop() {
  while (Serial.available() > 0) {
    switch (parser.feed(static_cast<uint8_t>(Serial.read()), millis())) {
      case frame::Event::Ping:
        Serial.println(kHello);
        break;
      case frame::Event::Complete:
        showFrame();
        break;
      case frame::Event::BadChecksum:
        Serial.println("ERR checksum");
        break;
      default:
        break;
    }
  }
  if (parser.poll(millis()) == frame::Event::Timeout) {
    Serial.println("ERR timeout");
  }
  delay(1);
}

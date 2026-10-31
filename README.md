# E-ink Uploader

Put a picture on the **Waveshare ESP32-S3-ePaper-1.54** (200×200 black/white) from the browser over Web Serial. The page also flashes the firmware, so no Arduino IDE is needed.

Not for the 4-colour **1.54G** board: it uses a different panel and pixel format.

## Use it

```sh
bun serve.ts            # http://127.0.0.1:8000, then open it in desktop Chrome or Edge
```

1. Plug the board in with USB-C.
2. First time only: **Install firmware**, then pick the `USB JTAG/serial debug unit` port. It takes about 20 s, and the page reconnects when it's done.
3. Drop, paste, or choose a picture. Adjust crop, rotation, dithering, brightness, contrast, and invert. The preview shows the exact pixels that will be sent.
4. **Send to screen**. A full refresh takes about 2 s, with the usual e-paper flashing.

If the install can't connect, the running firmware may have taken over the USB port. Put the board in download mode: unplug, hold **BOOT**, plug back in, release.

If pictures land upside down or sideways on your unit, use **Rotate**.

## Layout

| Path | What |
|---|---|
| `web/index.html`, `web/app.js` | Page, Web Serial connection, esptool-js install flow |
| `web/epd-image.js` | Pure image → 5000-byte panel buffer (dither, pack, frame) |
| `web/vendor/esptool-js-0.7.0.js` | Vendored esptool-js bundle (Apache-2.0); no CDN at runtime |
| `web/firmware/` | Built flash images + `manifest.json` (offsets 0x0 / 0x8000 / 0xe000 / 0x10000) |
| `firmware/eink_webserial/` | Arduino sketch: `epd.h` panel driver, `frame_parser.h` protocol |
| `scripts/build-firmware.sh` | Compile and refresh `web/firmware/` |
| `scripts/smoke.py` | Hardware test without the browser |

## Protocol (USB serial)

| Direction | Bytes | Meaning |
|---|---|---|
| host → board | `?` | Handshake. Board answers `EPD-WEBSERIAL v1 200x200` |
| host → board | `EPD1` + 5000 bytes + uint16 LE sum | Image. Row-major, 25 bytes per row, MSB = leftmost pixel, 1 = white |
| board → host | `BUSY` | Frame accepted, panel refreshing |
| board → host | `OK <ms>` / `ERR checksum\|timeout\|panel` | Result |

The panel goes into deep sleep after every refresh. The picture stays on the glass with the power off.

## Rebuild and test

```sh
# once: brew install arduino-cli, add the esp32 board URL, then:
arduino-cli core install esp32:esp32@3.3.12

bash scripts/build-firmware.sh     # compile and refresh web/firmware/
bun test                           # image pipeline
clang++ -std=c++17 -I firmware/eink_webserial firmware/test/parser_test.cpp -o build/parser_test && build/parser_test
uv run scripts/smoke.py            # with the board plugged in: sends a test pattern, expects OK
```

The firmware targets 4 MB flash with PSRAM off, so the same build runs on V1 (ESP32-S3FH4R2) and V2 (ESP32-S3-PICO-1-N8R8) boards. Pins come from Waveshare's example code: EPD power GPIO6 (active low), BUSY 8, RST 9, DC 10, CS 11, SCK 12, MOSI 13, battery hold GPIO17.

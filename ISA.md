---
task: "Web Serial app that flashes a Waveshare ESP32-S3 1.54in e-paper board and uploads a picture to its screen"
slug: 20261031-092600_eink-webserial
project: eink-webserial
phase: climbing
progress: 13/15
started: 2026-10-31T15:26:00Z
updated: 2026-10-31T16:31:00Z
principal_stated_goal: "I want to program an ESP32 over web serial. create me a simple app that can upload a picture to the 1.54 inch eink screen on a waveshare esp32-s3 development device."
---

## Problem

Getting a photo onto the Waveshare ESP32-S3-ePaper-1.54 today means an Arduino IDE setup, LVGL image converters, and a reflash per picture. Steve wants a browser page that does it over Web Serial.

## Vision

Plug the board into USB, open one local page in Chrome. First time: click **Install firmware** and the browser flashes it. Then drop any photo on the page, see exactly what the panel will show (200×200, 1-bit dithered), click **Send**, and the e-paper flips to the picture a few seconds later. Euphoric surprise: the preview on screen is pixel-for-pixel what lands on the glass, and the whole loop needs no IDE.

## Out of Scope

- The 4-colour ESP32-S3-ePaper-1.54**G** variant (different panel driver and pixel format).
- Partial refresh, animation, slideshows, Wi-Fi upload.
- Storing images on the board (e-paper keeps the picture with power off anyway).
- Hosting the page publicly.

## Constraints

- Board: ESP32-S3-ePaper-1.54 (V1 ESP32-S3FH4R2 4MB, or V2 PICO-1-N8R8 8MB). Panel 200×200 B/W, SSD1681 (Waveshare "1.54inch e-Paper V2").
- Pins from Waveshare's own example code (identical V1/V2): EPD power enable GPIO6 (LOW = on), BUSY 8, RST 9, DC 10, CS 11, SCK 12, MOSI 13. Battery hold GPIO17 (HIGH = on). Native USB-Serial/JTAG on GPIO19/20.
- Web Serial needs a secure context: page served from `localhost`, Chrome/Edge only.
- Firmware must run on both V1 and V2: 4MB flash layout, PSRAM unused.
- No runtime CDN: esptool-js 0.7.0 vendored (sha256 `00ebe6fb…1a84e`).

## Goal

A local web page plus Arduino firmware: the page flashes the firmware via esptool-js, converts a user picture to the panel's 5000-byte 1-bit buffer, and sends it over Web Serial; the firmware draws it and replies OK.

## Criteria

- [x] ISC-1: Firmware compiles for ESP32-S3 with arduino-cli + esp32 core 3.3.12, emitting bootloader, partitions, and app `.bin` files into `web/firmware/`. — `build-firmware.sh exit 0; 4 bins + manifest in web/firmware (app 303488 B)`
- [x] ISC-2: Firmware drives exactly the Waveshare pins listed in Constraints, with EPD power active-low on GPIO6. — `rg pin defines epd.h:14-20, .ino:12`
- [x] ISC-3: Firmware frame parser accepts a valid frame (magic + 5000 bytes + checksum), rejects a bad checksum, resyncs after leading garbage, and abandons a stalled partial frame. — `parser_test: all 7 cases passed`
- [x] ISC-4: Firmware sends the panel into deep sleep after every refresh. — `epd.h show() is the only refresh path; 0x10 at :160`
- [x] ISC-5: Page packing turns any image into exactly 5000 bytes, row-major, MSB = leftmost pixel, bit 1 = white (Waveshare driver layout). — `bun test 14/14 (layout + roundtrip)`
- [x] ISC-6: Dithering behaves: pure white → all `0xFF`, pure black → all `0x00`, 50% grey under Floyd–Steinberg → 45–55% black pixels. — `bun test 14/14; sample FS black ratio 0.496 in Chrome`
- [x] ISC-7: Page loads in real Chrome from `localhost` with zero console errors and shows Install, Connect, picture input, preview, and Send. — `WebVerify shot-desktop2.png + shot-mobile.png viewed; CDP probe problems: []`
- [x] ISC-8: Loading a picture renders the 200×200 dithered preview in the page. — `CDP probe packedBytes 5000, empty overlay hidden; preview viewed`
- [x] ISC-9: Install flow writes bootloader@0x0, partitions@0x8000, boot_app0@0xe000, app@0x10000 via esptool-js `writeFlash`, then hard-resets. — `offsets match core platform.txt upload recipe; manifest + bins 200 from server`
- [x] ISC-10: A CLI smoke script sends a test frame over serial and receives `OK` from real hardware. (after: ISC-1) — `smoke.py on V2 board: hello, BUSY, OK 1919 ms`
- [ ] ISC-11: [DEFERRED-VERIFY: needs board + Steve] On real hardware, a picture sent from the page appears on the e-paper. (after: ISC-9, ISC-10)
- [ ] ISC-15: [DEFERRED-VERIFY: needs board + Steve] Install firmware in the page flashes a real board and the page auto-reconnects to the uploader. (after: ISC-9)
- [x] ISC-12: Anti: the page never sends an image frame until the device has identified itself as this firmware. — `app.js:48 + :378 gate on serial.identified; probe sendDisabled true`
- [x] ISC-13: Anti: no network fetch outside `localhost` at runtime (esptool-js vendored, no CDN). — `rg finds no remote URLs; CDP probe offHostRequests: []`
- [x] ISC-14: Antecedent (experiential): the preview is computed from the same packed bytes that get sent, so what you see is what the panel shows. — `app.js render() draws packedToRgba(packed); unit test + Python/JS packing identical`

## Test Strategy

```yaml
- isc: ISC-1
  type: cli-probe
  check: scripts/build-firmware.sh exits 0; ls web/firmware/*.bin shows 4 files
- isc: ISC-2
  type: grep
  check: pin defines in firmware match Constraints
- isc: ISC-3
  type: host-unit-test
  check: clang++ firmware/test/parser_test.cpp runs all cases green
- isc: ISC-4
  type: grep
  check: deep-sleep command 0x10 issued after every refresh path
- isc: ISC-5, ISC-6, ISC-14
  type: unit-test
  check: bun test test/
- isc: ISC-7, ISC-8
  type: browser
  check: WebVerify screenshot of localhost page, console clean, preview canvas non-blank after load
- isc: ISC-9
  type: code-read + browser
  check: offsets in manifest match arduino-cli build; manifest fetch 200 in the page
- isc: ISC-10
  type: hardware
  check: uv run scripts/smoke.py prints OK  (needs board on USB)
- isc: ISC-11
  type: hardware + human
  check: Steve sends a picture; it shows on the panel
- isc: ISC-12
  type: code-read + unit-test
  check: send button disabled until handshake reply matches
- isc: ISC-13
  type: grep
  check: no http(s):// URLs in web/*.js or index.html
```

## Decisions

- 2026-10-31: Board variant assumed B/W ESP32-S3-ePaper-1.54 (not 1.54G). Steve didn't name a colour; B/W is the base model. Redirect if wrong.
- 2026-10-31: Custom 200-line driver ported from Waveshare's own `epaper_driver_bsp.cpp` (same init, LUT, RAM layout) rather than GxEPD2: the orientation then matches Waveshare's known-good demo, and no library install is needed.
- 2026-10-31: Flash the four separate images, not `merged.bin`, so flashing writes ~300 KB rather than a padded full-flash image.
- 2026-10-31: Serial protocol is a fixed frame (`EPD1` + 5000 bytes + 16-bit sum) with a `?` handshake. A fixed frame needs no length negotiation and makes resync trivial.
- 2026-10-31: Floyd–Steinberg switched to serpentine scan after the first screenshot showed a left-edge streak (one-way scan artifact).
- 2026-10-31: Added a "Use a sample picture" button (+ `?sample`): first-run test without hunting for a file, and lets a headless check fill the preview.
- 2026-10-31: Board is V2 (8MB flash, esptool flash-id). Full 8MB factory flash backed up to `backup/` (gitignored, sha256 d07bb665…69d5) before the first CLI flash; restore with `esptool write-flash 0 backup/<file>`.
- 2026-10-31: Second look skipped: hobby build, not security or publish-bound; correctness rests on host tests plus a hardware smoke run.

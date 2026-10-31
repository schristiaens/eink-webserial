#!/usr/bin/env bash
# Compile the firmware and copy the flashable images + manifest into web/firmware/.
# Needs: arduino-cli with esp32:esp32@3.3.12 installed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKETCH="$ROOT/firmware/eink_webserial"
BUILD="$ROOT/build"
OUT="$ROOT/web/firmware"
# 4MB / no PSRAM runs on both V1 (4MB) and V2 (8MB) boards. CDCOnBoot routes Serial to the USB-C port.
FQBN="esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashSize=4M,PartitionScheme=default,PSRAM=disabled"

arduino-cli compile --fqbn "$FQBN" --output-dir "$BUILD" "$SKETCH"

CORE_DIR="$(arduino-cli config get directories.data)/packages/esp32/hardware/esp32"
BOOT_APP0="$(find "$CORE_DIR" -path '*/tools/partitions/boot_app0.bin' | head -1)"

mkdir -p "$OUT"
cp "$BUILD/eink_webserial.ino.bootloader.bin" "$OUT/bootloader.bin"
cp "$BUILD/eink_webserial.ino.partitions.bin" "$OUT/partitions.bin"
cp "$BOOT_APP0" "$OUT/boot_app0.bin"
cp "$BUILD/eink_webserial.ino.bin" "$OUT/app.bin"

cat > "$OUT/manifest.json" <<EOF
{
  "chip": "ESP32-S3",
  "built": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "parts": [
    { "path": "bootloader.bin", "offset": 0 },
    { "path": "partitions.bin", "offset": 32768 },
    { "path": "boot_app0.bin", "offset": 57344 },
    { "path": "app.bin", "offset": 65536 }
  ]
}
EOF

ls -l "$OUT"

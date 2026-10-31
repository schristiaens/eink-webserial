# /// script
# requires-python = ">=3.13"
# dependencies = ["pyserial>=3.5"]
# ///
"""Hardware smoke test: send a test pattern to the board over serial, no browser.

    uv run scripts/smoke.py              # auto-picks the first Espressif USB port
    uv run scripts/smoke.py /dev/cu.usbmodem1101

Pattern: 4px border, an X corner to corner, and a filled top-left square, so
orientation is obvious on the glass (the square marks the top-left corner).
"""

import sys
import time

import serial
from serial.tools import list_ports

W = H = 200
HELLO = b"EPD-WEBSERIAL v1"


def pick_port() -> str:
    for p in list_ports.comports():
        if p.vid == 0x303A:
            return p.device
    sys.exit("No Espressif USB device found. Plug the board in or pass the port.")


def pattern() -> bytes:
    buf = bytearray([0xFF] * (W * H // 8))  # all white
    for y in range(H):
        for x in range(W):
            border = x < 4 or y < 4 or x >= W - 4 or y >= H - 4
            cross = abs(x - y) <= 1 or abs(x + y - (W - 1)) <= 1
            corner = 12 <= x < 52 and 12 <= y < 52
            if border or cross or corner:
                i = y * W + x
                buf[i >> 3] &= ~(0x80 >> (i & 7))
    return bytes(buf)


def read_line(port: serial.Serial, timeout: float) -> bytes:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        line = port.readline().strip()
        if line:
            print(f"  <- {line.decode(errors='replace')}")
            return line
    return b""


def main() -> None:
    dev = sys.argv[1] if len(sys.argv) > 1 else pick_port()
    print(f"port {dev}")
    with serial.Serial(dev, 115200, timeout=0.3) as port:
        for _ in range(15):
            port.write(b"?")
            if read_line(port, 0.5).startswith(HELLO):
                break
        else:
            sys.exit("FAIL: board never identified as the uploader firmware.")

        image = pattern()
        frame = b"EPD1" + image + (sum(image) & 0xFFFF).to_bytes(2, "little")
        print(f"  -> frame {len(frame)} bytes")
        port.write(frame)
        while True:
            line = read_line(port, 20)
            if not line:
                sys.exit("FAIL: no reply within 20 s.")
            if line.startswith(b"OK"):
                print("PASS: pattern is on the screen. The filled square should sit top-left.")
                return
            if line.startswith(b"ERR"):
                sys.exit(f"FAIL: {line.decode()}")


if __name__ == "__main__":
    main()

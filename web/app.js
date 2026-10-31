import { ESPLoader, Transport } from "./vendor/esptool-js-0.7.0.js";
import * as epd from "./epd-image.js";

const ESPRESSIF_VID = 0x303a;
const PORT_FILTERS = [{ usbVendorId: ESPRESSIF_VID }];
const $ = (id) => document.getElementById(id);

const serial = {
  port: null,
  reader: null,
  writer: null,
  readDone: null,
  identified: false, // device answered the handshake with HELLO_PREFIX
  lineBuf: "",
  waiters: new Set(),
};
let busy = false; // flashing or sending
let source = null; // ImageBitmap
let rotation = 0;
let packed = null; // 5000 bytes currently in the preview

// ---------- log + status ----------

function log(msg) {
  const el = $("log");
  const t = new Date().toLocaleTimeString([], { hour12: false });
  el.textContent += `${t}  ${msg}\n`;
  const lines = el.textContent.split("\n");
  if (lines.length > 400) el.textContent = lines.slice(-400).join("\n");
  el.scrollTop = el.scrollHeight;
}

function setStatus(text, tone = "") {
  $("status").textContent = text;
  $("status").dataset.tone = tone;
}

function setSendStatus(text, tone = "") {
  $("send-status").textContent = text;
  $("send-status").dataset.tone = tone;
}

function updateUi() {
  const supported = "serial" in navigator;
  $("connect").textContent = serial.port ? "Disconnect" : "Connect";
  $("connect").disabled = !supported || busy;
  $("install").disabled = !supported || busy;
  $("send").disabled = !(serial.identified && packed) || busy;
  if (!serial.port) setStatus("Not connected");
  else if (serial.identified) setStatus("Connected · uploader ready", "ok");
  else setStatus("Connected · no uploader firmware", "warn");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, what) {
  return Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(`${what} timed out`)))]);
}

// ---------- serial connection ----------

function waitForLine(match, timeoutMs) {
  return new Promise((resolve, reject) => {
    const w = {
      match,
      resolve: (line) => {
        clearTimeout(w.timer);
        serial.waiters.delete(w);
        resolve(line);
      },
    };
    w.timer = setTimeout(() => {
      serial.waiters.delete(w);
      reject(new Error("no reply"));
    }, timeoutMs);
    serial.waiters.add(w);
  });
}

function onLine(line) {
  log(`← ${line}`);
  if (line.startsWith(epd.HELLO_PREFIX) && !serial.identified) {
    serial.identified = true;
    updateUi();
  }
  if (line === "BUSY") setSendStatus("Refreshing the panel…");
  for (const w of [...serial.waiters]) if (w.match(line)) w.resolve(line);
}

async function readLoop(port) {
  const decoder = new TextDecoder();
  while (port.readable && serial.port === port) {
    const reader = port.readable.getReader();
    serial.reader = reader;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        serial.lineBuf += decoder.decode(value, { stream: true });
        if (serial.lineBuf.length > 4096) serial.lineBuf = serial.lineBuf.slice(-1024);
        let nl;
        while ((nl = serial.lineBuf.indexOf("\n")) >= 0) {
          const line = serial.lineBuf.slice(0, nl).replace(/\r$/, "");
          serial.lineBuf = serial.lineBuf.slice(nl + 1);
          if (line) onLine(line);
        }
      }
    } catch (err) {
      if (serial.port === port) log(`read error: ${err.message}`);
    } finally {
      reader.releaseLock();
    }
  }
}

async function openPort(port) {
  await withTimeout(port.open({ baudRate: 115200, bufferSize: 8192 }), 3000, "opening the port");
  serial.port = port;
  serial.identified = false;
  serial.lineBuf = "";
  serial.writer = port.writable.getWriter();
  serial.readDone = readLoop(port);
  updateUi();
  log("port open, looking for the uploader firmware…");

  // The board may reset when the port opens, so ping until it answers.
  for (let i = 0; i < 12 && !serial.identified && serial.port === port; i++) {
    await serial.writer.write(new Uint8Array([0x3f])); // '?'
    try {
      await waitForLine((l) => l.startsWith(epd.HELLO_PREFIX), 400);
    } catch {
      /* try again */
    }
  }
  updateUi();
  if (serial.identified) {
    $("board-hint").innerHTML = "Board ready. Pick a picture and press <b>Send to screen</b>.";
  } else {
    $("board-hint").innerHTML =
      "Connected, but the board isn't running the uploader. Press <b>Install firmware</b>.";
  }
}

async function closePort() {
  const port = serial.port;
  if (!port) return;
  serial.port = null;
  serial.identified = false;
  for (const w of serial.waiters) clearTimeout(w.timer);
  serial.waiters.clear();
  try {
    await serial.reader?.cancel();
  } catch {}
  try {
    serial.writer?.releaseLock();
  } catch {}
  await serial.readDone?.catch(() => {});
  try {
    await port.close();
  } catch {}
  serial.reader = serial.writer = serial.readDone = null;
  log("port closed");
  updateUi();
}

async function onConnectClick() {
  if (serial.port) return closePort();
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: PORT_FILTERS });
  } catch {
    return; // chooser cancelled
  }
  try {
    await openPort(port);
  } catch (err) {
    log(`connect failed: ${err.message}`);
    setStatus("Couldn't open the port", "err");
    await closePort();
  }
}

// ---------- firmware install (esptool-js) ----------

const espTerminal = {
  clean() {},
  writeLine: (data) => log(data),
  write: (data) => log(data),
};

async function loadFirmware() {
  const res = await fetch("firmware/manifest.json");
  if (!res.ok) throw new Error(`firmware/manifest.json: HTTP ${res.status}`);
  const manifest = await res.json();
  return Promise.all(
    manifest.parts.map(async (p) => {
      const r = await fetch(`firmware/${p.path}`);
      if (!r.ok) throw new Error(`firmware/${p.path}: HTTP ${r.status}`);
      return { address: p.offset, data: new Uint8Array(await r.arrayBuffer()), name: p.path };
    }),
  );
}

async function onInstallClick() {
  await closePort();
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: PORT_FILTERS });
  } catch {
    return;
  }
  busy = true;
  updateUi();
  const bar = $("flash-progress");
  bar.hidden = false;
  bar.value = 0;
  setStatus("Installing firmware…", "warn");
  const transport = new Transport(port, false);
  let installed = false;
  try {
    const files = await loadFirmware();
    const sizes = files.map((f) => f.data.length);
    const total = sizes.reduce((a, b) => a + b, 0);
    // Same baud both ways: no port reopen, which can knock native-USB boards out of the bootloader.
    const loader = new ESPLoader({ transport, baudrate: 115200, romBaudrate: 115200, terminal: espTerminal });
    await loader.main();
    if (loader.chip.CHIP_NAME !== "ESP32-S3") {
      throw new Error(`this board is an ${loader.chip.CHIP_NAME}, not an ESP32-S3`);
    }
    await loader.writeFlash({
      fileArray: files.map(({ address, data }) => ({ address, data })),
      flashSize: "keep",
      flashMode: "keep",
      flashFreq: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (i, written, fileTotal) => {
        const before = sizes.slice(0, i).reduce((a, b) => a + b, 0);
        bar.value = (before + (written / fileTotal) * sizes[i]) / total;
      },
    });
    await loader.after("hard_reset");
    installed = true;
    log("firmware installed, board restarting");
  } catch (err) {
    log(`install failed: ${err.message}`);
    setStatus("Install failed", "err");
    $("board-hint").innerHTML =
      "Install failed. Put the board in download mode and retry: unplug USB, hold <b>BOOT</b>, plug back in, release.";
  } finally {
    try {
      await transport.disconnect();
    } catch {}
    busy = false;
    bar.hidden = true;
    updateUi();
  }

  if (installed) await reconnectAfterInstall(port);
}

// After the reset the board may come back as the same port or re-enumerate as a new one.
async function reconnectAfterInstall(oldPort) {
  setStatus("Waiting for the board to restart…", "warn");
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(1000);
    const ports = (await navigator.serial.getPorts()).filter(
      (p) => p.getInfo().usbVendorId === ESPRESSIF_VID,
    );
    for (const p of [oldPort, ...ports.filter((p) => p !== oldPort)]) {
      try {
        await openPort(p);
        if (serial.identified) return;
        await closePort();
      } catch {
        await closePort();
      }
    }
  }
  setStatus("Firmware installed · press Connect", "ok");
  $("board-hint").innerHTML = "Firmware installed. Press <b>Connect</b> to start sending pictures.";
}

// ---------- picture ----------

// blob: a File/Blob, or anything createImageBitmap accepts (canvas, ImageBitmap).
async function loadPicture(blob, name) {
  try {
    source = await createImageBitmap(blob);
  } catch {
    setSendStatus(`Couldn't read ${name || "that file"} as an image.`, "err");
    return;
  }
  $("filename").textContent = name || "pasted image";
  setSendStatus("");
  render();
}

// A drawn landscape with smooth gradients, so dithering is easy to judge.
function loadSample() {
  const c = new OffscreenCanvas(400, 400);
  const g = c.getContext("2d");
  const sky = g.createLinearGradient(0, 0, 0, 280);
  sky.addColorStop(0, "#8c8c8c");
  sky.addColorStop(1, "#f4f4f4");
  g.fillStyle = sky;
  g.fillRect(0, 0, 400, 400);
  const glow = g.createRadialGradient(270, 150, 30, 270, 150, 110);
  glow.addColorStop(0, "#ffffff");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, 400, 400);
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.arc(270, 150, 38, 0, Math.PI * 2);
  g.fill();
  const ridge = (color, points) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, 400);
    for (const [x, y] of points) g.lineTo(x, y);
    g.lineTo(400, 400);
    g.fill();
  };
  ridge("#6e6e6e", [[0, 250], [70, 190], [130, 235], [210, 170], [300, 240], [360, 205], [400, 225]]);
  ridge("#1c1c1c", [[0, 300], [90, 255], [160, 290], [250, 245], [330, 285], [400, 265]]);
  g.fillStyle = "#ffffff";
  g.font = "600 34px -apple-system, system-ui, sans-serif";
  g.textAlign = "center";
  g.fillText("hello, e-ink", 200, 355);
  loadPicture(c, "sample picture");
}

function settings() {
  return {
    fit: document.querySelector('input[name="fit"]:checked').value,
    method: $("dither").value,
    brightness: Number($("brightness").value),
    contrast: Number($("contrast").value),
    invert: $("invert").checked,
  };
}

function render() {
  const s = settings();
  $("brightness-out").value = s.brightness;
  $("contrast-out").value = s.contrast;
  $("rotation").textContent = `${rotation}°`;
  if (!source) return;

  const work = new OffscreenCanvas(epd.WIDTH, epd.HEIGHT);
  const ctx = work.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, epd.WIDTH, epd.HEIGHT);
  ctx.imageSmoothingQuality = "high";
  const sideways = rotation % 180 !== 0;
  const w = sideways ? source.height : source.width;
  const h = sideways ? source.width : source.height;
  const pick = s.fit === "cover" ? Math.max : Math.min;
  const scale = pick(epd.WIDTH / w, epd.HEIGHT / h);
  ctx.translate(epd.WIDTH / 2, epd.HEIGHT / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(source, (-source.width * scale) / 2, (-source.height * scale) / 2, source.width * scale, source.height * scale);

  const rgba = ctx.getImageData(0, 0, epd.WIDTH, epd.HEIGHT).data;
  let bits = epd.dither(epd.toGray(rgba, s), s.method);
  if (s.invert) bits = epd.invert(bits);
  packed = epd.pack(bits);

  // Preview is drawn back from the packed bytes, so it is exactly what gets sent.
  const preview = $("preview").getContext("2d");
  preview.putImageData(new ImageData(epd.packedToRgba(packed), epd.WIDTH, epd.HEIGHT), 0, 0);
  $("empty").hidden = true;
  updateUi();
}

async function onSendClick() {
  if (!serial.identified || !packed || busy) return;
  busy = true;
  updateUi();
  setSendStatus("Sending…");
  const frame = epd.buildFrame(packed);
  try {
    const reply = waitForLine((l) => l.startsWith("OK") || l.startsWith("ERR"), 20000);
    log(`→ frame (${frame.length} bytes)`);
    await serial.writer.write(frame);
    const line = await reply;
    if (line.startsWith("OK")) {
      const ms = Number(line.split(" ")[1]);
      setSendStatus(`On the screen (refresh took ${(ms / 1000).toFixed(1)} s).`, "ok");
    } else {
      setSendStatus(`The board reported an error: ${line.slice(4)}. Try again.`, "err");
    }
  } catch (err) {
    setSendStatus(`No answer from the board (${err.message}). Reconnect and try again.`, "err");
  } finally {
    busy = false;
    updateUi();
  }
}

// ---------- wiring ----------

function init() {
  if (!("serial" in navigator)) $("unsupported").classList.add("show");

  $("connect").addEventListener("click", onConnectClick);
  $("install").addEventListener("click", onInstallClick);
  $("send").addEventListener("click", onSendClick);

  $("file").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) loadPicture(f, f.name);
  });
  const drop = $("drop");
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
    if (f) loadPicture(f, f.name);
  });
  window.addEventListener("paste", (e) => {
    const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
    if (item) loadPicture(item.getAsFile(), "pasted image");
  });

  for (const id of ["dither", "brightness", "contrast", "invert", "fit-cover", "fit-contain"]) {
    $(id).addEventListener("input", render);
  }
  $("sample").addEventListener("click", loadSample);
  $("rotate").addEventListener("click", () => {
    rotation = (rotation + 90) % 360;
    render();
  });
  $("reset-adjust").addEventListener("click", () => {
    $("brightness").value = 0;
    $("contrast").value = 0;
    $("invert").checked = false;
    render();
  });

  navigator.serial?.addEventListener("disconnect", (e) => {
    if (e.target === serial.port) {
      log("board unplugged");
      closePort();
    }
  });

  window.addEventListener("error", (e) => log(`error: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => log(`error: ${e.reason?.message ?? e.reason}`));

  updateUi();
  if (new URLSearchParams(location.search).has("sample")) loadSample();
}

init();

// Exposed for console debugging and automated checks.
window.einkUploader = { loadPicture, getPacked: () => packed, settings };

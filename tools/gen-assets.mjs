// Generator aset ekstensi: ikon PNG + suara WAV.
// Jalankan: node tools/gen-assets.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICON_DIR = join(ROOT, "assets", "icons");
const SOUND_DIR = join(ROOT, "assets", "sounds");

/* ---------------------------------------------------------------- PNG ---- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------- shape ---- */
// Koordinat normalisasi: -0.5 .. 0.5, y ke bawah.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

function inRoundedRect(x, y, half, r) {
  const ax = Math.abs(x) - (half - r);
  const ay = Math.abs(y) - (half - r);
  if (ax <= 0 || ay <= 0) return Math.abs(x) <= half && Math.abs(y) <= half;
  return ax * ax + ay * ay <= r * r;
}

function inBell(x, y) {
  const ax = Math.abs(x);
  if (inCircle(x, y, 0, -0.345, 0.05)) return true; // knob atas
  if (y >= 0.175 && y <= 0.245) {
    // rim melebar dengan ujung membulat
    if (ax <= 0.32) return true;
    return inCircle(x, y, ax > 0 ? 0.32 : -0.32, 0.21, 0.035);
  }
  if (inCircle(x, y, 0, 0.315, 0.08)) return true; // clapper
  if (y > -0.3 && y < 0.18) {
    const t = (y + 0.3) / 0.48;
    const half = 0.09 + 0.215 * Math.pow(t, 1.7);
    if (ax <= half) return true;
  }
  return inCircle(x, y, 0, -0.205, 0.095); // pundak/dome
}

function renderIcon(size) {
  const SS = 4; // supersampling
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [0xee, 0x4d, 0x2d];
  const fg = [0xff, 0xff, 0xff];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let cov = 0;
      let bell = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size - 0.5;
          const y = (py + (sy + 0.5) / SS) / size - 0.5;
          if (inRoundedRect(x, y, 0.5, 0.14)) cov++;
          if (inBell(x, y)) bell++;
        }
      }
      const n = SS * SS;
      const a = clamp01(cov / n);
      const b = clamp01(bell / n);
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(bg[c] * (1 - b) + fg[c] * b);
      rgba[i + 3] = Math.round(255 * a);
    }
  }
  return encodePng(size, size, rgba);
}

/* --------------------------------------------------------------- audio ---- */

const RATE = 44100;

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32000), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8, "latin1");
  head.write("fmt ", 12, "latin1");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "latin1");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** Satu ketukan nada: partial harmonik + envelope eksponensial. */
function tone(buf, startSec, durSec, freq, gain, decay, partials = [1, 0.45, 0.2]) {
  const start = Math.round(startSec * RATE);
  const len = Math.round(durSec * RATE);
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / RATE;
    const env = Math.exp(-t * decay) * Math.min(1, t / 0.004);
    let v = 0;
    for (let p = 0; p < partials.length; p++) v += partials[p] * Math.sin(2 * Math.PI * freq * (p + 1) * t);
    buf[idx] += v * gain * env;
  }
}

function normalize(buf, peak = 0.9) {
  let max = 0;
  for (const v of buf) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < buf.length; i++) buf[i] = (buf[i] / max) * peak;
  return buf;
}

/** Notifikasi umum: "ding-dong" turun, tegas dan pendek. */
function soundNotif() {
  const buf = new Float64Array(Math.round(1.0 * RATE));
  tone(buf, 0.0, 0.55, 987.77, 0.6, 7); // B5
  tone(buf, 0.14, 0.75, 659.26, 0.6, 5.5); // E5
  return normalize(buf);
}

/** Chat: tiga pop cepat bernada tinggi supaya jelas beda dari notifikasi. */
function soundChat() {
  const buf = new Float64Array(Math.round(0.8 * RATE));
  const seq = [1174.66, 1567.98, 2093.0]; // D6 G6 C7
  seq.forEach((f, i) => tone(buf, i * 0.075, 0.3, f, 0.55, 16, [1, 0.25]));
  return normalize(buf);
}

/* ----------------------------------------------------------------- run ---- */

mkdirSync(ICON_DIR, { recursive: true });
mkdirSync(SOUND_DIR, { recursive: true });

const written = [];
for (const size of [16, 32, 48, 128]) {
  const file = join(ICON_DIR, `icon${size}.png`);
  writeFileSync(file, renderIcon(size));
  written.push(file);
}
writeFileSync(join(SOUND_DIR, "notif.wav"), wav(soundNotif()));
writeFileSync(join(SOUND_DIR, "chat.wav"), wav(soundChat()));
written.push(join(SOUND_DIR, "notif.wav"), join(SOUND_DIR, "chat.wav"));

for (const f of written) console.log("ok", f.replace(ROOT + "\\", "").replace(ROOT + "/", ""));

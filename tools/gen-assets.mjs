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

/* ------------------------------------------------------------- SDF shapes ---- */
// Koordinat normalisasi: -0.5 .. 0.5, y ke bawah.
// Menggunakan Signed Distance Fields (SDF) untuk rendering antialiasing subpixel
// dengan efek tumpang-tindih (cutouts) yang tajam dan profesional pada semua ukuran.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a * (1 - t) + b * t;

function sdCircle(x, y, cx, cy, r) {
  return Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) - r;
}

function sdRoundedRect(x, y, cx, cy, w, h, r) {
  const dx = Math.abs(x - cx) - (w / 2 - r);
  const dy = Math.abs(y - cy) - (h / 2 - r);
  if (dx > 0 && dy > 0) return Math.sqrt(dx * dx + dy * dy) - r;
  return Math.max(dx, dy) - r;
}

function sdSegment(x, y, x0, y0, x1, y1, r) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  let t = ((x - x0) * dx + (y - y0) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.sqrt((x - (x0 + t * dx)) ** 2 + (y - (y0 + t * dy)) ** 2) - r;
}

/**
 * Tas belanja: bentuk generik "pesanan masuk", digambar sendiri dan sengaja
 * TIDAK meniru logo Shopee. Badan memakai sudut membulat besar dengan pegangan
 * lengkung terbuka supaya siluetnya tetap jelas di 16px.
 */
function sdBag(x, y) {
  const cx = -0.07;
  // Badan tas sedikit meruncing ke bawah supaya terbaca sebagai paper bag,
  // bukan kotak. Sisi kiri/kanan dimiringkan lewat offset bergantung y.
  const yTop = -0.1;
  const yBottom = 0.4;
  const t = clamp01((y - yTop) / (yBottom - yTop));
  const halfWidth = 0.26 - 0.025 * t;
  const body = sdRoundedRect(x, y, cx, (yTop + yBottom) / 2, halfWidth * 2, yBottom - yTop, 0.075);

  // Pegangan: cincin terbuka di atas badan, dipotong pada garis bahu tas.
  const ring = Math.abs(sdCircle(x, y, cx, -0.12, 0.135)) - 0.036;
  const handle = Math.max(ring, y - -0.09);

  return Math.min(body, handle);
}

/** Badge lingkaran di kanan atas yang memuat bel notifikasi. */
const BADGE = { cx: 0.245, cy: -0.025, r: 0.165 };

function sdBadge(x, y) {
  return sdCircle(x, y, BADGE.cx, BADGE.cy, BADGE.r);
}

/**
 * Bel notifikasi di dalam badge. Dipahat sebagai bentuk negatif sehingga
 * ikon hanya perlu dua warna dan tetap terbaca pada 16px.
 */
function sdBell(x, y) {
  const cx = BADGE.cx;
  const cy = BADGE.cy + 0.005;
  const ax = Math.abs(x - cx);

  const knob = sdCircle(x, y, cx, cy - 0.086, 0.017);
  const clapper = sdCircle(x, y, cx, cy + 0.079, 0.022);

  const yMin = cy - 0.078;
  const yMax = cy + 0.042;
  let body = 1e5;
  if (y >= yMin && y <= yMax) {
    const t = (y - yMin) / (yMax - yMin);
    body = ax - (0.026 + 0.05 * Math.pow(t, 2.2));
  }
  const rim = sdSegment(x, y, cx - 0.076, yMax, cx + 0.076, yMax, 0.016);

  return Math.min(knob, clapper, body, rim);
}

/** Garis getar: tiga sapuan memancar dari badge ke pojok kanan atas. */
function sdRing(x, y, i) {
  const angle = -1.36 + i * 0.44;
  const inner = BADGE.r + 0.055;
  const len = 0.085;
  const x0 = BADGE.cx + Math.cos(angle) * inner;
  const y0 = BADGE.cy + Math.sin(angle) * inner;
  return sdSegment(x, y, x0, y0, x0 + Math.cos(angle) * len, y0 + Math.sin(angle) * len, 0.023);
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  
  // Gradien latar oranye hangat. Warna tidak dapat dimerekkan, tetapi bentuk
  // di atasnya sengaja generik: tidak meniru logo atau wordmark pihak mana pun.
  const bgStart = [255, 90, 43]; // oranye terang
  const bgEnd = [217, 34, 10];   // oranye-merah pekat
  
  const fg = [255, 255, 255];    // elemen putih bersih
  
  // Lebar transisi antialiasing subpixel yang tajam (1.5 piksel)
  const edge = 1.5 / size;
  
  for (let py = 0; py < size; py++) {
    const y = py / size - 0.5;
    for (let px = 0; px < size; px++) {
      const x = px / size - 0.5;
      
      // Latar belakang dengan rounded corners eksterior
      const dBg = sdRoundedRect(x, y, 0, 0, 1.0, 1.0, 0.28);
      const alphaBg = clamp01(0.5 - dBg / edge);
      if (alphaBg <= 0) {
        rgba.set([0, 0, 0, 0], (py * size + px) * 4);
        continue;
      }
      
      // Interpolasi linier gradien diagonal latar belakang
      const tBg = clamp01((x + y + 1.0) / 2.0);
      const currentBg = bgStart.map((start, c) => Math.round(mix(start, bgEnd[c], tBg)));
      
      const dBadge = sdBadge(x, y);
      // Cincin putih memisahkan badge dari tas, seperti stiker yang ditempel.
      const dBadgeOutline = Math.abs(dBadge) - 0.026;
      // Tas dipotong tepat di tepi luar cincin badge.
      const dBag = Math.max(sdBag(x, y), -(dBadge + 0.026));
      const dBell = sdBell(x, y);

      let dRings = 1e5;
      for (let i = 0; i < 3; i++) dRings = Math.min(dRings, sdRing(x, y, i));

      const alphaBag = clamp01(0.5 - dBag / edge);
      const alphaOutline = clamp01(0.5 - dBadgeOutline / edge);
      const alphaBell = clamp01(0.5 - dBell / edge);
      const alphaRings = clamp01(0.5 - dRings / edge);
      // Semua elemen adalah bidang putih di atas latar oranye: tas, cincin
      // badge, bel di dalam badge, dan garis getar. Interior badge tetap
      // oranye karena cincin hanya menutup tepinya.
      const alphaWhite = Math.max(alphaBag, alphaOutline, alphaBell, alphaRings);

      const pixelColor = [...currentBg];
      for (let c = 0; c < 3; c++) {
        pixelColor[c] = mix(pixelColor[c], fg[c], alphaWhite);
      }
      
      const idx = (py * size + px) * 4;
      rgba[idx] = pixelColor[0];
      rgba[idx + 1] = pixelColor[1];
      rgba[idx + 2] = pixelColor[2];
      rgba[idx + 3] = Math.round(255 * alphaBg);
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

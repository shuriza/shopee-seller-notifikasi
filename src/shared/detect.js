/**
 * Inti keputusan "apakah ini notifikasi baru?" — murni, tanpa API browser,
 * supaya bisa diuji langsung di Node.
 *
 * Masalah nyata: satu tab bisa melaporkan angka unread dari tiga sumber dengan
 * keandalan berbeda (hook API/WebSocket > badge DOM > document.title). Mencampur
 * sumber tanpa aturan menghasilkan notifikasi palsu (skala angka beda) atau
 * notifikasi hilang (sumber bagus mati, sumber lemah diabaikan terus).
 */

import { KIND } from "./common.js";

/** Prioritas sumber; makin besar makin dipercaya. */
export const SOURCE_RANK = Object.freeze({ api: 3, dom: 2, title: 1 });

/** Sumber berperingkat lebih rendah diabaikan selama sumber tinggi masih segar. */
export const SOURCE_FRESH_MS = 60_000;

/** @typedef {"notif" | "chat"} Kind */
/** @typedef {"api" | "dom" | "title"} Source */

/**
 * @typedef {object} Reading
 * @property {Kind} kind
 * @property {number} count       jumlah belum dibaca; badge titik tanpa angka = 1
 * @property {Source} source
 * @property {string} [detail]    potongan teks untuk badan notifikasi
 */

/**
 * @typedef {object} KindState
 * @property {number} count
 * @property {Source} source
 * @property {number} at           waktu pembacaan terakhir yang diterima
 * @property {number} notifiedAt   waktu event terakhir yang benar-benar dikirim
 * @property {Record<string, boolean>} proven  sumber yang pernah melaporkan > 0
 */

/** @returns {{kinds: Record<string, KindState>}} */
export function createState() {
  return { kinds: Object.create(null) };
}

/**
 * @typedef {object} EvalOptions
 * @property {boolean} onlyOnIncrease
 * @property {number} cooldownSeconds
 * @property {boolean} notifyOrders
 * @property {boolean} notifyChats
 * @property {boolean} [suppress]  akui perubahan tanpa mengirim apa pun
 */

/**
 * Terapkan satu pembacaan ke state.
 *
 * @param {{kinds: Record<string, KindState>}} state  dimutasi di tempat
 * @param {Reading} reading
 * @param {EvalOptions} opts
 * @param {number} now  epoch ms
 * @returns {{event: null | {kind: Kind, prev: number, count: number, source: Source, detail?: string}, reason: string}}
 */
export function applyReading(state, reading, opts, now) {
  const { kind, source } = reading;
  const count = normalizeCount(reading.count);
  if (count === null) return { event: null, reason: "invalid-count" };
  if (!SOURCE_RANK[source]) return { event: null, reason: "unknown-source" };
  if (kind !== KIND.NOTIF && kind !== KIND.CHAT) return { event: null, reason: "unknown-kind" };

  const prev = state.kinds[kind];

  // Pembacaan pertama hanya menjadi garis dasar — jangan berisik saat halaman
  // dibuka. Probe melaporkan 0 secara eksplisit, jadi baseline biasanya 0 dan
  // badge pertama yang muncul tetap memicu notifikasi.
  if (!prev) {
    state.kinds[kind] = {
      count,
      source,
      at: now,
      notifiedAt: 0,
      proven: count > 0 ? { [source]: true } : {},
    };
    return { event: null, reason: "baseline" };
  }

  const proven = prev.proven || {};
  if (count > 0) proven[source] = true;

  // Nol dari sumber yang belum pernah membuktikan diri tidak boleh menghapus
  // hitungan sumber lain. Contoh nyata: Shopee mengubah nama kelas badge,
  // probe DOM jadi selalu "0", sementara hook API tetap benar — tanpa aturan
  // ini nol palsu tersebut akan mereset state dan menelan notifikasi.
  if (count === 0 && !proven[source]) {
    const otherProven = Object.keys(proven).some((s) => s !== source && proven[s]);
    if (otherProven) {
      prev.proven = proven;
      return { event: null, reason: "unproven-zero" };
    }
  }

  // Sumber lemah tidak boleh menimpa sumber kuat yang masih segar: badge DOM di
  // tab background sering tertinggal, sedangkan hook API sudah tahu angka asli.
  const downgrade = SOURCE_RANK[source] < SOURCE_RANK[prev.source];
  if (downgrade && now - prev.at < SOURCE_FRESH_MS) {
    prev.proven = proven;
    return { event: null, reason: "stale-source" };
  }

  const kindEnabled = kind === KIND.CHAT ? opts.notifyChats : opts.notifyOrders;
  const increased = count > prev.count;
  const changed = count !== prev.count;
  const wants = kindEnabled && count > 0 && (opts.onlyOnIncrease ? increased : changed);

  // notifiedAt === 0 berarti "belum pernah dikirim"; tanpa penjagaan ini,
  // notifikasi pertama beberapa detik setelah halaman dibuka ikut tertelan
  // cooldown karena now - 0 selalu kecil relatif epoch.
  const cooling = wants && prev.notifiedAt > 0 && now - prev.notifiedAt < opts.cooldownSeconds * 1000;
  // Tab sedang ditatap seller: perubahan diakui (baseline maju) tetapi TIDAK
  // boleh menyentuh notifiedAt. Kalau tersentuh, cooldown ikut jalan untuk
  // notifikasi yang tak pernah dikirim, dan pesanan berikutnya jadi senyap.
  const fire = wants && !cooling && !opts.suppress;

  state.kinds[kind] = {
    count,
    source,
    at: now,
    notifiedAt: fire ? now : prev.notifiedAt,
    proven,
  };

  if (!kindEnabled) return { event: null, reason: "kind-disabled" };
  if (!wants) return { event: null, reason: increased ? "filtered" : count < prev.count ? "decreased" : "unchanged" };
  if (cooling) return { event: null, reason: "cooldown" };
  if (opts.suppress) return { event: null, reason: "suppressed" };

  return {
    event: { kind, prev: prev.count, count, source, detail: reading.detail },
    reason: "fire",
  };
}

/**
 * Buang pembacaan yang tidak masuk akal (NaN, negatif, angka tak wajar besar).
 * @param {unknown} v
 * @returns {number | null}
 */
export function normalizeCount(v) {
  const n = typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100_000) return null;
  return Math.floor(n);
}

/**
 * Total belum dibaca untuk badge ikon ekstensi.
 * @param {Iterable<{kinds: Record<string, KindState>}>} states
 */
export function totalUnread(states) {
  let total = 0;
  for (const s of states) for (const k of Object.keys(s.kinds)) total += s.kinds[k].count;
  return total;
}

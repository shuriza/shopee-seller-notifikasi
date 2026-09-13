/**
 * Konstanta & util yang dipakai bersama service worker, content script, popup.
 * Modul ini harus bebas dari API yang tidak tersedia di semua konteks.
 */

export const KIND = /** @type {const} */ ({ NOTIF: "notif", CHAT: "chat" });

export const MSG = /** @type {const} */ ({
  // content -> background
  REPORT: "report", // laporan hasil probe dari satu tab
  HELLO: "hello", // content script siap, minta settings
  TEST: "test", // tombol "Kirim Notifikasi Tes"
  SET_ENABLED: "set-enabled", // toggle dari panel in-page
  // background -> content
  SETTINGS: "settings", // broadcast settings terbaru
  PROBE_NOW: "probe-now", // paksa probe (dipakai scheduler alarm)
  // popup <-> background
  GET_STATE: "get-state",
  SET_SETTINGS: "set-settings",
  RESET_BASELINE: "reset-baseline",
  GET_HISTORY: "get-history",
  CLEAR_HISTORY: "clear-history",
  OPEN_HISTORY: "open-history",
  OPEN_TAB: "open-tab",
  // offscreen
  PLAY: "play",
});

export const DEFAULTS = Object.freeze({
  /** Label manual profil ini, bukan identitas akun/login Shopee. */
  profileLabel: "",
  enabled: true,
  notifyOrders: true,
  notifyChats: true,
  soundEnabled: true,
  volume: 0.8,
  /** Hanya push saat tab Seller Center tidak terlihat / window tidak fokus. */
  onlyWhenHidden: true,
  /** Detik antar polling paksa dari service worker (alarm minimum 30s di MV3). */
  pollSeconds: 30,
  /** Jangan bunyi/notif lagi untuk kind yang sama dalam N detik. */
  cooldownSeconds: 5,
  /** Notifikasi Chrome tetap tampil sampai diklik. */
  requireInteraction: true,
  /** Tampilkan panel kontrol kecil di halaman Seller Center. */
  showPanel: true,
  /** Notifikasi hanya muncul jika jumlah unread naik (bukan sekadar berubah). */
  onlyOnIncrease: true,
});

/** Kunci storage. */
export const STORE = /** @type {const} */ ({
  SETTINGS: "settings",
  STATS: "stats",
  HISTORY: "history",
});

/**
 * Merge settings tersimpan dengan default (menoleransi field baru saat upgrade).
 * @param {Record<string, unknown> | undefined | null} raw
 */
export function withDefaults(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(DEFAULTS)) {
    const v = /** @type {any} */ (raw)[key];
    if (v === undefined || v === null) continue;
    const def = /** @type {any} */ (DEFAULTS)[key];
    if (typeof def === "boolean") out[key] = Boolean(v);
    else if (typeof def === "number") {
      const n = Number(v);
      if (Number.isFinite(n)) out[key] = n;
    } else if (typeof def === "string" && typeof v === "string") {
      out[key] = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 48);
    }
  }
  out.pollSeconds = clamp(out.pollSeconds, 15, 600);
  out.cooldownSeconds = clamp(out.cooldownSeconds, 0, 600);
  out.volume = clamp(out.volume, 0, 1);
  return out;
}

/** @param {number} v @param {number} lo @param {number} hi */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Label sumber notifikasi, supaya seller multi-akun tahu toko mana yang berbunyi.
 *
 * Judul halaman TIDAK dipakai sebagai nama: judul Seller Centre adalah nama
 * halaman ("Pesanan Saya"), sama di semua akun, jadi justru menyamarkan asal.
 * Urutan: nama toko dari halaman > domain + nomor tab.
 * @param {{url?: string, shopName?: string, tabId?: number}} src
 */
export function shopLabel(src) {
  const name = typeof src.shopName === "string" ? src.shopName.trim() : "";
  if (name && name.length <= 48) return name;
  let host = "Seller Centre";
  try {
    if (src.url) host = new URL(src.url).hostname.replace(/^seller\./, "");
  } catch {
    /* ignore */
  }
  return src.tabId === undefined ? host : `${host} · tab ${src.tabId}`;
}

/** Format teks jumlah untuk badan notifikasi. */
export function countText(prev, next) {
  if (typeof next !== "number") return "";
  if (typeof prev === "number" && next > prev) {
    const delta = next - prev;
    return delta > 1 ? `${delta} item baru (total ${next})` : `total ${next} belum dibaca`;
  }
  return `${next} belum dibaca`;
}

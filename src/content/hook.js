/**
 * Hook dunia MAIN, dijalankan di document_start.
 *
 * Kenapa perlu? Badge DOM Seller Center hanya diperbarui oleh React saat halaman
 * dianggap aktif; di tab background angka bisa membeku menit-menitan. Namun
 * WebSocket/polling internal Shopee tetap mengalir. Dengan membungkus fetch,
 * XHR, dan WebSocket kita membaca angka belum-dibaca langsung dari payload,
 * lalu meneruskannya ke content script lewat window.postMessage.
 *
 * Tidak ada data yang keluar dari browser: hanya angka unread yang dipakai.
 */

(() => {
  const TAG = "__ssn_hooked__";
  if (window[TAG]) return;
  window[TAG] = true;

  const CHANNEL = "__ssn_probe__";
  const MAX_BODY = 512 * 1024; // jangan pindai payload raksasa (gambar/laporan)

  /** URL yang layak dipindai — hemat CPU, hindari parse JSON tak relevan. */
  const URL_HINT = /(unread|notification|notif|message|chat|conversation|badge|todo|banner_count|summary)/i;

  /** Kunci JSON yang menandakan jumlah belum dibaca. */
  const CHAT_KEY = /^(unread_?count|unread|total_?unread|unread_?total|conversation_?unread|chat_?unread)$/i;
  const NOTIF_KEY = /^(notification_?unread(_?count)?|unread_?notification(_?count)?|notice_?unread(_?count)?|new_?notification(_?count)?)$/i;
  const CHAT_HINT = /(chat|message|conversation|webchat)/i;
  const NOTIF_HINT = /(notif|notice|announcement|seller_?center_?notice)/i;

  /**
   * @param {"notif"|"chat"} kind
   * @param {number} count
   */
  function emit(kind, count) {
    if (!Number.isFinite(count) || count < 0 || count > 100000) return;
    window.postMessage({ __ssn: CHANNEL, kind, count: Math.floor(count), source: "api" }, location.origin);
  }

  /**
   * Cari angka unread dalam objek JSON dengan konteks nama kunci induknya.
   * Batas kedalaman/kunjungan mencegah blowup pada payload dalam.
   * @param {unknown} node
   * @param {string} path
   * @param {{visits: number}} budget
   * @param {{chat: number|null, notif: number|null}} out
   */
  function walk(node, path, budget, out) {
    if (budget.visits++ > 4000 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && i < 200; i++) walk(node[i], path, budget, out);
      return;
    }
    for (const key of Object.keys(node)) {
      const val = /** @type {any} */ (node)[key];
      if (typeof val === "number") {
        const ctxPath = `${path}.${key}`;
        if (NOTIF_KEY.test(key) || (CHAT_KEY.test(key) && NOTIF_HINT.test(path) && !CHAT_HINT.test(key))) {
          out.notif = pick(out.notif, val);
        } else if (CHAT_KEY.test(key)) {
          if (CHAT_HINT.test(ctxPath) || !NOTIF_HINT.test(ctxPath)) out.chat = pick(out.chat, val);
          else out.notif = pick(out.notif, val);
        }
      } else if (val && typeof val === "object") {
        walk(val, `${path}.${key}`, budget, out);
      }
    }
  }

  /** Ambil nilai terbesar: payload kadang memuat per-kategori dan totalnya. */
  function pick(prev, next) {
    if (!Number.isFinite(next) || next < 0) return prev;
    return prev === null ? next : Math.max(prev, next);
  }

  /** @param {string} url @param {string} text */
  function scan(url, text) {
    if (!text || text.length > MAX_BODY) return;
    if (text[0] !== "{" && text[0] !== "[") return;
    // Filter murah sebelum JSON.parse: payload tanpa kata "unread" tidak menarik.
    if (!/unread/i.test(text)) return;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    const out = { chat: null, notif: null };
    walk(data, hintPath(url), { visits: 0 }, out);
    if (out.chat !== null) emit("chat", out.chat);
    if (out.notif !== null) emit("notif", out.notif);
  }

  /** Path URL ikut jadi konteks: /webchat/... membuat "unread" berarti chat. */
  function hintPath(url) {
    try {
      return new URL(url, location.href).pathname.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
    } catch {
      return "";
    }
  }

  /* ------------------------------------------------------------- fetch ---- */

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input ?? "");
      const promise = origFetch.apply(this, arguments);
      if (!URL_HINT.test(url)) return promise;
      return promise.then((res) => {
        // clone() supaya body asli tetap utuh untuk aplikasi Shopee.
        if (res && res.ok && res.body) {
          try {
            res
              .clone()
              .text()
              .then((t) => scan(url, t))
              .catch(() => {});
          } catch {
            /* body sudah dikonsumsi */
          }
        }
        return res;
      });
    };
  }

  /* --------------------------------------------------------------- XHR ---- */

  const OpenOrig = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ssnUrl = String(url ?? "");
    if (URL_HINT.test(this.__ssnUrl)) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") scan(this.__ssnUrl, this.responseText);
          else if (this.responseType === "json" && this.response) scan(this.__ssnUrl, JSON.stringify(this.response));
        } catch {
          /* akses response bisa melempar pada tipe tertentu */
        }
      });
    }
    return OpenOrig.apply(this, arguments);
  };

  /* --------------------------------------------------------- WebSocket ---- */

  const NativeWS = window.WebSocket;
  if (typeof NativeWS === "function") {
    const Patched = function (url, protocols) {
      const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") scan(String(url), ev.data);
      });
      return ws;
    };
    Patched.prototype = NativeWS.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Patched[k] = NativeWS[k];
    window.WebSocket = /** @type {any} */ (Patched);
  }

  /* ------------------------------------------------ nama toko dari state ---- */

  // Nama toko muncul di beberapa tempat global; kirim sekali kalau ketemu.
  function reportShopName() {
    const cand =
      window.__INITIAL_STATE__?.shop?.name ??
      window.__INITIAL_STATE__?.userInfo?.shop_name ??
      window.SPC_SELLER?.shop_name ??
      null;
    if (typeof cand === "string" && cand.trim()) {
      window.postMessage({ __ssn: CHANNEL, shopName: cand.trim() }, location.origin);
      return true;
    }
    return false;
  }
  if (!reportShopName()) {
    let tries = 0;
    const t = setInterval(() => {
      if (reportShopName() || ++tries > 20) clearInterval(t);
    }, 1000);
  }
})();

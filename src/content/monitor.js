/**
 * Content script (dunia terisolasi): mengumpulkan pembacaan dari tiga sumber,
 * mengirim ke service worker, dan memasang panel kontrol kecil.
 *
 * Anti-throttle: MutationObserver + Page Visibility tetap bekerja di tab
 * background, tetapi setInterval di-throttle ke ~1x/menit. Karena itu polling
 * paksa datang dari service worker (chrome.alarms) melalui pesan PROBE_NOW, dan
 * interval lokal hanya jaring pengaman saat tab terlihat.
 */

const CHANNEL = "__ssn_probe__";
const MSG = {
  REPORT: "report",
  HELLO: "hello",
  TEST: "test",
  SET_ENABLED: "set-enabled",
  SETTINGS: "settings",
  PROBE_NOW: "probe-now",
};

let settings = { enabled: true, showPanel: true };
let shopName = "";
/** Pembacaan dari hook API, menunggu dikirim. @type {Map<string, number>} */
const apiPending = new Map();
let lastTitle = "";
let disposed = false;

/* ------------------------------------------------------------ util DOM ---- */

/** @param {Element} el */
function visible(el) {
  if (!(el instanceof HTMLElement)) return true;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
  // Badge Shopee kecil; jangan pakai offsetParent karena badge sering position:absolute.
  return el.getClientRects().length > 0;
}

/** Ambil angka pertama dari teks badge ("12", "99+", "1 baru"). */
function parseBadge(text) {
  const t = (text || "").trim();
  if (!t) return null;
  if (/^\d+\s*\+$/.test(t)) return Number(t.replace(/\D/g, ""));
  const m = t.match(/\d{1,5}/);
  if (!m) return null;
  return Number(m[0]);
}

const CHAT_WORDS = /(chat|message|pesan|mensaje|conversation|webchat|im[-_]?unread)/i;
const NOTIF_WORDS = /(notif|notice|pemberitahuan|bell|announce|todo)/i;
const BADGE_WORDS = /(badge|unread|count|dot|red[-_]?point|superscript|sup)/i;

/**
 * Klasifikasikan badge berdasarkan konteks: className/aria/href elemen itu dan
 * leluhurnya. Shopee sering mengganti nama kelas hash, jadi kita bergantung pada
 * kata kunci yang stabil (aria-label, href, ikon) alih-alih satu selector kaku.
 * @param {Element} el
 * @returns {"chat"|"notif"|null}
 */
function classify(el) {
  let node = /** @type {Element|null} */ (el);
  let depth = 0;
  while (node && depth++ < 6) {
    const bag = [
      node.getAttribute?.("class") || "",
      node.getAttribute?.("aria-label") || "",
      node.getAttribute?.("data-testid") || "",
      node.getAttribute?.("title") || "",
      node.tagName === "A" ? node.getAttribute("href") || "" : "",
    ].join(" ");
    if (CHAT_WORDS.test(bag)) return "chat";
    if (NOTIF_WORDS.test(bag)) return "notif";
    node = node.parentElement;
  }
  return null;
}

/**
 * Pindai badge di header. Dibatasi ke area header/nav bila ada, supaya badge di
 * dalam daftar pesanan tidak ikut terhitung.
 *
 * Selalu melaporkan kedua jenis, termasuk 0. Tanpa nol eksplisit, badge yang
 * hilang setelah seller membaca pesan tidak akan menurunkan state, sehingga
 * pesanan berikutnya terlihat seperti "angka turun" dan tidak dinotifikasi.
 * @returns {Array<{kind: "chat"|"notif", count: number, source: "dom"}>}
 */
function probeDom() {
  /** @type {Record<string, number>} */
  const best = { chat: 0, notif: 0 };
  const roots = [];
  for (const sel of ["header", '[class*="header" i]', '[class*="navbar" i]', "nav"]) {
    for (const r of document.querySelectorAll(sel)) {
      if (roots.length < 8 && visible(r)) roots.push(r);
    }
  }
  if (!roots.length) roots.push(document.body);

  const seen = new Set();
  for (const root of roots) {
    if (!root) continue;
    const nodes = root.querySelectorAll(
      '[class*="badge" i],[class*="unread" i],[class*="count" i],[class*="dot" i],sup,[class*="red-point" i]',
    );
    for (const el of nodes) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (seen.size > 400) break;
      const cls = el.getAttribute("class") || el.tagName;
      if (!BADGE_WORDS.test(cls) && el.tagName !== "SUP") continue;
      if (!visible(el)) continue;
      const kind = classify(el);
      if (!kind) continue;
      const text = (el.textContent || "").trim();
      // Badge titik tanpa angka = "ada sesuatu yang baru" -> hitung sebagai 1.
      let count = parseBadge(text);
      if (count === null) count = text.length === 0 && el.getClientRects().length ? 1 : null;
      if (count === null || count <= 0) continue;
      best[kind] = Math.max(best[kind] ?? 0, count);
    }
  }
  return Object.entries(best).map(([kind, count]) => ({
    kind: /** @type {"chat"|"notif"} */ (kind),
    count,
    source: /** @type {"dom"} */ ("dom"),
  }));
}

/**
 * document.title adalah sumber paling tahan throttle: Shopee memberi awalan
 * "(3)" saat ada yang belum dibaca, dan judul tetap diperbarui di tab background.
 * @returns {Array<{kind: "notif", count: number, source: "title"}>}
 */
function probeTitle() {
  const m = document.title.match(/^\s*\((\d{1,5})\+?\)/);
  const count = m ? Number(m[1]) : 0;
  if (!Number.isFinite(count) || count < 0) return [];
  return [{ kind: /** @type {"notif"} */ ("notif"), count, source: /** @type {"title"} */ ("title") }];
}

/* ------------------------------------------------------------- reporting ---- */

function hidden() {
  return document.visibilityState !== "visible" || !document.hasFocus();
}

let sending = false;
let pendingProbe = false;

async function probeAndReport(force = false) {
  if (disposed || !settings.enabled) return;
  if (sending) {
    pendingProbe = true;
    return;
  }
  sending = true;
  try {
    /** @type {Array<{kind: string, count: number, source: string}>} */
    const readings = [];
    for (const [kind, count] of apiPending) readings.push({ kind, count, source: "api" });
    apiPending.clear();
    readings.push(...probeDom(), ...probeTitle());
    if (!readings.length && !force) return;

    await chrome.runtime.sendMessage({
      type: MSG.REPORT,
      readings,
      hidden: hidden(),
      url: location.href,
      title: document.title,
      shopName,
    });
  } catch (err) {
    // "Extension context invalidated" saat ekstensi di-reload: berhenti bersih.
    if (String(err?.message || err).includes("context invalidated")) dispose();
  } finally {
    sending = false;
    if (pendingProbe) {
      pendingProbe = false;
      setTimeout(() => probeAndReport(), 200);
    }
  }
}

let debounceTimer = null;
function probeSoon(delay = 400) {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    probeAndReport();
  }, delay);
}

/* --------------------------------------------------------------- sumber ---- */

window.addEventListener("message", (ev) => {
  if (ev.source !== window || !ev.data || ev.data.__ssn !== CHANNEL) return;
  const d = ev.data;
  if (typeof d.shopName === "string") {
    shopName = d.shopName;
    return;
  }
  if (d.kind !== "chat" && d.kind !== "notif") return;
  const prev = apiPending.get(d.kind);
  apiPending.set(d.kind, prev === undefined ? d.count : Math.max(prev, d.count));
  probeSoon(150);
});

const observer = new MutationObserver((records) => {
  for (const r of records) {
    const target = /** @type {Element} */ (r.target);
    const cls = target?.getAttribute?.("class") || "";
    if (BADGE_WORDS.test(cls) || CHAT_WORDS.test(cls) || NOTIF_WORDS.test(cls) || r.addedNodes.length) {
      probeSoon();
      return;
    }
  }
});

function startObserver() {
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "data-count", "aria-label"],
  });
  // <title> diganti wholesale oleh React; observasi terpisah agar pasti tertangkap.
  const titleEl = document.querySelector("title");
  if (titleEl) {
    new MutationObserver(() => {
      if (document.title === lastTitle) return;
      lastTitle = document.title;
      probeSoon(100);
    }).observe(titleEl, { subtree: true, childList: true, characterData: true });
  }
}

document.addEventListener("visibilitychange", () => probeAndReport(true));
window.addEventListener("focus", () => probeAndReport(true));
window.addEventListener("blur", () => probeAndReport(true));

// Jaring pengaman lokal; di tab background Chrome menurunkannya ke ~1x/menit,
// dan itu sudah ditutup oleh alarm di service worker.
const localTimer = setInterval(() => probeAndReport(), 10_000);

/* ----------------------------------------------------------------- panel ---- */

let panelEl = null;

function renderPanel() {
  if (!settings.showPanel) {
    panelEl?.remove();
    panelEl = null;
    return;
  }
  if (!panelEl) {
    panelEl = document.createElement("div");
    panelEl.className = "ssn-panel";
    panelEl.innerHTML = `
      <div class="ssn-row">
        <span class="ssn-dot" data-dot></span>
        <strong class="ssn-title">Seller Notifier</strong>
        <button class="ssn-x" data-hide title="Sembunyikan panel">×</button>
      </div>
      <div class="ssn-actions">
        <button class="ssn-btn ssn-btn-primary" data-test>🔔 Kirim Notifikasi Tes</button>
        <button class="ssn-btn" data-test-chat>💬 Tes Suara Chat</button>
        <button class="ssn-btn" data-toggle></button>
      </div>
      <div class="ssn-hint" data-hint></div>`;
    (document.body || document.documentElement).appendChild(panelEl);

    panelEl.querySelector("[data-test]").addEventListener("click", () => fireTest("notif"));
    panelEl.querySelector("[data-test-chat]").addEventListener("click", () => fireTest("chat"));
    panelEl.querySelector("[data-hide]").addEventListener("click", () => {
      panelEl.remove();
      panelEl = null;
    });
    panelEl.querySelector("[data-toggle]").addEventListener("click", async () => {
      const next = !settings.enabled;
      try {
        const res = await chrome.runtime.sendMessage({ type: MSG.SET_ENABLED, enabled: next });
        if (!res?.settings) throw new Error(res?.error || "Pengaturan tidak tersimpan.");
        settings = res.settings;
        renderPanel();
        hint(settings.enabled ? "Monitor aktif." : "Monitor dimatikan.");
        if (settings.enabled) probeAndReport(true);
      } catch (err) {
        hint(`Gagal mengubah monitor: ${errorText(err)}`);
      }
    });
  }
  panelEl.querySelector("[data-toggle]").textContent = settings.enabled ? "⏸ Matikan Monitor" : "▶ Nyalakan Monitor";
  panelEl.querySelector("[data-dot]").classList.toggle("ssn-dot-off", !settings.enabled);
}

/** @param {string} text */
function hint(text) {
  const el = panelEl?.querySelector("[data-hint]");
  if (!el) return;
  el.textContent = text;
  clearTimeout(el.__t);
  el.__t = setTimeout(() => (el.textContent = ""), 4000);
}

/** @param {unknown} err */
function errorText(err) {
  return String(err?.message || err || "Coba lagi.");
}

/** @param {any} res @param {"notif"|"chat"} kind */
function testHint(res, kind) {
  const label = kind === "chat" ? "Tes suara chat" : "Notifikasi tes";
  if (!res?.ok) return `Gagal mengirim ${label.toLowerCase()}: ${res?.error || "Coba lagi."}`;
  if (!res.audio?.ok) return `${label} dikirim, tetapi suara gagal diputar: ${res.audio?.error || "Coba lagi."}`;
  if (res.audio.skipped) return `${label} dikirim. Suara sedang dinonaktifkan.`;
  return `${label} dikirim dan suara diputar.`;
}

/** @param {"notif"|"chat"} kind */
async function fireTest(kind) {
  try {
    // shopName ikut dikirim: hook baru menemukannya beberapa saat setelah
    // HELLO, jadi tanpa ini notifikasi tes memakai label domain, bukan toko.
    const res = await chrome.runtime.sendMessage({ type: MSG.TEST, kind, shopName, url: location.href });
    hint(testHint(res, kind));
  } catch (err) {
    hint(`Gagal mengirim tes: ${errorText(err)}`);
  }
}

/* ------------------------------------------------------------- messaging ---- */

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === MSG.PROBE_NOW) {
    probeAndReport(true);
    respond?.({ ok: true });
    return;
  }
  if (msg.type === MSG.SETTINGS) {
    settings = msg.settings || settings;
    renderPanel();
    if (settings.enabled) probeAndReport(true);
    respond?.({ ok: true });
  }
});

function dispose() {
  disposed = true;
  clearInterval(localTimer);
  observer.disconnect();
  panelEl?.remove();
  panelEl = null;
}

/* ------------------------------------------------------------------ init ---- */

(async function init() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.HELLO,
      url: location.href,
      title: document.title,
    });
    if (res?.settings) settings = res.settings;
  } catch {
    /* worker belum siap; settings default dipakai */
  }
  lastTitle = document.title;
  startObserver();
  renderPanel();
  probeAndReport(true);
})();

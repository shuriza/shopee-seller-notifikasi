import { DEFAULTS, KIND, MSG, STORE, countText, shopLabel, withDefaults } from "../shared/common.js";
import { applyReading, createState, restoreReading, totalUnread } from "../shared/detect.js";

/**
 * Service worker: pemilik semua keputusan.
 *
 * Kenapa di sini, bukan di content script?
 * 1. Chrome men-throttle timer halaman background jadi ~1x/menit, jadi polling
 *    harus dipicu dari luar halaman (chrome.alarms).
 * 2. Service worker MV3 sendiri bisa mati; alarm membangunkannya kembali, dan
 *    state di memori direhidrasi dari chrome.storage.session.
 */

const ALARM_POLL = "poll";
const OFFSCREEN_PATH = "src/offscreen/offscreen.html";
const NOTIF_PREFIX = "ssn:";
const SESSION = Object.freeze({
  TAB_STATE: "tabState",
  NOTIFICATION_TARGETS: "notificationTargets",
  ID: "historySessionId",
});

/** @type {Map<number, ReturnType<typeof createState> & {label: string, url: string, trackerId: string, lastReportedAt: number}>} */
const tabs = new Map();
/** notificationId -> private target identity, untuk fokus tab saat notifikasi diklik. */
const notifTargets = new Map();
let settings = { ...DEFAULTS };
let creatingOffscreen = null;
let ready = null;
let sessionDirty = false;
let operationTail = Promise.resolve();
let sessionId = "";

const HISTORY_LIMIT = 200;

/** @param {string | undefined} url */
function isSellerUrl(url) {
  return typeof url === "string" && matchPatterns().some((pattern) =>
    pattern.endsWith("*") && url.startsWith(pattern.slice(0, -1)),
  );
}

/** @param {unknown} raw */
function historyEntries(raw) {
  return Array.isArray(raw) ? raw : [];
}

/**
 * Worker mutations are serialized. Read storage on every operation so history
 * survives worker sleep without retaining another in-memory copy.
 * @param {Record<string, unknown>} entry
 */
async function appendHistory(entry) {
  try {
    const stored = await chrome.storage.local.get(STORE.HISTORY);
    const entries = historyEntries(stored[STORE.HISTORY]);
    await chrome.storage.local.set({ [STORE.HISTORY]: [entry, ...entries].slice(0, HISTORY_LIMIT) });
  } catch (err) {
    // A record-keeping failure must never change delivery result of a toast.
    console.warn("[SSN] gagal menyimpan riwayat notifikasi:", err);
  }
}

/** @param {any} entry @param {Map<number, string>} liveSellerTabs */
function exposeHistoryEntry(entry, liveSellerTabs) {
  const target = entry && typeof entry === "object" ? entry : {};
  const tabId = target.tabId;
  const st = Number.isInteger(tabId) ? tabs.get(tabId) : undefined;
  const canOpen = target.sessionId === sessionId
    && Number.isInteger(tabId)
    && liveSellerTabs.has(tabId)
    && Boolean(st && liveSellerTabs.get(tabId) === st.url && isSellerUrl(st.url) &&
      st.label === target.targetLabel && st.trackerId === target.trackerId);
  return {
    id: typeof target.id === "string" ? target.id : "",
    at: Number.isFinite(target.at) ? target.at : 0,
    kind: target.kind === KIND.CHAT ? KIND.CHAT : KIND.NOTIF,
    test: Boolean(target.test),
    label: typeof target.label === "string" ? target.label : "",
    profileLabel: typeof target.profileLabel === "string" ? target.profileLabel : "",
    title: typeof target.title === "string" ? target.title : "",
    count: Number.isFinite(target.count) ? target.count : null,
    source: target.source === "api" || target.source === "dom" || target.source === "title" ? target.source : null,
    delivery: target.delivery === "sent" ? "sent" : "failed",
    audio: target.audio === "played" || target.audio === "off" || target.audio === "failed" ? target.audio : null,
    error: typeof target.error === "string" ? target.error : "",
    canOpen,
  };
}

/** @param {number} tabId @param {string | undefined} expectedLabel */
async function focusTrackedSellerTab(tabId, expectedLabel) {
  const st = tabs.get(tabId);
  if (!st || !isSellerUrl(st.url) || (expectedLabel !== undefined && st.label !== expectedLabel)) {
    return { ok: false, error: "Tab Seller Centre sudah tidak tersedia." };
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isSellerUrl(tab.url)) return { ok: false, error: "Tab Seller Centre sudah tidak tersedia." };
    if (tab.url !== st.url) return { ok: false, error: "Tab Seller Centre sudah tidak tersedia." };
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return { ok: true };
  } catch {
    return { ok: false, error: "Tab Seller Centre sudah tidak tersedia." };
  }
}

/**
 * Event MV3 dapat masuk bersamaan setelah worker dibangunkan. Serialisasi ini
 * mencegah dua REPORT membaca baseline yang sama atau dua SET_SETTINGS saling
 * menimpa perubahan. Error satu event tidak merusak antrean event berikutnya.
 * @template T
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
function runExclusive(work) {
  const result = operationTail.then(work, work);
  operationTail = result.catch((err) => console.warn("[SSN] operasi worker gagal:", err));
  return result;
}

/* ------------------------------------------------------------- settings ---- */

/** @param {Record<string, unknown>} patch */
async function saveSettings(patch) {
  settings = withDefaults({ ...settings, ...patch });
  await chrome.storage.local.set({ [STORE.SETTINGS]: settings });
  await syncAlarm();
  broadcastSettings();
  return settings;
}

function broadcastSettings() {
  for (const tabId of tabs.keys()) send(tabId, { type: MSG.SETTINGS, settings });
}

/** @param {number} tabId @param {any} msg */
function send(tabId, msg) {
  // Reload/navigasi membuat content script sebentar tidak tersedia. Itu bukan
  // bukti tab ditutup; menghapus state di sini akan mengulang baseline dan
  // berisiko menggandakan notifikasi setelah script hidup lagi.
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

/* ---------------------------------------------------------------- state ---- */

function markSessionDirty() {
  sessionDirty = true;
}

/**
 * Global service-worker dapat hilang 30 detik setelah idle. Jangan debounce
 * state yang menjadi dasar dedupe: simpan sebelum event selesai agar wake-up
 * berikutnya tidak menilai hitungan lama sebagai notifikasi baru.
 */
async function persistSession() {
  if (!sessionDirty) return;
  const tabState = {};
  for (const [tabId, st] of tabs) {
    tabState[tabId] = {
      kinds: st.kinds,
      label: st.label,
      url: st.url,
      trackerId: st.trackerId,
      lastReportedAt: st.lastReportedAt,
    };
  }
  const notificationTargets = Object.fromEntries(notifTargets);
  try {
    await chrome.storage.session.set({
      [SESSION.TAB_STATE]: tabState,
      [SESSION.NOTIFICATION_TARGETS]: notificationTargets,
    });
    sessionDirty = false;
  } catch (err) {
    // Tetap dirty agar event berikutnya mencoba menyimpan lagi; jangan membuat
    // state in-memory tampak sudah aman padahal gagal dipersistenkan.
    sessionDirty = true;
    throw err;
  }
}

/** Memulihkan state sekali per kelahiran worker. */
async function restoreSession() {
  const stored = await chrome.storage.session.get([SESSION.TAB_STATE, SESSION.NOTIFICATION_TARGETS]);
  const rawTabs = stored[SESSION.TAB_STATE];
  if (rawTabs && typeof rawTabs === "object") {
    for (const [id, entry] of Object.entries(rawTabs)) {
      const tabId = Number(id);
      if (!Number.isInteger(tabId) || !entry || typeof entry !== "object") continue;
      tabs.set(tabId, {
        kinds: entry.kinds && typeof entry.kinds === "object" ? entry.kinds : Object.create(null),
        label: typeof entry.label === "string" ? entry.label : "",
        url: typeof entry.url === "string" ? entry.url : "",
        trackerId: typeof entry.trackerId === "string" && entry.trackerId ? entry.trackerId : crypto.randomUUID(),
        lastReportedAt: Number.isFinite(entry.lastReportedAt) ? entry.lastReportedAt : 0,
      });
    }
  }
  const rawTargets = stored[SESSION.NOTIFICATION_TARGETS];
  if (rawTargets && typeof rawTargets === "object") {
    for (const [id, target] of Object.entries(rawTargets)) {
      if (target && typeof target === "object" && Number.isInteger(target.tabId) && typeof target.trackerId === "string") {
        notifTargets.set(id, target);
      }
    }
  }
}

/** Hapus session state untuk tab yang sudah benar-benar tidak ada. */
async function pruneClosedTabs() {
  const live = await chrome.tabs.query({ url: matchPatterns() });
  const liveIds = new Set(live.map((tab) => tab.id).filter(Number.isInteger));
  let changed = false;
  for (const tabId of tabs.keys()) {
    if (!liveIds.has(tabId)) {
      tabs.delete(tabId);
      changed = true;
    }
  }
  if (changed) {
    markSessionDirty();
    updateBadge();
  }
  return live;
}

/**
 * Satu barrier bootstrap. Semua event menunggunya sebelum menyentuh state,
 * sehingga restore storage tidak balapan dengan HELLO/REPORT pertama.
 */
function ensureReady() {
  if (ready) return ready;
  ready = (async () => {
    const [storedSettings, storedSession] = await Promise.all([
      chrome.storage.local.get(STORE.SETTINGS),
      chrome.storage.session.get(SESSION.ID),
      restoreSession(),
    ]);
    settings = withDefaults(storedSettings[STORE.SETTINGS]);
    sessionId = typeof storedSession[SESSION.ID] === "string" && storedSession[SESSION.ID]
      ? storedSession[SESSION.ID]
      : crypto.randomUUID();
    if (sessionId !== storedSession[SESSION.ID]) {
      await chrome.storage.session.set({ [SESSION.ID]: sessionId });
    }
    await pruneClosedTabs();
    await syncAlarm();
    await persistSession();
    updateBadge();
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

/** @param {number} tabId @param {{url?: string, shopName?: string}} meta */
function stateFor(tabId, meta) {
  let st = tabs.get(tabId);
  if (!st) {
    st = Object.assign(createState(), { label: "", url: "", trackerId: crypto.randomUUID(), lastReportedAt: 0 });
    tabs.set(tabId, st);
    markSessionDirty();
  }
  if (meta) {
    if (meta.url && meta.url !== st.url) {
      st.url = meta.url;
      markSessionDirty();
    }
    // HELLO/probe awal sering belum punya nama toko. Jangan timpa nama yang
    // sudah benar dengan fallback domain atau judul halaman saat itu terjadi.
    const suppliedName = typeof meta.shopName === "string" ? meta.shopName.trim() : "";
    const label = suppliedName || st.label || shopLabel({ url: st.url, tabId });
    if (label !== st.label) {
      st.label = label;
      markSessionDirty();
    }
  }
  return st;
}

/* --------------------------------------------------------------- alarms ---- */

async function syncAlarm() {
  if (!settings.enabled) {
    await chrome.alarms.clear(ALARM_POLL);
    return;
  }
  // chrome.alarms minimum 30 detik untuk periode berulang.
  const minutes = Math.max(settings.pollSeconds, 30) / 60;
  const existing = await chrome.alarms.get(ALARM_POLL);
  if (existing && Math.abs((existing.periodInMinutes ?? 0) - minutes) < 1e-6) return;
  await chrome.alarms.create(ALARM_POLL, { periodInMinutes: minutes, delayInMinutes: minutes });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_POLL) return;
  await runExclusive(async () => {
    await ensureReady();
    if (!settings.enabled) return;
    const live = await pruneClosedTabs();
    for (const tab of live) if (tab.id !== undefined) send(tab.id, { type: MSG.PROBE_NOW });
    await persistSession();
  });
});

function matchPatterns() {
  return chrome.runtime.getManifest().host_permissions ?? [];
}

/* ---------------------------------------------------------------- audio ---- */

async function hasOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  // getContexts tersedia sejak Chrome 116; hasDocument baru Chrome 150.
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  // AUDIO_PLAYBACK boleh ditutup Chrome setelah 30s sunyi. Promise global yang
  // permanen akan mengira dokumen lama masih ada lalu pesan audio hilang.
  const exists = await hasOffscreenDocument();
  if (exists) return;
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = (async () => {
    const has = await hasOffscreenDocument();
    if (!has) {
      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_PATH,
          reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
          justification: "Memutar suara notifikasi saat tab Seller Center tidak aktif.",
        });
      } catch (err) {
        // Race: dokumen sudah dibuat oleh invocation lain.
        if (!String(err?.message || err).includes("Only a single offscreen")) throw err;
      }
    }
  })();
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

/** @param {"notif"|"chat"} kind */
async function playSound(kind) {
  if (!settings.soundEnabled || settings.volume <= 0) return { ok: true, skipped: true };
  try {
    await ensureOffscreen();
    const result = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: MSG.PLAY,
      kind,
      volume: settings.volume,
    });
    if (!result?.ok) throw new Error(result?.error || "Pemutar suara tidak merespons.");
    return { ok: true };
  } catch (err) {
    const error = String(err?.message || err);
    console.warn("[SSN] gagal memutar suara:", error);
    return { ok: false, error };
  }
}

/* --------------------------------------------------------- notifications ---- */

let notifSeq = 0;

/**
 * @param {{kind: "notif"|"chat", title: string, body: string, tabId?: number, label?: string, count?: number, source?: "api"|"dom"|"title", test?: boolean}} spec
 */
async function pushNotification(spec) {
  const id = `${NOTIF_PREFIX}${spec.kind}:${Date.now()}:${notifSeq++}`;
  const at = Date.now();
  const profileLabel = settings.profileLabel;
  const title = `${profileLabel ? `[${profileLabel}] ` : ""}${spec.title}`;
  const target = spec.tabId === undefined ? undefined : tabs.get(spec.tabId);
  const history = (delivery, audio = null, error = "") => appendHistory({
    id,
    at,
    kind: spec.kind,
    test: Boolean(spec.test),
    label: typeof spec.label === "string" ? spec.label : "",
    profileLabel,
    title,
    count: Number.isFinite(spec.count) ? spec.count : null,
    source: spec.source ?? null,
    delivery,
    audio,
    error,
    sessionId: target ? sessionId : "",
    tabId: target ? spec.tabId : null,
    targetLabel: target?.label ?? "",
    trackerId: target?.trackerId ?? "",
  });
  try {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("assets/icons/icon128.png"),
      title,
      message: spec.body,
      priority: 2,
      requireInteraction: Boolean(settings.requireInteraction),
      silent: true, // suara diputar sendiri supaya bisa beda per jenis
    });
  } catch (err) {
    const error = String(err?.message || err);
    console.warn("[SSN] gagal membuat notifikasi:", err);
    await history("failed", null, error);
    return { ok: false, error };
  }
  if (spec.tabId !== undefined && target) {
    notifTargets.set(id, { tabId: spec.tabId, trackerId: target.trackerId });
    markSessionDirty();
    // Toast sudah dibuat. Kegagalan menyimpan target klik tidak boleh berubah
    // menjadi "gagal mengirim" atau menghentikan audio/statistik; target tetap
    // ada di memori dan akan dicoba simpan pada event berikutnya.
    try {
      await persistSession();
    } catch (err) {
      console.warn("[SSN] target klik belum tersimpan:", err);
    }
  }
  const audio = await playSound(spec.kind);
  try {
    await bumpStat(spec.kind);
  } catch (err) {
    // Statistika tidak menentukan apakah notifikasi layar telah berhasil.
    console.warn("[SSN] gagal menyimpan statistik notifikasi:", err);
  }
  const audioStatus = audio.ok ? (audio.skipped ? "off" : "played") : "failed";
  await history("sent", audioStatus, audio.ok ? "" : audio.error);
  return { ok: true, id, audio };
}

/** @param {"notif"|"chat"} kind */
async function bumpStat(kind) {
  const got = await chrome.storage.local.get(STORE.STATS);
  const stats = got[STORE.STATS] || { notif: 0, chat: 0, lastAt: 0 };
  stats[kind] = (stats[kind] || 0) + 1;
  stats.lastAt = Date.now();
  await chrome.storage.local.set({ [STORE.STATS]: stats });
}

chrome.notifications.onClicked.addListener((id) => {
  runExclusive(async () => {
    await ensureReady();
    const target = notifTargets.get(id);
    await chrome.notifications.clear(id);
    notifTargets.delete(id);
    markSessionDirty();
    await persistSession();
    if (!target || tabs.get(target.tabId)?.trackerId !== target.trackerId) return;
    await focusTrackedSellerTab(target.tabId);
  }).catch((err) => console.warn("[SSN] gagal menangani klik notifikasi:", err));
});

chrome.notifications.onClosed.addListener((id) => {
  runExclusive(async () => {
    await ensureReady();
    if (!notifTargets.delete(id)) return;
    markSessionDirty();
    await persistSession();
  }).catch((err) => console.warn("[SSN] gagal menyimpan penutupan notifikasi:", err));
});

/* ---------------------------------------------------------------- badge ---- */

function updateBadge() {
  const total = totalUnread(tabs.values());
  const text = total > 0 ? (total > 99 ? "99+" : String(total)) : "";
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: settings.enabled ? "#ee4d2d" : "#9aa0a6" }).catch(() => {});
}

/* -------------------------------------------------------------- reports ---- */

/**
 * @param {number} tabId
 * @param {{readings: Array<{kind: "notif"|"chat", count: number, source: "api"|"dom"|"title", detail?: string}>, hidden: boolean, url?: string, title?: string, shopName?: string}} payload
 */
async function handleReport(tabId, payload) {
  const st = stateFor(tabId, payload);
  const now = Date.now();
  st.lastReportedAt = now;
  if (!settings.enabled) {
    markSessionDirty();
    await persistSession();
    return { ok: false, reason: "disabled" };
  }
  const fired = [];

  // Sesuai permintaan: notifikasi hanya saat seller tidak sedang menatap tab.
  const suppress = Boolean(settings.onlyWhenHidden && !payload.hidden);
  const opts = { ...settings, suppress };

  for (const reading of payload.readings || []) {
    const before = st.kinds[reading.kind]
      ? { ...st.kinds[reading.kind], proven: { ...(st.kinds[reading.kind].proven || {}) } }
      : undefined;
    const { event, reason } = applyReading(st, reading, opts, now);
    if (!event) continue;
    const isChat = event.kind === KIND.CHAT;
    const sent = await pushNotification({
      kind: event.kind,
      title: `${isChat ? "💬 Chat baru" : "🔔 Notifikasi baru"} — ${st.label || "Seller Centre"}`,
      body: event.detail || countText(event.prev, event.count),
      tabId,
      label: st.label || "Seller Centre",
      count: event.count,
      source: event.source,
    });
    // chrome.notifications.create gagal berarti seller belum diberi tahu.
    // Rollback hanya untuk kegagalan pembuatan notifikasi, bukan kegagalan
    // audio—toast sudah tampil pada kasus audio gagal dan tidak boleh diulang.
    if (!sent.ok) restoreReading(st, event.kind, before);
    fired.push({ kind: event.kind, reason, sent });
  }

  // applyReading memutasi baseline/count meski tidak ada push (mis. tab sedang
  // terlihat atau count turun). Semua mutasi harus bertahan lintas worker idle,
  // atau wake-up berikutnya bisa mengirim duplikat.
  markSessionDirty();
  updateBadge();
  await persistSession();
  return { ok: true, fired };
}

/* ------------------------------------------------------------- messages ---- */

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.target === "offscreen") return; // bukan untuk kita

  runExclusive(async () => {
    await ensureReady();
    // Popup dibuka sebagai tab saat debugging juga punya sender.tab; halaman
    // ekstensi bukan toko dan tidak boleh masuk daftar Seller Centre.
    const ownPage = sender.url?.startsWith(chrome.runtime.getURL(""));
    const tabId = ownPage ? undefined : sender.tab?.id;

    switch (msg.type) {
      case MSG.HELLO: {
        if (tabId !== undefined) stateFor(tabId, msg);
        await persistSession();
        updateBadge();
        return { settings };
      }
      case MSG.REPORT: {
        if (tabId === undefined) return { ok: false, reason: "no-tab" };
        return handleReport(tabId, msg);
      }
      case MSG.TEST: {
        const label = tabId !== undefined ? stateFor(tabId, msg).label : null;
        const kind = msg.kind === KIND.CHAT ? KIND.CHAT : KIND.NOTIF;
        const sent = await pushNotification({
          kind,
          title: `${kind === KIND.CHAT ? "💬 Tes chat" : "🔔 Tes notifikasi"} — ${label || "Seller Centre"}`,
          body: "Kalau notifikasi ini muncul dan berbunyi, ekstensi bekerja normal.",
          tabId,
          label: label || "Seller Centre",
          test: true,
        });
        return sent;
      }
      case MSG.SET_ENABLED: {
        await saveSettings({ enabled: Boolean(msg.enabled) });
        updateBadge();
        return { settings };
      }
      case MSG.SET_SETTINGS: {
        if (!ownPage) return { ok: false, error: "Akses pengaturan ditolak." };
        await saveSettings(msg.patch || {});
        updateBadge();
        return { settings };
      }
      case MSG.RESET_BASELINE: {
        if (!ownPage) return { ok: false, error: "Akses baseline ditolak." };
        for (const st of tabs.values()) st.kinds = Object.create(null);
        markSessionDirty();
        await persistSession();
        updateBadge();
        return { ok: true };
      }
      case MSG.GET_STATE: {
        const got = await chrome.storage.local.get(STORE.STATS);
        const list = [];
        for (const [id, st] of tabs) {
          list.push({
            tabId: id,
            label: st.label,
            url: st.url,
            lastReportedAt: st.lastReportedAt || 0,
            kinds: Object.fromEntries(
              Object.entries(st.kinds).map(([k, v]) => [k, { count: v.count, source: v.source, at: v.at }]),
            ),
          });
        }
        return { settings, stats: got[STORE.STATS] || { notif: 0, chat: 0, lastAt: 0 }, tabs: list };
      }
      case MSG.GET_HISTORY: {
        if (!ownPage) return { ok: false, error: "Akses riwayat ditolak." };
        const [stored, live] = await Promise.all([
          chrome.storage.local.get(STORE.HISTORY),
          chrome.tabs.query({ url: matchPatterns() }),
        ]);
        const liveSellerTabs = new Map(live.filter((tab) => Number.isInteger(tab.id)).map((tab) => [tab.id, tab.url]));
        return {
          ok: true,
          entries: historyEntries(stored[STORE.HISTORY]).slice(0, HISTORY_LIMIT)
            .map((entry) => exposeHistoryEntry(entry, liveSellerTabs)),
          limit: HISTORY_LIMIT,
        };
      }
      case MSG.CLEAR_HISTORY: {
        if (!ownPage) return { ok: false, error: "Akses riwayat ditolak." };
        await chrome.storage.local.remove(STORE.HISTORY);
        return { ok: true };
      }
      case MSG.OPEN_HISTORY: {
        if (!ownPage) return { ok: false, error: "Akses riwayat ditolak." };
        const stored = await chrome.storage.local.get(STORE.HISTORY);
        const entry = historyEntries(stored[STORE.HISTORY]).find((item) => item?.id === msg.id);
        if (!entry || entry.sessionId !== sessionId || !Number.isInteger(entry.tabId)) {
          return { ok: false, error: "Tab asal sudah tidak tersedia." };
        }
        const st = tabs.get(entry.tabId);
        if (!st || st.trackerId !== entry.trackerId) return { ok: false, error: "Tab asal sudah tidak tersedia." };
        return focusTrackedSellerTab(entry.tabId, entry.targetLabel);
      }
      case MSG.OPEN_TAB: {
        if (!ownPage || !Number.isInteger(msg.tabId)) return { ok: false, error: "Akses tab ditolak." };
        return focusTrackedSellerTab(msg.tabId);
      }
      default:
        return { ok: false, reason: "unknown-type" };
    }
  }).then(
    (res) => respond(res),
    (err) => respond({ ok: false, error: String(err?.message || err) }),
  );

  return true; // respons asinkron
});

/* ------------------------------------------------------------ lifecycle ---- */

chrome.tabs.onRemoved.addListener((tabId) => {
  runExclusive(async () => {
    await ensureReady();
    if (!tabs.delete(tabId)) return;
    markSessionDirty();
    updateBadge();
    await persistSession();
  }).catch((err) => console.warn("[SSN] gagal membersihkan tab tertutup:", err));
});

chrome.runtime.onInstalled.addListener(async () => {
  await runExclusive(ensureReady);
});

chrome.runtime.onStartup.addListener(async () => {
  await runExclusive(ensureReady);
});

// Setiap kali worker bangun (termasuk dari alarm), pastikan settings termuat.
ensureReady()
  .catch((err) => console.warn("[SSN] init gagal:", err));

import { DEFAULTS, KIND, MSG, STORE, countText, shopLabel, withDefaults } from "../shared/common.js";
import { applyReading, createState, totalUnread } from "../shared/detect.js";

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

/** @type {Map<number, ReturnType<typeof createState> & {label: string, url: string}>} */
const tabs = new Map();
/** notificationId -> tabId, untuk fokus tab saat notifikasi diklik. */
const notifTargets = new Map();
let settings = { ...DEFAULTS };
let offscreenReady = null;

/* ------------------------------------------------------------- settings ---- */

async function loadSettings() {
  const got = await chrome.storage.local.get(STORE.SETTINGS);
  settings = withDefaults(got[STORE.SETTINGS]);
  return settings;
}

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
  chrome.tabs.sendMessage(tabId, msg).catch(() => tabs.delete(tabId));
}

/* ---------------------------------------------------------------- state ---- */

const SESSION_KEY = "tabState";

async function rehydrate() {
  if (tabs.size) return;
  const got = await chrome.storage.session.get(SESSION_KEY);
  const raw = got[SESSION_KEY];
  if (!raw) return;
  for (const [id, entry] of Object.entries(raw)) {
    const tabId = Number(id);
    if (!Number.isFinite(tabId)) continue;
    tabs.set(tabId, { kinds: entry.kinds || Object.create(null), label: entry.label || "", url: entry.url || "" });
  }
}

let persistTimer = null;
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const dump = {};
    for (const [tabId, st] of tabs) dump[tabId] = { kinds: st.kinds, label: st.label, url: st.url };
    chrome.storage.session.set({ [SESSION_KEY]: dump }).catch(() => {});
  }, 250);
}

/** @param {number} tabId @param {{url?: string, shopName?: string}} meta */
function stateFor(tabId, meta) {
  let st = tabs.get(tabId);
  if (!st) {
    st = Object.assign(createState(), { label: "", url: "" });
    tabs.set(tabId, st);
  }
  if (meta) {
    if (meta.url) st.url = meta.url;
    st.label = shopLabel({ url: meta.url || st.url, shopName: meta.shopName, tabId });
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
  await loadSettings();
  await rehydrate();
  if (!settings.enabled) return;
  // Tab yang sudah tertutup dibersihkan agar state tidak menumpuk.
  const live = await chrome.tabs.query({ url: matchPatterns() });
  const liveIds = new Set(live.map((t) => t.id));
  for (const tabId of [...tabs.keys()]) if (!liveIds.has(tabId)) tabs.delete(tabId);
  for (const tab of live) if (tab.id !== undefined) send(tab.id, { type: MSG.PROBE_NOW });
  updateBadge();
  persistSoon();
});

function matchPatterns() {
  return chrome.runtime.getManifest().host_permissions ?? [];
}

/* ---------------------------------------------------------------- audio ---- */

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const has = await chrome.offscreen.hasDocument?.();
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
    await offscreenReady;
  } catch (err) {
    offscreenReady = null;
    throw err;
  }
  return offscreenReady;
}

/** @param {"notif"|"chat"} kind */
async function playSound(kind) {
  if (!settings.soundEnabled || settings.volume <= 0) return;
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: MSG.PLAY,
      kind,
      volume: settings.volume,
    });
  } catch (err) {
    console.warn("[SSN] gagal memutar suara:", err);
  }
}

/* --------------------------------------------------------- notifications ---- */

let notifSeq = 0;

/**
 * @param {{kind: "notif"|"chat", title: string, body: string, tabId?: number}} spec
 */
async function pushNotification(spec) {
  const id = `${NOTIF_PREFIX}${spec.kind}:${Date.now()}:${notifSeq++}`;
  if (spec.tabId !== undefined) notifTargets.set(id, spec.tabId);
  try {
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("assets/icons/icon128.png"),
      title: spec.title,
      message: spec.body,
      priority: 2,
      requireInteraction: Boolean(settings.requireInteraction),
      silent: true, // suara diputar sendiri supaya bisa beda per jenis
    });
  } catch (err) {
    console.warn("[SSN] gagal membuat notifikasi:", err);
    notifTargets.delete(id);
    return;
  }
  await playSound(spec.kind);
  await bumpStat(spec.kind);
}

/** @param {"notif"|"chat"} kind */
async function bumpStat(kind) {
  const got = await chrome.storage.local.get(STORE.STATS);
  const stats = got[STORE.STATS] || { notif: 0, chat: 0, lastAt: 0 };
  stats[kind] = (stats[kind] || 0) + 1;
  stats.lastAt = Date.now();
  await chrome.storage.local.set({ [STORE.STATS]: stats });
}

chrome.notifications.onClicked.addListener(async (id) => {
  const tabId = notifTargets.get(id);
  chrome.notifications.clear(id);
  notifTargets.delete(id);
  if (tabId === undefined) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    /* tab sudah ditutup */
  }
});

chrome.notifications.onClosed.addListener((id) => notifTargets.delete(id));

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
  if (!settings.enabled) return { ok: false, reason: "disabled" };
  const st = stateFor(tabId, payload);
  const now = Date.now();
  const fired = [];

  // Sesuai permintaan: notifikasi hanya saat seller tidak sedang menatap tab.
  const suppress = Boolean(settings.onlyWhenHidden && !payload.hidden);
  const opts = { ...settings, suppress };

  for (const reading of payload.readings || []) {
    const { event, reason } = applyReading(st, reading, opts, now);
    if (!event) continue;
    const isChat = event.kind === KIND.CHAT;
    await pushNotification({
      kind: event.kind,
      title: `${isChat ? "💬 Chat baru" : "🔔 Notifikasi baru"} — ${st.label || "Seller Centre"}`,
      body: event.detail || countText(event.prev, event.count),
      tabId,
    });
    fired.push({ kind: event.kind, reason });
  }

  updateBadge();
  persistSoon();
  return { ok: true, fired };
}

/* ------------------------------------------------------------- messages ---- */

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.target === "offscreen") return; // bukan untuk kita

  (async () => {
    await loadSettings();
    await rehydrate();
    const tabId = sender.tab?.id;

    switch (msg.type) {
      case MSG.HELLO: {
        if (tabId !== undefined) stateFor(tabId, msg);
        await syncAlarm();
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
        await pushNotification({
          kind,
          title: `${kind === KIND.CHAT ? "💬 Tes chat" : "🔔 Tes notifikasi"} — ${label || "Seller Centre"}`,
          body: "Kalau notifikasi ini muncul dan berbunyi, ekstensi bekerja normal.",
          tabId,
        });
        return { ok: true };
      }
      case MSG.SET_ENABLED: {
        await saveSettings({ enabled: Boolean(msg.enabled) });
        updateBadge();
        return { settings };
      }
      case MSG.SET_SETTINGS: {
        await saveSettings(msg.patch || {});
        updateBadge();
        return { settings };
      }
      case MSG.RESET_BASELINE: {
        for (const st of tabs.values()) st.kinds = Object.create(null);
        persistSoon();
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
            kinds: Object.fromEntries(
              Object.entries(st.kinds).map(([k, v]) => [k, { count: v.count, source: v.source, at: v.at }]),
            ),
          });
        }
        return { settings, stats: got[STORE.STATS] || { notif: 0, chat: 0, lastAt: 0 }, tabs: list };
      }
      default:
        return { ok: false, reason: "unknown-type" };
    }
  })().then(
    (res) => respond(res),
    (err) => respond({ ok: false, error: String(err?.message || err) }),
  );

  return true; // respons asinkron
});

/* ------------------------------------------------------------ lifecycle ---- */

/**
 * Port panjang dari tiap tab Seller Center. Selama minimal satu port hidup,
 * Chrome menunda pembunuhan service worker, jadi scheduler tidak sering
 * dingin-start. Port juga jadi sinyal tab hilang yang lebih cepat daripada
 * polling chrome.tabs.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ssn-keepalive") return;
  const tabId = port.sender?.tab?.id;
  if (tabId !== undefined) stateFor(tabId, { url: port.sender?.url, title: port.sender?.tab?.title });
  port.onDisconnect.addListener(() => {
    if (tabId !== undefined && tabs.delete(tabId)) {
      updateBadge();
      persistSoon();
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabs.delete(tabId)) {
    updateBadge();
    persistSoon();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await loadSettings();
  await syncAlarm();
  updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  await syncAlarm();
  updateBadge();
});

// Setiap kali worker bangun (termasuk dari alarm), pastikan settings termuat.
loadSettings()
  .then(() => Promise.all([syncAlarm(), rehydrate()]))
  .then(updateBadge)
  .catch((err) => console.warn("[SSN] init gagal:", err));

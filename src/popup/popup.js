import { KIND, MSG } from "../shared/common.js";

const $ = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

const TOGGLES = [
  "notifyOrders",
  "notifyChats",
  "onlyWhenHidden",
  "onlyOnIncrease",
  "requireInteraction",
  "soundEnabled",
  "showPanel",
];

let settings = null;

/** @param {any} msg */
const call = (msg) => chrome.runtime.sendMessage(msg);

/** @param {string} text */
function setStatus(text) {
  document.getElementById("status").textContent = text;
}

/** @param {unknown} err */
function errorText(err) {
  return String(err?.message || err || "Coba lagi.");
}

/** @param {any} res @param {"notifikasi"|"suara chat"} test */
function testStatus(res, test) {
  if (!res?.ok) return `Gagal mengirim tes ${test}: ${res?.error || "Coba lagi."}`;
  if (!res.audio?.ok) {
    return `Tes ${test} terkirim, tetapi suara gagal diputar: ${res.audio?.error || "Coba lagi."}`;
  }
  if (res.audio.skipped) return `Tes ${test} terkirim. Suara dinonaktifkan.`;
  return `Tes ${test} terkirim dan suara diputar.`;
}

function render(state) {
  settings = state.settings;
  const staleMs = Math.max(settings.pollSeconds, 30) * 3 * 1000;
  const now = Date.now();
  const profileLabel = document.getElementById("profile-label");
  profileLabel.hidden = !settings.profileLabel;
  profileLabel.textContent = settings.profileLabel ? `Profil: ${settings.profileLabel}` : "";
  $("enabled").checked = settings.enabled;
  setStatus(settings.enabled
    ? `Aktif · cek tiap ${settings.pollSeconds}s`
    : "Monitor dimatikan");
  for (const id of TOGGLES) $(id).checked = Boolean(settings[id]);

  $("volume").value = String(Math.round(settings.volume * 100));
  $("volume-val").textContent = `${Math.round(settings.volume * 100)}%`;
  $("pollSeconds").value = String(settings.pollSeconds);
  $("poll-val").textContent = `${settings.pollSeconds}s`;
  $("cooldownSeconds").value = String(settings.cooldownSeconds);
  $("cool-val").textContent = `${settings.cooldownSeconds}s`;

  const list = document.getElementById("tabs");
  list.textContent = "";
  document.getElementById("tab-count").textContent = String(state.tabs.length);
  if (!state.tabs.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Belum ada tab Seller Centre terbuka.";
    list.appendChild(li);
  }
  for (const t of state.tabs) {
    const total = Object.values(t.kinds).reduce((a, k) => a + (k.count || 0), 0);
    const stale = t.lastReportedAt > 0 && now - t.lastReportedAt > staleMs;
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = t.label || "Seller Centre";
    name.title = t.url || "";
    if (stale) {
      const staleSpan = document.createElement("span");
      staleSpan.className = "stale-dot";
      staleSpan.title = `Laporan terakhir: ${t.lastReportedAt ? new Date(t.lastReportedAt).toLocaleTimeString("id-ID") : "—"}`;
      name.prepend(staleSpan);
    }
    const num = document.createElement("span");
    num.className = total > 0 ? "num" : "num zero";
    num.textContent = String(total);
    // per-kind source pill
    const sources = [];
    if (t.kinds?.notif?.source) sources.push(`N:${t.kinds.notif.source}`);
    if (t.kinds?.chat?.source) sources.push(`C:${t.kinds.chat.source}`);
    const src = document.createElement("span");
    src.className = "src-pill";
    src.textContent = sources.join(" ");
    li.append(name, num);
    if (sources.length) li.append(src);
    li.addEventListener("click", () => {
      chrome.tabs.update(t.tabId, { active: true }).catch((err) => {
        setStatus(`Gagal membuka tab: ${errorText(err)}`);
      });
    });
    list.appendChild(li);
  }

  const s = state.stats || { notif: 0, chat: 0, lastAt: 0 };
  const when = s.lastAt ? new Date(s.lastAt).toLocaleTimeString("id-ID") : "—";
  document.getElementById("stats").textContent =
    `Terkirim: ${s.notif || 0} notifikasi · ${s.chat || 0} chat · terakhir ${when}`;
}

async function refresh() {
  const state = await call({ type: MSG.GET_STATE });
  if (!state?.settings) throw new Error(state?.error || "Status tidak tersedia.");
  render(state);
}

async function patch(p) {
  const res = await call({ type: MSG.SET_SETTINGS, patch: p });
  if (!res?.settings) throw new Error(res?.error || "Pengaturan tidak tersimpan.");
  settings = res.settings;
  await refresh();
}

/** @param {Record<string, unknown>} p */
function patchWithFeedback(p) {
  patch(p).catch(async (err) => {
    try {
      await refresh();
    } catch {
      // Tampilkan kegagalan penyimpanan asli bila status terbaru juga tidak tersedia.
    }
    setStatus(`Gagal menyimpan pengaturan: ${errorText(err)}`);
  });
}

/** @param {"notif"|"chat"} kind */
async function sendTest(kind) {
  const test = kind === KIND.CHAT ? "suara chat" : "notifikasi";
  try {
    const res = await call({ type: MSG.TEST, kind });
    setStatus(testStatus(res, test));
  } catch (err) {
    setStatus(`Gagal mengirim tes ${test}: ${errorText(err)}`);
  }
}

/* -------------------------------------------------------------- bindings ---- */

$("enabled").addEventListener("change", (e) => patchWithFeedback({ enabled: e.target.checked }));
for (const id of TOGGLES) $(id).addEventListener("change", (e) => patchWithFeedback({ [id]: e.target.checked }));

$("volume").addEventListener("input", (e) => {
  $("volume-val").textContent = `${e.target.value}%`;
});
$("volume").addEventListener("change", (e) => patchWithFeedback({ volume: Number(e.target.value) / 100 }));

$("pollSeconds").addEventListener("input", (e) => {
  $("poll-val").textContent = `${e.target.value}s`;
});
$("pollSeconds").addEventListener("change", (e) => patchWithFeedback({ pollSeconds: Number(e.target.value) }));

$("cooldownSeconds").addEventListener("input", (e) => {
  $("cool-val").textContent = `${e.target.value}s`;
});
$("cooldownSeconds").addEventListener("change", (e) => patchWithFeedback({ cooldownSeconds: Number(e.target.value) }));

document.getElementById("test-notif").addEventListener("click", () => sendTest(KIND.NOTIF));
document.getElementById("test-chat").addEventListener("click", () => sendTest(KIND.CHAT));
document.getElementById("reset").addEventListener("click", async () => {
  try {
    const res = await call({ type: MSG.RESET_BASELINE });
    if (!res?.ok) throw new Error(res?.error || "Baseline tidak dapat disetel ulang.");
    await refresh();
  } catch (err) {
    setStatus(`Gagal menyetel ulang baseline: ${errorText(err)}`);
  }
});

refresh().catch((err) => {
  setStatus(`Gagal memuat: ${errorText(err)}`);
});

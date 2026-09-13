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

function render(state) {
  settings = state.settings;
  $("enabled").checked = settings.enabled;
  $("status").textContent = settings.enabled
    ? `Aktif · cek tiap ${settings.pollSeconds}s`
    : "Monitor dimatikan";
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
    const total = Object.values(t.kinds).reduce((a, k) => a + k.count, 0);
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = t.label || "Seller Centre";
    name.title = t.url || "";
    const num = document.createElement("span");
    num.className = total > 0 ? "num" : "num zero";
    num.textContent = String(total);
    li.append(name, num);
    li.addEventListener("click", () => chrome.tabs.update(t.tabId, { active: true }));
    list.appendChild(li);
  }

  const s = state.stats || { notif: 0, chat: 0, lastAt: 0 };
  const when = s.lastAt ? new Date(s.lastAt).toLocaleTimeString("id-ID") : "—";
  document.getElementById("stats").textContent =
    `Terkirim: ${s.notif || 0} notifikasi · ${s.chat || 0} chat · terakhir ${when}`;
}

async function refresh() {
  const state = await call({ type: MSG.GET_STATE });
  if (state) render(state);
}

async function patch(p) {
  const res = await call({ type: MSG.SET_SETTINGS, patch: p });
  if (res?.settings) settings = res.settings;
  await refresh();
}

/* -------------------------------------------------------------- bindings ---- */

$("enabled").addEventListener("change", (e) => patch({ enabled: e.target.checked }));
for (const id of TOGGLES) $(id).addEventListener("change", (e) => patch({ [id]: e.target.checked }));

$("volume").addEventListener("input", (e) => {
  $("volume-val").textContent = `${e.target.value}%`;
});
$("volume").addEventListener("change", (e) => patch({ volume: Number(e.target.value) / 100 }));

$("pollSeconds").addEventListener("input", (e) => {
  $("poll-val").textContent = `${e.target.value}s`;
});
$("pollSeconds").addEventListener("change", (e) => patch({ pollSeconds: Number(e.target.value) }));

$("cooldownSeconds").addEventListener("input", (e) => {
  $("cool-val").textContent = `${e.target.value}s`;
});
$("cooldownSeconds").addEventListener("change", (e) => patch({ cooldownSeconds: Number(e.target.value) }));

document.getElementById("test-notif").addEventListener("click", () => call({ type: MSG.TEST, kind: KIND.NOTIF }));
document.getElementById("test-chat").addEventListener("click", () => call({ type: MSG.TEST, kind: KIND.CHAT }));
document.getElementById("reset").addEventListener("click", async () => {
  await call({ type: MSG.RESET_BASELINE });
  await refresh();
});

refresh().catch((err) => {
  document.getElementById("status").textContent = `Gagal memuat: ${err.message}`;
});

import { MSG } from "../shared/common.js";

const $ = (id) => document.getElementById(id);
const state = {
  settings: null,
  tabs: [],
  entries: [],
  loading: false,
  refreshPending: false,
  labelDirty: false,
};

/** @param {Record<string, unknown>} message */
const call = (message) => chrome.runtime.sendMessage(message);

/** @param {unknown} error */
function errorText(error) {
  return String(error?.message || error || "Coba lagi.");
}

/** @param {string} text @param {"info"|"error"|"success"} [tone] */
function setStatus(text, tone = "info") {
  const status = $("status");
  status.textContent = text;
  status.dataset.tone = tone === "info" ? "" : tone;
}

/** @param {number} at */
function formatTime(at) {
  if (!Number.isFinite(at) || at <= 0) return "Belum ada laporan";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(at));
}

/** @param {unknown} value */
function safeText(value, fallback = "—") {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

/** @param {unknown} value */
function countText(value) {
  return Number.isFinite(value) ? String(value) : "—";
}

function renderProfile() {
  if (!state.settings || state.labelDirty) return;
  $("profile-label").value = state.settings.profileLabel || "";
}

const STALE_MULTIPLIER = 3;

function isTabStale(tab, settings) {
  if (!tab.lastReportedAt) return false;
  const staleMs = Math.max((settings?.pollSeconds ?? 30), 30) * STALE_MULTIPLIER * 1000;
  return Date.now() - tab.lastReportedAt > staleMs;
}

function tabKind(tab, kind) {
  const raw = tab?.kinds?.[kind];
  return raw && typeof raw === "object" ? raw : {};
}

function appendMetric(parent, label, value, source) {
  const metric = document.createElement("span");
  metric.className = "metric";
  const strong = document.createElement("strong");
  strong.textContent = countText(value);
  metric.append(`${label} `, strong);
  if (source) metric.append(` · ${source}`);
  parent.append(metric);
}

function renderTabs() {
  const list = $("tab-list");
  list.textContent = "";
  $("tab-count").textContent = String(state.tabs.length);

  if (!state.tabs.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Belum ada tab Seller Centre yang terpantau.";
    list.append(empty);
    return;
  }

  for (const tab of state.tabs) {
    const row = document.createElement("article");
    row.className = "tab-row";
    if (isTabStale(tab, state.settings)) row.classList.add("tab-row--stale");

    const identity = document.createElement("div");
    const name = document.createElement("div");
    name.className = "tab-name";
    name.textContent = safeText(tab.label, "Seller Centre");
    if (isTabStale(tab, state.settings)) {
      const staleBadge = document.createElement("span");
      staleBadge.className = "stale-badge";
      staleBadge.title = `Tab tidak melapor lebih dari ${Math.max((state.settings?.pollSeconds ?? 30), 30) * STALE_MULTIPLIER} detik`;
      staleBadge.textContent = "Stale";
      name.append(" ", staleBadge);
    }
    const last = document.createElement("div");
    last.className = "tab-meta";
    last.textContent = `Laporan terakhir: ${formatTime(Number(tab.lastReportedAt))}`;
    identity.append(name, last);

    const counts = document.createElement("div");
    counts.className = "counts";
    const notif = tabKind(tab, "notif");
    const chat = tabKind(tab, "chat");
    appendMetric(counts, "Notifikasi", notif.count, safeText(notif.source, "").replace("—", ""));
    appendMetric(counts, "Chat", chat.count, safeText(chat.source, "").replace("—", ""));

    const focus = document.createElement("button");
    focus.className = "button button-secondary";
    focus.type = "button";
    focus.textContent = "Fokuskan tab";
    focus.setAttribute("aria-label", `Fokuskan tab ${safeText(tab.label, "Seller Centre")}`);
    focus.addEventListener("click", async () => {
      focus.disabled = true;
      try {
        const res = await call({ type: MSG.OPEN_TAB, tabId: tab.tabId });
        if (!res?.ok) throw new Error(res?.error || "Tab tidak tersedia.");
        setStatus("Tab Seller Centre difokuskan.", "success");
      } catch (error) {
        setStatus(`Gagal memfokuskan tab: ${errorText(error)}`, "error");
      } finally {
        focus.disabled = false;
      }
    });

    row.append(identity, counts, focus);
    list.append(row);
  }
}

/** @param {any} entry */
function entryMatches(entry) {
  const kind = $("kind-filter").value;
  if (kind !== "all" && entry.kind !== kind) return false;
  if ($("hide-tests").checked && entry.test) return false;
  const dateFrom = $("date-from").value;
  const dateTo = $("date-to").value;
  if (dateFrom) {
    const [fy, fm, fd] = dateFrom.split("-").map(Number);
    const from = new Date(fy, fm - 1, fd).getTime();
    if (!isNaN(from) && entry.at < from) return false;
  }
  if (dateTo) {
    const [ty, tm, td] = dateTo.split("-").map(Number);
    const to = new Date(ty, tm - 1, td + 1).getTime(); // awal hari berikutnya, inklusif hari td
    if (!isNaN(to) && entry.at >= to) return false;
  }
  const query = $("history-search").value.trim().toLocaleLowerCase("id-ID");
  if (!query) return true;
  return `${entry.label || ""} ${entry.profileLabel || ""}`.toLocaleLowerCase("id-ID").includes(query);
}

/** @param {any} entry */
function deliveryBadge(entry) {
  const badge = document.createElement("span");
  const sent = entry.delivery === "sent";
  badge.className = `badge ${sent ? "good" : "failure"}`;
  badge.textContent = sent ? "Terkirim" : "Gagal kirim";
  return badge;
}

/** @param {any} entry */
function audioBadge(entry) {
  const badge = document.createElement("span");
  if (entry.audio === "played") {
    badge.className = "badge good";
    badge.textContent = "Suara diputar";
  } else if (entry.audio === "off") {
    badge.className = "badge";
    badge.textContent = "Suara nonaktif";
  } else if (entry.audio === "failed") {
    badge.className = "badge failure";
    badge.textContent = "Suara gagal";
  } else {
    badge.className = "badge";
    badge.textContent = "Tanpa suara";
  }
  return badge;
}

function renderHistory() {
  const list = $("history-list");
  list.textContent = "";
  const entries = state.entries.filter(entryMatches);
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = state.entries.length
      ? "Tidak ada riwayat yang sesuai dengan filter."
      : "Belum ada notifikasi yang tercatat di riwayat lokal.";
    list.append(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("article");
    row.className = "history-row";
    const primary = document.createElement("div");
    const title = document.createElement("div");
    title.className = "history-title";
    const kind = document.createElement("span");
    kind.textContent = entry.kind === "chat" ? "Chat" : "Notifikasi";
    title.append(kind);
    if (entry.test) {
      const test = document.createElement("span");
      test.className = "badge test";
      test.textContent = "Tes";
      title.append(test);
    }
    title.append(deliveryBadge(entry), audioBadge(entry));
    const label = document.createElement("div");
    label.className = "history-label";
    const shop = safeText(entry.label, "Seller Centre");
    const profile = safeText(entry.profileLabel, "").replace("—", "");
    label.textContent = profile && profile !== shop ? `${shop} · Profil: ${profile}` : (profile || shop);
    const detail = document.createElement("div");
    detail.className = "history-detail";
    const details = [];
    if (entry.title) details.push(safeText(entry.title));
    if (Number.isFinite(entry.count)) details.push(`Jumlah: ${entry.count}`);
    if (entry.source) details.push(`Sumber: ${entry.source}`);
    if (entry.error) details.push(`Keterangan: ${entry.error}`);
    detail.textContent = details.join(" · ") || "Tidak ada detail tambahan.";
    primary.append(title, label, detail);

    const meta = document.createElement("div");
    meta.className = "history-time";
    meta.textContent = formatTime(Number(entry.at));

    const open = document.createElement("button");
    open.type = "button";
    open.className = "button button-secondary open-history";
    open.textContent = entry.canOpen ? "Buka asal" : "Asal tidak tersedia";
    open.disabled = !entry.canOpen;
    open.setAttribute("aria-label", entry.canOpen ? "Fokuskan tab asal kejadian" : "Tab asal kejadian sudah tidak tersedia");
    if (entry.canOpen) {
      open.addEventListener("click", async () => {
        open.disabled = true;
        try {
          const res = await call({ type: MSG.OPEN_HISTORY, id: entry.id });
          if (!res?.ok) throw new Error(res?.error || "Tab asal tidak tersedia.");
          setStatus("Tab asal kejadian difokuskan.", "success");
        } catch (error) {
          setStatus(`Gagal membuka asal kejadian: ${errorText(error)}`, "error");
          await refresh({ quiet: true });
        } finally {
          open.disabled = false;
        }
      });
    }
    row.append(primary, meta, open);
    list.append(row);
  }
}

function render() {
  renderProfile();
  renderTabs();
  renderHistory();
}

/** @param {{quiet?: boolean}} [options] */
async function refresh(options = {}) {
  const quiet = Boolean(options.quiet);
  if (state.loading) {
    state.refreshPending = true;
    return;
  }
  state.loading = true;
  $("refresh").disabled = true;
  $("history-error").hidden = true;
  if (!quiet) setStatus("Memuat data…");
  try {
    const [snapshot, history] = await Promise.all([
      call({ type: MSG.GET_STATE }),
      call({ type: MSG.GET_HISTORY }),
    ]);
    if (!snapshot?.settings) throw new Error(snapshot?.error || "Status pemantauan tidak tersedia.");
    if (!history?.ok) throw new Error(history?.error || "Riwayat tidak tersedia.");
    state.settings = snapshot.settings;
    state.tabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : [];
    state.entries = Array.isArray(history.entries) ? history.entries : [];
    render();
    if (!quiet) setStatus(`Data diperbarui. ${state.entries.length} dari maksimal 200 kejadian lokal dimuat.`, "success");
  } catch (error) {
    const message = `Gagal memuat data: ${errorText(error)}`;
    $("history-error").textContent = message;
    $("history-error").hidden = false;
    if (!quiet) setStatus(message, "error");
  } finally {
    state.loading = false;
    $("refresh").disabled = false;
    if (state.refreshPending) {
      state.refreshPending = false;
      void refresh({ quiet: true });
    }
  }
}

async function saveProfile(event) {
  event.preventDefault();
  const button = $("save-profile");
  button.disabled = true;
  const profileLabel = $("profile-label").value.trim().slice(0, 48);
  try {
    const res = await call({ type: MSG.SET_SETTINGS, patch: { profileLabel } });
    if (!res?.settings) throw new Error(res?.error || "Label tidak dapat disimpan.");
    state.settings = res.settings;
    state.labelDirty = false;
    renderProfile();
    setStatus(profileLabel ? "Label profil disimpan." : "Label dihapus; nama toko otomatis akan dipakai.", "success");
  } catch (error) {
    setStatus(`Gagal menyimpan label: ${errorText(error)}`, "error");
  } finally {
    button.disabled = false;
  }
}

async function clearHistory() {
  const button = $("confirm-clear");
  button.disabled = true;
  try {
    const res = await call({ type: MSG.CLEAR_HISTORY });
    if (!res?.ok) throw new Error(res?.error || "Riwayat tidak dapat dihapus.");
    $("clear-confirmation").hidden = true;
    state.entries = [];
    renderHistory();
    setStatus("Riwayat lokal dihapus. Pengaturan dan baseline tetap ada.", "success");
  } catch (error) {
    setStatus(`Gagal menghapus riwayat: ${errorText(error)}`, "error");
  } finally {
    button.disabled = false;
  }
}

$("refresh").addEventListener("click", refresh);
$("profile-form").addEventListener("submit", saveProfile);
$("profile-label").addEventListener("input", () => { state.labelDirty = true; });
$("clear-history").addEventListener("click", () => { $("clear-confirmation").hidden = false; });
$("cancel-clear").addEventListener("click", () => { $("clear-confirmation").hidden = true; });
$("confirm-clear").addEventListener("click", clearHistory);
$("kind-filter").addEventListener("change", renderHistory);
$("history-search").addEventListener("input", renderHistory);
$("hide-tests").addEventListener("change", renderHistory);
$("date-from").addEventListener("change", renderHistory);
$("date-to").addEventListener("change", renderHistory);
$("export-history").addEventListener("click", exportHistory);

/** Export visible (filtered) history entries as JSON download. */
function exportHistory() {
  const entries = state.entries.filter(entryMatches);
  if (!entries.length) {
    setStatus("Tidak ada riwayat yang sesuai filter untuk diekspor.", "error");
    return;
  }
  const payload = JSON.stringify(entries, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const ts = new Date().toISOString().slice(0, 10);
  a.download = `ssn-riwayat-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setStatus(`${entries.length} entri diekspor.`, "success");
}

chrome.storage?.onChanged?.addListener((changes, area) => {
  if ((area === "local" && (changes.settings || changes.history)) ||
      (area === "session" && changes.tabState)) refresh({ quiet: true });
});

refresh();

/**
 * E2E Chrome nyata untuk kontrak pengguna: push, audio, dedupe lintas restart
 * worker, dan feedback kegagalan. Jalankan fixture dulu: npm run fixture.
 *
 * Yang tidak disimulasikan: OS toast UI dan klik OS. chrome.notifications
 * di-spy setelah promise create benar-benar resolve; itu membuktikan API Chrome
 * menerima toast, bukan hanya bahwa worker mencoba mengirim pesan.
 */
import puppeteer from "puppeteer-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_BIN || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ORIGIN = "https://seller.shopee.co.id";
const PROFILE = mkdtempSync(join(tmpdir(), "ssn-e2e-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let fails = 0;
function check(name, condition, extra = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `  <- ${extra}`}`);
  if (!condition) fails++;
}

/** @param {() => Promise<boolean>} predicate */
async function eventually(predicate, timeoutMs = 8_000, intervalMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

const launchOptions = {
  executablePath: CHROME,
  headless: false,
  userDataDir: PROFILE,
  enableExtensions: [ROOT],
  args: [
    "--host-resolver-rules=MAP seller.shopee.co.id 127.0.0.1:8443",
    "--ignore-certificate-errors",
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1200,860",
  ],
};
let browser = await puppeteer.launch(launchOptions);

try {
  /** @returns {Promise<import('puppeteer-core').Target>} */
  async function workerTarget() {
    for (let i = 0; i < 100; i++) {
      const target = browser
        .targets()
        .find((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
      if (target) return target;
      await sleep(100);
    }
    throw new Error("service worker tidak ditemukan");
  }

  let target = await workerTarget();
  let worker = await target.worker();
  const extId = new URL(target.url()).host;

  // Pesan ke runtime harus berasal dari konteks ekstensi lain. Mengirim dari
  // worker ke dirinya sendiri tidak memicu runtime.onMessage di Chrome.
  const control = await browser.newPage();
  await control.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: "domcontentloaded" });
  const runtimeCall = (message) => control.evaluate((m) => chrome.runtime.sendMessage(m), message);

  /** Pasang spy yang hanya mencatat create/audio yang benar-benar sukses. */
  async function armWorkerSpy() {
    target = await workerTarget();
    worker = await target.worker();
    await worker.evaluate(() => {
      globalThis.__e2e = { notifications: [], sounds: [], failNextCreate: false };
      const realCreate = chrome.notifications.create.bind(chrome.notifications);
      chrome.notifications.create = async (...args) => {
        if (globalThis.__e2e.failNextCreate) {
          globalThis.__e2e.failNextCreate = false;
          throw new Error("simulasi Chrome menolak toast");
        }
        const result = await realCreate(...args);
        const [id, options] = args;
        globalThis.__e2e.notifications.push({ id, title: options.title, message: options.message });
        return result;
      };
      const realSend = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (message, ...rest) => {
        const result = await realSend(message, ...rest);
        if (message?.target === "offscreen" && message.type === "play" && result?.ok) {
          globalThis.__e2e.sounds.push({ kind: message.kind, volume: message.volume });
        }
        return result;
      };
    });
  }
  await armWorkerSpy();
  const seen = () => worker.evaluate(() => globalThis.__e2e);
  const clearSeen = () => worker.evaluate(() => {
    globalThis.__e2e.notifications = [];
    globalThis.__e2e.sounds = [];
  });
  const call = runtimeCall;

  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  const setFocus = (enabled) => cdp.send("Emulation.setFocusEmulationEnabled", { enabled });
  await page.goto(`${ORIGIN}/portal/sale`, { waitUntil: "domcontentloaded" });
  await sleep(1_200);

  const other = await browser.newPage();
  await other.goto("data:text/html,<title>tab lain</title>x");
  await other.bringToFront();
  await sleep(400);

  /* ------------------------------------ TEST: toast sukses + audio sukses ---- */
  await clearSeen();
  const testResult = await call({ type: "test", kind: "notif" });
  const sent = await eventually(async () => (await seen()).notifications.length === 1);
  const first = await seen();
  check("TEST membuat toast Chrome", sent, JSON.stringify(first));
  check("TEST mengembalikan audio sukses", testResult?.ok === true && testResult.audio?.ok === true, JSON.stringify(testResult));
  check("audio dicatat hanya setelah respons offscreen sukses", first.sounds.some((s) => s.kind === "notif"), JSON.stringify(first.sounds));

  /* ------------------------ offscreen tertutup -> TEST membuat ulang audio ---- */
  await worker.evaluate(() => chrome.offscreen.closeDocument());
  const closed = await eventually(async () => {
    const contexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }));
    return contexts.length === 0;
  });
  if (!closed) throw new Error("Prasyarat pengujian audio: dokumen offscreen belum ditutup");
  await clearSeen();
  const afterClose = await call({ type: "test", kind: "chat" });
  const afterCloseSeen = await seen();
  check("TEST sesudah close memutar suara chat", afterClose?.audio?.ok === true && afterCloseSeen.sounds.some((s) => s.kind === "chat"), JSON.stringify(afterClose));

  /* ---------------- create gagal -> respons jujur -> retry sukses tanpa spam ---- */
  await worker.evaluate(() => (globalThis.__e2e.failNextCreate = true));
  const failedTest = await call({ type: "test", kind: "notif" });
  check("TEST mengembalikan error saat Chrome menolak toast", failedTest?.ok === false && /menolak toast/.test(failedTest.error || ""), JSON.stringify(failedTest));
  await clearSeen();
  const retryTest = await call({ type: "test", kind: "notif" });
  const retrySeen = await seen();
  check("TEST dapat retry setelah toast gagal", retryTest?.ok === true && retrySeen.notifications.length === 1, JSON.stringify(retryTest));

  /* ------------------- REPORT DOM di background + dedupe setelah restart worker ---- */
  await page.evaluate(() => document.getElementById("b-clear").click());
  await sleep(500);
  await call({ type: "reset-baseline" });
  await page.evaluate(() => document.getElementById("b-clear").click());
  await sleep(500);
  await clearSeen();
  await page.evaluate(() => document.getElementById("b-notif").click());
  const firstPush = await eventually(async () => (await seen()).notifications.some((n) => /Notifikasi baru/.test(n.title)));
  const beforeRestart = await seen();
  check("badge baru di tab background menghasilkan push", firstPush, JSON.stringify(beforeRestart));

  // Uji respons setelah Runtime.terminateExecution, tanpa reload ekstensi.
  // Command ini menghentikan eksekusi, bukan jaminan worker baru dibuat.
  // Karena itu skenario ini TIDAK membuktikan cold-start dari storage.session.
  const oldTarget = target;
  const workerSession = await oldTarget.createCDPSession();
  await workerSession.send("Runtime.terminateExecution");
  const recovery = control;
  const restored = await recovery.evaluate(() => chrome.runtime.sendMessage({ type: "get-state" }));
  check("pesan setelah terminate mempertahankan nama toko", restored.tabs?.some((t) => /Toko Sepatu Jaya/.test(t.label)), JSON.stringify(restored.tabs));
  check("pesan setelah terminate mempertahankan unread", restored.tabs?.some((t) => t.kinds.notif?.count === 1), JSON.stringify(restored.tabs));

  const tabId = restored.tabs?.find((t) => /Toko Sepatu Jaya/.test(t.label))?.tabId;
  if (!Number.isInteger(tabId)) throw new Error("tab Seller Centre tidak ada setelah restart worker");

  // Paksa content script nyata melakukan probe. Count DOM masih 1, jadi tidak
  // boleh ada push kedua setelah state dipulihkan.
  await clearSeen();
  await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "probe-now" }), tabId);
  await sleep(500);
  check("count sama sesudah terminate tidak push ulang", (await seen()).notifications.length === 0, JSON.stringify(await seen()));

  // Count lebih tinggi dari fixture nyata sesudah restart harus tetap push.
  // Tunggu melewati cooldown default 5s dari push sebelum restart; yang diuji
  // di sini dedupe persistence, bukan throttle anti-spam.
  await sleep(5_200);
  await clearSeen();
  await page.evaluate(() => document.getElementById("b-notif").click());
  const higherPush = await eventually(async () => (await seen()).notifications.some((n) => /Notifikasi baru/.test(n.title)));
  check("count lebih tinggi sesudah terminate tetap push", higherPush, JSON.stringify(await seen()));

  /* -------------------- tab aktif menekan toast, bukan baseline berikutnya ---- */
  await page.bringToFront();
  await setFocus(true);
  await sleep(5_200);
  await clearSeen();
  await page.evaluate(() => document.getElementById("b-notif").click());
  await sleep(1_200);
  check("tab terlihat tidak menerima toast", (await seen()).notifications.length === 0, JSON.stringify(await seen()));
  await setFocus(false);

  /* ----------------------------------------- settings serial tanpa lost update ---- */
  const [a, b] = await Promise.all([
    call({ type: "set-settings", patch: { volume: 0.35 } }),
    call({ type: "set-settings", patch: { cooldownSeconds: 45 } }),
  ]);
  const configured = await call({ type: "get-state" });
  check("dua perubahan settings paralel keduanya tersimpan", a?.settings?.volume === 0.35 && b?.settings?.cooldownSeconds === 45 && configured.settings.volume === 0.35 && configured.settings.cooldownSeconds === 45, JSON.stringify(configured.settings));
  check("TEST dari halaman ekstensi tidak membuat toko palsu", configured.tabs.length === 1 && configured.tabs[0].tabId === tabId, JSON.stringify(configured.tabs));

  /* ---------------------------------------------------- popup feedback nyata ---- */
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: "domcontentloaded" });
  await popup.click("#test-notif");
  const feedback = await eventually(async () => /terkirim dan suara diputar|Suara dinonaktifkan/.test(await popup.$eval("#status", (el) => el.textContent)));
  check("popup menunjukkan hasil TEST aktual", feedback, await popup.$eval("#status", (el) => el.textContent));

  // History is local, bounded, and records attempts rather than every probe.
  const priorState = await call({ type: "get-state" });
  await call({ type: "clear-history" });
  const getHistory = () => call({ type: "get-history" });
  const afterClearState = await call({ type: "get-state" });
  check("menghapus riwayat tidak mengubah statistik atau baseline", 
    JSON.stringify(priorState.stats) === JSON.stringify(afterClearState.stats) &&
    JSON.stringify(priorState.tabs.map((t) => [t.tabId, t.kinds.notif?.count])) ===
      JSON.stringify(afterClearState.tabs.map((t) => [t.tabId, t.kinds.notif?.count])));
  await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "probe-now" }), tabId);
  await sleep(600);
  check("probe tanpa perubahan tidak mengisi riwayat", (await getHistory()).entries.length === 0);

  await call({ type: "set-settings", patch: { profileLabel: "  Gudang Barat  ", soundEnabled: false } });
  const taggedTest = await call({ type: "test", kind: "chat" });
  let history = await getHistory();
  const taggedEntry = history.entries.find((entry) => entry.id === taggedTest.id);
  check("label profil muncul di toast dan riwayat dengan suara off",
    taggedEntry?.profileLabel === "Gudang Barat" && taggedEntry.title.startsWith("[Gudang Barat] ") &&
    taggedEntry.audio === "off" && taggedEntry.test && !taggedEntry.canOpen &&
    (await seen()).notifications.some((n) => n.id === taggedTest.id && n.title === taggedEntry.title), JSON.stringify(taggedEntry));
  check("riwayat publik tidak membocorkan URL dan identitas sesi internal",
    history.entries.every((entry) => !["url", "body", "tabId", "sessionId", "trackerId"].some((key) => key in entry)));

  const statsBeforeFailure = (await call({ type: "get-state" })).stats;
  await worker.evaluate(() => (globalThis.__e2e.failNextCreate = true));
  await call({ type: "test", kind: "notif" });
  const failedEntry = (await getHistory()).entries[0];
  check("toast gagal dicatat tanpa menambah statistik terkirim",
    failedEntry.delivery === "failed" && /menolak toast/.test(failedEntry.error) &&
    JSON.stringify(statsBeforeFailure) === JSON.stringify((await call({ type: "get-state" })).stats));

  await call({ type: "set-settings", patch: { profileLabel: "Gudang Timur", cooldownSeconds: 0 } });
  await other.bringToFront();
  await page.evaluate(() => document.getElementById("b-notif").click());
  const reportInHistory = await eventually(async () => (await getHistory()).entries.some((e) => !e.test && e.count === 4));
  history = await getHistory();
  const liveEntry = history.entries.find((e) => !e.test && e.count === 4);
  check("riwayat menjaga label lama dan mencatat toko asal terbaru",
    reportInHistory && liveEntry?.profileLabel === "Gudang Timur" && liveEntry.canOpen &&
    history.entries.find((e) => e.id === taggedTest.id)?.profileLabel === "Gudang Barat", JSON.stringify(history.entries));
  const opened = await call({ type: "open-history", id: liveEntry.id });
  const sourceTab = await worker.evaluate((id) => chrome.tabs.get(id), tabId);
  check("riwayat membuka tab toko yang masih tersedia", opened.ok && sourceTab.active);

  // Populate local storage at retention boundary rather than emitting 201 OS toasts.
  const stored = await control.evaluate(() => chrome.storage.local.get("history"));
  const seed = stored.history[0];
  await control.evaluate((entries) => chrome.storage.local.set({ history: [
    { ...entries[0], id: "previous-session", sessionId: "expired-session" }, ...entries,
  ] }), stored.history);
  const expiredOpen = await call({ type: "open-history", id: "previous-session" });
  check("riwayat sesi lama tidak membuka tab meski ID tab masih ada",
    !expiredOpen.ok && !(await getHistory()).entries.find((e) => e.id === "previous-session").canOpen);
  await control.evaluate((entry) => chrome.storage.local.set({
    history: Array.from({ length: 200 }, (_, i) => ({ ...entry, id: `retention-${i}`, at: entry.at - i })),
  }), seed);
  const boundaryTest = await call({ type: "test", kind: "chat" });
  const bounded = await getHistory();
  check("riwayat membatasi 200 terbaru dan membuang entri tertua",
    bounded.limit === 200 && bounded.entries.length === 200 && bounded.entries[0].id === boundaryTest.id &&
    !bounded.entries.some((e) => e.id === "retention-199"));
  await control.evaluate((entries) => chrome.storage.local.set({ history: entries }), stored.history);

  const dashboardUrl = await popup.$eval(".dashboard-link", (el) => el.href);
  await popup.bringToFront();
  const dashboardTarget = browser.waitForTarget((t) => t.url() === dashboardUrl, { timeout: 10_000 });
  dashboardTarget.catch(() => {});
  await popup.click(".dashboard-link");
  const dashboard = await (await dashboardTarget).page();
  await dashboard.setViewport({ width: 1100, height: 850 });
  await dashboard.waitForSelector(".history-row");
  await dashboard.select("#kind-filter", "chat");
  check("dashboard memfilter chat tanpa baris notifikasi", await dashboard.$$eval(".history-row", (rows) =>
    rows.length === 1 && rows[0].querySelector(".history-title").textContent.startsWith("Chat")));
  await dashboard.click("#hide-tests");
  check("dashboard menyembunyikan notifikasi tes", await dashboard.$$eval(".history-row", (rows) => rows.length === 0));
  await dashboard.select("#kind-filter", "all");
  await dashboard.type("#history-search", "Gudang Timur");
  check("pencarian profil menampilkan kejadian toko sebenarnya", await dashboard.$$eval(".history-row", (rows) =>
    rows.length === 1 && rows[0].textContent.includes("Gudang Timur") && !rows[0].querySelector(".test")));
  await dashboard.$eval("#history-search", (el) => { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await dashboard.click("#hide-tests");
  await dashboard.$eval("#profile-label", (el) => { el.value = "<Toko & Aman>"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await dashboard.click("#save-profile");
  check("form dashboard menyimpan label literal bukan markup", await eventually(async () =>
    (await call({ type: "get-state" })).settings.profileLabel === "<Toko & Aman>"));
  const literalTest = await call({ type: "test", kind: "chat" });
  await dashboard.click("#refresh");
  await eventually(async () => await dashboard.$$eval(".history-row", (rows) => rows.some((r) => r.textContent.includes("<Toko & Aman>"))));
  check("riwayat merender label berkarakter HTML sebagai teks", await dashboard.$$eval(".history-row", (rows) =>
    rows.some((row) => row.textContent.includes("<Toko & Aman>") && !row.querySelector("toko"))));
  await dashboard.screenshot({ path: join(ROOT, "tools", "dashboard.png"), fullPage: true });
  await dashboard.setViewport({ width: 340, height: 760 });
  check("dashboard tidak meluber pada lebar 340px", await dashboard.evaluate(() =>
    document.documentElement.scrollWidth <= innerWidth));
  await dashboard.screenshot({ path: join(ROOT, "tools", "dashboard-mobile.png"), fullPage: true });
  await dashboard.$eval("#profile-label", (el) => { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await dashboard.click("#save-profile");
  check("label profil dapat dikosongkan lewat dashboard", await eventually(async () =>
    (await call({ type: "get-state" })).settings.profileLabel === ""));
  await dashboard.click("#clear-history");
  await dashboard.click("#cancel-clear");
  check("batal hapus mempertahankan riwayat", (await getHistory()).entries.some((e) => e.id === literalTest.id));

  // Isolate event delivery from fallback polling. Clear the worker alarm and
  // move the local next poll far away; mutation/API callbacks must still report.
  await call({ type: "set-settings", patch: { cooldownSeconds: 0, pollSeconds: 300 } });
  await other.bringToFront();
  await sleep(800);
  await worker.evaluate(() => chrome.alarms.clear("poll"));
  await page.evaluate(() => document.getElementById("b-clear").click());
  await sleep(300);
  await call({ type: "reset-baseline" });
  await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "probe-now" }), tabId);
  await eventually(async () => {
    const state = await call({ type: "get-state" });
    return state.tabs.find((tab) => tab.tabId === tabId)?.kinds?.chat?.count === 0;
  });
  await clearSeen();
  await page.evaluate(() => {
    const badge = document.getElementById("chat-badge");
    badge.textContent = "1";
    badge.classList.remove("hidden");
  });
  check("badge chat background dikirim tanpa menunggu alarm", await eventually(async () =>
    (await getHistory()).entries.some((entry) => !entry.test && entry.kind === "chat" && entry.source === "dom" && entry.count === 1), 2500));
  await page.evaluate(() => { document.getElementById("chat-badge").textContent = "2"; });
  check("perubahan text node badge langsung terdeteksi", await eventually(async () =>
    (await getHistory()).entries.some((entry) => !entry.test && entry.kind === "chat" && entry.source === "dom" && entry.count === 2), 2500));
  await page.evaluate(async () => {
    await fetch("/api/reset");
    for (let i = 0; i < 3; i++) await fetch("/api/webchat/unread?bump=1").then((r) => r.json());
  });
  check("sinyal API chat dikirim tanpa menunggu alarm", await eventually(async () =>
    (await getHistory()).entries.some((entry) => !entry.test && entry.kind === "chat" && entry.source === "api" && entry.count === 3), 2500));
  await call({ type: "set-settings", patch: { cooldownSeconds: 5 } });

  // Pesan beruntun dari pembeli: unread naik cepat, lalu naik lagi setelah jeda.
  await call({ type: "clear-history" });
  // Jeda dihitung dari notifikasi chat sebelumnya, bukan dari isi riwayat.
  await sleep(5_200);
  await page.evaluate(async () => {
    await fetch("/api/webchat/unread?bump=1").then((r) => r.json());
    await fetch("/api/webchat/unread?bump=1").then((r) => r.json());
  });
  const burstSeen = await eventually(async () => (await getHistory()).entries.length >= 1, 4_000);
  await sleep(1_500);
  const burst = await getHistory();
  check("chat beruntun dalam jeda hanya satu notifikasi", burstSeen && burst.entries.length === 1 && burst.entries[0].kind === "chat",
    JSON.stringify(burst.entries.map((e) => [e.kind, e.count])));
  await sleep(5_200);
  await page.evaluate(() => fetch("/api/webchat/unread?bump=1").then((r) => r.json()));
  check("chat berikutnya sesudah jeda tetap diberi tahu", await eventually(async () => {
    const entries = (await getHistory()).entries;
    return entries.length === 2 && entries[0].kind === "chat" && entries[0].count > burst.entries[0].count;
  }, 4_000));

  const closableEntry = (await getHistory()).entries.find((entry) => !entry.test && entry.canOpen);
  if (!closableEntry) throw new Error("Prasyarat: riwayat chat live tidak tersedia untuk uji tab tertutup");

  await page.close();
  const staleOpen = await call({ type: "open-history", id: closableEntry.id });
  check("riwayat tab tertutup menolak navigasi tanpa membuka tab lain",
    staleOpen.ok === false && (await getHistory()).entries.find((e) => e.id === closableEntry.id)?.canOpen === false);

  await dashboard.bringToFront();
  await dashboard.click("#clear-history");
  await dashboard.click("#confirm-clear");
  check("konfirmasi hapus mengosongkan riwayat lokal", await eventually(async () => (await getHistory()).entries.length === 0));

  await popup.setViewport({ width: 340, height: 760 });
  await popup.screenshot({ path: join(ROOT, "tools", "popup.png"), fullPage: true });

} finally {
  // Chrome can keep extension contexts alive past Puppeteer's graceful close.
  // This browser belongs only to this harness, so cap graceful shutdown and
  // terminate its owned process rather than leaving a false test timeout.
  const chromeProcess = browser.process();
  const closeResult = await Promise.race([
    browser.close().then(() => true).catch(() => false),
    sleep(8_000).then(() => false),
  ]);
  if (!closeResult && chromeProcess && !chromeProcess.killed) {
    chromeProcess.kill("SIGKILL");
    try {
      browser.disconnect();
    } catch {
      /* connection may already be gone */
    }
  }
  // Windows can hold a temporary-profile file while a forcibly terminated
  // Chrome child exits. Only remove it after graceful close; abandoned temp
  // profiles are OS-cleanable and must not block test completion.
  if (closeResult) rmSync(PROFILE, { recursive: true, force: true });
  console.log(fails ? `\n${fails} test e2e gagal` : "\nsemua test e2e lolos");
  process.exit(fails ? 1 : 0);
}

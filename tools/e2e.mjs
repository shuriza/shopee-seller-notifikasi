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

const browser = await puppeteer.launch({
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
});

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
  check("service worker ekstensi hidup", Boolean(worker));

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
  check("hook MAIN-world dan panel terpasang", await page.evaluate(() => Boolean(window.__ssn_hooked__ && document.querySelector(".ssn-panel"))));

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
  await clearSeen();
  const afterClose = await call({ type: "test", kind: "chat" });
  const recreated = await eventually(async () => {
    const contexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }));
    return contexts.length === 1;
  });
  const afterCloseSeen = await seen();
  check("dokumen audio berhasil ditutup untuk simulasi", closed);
  check("TEST sesudah close membuat ulang dokumen audio", recreated);
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
  await popup.setViewport({ width: 340, height: 760 });
  await popup.screenshot({ path: join(ROOT, "tools", "popup.png"), fullPage: true });
  await page.bringToFront();
  await page.click(".ssn-panel [data-test]");
  await eventually(async () => /dikirim dan suara diputar/.test(await page.$eval("[data-hint]", (el) => el.textContent)));
  await page.screenshot({ path: join(ROOT, "tools", "panel.png") });
} finally {
  await browser.close();
  rmSync(PROFILE, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} test e2e gagal` : "\nsemua test e2e lolos");
process.exit(fails ? 1 : 0);

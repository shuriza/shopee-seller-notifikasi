/**
 * Uji end-to-end: jalankan Chrome sungguhan dengan ekstensi ter-load, arahkan
 * seller.shopee.co.id ke fixture HTTPS lokal, picu badge/API, dan periksa bahwa
 * service worker benar-benar membuat notifikasi + memutar audio.
 *
 * chrome.notifications tidak bisa diintip dari luar, jadi API-nya di-instrumen
 * di dalam service worker (spy tipis) dan hasilnya dibaca lewat CDP.
 *
 * Jalankan: node tools/e2e.mjs   (fixture harus sudah hidup di :8443)
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

let fails = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  <- " + extra}`);
  if (!cond) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  userDataDir: PROFILE,
  // Chrome 137+ mencabut --load-extension/--disable-extensions-except dari build
  // bermerek Chrome; enableExtensions memakai jalur CDP Extensions.loadUnpacked.
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
  /* ---------------------------------------- temukan service worker ekstensi ---- */
  let swTarget = null;
  for (let i = 0; i < 60 && !swTarget; i++) {
    swTarget = browser
      .targets()
      .find((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
    if (!swTarget) await sleep(250);
  }
  check("service worker ekstensi hidup", Boolean(swTarget), "tidak ditemukan");
  if (!swTarget) throw new Error("service worker tidak ditemukan");

  const extId = new URL(swTarget.url()).host;
  console.log("      ext id:", extId);
  const sw = await swTarget.worker();

  /* --------------------------------------------------- pasang spy notifikasi ---- */
  await sw.evaluate(() => {
    globalThis.__seen = { notifs: [], sounds: [] };
    const origCreate = chrome.notifications.create.bind(chrome.notifications);
    chrome.notifications.create = (id, opts, cb) => {
      globalThis.__seen.notifs.push({ id, title: opts.title, message: opts.message, silent: opts.silent });
      return origCreate(id, opts, cb);
    };
    const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg, ...rest) => {
      if (msg && msg.target === "offscreen" && msg.type === "play") {
        globalThis.__seen.sounds.push({ kind: msg.kind, volume: msg.volume });
      }
      return origSend(msg, ...rest);
    };
  });

  const seen = () => sw.evaluate(() => globalThis.__seen);
  const clear = () => sw.evaluate(() => ((globalThis.__seen = { notifs: [], sounds: [] }), true));

  /* ------------------------------------------------------------ buka fixture ---- */
  const page = await browser.newPage();
  // Window Chrome yang dikendalikan otomatis sering kehilangan fokus OS, sehingga
  // document.hasFocus() false walau tab di depan. Emulasi fokus dinyalakan HANYA
  // saat skenario menuntut "seller sedang menatap tab"; kalau dibiarkan menyala,
  // tab background pun terlihat fokus dan seluruh uji push jadi salah.
  const cdp = await page.createCDPSession();
  const setFocus = (enabled) => cdp.send("Emulation.setFocusEmulationEnabled", { enabled });
  await page.goto(ORIGIN + "/portal/sale", { waitUntil: "domcontentloaded" });
  await sleep(1500);

  check("hook MAIN world terpasang", await page.evaluate(() => Boolean(window.__ssn_hooked__)));
  check("panel in-page tampil", (await page.$(".ssn-panel")) !== null);
  check(
    "tombol tes ada di panel",
    await page.$eval(".ssn-panel [data-test]", (b) => b.textContent.includes("Notifikasi Tes")),
  );

  /* ------------------------------------------ 1) tombol "Kirim Notifikasi Tes" ---- */
  await clear();
  await page.click(".ssn-panel [data-test]");
  await sleep(1200);
  let s = await seen();
  check("tombol tes membuat notifikasi", s.notifs.length === 1, JSON.stringify(s.notifs));
  check("notifikasi tes memutar suara notif", s.sounds.some((x) => x.kind === "notif"), JSON.stringify(s.sounds));
  check(
    "judul notifikasi memuat nama toko",
    /Toko Sepatu Jaya/.test(s.notifs[0]?.title || ""),
    s.notifs[0]?.title,
  );
  check("notifikasi silent (audio ditangani ekstensi)", s.notifs[0]?.silent === true, String(s.notifs[0]?.silent));

  /* --------------------------------------------------- 2) tombol tes suara chat ---- */
  await clear();
  await page.click(".ssn-panel [data-test-chat]");
  await sleep(1200);
  s = await seen();
  check("tes chat memakai suara chat (beda dari notif)", s.sounds.some((x) => x.kind === "chat"), JSON.stringify(s.sounds));

  /* ---------------------------------- 3) badge DOM saat tab tidak terlihat lagi ---- */
  // Tab kedua di depan -> tab Seller Centre jadi hidden, sesuai skenario asli.
  const other = await browser.newPage();
  await other.goto("data:text/html,<title>tab lain</title><h1>tab lain</h1>");
  await other.bringToFront();
  await sleep(800);

  await clear();
  await page.evaluate(() => document.getElementById("b-notif").click());
  await sleep(2500);
  s = await seen();
  check(
    "badge notifikasi baru di tab background -> push",
    s.notifs.some((n) => /Notifikasi baru/i.test(n.title)),
    JSON.stringify(s.notifs),
  );
  check("suara notif diputar", s.sounds.some((x) => x.kind === "notif"), JSON.stringify(s.sounds));

  await clear();
  await page.evaluate(() => document.getElementById("b-chat").click());
  await sleep(2500);
  s = await seen();
  check(
    "badge chat baru -> push chat",
    s.notifs.some((n) => /Chat baru/i.test(n.title)),
    JSON.stringify(s.notifs),
  );
  check("suara chat diputar untuk chat", s.sounds.some((x) => x.kind === "chat"), JSON.stringify(s.sounds));

  /* ---------------------------------------------- 4) hook API (angka dari JSON) ---- */
  // Reset dulu supaya kenaikan benar-benar berasal dari respons API, bukan sisa
  // hitungan badge DOM dari langkah sebelumnya. Jeda melampaui cooldown 5s:
  // tanpa itu notifikasi chat dari langkah 3 masih menahan yang berikutnya.
  await page.evaluate(() => document.getElementById("b-clear").click());
  await sleep(7000);
  await clear();
  await page.evaluate(() => document.getElementById("b-api-chat").click());
  await sleep(3000);
  s = await seen();
  check(
    "unread dari respons API terdeteksi",
    s.notifs.some((n) => /Chat baru/i.test(n.title)),
    JSON.stringify(s),
  );

  /* --------------------------------------------------- 5) tab aktif tidak spam ---- */
  await page.bringToFront();
  await setFocus(true);
  await sleep(600);
  await clear();
  await page.evaluate(() => document.getElementById("b-notif").click());
  await sleep(2500);
  s = await seen();
  check("tab aktif: tidak push (onlyWhenHidden)", s.notifs.length === 0, JSON.stringify(s.notifs));
  check(
    "halaman benar-benar terlihat & fokus saat diuji",
    JSON.stringify(await page.evaluate(() => [document.visibilityState, document.hasFocus()])) ===
      '["visible",true]',
  );
  await setFocus(false);

  /* ------------------------------------------------------ 6) monitor dimatikan ---- */
  await other.bringToFront();
  await sleep(400);
  await page.evaluate(() => document.querySelector(".ssn-panel [data-toggle]").click());
  await sleep(800);
  await clear();
  await page.evaluate(() => document.getElementById("b-notif").click());
  await sleep(2500);
  s = await seen();
  check("monitor off: tidak ada push", s.notifs.length === 0, JSON.stringify(s.notifs));

  await page.evaluate(() => document.querySelector(".ssn-panel [data-toggle]").click());
  // Setelah dinyalakan, badge yang menumpuk selama monitor mati langsung
  // menyusul; jeda cooldown dihormati sebelum memicu pesanan berikutnya.
  await sleep(1500);
  await clear();
  await sleep(6000);
  await page.evaluate(() => document.getElementById("b-notif").click());
  await sleep(3000);
  s = await seen();
  check("monitor on lagi: push kembali", s.notifs.length >= 1, JSON.stringify(s.notifs));

  /* ---------------------------------------------------------- 7) offscreen doc ---- */
  const hasOffscreen = browser.targets().some((t) => t.url().includes("offscreen.html"));
  check("offscreen audio document dibuat", hasOffscreen);

  /* ------------------------------------------------------------- 8) popup UI ---- */
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`, { waitUntil: "domcontentloaded" });
  await sleep(1200);
  const status = await popup.$eval("#status", (el) => el.textContent);
  check("popup memuat status", /Aktif|dimatikan/i.test(status), status);
  const tabRows = await popup.$$eval("#tabs li", (els) => els.map((e) => e.textContent));
  check(
    "popup mendaftar tab dengan nama toko",
    tabRows.some((t) => /Toko Sepatu Jaya/.test(t)),
    JSON.stringify(tabRows),
  );
  const stats = await popup.$eval("#stats", (el) => el.textContent);
  check("popup menampilkan hitungan terkirim", /Terkirim: [1-9]/.test(stats), stats);
  await popup.screenshot({ path: join(ROOT, "tools", "popup.png") });
  console.log("      screenshot popup: tools/popup.png");
  await page.bringToFront();
  await page.screenshot({ path: join(ROOT, "tools", "panel.png") });
  console.log("      screenshot panel: tools/panel.png");
} finally {
  await browser.close();
  rmSync(PROFILE, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} test e2e gagal` : "\nsemua test e2e lolos");
process.exit(fails ? 1 : 0);

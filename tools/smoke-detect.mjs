// Smoke test logika deteksi. Jalankan: node tools/smoke-detect.mjs
import { applyReading, createState, normalizeCount, totalUnread } from "../src/shared/detect.js";

const OPTS = { onlyOnIncrease: true, cooldownSeconds: 5, notifyOrders: true, notifyChats: true };
let fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  <- " + extra}`);
  if (!cond) fail++;
};

// 1. Pembacaan pertama = baseline, tidak boleh berisik saat halaman dibuka.
{
  const st = createState();
  const r = applyReading(st, { kind: "notif", count: 7, source: "dom" }, OPTS, 1000);
  check("baseline tidak memicu notifikasi", r.event === null && r.reason === "baseline", r.reason);
}

// 2. Naik -> memicu; turun (dibaca seller) -> senyap; naik lagi -> memicu.
{
  const st = createState();
  applyReading(st, { kind: "notif", count: 2, source: "dom" }, OPTS, 0);
  const up = applyReading(st, { kind: "notif", count: 5, source: "dom" }, OPTS, 10_000);
  const down = applyReading(st, { kind: "notif", count: 0, source: "dom" }, OPTS, 20_000);
  const again = applyReading(st, { kind: "notif", count: 1, source: "dom" }, OPTS, 30_000);
  check("kenaikan memicu notifikasi", up.event?.count === 5 && up.event.prev === 2, up.reason);
  check("penurunan senyap", down.event === null && down.reason === "decreased", down.reason);
  check("naik lagi dari nol memicu", again.event?.count === 1, again.reason);
}

// 3. Cooldown menahan banjir notifikasi berturut-turut.
{
  const st = createState();
  applyReading(st, { kind: "chat", count: 1, source: "api" }, OPTS, 0);
  const a = applyReading(st, { kind: "chat", count: 2, source: "api" }, OPTS, 1_000);
  const b = applyReading(st, { kind: "chat", count: 3, source: "api" }, OPTS, 2_000);
  const c = applyReading(st, { kind: "chat", count: 4, source: "api" }, OPTS, 9_000);
  check("chat pertama memicu", a.event !== null, a.reason);
  check("chat dalam cooldown ditahan", b.event === null && b.reason === "cooldown", b.reason);
  check("chat setelah cooldown memicu", c.event?.count === 4, c.reason);
}

// 4. Badge DOM basi tidak boleh menimpa angka dari hook API.
{
  const st = createState();
  applyReading(st, { kind: "notif", count: 4, source: "api" }, OPTS, 0);
  const stale = applyReading(st, { kind: "notif", count: 9, source: "dom" }, OPTS, 5_000);
  check("dom diabaikan saat api masih segar", stale.event === null && stale.reason === "stale-source", stale.reason);
  const later = applyReading(st, { kind: "notif", count: 9, source: "dom" }, OPTS, 90_000);
  check("dom dipakai lagi saat api basi", later.event?.count === 9, later.reason);
}

// 5. Sumber title (paling lemah) tetap bekerja bila cuma dia yang ada.
{
  const st = createState();
  applyReading(st, { kind: "notif", count: 1, source: "title" }, OPTS, 0);
  const r = applyReading(st, { kind: "notif", count: 3, source: "title" }, OPTS, 10_000);
  check("title memicu saat jadi satu-satunya sumber", r.event?.count === 3, r.reason);
}

// 6. Per-jenis toggle mandiri: chat mati, notifikasi tetap jalan.
{
  const st = createState();
  const opts = { ...OPTS, notifyChats: false };
  applyReading(st, { kind: "chat", count: 1, source: "api" }, opts, 0);
  applyReading(st, { kind: "notif", count: 1, source: "api" }, opts, 0);
  const chat = applyReading(st, { kind: "chat", count: 5, source: "api" }, opts, 10_000);
  const notif = applyReading(st, { kind: "notif", count: 2, source: "api" }, opts, 10_000);
  check("chat dimatikan tidak memicu", chat.event === null && chat.reason === "kind-disabled", chat.reason);
  check("notifikasi tetap memicu", notif.event !== null, notif.reason);
}

// 7. onlyOnIncrease=false memicu pada perubahan apa pun yang > 0.
{
  const st = createState();
  const opts = { ...OPTS, onlyOnIncrease: false, cooldownSeconds: 0 };
  applyReading(st, { kind: "notif", count: 5, source: "api" }, opts, 0);
  const r = applyReading(st, { kind: "notif", count: 3, source: "api" }, opts, 1_000);
  check("mode 'setiap perubahan' memicu walau turun", r.event?.count === 3, r.reason);
}

// 8. Input sampah ditolak, bukan bikin state rusak.
{
  const st = createState();
  const bad = applyReading(st, { kind: "notif", count: Number.NaN, source: "dom" }, OPTS, 0);
  const kind = applyReading(st, { kind: "wat", count: 1, source: "dom" }, OPTS, 0);
  const src = applyReading(st, { kind: "notif", count: 1, source: "guess" }, OPTS, 0);
  check("NaN ditolak", bad.event === null && bad.reason === "invalid-count", bad.reason);
  check("kind asing ditolak", kind.event === null && kind.reason === "unknown-kind", kind.reason);
  check("source asing ditolak", src.event === null && src.reason === "unknown-source", src.reason);
  check("state tetap kosong", Object.keys(st.kinds).length === 0);
  check("normalizeCount('12') = 12", normalizeCount("12") === 12);
  check("normalizeCount(-1) = null", normalizeCount(-1) === null);
}

// 9. Badge total lintas tab untuk ikon ekstensi.
{
  const a = createState();
  const b = createState();
  applyReading(a, { kind: "notif", count: 3, source: "api" }, OPTS, 0);
  applyReading(a, { kind: "chat", count: 2, source: "api" }, OPTS, 0);
  applyReading(b, { kind: "chat", count: 4, source: "api" }, OPTS, 0);
  check("total lintas tab = 9", totalUnread([a, b]) === 9, String(totalUnread([a, b])));
}

// 10. Siklus nyata: buka tab (badge 0) -> pesanan masuk -> dibaca -> pesanan baru.
{
  const st = createState();
  const base = applyReading(st, { kind: "notif", count: 0, source: "dom" }, OPTS, 0);
  const first = applyReading(st, { kind: "notif", count: 1, source: "dom" }, OPTS, 10_000);
  const read = applyReading(st, { kind: "notif", count: 0, source: "dom" }, OPTS, 20_000);
  const second = applyReading(st, { kind: "notif", count: 1, source: "dom" }, OPTS, 30_000);
  check("baseline nol senyap", base.event === null && base.reason === "baseline", base.reason);
  check("pesanan pertama setelah baseline nol memicu", first.event?.count === 1, first.reason);
  check("badge hilang setelah dibaca senyap", read.event === null, read.reason);
  check("pesanan berikutnya memicu lagi", second.event?.count === 1, second.reason);
}

// 11. Probe DOM yang rusak (selector Shopee berubah) melaporkan nol palsu terus;
//     hitungan dari hook API tidak boleh ikut terhapus.
{
  const st = createState();
  applyReading(st, { kind: "chat", count: 0, source: "api" }, OPTS, 0);
  const up = applyReading(st, { kind: "chat", count: 3, source: "api" }, OPTS, 10_000);
  const fake = applyReading(st, { kind: "chat", count: 0, source: "dom" }, OPTS, 80_000);
  const more = applyReading(st, { kind: "chat", count: 4, source: "api" }, OPTS, 90_000);
  check("chat dari api memicu", up.event?.count === 3, up.reason);
  check("nol palsu dari dom diabaikan", fake.event === null && fake.reason === "unproven-zero", fake.reason);
  check("kenaikan api berikutnya tetap memicu", more.event?.count === 4, more.reason);
}

// 12. Nol dari sumber yang sudah terbukti benar tetap harus menurunkan state.
{
  const st = createState();
  applyReading(st, { kind: "notif", count: 0, source: "dom" }, OPTS, 0);
  applyReading(st, { kind: "notif", count: 2, source: "dom" }, OPTS, 10_000);
  const zero = applyReading(st, { kind: "notif", count: 0, source: "dom" }, OPTS, 20_000);
  check("nol dari sumber terbukti diterima", zero.event === null && zero.reason === "decreased", zero.reason);
  const again = applyReading(st, { kind: "notif", count: 2, source: "dom" }, OPTS, 30_000);
  check("state benar-benar turun ke 0", again.event?.prev === 0, JSON.stringify(again));
}

// 13. suppress (tab sedang ditatap): perubahan diakui, tetapi tidak boleh
//     memicu cooldown untuk notifikasi yang tidak pernah dikirim.
{
  const st = createState();
  applyReading(st, { kind: "notif", count: 0, source: "dom" }, OPTS, 0);
  const quiet = applyReading(st, { kind: "notif", count: 1, source: "dom" }, { ...OPTS, suppress: true }, 1_000);
  check("tab terlihat: tidak ada event", quiet.event === null && quiet.reason === "suppressed", quiet.reason);
  // Seller berpindah tab; pesanan berikut datang hanya 1 detik kemudian.
  const loud = applyReading(st, { kind: "notif", count: 2, source: "dom" }, OPTS, 2_000);
  check("setelah tab ditinggalkan, notifikasi tetap terkirim", loud.event?.count === 2, loud.reason);
}

console.log(fail ? `\n${fail} test gagal` : "\nsemua test lolos");
process.exit(fail ? 1 : 0);

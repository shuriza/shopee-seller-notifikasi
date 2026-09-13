# Shopee Seller Notifier

Push notifikasi Chrome untuk **Shopee Seller Centre** — pesanan/notifikasi baru dan chat pembeli
terdeteksi walau tab tidak aktif, dengan **suara berbeda** untuk chat dan notifikasi.

Dibuat untuk seller yang memegang **banyak akun**: setiap notifikasi diberi label nama toko, jadi
langsung jelas akun mana yang butuh perhatian. Klik notifikasi → langsung lompat ke tab toko itu.

## Kenapa perlu

Seller Centre tidak mengirim push notification untuk setiap pesanan masuk. Badge di header hanya
diperbarui saat tab aktif, dan Chrome men-throttle timer halaman background jadi ~1×/menit — jadi
polling di dalam halaman saja telat berat. Ekstensi ini memindahkan penjadwalan ke luar halaman.

## Cara pakai

1. `chrome://extensions` → aktifkan **Developer mode** → **Load unpacked** → pilih folder ini.
   (Atau pakai `dist/shopee-seller-notifier-<versi>.zip` untuk unggahan Web Store.)
2. Buka Seller Centre dan **refresh** halamannya sekali.
3. Klik **🔔 Kirim Notifikasi Tes** di panel kanan-bawah untuk memastikan notifikasi + suara jalan.
   Kalau tidak muncul: izinkan notifikasi Chrome di pengaturan OS (Windows: Focus assist off).
4. Biarkan tab Seller Centre tetap terbuka. Satu tab per akun; semua dipantau bersamaan.
5. **⏸ Matikan Monitor** di panel atau toggle di popup untuk menjeda sementara.

## Cara kerja deteksi

Tiga sumber dengan tingkat kepercayaan berbeda, di-merge di `src/shared/detect.js`:

| Sumber | Cara | Tahan throttle | Peringkat |
| --- | --- | --- | --- |
| `api` | hook `fetch`/XHR/WebSocket, baca field `unread*` dari JSON Shopee | ya | 3 (tertinggi) |
| `dom` | badge di header (`class` mengandung badge/unread/count, `<sup>`) | sebagian | 2 |
| `title` | prefix `(3)` pada judul tab | ya | 1 |

Aturan yang menjaga notifikasi tetap akurat:

- **Baseline diam.** Pembacaan pertama tidak pernah berbunyi — membuka tab tidak memicu notifikasi.
- **Sumber lemah tidak menimpa sumber kuat** selama sumber kuat masih segar (60s). Badge DOM yang
  membeku di tab background tidak bisa menurunkan angka yang sudah benar dari hook API.
- **Nol dari sumber yang belum terbukti diabaikan.** Kalau Shopee mengganti nama kelas badge dan
  probe DOM jadi selalu "0", hitungan dari hook API tetap utuh.
- **Cooldown** menahan banjir notifikasi; notifikasi pertama tidak ikut tertahan.
- **Tab sedang ditatap** → perubahan diakui tapi senyap, tanpa menyalakan cooldown, jadi pesanan
  berikutnya setelah pindah tab tetap berbunyi.

Penjadwalan: `chrome.alarms` di service worker (default 30s) mengirim `PROBE_NOW` ke setiap tab,
karena `setInterval` di tab background di-throttle. `MutationObserver` menangkap perubahan instan
saat tab masih hidup. Audio diputar dari **offscreen document** — service worker tidak punya DOM,
dan content script bisa kena kebijakan autoplay atau tab yang di-mute.

Privasi: tidak ada jaringan keluar. Hook hanya membaca angka `unread` dari respons yang memang sudah
diminta halaman Shopee sendiri.

## Struktur

```
manifest.json                 MV3
src/shared/common.js          settings, konstanta pesan, label toko
src/shared/detect.js          inti keputusan (murni, tanpa API browser)
src/background/service-worker.js  scheduler, notifikasi, badge, state
src/offscreen/                pemutar audio WebAudio
src/content/hook.js           dunia MAIN: sniff fetch/XHR/WebSocket
src/content/monitor.js        probe DOM/title, panel, keep-alive port
src/popup/                    pengaturan lengkap
tools/gen-assets.mjs          generator ikon PNG + suara WAV (tanpa binary blob)
tools/smoke-detect.mjs        31 assert logika deteksi (tanpa browser)
tools/fixture/                Seller Centre palsu (HTTPS) untuk e2e
tools/e2e.mjs                 22 assert di Chrome sungguhan + ekstensi ter-load
tools/pack.mjs                bundel zip untuk Web Store
```

## Pengembangan

```bash
npm install
npm run assets     # regenerasi ikon & suara
npm test           # logika deteksi (cepat, tanpa browser)
npm run fixture    # jalankan Seller Centre palsu di :8443
npm run e2e        # di terminal lain: Chrome nyata, ekstensi ter-load
npm run zip        # dist/shopee-seller-notifier-<versi>.zip
```

`e2e` memetakan `seller.shopee.co.id` ke fixture lokal (`--host-resolver-rules`) supaya content
script benar-benar ter-inject sesuai match pattern, lalu memeriksa notifikasi yang benar-benar
dibuat service worker. Butuh Chrome dan `openssl` (ikut Git for Windows; atau set `OPENSSL_BIN`).

Chrome 137+ mencabut `--load-extension`, jadi e2e memakai opsi `enableExtensions` puppeteer.

## Status verifikasi

Terakhir dijalankan di Chrome 152 / Windows 11: **31/31** assert logika deteksi, **22/22** assert
e2e (0 gagal). Yang dibuktikan e2e, bukan diasumsikan:

- push notifikasi & suara untuk badge notif dan badge chat saat tab di latar belakang
- angka `unread` yang datang dari respons API (bukan hanya badge DOM)
- suara chat berbeda dari suara notifikasi
- tab sedang aktif → tidak push (`onlyWhenHidden`), dan halaman memang `visible` + fokus saat diuji
- monitor dimatikan → hening; dinyalakan lagi → push kembali
- offscreen audio document benar-benar dibuat
- popup memuat status, mendaftar tab dengan nama toko, dan menghitung notifikasi terkirim

Empat bug ditemukan lewat verifikasi ini, bukan lewat pembacaan kode:

1. cooldown menelan notifikasi *pertama* (`notifiedAt: 0` dibaca sebagai epoch 0);
2. probe tidak melaporkan nol, sehingga badge yang hilang setelah dibaca tidak menurunkan state dan
   pesanan berikutnya dianggap "turun" lalu senyap;
3. cek `onlyWhenHidden` berjalan setelah state dimutasi, sehingga notifikasi yang dilewati tetap
   menyalakan cooldown dan pesanan pertama setelah pindah tab hilang;
4. label notifikasi menebak nama toko dari judul halaman, sehingga semua akun tampak sama.

## Catatan

- Seller Centre harus tetap terbuka; ekstensi tidak bisa login atau polling tanpa sesi tab.
- Interval bawah `chrome.alarms` adalah 30 detik; nilai lebih kecil di popup tetap dinaikkan ke 30s.
  Deteksi tetap bisa **instan** lewat hook API dan MutationObserver saat sinyal muncul.

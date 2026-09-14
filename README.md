# Shopee Seller Notifier

Push notifikasi Chrome untuk **Shopee Seller Centre** — pesanan/notifikasi baru dan chat pembeli
terdeteksi walau tab tidak aktif, dengan **suara berbeda** untuk chat dan notifikasi.

Dibuat untuk seller yang memegang **banyak akun**: notifikasi memakai nama toko bila ditemukan,
dengan fallback domain dan nomor tab. Klik notifikasi membuka tab asalnya. Ekstensi tidak memisahkan
cookie akun atau menyatukan beberapa profil Chrome dalam satu dashboard.

## Kenapa perlu

Notifikasi yang terlambat atau terlewat menyulitkan pemantauan toko. Chrome dapat membatasi timer
tab background; ekstensi menambahkan pemeriksaan melalui alarm worker dan mengamati sinyal yang
sudah diterima halaman. Ini tidak memaksa server Shopee atau tab yang dibekukan untuk mengirim data.

## Cara pakai

1. `chrome://extensions` → aktifkan **Developer mode** → **Load unpacked** → pilih folder ini.
   (Atau pakai `dist/shopee-seller-notifier-<versi>.zip` untuk unggahan Web Store.)
2. Buka Seller Centre dan **refresh** halamannya sekali.
3. Klik **🔔 Kirim Notifikasi Tes** di panel kanan-bawah untuk memastikan notifikasi + suara jalan.
   Kalau tidak muncul: izinkan notifikasi Chrome di pengaturan OS (Windows: Focus assist off).
4. Biarkan tab Seller Centre tetap terbuka dan login. Akun yang berbeda biasanya membutuhkan profil
   Chrome terpisah; pasang ekstensi di setiap profil tersebut. Dua tab dalam profil sama berbagi sesi.
5. **⏸ Matikan Monitor** di panel atau toggle di popup untuk menjeda sementara.
6. Klik **Buka riwayat & pemantauan** di popup untuk membuka dashboard pada tab baru.
   Isi **Label profil** (misalnya `Toko Sepatu — Chrome A`), lalu **Simpan label**. Label ditambahkan
   di depan judul notifikasi profil ini; nama toko otomatis tetap tampil. Kosongkan untuk menghapus.

## Riwayat dan monitoring lokal

- Dashboard menampilkan tab Seller Centre dalam **profil browser ini**, jumlah notifikasi/chat,
  sumber hitungan, dan waktu laporan terakhir. Ini bukan pemeriksaan login atau kesehatan koneksi.
- Maksimal **200 percobaan notifikasi terbaru** disimpan lokal: termasuk tes, toast gagal, dan hasil
  audio. Baseline, hitungan tetap, serta perubahan yang ditekan pengaturan tidak menambah riwayat.
- Filter berdasarkan jenis, rentang tanggal, cari nama toko/label profil, atau sembunyikan notifikasi tes.
- **Ekspor JSON** mengunduh entri yang lolos filter aktif sebagai file `.json` ke folder Unduhan.
- **Stale tab indicator**: popup dan dashboard menandai tab yang tidak melapor lebih dari 3× interval
  polling. Berguna mendeteksi tab yang dibuang Chrome atau koneksi terputus.
- **Sumber per-kind di popup**: pil kecil di samping angka unread menampilkan sumber aktif
  (`N:api`, `C:dom`) sehingga terlihat hook mana yang memberi data.
- **Buka asal** memfokuskan tab dan jendela sumber yang masih tersedia. Setelah browser berganti
  sesi, tab ditutup, atau identitas target tidak cocok, tombol tidak membuka ulang URL lama.
- Riwayat bertahan setelah browser ditutup dan dibuka; label pada entri lama tidak ikut berubah
  ketika label profil diedit. **Hapus riwayat** memerlukan konfirmasi dan tidak menghapus pengaturan,
  statistik terkirim, atau baseline.

Ini **bukan dashboard gabungan lintas profil**. Tetap pasang ekstensi dan login pada setiap profil;
label manual membantu membedakan notifikasi desktop dari profil-profil tersebut.

## Cara kerja deteksi

Tiga sumber dengan tingkat kepercayaan berbeda, di-merge di `src/shared/detect.js`:

| Sumber | Cara | Syarat | Peringkat |
| --- | --- | --- | --- |
| `api` | hook `fetch`/XHR/WebSocket, baca field `unread*` | halaman tetap menerima respons | 3 (tertinggi) |
| `dom` | badge header (`class` badge/unread/count, `<sup>`) | DOM diperbarui halaman | 2 |
| `title` | prefix `(3)` pada judul tab | judul diperbarui halaman | 1 |

Aturan yang menjaga notifikasi tetap akurat:

- **Baseline diam.** Pembacaan pertama tidak pernah berbunyi — membuka tab tidak memicu notifikasi.
- **Sumber lemah tidak menimpa sumber kuat** selama sumber kuat masih segar (60s). Badge DOM yang
  membeku di tab background tidak bisa menurunkan angka yang sudah benar dari hook API.
- **Nol dari sumber yang belum terbukti diabaikan.** Kalau Shopee mengganti nama kelas badge dan
  probe DOM jadi selalu "0", hitungan dari hook API tetap utuh.
- **Cooldown** menahan banjir notifikasi; notifikasi pertama tidak ikut tertahan.
- **Tab sedang ditatap** → perubahan diakui tapi senyap, tanpa menyalakan cooldown, jadi pesanan
  berikutnya setelah pindah tab tetap berbunyi.

### Chat berulang dan banyak pembeli

Ekstensi membaca **jumlah chat belum dibaca**, bukan identitas pengirim. Jadi:

- Chat kedua dari pembeli yang sama **tetap** memicu notifikasi selama jumlah belum dibaca naik dan
  jeda anti-spam sudah lewat.
- Beberapa pesan yang datang beruntun dalam jeda tersebut **diringkas menjadi satu** notifikasi;
  jumlah pada notifikasi berikutnya tetap mencerminkan total terbaru.
- Pembeli berbeda **tidak** menghasilkan notifikasi terpisah per orang, dan tidak ada nama pengirim
  di notifikasi. Untuk mengetahui siapa yang mengirim, buka tab Seller Centre.
- Membalas atau membaca chat menurunkan jumlah; pesan berikutnya dihitung sebagai kenaikan baru.
- Atur **Jeda anti-spam** di popup: `0` detik berarti setiap kenaikan langsung diberi tahu.

Penjadwalan: `chrome.alarms` di service worker (default 30s) mengirim `PROBE_NOW` ke setiap tab,
karena `setInterval` di tab background di-throttle. Itu hanya jaring pengaman: hook API dan
`MutationObserver` melaporkan lewat microtask tanpa `setTimeout`, sehingga badge/WebSocket yang
berubah di tab background tidak menunggu timer yang bisa ditunda Chrome. Audio diputar dari
**offscreen document** — service worker tidak punya DOM, dan content script bisa kena kebijakan
autoplay atau tab yang di-mute.

### Ketahanan saat Chrome menghentikan service worker

Manifest V3 boleh menghentikan service worker setelah idle; itu perilaku normal Chrome. Ekstensi
tidak mengandalkan port keep-alive. Sebelum setiap respons
`HELLO`, `REPORT`, reset baseline, atau target klik notifikasi selesai, state dedupe dan target tab
disimpan di `chrome.storage.session`. Saat worker dibangunkan lagi oleh alarm/pesan/notifikasi,
state dipulihkan lebih dulu lalu tab yang benar-benar sudah tertutup dipangkas.

Artinya count yang sama tidak diulang setelah worker idle/restart, label toko tidak kembali ke
fallback domain, dan klik notifikasi yang masih tampil tetap dapat membuka tab asalnya. State sesi
memang dihapus ketika Chrome/profile ditutup; tab Seller Centre akan membuat baseline baru saat
dibuka lagi, sehingga tetap tidak berbunyi hanya karena browser baru dinyalakan.

Dokumen audio offscreen dengan alasan `AUDIO_PLAYBACK` dapat ditutup Chrome setelah kira-kira 30
detik hening. Sebelum setiap suara, worker mengecek dokumen itu dan membuat ulang bila perlu.
Notifikasi layar dan suara adalah dua hasil terpisah: bila toast berhasil tetapi audio gagal,
popup/panel menyatakan kegagalan suara secara eksplisit—toast tidak dikirim ulang agar tidak
menggandakan notifikasi. Bila Chrome menolak membuat toast, pembacaan dikembalikan agar probe
berikutnya dapat mencoba mengirimnya lagi.

Privasi: tidak ada server ekstensi atau pengiriman data ke pihak ketiga. Halaman Shopee tetap memakai
jaringannya sendiri. Hook membaca respons halaman secara lokal; laporan yang diteruskan ke worker
berisi hitungan, metadata halaman, dan nama toko. Tidak ada replay request atau penyimpanan password.
Riwayat di `chrome.storage.local` menyimpan waktu, jenis, label, judul, hitungan/sumber, hasil kirim,
hasil audio, error API, dan identitas target sesi internal. Tidak menyimpan URL halaman, body chat,
cookie, atau payload API mentah. Menghapus ekstensi juga menghapus penyimpanan lokalnya.

## Struktur

```
manifest.json                 MV3
src/shared/common.js          settings, konstanta pesan, label toko
src/shared/detect.js          inti keputusan (murni, tanpa API browser)
src/background/service-worker.js  scheduler, notifikasi, badge, state
src/offscreen/                pemutar audio WebAudio
src/content/hook.js           dunia MAIN: sniff fetch/XHR/WebSocket
src/content/monitor.js        probe DOM/title dan panel kontrol; tanpa keep-alive port
src/popup/                    pengaturan lengkap
src/dashboard/                label profil, daftar tab, filter dan riwayat lokal
tools/gen-assets.mjs          generator ikon PNG + suara WAV (tanpa binary blob)
tools/smoke-detect.mjs        logika deteksi dan normalisasi label (tanpa browser)
tools/fixture/                Seller Centre palsu (HTTPS) untuk e2e
tools/e2e.mjs                 Chrome sungguhan + ekstensi ter-load
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

Rilis 1.3.0: **39 pemeriksaan logika** (smoke-detect) — semua lolos. **39 pemeriksaan browser** pada
Chrome 152 / Windows 11 (dari sesi 1.2.1) masih berlaku. Fitur UI baru v1.3.0 (stale badge, filter
tanggal, ekspor JSON, sumber per-kind) belum masuk harness otomatis dan memerlukan verifikasi manual.

Browser test memakai fixture HTTPS lokal, bukan akun Shopee produksi. Cakupannya:
- toast diterima API Chrome; respons sukses audio notif dan chat diterima dari offscreen;
- offscreen ditutup secara eksplisit, kemudian TEST berikutnya membuat ulang dan memutar audio;
- kegagalan pembuatan toast disimulasikan, TEST melaporkan error dan percobaan berikutnya berhasil;
- kenaikan badge background menghasilkan push, hitungan sama tidak mengulangnya;
- badge DOM, perubahan teks badge, dan respons API chat dilaporkan tanpa menunggu alarm worker;
- chat beruntun dalam jeda anti-spam diringkas satu notifikasi, kenaikan sesudahnya tetap diberi tahu;
- tab terlihat tidak diberi toast; dua perubahan pengaturan bersamaan sama-sama tersimpan;
- popup/panel menampilkan hasil pengiriman, dan halaman ekstensi tidak terdaftar sebagai toko.
- riwayat mencatat percobaan gagal/berhasil dan label historis tanpa mengubah statistik ketika gagal;
- batas 200 entri, penghapusan tanpa mengubah baseline, penolakan sesi lama dan tab tertutup;
- dashboard dibuka lewat popup, filter/pencarian/label literal, konfirmasi batal/hapus;
- layout desktop dan 340px; durability riwayat lintas browser restart perlu dicek manual.

**Batas bukti:** `Runtime.terminateExecution` di harness hanya membuktikan bahwa pesan dan hitungan
tetap bekerja setelah command tersebut. Itu bukan bukti worker baru dibuat atau state dipulihkan
dari storage. Cold-start worker penuh dan klik toast OS sesudah restart belum terverifikasi otomatis.
Audio diverifikasi lewat penyelesaian WebAudio, bukan rekaman speaker; toast OS dapat dipengaruhi
pengaturan Windows. Struktur DOM/API dan nama toko Shopee nyata masih perlu diuji dengan sesi seller.

## Perubahan 1.3.0

- **Stale tab indicator.** Popup dan dashboard menandai tab yang tidak melapor lebih dari 3× interval polling dengan latar kuning dan badge "Stale". Berguna untuk mendeteksi tab yang dibuang Chrome atau koneksi terputus.
- **Sumber per-kind di popup.** Di bawah angka unread tiap tab popup, pil kecil menampilkan sumber aktif (`N:api`, `C:dom`, dll.) sehingga bisa langsung terlihat apakah hook API atau DOM yang memberi data.
- **Filter tanggal di dashboard.** Riwayat dapat difilter berdasarkan rentang tanggal (Dari/Sampai) di samping filter jenis dan pencarian label yang sudah ada.
- **Ekspor JSON.** Tombol "Ekspor JSON" mengunduh entri riwayat yang sesuai filter aktif sebagai file `ssn-riwayat-YYYY-MM-DD.json`. Isi field identik dengan struktur `GET_HISTORY`.

## Perubahan 1.2.1

- Laporan chat/notifikasi tidak lagi menunggu `setTimeout` yang dapat di-throttle pada tab
  background, sehingga chat nyata tidak tertunda sampai polling berikutnya.
- Perubahan teks badge (`characterData`) ikut memicu pembacaan ulang.
- Dokumentasi perilaku chat berulang dan batas identitas pengirim.

## Perubahan 1.2.0

- Label profil manual (maksimal 48 karakter) sebagai awalan toast, disimpan per profil.
- Dashboard responsif dan riwayat lokal maksimum 200 entri, termasuk tes dan kegagalan kirim/audio.
- Status hitungan dan laporan terakhir per tab; pemfokusan tab sumber dari riwayat.
- Identitas sesi/tracker diperiksa sebelum navigasi; entry dari sesi lama tidak membuka ID tab daur ulang.
- Riwayat dapat dihapus tanpa menghapus pengaturan, statistik, atau baseline; izin ekstensi tidak bertambah.

## Perubahan 1.1.0

- Bootstrap worker tunggal, operasi state diurutkan, dan baseline disimpan sebelum respons REPORT.
- Nama toko dipertahankan saat probe awal belum membawa nama; target klik disimpan dalam sesi.
- Port keep-alive dan loop reconnect dihapus; kegagalan pesan sementara tidak menghapus baseline.
- Dokumen audio diperiksa ulang setiap pemutaran; feedback membedakan toast gagal, suara gagal,
  suara dimatikan, dan sukses.
- Pembacaan dikembalikan setelah toast ditolak sehingga probe berikutnya dapat mencoba lagi.
- Minimum Chrome 120 untuk periode alarm 30 detik; lookup audio memakai `runtime.getContexts`.

## Catatan

- Seller Centre harus tetap terbuka; ekstensi tidak bisa login atau polling tanpa sesi tab.
- Browser ditutup, perangkat tidur, tab dibuang, atau sesi habis dapat menghentikan pemantauan.
- Badge agregat tidak menjamin setiap pesanan terdeteksi: angka tetap (mis. `99+`) dan perubahan
  yang terjadi di antara dua probe mungkin tidak menghasilkan sinyal baru.
- Interval bawah `chrome.alarms` adalah 30 detik; nilai lebih kecil di popup tetap dinaikkan ke 30s.
  Deteksi tetap bisa **instan** lewat hook API dan MutationObserver saat sinyal muncul.

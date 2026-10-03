# Runbook Operasional TG Drive

Catatan penting agar tidak lupa. Bahasa Indonesia.

## Daftar repo GitHub

| Repo | Isi |
|---|---|
| `tgdrive-server` | Source server Flask + `install.sh` + `migrate.sh` (repo ini) |
| `tgdrive-apk` | Source + rilis APK Android |
| `tgdrive-win` | Source + rilis aplikasi Windows (Tauri) |

## Install VPS baru

```bash
curl -fsSL https://raw.githubusercontent.com/diyansantoso26/tgdrive-server/main/install.sh -o install.sh
sudo bash install.sh --domain drive.contoh.id
```

Lalu isi `TG_BOT_TOKEN` & `TG_CHANNEL_ID` di `/home/tgdrive/app/.env`, restart service,
arahkan DNS, pasang SSL (`certbot --nginx -d domain`).

## Migrasi VPS lama → baru

```bash
# VPS LAMA
sudo ./migrate.sh backup            # → tgdrive-backup-YYYYMMDD-HHMMSS.tar.gz
scp tgdrive-backup-*.tar.gz root@IP-BARU:/root/

# VPS BARU
sudo bash install.sh --domain drive.contoh.id
sudo ./migrate.sh restore /root/tgdrive-backup-*.tar.gz
# → arahkan DNS ke IP baru
```

## Rilis APK Android baru

```bash
cd ~/workspace/tgdrive-apk
# 1. (Bila perlu) hapus android:usesCleartextTraffic dari AndroidManifest.xml
# 2. Build & sign — password keystore DIMINTA ke pemilik, dipakai sekali via env,
#    TIDAK disimpan di file mana pun:
VER_CODE=<n> VER_NAME=<x.y> TGDRIVE_KS_PASS='<password>' ./build-apk.sh
# 3. Upload ke VPS:
scp -F ~/.ssh/config_vps build/manual/tgdrive.apk vps:/tmp/tgdrive.apk
ssh -F ~/.ssh/config_vps vps "sudo cp /tmp/tgdrive.apk /home/tgdrive/app/apk/tgdrive.apk && sudo chown tgdrive:tgdrive /home/tgdrive/app/apk/tgdrive.apk"
# 4. Daftarkan versi di admin (panel /admin → Aplikasi Android) atau via DB:
#    apk_version_code=<n>, apk_version_name=<x.y>
# 5. Verifikasi: curl https://domain/apk/tgdrive.apk → cek versionCode via aapt
# 6. Rilis GitHub: upload ke releases/ di repo tgdrive-apk + buat release tag
```

## Rilis aplikasi Windows baru

```bash
cd ~/workspace/tgdrive-win
# 1. Update kode, lalu push ke GitHub:
python3 publish.py
# 2. Trigger build (GitHub Actions, runner Windows):
python3 -c "... workflow_dispatch ..."
# 3. Tunggu selesai → download artifact → upload .exe ke /home/tgdrive/app/apk/
# 4. Daftarkan versi di admin (panel /admin → Aplikasi Windows):
#    win_version_code, win_version_name, win_url=/apk/nama-file.exe
# 5. Verifikasi download HTTP 200 + /api/app-version
# 6. Rilis GitHub: file .exe ke releases/ + buat release tag
```

## Aturan yang tidak boleh dilanggar

1. **Jangan ganggu tetangga** — setiap kerja di VPS, cek dulu & sesudahnya:
   aaPanel/nginx, Hermes, 9router, cloudflared, telegram-bot-api, wa.gtg.my.id, gtg.my.id.
2. **Kredensial tidak disimpan** — password keystore, token bot, API key:
   dipakai sekali secara transient, tidak ditulis di chat/file/memory.
3. **Upload via /tmp** — user `gtg` tidak bisa tulis langsung ke `/home/tgdrive/app`;
   upload ke `/tmp` dulu lalu `sudo cp` + `chown tgdrive:tgdrive`.
4. **SSH VPS** selalu pakai `ssh -F ~/.ssh/config_vps vps` (wajib lewat proxy).
5. **Rahasia tidak di-commit** — `.env`, `*.db`, `apk/`, keystore ada di `.gitignore`.
6. **Nginx aaPanel** di-reload pakai `/etc/init.d/nginx reload` (bukan systemctl).

## Perintah cepat

```bash
sudo systemctl status tgdrive        # status service
sudo systemctl reload tgdrive        # reload graceful (tanpa putus koneksi) — untuk update kode
sudo systemctl restart tgdrive       # restart penuh — hanya bila .env berubah / reload bermasalah
sudo journalctl -u tgdrive -f        # log
sudo nano /home/tgdrive/app/.env     # konfigurasi (lalu restart)
```

## Sistem lisensi

- Paket: PRO Bulanan (30 hari) / PRO Tahunan (365 hari) / PRO Lifetime.
- Admin → panel Admin → seksi **Lisensi**: buat kode (`TGDRIVE-XXXX-XXXX`), lihat status, cabut, hapus.
- Admin → **Harga Lisensi**: isi harga tiap paket (tampil di halaman Upgrade).
- Admin → Pengaturan: isi **nomor WhatsApp** untuk tombol konfirmasi pembayaran.
- User: menu **⭐ Upgrade** → baca keuntungan → scan QRIS (`static/qris.jpg`) → bayar →
  konfirmasi via WA → terima kode dari admin → redeem di halaman yang sama.
- `is_pro()` menghormati lisensi aktif (kedaluwarsa/dicabut = PRO hilang otomatis).
- Redeem menaikkan kuota user bila kuota lisensi lebih besar (tidak pernah turun otomatis).

## UI baru (2026-10-03)

- Undo/redo di Drive: tombol ⟲ ⟳ + toast "Urungkan" + Ctrl+Z/Ctrl+Shift+Z.
  Bisa untuk: rename file/folder, pindah/kembalikan tong sampah, buat folder.
- Menu akun: avatar lingkaran (ganti teks username + link Keluar).
  Isi: ubah nama tampilan, Akun Telegram, Riwayat aktivitas, Pengaturan, Tema, Upgrade ke PRO, Keluar.
- Topbar ramping: Drive | Foto | Upgrade (+ Admin). Aktivitas & Pengaturan pindah ke menu akun.
- 5 tema (per user, tersimpan di DB): Gelap, Terang, Senja, Samudra, Hutan. Ganti via menu akun → Tema.
- Ikon SVG di navigasi, toolbar, dan menu (mengikuti warna tema).
- API: `PUT /api/profile` {display_name, theme}.

## Revisi toolbar Drive (2026-10-03)

- Breadcrumb pill pindah ke baris sendiri selebar penuh (scroll horizontal di HP).
- Toolbar dikelompok dengan divider: [← → ↑] | [⟲ ⟳] | [pencarian flex] | [＋Baru] [⬆ Upload] [⋯].
- Tombol **☑ Pilih dihapus** dari toolbar; mode pilih via tahan lama (HP) atau **⋯ → Pilih banyak** (desktop).
- Menu ⋯ berisi: Pilih banyak, Tong Sampah.

## Tanggal foto dari nama file (2026-10-03)

- `taken_at` kini diisi berlapis: EXIF (`DateTimeOriginal` → `CreateDate` →
  `DateTime`) dulu, lalu **nama file** bila EXIF kosong.
- Pola nama yang dikenali: `IMG_YYYYMMDD_HHMMSS`, `IMG-YYYYMMDD-WAxxxx`
  (WhatsApp), `VID_…`, `PXL_…`, `Screenshot_YYYY-MM-DD-HH-MM-SS`,
  tanggal `YYYY-MM-DD`, timestamp murni 10/13 digit. Tanggal tidak masuk akal
  (<1990 / masa depan) ditolak.
- Berlaku untuk foto DAN video (`photo_taken_at` di `_process_upload_file`).
- Backfill sekali jalan: `python3 /tmp/backfill_taken.py` di VPS mengisi
  `taken_at` yang masih NULL dari nama file (680 dari 701 foto pada
  2026-10-03; sisanya nama acak tanpa tanggal → tetap pakai tanggal upload).
- Scrubber timeline Foto otomatis muncul karena foto kini tersebar di
  banyak grup bulan.

## Foto full viewport + fix PIN user (2026-10-03)

- Tab Foto kini **viewport terkunci**: halaman tidak bisa di-scroll
  (`body.page-photos{overflow:hidden}`), scrollbar browser disembunyikan;
  hanya area `#tlWrap` yang scroll internal (scrollbar-nya juga
  disembunyikan). Scrubber jadi navigasi utama (geser = lompat antar
  grup bulan; scroll area = kenop ikut). Header bulan sticky `top:0`.
- Fix bug: tombol **Simpan PIN tidak berfungsi untuk user non-admin** —
  `initSettings()` crash di `getElementById('lApply')` (tombol khusus
  admin) sehingga handler PIN tidak pernah tersambung. Kini di-guard.

## Upload 2-mode (2026-10-03)

- **Mode 1** (<100 MB): single POST biasa via domain — perilaku lama, stabil.
- **Mode 2** (>=100 MB, khusus PRO): chunked 5/10 MB via `direct.gtg.my.id:8443`
  dengan token transfer (bukan cookie lintas origin) + header CORS terbatas.
  Finalisasi Telegram tidak lagi lewat Cloudflare -> bebas HTTP 524.
- `POST /api/upload/complete` **idempotent**: retry dengan `upload_id` yang sama
  mengembalikan hasil tersimpan (`result_file_id`), tidak duplikat ke Telegram.
  `POST /api/upload/init` juga idempotent via `client_key` (retry init tidak bikin sesi ganda).
- Toggle admin **Pengaturan -> Upload resume/chunked** (default ON, setting `chunked_upload`):
  OFF = endpoint chunked menolak 503; file >=100 MB hanya bisa via jalur langsung manual.
- Menu **Mode Besar dihapus dari menu ⋯** (badge PRO sudah cukup sebagai penanda).
  Fallback tersisa: tombol "⚡ Coba via Mode Besar" muncul kontekstual saat upload
  besar otomatis gagal + link "Buka jalur langsung (darurat)" di Pengaturan khusus PRO.
- Kolom baru `upload_sessions.client_key` + `result_file_id` (migrasi otomatis di `db.init_db`).
- Batas: non-PRO 100 MB/file, PRO 2 GB/file.

# TG Drive — Server

Aplikasi penyimpanan cloud pribadi berbasis Telegram (mirip Google Drive): upload file/foto, folder, tong sampah, share link, multi-user, kuota, mode PRO, aplikasi Android & Windows.

Repo ini berisi **source code server** (Python/Flask). Aplikasi Android ada di [`tgdrive-apk`](https://github.com/diyansantoso26/tgdrive-apk), aplikasi Windows di [`tgdrive-win`](https://github.com/diyansantoso26/tgdrive-win).

---

## A. Install di VPS baru (sekali jalan)

**Syarat:** VPS Linux (Ubuntu/Debian, RHEL/Alma/Rocky/Fedora, atau Arch), akses root, RAM ≥ 1 GB.

```bash
# 1. Download & jalankan installer (sebagai root)
curl -fsSL https://raw.githubusercontent.com/diyansantoso26/tgdrive-server/main/install.sh -o install.sh
sudo bash install.sh --domain drive.contoh.id
```

`--domain` boleh dikosongkan bila belum punya domain. Script akan:
1. Deteksi distro → install Python 3, nginx, sqlite, git, curl
2. Buat user `tgdrive` + clone repo ke `/home/tgdrive/app`
3. Buat virtualenv + install dependensi (retry otomatis bila gagal jaringan)
4. Generate `.env` (secret acak + password admin awal acak — **catat & simpan!**)
5. Pasang & jalankan systemd service `tgdrive`
6. Konfigurasi nginx reverse proxy
7. **Verifikasi otomatis**: service aktif, HTTP 200, API valid, database OK

Setiap fase dicek — bila gagal, script mencoba memperbaikinya sendiri (perbaiki permission, restart service, install ulang). Bila tetap gagal, ditampilkan penyebab + cara perbaikinya. Aman dijalankan ulang.

**Setelah install (manual, ±5 menit):**
1. Isi `TG_BOT_TOKEN` (dari @BotFather) dan `TG_CHANNEL_ID` di `/home/tgdrive/app/.env`:
   ```bash
   sudo nano /home/tgdrive/app/.env
   sudo systemctl restart tgdrive
   ```
   Cara dapat channel ID: buat channel privat → jadikan bot admin → forward 1 pesan channel ke @userinfobot.
2. Arahkan DNS domain ke IP VPS.
3. Pasang SSL gratis: `sudo certbot --nginx -d drive.contoh.id` (install certbot dulu bila belum ada).
4. Login sebagai `admin`, **ganti password** di Pengaturan, lalu atur kuota & versi APK di panel `/admin`.

## B. Migrasi ke VPS lain

```bash
# Di VPS LAMA — buat arsip backup (DB + .env + apk + thumbs)
sudo ./migrate.sh backup
# → hasil: tgdrive-backup-YYYYMMDD-HHMMSS.tar.gz

# Pindahkan ke VPS baru
scp tgdrive-backup-*.tar.gz root@IP-VPS-BARU:/root/

# Di VPS BARU — install fresh dulu, lalu restore
sudo bash install.sh --domain drive.contoh.id
sudo ./migrate.sh restore /root/tgdrive-backup-*.tar.gz
```

Terakhir: arahkan DNS ke IP VPS baru.

## C. Perintah operasional

```bash
sudo systemctl status tgdrive      # cek status
sudo systemctl restart tgdrive     # restart
sudo journalctl -u tgdrive -f      # lihat log
sudo nano /home/tgdrive/app/.env   # ubah konfigurasi (lalu restart)
```

## D. Struktur

```
app.py              aplikasi Flask
config.py           konfigurasi (baca .env)
db.py               lapisan database SQLite
tg.py               helper Telegram Bot API
templates/ static/  tampilan web
install.sh          installer sekali jalan (multi-distro + self-repair)
migrate.sh          backup & restore antar VPS
systemd/            unit service
nginx/              contoh konfigurasi nginx
```

## E. Catatan keamanan

- `.env`, `*.db`, dan folder `apk/` **tidak pernah** di-commit (lihat `.gitignore`).
- Token bot Telegram per-user dienkripsi (Fernet) di database.
- Untuk upload file >20MB butuh server Bot API lokal (lihat `telegram-bot-api.service` di riwayat) — opsional.

## Lisensi

Pribadi — untuk kebutuhan sendiri.

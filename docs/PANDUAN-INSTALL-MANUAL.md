# Panduan Install TG Drive Manual di VPS

Panduan langkah-demi-langkah untuk install TG Drive di VPS baru (Ubuntu 24.04).

## Yang Kamu Butuhkan

1. VPS dengan Ubuntu 24.04 (minimal 2GB RAM)
2. File backup: `tgdrive-backup-2026-10-06.tar.gz` (94MB)
3. Domain yang sudah pointing ke VPS (misal: drive.gtg.my.id)
4. Cloudflare Tunnel sudah setup (atau pakai reverse proxy biasa)

## Langkah 1: Persiapan VPS

```bash
# Update sistem
sudo apt update && sudo apt upgrade -y

# Install dependensi
sudo apt install -y python3 python3-venv python3-pip nginx
```

## Langkah 2: Buat User & Restore File

```bash
# Buat user tgdrive
sudo useradd -r -m -s /bin/bash tgdrive

# Extract backup
sudo mkdir -p /home/tgdrive
sudo tar -xzf tgdrive-backup-2026-10-06.tar.gz -C /home/tgdrive
sudo chown -R tgdrive:tgdrive /home/tgdrive/app
```

## Langkah 3: Setup Python Environment

```bash
# Buat virtual environment
sudo -u tgdrive python3 -m venv /home/tgdrive/app/venv

# Install dependensi
sudo -u tgdrive /home/tgdrive/app/venv/bin/pip install -r /home/tgdrive/app/requirements.txt
```

## Langkah 4: Konfigurasi Environment

Edit file `/home/tgdrive/app/.env` dan sesuaikan:

```bash
sudo -u tgdrive nano /home/tgdrive/app/.env
```

Isi yang penting:
- `SECRET_KEY`: kunci rahasia Flask (buat yang baru)
- `TELEGRAM_BOT_TOKEN`: token bot Telegram kamu
- `TELEGRAM_API_ID` & `TELEGRAM_API_HASH`: dari my.telegram.org
- `DATABASE_URL`: path ke database (default: sqlite:////home/tgdrive/app/tgdrive.db)

## Langkah 5: Buat Systemd Service

Buat file `/etc/systemd/system/tgdrive.service`:

```ini
[Unit]
Description=TG Drive - penyimpanan cloud pribadi berbasis Telegram
After=network.target

[Service]
Type=simple
User=tgdrive
Group=tgdrive
WorkingDirectory=/home/tgdrive/app
EnvironmentFile=/home/tgdrive/app/.env
ExecStart=/home/tgdrive/app/venv/bin/gunicorn -w 3 --threads 4 --timeout 1800 --graceful-timeout 1800 -b 127.0.0.1:8502 app:app
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Aktifkan:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tgdrive
sudo systemctl status tgdrive
```

## Langkah 6: Setup Nginx Reverse Proxy

Buat file `/etc/nginx/sites-available/drive.gtg.my.id`:

```nginx
server {
    listen 80;
    server_name drive.gtg.my.id;
    client_max_body_size 2100M;
    location / {
        proxy_pass http://127.0.0.1:8502;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1800;
        proxy_send_timeout 1800;
    }
}
```

Aktifkan:

```bash
sudo ln -s /etc/nginx/sites-available/drive.gtg.my.id /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## Langkah 7: Setup Cloudflare Tunnel (Opsional)

Kalau pakai Cloudflare Tunnel, tambahkan ke config:

```yaml
- hostname: drive.gtg.my.id
  service: http://127.0.0.1:80
```

## Verifikasi

Buka `https://drive.gtg.my.id` di browser. Harusnya muncul halaman login.

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| Service gagal start | Cek log: `sudo journalctl -u tgdrive -n 50` |
| 502 Bad Gateway | Pastikan service jalan: `sudo systemctl status tgdrive` |
| Upload gagal | Cek `client_max_body_size` di nginx |
| Database error | Pastikan permission: `sudo chown -R tgdrive:tgdrive /home/tgdrive` |

## File Backup

- **Lokasi:** `/home/gtg/tgdrive-backup-2026-10-06.tar.gz` di VPS
- **Ukuran:** 94MB
- **Isi:** Source code + database + config (tanpa venv)
- **Cara download:** Via SCP atau panel file manager

---
*Dibuat: 2026-10-06*

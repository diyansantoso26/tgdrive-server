#!/bin/bash
# Install TG Drive di VPS Ubuntu 24.04 dari nol
# Cara pakai: sudo bash install-tgdrive.sh
# Atau: bash install-tgdrive.sh (nanti minta sudo otomatis)
#
# Yang dilakukan script ini:
# 1. Install system dependencies (python3, nginx, dll)
# 2. Buat user tgdrive
# 3. Setup Python virtual environment + install Python packages
# 4. Buat systemd service
# 5. Setup nginx reverse proxy
#
# Catatan: file .env harus dikonfigurasi manual setelah install
# Lihat docs/PANDUAN-INSTALL-MANUAL.md untuk detail konfigurasi

set -e

echo "=== Install TG Drive ==="
echo ""

# Cek root
if [ "$EUID" -ne 0 ]; then
    echo "Jalankan sebagai root: sudo bash $0"
    exit 1
fi

# 1. System dependencies
echo "[1/5] Install system dependencies..."
apt update -qq
apt install -y -qq python3 python3-venv python3-pip nginx curl

# 2. Buat user tgdrive
echo "[2/5] Buat user tgdrive..."
if ! id tgdrive &>/dev/null; then
    useradd -r -m -s /bin/bash tgdrive
    echo "User tgdrive dibuat"
else
    echo "User tgdrive sudah ada"
fi

# 2b. Cari dan extract backup otomatis
echo "[2b/5] Cari file backup..."
APP_DIR="/home/tgdrive/app"
BACKUP_FILE=""
for loc in "/home/gtg/tgdrive-backup-2026-10-06.tar.gz" "/root/tgdrive-backup-2026-10-06.tar.gz" "/tmp/tgdrive-backup-2026-10-06.tar.gz" "./tgdrive-backup-2026-10-06.tar.gz" "$HOME/tgdrive-backup-2026-10-06.tar.gz"; do
    if [ -f "$loc" ]; then
        BACKUP_FILE="$loc"
        break
    fi
done
# Cari juga file dengan pola tgdrive-backup-*.tar.gz
if [ -z "$BACKUP_FILE" ]; then
    BACKUP_FILE=$(find /home /root /tmp -maxdepth 2 -name "tgdrive-backup-*.tar.gz" 2>/dev/null | head -1)
fi

if [ ! -d "$APP_DIR" ]; then
    if [ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ]; then
        echo "Ketemu backup: $BACKUP_FILE"
        echo "Extract..."
        mkdir -p /home/tgdrive
        tar -xzf "$BACKUP_FILE" -C /home/tgdrive
        chown -R tgdrive:tgdrive /home/tgdrive
        echo "Extract selesai"
    else
        echo "ERROR: $APP_DIR tidak ditemukan dan file backup tidak ketemu!"
        echo ""
        echo "Taruh file backup (tgdrive-backup-*.tar.gz) di salah satu:"
        echo "  - /home/gtg/"
        echo "  - /root/"
        echo "  - /tmp/"
        echo "  - direktori saat ini"
        echo ""
        echo "Terus jalanin lagi script ini."
        exit 1
    fi
fi

# 3. Setup Python venv
echo "[3/5] Setup Python environment..."

sudo -u tgdrive python3 -m venv "$APP_DIR/venv"
echo "Install Python packages..."
sudo -u tgdrive "$APP_DIR/venv/bin/pip" install -q --upgrade pip
sudo -u tgdrive "$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"

# Verifikasi
echo "Verifikasi packages:"
sudo -u tgdrive "$APP_DIR/venv/bin/pip" list 2>/dev/null | grep -E "Flask|gunicorn|requests|Pillow"

# 4. Systemd service
echo "[4/5] Buat systemd service..."
cat > /etc/systemd/system/tgdrive.service << 'EOF'
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
ExecReload=/bin/kill -HUP $MAINPID
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable tgdrive

# 5. Nginx
echo "[5/5] Setup nginx..."
cat > /etc/nginx/sites-available/tgdrive << 'EOF'
server {
    listen 80;
    server_name _;
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
EOF

ln -sf /etc/nginx/sites-available/tgdrive /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# Set ownership
chown -R tgdrive:tgdrive /home/tgdrive/app

echo ""
echo "=== Selesai ==="
echo ""
echo "Langkah selanjutnya (manual):"
echo "1. Edit /home/tgdrive/app/.env (token bot, secret key, dll)"
echo "   sudo -u tgdrive nano /home/tgdrive/app/.env"
echo ""
echo "2. Ganti server_name di nginx dengan domain kamu:"
echo "   sudo nano /etc/nginx/sites-available/tgdrive"
echo "   sudo systemctl reload nginx"
echo ""
echo "3. Start service:"
echo "   sudo systemctl start tgdrive"
echo "   sudo systemctl status tgdrive"
echo ""
echo "4. Cek log kalau ada masalah:"
echo "   sudo journalctl -u tgdrive -f"

#!/bin/bash
# ==============================================================================
# TG Drive — installer sekali jalan untuk VPS Linux baru.
#
#   curl -fsSL https://raw.githubusercontent.com/diyansantoso26/tgdrive-server/main/install.sh | sudo bash
#   atau:
#   sudo bash install.sh [--domain drive.contoh.id] [--repo URL] [--port 8502]
#
# Mendukung: Ubuntu/Debian (apt), RHEL/Alma/Rocky/CentOS/Fedora (dnf/yum),
#            Arch/Manjaro (pacman).
# Idempotent: aman dijalankan ulang. Setiap fase dicek & diperbaiki otomatis.
# ==============================================================================

set -u
APP_USER="tgdrive"
APP_DIR="/home/tgdrive/app"
APP_PORT="8502"
REPO_URL="https://github.com/diyansantoso26/tgdrive-server.git"
DOMAIN=""
PKG_MGR=""; DISTRO=""

# ---------- util ----------
say()  { echo -e "\033[1;32m[TG]\033[0m $*"; }
warn() { echo -e "\033[1;33m[!!]\033[0m $*" >&2; }
die()  { echo -e "\033[1;31m[XX]\033[0m $*" >&2; exit 1; }

# Jalankan perintah; bila gagal, tampilkan pesan + saran, lalu keluar.
run() {
    local desc="$1"; shift
    echo "  → $desc..."
    if "$@" >/tmp/tgdrive-install.log 2>&1; then
        echo "    OK"
    else
        warn "GAGAL: $desc"
        tail -5 /tmp/tgdrive-install.log | sed 's/^/    | /'
        return 1
    fi
}

# Coba hingga N kali (untuk pip install yang kadang gagal jaringan).
retry() {
    local n="$1"; shift
    local i
    for ((i=1; i<=n; i++)); do
        if "$@" >/tmp/tgdrive-install.log 2>&1; then return 0; fi
        warn "percobaan $i/$n gagal, ulangi dalam 3 dtk..."
        sleep 3
    done
    warn "gagal setelah $n percobaan:"
    tail -5 /tmp/tgdrive-install.log | sed 's/^/    | /'
    return 1
}

# ---------- argumen ----------
while [ $# -gt 0 ]; do
    case "$1" in
        --domain) DOMAIN="$2"; shift 2 ;;
        --repo)   REPO_URL="$2"; shift 2 ;;
        --port)   APP_PORT="$2"; shift 2 ;;
        *) die "Argumen tidak dikenal: $1" ;;
    esac
done

[ "$(id -u)" = "0" ] || die "Jalankan sebagai root (pakai sudo)."

# ---------- 1. deteksi OS ----------
say "Fase 1/8 — deteksi sistem operasi"
[ -f /etc/os-release ] || die "/etc/os-release tidak ditemukan."
# shellcheck disable=SC1091
. /etc/os-release
DISTRO="${ID:-unknown}"
say "Terdeteksi: ${PRETTY_NAME:-$DISTRO}"
case "$DISTRO" in
    ubuntu|debian|raspbian|linuxmint|pop) PKG_MGR="apt" ;;
    rhel|centos|almalinux|rocky|fedora|ol) PKG_MGR="dnf" ;;
    arch|manjaro|endeavouros) PKG_MGR="pacman" ;;
    *)
        if [ "${ID_LIKE:-}" != "" ]; then
            case "$ID_LIKE" in
                *debian*) PKG_MGR="apt" ;;
                *rhel*|*fedora*) PKG_MGR="dnf" ;;
                *arch*) PKG_MGR="pacman" ;;
            esac
        fi
        ;;
esac
[ -n "$PKG_MGR" ] || die "Distro '$DISTRO' belum didukung. Didukung: Ubuntu/Debian, RHEL/Alma/Rocky/Fedora, Arch."
# dnf tidak ada di sistem lama → pakai yum
if [ "$PKG_MGR" = "dnf" ] && ! command -v dnf >/dev/null 2>&1; then PKG_MGR="yum"; fi
say "Paket manajer: $PKG_MGR"

# ---------- 2. paket sistem ----------
say "Fase 2/8 — install paket sistem"
install_pkgs() {
    case "$PKG_MGR" in
        apt)
            run "update apt" apt-get update -qq
            run "install paket" apt-get install -y -qq python3 python3-venv python3-pip \
                sqlite3 nginx git curl \
                || run "install paket (verbose)" apt-get install -y python3 python3-venv \
                    python3-pip sqlite3 nginx git curl
            ;;
        dnf|yum)
            # EPEL untuk nginx di RHEL/Alma/Rocky (best effort)
            $PKG_MGR install -y -q epel-release 2>/dev/null || true
            run "install paket" $PKG_MGR install -y -q python3 python3-pip sqlite \
                nginx git curl
            ;;
        pacman)
            run "update pacman" pacman -Sy --noconfirm
            run "install paket" pacman -S --noconfirm --needed python python-pip \
                python-virtualenv sqlite nginx git curl
            ;;
    esac
}
install_pkgs || die "Install paket gagal. Cek koneksi internet lalu jalankan ulang script ini."
command -v python3 >/dev/null || die "python3 tidak ditemukan setelah install."
PYVER=$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')
say "Python $PYVER OK"

# ---------- 3. user & direktori ----------
say "Fase 3/8 — user & direktori aplikasi"
if ! id "$APP_USER" >/dev/null 2>&1; then
    run "buat user $APP_USER" useradd -r -m -d "/home/$APP_USER" -s /bin/bash "$APP_USER"
else
    say "user $APP_USER sudah ada"
fi
run "buat direktori" mkdir -p "$APP_DIR" "$APP_DIR/data"

# ---------- 4. ambil source ----------
say "Fase 4/8 — ambil source dari GitHub"
if [ -d "$APP_DIR/.git" ]; then
    run "update repo" git -C "$APP_DIR" pull --ff-only
else
    if [ -n "$(ls -A "$APP_DIR" 2>/dev/null | grep -v '^data$' || true)" ]; then
        warn "$APP_DIR tidak kosong & bukan git — backup ke ${APP_DIR}.bak"
        mv "$APP_DIR" "${APP_DIR}.bak.$(date +%s)"
        mkdir -p "$APP_DIR" "$APP_DIR/data"
    fi
    run "clone repo" git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

# ---------- 5. virtualenv & dependensi ----------
say "Fase 5/8 — virtualenv & dependensi Python"
if [ ! -x "$APP_DIR/venv/bin/python" ]; then
    run "buat virtualenv" python3 -m venv "$APP_DIR/venv"
fi
retry 3 "$APP_DIR/venv/bin/pip" install -q --upgrade pip \
    || die "Upgrade pip gagal."
retry 3 "$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/requirements.txt" \
    || die "Install requirements gagal."
run "verifikasi import" "$APP_DIR/venv/bin/python" -c "import flask, gunicorn, PIL, requests"

# ---------- 6. konfigurasi (.env) ----------
say "Fase 6/8 — konfigurasi (.env)"
ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
    cp "$APP_DIR/.env.example" "$ENV_FILE"
    # generate secret acak
    SECRET_KEY=$("$APP_DIR/venv/bin/python" -c 'import secrets; print(secrets.token_hex(32))')
    # password admin awal acak — ditampilkan sekali di akhir
    ADMIN_PASS=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)
    ADMIN_HASH=$("$APP_DIR/venv/bin/python" -c "
from werkzeug.security import generate_password_hash
import sys
print(generate_password_hash(sys.argv[1]))" "$ADMIN_PASS")
    {
        echo "SECRET_KEY=$SECRET_KEY"
        echo "ADMIN_PASSWORD_HASH=$ADMIN_HASH"
    } >> "$ENV_FILE"
    echo "$ADMIN_PASS" > /tmp/tgdrive-admin-pass.txt
    chmod 600 /tmp/tgdrive-admin-pass.txt
    say ".env dibuat (secret + password admin awal digenerate)"
else
    say ".env sudah ada — tidak diubah"
fi
[ -n "${DOMAIN}" ] && grep -q "^DOMAIN_URL=" "$ENV_FILE" && \
    sed -i "s|^DOMAIN_URL=.*|DOMAIN_URL=https://${DOMAIN}|" "$ENV_FILE" || true
chmod 600 "$ENV_FILE"

# ---------- 7. systemd service ----------
say "Fase 7/8 — systemd service"
sed -e "s|/home/tgdrive/app|$APP_DIR|g" -e "s|127.0.0.1:8502|127.0.0.1:$APP_PORT|" \
    "$APP_DIR/systemd/tgdrive.service" > /etc/systemd/system/tgdrive.service
run "reload systemd" systemctl daemon-reload
run "enable service" systemctl enable tgdrive
# Perbaiki kepemilikan SEBELUM start (self-repair permission)
run "perbaiki kepemilikan" chown -R "$APP_USER:$APP_USER" "$APP_DIR"
run "start service" systemctl restart tgdrive
sleep 3
if systemctl is-active -q tgdrive; then
    say "service tgdrive: AKTIF"
else
    warn "service gagal start, coba perbaiki..."
    journalctl -u tgdrive -n 10 --no-pager | sed 's/^/    | /'
    # self-repair: cek port bentrok & coba sekali lagi
    if ss -ltn 2>/dev/null | grep -q ":$APP_PORT "; then
        warn "port $APP_PORT dipakai proses lain!"
    fi
    run "restart ulang" systemctl restart tgdrive
    sleep 3
    systemctl is-active -q tgdrive || die "Service tetap gagal. Lihat: journalctl -u tgdrive"
fi

# ---------- 8. nginx ----------
say "Fase 8/8 — nginx reverse proxy"
SERVER_NAME="${DOMAIN:-_}"
sed "s/__DOMAIN__/$SERVER_NAME/" "$APP_DIR/nginx/tgdrive.conf.example" > /tmp/tgdrive-nginx.conf
NGINX_CONF=""
if [ -d /etc/nginx/sites-available ]; then
    NGINX_CONF="/etc/nginx/sites-available/tgdrive"
    cp /tmp/tgdrive-nginx.conf "$NGINX_CONF"
    ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/tgdrive
    rm -f /etc/nginx/sites-enabled/default
elif [ -d /etc/nginx/conf.d ]; then
    NGINX_CONF="/etc/nginx/conf.d/tgdrive.conf"
    cp /tmp/tgdrive-nginx.conf "$NGINX_CONF"
fi
if [ -n "$NGINX_CONF" ]; then
    if nginx -t 2>/tmp/tgdrive-install.log; then
        run "reload nginx" systemctl reload nginx 2>/dev/null || systemctl restart nginx
        say "nginx OK"
    else
        warn "konfigurasi nginx bermasalah, lewati (aplikasi tetap jalan di 127.0.0.1:$APP_PORT):"
        tail -5 /tmp/tgdrive-install.log | sed 's/^/    | /'
    fi
else
    warn "direktori nginx tidak dikenal — konfigurasi manual dari nginx/tgdrive.conf.example"
fi

# ---------- verifikasi akhir ----------
say "Verifikasi akhir"
OK=1
systemctl is-active -q tgdrive || { warn "service tidak aktif"; OK=0; }
if curl -sf -o /dev/null --max-time 10 "http://127.0.0.1:$APP_PORT/"; then
    say "HTTP 127.0.0.1:$APP_PORT → 200 OK"
else
    warn "aplikasi tidak merespon di 127.0.0.1:$APP_PORT"; OK=0
fi
if curl -sf --max-time 10 "http://127.0.0.1:$APP_PORT/api/app-version" | grep -q version_code; then
    say "API /api/app-version OK"
else
    warn "API tidak valid"; OK=0
fi
[ -f "$APP_DIR/data/drive.db" ] && say "database OK" || warn "database belum terbentuk (terbentuk saat pertama dibuka)"

echo ""
echo "=============================================="
if [ "$OK" = "1" ]; then
    say "INSTALL SELESAI — semua cek lolos ✓"
else
    warn "INSTALL SELESAI DENGAN CATATAN — periksa peringatan di atas"
fi
echo "=============================================="
echo "  Aplikasi : http://127.0.0.1:$APP_PORT (via nginx: http://${DOMAIN:-IP-VPS})"
echo "  Login    : admin"
if [ -f /tmp/tgdrive-admin-pass.txt ]; then
    echo "  Password : $(cat /tmp/tgdrive-admin-pass.txt)  ← simpan & hapus file ini!"
    echo "             (tersimpan sementara di /tmp/tgdrive-admin-pass.txt)"
fi
echo ""
echo "  Langkah berikut (manual):"
echo "   1. Isi TG_BOT_TOKEN & TG_CHANNEL_ID di $APP_DIR/.env lalu: systemctl restart tgdrive"
echo "   2. Arahkan DNS domain ke IP VPS ini"
echo "   3. Pasang SSL: certbot --nginx -d $DOMAIN  (bila ada domain)"
echo "   4. Ganti password admin di halaman Pengaturan"
echo "  Lihat README.md untuk migrasi data dari VPS lama."
echo "=============================================="

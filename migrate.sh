#!/bin/bash
# ==============================================================================
# TG Drive — migrasi antar VPS.
#
#   Di VPS LAMA : sudo ./migrate.sh backup [> tgdrive-backup-YYYYMMDD.tar.gz]
#                 → arsip berisi: database, .env, folder apk/, data thumbs/cache
#   Di VPS BARU : sudo ./migrate.sh restore tgdrive-backup-YYYYMMDD.tar.gz
#                 → restore + perbaiki permission + restart service
#
# Catatan: yang diarsipkan HANYA data & rahasia milikmu — tidak diupload ke GitHub.
# ==============================================================================

set -u
APP_USER="tgdrive"
APP_DIR="/home/tgdrive/app"

say()  { echo -e "\033[1;32m[TG]\033[0m $*"; }
die()  { echo -e "\033[1;31m[XX]\033[0m $*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "Jalankan sebagai root (pakai sudo)."

cmd="${1:-}"
case "$cmd" in
    backup)
        [ -d "$APP_DIR" ] || die "$APP_DIR tidak ditemukan."
        STAMP=$(date +%Y%m%d-%H%M%S)
        OUT="${2:-tgdrive-backup-$STAMP.tar.gz}"
        say "Backup dari $APP_DIR ..."
        systemctl stop tgdrive 2>/dev/null || true   # hentikan dulu agar DB konsisten
        tar -czf "$OUT" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")" \
            --exclude='./venv' --exclude='./__pycache__' --exclude='./.git' \
            --exclude='./data/cache' --exclude='./data/tmp' \
            2>/dev/null || die "tar gagal."
        systemctl start tgdrive 2>/dev/null || true
        chmod 600 "$OUT"
        say "SELESAI: $OUT ($(du -h "$OUT" | cut -f1))"
        say "Pindahkan file ini ke VPS baru (scp), lalu: sudo ./migrate.sh restore $OUT"
        ;;
    restore)
        ARCHIVE="${2:-}" 
        [ -n "$ARCHIVE" ] || die "Sebutkan file arsip: sudo ./migrate.sh restore <file.tar.gz>"
        [ -f "$ARCHIVE" ] || die "File tidak ditemukan: $ARCHIVE"
        [ -d "$APP_DIR" ] || die "$APP_DIR tidak ditemukan — jalankan install.sh dulu."
        say "Restore dari $ARCHIVE ..."
        # pengaman: backup kondisi saat ini dulu
        if [ -f "$APP_DIR/data/drive.db" ]; then
            cp "$APP_DIR/data/drive.db" "/tmp/drive.db.sebelum-restore.$(date +%s)"
            say "database lama diamankan di /tmp"
        fi
        systemctl stop tgdrive 2>/dev/null || true
        TMPD=$(mktemp -d)
        tar -xzf "$ARCHIVE" -C "$TMPD" || die "ekstrak gagal — file rusak?"
        SRC="$TMPD/app"
        [ -d "$SRC" ] || { SRC="$TMPD/$(ls "$TMPD" | head -1)"; }
        # yang di-restore: DB, .env, apk/, data (thumbs)
        for p in data/drive.db .env apk data/thumbs; do
            if [ -e "$SRC/$p" ]; then
                mkdir -p "$APP_DIR/$(dirname "$p")"
                cp -a "$SRC/$p" "$APP_DIR/$p"
                say "  restore: $p"
            fi
        done
        rm -rf "$TMPD"
        chown -R "$APP_USER:$APP_USER" "$APP_DIR"
        chmod 600 "$APP_DIR/.env" 2>/dev/null || true
        systemctl start tgdrive
        sleep 3
        if systemctl is-active -q tgdrive && curl -sf -o /dev/null --max-time 10 "http://127.0.0.1:8502/"; then
            say "RESTORE SELESAI — aplikasi jalan normal ✓"
        else
            die "restore selesai tapi service bermasalah. Lihat: journalctl -u tgdrive"
        fi
        ;;
    *)
        die "Pakai: $0 backup [file.tar.gz]  |  $0 restore <file.tar.gz>"
        ;;
esac

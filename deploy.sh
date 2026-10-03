#!/bin/bash
# Deploy TG Drive (multi-user) ke VPS.
# Cara pakai:  ./deploy.sh        (dari ~/workspace/tgdrive-app)
#              ./deploy.sh apk    (sekalian upload APK terbaru ke /home/tgdrive/app/apk/)
set -e
cd "$(dirname "$0")"
SSH="ssh -F /home/hatch/.ssh/config_vps vps"
SCP="scp -F /home/hatch/.ssh/config_vps"
STAMP=$(date +%Y%m%d-%H%M)

echo "== 1/6 Backup database =="
$SSH "sudo cp /home/tgdrive/app/data/drive.db /home/tgdrive/app/data/drive.db.bak-deploy-$STAMP && sudo chown tgdrive:tgdrive /home/tgdrive/app/data/drive.db.bak-deploy-$STAMP && sudo bash -c 'cd /home/tgdrive/app/data && ls -t drive.db.bak-deploy-* 2>/dev/null | tail -n +6 | xargs -r rm -f' && echo backup-ok"

echo "== 2/6 Pastikan TOKEN_ENC_KEY ada (sekali saja, anti duplikat) =="
$SSH "sudo grep -q '^TOKEN_ENC_KEY=' /home/tgdrive/app/.env && echo key-ada || { KEY=\$(/home/tgdrive/app/venv/bin/python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'); printf '\nTOKEN_ENC_KEY=%s\n' \"\$KEY\" | sudo tee -a /home/tgdrive/app/.env > /dev/null; sudo chmod 600 /home/tgdrive/app/.env; echo key-dibuat; }"

echo "== 3/6 Upload file ke /tmp VPS =="
rm -rf /tmp/tgdeploy && mkdir -p /tmp/tgdeploy
cp app.py db.py config.py tg.py /tmp/tgdeploy/
cp -r templates static /tmp/tgdeploy/
[ "${1:-}" = "apk" ] && cp ~/workspace/tgdrive-apk/build/manual/tgdrive.apk /tmp/tgdeploy/ || true
$SSH "sudo rm -rf /tmp/tgdeploy" && $SCP -r /tmp/tgdeploy vps:/tmp/tgdeploy

echo "== 4/6 Install ke /home/tgdrive/app =="
$SSH "sudo cp /tmp/tgdeploy/app.py /tmp/tgdeploy/db.py /tmp/tgdeploy/config.py /tmp/tgdeploy/tg.py /home/tgdrive/app/ && sudo cp -r /tmp/tgdeploy/templates/. /home/tgdrive/app/templates/ && sudo cp -r /tmp/tgdeploy/static/. /home/tgdrive/app/static/ && sudo chown -R tgdrive:tgdrive /home/tgdrive/app/app.py /home/tgdrive/app/db.py /home/tgdrive/app/config.py /home/tgdrive/app/tg.py /home/tgdrive/app/templates /home/tgdrive/app/static && echo install-ok"
if [ "${1:-}" = "apk" ]; then
  $SSH "sudo mkdir -p /home/tgdrive/app/apk && sudo cp /tmp/tgdeploy/tgdrive.apk /home/tgdrive/app/apk/ && sudo chown -R tgdrive:tgdrive /home/tgdrive/app/apk && echo apk-ok"
fi

echo "== 5/6 Reload service (graceful, tanpa putus koneksi) =="
# HUP = worker lama selesaikan request yang jalan, worker baru pakai kode baru.
# Tidak ada jendela "connection refused" seperti systemctl restart.
# Pakai ./deploy.sh --restart bila perlu restart penuh (mis. .env berubah).
if [ "${1:-}" = "--restart" ]; then
  $SSH "sudo systemctl restart tgdrive.service && sleep 5 && sudo systemctl is-active tgdrive.service"
else
  $SSH "sudo systemctl reload tgdrive.service || sudo systemctl restart tgdrive.service"
  sleep 8
  $SSH "sudo systemctl is-active tgdrive.service"
fi

echo "== 6/6 Verifikasi =="
$SSH "curl -s -o /dev/null -w 'login:%{http_code}\n' --max-time 15 http://127.0.0.1:8502/login"
$SSH "curl -s --max-time 15 http://127.0.0.1:8502/api/app-version; echo"
echo "SELESAI — cek https://drive.gtg.my.id di browser, lalu cek tetangga (aaPanel, Hermes, 9router, cloudflared, telegram-bot-api, wa.gtg.my.id)."

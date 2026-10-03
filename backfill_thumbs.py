#!/usr/bin/env python3
"""Backfill thumbnail lokal untuk file lama (opsi A).

- Foto/video yang belum punya thumb_local: unduh original dari Telegram,
  generate thumbnail 480px (PIL/ffmpeg), simpan di THUMB_DIR, catat di DB.
- Prioritas: yang rusak dulu (tanpa thumb Telegram), lalu sisanya.
- Aman dijalankan ulang (idempotent): lewati yang sudah punya thumb_local.

Jalankan di VPS: nohup venv/bin/python backfill_thumbs.py >> data/backfill.log 2>&1 &
"""
import os
import sys
import tempfile
import time
import traceback

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

import config          # noqa: E402
import db              # noqa: E402
import tg              # noqa: E402
from app import _creds_for_file, _make_local_thumb  # noqa: E402


def main():
    db.init_db()
    conn = db.get_db()
    rows = conn.execute(
        "SELECT id, user_id, account_id, name, kind, file_id, thumb_file_id"
        " FROM files WHERE kind IN ('photo','video')"
        " AND (thumb_local IS NULL OR thumb_local='')"
        " AND trashed=0"
        " ORDER BY CASE WHEN thumb_file_id IS NULL OR thumb_file_id='' THEN 0 ELSE 1 END,"
        " id DESC").fetchall()
    conn.close()
    total = len(rows)
    print('Target: %d file' % total, flush=True)
    ok, fail = 0, 0
    for i, _r in enumerate(rows, 1):
        r = db._row_to_dict(_r)
        fid = r['id']
        try:
            creds = _creds_for_file(r)
            if not creds:
                print('[%d/%d] #%d %s: tanpa kredensial, lewati' % (i, total, fid, r['name'][:40]), flush=True)
                fail += 1
                continue
            fd, tmp = tempfile.mkstemp(suffix='_' + os.path.basename(r['name'] or 'f')[-20:])
            os.close(fd)
            try:
                tg.download_file(r['file_id'], tmp, creds=creds)
                name = _make_local_thumb(tmp, r['kind'], fid)
                if name:
                    db.set_thumb_local(fid, r['user_id'], name)
                    ok += 1
                    print('[%d/%d] #%d %s: OK -> %s' % (i, total, fid, r['name'][:40], name), flush=True)
                else:
                    fail += 1
                    print('[%d/%d] #%d %s: generate gagal' % (i, total, fid, r['name'][:40]), flush=True)
            finally:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        except Exception as e:
            fail += 1
            print('[%d/%d] #%d %s: ERROR %s' % (i, total, fid, r['name'][:40], e), flush=True)
            traceback.print_exc()
        time.sleep(0.3)  # napas untuk Bot API
    print('SELESAI: %d ok, %d gagal dari %d' % (ok, fail, total), flush=True)


if __name__ == '__main__':
    main()

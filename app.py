"""TG Drive — penyimpanan cloud pribadi berbasis Telegram. MVP single-user."""
import hashlib
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import subprocess
import time
import uuid
from datetime import datetime, timedelta
from functools import wraps

from flask import (Flask, abort, g, jsonify, make_response, redirect, render_template, request,
                   send_file, session, url_for)
from urllib.parse import quote, urlparse
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename
from PIL import Image
from PIL.ExifTags import TAGS

import config
import db
import tg

db.init_db()

app = Flask(__name__)
app.secret_key = config.SECRET_KEY
app.config['MAX_CONTENT_LENGTH'] = config.MAX_UPLOAD_BYTES + 2 * 1024 * 1024


@app.after_request
def _cors_upload(resp):
    # CORS terbatas: hanya untuk endpoint chunked yang diautentikasi token transfer
    if getattr(g, 'allow_cors', False):
        resp.headers['Access-Control-Allow-Origin'] = '*'
    return resp

IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'}
VIDEO_EXTS = {'.mp4', '.webm', '.mov', '.mkv', '.avi'}
AUDIO_EXTS = {'.mp3', '.ogg', '.wav', '.m4a'}


def login_required(f):
    @wraps(f)
    def wrapper(*a, **kw):
        if not session.get('logged_in') or not session.get('user_id'):
            if request.path.startswith('/api/'):
                return jsonify({'error': 'login dulu'}), 401
            return redirect(url_for('login', next=request.path))
        return f(*a, **kw)
    return wrapper


def admin_required(f):
    @wraps(f)
    def wrapper(*a, **kw):
        if not session.get('logged_in') or not session.get('user_id'):
            if request.path.startswith('/api/'):
                return jsonify({'error': 'login dulu'}), 401
            return redirect(url_for('login', next=request.path))
        if session.get('role') != 'admin':
            abort(403)
        return f(*a, **kw)
    return wrapper


def uid():
    return session.get('user_id')


def is_admin():
    return session.get('role') == 'admin'


def is_pro():
    if is_admin():
        return True
    if session.get('is_pro'):
        return True
    # lisensi: cek sekali per request (query ringan, lalu cache di g)
    if hasattr(g, '_pro_license'):
        return g._pro_license
    uid_ = session.get('user_id')
    g._pro_license = bool(uid_ and db.has_active_license(uid_))
    return g._pro_license


# ---------- paket lisensi ----------
LICENSE_TIERS = {
    'pro_monthly':  {'nama': 'PRO Bulanan',  'durasi_hari': 30,  'kuota_mb': 204800,  'max_upload_mb': 2048},
    'pro_yearly':   {'nama': 'PRO Tahunan',  'durasi_hari': 365,  'kuota_mb': 512000,  'max_upload_mb': 2048},
    'pro_lifetime': {'nama': 'PRO Lifetime', 'durasi_hari': None, 'kuota_mb': 1048576, 'max_upload_mb': 2048},
}
LICENSE_PRICES = {  # key setting -> tier
    'license_price_monthly': 'pro_monthly',
    'license_price_yearly': 'pro_yearly',
    'license_price_lifetime': 'pro_lifetime',
}


def _tier_info():
    out = []
    for key, t in LICENSE_TIERS.items():
        price_key = [k for k, v in LICENSE_PRICES.items() if v == key][0]
        out.append({'tier': key, 'nama': t['nama'], 'durasi_hari': t['durasi_hari'],
                    'kuota_mb': t['kuota_mb'], 'max_upload_mb': t['max_upload_mb'],
                    'harga': (db.get_setting(price_key, '') or '').strip()})
    return out


# ---------- batas upload ----------

CF_LIMIT_BYTES = 100 * 1024 * 1024  # batas Cloudflare per request (via domain)
RESUME_THRESHOLD_BYTES = 10 * 1024 * 1024  # >= ini pakai upload chunked/resume


def _user_tier(user_id):
    """Kembalikan tier lisensi aktif user (atau None)."""
    lic = db.get_active_license(user_id)
    return lic['tier'] if lic else None


def _max_upload_bytes(user_id):
    """Batas ukuran per file (byte) untuk user ini, dienforce di server."""
    pro = False
    if user_id:
        u = db.get_user(user_id)
        # samakan dengan is_pro(): admin selalu PRO, atau flag is_pro, atau lisensi aktif
        if u and (u['role'] == 'admin' or u['is_pro']):
            pro = True
        elif db.has_active_license(user_id):
            pro = True
    if not pro:
        # non-PRO: hanya bisa via domain -> kena batas Cloudflare
        return min(CF_LIMIT_BYTES, config.MAX_UPLOAD_BYTES)
    tier = _user_tier(user_id)
    tmax = (LICENSE_TIERS.get(tier, {}).get('max_upload_mb')
            if tier else None) or 2048
    return min(tmax * 1024 * 1024, config.MAX_UPLOAD_BYTES)


def _direct_base():
    return _norm_public_url(db.get_setting('direct_url', ''), 'http://').rstrip('/')


def _do_login_session(u):
    """Isi session Flask untuk user yang sudah tervalidasi (dipakai login biasa & handoff)."""
    session['logged_in'] = True
    session['user_id'] = u['id']
    session['username'] = u['username']
    session['role'] = u['role']
    session['is_pro'] = bool(u['is_pro'])
    session['unlocked_folders'] = []
    session.permanent = True
    db.log_activity('login', u['id'])


# ---------- rate limit login/registrasi (per worker, sederhana) ----------
_login_attempts = {}


def _rate_ok(ip):
    rec = _login_attempts.get(ip)
    return not rec or time.time() >= rec[1] or rec[0] < 5


def _rate_hit(ip):
    now = time.time()
    rec = _login_attempts.get(ip)
    if not rec or now >= rec[1]:
        _login_attempts[ip] = [1, now + 900]
    else:
        rec[0] += 1


def _rate_clear(ip):
    _login_attempts.pop(ip, None)


def detect_kind(filename):
    ext = os.path.splitext(filename.lower())[1]
    if ext in IMAGE_EXTS:
        return 'photo'
    if ext in VIDEO_EXTS:
        return 'video'
    if ext in AUDIO_EXTS:
        return 'audio'
    return 'doc'


def exif_taken_at(path):
    try:
        img = Image.open(path)
        exif = img.getexif()
        for tag_id, val in exif.items():
            if TAGS.get(tag_id) == 'DateTimeOriginal' and val:
                return datetime.strptime(str(val), '%Y:%m:%d %H:%M:%S').isoformat(timespec='seconds')
    except Exception:
        pass
    return None


def cache_path_for(file_id):
    return os.path.join(config.CACHE_DIR, file_id)


def enforce_cache_limit():
    try:
        files = []
        total = 0
        for name in os.listdir(config.CACHE_DIR):
            p = os.path.join(config.CACHE_DIR, name)
            if os.path.isfile(p):
                sz = os.path.getsize(p)
                total += sz
                files.append((os.path.getmtime(p), p, sz))
        if total <= config.CACHE_MAX_BYTES:
            return
        files.sort()
        for _, p, sz in files:
            try:
                os.remove(p)
            except OSError:
                pass
            total -= sz
            if total <= config.CACHE_MAX_BYTES:
                break
    except OSError:
        pass


def ensure_local_copy(rec, creds=None):
    """Pastikan file ada di cache lokal; unduh dari Telegram bila perlu."""
    p = cache_path_for(rec['file_id'])
    if os.path.exists(p) and os.path.getsize(p) == (rec['size'] or 0):
        return p
    tg.download_file(rec['file_id'], p, creds=creds)
    enforce_cache_limit()
    return p


# ---------- tema ----------
THEMES = {
    'gelap':   {'nama': 'Gelap'},
    'terang':  {'nama': 'Terang'},
    'senja':   {'nama': 'Senja'},
    'samudra': {'nama': 'Samudra'},
    'hutan':   {'nama': 'Hutan'},
}
DEFAULT_THEME = 'gelap'


def _user_theme(user_id):
    t = (db.get_user_setting(user_id, 'theme', DEFAULT_THEME) or DEFAULT_THEME)
    return t if t in THEMES else DEFAULT_THEME


@app.context_processor
def inject_user():
    u = None
    theme = DEFAULT_THEME
    display_name = session.get('username')
    if session.get('user_id'):
        u = db.get_user(session['user_id'])
        if u:
            display_name = u.get('display_name') or u.get('username')
            theme = _user_theme(u['id'])
    return {'nav_username': session.get('username'),
            'nav_display_name': display_name,
            'nav_is_admin': session.get('role') == 'admin',
            'nav_is_pro': is_pro(),
            'nav_theme': theme,
            'nav_themes': THEMES,
            'is_direct': _is_direct_host()}


def _is_direct_host():
    """True bila request ini datang lewat jalur langsung (direct_url admin).
    Dipakai template untuk label koneksi & batas 100MB — akurat untuk
    direct berupa IP maupun domain."""
    try:
        direct = _norm_public_url(db.get_setting('direct_url', ''), 'http://')
        if not direct:
            return False
        return urlparse(direct).netloc.lower() == (request.host or '').lower()
    except Exception:
        return False


@app.context_processor
def inject_asset_v():
    # Cache-buster otomatis untuk file statis: pakai mtime terbaru app.js/style.css,
    # jadi setiap deploy yang mengubah JS/CSS langsung terpakai klien (termasuk WebView).
    try:
        v = max(int(os.path.getmtime(os.path.join(app.root_path, 'static', f)))
                for f in ('app.js', 'style.css'))
    except Exception:
        v = 0
    return {'asset_v': v}


# ---------- halaman ----------

@app.route('/')
def index():
    if not session.get('logged_in'):
        return redirect(url_for('login'))
    return redirect(url_for('drive'))


@app.route('/login', methods=['GET', 'POST'])
def login():
    err = None
    if request.method == 'POST':
        ip = request.remote_addr or 'x'
        if not _rate_ok(ip):
            err = 'Terlalu banyak percobaan. Coba lagi 15 menit.'
        else:
            un = (request.form.get('username') or '').strip()
            pw = request.form.get('password', '')
            u = db.get_user_auth(un)
            if u and u['is_active'] and u['password_hash'] and check_password_hash(u['password_hash'], pw):
                _rate_clear(ip)
                _do_login_session(u)
                nxt = request.args.get('next') or url_for('drive')
                return redirect(nxt)
            _rate_hit(ip)
            err = 'Username atau password salah.'
    return render_template('login.html', err=err)


@app.route('/register', methods=['GET', 'POST'])
def register():
    mode = db.get_setting('registration_mode', 'open')
    err = None
    if mode == 'closed':
        return render_template('register.html', err='Pendaftaran sedang ditutup.', closed=True, mode=mode)
    if request.method == 'POST':
        ip = request.remote_addr or 'x'
        if not _rate_ok(ip):
            err = 'Terlalu banyak percobaan. Coba lagi 15 menit.'
        else:
            un = (request.form.get('username') or '').strip()
            pw = request.form.get('password', '')
            pw2 = request.form.get('password2', '')
            code = (request.form.get('invite_code') or '').strip()
            bonus = 0
            if len(un) < 3 or len(un) > 40 or not re.match(r'^[A-Za-z0-9_.-]+$', un):
                err = 'Username 3–40 karakter (huruf/angka/._-).'
            elif len(pw) < 8:
                err = 'Password minimal 8 karakter.'
            elif pw != pw2:
                err = 'Konfirmasi password tidak sama.'
            elif mode == 'invite' or code:
                b = db.redeem_invite_code(code)
                if b is None:
                    err = 'Kode undangan tidak valid / sudah habis.'
                else:
                    bonus = b
            if not err:
                try:
                    new_id = db.create_user(un, generate_password_hash(pw),
                                          quota_mb=102400 + bonus)
                except sqlite3.IntegrityError:
                    err = 'Username sudah dipakai.'
                    _rate_hit(ip)
                else:
                    u = db.get_user(new_id)
                    session['logged_in'] = True
                    session['user_id'] = u['id']
                    session['username'] = u['username']
                    session['role'] = u['role']
                    session['is_pro'] = False
                    session['unlocked_folders'] = []
                    session.permanent = True
                    db.log_activity('register', new_id)
                    return redirect(url_for('drive'))
            else:
                _rate_hit(ip)
    return render_template('register.html', err=err, closed=False, mode=mode)


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


# ---------- handoff login antar-domain (pindah domain/direct tanpa login ulang) ----------

def _handoff_ttl():
    try:
        v = int(db.get_setting('handoff_token_ttl', 90) or 90)
    except (TypeError, ValueError):
        v = 90
    return max(10, min(600, v))


@app.route('/api/handoff-token', methods=['POST'])
@login_required
def api_handoff_token():
    """Buatkan token login sekali pakai untuk user saat ini (dipakai pindah domain)."""
    return jsonify({'token': db.create_login_token(uid(), _handoff_ttl())})


@app.route('/auth/handoff')
def auth_handoff():
    """Tukar token sekali pakai menjadi session login, lalu redirect ke `next`."""
    token = request.args.get('token') or ''
    nxt = request.args.get('next') or url_for('drive')
    # cegah open-redirect: hanya path relatif internal
    if not nxt.startswith('/') or nxt.startswith('//'):
        nxt = url_for('drive')
    user_id = db.consume_login_token(token)
    if not user_id:
        return redirect(url_for('login', next=nxt, err='handoff'))
    u = db.get_user(user_id)
    if not u or not u['is_active']:
        return redirect(url_for('login', next=nxt))
    _do_login_session(u)
    db.log_activity('handoff_login', user_id)
    return redirect(nxt)


def fmt_size(b):
    b = float(b or 0)
    if b < 1024:
        return '%d B' % b
    for u in ('KB', 'MB', 'GB'):
        b /= 1024
        if b < 1024:
            return '%.1f %s' % (b, u)
    return '%.1f TB' % b


def tg_configured():
    acc = db.get_active_account(uid()) if uid() else None
    if acc and acc.get('bot_token') and acc.get('channel_id'):
        return True
    return config.tg_configured()


def active_account():
    return db.get_active_account(uid()) if uid() else None


def _user_creds(user_id=None, account_id=None):
    """(token, channel) untuk user; pakai akun Telegram aktifnya (atau akun tertentu)."""
    u = user_id or uid()
    if not u:
        return None
    acc = db.get_account(account_id, u) if account_id else db.get_active_account(u)
    if not acc or not acc.get('bot_token'):
        return None
    return (acc['bot_token'], acc['channel_id'])


def _creds_for_file(rec):
    """Kredensial untuk sebuah file: pakai akun pemilik file, fallback akun aktif."""
    c = _user_creds(user_id=rec.get('user_id'), account_id=rec.get('account_id'))
    return c or _user_creds(user_id=rec.get('user_id'))


@app.route('/settings')
@login_required
def settings():
    return render_template('settings.html', configured=tg_configured(),
                           username=session.get('username'), is_pro=is_pro(), is_admin=is_admin())


@app.route('/drive')
@login_required
def drive():
    return render_template('drive.html', configured=tg_configured(),
                           stats=db.count_storage(uid()), is_pro=is_pro(), is_admin=is_admin())


@app.route('/photos')
@login_required
def photos():
    return render_template('photos.html', configured=tg_configured())


@app.route('/activity')
@login_required
def activity():
    return render_template('activity.html', configured=tg_configured())


@app.route('/api/activity')
@login_required
def api_activity():
    action = request.args.get('action') or None
    q = request.args.get('q', '').strip() or None
    datef = request.args.get('date') or ''
    order = request.args.get('order', 'desc')
    try:
        limit = max(1, min(200, int(request.args.get('limit', 50))))
    except (TypeError, ValueError):
        limit = 50
    try:
        offset = max(0, int(request.args.get('offset', 0)))
    except (TypeError, ValueError):
        offset = 0
    since = None
    until = None
    now = datetime.now()
    today0 = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if datef == 'today':
        since = today0.isoformat()
    elif datef == 'yesterday':
        since = (today0 - timedelta(days=1)).isoformat()
        until = today0.isoformat()
    elif datef in ('7', '30'):
        since = (now - timedelta(days=int(datef))).isoformat()
    items = db.list_activity(uid(), action=action, q=q, since=since, until=until, order=order,
                             limit=limit, offset=offset)
    return jsonify({'items': items, 'has_more': len(items) == limit})


# ---------- API ----------

@app.route('/api/files')
@login_required
def api_files():
    folder = request.args.get('folder')
    if folder == 'all':
        folder_id = None  # semua folder (dipakai halaman Foto)
    elif folder in (None, '', 'root'):
        folder_id = 'null'
    else:
        folder_id = folder
    # folder spesifik yang terkunci -> 403 agar frontend bisa meminta PIN
    if folder_id not in (None, 'null'):
        try:
            if not folder_accessible(int(folder_id)):
                return jsonify({'error': 'Folder terkunci — buka dengan PIN dulu', 'locked': True}), 403
        except (TypeError, ValueError):
            pass
    # purge otomatis: file di tong sampah > 7 hari dihapus permanen (termasuk dari Telegram)
    if request.args.get('trashed') == '1':
        for f in db.trashed_older_than(uid(), days=7):
            try:
                _permanent_delete(f)
            except Exception:
                pass
    files = db.list_files(uid(),
        folder_id=folder_id,
        q=request.args.get('q', '').strip() or None,
        sort=request.args.get('sort', 'date'),
        order=request.args.get('order', 'desc'),
        trashed=1 if request.args.get('trashed') == '1' else 0,
        favorites_only=request.args.get('fav') == '1',
        kind_in=request.args.get('kinds').split(',') if request.args.get('kinds') else None,
    )
    # sembunyikan isi folder terkunci dari tampilan gabungan (Foto, pencarian, favorit, sampah)
    files, locked_hidden = _filter_locked(files)
    return jsonify({'files': files, 'locked_hidden': locked_hidden})


@app.route('/api/folders')
@login_required
def api_folders():
    return jsonify({'folders': db.list_folders(uid())})


@app.route('/api/folders', methods=['POST'])
@login_required
def api_folder_create():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Nama folder wajib diisi'}), 400
    parent_id = data.get('parent_id')
    try:
        parent_id = int(parent_id) if parent_id not in (None, '') else None
    except (TypeError, ValueError):
        parent_id = None
    if parent_id and not db.get_folder(parent_id, uid()):
        return jsonify({'error': 'Folder induk tidak ditemukan'}), 404
    fid = db.add_folder(name[:80], uid(), parent_id)
    db.log_activity('create_folder', uid(), folder_id=fid, folder_name=name[:80])
    return jsonify({'id': fid, 'name': name[:80]})


@app.route('/api/folders/ensure', methods=['POST'])
@login_required
def api_folder_ensure():
    """Find-or-create satu segmen folder (dipakai saat upload folder agar tidak duplikat)."""
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Nama folder wajib diisi'}), 400
    parent_id = data.get('parent_id')
    try:
        parent_id = int(parent_id) if parent_id not in (None, '') else None
    except (TypeError, ValueError):
        parent_id = None
    fid = db.find_folder(name[:80], parent_id)
    created = False
    if not fid:
        fid = db.add_folder(name[:80], uid(), parent_id)
        db.log_activity('create_folder', uid(), folder_id=fid, folder_name=name[:80])
        created = True
    return jsonify({'id': fid, 'created': created})


@app.route('/api/folders/<int:fid>/properties')
@login_required
def api_folder_properties(fid):
    """Properties folder ala file explorer: ukuran total (rekursif), isi, tanggal dibuat."""
    f = db.get_folder(fid, uid())
    if not f:
        return jsonify({'error': 'Folder tidak ditemukan'}), 404
    if not folder_accessible(fid):
        return jsonify({'error': 'Folder terkunci — buka dengan PIN dulu', 'locked': True}), 403
    st = db.folder_stats(fid, uid())
    return jsonify({'id': f['id'], 'name': f['name'], 'created_at': f.get('created_at'),
                    'size': st['size'], 'files': st['files'], 'folders': st['folders']})


@app.route('/api/folders/<int:fid>/rename', methods=['POST'])
@login_required
def api_folder_rename(fid):
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Nama folder wajib diisi'}), 400
    old = db.get_folder(fid, uid())
    if not old:
        return jsonify({'error': 'Folder tidak ditemukan'}), 404
    if not folder_accessible(fid):
        return jsonify({'error': 'Folder terkunci — buka dengan PIN dulu', 'locked': True}), 403
    db.rename_folder(fid, uid(), name)
    db.log_activity('rename_folder', uid(), folder_id=fid, folder_name=name,
                    detail=('%s → %s' % (old['name'], name)) if old else None)
    return jsonify({'ok': True})


@app.route('/api/folders/<int:fid>', methods=['DELETE'])
@login_required
def api_folder_delete(fid):
    old = db.get_folder(fid, uid())
    if old and not folder_accessible(fid):
        return jsonify({'error': 'Folder terkunci — buka dengan PIN dulu', 'locked': True}), 403
    n = db.delete_folder(fid, uid())
    db.log_activity('delete_folder', uid(), folder_name=old['name'] if old else None,
                    detail='%d file dipindah ke tong sampah' % n)
    return jsonify({'ok': True, 'trashed_files': n})


# ---------- kunci folder ----------

PIN_RE = re.compile(r'^\d{4,12}$')


def _pin_hash():
    return db.get_user_setting(uid(), 'folder_lock_pin_hash')


def _unlocked_ids():
    return set(session.get('unlocked_folders') or [])


def folder_accessible(fid, user_id=None):
    """True bila folder bisa diakses: tidak terkunci, atau sudah dibuka dgn PIN sesi ini."""
    if not fid:
        return True
    u = user_id or uid()
    unlocked = _unlocked_ids() if user_id is None or user_id == uid() else []
    pmap = db.folder_parent_map(u)
    seen, cur = set(), fid
    while cur and cur not in seen:
        seen.add(cur)
        if cur in unlocked:
            return True
        parent, is_locked = pmap.get(cur, (None, 0))
        if is_locked:
            return False
        cur = parent
    return True


def _filter_locked(files):
    """Sembunyikan file di folder terkunci (kecuali sudah dibuka sesi ini).

    Mengembalikan (files_terlihat, jumlah_disembunyikan)."""
    locked = db.locked_subtree_ids(uid())
    if not locked:
        return files, 0
    unlocked = _unlocked_ids()
    pmap = db.folder_parent_map(uid())
    kept, n = [], 0
    for f in files:
        fid = f.get('folder_id')
        if fid and fid in locked and not any(c in unlocked for c in db.folder_chain_ids(fid, pmap, uid())):
            n += 1
            continue
        kept.append(f)
    return kept, n


@app.route('/api/lock/status')
@login_required
def api_lock_status():
    return jsonify({'pin_set': bool(_pin_hash()), 'unlocked': sorted(_unlocked_ids())})


@app.route('/api/lock/pin', methods=['POST'])
@login_required
def api_lock_pin():
    data = request.get_json(force=True, silent=True) or {}
    pin = (data.get('pin') or '').strip()
    old = _pin_hash()
    if old and not check_password_hash(old, (data.get('old_pin') or '').strip()):
        return jsonify({'error': 'PIN lama salah'}), 403
    if not PIN_RE.match(pin):
        return jsonify({'error': 'PIN harus 4–12 digit angka'}), 400
    db.set_user_setting(uid(), 'folder_lock_pin_hash', generate_password_hash(pin))
    db.log_activity('set_lock_pin', uid())
    return jsonify({'ok': True})


@app.route('/api/lock/unlock', methods=['POST'])
@login_required
def api_lock_unlock():
    data = request.get_json(force=True, silent=True) or {}
    try:
        fid = int(data.get('folder_id'))
    except (TypeError, ValueError):
        return jsonify({'error': 'folder_id tidak valid'}), 400
    h = _pin_hash()
    if not h:
        return jsonify({'error': 'PIN belum diatur di Pengaturan'}), 400
    if not check_password_hash(h, (data.get('pin') or '').strip()):
        return jsonify({'error': 'PIN salah'}), 403
    f = db.get_folder(fid, uid())
    if not f:
        return jsonify({'error': 'Folder tidak ditemukan'}), 404
    u = _unlocked_ids()
    u.add(fid)
    session['unlocked_folders'] = sorted(u)
    db.log_activity('unlock_folder', uid(), folder_id=fid, folder_name=f['name'])
    return jsonify({'ok': True})


@app.route('/api/lock/relock', methods=['POST'])
@login_required
def api_lock_relock():
    session['unlocked_folders'] = []
    db.log_activity('relock_all', uid())
    return jsonify({'ok': True})


@app.route('/api/folders/<int:fid>/lock', methods=['POST'])
@login_required
def api_folder_lock(fid):
    data = request.get_json(force=True, silent=True) or {}
    locked = bool(data.get('locked', True))
    f = db.get_folder(fid, uid())
    if not f:
        return jsonify({'error': 'Folder tidak ditemukan'}), 404
    if not locked:
        # melepas kunci butuh PIN agar kunci tidak gampang dibobol dari sesi terbuka
        h = _pin_hash()
        if not h or not check_password_hash(h, (data.get('pin') or '').strip()):
            return jsonify({'error': 'PIN salah'}), 403
    db.set_folder_lock(fid, uid(), locked)
    if locked:
        u = _unlocked_ids()
        u.discard(fid)
        session['unlocked_folders'] = sorted(u)
    db.log_activity('lock_folder' if locked else 'unlock_folder_flag', uid(),
                    folder_id=fid, folder_name=f['name'])
    return jsonify({'ok': True, 'is_locked': locked})


@app.route('/api/files/<int:fid>/rename', methods=['POST'])
@login_required
def api_file_rename(fid):
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Nama file wajib diisi'}), 400
    rec = db.get_file(fid, uid())
    if not rec:
        return jsonify({'error': 'File tidak ketemu'}), 404
    db.rename_file(fid, uid(), name)
    db.log_activity('rename_file', uid(), file_id=fid, file_name=name,
                    detail='%s → %s' % (rec['name'], name))
    return jsonify({'ok': True})


@app.route('/api/check-duplicate', methods=['POST'])
@login_required
def api_check_duplicate():
    """Cek apakah file dengan nama+ukuran sama sudah ada (di folder & akun aktif)."""
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get('name') or '').strip()
    try:
        size = int(data.get('size') or 0)
    except (TypeError, ValueError):
        size = 0
    folder = data.get('folder_id')
    folder_id = int(folder) if (isinstance(folder, str) and folder.isdigit()) else None
    if not name or size <= 0:
        return jsonify({'duplicate': False})
    dup = db.check_duplicate(name, size, uid(), folder_id)
    return jsonify({
        'duplicate': bool(dup),
        'existing_id': dup['id'] if dup else None,
        'existing_date': dup['uploaded_at'] if dup else None,
    })


def _process_upload_file(tmp_path, orig_name, size, folder_id, overwrite_id, creds,
                          user_id, t0, old_rec=None):
    """Kirim file lokal ke Telegram + catat DB. Dipakai upload biasa & chunked."""
    kind = detect_kind(orig_name)
    mime = mimetypes.guess_type(orig_name)[0]
    taken = exif_taken_at(tmp_path) if kind == 'photo' else None
    caption = orig_name[:900]

    if kind == 'photo':
        meta = tg.send_photo(tmp_path, caption, creds=creds)
    elif kind == 'video':
        meta = tg.send_video(tmp_path, caption, creds=creds)
    else:
        meta = tg.send_document(tmp_path, orig_name, caption, creds=creds)
    if not meta.get('file_id'):
        raise tg.TgError('Telegram tidak mengembalikan file_id')

    w, h = meta.get('width'), meta.get('height')
    if kind == 'photo' and (not w or not h):
        try:
            with Image.open(tmp_path) as im:
                w, h = im.size
        except Exception:
            pass

    new_rec = {
        'name': orig_name[:200], 'kind': kind, 'mime': mime, 'size': size,
        'file_id': meta['file_id'], 'thumb_file_id': meta.get('thumb_file_id'),
        'message_id': meta.get('message_id'), 'width': w, 'height': h,
        'duration': meta.get('duration'), 'taken_at': taken, 'folder_id': folder_id,
        'user_id': user_id,
    }
    if old_rec:
        # TIMPA: ganti isi file lama, hapus pesan Telegram yang lama
        db.update_file_storage(old_rec['id'], user_id, new_rec)
        if old_rec.get('message_id'):
            tg.delete_message(old_rec['message_id'], creds=creds)
        # hapus cache lokal versi lama (file + thumbnail)
        for _cp in (cache_path_for(old_rec['file_id']),
                    os.path.join(config.THUMB_DIR, (old_rec.get('thumb_file_id') or '') + '.jpg')):
            try:
                if _cp and os.path.exists(_cp):
                    os.remove(_cp)
            except OSError:
                pass
        fid = old_rec['id']
    else:
        fid = db.add_file(new_rec)
    dur = max(0.1, time.time() - t0)
    spd = size / dur
    db.log_activity('overwrite' if old_rec else 'upload', user_id,
                    file_id=fid, file_name=orig_name[:200], folder_id=folder_id,
                    detail='%s • %.0f dtk • %s/dtk' % (fmt_size(size), dur, fmt_size(spd)))
    return fid, bool(old_rec)


@app.route('/api/upload', methods=['POST'])
@login_required
def api_upload():
    if not tg_configured():
        return jsonify({'error': 'Akun Telegram belum dikonfigurasi. Tambahkan di halaman Pengaturan.'}), 500
    creds = _user_creds()
    if not creds:
        return jsonify({'error': 'Akun Telegram belum dikonfigurasi.'}), 500
    # cek kuota user
    me_u = db.get_user(uid())
    quota_bytes = (me_u['quota_mb'] if me_u else 102400) * 1024 * 1024
    up = request.files.get('file')
    if not up or not up.filename:
        return jsonify({'error': 'Tidak ada file'}), 400
    folder_id = request.form.get('folder_id')
    folder_id = int(folder_id) if (folder_id and folder_id.isdigit()) else None
    if folder_id and not folder_accessible(folder_id):
        return jsonify({'error': 'Folder terkunci — buka dengan PIN dulu', 'locked': True}), 403
    overwrite_id = request.form.get('overwrite_id')
    overwrite_id = int(overwrite_id) if (overwrite_id and overwrite_id.isdigit()) else None
    old_rec = db.get_file(overwrite_id, uid()) if overwrite_id else None

    orig_name = up.filename
    if len(orig_name.encode('utf-8', 'ignore')) > 200:
        orig_name = orig_name[:200]
    tmp_name = uuid.uuid4().hex + '_' + secure_filename(orig_name)
    tmp_path = os.path.join(config.TMP_DIR, tmp_name)
    t0 = time.time()
    try:
        up.save(tmp_path)
        size = os.path.getsize(tmp_path)
        if size > _max_upload_bytes(uid()):
            return jsonify({'error': 'File maksimal %s.' % fmt_size(_max_upload_bytes(uid()))}), 413
        if not old_rec and db.user_storage_bytes(uid()) + size > quota_bytes:
            return jsonify({'error': 'Kuota penyimpanan habis (%s).' % fmt_size(quota_bytes)}), 413
        fid, overwritten = _process_upload_file(tmp_path, orig_name, size, folder_id,
                                                overwrite_id, creds, uid(), t0, old_rec)
        return jsonify({'ok': True, 'id': fid, 'overwritten': overwritten})
    except tg.TgError as e:
        return jsonify({'error': 'Telegram: %s' % e}), 502
    except Exception as e:
        return jsonify({'error': 'Gagal upload: %s' % e}), 500
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


# ---------- upload chunked / resume (file besar) ----------

def _chunk_auth():
    """Auth untuk endpoint chunk: session cookie ATAU transfer token (lintas origin).

    Kembalikan (user_id, upload_session) atau (None, error_response).
    Token hanya berlaku untuk upload_id yang terikat padanya.
    """
    tok = request.form.get('transfer_token') or request.args.get('transfer_token')
    sid = request.form.get('upload_id') or request.args.get('upload_id')
    if tok:
        t = db.consume_transfer_token(hashlib.sha256(tok.encode()).hexdigest(),
                                      'upload', single_use=False)
        if not t:
            return None, (jsonify({'error': 'Token transfer tidak valid/kedaluwarsa.'}), 401)
        # CORS: auth via token di body (tanpa cookie) -> aman buka untuk origin mana pun
        g.allow_cors = True
        s = db.get_upload_session(t['ref_id'])
        if not s or s['user_id'] != t['user_id'] or s['status'] not in ('active', 'done'):
            return None, (jsonify({'error': 'Sesi upload tidak valid.'}), 404)
        if sid and sid != s['id']:
            return None, (jsonify({'error': 'Token tidak cocok dengan sesi upload.'}), 403)
        return t['user_id'], s
    if not session.get('logged_in'):
        return None, (jsonify({'error': 'Belum login.'}), 401)
    s = db.get_upload_session(sid, uid()) if sid else None
    if not s:
        return None, (jsonify({'error': 'Sesi upload tidak ditemukan.'}), 404)
    # 'done' diizinkan lewat (untuk complete yang idempotent); tiap endpoint memutuskan
    if s['status'] not in ('active', 'done'):
        return None, (jsonify({'error': 'Sesi upload sudah %s.' % s['status']}), 410)
    return uid(), s


@app.route('/api/upload/init', methods=['POST'])
@login_required
def api_upload_init():
    """Mulai sesi upload chunked. Tentukan target: domain (file <100MB) atau
    direct (PRO, file >=100MB). Untuk lintas origin, berikan transfer token."""
    if not tg_configured():
        return jsonify({'error': 'Akun Telegram belum dikonfigurasi.'}), 500
    if not _user_creds():
        return jsonify({'error': 'Akun Telegram belum dikonfigurasi.'}), 500
    data = request.get_json(force=True, silent=True) or {}
    try:
        file_size = int(data.get('file_size') or 0)
    except (TypeError, ValueError):
        file_size = 0
    name = (data.get('name') or '').strip()[:200]
    if not name or file_size <= 0:
        return jsonify({'error': 'Nama/ukuran file tidak valid.'}), 400
    folder_id = data.get('folder_id')
    folder_id = int(folder_id) if (isinstance(folder_id, int) or
                                  (isinstance(folder_id, str) and folder_id.isdigit())) else None
    if folder_id and not folder_accessible(folder_id):
        return jsonify({'error': 'Folder terkunci — buka dengan PIN dulu', 'locked': True}), 403
    overwrite_id = data.get('overwrite_id')
    overwrite_id = int(overwrite_id) if (isinstance(overwrite_id, int) or
                                        (isinstance(overwrite_id, str) and str(overwrite_id).isdigit())) else None
    old_rec = db.get_file(overwrite_id, uid()) if overwrite_id else None

    maxb = _max_upload_bytes(uid())
    if file_size > maxb:
        return jsonify({'error': 'File maksimal %s.' % fmt_size(maxb)}), 413
    me_u = db.get_user(uid())
    quota_bytes = (me_u['quota_mb'] if me_u else 102400) * 1024 * 1024
    if not old_rec and db.user_storage_bytes(uid()) + file_size > quota_bytes:
        return jsonify({'error': 'Kuota penyimpanan habis (%s).' % fmt_size(quota_bytes)}), 413

    pro = is_pro()
    # 2 mode upload:
    #  - <100MB: single POST via domain (mode 1, kode lama)
    #  - >=100MB: chunked via direct + token (mode 2, khusus PRO) — hindari timeout Cloudflare
    need_direct = file_size >= CF_LIMIT_BYTES
    if need_direct and not pro:
        return jsonify({'error': 'File di atas 100 MB khusus pengguna PRO.'}), 403
    chunked_on = (db.get_setting('chunked_upload', '1') or '1') == '1'
    if need_direct and not chunked_on:
        return jsonify({'error': 'Mode upload resume dimatikan admin.', 'chunked_off': True}), 403
    direct_base = _direct_base()
    if need_direct and not direct_base:
        return jsonify({'error': 'Jalur langsung belum diatur admin.'}), 500

    # idempotency: retry init dengan client_key yang sama -> kembalikan sesi aktif
    client_key = (data.get('client_key') or '').strip()[:64] or None
    if client_key:
        old = db.get_upload_session_by_client_key(client_key, uid())
        if old:
            try:
                rec = json.loads(old['received'] or '[]')
            except Exception:
                rec = []
            out = {'ok': True, 'upload_id': old['id'], 'chunk_size': old['chunk_size'],
                   'total_chunks': old['total_chunks'], 'resumed': True,
                   'received': len(rec), 'target': 'direct' if need_direct else 'domain'}
            if need_direct:
                raw = secrets.token_urlsafe(32)
                db.create_transfer_token(hashlib.sha256(raw.encode()).hexdigest(), uid(),
                                         'upload', ref_id=old['id'], ttl_seconds=24 * 3600)
                out['direct_url'] = direct_base
                out['transfer_token'] = raw
            return jsonify(out)

    chunk_size = (10 * 1024 * 1024) if file_size >= 500 * 1024 * 1024 else (5 * 1024 * 1024)
    total_chunks = (file_size + chunk_size - 1) // chunk_size
    sid = uuid.uuid4().hex
    tmp_path = os.path.join(config.TMP_DIR, 'chunk_' + sid + '.part')
    # buat file sparse sebesar file_size agar tulis acak per chunk aman
    try:
        with open(tmp_path, 'wb') as fh:
            fh.truncate(file_size)
    except OSError:
        return jsonify({'error': 'Gagal menyiapkan ruang sementara.'}), 500
    db.create_upload_session(sid, uid(), name, file_size, chunk_size, total_chunks,
                             tmp_path, folder_id, overwrite_id, client_key=client_key)

    out = {'ok': True, 'upload_id': sid, 'chunk_size': chunk_size,
           'total_chunks': total_chunks, 'target': 'direct' if need_direct else 'domain'}
    if need_direct:
        # token lintas origin: terikat upload_id ini, 24 jam, multi-pakai dalam TTL
        raw = secrets.token_urlsafe(32)
        db.create_transfer_token(hashlib.sha256(raw.encode()).hexdigest(), uid(),
                                 'upload', ref_id=sid, ttl_seconds=24 * 3600)
        out['direct_url'] = direct_base
        out['transfer_token'] = raw
    return jsonify(out)


@app.route('/api/upload/sessions', methods=['GET'])
@login_required
def api_upload_sessions():
    """Daftar sesi upload aktif user (untuk resume lintas buka aplikasi)."""
    ss = db.list_active_upload_sessions(uid())
    out = []
    for s in ss:
        try:
            rec = json.loads(s['received'] or '[]')
        except Exception:
            rec = []
        out.append({'upload_id': s['id'], 'name': s['file_name'], 'size': s['file_size'],
                    'chunk_size': s['chunk_size'], 'total_chunks': s['total_chunks'],
                    'received': len(rec), 'folder_id': s['folder_id']})
    return jsonify({'sessions': out})


@app.route('/api/upload/chunk', methods=['POST'])
def api_upload_chunk():
    """Terima satu chunk. Auth: session cookie atau transfer token."""
    user_id, res = _chunk_auth()
    if user_id is None:
        return res
    s = res
    try:
        idx = int(request.form.get('chunk_index'))
    except (TypeError, ValueError):
        return jsonify({'error': 'chunk_index tidak valid.'}), 400
    if not (0 <= idx < s['total_chunks']):
        return jsonify({'error': 'chunk_index di luar rentang.'}), 400
    ch = request.files.get('chunk')
    if not ch:
        return jsonify({'error': 'Tidak ada data chunk.'}), 400
    # tulis di offset yang tepat (mendukung kirim ulang / urutan acak)
    try:
        data = ch.read()
        expect = s['chunk_size'] if idx < s['total_chunks'] - 1 else \
            (s['file_size'] - s['chunk_size'] * (s['total_chunks'] - 1))
        if len(data) != expect:
            return jsonify({'error': 'Ukuran chunk tidak sesuai.'}), 400
        with open(s['tmp_path'], 'r+b') as fh:
            fh.seek(idx * s['chunk_size'])
            fh.write(data)
    except OSError:
        return jsonify({'error': 'Gagal menulis chunk.'}), 500
    n = db.add_upload_chunk(s['id'], idx)
    return jsonify({'ok': True, 'received': n, 'total': s['total_chunks']})


@app.route('/api/upload/status', methods=['GET'])
def api_upload_status():
    """Chunk mana saja yang sudah diterima (untuk resume)."""
    user_id, res = _chunk_auth()
    if user_id is None:
        return res
    s = res
    try:
        rec = json.loads(s['received'] or '[]')
    except Exception:
        rec = []
    return jsonify({'ok': True, 'upload_id': s['id'], 'received': sorted(rec),
                    'total_chunks': s['total_chunks'], 'chunk_size': s['chunk_size'],
                    'name': s['file_name'], 'size': s['file_size'],
                    'folder_id': s['folder_id']})


@app.route('/api/upload/complete', methods=['POST'])
def api_upload_complete():
    """Semua chunk lengkap -> rakit & proses seperti upload biasa. Idempotent:
    retry dengan upload_id yang sama mengembalikan hasil tersimpan."""
    user_id, res = _chunk_auth()
    if user_id is None:
        return res
    s = res
    # sudah pernah complete -> kembalikan hasil tersimpan (anti duplikat)
    if s['status'] == 'done' and s.get('result_file_id'):
        return jsonify({'ok': True, 'id': s['result_file_id'], 'duplicate': True})
    try:
        rec = set(json.loads(s['received'] or '[]'))
    except Exception:
        rec = set()
    if len(rec) < s['total_chunks']:
        return jsonify({'error': 'Masih kurang %d potongan.' % (s['total_chunks'] - len(rec)),
                        'missing': sorted(set(range(s['total_chunks'])) - rec)}), 409
    if not tg_configured():
        return jsonify({'error': 'Akun Telegram belum dikonfigurasi.'}), 500
    creds = _user_creds(user_id=user_id)
    if not creds:
        return jsonify({'error': 'Akun Telegram belum dikonfigurasi.'}), 500
    t0 = time.time()
    try:
        actual = os.path.getsize(s['tmp_path'])
        if actual != s['file_size']:
            return jsonify({'error': 'Ukuran rakitan tidak sesuai (%s vs %s).' %
                            (fmt_size(actual), fmt_size(s['file_size']))}), 500
        old_rec = db.get_file(s['overwrite_id'], user_id) if s['overwrite_id'] else None
        # cek ulang kuota saat finalisasi
        me_u = db.get_user(user_id)
        quota_bytes = (me_u['quota_mb'] if me_u else 102400) * 1024 * 1024
        if not old_rec and db.user_storage_bytes(user_id) + s['file_size'] > quota_bytes:
            return jsonify({'error': 'Kuota penyimpanan habis.'}), 413
        fid, overwritten = _process_upload_file(s['tmp_path'], s['file_name'], s['file_size'],
                                                s['folder_id'], s['overwrite_id'],
                                                creds, user_id, t0, old_rec)
        # tandai done + simpan hasil (sesi dihapus oleh cleanup 24 jam; retry aman)
        db.set_upload_session_status(s['id'], 'done', result_file_id=fid)
        try:
            os.remove(s['tmp_path'])
        except OSError:
            pass
        return jsonify({'ok': True, 'id': fid, 'overwritten': overwritten})
    except tg.TgError as e:
        return jsonify({'error': 'Telegram: %s' % e}), 502
    except Exception as e:
        return jsonify({'error': 'Gagal merakit: %s' % e}), 500


@app.route('/api/upload/cancel', methods=['POST'])
def api_upload_cancel():
    user_id, res = _chunk_auth()
    if user_id is None:
        return res
    s = res
    try:
        if s['tmp_path'] and os.path.exists(s['tmp_path']):
            os.remove(s['tmp_path'])
    except OSError:
        pass
    db.delete_upload_session(s['id'])
    return jsonify({'ok': True})


@app.route('/api/download-token', methods=['POST'])
@login_required
def api_download_token():
    """Token download lintas origin untuk file besar (via direct)."""
    data = request.get_json(force=True, silent=True) or {}
    try:
        fid = int(data.get('file_id') or 0)
    except (TypeError, ValueError):
        return jsonify({'error': 'file_id tidak valid.'}), 400
    rec = db.get_file(fid, uid())
    if not rec or rec['trashed']:
        return jsonify({'error': 'File tidak ditemukan.'}), 404
    if not folder_accessible(rec.get('folder_id')):
        return jsonify({'error': 'Folder terkunci.'}), 403
    raw = secrets.token_urlsafe(32)
    db.create_transfer_token(hashlib.sha256(raw.encode()).hexdigest(), uid(),
                             'download', ref_id=str(fid), ttl_seconds=15 * 60)
    direct_base = _direct_base()
    if not direct_base:
        return jsonify({'error': 'Jalur langsung belum diatur admin.'}), 500
    return jsonify({'ok': True, 'token': raw,
                    'url': direct_base + '/file/%d/download?token=%s' % (fid, raw)})



@app.route('/api/files/<int:fid>/trash', methods=['POST'])
@login_required
def api_trash(fid):
    rec = db.get_file(fid, uid())
    db.set_trashed(fid, uid(), True)
    db.log_activity('trash', uid(), file_id=fid, file_name=rec['name'] if rec else None)
    return jsonify({'ok': True})


@app.route('/api/files/<int:fid>/restore', methods=['POST'])
@login_required
def api_restore(fid):
    rec = db.get_file(fid, uid())
    db.set_trashed(fid, uid(), False)
    db.log_activity('restore', uid(), file_id=fid, file_name=rec['name'] if rec else None)
    return jsonify({'ok': True})


def _permanent_delete(rec):
    """Hapus permanen satu file: pesan Telegram + cache + baris DB + log aktivitas.

    Dipakai oleh hapus permanen manual, kosongkan sampah, dan purge otomatis.
    Gagal hapus pesan Telegram tidak menggagalkan (best effort)."""
    if rec.get('message_id'):
        tg.delete_message(rec['message_id'], creds=_creds_for_file(rec))  # best effort
    for p in (cache_path_for(rec['file_id']),
              os.path.join(config.THUMB_DIR, (rec.get('thumb_file_id') or '') + '.jpg')):
        try:
            if p and os.path.exists(p):
                os.remove(p)
        except OSError:
            pass
    db.delete_file(rec['id'], rec['user_id'])
    db.log_activity('delete', rec['user_id'], file_name=rec['name'])


@app.route('/api/files/<int:fid>', methods=['DELETE'])
@login_required
def api_delete(fid):
    rec = db.get_file(fid, uid())
    if not rec:
        return jsonify({'error': 'Tidak ketemu'}), 404
    _permanent_delete(rec)
    return jsonify({'ok': True})


@app.route('/api/trash/empty', methods=['POST'])
@login_required
def api_trash_empty():
    """Kosongkan tong sampah: hapus permanen semua file di sampah (termasuk pesan Telegram)."""
    files = db.list_files(uid(), trashed=1)
    n, gagal = 0, 0
    for f in files:
        try:
            _permanent_delete(f)
            n += 1
        except Exception:
            gagal += 1
    return jsonify({'ok': True, 'deleted': n, 'failed': gagal})


@app.route('/api/files/<int:fid>/favorite', methods=['POST'])
@login_required
def api_fav(fid):
    data = request.get_json(force=True, silent=True) or {}
    fav = bool(data.get('fav', True))
    rec = db.get_file(fid, uid())
    db.set_favorite(fid, uid(), fav)
    db.log_activity('favorite' if fav else 'unfavorite', uid(),
                    file_id=fid, file_name=rec['name'] if rec else None)
    return jsonify({'ok': True})


@app.route('/api/share', methods=['POST'])
@login_required
def api_share():
    data = request.get_json(force=True, silent=True) or {}
    fid = data.get('file_id')
    hours = max(1, min(24 * 30, int(data.get('hours', 24))))
    rec = db.get_file(fid, uid())
    if not rec:
        return jsonify({'error': 'File tidak ketemu'}), 404
    if not folder_accessible(rec.get('folder_id')):
        return jsonify({'error': 'File di folder terkunci tidak bisa dibagikan', 'locked': True}), 403
    token, exp = db.create_share(fid, uid(), hours)
    db.log_activity('share', uid(), file_id=fid, file_name=rec['name'], detail='berlaku s/d ' + exp)
    return jsonify({'token': token, 'url': url_for('shared', token=token, _external=True), 'expires_at': exp})


@app.route('/api/storage')
@login_required
def api_storage():
    st = db.count_storage(uid())
    st['max_upload_bytes'] = _max_upload_bytes(uid())
    u = db.get_user(uid())
    st['quota_mb'] = u['quota_mb'] if u else 102400
    st['is_pro'] = is_pro()
    return jsonify(st)


# ---------- file serving ----------

def _serve_record(rec, creds=None):
    try:
        p = ensure_local_copy(rec, creds)
    except tg.TgError as e:
        abort(502, 'Telegram: %s' % e)
    mime = rec['mime'] or 'application/octet-stream'
    if request.headers.get('X-Forwarded-Host'):
        # Lewat nginx: biarkan nginx yang serve file-nya (worker langsung bebas,
        # unduhan/video tidak menahan koneksi Python). Lihat location /_tgcache/.
        resp = make_response('')
        resp.headers['X-Accel-Redirect'] = '/_tgcache/' + rec['file_id']
        resp.headers['Content-Type'] = mime
        resp.headers['Content-Disposition'] = "inline; filename*=UTF-8''%s" % quote(rec['name'])
        return resp
    return send_file(p, download_name=rec['name'], mimetype=mime, as_attachment=False)


@app.route('/file/<int:fid>/download')
def file_download(fid):
    # Auth: session cookie ATAU token download sekali-pakai (lintas origin via direct).
    tok = request.args.get('token')
    if tok:
        t = db.consume_transfer_token(hashlib.sha256(tok.encode()).hexdigest(),
                                      'download', single_use=False)
        if not t or t['ref_id'] != str(fid):
            abort(403)
        dl_uid = t['user_id']
    else:
        if not session.get('logged_in'):
            abort(401)
        dl_uid = uid()
    rec = db.get_file(fid, dl_uid)
    if not rec or rec['trashed']:
        abort(404)
    if not folder_accessible(rec.get('folder_id'), dl_uid):
        abort(404)
    return _serve_record(rec, _creds_for_file(rec))


@app.route('/file/<int:fid>/thumb')
@login_required
def file_thumb(fid):
    rec = db.get_file(fid, uid())
    if not rec or not rec.get('thumb_file_id'):
        abort(404)
    if not folder_accessible(rec.get('folder_id')):
        abort(404)
    tp = os.path.join(config.THUMB_DIR, rec['thumb_file_id'] + '.jpg')
    if not os.path.exists(tp):
        try:
            tg.download_file(rec['thumb_file_id'], tp, creds=_creds_for_file(rec))
        except tg.TgError:
            abort(502)
    # thumbnail jarang berubah -> browser boleh cache 1 hari
    return send_file(tp, mimetype='image/jpeg', max_age=86400)


@app.route('/s/<token>')
def shared(token):
    sh = db.get_share(token)
    if not sh:
        return render_template('login.html', err='Link tidak valid atau sudah kedaluwarsa.', hide_form=True), 404
    rec = db.get_file(sh['file_id'], sh['user_id'])
    if not rec or rec['trashed']:
        abort(404)
    if not folder_accessible(rec.get('folder_id'), sh['user_id']):
        abort(404)
    return _serve_record(rec, _creds_for_file(rec))


# ---------- monitor sumber daya & batas pemakaian ----------

UNIT_TEMPLATE = """[Unit]
Description=TG Drive - penyimpanan cloud pribadi berbasis Telegram
After=network.target

[Service]
Type=simple
User=tgdrive
Group=tgdrive
WorkingDirectory=/home/tgdrive/app
EnvironmentFile=/home/tgdrive/app/.env
ExecStart=/home/tgdrive/app/venv/bin/gunicorn -w 3 --threads 4 --timeout 1800 -b 127.0.0.1:8502 app:app
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
{limits}
[Install]
WantedBy=multi-user.target
"""


def render_unit(cpu_pct=None, mem_mb=None):
    """Bangun isi tgdrive.service. cpu_pct = % dari TOTAL cpu VPS."""
    nproc = os.cpu_count() or 1
    lines = []
    if cpu_pct:
        quota = max(5, int(round(float(cpu_pct) / 100 * nproc * 100)))
        lines.append('CPUQuota=%d%%' % quota)
    if mem_mb:
        lines.append('MemoryMax=%dM' % int(mem_mb))
    return UNIT_TEMPLATE.format(limits='\n'.join(lines) + ('\n' if lines else ''))


def default_limits():
    return {
        'cpu_pct': int(db.get_setting('cpu_pct', 50)),
        'mem_mb': int(db.get_setting('mem_mb', 2048)),
    }


_last_sys_cpu = None
_last_proc_cpu = None


def _cpu_times():
    with open('/proc/stat') as f:
        v = list(map(int, f.readline().split()[1:]))
    return sum(v), v[3] + v[4]


def system_cpu_pct():
    global _last_sys_cpu
    total, idle = _cpu_times()
    now = time.time()
    if _last_sys_cpu is None:
        _last_sys_cpu = (now, total, idle)
        return 0.0
    pnow, ptotal, pidle = _last_sys_cpu
    _last_sys_cpu = (now, total, idle)
    dt, di = total - ptotal, idle - pidle
    return round((dt - di) / dt * 100, 1) if dt > 0 else 0.0


def proc_info():
    """(cpu_pct, rss_mb) untuk proses ini."""
    global _last_proc_cpu
    try:
        with open('/proc/self/stat') as f:
            p = f.read().rsplit(')', 1)[1].split()
        ticks = int(p[11]) + int(p[12])
        rss_mb = int(p[21]) * os.sysconf('SC_PAGE_SIZE') / 1024 / 1024
    except Exception:
        return 0.0, 0.0
    now = time.time()
    hz = os.sysconf('SC_CLK_TCK')
    nproc = os.cpu_count() or 1
    if _last_proc_cpu is None:
        _last_proc_cpu = (now, ticks)
        return 0.0, round(rss_mb, 1)
    pnow, pticks = _last_proc_cpu
    _last_proc_cpu = (now, ticks)
    dt = now - pnow
    cpu = ((ticks - pticks) / hz) / dt / nproc * 100 if dt > 0 else 0.0
    return round(cpu, 1), round(rss_mb, 1)


def mem_info():
    total = avail = 0
    try:
        with open('/proc/meminfo') as f:
            for line in f:
                if line.startswith('MemTotal:'):
                    total = int(line.split()[1]) // 1024
                elif line.startswith('MemAvailable:'):
                    avail = int(line.split()[1]) // 1024
    except Exception:
        pass
    return total, avail


@app.route('/api/ping')
def api_ping():
    return jsonify({'ok': True})


@app.route('/api/sysinfo')
@admin_required
def api_sysinfo():
    total_mb, avail_mb = mem_info()
    pcpu, prss = proc_info()
    lim = default_limits()
    nproc = os.cpu_count() or 1
    return jsonify({
        'cpu_pct': system_cpu_pct(),
        'proc_cpu_pct': pcpu,
        'mem_total_mb': total_mb,
        'mem_avail_mb': avail_mb,
        'proc_rss_mb': prss,
        'nproc': nproc,
        'limits': lim,
        'cpu_quota_systemd': '%d%%' % max(5, int(round(lim['cpu_pct'] / 100 * nproc * 100))),
    })


@app.route('/api/limits')
@admin_required
def api_limits_get():
    lim = default_limits()
    total_mb, _ = mem_info()
    return jsonify({**lim, 'nproc': os.cpu_count() or 1, 'mem_total_mb': total_mb})


@app.route('/api/limits', methods=['POST'])
@admin_required
def api_limits_set():
    data = request.get_json(force=True, silent=True) or {}
    try:
        cpu_pct = max(5, min(100, int(data.get('cpu_pct', 50))))
        mem_mb = max(256, min(32768, int(data.get('mem_mb', 2048))))
    except (TypeError, ValueError):
        return jsonify({'error': 'Nilai tidak valid'}), 400
    db.set_setting('cpu_pct', cpu_pct)
    db.set_setting('mem_mb', mem_mb)
    staged = '/home/tgdrive/app/tgdrive.service.staged'
    with open(staged, 'w') as f:
        f.write(render_unit(cpu_pct, mem_mb))
    try:
        subprocess.run(['sudo', '/usr/bin/cp', staged,
                        '/etc/systemd/system/tgdrive.service'], check=True, timeout=30)
        subprocess.run(['sudo', '/usr/bin/systemctl', 'daemon-reload'], check=True, timeout=30)
    except subprocess.CalledProcessError as e:
        return jsonify({'error': 'Gagal menerapkan batas (izin sudo): %s' % e}), 500
    # restart terpisah 2 detik agar respons ini sempat terkirim
    subprocess.Popen(['bash', '-c', 'sleep 2; sudo /usr/bin/systemctl restart tgdrive'],
                     start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return jsonify({'ok': True, 'restarting': True})


@app.route('/api/setup-status')
@login_required
def api_setup():
    info = {'configured': tg_configured()}
    acc = active_account()
    if acc:
        info['account'] = {'id': acc['id'], 'name': acc['name']}
        try:
            me = tg.get_me(creds=(acc['bot_token'], acc['channel_id']))
            info['bot'] = '@' + me.get('username', '?')
        except tg.TgError as e:
            info['error'] = str(e)
    return jsonify(info)


# ---------- akun telegram (multi-akun, satu aktif) ----------

@app.route('/api/accounts')
@login_required
def api_accounts():
    return jsonify({'accounts': db.list_accounts(uid())})


@app.route('/api/accounts/test', methods=['POST'])
@login_required
def api_account_test():
    data = request.get_json(force=True, silent=True) or {}
    token = (data.get('bot_token') or '').strip()
    channel = (data.get('channel_id') or '').strip()
    if not token or not channel:
        return jsonify({'error': 'Token dan ID channel wajib diisi'}), 400
    try:
        me = tg.get_me(creds=(token, channel))
        chat_title, _ = tg.check_channel_access(creds=(token, channel))
        return jsonify({'ok': True, 'username': '@' + me.get('username', '?'),
                        'name': me.get('first_name', ''),
                        'channel': chat_title})
    except tg.TgError as e:
        return jsonify({'error': 'Tes gagal: %s' % e}), 502


@app.route('/api/accounts', methods=['POST'])
@login_required
def api_account_add():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get('name') or '').strip() or 'Akun'
    token = (data.get('bot_token') or '').strip()
    channel = (data.get('channel_id') or '').strip()
    if not token or not channel:
        return jsonify({'error': 'Token dan ID channel wajib diisi'}), 400
    try:
        tg.get_me(creds=(token, channel))
        tg.check_channel_access(creds=(token, channel))
    except tg.TgError as e:
        return jsonify({'error': 'Koneksi gagal: %s' % e}), 400
    aid = db.add_account(uid(), name, token, channel)
    return jsonify({'ok': True, 'id': aid})


@app.route('/api/accounts/<int:aid>/activate', methods=['POST'])
@login_required
def api_account_activate(aid):
    acc = db.get_account(aid, uid())
    if not acc:
        return jsonify({'error': 'Akun tidak ketemu'}), 404
    db.set_active_account(aid, uid())
    db.log_activity('switch_account', uid(), detail='Beralih ke akun "%s"' % acc['name'], account_id=aid)
    return jsonify({'ok': True})


@app.route('/api/accounts/<int:aid>', methods=['PUT'])
@login_required
def api_account_update(aid):
    acc = db.get_account(aid, uid())
    if not acc:
        return jsonify({'error': 'Akun tidak ketemu'}), 404
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get('name') or '').strip() or acc['name']
    new_token = (data.get('bot_token') or '').strip()
    channel = (data.get('channel_id') or '').strip() or acc['channel_id']
    eff_token = new_token or acc['bot_token']
    if not eff_token or not channel:
        return jsonify({'error': 'Token dan ID channel wajib diisi'}), 400
    try:
        tg.get_me(creds=(eff_token, channel))
        tg.check_channel_access(creds=(eff_token, channel))
    except tg.TgError as e:
        return jsonify({'error': 'Koneksi gagal: %s' % e}), 400
    db.update_account(aid, uid(), name, new_token or None, channel)
    db.log_activity('edit_account', uid(), detail='Mengubah akun "%s"' % name, account_id=aid)
    return jsonify({'ok': True})


@app.route('/api/accounts/<int:aid>', methods=['DELETE'])
@login_required
def api_account_delete(aid):
    acc = db.get_account(aid, uid())
    if not acc:
        return jsonify({'error': 'Akun tidak ketemu'}), 404
    try:
        res = db.delete_account(aid, uid())
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    # hapus pesan Telegram milik akun ini (best effort, pakai kredensial akun tsb)
    creds = (res['token'], res['channel_id'])
    for f in res['files']:
        if f.get('message_id'):
            tg.delete_message(f['message_id'], creds=creds)
    return jsonify({'ok': True, 'deleted_files': len(res['files'])})


# ---------- error handlers ----------

@app.errorhandler(413)
def too_large(e):
    if request.path.startswith('/api/'):
        return jsonify({'error': 'File maksimal %s.' % fmt_size(config.MAX_UPLOAD_BYTES)}), 413
    return 'File terlalu besar (maks %s).' % fmt_size(config.MAX_UPLOAD_BYTES), 413


# ---------- server-info (jalur IP langsung, khusus PRO/admin) ----------

def _norm_public_url(raw, default_scheme='http://'):
    """Normalisasi URL IP publik/domain dari setting admin.
    Admin sering mengisi 'IP:port' tanpa skema -> browser menganggapnya
    URL relatif dan nyasar 404. Selalu kembalikan dengan skema + tanpa
    trailing slash."""
    u = (raw or '').strip()
    if not u:
        return ''
    if '://' not in u:
        u = default_scheme + u
    return u.rstrip('/')


@app.route('/api/server-info')
@login_required
def api_server_info():
    if not is_pro():
        return jsonify({'error': 'Khusus pengguna PRO'}), 403
    # Max Speed otomatis aktif untuk PRO kecuali user mematikannya eksplisit.
    # Jadi user PRO tidak perlu mengatur apa-apa.
    explicit = db.get_user_setting(uid(), 'max_speed', None)
    effective = (explicit == '1') if explicit is not None else True
    return jsonify({
        'direct_url': _norm_public_url(db.get_setting('direct_url', ''), 'http://'),
        'domain_url': _norm_public_url(db.get_setting('domain_url', 'https://drive.gtg.my.id'), 'https://'),
        'max_speed': effective,
        'max_speed_explicit': explicit is not None,
        'max_upload_bytes': _max_upload_bytes(uid()),
        'cf_limit_bytes': CF_LIMIT_BYTES,
        'resume_threshold_bytes': RESUME_THRESHOLD_BYTES,
        'is_pro': True,
    })


@app.route('/api/upload-limits')
@login_required
def api_upload_limits():
    """Batas upload untuk user saat ini (dipakai semua halaman)."""
    return jsonify({
        'max_upload_bytes': _max_upload_bytes(uid()),
        'cf_limit_bytes': CF_LIMIT_BYTES,
        'resume_threshold_bytes': RESUME_THRESHOLD_BYTES,
        'is_pro': is_pro(),
        'direct_url': _direct_base(),
        'chunked': (db.get_setting('chunked_upload', '1') or '1') == '1',
    })


@app.route('/api/max-speed', methods=['PUT'])
@login_required
def api_max_speed():
    if not is_pro():
        return jsonify({'error': 'Khusus pengguna PRO'}), 403
    data = request.get_json(force=True, silent=True) or {}
    on = bool(data.get('max_speed'))
    if on and not db.get_setting('direct_url', '').strip():
        return jsonify({'error': 'IP publik belum diatur admin.'}), 400
    db.set_user_setting(uid(), 'max_speed', '1' if on else '0')
    db.log_activity('max_speed', uid(),
                    detail='Max Speed %s' % ('diaktifkan' if on else 'dimatikan'))
    return jsonify({'ok': True, 'max_speed': on})


# ---------- lisensi (user) ----------

@app.route('/upgrade')
@login_required
def upgrade_page():
    lic = db.get_active_license(uid())
    return render_template('upgrade.html', tiers=_tier_info(),
                           my_license=lic,
                           wa_number=(db.get_setting('wa_number', '') or '').strip(),
                           telegram_username=(db.get_setting('telegram_username', '') or '').strip(),
                           qris_url=url_for('static', filename='qris.jpg'),
                           is_pro=is_pro(), is_admin=is_admin())


@app.route('/api/license/status')
@login_required
def api_license_status():
    lic = db.get_active_license(uid())
    if lic:
        t = LICENSE_TIERS.get(lic['tier'], {})
        lic = dict(lic)
        lic['nama'] = t.get('nama', lic['tier'])
    return jsonify({'license': lic, 'is_pro': is_pro()})


@app.route('/api/license/redeem', methods=['POST'])
@login_required
def api_license_redeem():
    data = request.get_json(force=True, silent=True) or {}
    ok, msg, lic = db.redeem_license(data.get('code'), uid())
    if not ok:
        return jsonify({'error': msg}), 400
    db.log_activity('license_redeem', uid(), detail='Redeem lisensi %s' % lic['code'])
    return jsonify({'ok': True, 'message': msg,
                    'expires_at': lic['expires_at'],
                    'nama': LICENSE_TIERS.get(lic['tier'], {}).get('nama', lic['tier'])})


# ---------- profil (nama tampilan & tema) ----------

@app.route('/api/profile', methods=['PUT'])
@login_required
def api_profile():
    data = request.get_json(force=True, silent=True) or {}
    changed = []
    if 'display_name' in data:
        name = (data['display_name'] or '').strip()[:40]
        conn = db.get_db()
        conn.execute('UPDATE users SET display_name=? WHERE id=?', (name or None, uid()))
        conn.commit()
        conn.close()
        changed.append('nama')
    if 'theme' in data and data['theme'] in THEMES:
        db.set_user_setting(uid(), 'theme', data['theme'])
        changed.append('tema')
    if not changed:
        return jsonify({'error': 'Tidak ada perubahan.'}), 400
    return jsonify({'ok': True, 'changed': changed})


# ---------- panel admin ----------

@app.route('/admin')
@admin_required
def admin_page():
    return render_template('admin.html')


@app.route('/api/admin/users')
@admin_required
def api_admin_users():
    return jsonify({'users': db.list_users()})


@app.route('/api/admin/users/<int:target_id>', methods=['PATCH'])
@admin_required
def api_admin_user_patch(target_id):
    data = request.get_json(force=True, silent=True) or {}
    patch = {}
    for k in ('is_active', 'is_pro', 'quota_mb'):
        if k in data:
            patch[k] = data[k]
    if 'role' in data and target_id != uid():
        patch['role'] = data['role']
    if 'role' in data and data['role'] != 'admin':
        # jangan demote admin terakhir
        u = db.get_user(target_id)
        if u and u['role'] == 'admin' and db.count_admins() <= 1:
            return jsonify({'error': 'Admin terakhir tidak bisa didemote.'}), 400
    if not db.set_user_fields(target_id, **patch):
        return jsonify({'error': 'Tidak ada yang diubah / user tidak ada'}), 400
    if target_id == uid():
        # refresh sesi sendiri
        u = db.get_user(uid())
        if u:
            session['role'] = u['role']
            session['is_pro'] = bool(u['is_pro'])
    return jsonify({'ok': True})


@app.route('/api/admin/users/<int:target_id>', methods=['DELETE'])
@admin_required
def api_admin_user_delete(target_id):
    if target_id == uid():
        return jsonify({'error': 'Tidak bisa menghapus akun sendiri.'}), 400
    try:
        res = db.delete_user(target_id)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    if res is None:
        return jsonify({'error': 'User tidak ada'}), 404
    # hapus pesan Telegram milik user ini (best effort)
    for a in res:
        creds = (a['token'], a['channel_id'])
        for f in a['files']:
            if f.get('message_id'):
                try:
                    tg.delete_message(f['message_id'], creds=creds)
                except Exception:
                    pass
    return jsonify({'ok': True, 'deleted_files': sum(len(a['files']) for a in res)})


@app.route('/api/admin/invites')
@admin_required
def api_admin_invites():
    return jsonify({'invites': db.list_invite_codes(),
                    'registration_mode': db.get_setting('registration_mode', 'open'),
                    'direct_url': db.get_setting('direct_url', ''),
                    'domain_url': db.get_setting('domain_url', 'https://drive.gtg.my.id'),
                    'handoff_token_ttl': int(db.get_setting('handoff_token_ttl', 90) or 90),
                    'wa_number': db.get_setting('wa_number', '') or '',
                    'telegram_username': db.get_setting('telegram_username', '') or '',
                    'chunked_upload': (db.get_setting('chunked_upload', '1') or '1') == '1',
                    'prices': {k: db.get_setting(k, '') or '' for k in
                               ('license_price_monthly', 'license_price_yearly', 'license_price_lifetime')}})


@app.route('/api/admin/invites', methods=['POST'])
@admin_required
def api_admin_invite_create():
    import secrets as _sec
    data = request.get_json(force=True, silent=True) or {}
    code = (data.get('code') or _sec.token_urlsafe(6)).strip()[:32]
    cid = db.create_invite_code(code,
                                bonus_quota_mb=int(data.get('bonus_quota_mb') or 0),
                                max_uses=int(data.get('max_uses') or 1),
                                created_by=uid())
    return jsonify({'ok': True, 'id': cid, 'code': code})


# ---------- lisensi (admin) ----------

@app.route('/api/admin/licenses')
@admin_required
def api_admin_licenses():
    lics = db.list_licenses()
    for lic in lics:
        lic['nama'] = LICENSE_TIERS.get(lic['tier'], {}).get('nama', lic['tier'])
    return jsonify({'licenses': lics, 'tiers': _tier_info(),
                    'wa_number': db.get_setting('wa_number', '') or ''})


@app.route('/api/admin/licenses', methods=['POST'])
@admin_required
def api_admin_license_create():
    data = request.get_json(force=True, silent=True) or {}
    tier = data.get('tier')
    if tier not in LICENSE_TIERS:
        return jsonify({'error': 'Paket tidak dikenal.'}), 400
    try:
        count = max(1, min(50, int(data.get('count') or 1)))
    except (TypeError, ValueError):
        count = 1
    t = LICENSE_TIERS[tier]
    try:
        quota = int(data.get('quota_mb') or t['kuota_mb'])
    except (TypeError, ValueError):
        quota = t['kuota_mb']
    codes = []
    for _ in range(count):
        code = db.create_license(tier, quota_mb=quota, duration_days=t['durasi_hari'],
                                 created_by=uid(), note=(data.get('note') or '')[:100])
        if code:
            codes.append(code)
    db.log_activity('license_create', uid(), detail='Buat %d lisensi %s' % (len(codes), tier))
    return jsonify({'ok': True, 'codes': codes})


@app.route('/api/admin/licenses/<int:lid>/revoke', methods=['POST'])
@admin_required
def api_admin_license_revoke(lid):
    data = request.get_json(force=True, silent=True) or {}
    revoked = bool(data.get('revoked', True))
    db.set_license_status(lid, 'revoked' if revoked else 'active')
    return jsonify({'ok': True})


@app.route('/api/admin/licenses/<int:lid>', methods=['DELETE'])
@admin_required
def api_admin_license_delete(lid):
    db.delete_license(lid)
    return jsonify({'ok': True})


@app.route('/api/admin/invites/<int:cid>', methods=['DELETE'])
@admin_required
def api_admin_invite_delete(cid):
    db.delete_invite_code(cid)
    return jsonify({'ok': True})


@app.route('/api/admin/invites/<int:cid>/toggle', methods=['POST'])
@admin_required
def api_admin_invite_toggle(cid):
    data = request.get_json(force=True, silent=True) or {}
    db.set_invite_active(cid, bool(data.get('active', True)))
    return jsonify({'ok': True})


@app.route('/api/admin/settings', methods=['POST'])
@admin_required
def api_admin_settings():
    data = request.get_json(force=True, silent=True) or {}
    if 'registration_mode' in data and data['registration_mode'] in ('open', 'invite', 'closed'):
        db.set_setting('registration_mode', data['registration_mode'])
    if 'direct_url' in data:
        db.set_setting('direct_url', _norm_public_url(data['direct_url'], 'http://')[:200])
    if 'domain_url' in data:
        db.set_setting('domain_url', _norm_public_url(data['domain_url'], 'https://')[:200])
    if 'handoff_token_ttl' in data:
        try:
            ttl = int(data['handoff_token_ttl'])
        except (TypeError, ValueError):
            ttl = 90
        db.set_setting('handoff_token_ttl', str(max(10, min(600, ttl))))
    for pk in ('license_price_monthly', 'license_price_yearly', 'license_price_lifetime'):
        if pk in data:
            db.set_setting(pk, (data[pk] or '').strip()[:32])
    if 'wa_number' in data:
        wa = re.sub(r'\D', '', data['wa_number'] or '')[:16]
        db.set_setting('wa_number', wa)
    if 'telegram_username' in data:
        tu = re.sub(r'[^A-Za-z0-9_]', '', data['telegram_username'] or '')[:32]
        db.set_setting('telegram_username', tu)
    if 'chunked_upload' in data:
        db.set_setting('chunked_upload', '1' if data['chunked_upload'] in (True, 1, '1') else '0')
    return jsonify({'ok': True})


@app.route('/api/admin/stats')
@admin_required
def api_admin_stats():
    users = db.list_users()
    total_bytes = sum(u['used_bytes'] or 0 for u in users)
    return jsonify({'total_users': len(users),
                    'total_bytes': total_bytes,
                    'pro_users': sum(1 for u in users if u['is_pro']),
                    'active_users': sum(1 for u in users if u['is_active'])})


# ---------- APK update ----------

@app.route('/api/app-version')
def api_app_version():
    return jsonify({'version_code': int(db.get_setting('apk_version_code', 1)),
                    'version_name': db.get_setting('apk_version_name', '1.0'),
                    'apk_url': db.get_setting('apk_url', '/apk/tgdrive.apk'),
                    'windows': {
                        'version_code': int(db.get_setting('win_version_code', 0)),
                        'version_name': db.get_setting('win_version_name', ''),
                        'url': db.get_setting('win_url', ''),
                    }})


@app.route('/api/admin/apk', methods=['POST'])
@admin_required
def api_admin_apk():
    data = request.get_json(force=True, silent=True) or {}
    db.set_setting('apk_version_code', str(int(data.get('version_code') or 1)))
    db.set_setting('apk_version_name', (data.get('version_name') or '1.0')[:20])
    db.set_setting('apk_url', (data.get('apk_url') or '/apk/tgdrive.apk')[:200])
    if 'win_version_code' in data:
        db.set_setting('win_version_code', str(int(data.get('win_version_code') or 0)))
        db.set_setting('win_version_name', (data.get('win_version_name') or '')[:20])
        db.set_setting('win_url', (data.get('win_url') or '')[:200])
    return jsonify({'ok': True})


@app.route('/apk/<path:fname>')
def apk_download(fname):
    # file APK disajikan dari direktori khusus (diatur via setting apk_dir)
    apk_dir = db.get_setting('apk_dir', os.path.join(config.BASE_DIR, 'apk'))
    p = os.path.join(apk_dir, os.path.basename(fname))
    if not os.path.exists(p):
        abort(404)
    return send_file(p, as_attachment=True,
                     download_name=os.path.basename(fname),
                     mimetype='application/vnd.android.package-archive')


if __name__ == '__main__':
    db.init_db()
    app.run(host='127.0.0.1', port=8502)

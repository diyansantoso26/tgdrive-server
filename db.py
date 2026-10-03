"""Lapisan database SQLite untuk TG Drive (multi-user: tiap user punya bot & data sendiri)."""
import os
import sqlite3
from datetime import datetime, timedelta

import config

try:
    from cryptography.fernet import Fernet, InvalidToken
except ImportError:  # pragma: no cover
    Fernet, InvalidToken = None, None

DB_PATH = os.path.join(config.DATA_DIR, 'drive.db')

_fernet = None


def _get_fernet():
    global _fernet
    if _fernet is None:
        _fernet = Fernet(config.TOKEN_ENC_KEY.encode())
    return _fernet


def _enc_token(plain):
    return _get_fernet().encrypt(plain.encode()).decode()


def _dec_token(stored):
    """Kembalikan token plaintext; bila belum terenkripsi (data lama), kembalikan apa adanya."""
    if not stored:
        return ''
    if not stored.startswith('gAAAAA'):
        return stored
    try:
        return _get_fernet().decrypt(stored.encode()).decode()
    except Exception:
        return stored

SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES folders(id),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,              -- photo | video | doc | audio
    mime TEXT,
    size INTEGER NOT NULL,
    file_id TEXT NOT NULL,           -- Telegram file_id (ukuran penuh)
    thumb_file_id TEXT,              -- Telegram file_id thumbnail (jika ada)
    message_id INTEGER,              -- message id di channel (untuk hapus permanen)
    width INTEGER,
    height INTEGER,
    duration INTEGER,
    taken_at TEXT,                   -- dari EXIF / metadata (untuk timeline Foto)
    uploaded_at TEXT NOT NULL,
    folder_id INTEGER REFERENCES folders(id),
    favorite INTEGER NOT NULL DEFAULT 0,
    trashed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES files(id),
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tg_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    bot_token TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id, trashed);
CREATE INDEX IF NOT EXISTS idx_files_taken ON files(taken_at);
CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,              -- NULL = global (mis. login)
    action TEXT NOT NULL,            -- upload, overwrite, rename_file, trash, restore, delete,
                                     -- create_folder, rename_folder, delete_folder, share,
                                     -- favorite, unfavorite, switch_account, login
    file_id INTEGER,
    file_name TEXT,                  -- snapshot nama saat aksi terjadi
    folder_id INTEGER,
    folder_name TEXT,                -- snapshot nama folder
    detail TEXT,                     -- mis. "a.txt -> b.txt", "berlaku s/d ..."
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity ON activity_log(account_id, created_at);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',   -- admin | user
    is_pro INTEGER NOT NULL DEFAULT 0,   -- 1 = pelanggan pro/donatur (fitur premium)
    quota_mb INTEGER NOT NULL DEFAULT 102400,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    bonus_quota_mb INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS login_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_hash ON login_tokens(token_hash);
CREATE TABLE IF NOT EXISTS licenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    tier TEXT NOT NULL,
    quota_mb INTEGER NOT NULL DEFAULT 0,
    duration_days INTEGER,
    created_at TEXT NOT NULL,
    created_by INTEGER,
    redeemed_by INTEGER,
    redeemed_at TEXT,
    expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    note TEXT
);
"""


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _table_cols(conn, table):
    return [r['name'] for r in conn.execute('PRAGMA table_info(%s)' % table)]


def init_db():
    conn = get_db()
    conn.execute('PRAGMA journal_mode=WAL')  # konkurensi baca/tulis lebih baik
    conn.executescript(SCHEMA)
    # migrasi: tambah account_id bila belum ada
    for tbl in ('files', 'folders'):
        if 'account_id' not in _table_cols(conn, tbl):
            conn.execute('ALTER TABLE %s ADD COLUMN account_id INTEGER' % tbl)
    # migrasi: flag kunci folder
    if 'is_locked' not in _table_cols(conn, 'folders'):
        conn.execute('ALTER TABLE folders ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0')
    # migrasi: nama tampilan user
    if 'display_name' not in _table_cols(conn, 'users'):
        conn.execute('ALTER TABLE users ADD COLUMN display_name TEXT')
    # migrasi multi-user: kolom user_id di semua tabel data
    for tbl in ('files', 'folders', 'tg_accounts', 'shares', 'activity_log'):
        if 'user_id' not in _table_cols(conn, tbl):
            conn.execute('ALTER TABLE %s ADD COLUMN user_id INTEGER' % tbl)
    # migrasi: waktu masuk tong sampah (untuk hapus permanen otomatis 7 hari)
    if 'trashed_at' not in _table_cols(conn, 'files'):
        conn.execute('ALTER TABLE files ADD COLUMN trashed_at TEXT')
        conn.execute("UPDATE files SET trashed_at=? WHERE trashed=1 AND trashed_at IS NULL",
                     (datetime.now().isoformat(timespec='seconds'),))
    conn.commit()
    # buat akun admin bila belum ada (dari password lama di .env)
    now = datetime.now().isoformat(timespec='seconds')
    admin = conn.execute("SELECT id FROM users WHERE role='admin'").fetchone()
    if not admin:
        cur = conn.execute(
            "INSERT INTO users (username, password_hash, role, is_pro, quota_mb, is_active, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            ('admin', config.ADMIN_PASSWORD_HASH or '', 'admin', 1, 102400, 1, now))
        admin_id = cur.lastrowid
    else:
        admin_id = admin['id']
    # backfill: data lama jadi milik admin
    for tbl in ('files', 'folders', 'tg_accounts', 'shares', 'activity_log'):
        conn.execute('UPDATE %s SET user_id=? WHERE user_id IS NULL' % tbl, (admin_id,))
    conn.commit()
    # migrasi PIN kunci folder -> user_settings milik admin
    pin = conn.execute("SELECT value FROM settings WHERE key='folder_lock_pin_hash'").fetchone()
    if pin:
        conn.execute('INSERT OR IGNORE INTO user_settings (user_id, key, value) VALUES (?,?,?)',
                     (admin_id, 'folder_lock_pin_hash', pin['value']))
        conn.execute("DELETE FROM settings WHERE key='folder_lock_pin_hash'")
        conn.commit()
    # enkripsi token bot yang masih plaintext
    for r in conn.execute('SELECT id, bot_token FROM tg_accounts').fetchall():
        tok = r['bot_token'] or ''
        if tok and not tok.startswith('gAAAAA'):
            conn.execute('UPDATE tg_accounts SET bot_token=? WHERE id=?',
                         (_enc_token(tok), r['id']))
    conn.commit()
    # seed pengaturan global default
    for k, v in (('registration_mode', 'open'),):
        conn.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', (k, v))
    conn.commit()
    # seed akun default dari .env bila tabel akun masih kosong (atomik, aman utk multi-worker)
    if config.BOT_TOKEN and config.CHANNEL_ID:
        cur = conn.execute(
            'INSERT INTO tg_accounts (name, bot_token, channel_id, is_active, created_at)'
            ' SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM tg_accounts)',
            ('Akun 1', config.BOT_TOKEN, config.CHANNEL_ID, 1,
             datetime.now().isoformat(timespec='seconds')))
        if cur.rowcount:
            aid = cur.lastrowid
            conn.execute('UPDATE files SET account_id=? WHERE account_id IS NULL', (aid,))
            conn.execute('UPDATE folders SET account_id=? WHERE account_id IS NULL', (aid,))
        conn.commit()
    # backfill: file yang sudah ada sebelum fitur log dianggap sebagai 'upload'
    try:
        n = conn.execute('SELECT COUNT(*) c FROM activity_log').fetchone()['c']
        if n == 0:
            conn.execute(
                "INSERT INTO activity_log (account_id, action, file_id, file_name, folder_id, created_at)"
                " SELECT account_id, 'upload', id, name, folder_id, uploaded_at FROM files")
            conn.commit()
    except sqlite3.OperationalError:
        pass
    conn.close()


def _row_to_dict(r):
    return dict(r) if r is not None else None


def _active_id(user_id, conn=None):
    """ID akun aktif milik user; None bila belum ada."""
    own = conn is None
    if own:
        conn = get_db()
    try:
        r = conn.execute('SELECT id FROM tg_accounts WHERE is_active=1 AND user_id=?',
                         (user_id,)).fetchone()
        return r['id'] if r else None
    except sqlite3.OperationalError:
        return None
    finally:
        if own:
            conn.close()


def _dec_acc_row(r):
    d = _row_to_dict(r)
    if d and d.get('bot_token'):
        d['bot_token'] = _dec_token(d['bot_token'])
    return d


# ---------- akun telegram (per user, satu aktif per user) ----------

def list_accounts(user_id):
    conn = get_db()
    try:
        rows = conn.execute(
            'SELECT id, name, channel_id, is_active, created_at, bot_token,'
            ' (SELECT COUNT(*) FROM files f WHERE f.account_id=tg_accounts.id AND f.trashed=0'
            '  AND f.user_id=?) AS file_count'
            ' FROM tg_accounts WHERE user_id=? ORDER BY id',
            (user_id, user_id)).fetchall()
    except sqlite3.OperationalError:
        conn.close()
        return []
    conn.close()
    out = []
    for r in rows:
        tok = _dec_token(r['bot_token'])
        out.append({'id': r['id'], 'name': r['name'], 'channel_id': r['channel_id'],
                    'is_active': r['is_active'], 'created_at': r['created_at'],
                    'token_head': tok[:10], 'token_tail': tok[-2:],
                    'file_count': r['file_count']})
    return out


def get_active_account(user_id):
    conn = get_db()
    try:
        r = conn.execute('SELECT * FROM tg_accounts WHERE is_active=1 AND user_id=?',
                         (user_id,)).fetchone()
        return _dec_acc_row(r)
    except sqlite3.OperationalError:
        return None
    finally:
        conn.close()


def get_account(aid, user_id):
    conn = get_db()
    r = conn.execute('SELECT * FROM tg_accounts WHERE id=? AND user_id=?',
                     (aid, user_id)).fetchone()
    conn.close()
    return _dec_acc_row(r)


def add_account(user_id, name, bot_token, channel_id):
    conn = get_db()
    active = 1 if _active_id(user_id, conn) is None else 0  # akun pertama otomatis aktif
    cur = conn.execute(
        'INSERT INTO tg_accounts (name, bot_token, channel_id, is_active, created_at, user_id)'
        ' VALUES (?,?,?,?,?,?)',
        (name.strip()[:60], _enc_token(bot_token.strip()), channel_id.strip(), active,
         datetime.now().isoformat(timespec='seconds'), user_id))
    aid = cur.lastrowid
    conn.commit()
    conn.close()
    return aid


def update_account(aid, user_id, name, bot_token, channel_id):
    # bot_token None/kosong = pertahankan token lama
    conn = get_db()
    if bot_token and bot_token.strip():
        conn.execute('UPDATE tg_accounts SET name=?, bot_token=?, channel_id=?'
                     ' WHERE id=? AND user_id=?',
                     (name.strip()[:60], _enc_token(bot_token.strip()),
                      channel_id.strip(), aid, user_id))
    else:
        conn.execute('UPDATE tg_accounts SET name=?, channel_id=?'
                     ' WHERE id=? AND user_id=?',
                     (name.strip()[:60], channel_id.strip(), aid, user_id))
    conn.commit()
    conn.close()


def set_active_account(aid, user_id):
    conn = get_db()
    r = conn.execute('UPDATE tg_accounts SET is_active=1 WHERE id=? AND user_id=?',
                     (aid, user_id))
    if r.rowcount:
        conn.execute('UPDATE tg_accounts SET is_active=0 WHERE id!=? AND user_id=?',
                     (aid, user_id))
    conn.commit()
    conn.close()
    return r.rowcount > 0


def _delete_account_rows(conn, aid, user_id):
    """Hapus akun + metadata file-nya. Kembalikan info untuk cleanup Telegram."""
    acc = conn.execute('SELECT * FROM tg_accounts WHERE id=? AND user_id=?',
                       (aid, user_id)).fetchone()
    if not acc:
        return None
    files = [dict(r) for r in conn.execute(
        'SELECT id, file_id, message_id FROM files WHERE account_id=? AND user_id=?',
        (aid, user_id))]
    fids = [f['id'] for f in files]
    if fids:
        q = ','.join('?' * len(fids))
        conn.execute('DELETE FROM shares WHERE file_id IN (%s)' % q, fids)
        conn.execute('DELETE FROM files WHERE id IN (%s)' % q, fids)
    conn.execute('DELETE FROM folders WHERE account_id=? AND user_id=?', (aid, user_id))
    conn.execute('DELETE FROM tg_accounts WHERE id=?', (aid,))
    return {'token': _dec_token(acc['bot_token']), 'channel_id': acc['channel_id'],
            'files': files, 'was_active': bool(acc['is_active'])}


def delete_account(aid, user_id):
    """Hapus akun non-aktif beserta metadata file-nya. Kembalikan info untuk cleanup Telegram."""
    conn = get_db()
    acc = conn.execute('SELECT is_active FROM tg_accounts WHERE id=? AND user_id=?',
                       (aid, user_id)).fetchone()
    if not acc:
        conn.close()
        return None
    if acc['is_active']:
        conn.close()
        raise ValueError('Akun aktif tidak bisa dihapus. Aktifkan akun lain dulu.')
    res = _delete_account_rows(conn, aid, user_id)
    conn.commit()
    conn.close()
    return res


# ---------- files (terisolasi per user) ----------

def _acc_filter(user_id, account_id):
    if account_id is None:
        account_id = _active_id(user_id)
    return account_id


def add_file(rec):
    """rec wajib memuat user_id."""
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO files (name, kind, mime, size, file_id, thumb_file_id, message_id,
                              width, height, duration, taken_at, uploaded_at, folder_id, account_id, user_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (rec['name'], rec['kind'], rec.get('mime'), rec['size'], rec['file_id'],
         rec.get('thumb_file_id'), rec.get('message_id'), rec.get('width'),
         rec.get('height'), rec.get('duration'), rec.get('taken_at'),
         datetime.now().isoformat(timespec='seconds'), rec.get('folder_id'),
         rec.get('account_id') if rec.get('account_id') is not None else _active_id(rec['user_id'], conn),
         rec['user_id']))
    fid = cur.lastrowid
    conn.commit()
    conn.close()
    return fid


def update_file_storage(fid, user_id, rec):
    """Timpa isi file: ganti referensi Telegram-nya, metadata ikut baru."""
    conn = get_db()
    conn.execute(
        """UPDATE files SET kind=?, mime=?, size=?, file_id=?, thumb_file_id=?, message_id=?,
                          width=?, height=?, duration=?, taken_at=?, uploaded_at=?
           WHERE id=? AND user_id=?""",
        (rec['kind'], rec.get('mime'), rec['size'], rec['file_id'], rec.get('thumb_file_id'),
         rec.get('message_id'), rec.get('width'), rec.get('height'), rec.get('duration'),
         rec.get('taken_at'), datetime.now().isoformat(timespec='seconds'), fid, user_id))
    conn.commit()
    conn.close()


def get_file(fid, user_id, account_id=None):
    account_id = _acc_filter(user_id, account_id)
    conn = get_db()
    r = conn.execute('SELECT * FROM files WHERE id=? AND user_id=? AND account_id IS ?',
                     (fid, user_id, account_id)).fetchone()
    conn.close()
    return _row_to_dict(r)


def check_duplicate(name, size, user_id, folder_id=None, account_id=None):
    """Cari file (belum di-trash) dengan nama & ukuran sama di folder & akun & user yang sama."""
    account_id = _acc_filter(user_id, account_id)
    conn = get_db()
    if folder_id is None:
        r = conn.execute(
            'SELECT id, uploaded_at FROM files WHERE name=? AND size=? AND trashed=0'
            ' AND folder_id IS NULL AND user_id=? AND account_id IS ?',
            (name, size, user_id, account_id)).fetchone()
    else:
        r = conn.execute(
            'SELECT id, uploaded_at FROM files WHERE name=? AND size=? AND trashed=0'
            ' AND folder_id=? AND user_id=? AND account_id IS ?',
            (name, size, folder_id, user_id, account_id)).fetchone()
    conn.close()
    return _row_to_dict(r)


def list_files(user_id, folder_id=None, q=None, sort='date', order='desc', trashed=0,
               favorites_only=False, kind_in=None, account_id=None):
    account_id = _acc_filter(user_id, account_id)
    allowed_sort = {'name': 'name', 'date': 'uploaded_at', 'size': 'size', 'taken': 'taken_at'}
    col = allowed_sort.get(sort, 'uploaded_at')
    direction = 'ASC' if order == 'asc' else 'DESC'
    sql = 'SELECT * FROM files WHERE trashed=? AND user_id=? AND account_id IS ?'
    params = [trashed, user_id, account_id]
    if folder_id is not None:
        sql += ' AND folder_id IS ?' if folder_id == 'null' else ' AND folder_id=?'
        params.append(None if folder_id == 'null' else folder_id)
    if q:
        sql += ' AND name LIKE ?'
        params.append('%' + q + '%')
    if favorites_only:
        sql += ' AND favorite=1'
    if kind_in:
        sql += ' AND kind IN (%s)' % ','.join('?' * len(kind_in))
        params.extend(kind_in)
    if col == 'taken_at':
        sql += f' ORDER BY {col} IS NULL, {col} {direction}'
    else:
        sql += f' ORDER BY {col} {direction}'
    conn = get_db()
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def set_trashed(fid, user_id, trashed):
    conn = get_db()
    now = datetime.now().isoformat(timespec='seconds')
    if trashed:
        conn.execute('UPDATE files SET trashed=1, trashed_at=? WHERE id=? AND user_id=?',
                     (now, fid, user_id))
    else:
        conn.execute('UPDATE files SET trashed=0, trashed_at=NULL WHERE id=? AND user_id=?',
                     (fid, user_id))
    conn.commit()
    conn.close()


def trashed_older_than(user_id, days=7):
    """File di tong sampah yang sudah lebih dari `days` hari (untuk hapus permanen otomatis)."""
    cutoff = (datetime.now() - timedelta(days=days)).isoformat(timespec='seconds')
    conn = get_db()
    rows = conn.execute(
        'SELECT * FROM files WHERE trashed=1 AND user_id=?'
        ' AND trashed_at IS NOT NULL AND trashed_at < ?',
        (user_id, cutoff)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def set_favorite(fid, user_id, fav):
    conn = get_db()
    conn.execute('UPDATE files SET favorite=? WHERE id=? AND user_id=?',
                 (1 if fav else 0, fid, user_id))
    conn.commit()
    conn.close()


def delete_file(fid, user_id):
    conn = get_db()
    conn.execute('DELETE FROM shares WHERE file_id=? AND user_id=?', (fid, user_id))
    conn.execute('DELETE FROM files WHERE id=? AND user_id=?', (fid, user_id))
    conn.commit()
    conn.close()


def rename_file(fid, user_id, name):
    conn = get_db()
    conn.execute('UPDATE files SET name=? WHERE id=? AND user_id=?',
                 (name.strip()[:200], fid, user_id))
    conn.commit()
    conn.close()


def count_storage(user_id, account_id=None):
    account_id = _acc_filter(user_id, account_id)
    conn = get_db()
    try:
        r = conn.execute('SELECT COUNT(*) c, COALESCE(SUM(size),0) s FROM files'
                         ' WHERE trashed=0 AND user_id=? AND account_id IS ?',
                         (user_id, account_id)).fetchone()
    except sqlite3.OperationalError:
        r = {'c': 0, 's': 0}
    conn.close()
    try:
        return {'count': r['c'], 'bytes': r['s']}
    except (TypeError, KeyError):
        return {'count': 0, 'bytes': 0}


def user_storage_bytes(user_id):
    """Total byte milik user di semua akun (untuk kuota)."""
    conn = get_db()
    r = conn.execute('SELECT COALESCE(SUM(size),0) s FROM files WHERE trashed=0 AND user_id=?',
                     (user_id,)).fetchone()
    conn.close()
    return r['s'] or 0


# ---------- settings (key-value) ----------

def get_setting(key, default=None):
    conn = get_db()
    try:
        r = conn.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
        return r['value'] if r else default
    except sqlite3.OperationalError:
        return default
    finally:
        conn.close()


def set_setting(key, value):
    conn = get_db()
    conn.execute('INSERT INTO settings (key, value) VALUES (?,?)'
                 ' ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, str(value)))
    conn.commit()
    conn.close()


# ---------- activity log (per user) ----------

def log_activity(action, user_id, file_id=None, file_name=None, folder_id=None,
                 folder_name=None, detail=None, account_id=None):
    """Catat satu aktivitas. account_id=None -> pakai akun aktif user tsb."""
    if account_id is None and user_id is not None:
        account_id = _active_id(user_id)
    conn = get_db()
    try:
        conn.execute(
            'INSERT INTO activity_log (account_id, action, file_id, file_name,'
            ' folder_id, folder_name, detail, created_at, user_id)'
            ' VALUES (?,?,?,?,?,?,?,?,?)',
            (account_id, action, file_id, file_name, folder_id, folder_name, detail,
             datetime.now().isoformat(timespec='seconds'), user_id))
        conn.commit()
    except sqlite3.OperationalError:
        pass
    finally:
        conn.close()


def list_activity(user_id, action=None, q=None, since=None, until=None, order='desc',
                  limit=50, offset=0, account_id=None):
    if account_id is None:
        account_id = _active_id(user_id)
    sql = 'SELECT * FROM activity_log WHERE user_id=? AND (account_id IS ? OR account_id IS NULL)'
    params = [user_id, account_id]
    if action:
        sql += ' AND action=?'
        params.append(action)
    if q:
        sql += ' AND (file_name LIKE ? OR folder_name LIKE ? OR detail LIKE ?)'
        params += ['%' + q + '%'] * 3
    if since:
        sql += ' AND created_at >= ?'
        params.append(since)
    if until:
        sql += ' AND created_at < ?'
        params.append(until)
    sql += ' ORDER BY id ' + ('ASC' if order == 'asc' else 'DESC')
    sql += ' LIMIT ? OFFSET ?'
    params += [limit, offset]
    conn = get_db()
    try:
        rows = conn.execute(sql, params).fetchall()
    except sqlite3.OperationalError:
        rows = []
    conn.close()
    return [dict(r) for r in rows]


# ---------- folders (per user) ----------

def get_folder(fid, user_id):
    conn = get_db()
    r = conn.execute('SELECT * FROM folders WHERE id=? AND user_id=?', (fid, user_id)).fetchone()
    conn.close()
    return _row_to_dict(r)

def list_folders(user_id, account_id=None):
    account_id = _acc_filter(user_id, account_id)
    conn = get_db()
    try:
        rows = conn.execute('SELECT * FROM folders WHERE user_id=? AND account_id IS ? ORDER BY name',
                            (user_id, account_id)).fetchall()
    except sqlite3.OperationalError:
        rows = []
    conn.close()
    return [dict(r) for r in rows]


def folder_stats(fid, user_id, account_id=None):
    """Ukuran total folder (termasuk semua subfolder), jumlah file & subfolder."""
    account_id = _acc_filter(user_id, account_id)
    conn = get_db()
    ids = [fid]
    i = 0
    while i < len(ids):
        rows = conn.execute('SELECT id FROM folders WHERE parent_id=? AND user_id=? AND account_id IS ?',
                            (ids[i], user_id, account_id)).fetchall()
        ids.extend(r[0] for r in rows)
        i += 1
    q = ','.join('?' * len(ids))
    r = conn.execute('SELECT COUNT(*), COALESCE(SUM(size),0) FROM files WHERE folder_id IN (%s)'
                     ' AND trashed=0 AND user_id=? AND account_id IS ?' % q,
                     (*ids, user_id, account_id)).fetchone()
    conn.close()
    return {'size': r[1] or 0, 'files': r[0] or 0, 'folders': len(ids) - 1}


def find_folder(name, user_id, parent_id=None, account_id=None):
    """Cari folder berdasar nama + parent (untuk find-or-create saat upload folder)."""
    account_id = _acc_filter(user_id, account_id)
    conn = get_db()
    if parent_id is None:
        r = conn.execute('SELECT id FROM folders WHERE name=? AND parent_id IS NULL AND user_id=? AND account_id IS ?',
                         (name.strip(), user_id, account_id)).fetchone()
    else:
        r = conn.execute('SELECT id FROM folders WHERE name=? AND parent_id=? AND user_id=? AND account_id IS ?',
                         (name.strip(), parent_id, user_id, account_id)).fetchone()
    conn.close()
    return r[0] if r else None


def add_folder(name, user_id, parent_id=None, account_id=None):
    account_id = _active_id(user_id) if account_id is None else account_id
    conn = get_db()
    cur = conn.execute('INSERT INTO folders (name, parent_id, created_at, account_id, user_id) VALUES (?,?,?,?,?)',
                       (name.strip(), parent_id, datetime.now().isoformat(timespec='seconds'), account_id, user_id))
    fid = cur.lastrowid
    conn.commit()
    conn.close()
    return fid


def rename_folder(fid, user_id, name):
    conn = get_db()
    conn.execute('UPDATE folders SET name=? WHERE id=? AND user_id=?', (name.strip()[:80], fid, user_id))
    conn.commit()
    conn.close()


def set_folder_lock(fid, user_id, locked):
    conn = get_db()
    conn.execute('UPDATE folders SET is_locked=? WHERE id=? AND user_id=?', (1 if locked else 0, fid, user_id))
    conn.commit()
    conn.close()


def folder_parent_map(user_id, account_id=None):
    """{id: (parent_id, is_locked)} untuk semua folder user (akun aktif)."""
    account_id = _acc_filter(user_id, account_id)
    conn = get_db()
    try:
        rows = conn.execute('SELECT id, parent_id, is_locked FROM folders WHERE user_id=? AND account_id IS ?',
                            (user_id, account_id)).fetchall()
    except sqlite3.OperationalError:
        rows = []
    conn.close()
    return {r['id']: (r['parent_id'], r['is_locked'] or 0) for r in rows}


def folder_chain_ids(fid, pmap=None, user_id=None):
    """ID folder dari fid sampai root (termasuk fid)."""
    if pmap is None:
        pmap = folder_parent_map(user_id)
    ids, seen, cur = [], set(), fid
    while cur and cur not in seen:
        seen.add(cur)
        ids.append(cur)
        cur = pmap.get(cur, (None, 0))[0]
    return ids


def locked_subtree_ids(user_id, account_id=None):
    """ID folder yang terkunci atau berada di dalam folder terkunci."""
    pmap = folder_parent_map(user_id, account_id)
    out = set()
    for fid in pmap:
        for c in folder_chain_ids(fid, pmap):
            if pmap.get(c, (None, 0))[1]:
                out.add(fid)
                break
    return out


def delete_folder(fid, user_id):
    """Hapus folder + seluruh subfolder: semua file di dalamnya dipindah ke tong sampah (root)."""
    conn = get_db()
    # pastikan folder milik user
    if not conn.execute('SELECT 1 FROM folders WHERE id=? AND user_id=?', (fid, user_id)).fetchone():
        conn.close()
        return 0
    ids = [fid]
    i = 0
    while i < len(ids):
        rows = conn.execute('SELECT id FROM folders WHERE parent_id=? AND user_id=?',
                            (ids[i], user_id)).fetchall()
        ids.extend(r[0] for r in rows)
        i += 1
    q = ','.join('?' * len(ids))
    cur = conn.execute('UPDATE files SET trashed=1, folder_id=NULL WHERE folder_id IN (%s) AND user_id=?' % q,
                       (*ids, user_id))
    n = cur.rowcount
    conn.execute('DELETE FROM folders WHERE id IN (%s) AND user_id=?' % q, (*ids, user_id))
    conn.commit()
    conn.close()
    return n


def rename_file(fid, user_id, name):
    conn = get_db()
    conn.execute('UPDATE files SET name=? WHERE id=? AND user_id=?',
                 (name.strip()[:200], fid, user_id))
    conn.commit()
    conn.close()


# ---------- shares (per user; bearer token untuk akses publik) ----------

def create_share(file_id, user_id, hours):
    import secrets
    from datetime import timedelta
    token = secrets.token_urlsafe(24)
    exp = (datetime.now() + timedelta(hours=hours)).isoformat(timespec='seconds')
    conn = get_db()
    conn.execute('INSERT INTO shares (file_id, token, expires_at, user_id) VALUES (?,?,?,?)',
                 (file_id, token, exp, user_id))
    conn.commit()
    conn.close()
    return token, exp


def get_share(token):
    conn = get_db()
    r = conn.execute("""SELECT s.*, f.user_id AS fuser, f.trashed FROM shares s
                        JOIN files f ON f.id = s.file_id WHERE s.token=?""", (token,)).fetchone()
    conn.close()
    if not r:
        return None
    d = dict(r)
    if d['expires_at'] < datetime.now().isoformat(timespec='seconds'):
        return None
    if d['user_id'] != d['fuser'] or d['trashed']:
        return None
    return d


# ---------- users ----------

def create_user(username, password_hash, role='user', is_pro=0, quota_mb=102400):
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO users (username, password_hash, role, is_pro, quota_mb, is_active, created_at)"
        " VALUES (?,?,?,?,?,?,?)",
        (username.strip()[:40], password_hash, role, 1 if is_pro else 0, int(quota_mb), 1,
         datetime.now().isoformat(timespec='seconds')))
    uid = cur.lastrowid
    conn.commit()
    conn.close()
    return uid


def get_user(uid):
    conn = get_db()
    r = conn.execute('SELECT id, username, role, is_pro, quota_mb, is_active, created_at, display_name'
                     ' FROM users WHERE id=?', (uid,)).fetchone()
    conn.close()
    return _row_to_dict(r)


def get_user_auth(username):
    """Untuk login: termasuk password_hash."""
    conn = get_db()
    r = conn.execute('SELECT * FROM users WHERE username=?', ((username or '').strip(),)).fetchone()
    conn.close()
    return _row_to_dict(r)


def list_users():
    conn = get_db()
    rows = conn.execute(
        'SELECT u.id, u.username, u.display_name, u.role, u.is_pro, u.quota_mb, u.is_active, u.created_at,'
        ' (SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.user_id=u.id AND f.trashed=0) AS used_bytes,'
        ' (SELECT COUNT(*) FROM files f WHERE f.user_id=u.id AND f.trashed=0) AS file_count'
        ' FROM users u ORDER BY u.id').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def count_admins():
    conn = get_db()
    r = conn.execute("SELECT COUNT(*) c FROM users WHERE role='admin' AND is_active=1").fetchone()
    conn.close()
    return r['c']


def set_user_fields(uid, **kw):
    allowed = {'is_active': int, 'is_pro': int, 'quota_mb': int, 'role': str}
    sets, vals = [], []
    for k, conv in allowed.items():
        if k in kw:
            v = kw[k]
            if k == 'role' and v not in ('admin', 'user'):
                continue
            sets.append('%s=?' % k)
            vals.append(conv(v))
    if not sets:
        return False
    conn = get_db()
    conn.execute('UPDATE users SET %s WHERE id=?' % ','.join(sets), (*vals, uid))
    conn.commit()
    conn.close()
    return True


def delete_user(uid):
    """Hapus user + SELURUH datanya. Kembalikan info akun untuk cleanup Telegram."""
    conn = get_db()
    u = conn.execute('SELECT role FROM users WHERE id=?', (uid,)).fetchone()
    if not u:
        conn.close()
        return None
    if u['role'] == 'admin' and count_admins() <= 1:
        conn.close()
        raise ValueError('Admin terakhir tidak bisa dihapus.')
    accs = [dict(r) for r in conn.execute('SELECT id FROM tg_accounts WHERE user_id=?', (uid,))]
    cleaned = []
    for a in accs:
        info = _delete_account_rows(conn, a['id'], uid)
        if info:
            cleaned.append(info)
    conn.execute('DELETE FROM shares WHERE user_id=?', (uid,))
    conn.execute('DELETE FROM activity_log WHERE user_id=?', (uid,))
    conn.execute('DELETE FROM user_settings WHERE user_id=?', (uid,))
    conn.execute('DELETE FROM users WHERE id=?', (uid,))
    conn.commit()
    conn.close()
    return cleaned


# ---------- invite codes ----------

def create_invite_code(code, bonus_quota_mb=0, max_uses=1, created_by=None):
    conn = get_db()
    cur = conn.execute(
        'INSERT INTO invite_codes (code, bonus_quota_mb, max_uses, used_count, is_active, created_by, created_at)'
        ' VALUES (?,?,?,?,?,?,?)',
        (code.strip()[:32], int(bonus_quota_mb), max(1, int(max_uses)), 0, 1, created_by,
         datetime.now().isoformat(timespec='seconds')))
    cid = cur.lastrowid
    conn.commit()
    conn.close()
    return cid


def list_invite_codes():
    conn = get_db()
    rows = conn.execute('SELECT * FROM invite_codes ORDER BY id DESC').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def redeem_invite_code(code):
    """Validasi & pakai satu jatah kode. Kembalikan bonus_quota_mb atau None bila tidak valid."""
    conn = get_db()
    r = conn.execute('SELECT * FROM invite_codes WHERE code=?', ((code or '').strip(),)).fetchone()
    if not r or not r['is_active'] or r['used_count'] >= r['max_uses']:
        conn.close()
        return None
    conn.execute('UPDATE invite_codes SET used_count=used_count+1 WHERE id=?', (r['id'],))
    conn.commit()
    conn.close()
    return r['bonus_quota_mb'] or 0


def set_invite_active(cid, active):
    conn = get_db()
    conn.execute('UPDATE invite_codes SET is_active=? WHERE id=?', (1 if active else 0, cid))
    conn.commit()
    conn.close()


def delete_invite_code(cid):
    conn = get_db()
    conn.execute('DELETE FROM invite_codes WHERE id=?', (cid,))
    conn.commit()
    conn.close()


# ---------- token handoff login antar-domain ----------

def create_login_token(user_id, ttl_seconds=90):
    """Buat token login sekali pakai untuk pindah domain tanpa login ulang.
    Kembalikan token plaintext (di DB hanya disimpan hash-nya)."""
    import secrets
    import hashlib
    token = secrets.token_urlsafe(32)
    th = hashlib.sha256(token.encode()).hexdigest()
    now = datetime.now()
    exp = now + timedelta(seconds=max(10, min(600, int(ttl_seconds or 90))))
    conn = get_db()
    # janitor: buang token yang sudah kedaluwarsa
    conn.execute('DELETE FROM login_tokens WHERE expires_at <= ?', (now.isoformat(timespec='seconds'),))
    conn.execute(
        'INSERT INTO login_tokens (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
        (th, user_id, now.isoformat(timespec='seconds'), exp.isoformat(timespec='seconds')))
    conn.commit()
    conn.close()
    return token


def consume_login_token(token):
    """Validasi & hanguskan token. Kembalikan user_id atau None bila tidak valid."""
    import hashlib
    th = hashlib.sha256((token or '').encode()).hexdigest()
    now = datetime.now().isoformat(timespec='seconds')
    conn = get_db()
    r = conn.execute(
        'SELECT id, user_id FROM login_tokens WHERE token_hash=? AND used=0 AND expires_at > ?',
        (th, now)).fetchone()
    if not r:
        conn.close()
        return None
    conn.execute('UPDATE login_tokens SET used=1 WHERE id=?', (r['id'],))
    conn.commit()
    conn.close()
    return r['user_id']


# ---------- lisensi ----------

def _gen_license_code():
    import secrets
    return 'TGDRIVE-' + secrets.token_hex(2).upper() + '-' + secrets.token_hex(2).upper()


def create_license(tier, quota_mb=0, duration_days=None, created_by=None, note=''):
    """Buat satu kode lisensi. Kembalikan code."""
    conn = get_db()
    for _ in range(5):
        code = _gen_license_code()
        try:
            conn.execute(
                'INSERT INTO licenses (code, tier, quota_mb, duration_days, created_at, created_by, note)'
                ' VALUES (?,?,?,?,?,?,?)',
                (code, tier, int(quota_mb or 0),
                 None if duration_days is None else int(duration_days),
                 datetime.now().isoformat(timespec='seconds'), created_by, note or ''))
            conn.commit()
            conn.close()
            return code
        except sqlite3.IntegrityError:
            continue
    conn.close()
    return None


def list_licenses():
    conn = get_db()
    rows = conn.execute(
        'SELECT l.*, u.username AS redeemed_username FROM licenses l'
        ' LEFT JOIN users u ON u.id = l.redeemed_by ORDER BY l.id DESC').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_license_by_code(code):
    conn = get_db()
    r = conn.execute('SELECT * FROM licenses WHERE code=?', ((code or '').strip().upper(),)).fetchone()
    conn.close()
    return dict(r) if r else None


def redeem_license(code, user_id):
    """Tukar kode lisensi. Kembalikan (ok, pesan, lisensi)."""
    code = (code or '').strip().upper()
    conn = get_db()
    r = conn.execute('SELECT * FROM licenses WHERE code=?', (code,)).fetchone()
    if not r:
        conn.close()
        return False, 'Kode tidak ditemukan.', None
    lic = dict(r)
    if lic['status'] != 'active':
        conn.close()
        return False, 'Kode lisensi ini sudah dicabut.', None
    if lic['redeemed_by']:
        conn.close()
        return False, 'Kode ini sudah dipakai.', None
    now = datetime.now()
    exp = None
    if lic['duration_days']:
        exp = (now + timedelta(days=int(lic['duration_days']))).isoformat(timespec='seconds')
    conn.execute('UPDATE licenses SET redeemed_by=?, redeemed_at=?, expires_at=? WHERE id=?',
                 (user_id, now.isoformat(timespec='seconds'), exp, lic['id']))
    # kuota user hanya naik (tidak pernah turun otomatis)
    if lic['quota_mb']:
        u = conn.execute('SELECT quota_mb FROM users WHERE id=?', (user_id,)).fetchone()
        if u and (u['quota_mb'] or 0) < lic['quota_mb']:
            conn.execute('UPDATE users SET quota_mb=? WHERE id=?', (lic['quota_mb'], user_id))
    conn.commit()
    conn.close()
    lic['redeemed_by'] = user_id
    lic['expires_at'] = exp
    return True, 'Lisensi aktif!', lic


def set_license_status(lid, status):
    conn = get_db()
    conn.execute('UPDATE licenses SET status=? WHERE id=?', (status, lid))
    conn.commit()
    conn.close()


def delete_license(lid):
    conn = get_db()
    conn.execute('DELETE FROM licenses WHERE id=?', (lid,))
    conn.commit()
    conn.close()


def get_active_license(user_id):
    """Lisensi aktif (belum dicabut & belum kedaluwarsa) milik user, atau None."""
    if not user_id:
        return None
    now = datetime.now().isoformat(timespec='seconds')
    conn = get_db()
    r = conn.execute(
        "SELECT * FROM licenses WHERE redeemed_by=? AND status='active'"
        " AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC LIMIT 1",
        (user_id, now)).fetchone()
    conn.close()
    return dict(r) if r else None


def has_active_license(user_id):
    return get_active_license(user_id) is not None


# ---------- user settings ----------

def get_user_setting(user_id, key, default=None):
    conn = get_db()
    r = conn.execute('SELECT value FROM user_settings WHERE user_id=? AND key=?',
                     (user_id, key)).fetchone()
    conn.close()
    return r['value'] if r else default


def set_user_setting(user_id, key, value):
    conn = get_db()
    conn.execute('INSERT INTO user_settings (user_id, key, value) VALUES (?,?,?)'
                 ' ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value',
                 (user_id, key, value))
    conn.commit()
    conn.close()

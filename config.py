"""Konfigurasi TG Drive — dibaca dari .env (tidak ada secret di kode)."""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
CACHE_DIR = os.path.join(DATA_DIR, 'cache')
THUMB_DIR = os.path.join(DATA_DIR, 'thumbs')
TMP_DIR = os.path.join(DATA_DIR, 'tmp')


def _load_env():
    env_path = os.path.join(BASE_DIR, '.env')
    if not os.path.exists(env_path):
        return
    with open(env_path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)


_load_env()

BOT_TOKEN = os.environ.get('TG_BOT_TOKEN', '')
CHANNEL_ID = os.environ.get('TG_CHANNEL_ID', '')
SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-ganti-di-env')
ADMIN_PASSWORD_HASH = os.environ.get('ADMIN_PASSWORD_HASH', '')

BOT_API_BASE = os.environ.get('BOT_API_BASE', 'https://api.telegram.org')  # server Bot API lokal -> http://127.0.0.1:8081

MAX_UPLOAD_BYTES = int(os.environ.get('MAX_UPLOAD_MB', 20)) * 1024 * 1024  # default 20 MB (Bot API publik); 2048 saat Bot API lokal aktif


def _ensure_token_enc_key():
    """Kunci enkripsi token bot (Fernet). Dibuat sekali & disimpan di .env bila belum ada."""
    key = os.environ.get('TOKEN_ENC_KEY')
    if key:
        return key
    try:
        from cryptography.fernet import Fernet
        key = Fernet.generate_key().decode()
    except ImportError:
        return ''
    try:
        with open(os.path.join(BASE_DIR, '.env'), 'a', encoding='utf-8') as f:
            f.write('\nTOKEN_ENC_KEY=%s\n' % key)
    except OSError:
        pass
    os.environ['TOKEN_ENC_KEY'] = key
    return key


TOKEN_ENC_KEY = _ensure_token_enc_key()
CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024    # cache unduhan maks 2 GB, auto-bersih

for _d in (DATA_DIR, CACHE_DIR, THUMB_DIR, TMP_DIR):
    os.makedirs(_d, exist_ok=True)


def tg_configured():
    return bool(BOT_TOKEN and CHANNEL_ID)

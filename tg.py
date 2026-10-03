"""Klien Bot API Telegram untuk TG Drive — kredensial dari akun aktif (DB), fallback .env."""
import os
import shutil

import requests

import config


class TgError(Exception):
    pass


_session = None


def _sess():
    """Satu session untuk keep-alive koneksi HTTPS ke Telegram (lebih cepat)."""
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update({'User-Agent': 'TGDrive/1.0'})
    return _session


def _creds(bot_token=None, channel_id=None):
    """(token, channel_id): WAJIB eksplisit (multi-user). Tanpa fallback,
    agar bug pemanggilan gagal keras, bukan memakai bot orang lain."""
    if bot_token and channel_id:
        return bot_token, channel_id
    raise TgError('Kredensial Telegram tidak diberikan')


def _api(bot_token=None, channel_id=None):
    token, _ = _creds(bot_token, channel_id)
    if not token:
        raise TgError('Bot Telegram belum dikonfigurasi')
    return config.BOT_API_BASE.rstrip('/') + '/bot' + token


def _file_base(bot_token=None, channel_id=None):
    token, _ = _creds(bot_token, channel_id)
    return config.BOT_API_BASE.rstrip('/') + '/file/bot' + token


def _chat_id(bot_token=None, channel_id=None):
    _, ch = _creds(bot_token, channel_id)
    if not ch:
        raise TgError('Channel Telegram belum dikonfigurasi')
    return ch


def _check(resp):
    try:
        j = resp.json()
    except Exception:
        raise TgError('Respons Telegram tidak valid (HTTP %s)' % resp.status_code)
    if not j.get('ok'):
        raise TgError(j.get('description', 'Telegram API error'))
    return j['result']


def _post(method, data=None, files=None, bot_token=None, channel_id=None, timeout=120):
    r = _sess().post(_api(bot_token, channel_id) + method, data=data, files=files, timeout=timeout)
    return _check(r)


def send_photo(path, caption='', creds=None):
    bt, ch = creds or (None, None)
    with open(path, 'rb') as f:
        res = _post('/sendPhoto', data={'chat_id': _chat_id(bt, ch), 'caption': caption[:900]},
                    files={'photo': f}, bot_token=bt, channel_id=ch)
    photos = res.get('photo', [])
    biggest = max(photos, key=lambda p: p.get('file_size', 0)) if photos else {}
    smallest = min(photos, key=lambda p: p.get('file_size', 0)) if photos else {}
    return {
        'file_id': biggest.get('file_id'),
        'thumb_file_id': smallest.get('file_id') if smallest != biggest else None,
        'message_id': res.get('message_id'),
        'width': biggest.get('width'),
        'height': biggest.get('height'),
    }


def send_video(path, caption='', creds=None):
    bt, ch = creds or (None, None)
    with open(path, 'rb') as f:
        res = _post('/sendVideo',
                    data={'chat_id': _chat_id(bt, ch), 'caption': caption[:900], 'supports_streaming': True},
                    files={'video': f}, bot_token=bt, channel_id=ch, timeout=300)
    v = res.get('video', {})
    thumb = v.get('thumb') or v.get('thumbnail') or {}
    return {
        'file_id': v.get('file_id'),
        'thumb_file_id': thumb.get('file_id'),
        'message_id': res.get('message_id'),
        'width': v.get('width'),
        'height': v.get('height'),
        'duration': v.get('duration'),
    }


def send_document(path, filename, caption='', creds=None):
    bt, ch = creds or (None, None)
    with open(path, 'rb') as f:
        res = _post('/sendDocument', data={'chat_id': _chat_id(bt, ch), 'caption': caption[:900]},
                    files={'document': (filename, f)}, bot_token=bt, channel_id=ch, timeout=300)
    d = res.get('document', {})
    thumb = d.get('thumb') or d.get('thumbnail') or {}
    return {
        'file_id': d.get('file_id'),
        'thumb_file_id': thumb.get('file_id'),
        'message_id': res.get('message_id'),
    }


def get_file_url(file_id, creds=None):
    bt, ch = creds or (None, None)
    r = _sess().get(_api(bt, ch) + '/getFile', params={'file_id': file_id}, timeout=600)
    res = _check(r)
    return _file_base(bt, ch) + '/' + res['file_path']


def get_file_local_path(file_id, creds=None):
    """Path lokal absolut dari getFile (mode --local server Bot API).

    Mengembalikan path bila server mengembalikan absolute path, atau None
    bila masih berupa URL (mode cloud / non-local)."""
    bt, ch = creds or (None, None)
    r = _sess().get(_api(bt, ch) + '/getFile', params={'file_id': file_id}, timeout=600)
    res = _check(r)
    p = res.get('file_path') or ''
    if p.startswith('/'):
        return p
    return None


def download_file(file_id, dest_path, creds=None):
    bt, ch = creds or (None, None)
    local = get_file_local_path(file_id, creds)
    if local:
        # server Bot API lokal (--local): file sudah ada di disk, tinggal salin
        if not os.path.exists(local):
            raise TgError('File lokal tidak ditemukan di server Bot API')
        shutil.copyfile(local, dest_path)
        return dest_path
    url = get_file_url(file_id, creds)
    with _sess().get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(dest_path, 'wb') as f:
            for chunk in r.iter_content(chunk_size=1024 * 256):
                if chunk:
                    f.write(chunk)
    return dest_path


def delete_message(message_id, creds=None):
    bt, ch = creds or (None, None)
    try:
        _post('/deleteMessage', data={'chat_id': _chat_id(bt, ch), 'message_id': message_id},
              bot_token=bt, channel_id=ch, timeout=30)
        return True
    except TgError:
        return False


def get_me(creds=None):
    """Tes koneksi: kembalikan info bot. creds=(token, channel) opsional untuk tes akun baru."""
    bt, ch = creds or (None, None)
    r = _sess().get(_api(bt, ch) + '/getMe', timeout=30)
    return _check(r)


def check_channel_access(creds=None):
    """Pastikan bot bisa mengakses channel: kembalikan (judul_channel, status_bot).

    Melempar TgError bila channel tidak ditemukan / bot bukan anggota —
    dipakai saat Tes Koneksi & simpan akun agar channel bermasalah
    ketahuan di awal, bukan saat upload gagal."""
    bt, ch = creds or (None, None)
    token, channel = _creds(bt, ch)
    base = config.BOT_API_BASE.rstrip('/') + '/bot' + token
    chat = _check(_sess().get(base + '/getChat', params={'chat_id': channel}, timeout=30))
    me = _check(_sess().get(base + '/getMe', timeout=30))
    member = _check(_sess().get(base + '/getChatMember',
                                params={'chat_id': channel, 'user_id': me['id']}, timeout=30))
    status = (member or {}).get('status', '')
    if status not in ('administrator', 'creator'):
        raise TgError('Bot bukan admin channel (status: %s). Jadikan bot sebagai admin channel dulu.' % (status or 'bukan anggota'))
    return chat.get('title', '?'), status

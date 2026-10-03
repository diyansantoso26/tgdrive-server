#!/usr/bin/env python3
"""Publish tgdrive-server ke GitHub: buat repo, push semua file (idempotent)."""
import base64
import json
import os
import sys
import urllib.request
import urllib.error

sys.path.insert(0, '/opt/hatch/skills/skill-creator/bin')
from dynamic_credentials import add_surrogate_to_request, read_response_body

HOST = 'api.github.com'
ME, REPO = 'diyansantoso26', 'tgdrive-server'
SRC = os.path.expanduser('~/workspace/tgdrive-server')
SKIP = {'.git', '__pycache__', 'venv', '.venv'}


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f'https://{HOST}{path}', data=data, method=method)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('X-GitHub-Api-Version', '2022-11-28')
    if data:
        req.add_header('Content-Type', 'application/json')
    add_surrogate_to_request(req, 'custom.github', allowed_hosts=[HOST])
    try:
        resp = urllib.request.urlopen(req, timeout=180)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {'http_error': 404}
        print(f'HTTP {e.code}: {e.read().decode()[:300]}')
        sys.exit(1)
    raw = read_response_body(resp)
    return json.loads(raw.decode()) if raw.strip() else {'ok': True}


def main():
    if api('GET', f'/repos/{ME}/{REPO}').get('http_error') == 404:
        r = api('POST', '/user/repos', {'name': REPO,
               'description': 'TG Drive — server cloud pribadi berbasis Telegram (Flask)',
               'private': False, 'auto_init': False})
        print('repo dibuat:', r.get('html_url'))
    else:
        print('repo sudah ada')

    files = []
    for root, dirs, names in os.walk(SRC):
        dirs[:] = [d for d in dirs if d not in SKIP and not d.startswith('.')]
        for n in names:
            if n == 'publish.py':
                continue
            full = os.path.join(root, n)
            files.append((os.path.relpath(full, SRC), full))
    print(f'{len(files)} file')
    for rel, full in sorted(files):
        with open(full, 'rb') as f:
            content = base64.b64encode(f.read()).decode()
        cur = api('GET', f'/repos/{ME}/{REPO}/contents/{rel}')
        payload = {'message': f'tgdrive-server: {rel}', 'content': content}
        if isinstance(cur, dict) and cur.get('sha'):
            payload['sha'] = cur['sha']
        api('PUT', f'/repos/{ME}/{REPO}/contents/{rel}', payload)
        print('  ↑', rel)
    print('SELESAI: https://github.com/%s/%s' % (ME, REPO))


if __name__ == '__main__':
    main()

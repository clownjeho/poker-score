#!/usr/bin/env python3
"""
扑克积分计算器服务端 - Flask 版本
支持 PythonAnywhere / Zeabur 部署

改动要点（2026-10-01）:
  1) 静态文件白名单 —— 不再把 server.py / scores.json 暴露到公网
  2) 密码从环境变量读（POKER_USER / POKER_PASSWORD），源码不再硬编码
  3) 每次写入前自动备份 scores.json 到 backups/，保留最近 KEEP_BACKUPS 份
  4) /save 带 rev 版本校验：旧版本客户端提交会被拒（409 + 最新数据），避免互相覆盖
  5) 新增 /export 一键下载留档
  6) debug 关闭
"""

import os
import json
import shutil
import datetime
from functools import wraps
from flask import Flask, request, send_from_directory, jsonify, make_response

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE_DIR, 'scores.json')
BACKUP_DIR = os.path.join(BASE_DIR, 'backups')
KEEP_BACKUPS = 60

# 只允许这些文件被 HTTP 访问（其余一律 404）
STATIC_ALLOW = {
    'index.html', 'app.js', 'style.css',
    'favicon.ico', 'manifest.webmanifest', 'apple-touch-icon.png',
}

APP_USERNAME = os.environ.get('POKER_USER', '1')
APP_PASSWORD = os.environ.get('POKER_PASSWORD', 'gpdz@123')

app = Flask(__name__, static_folder=None)


def _now():
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


# ===== 密码验证装饰器 =====
def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.authorization
        if not auth or auth.username != APP_USERNAME or auth.password != APP_PASSWORD:
            response = make_response('Authentication required', 401)
            response.headers['WWW-Authenticate'] = 'Basic realm="Protected"'
            return response
        return f(*args, **kwargs)
    return decorated


# ===== 备份 =====
def _backup_current():
    """写入前把现有 scores.json 存一份快照，并清理超量备份。"""
    if not os.path.exists(DATA_FILE):
        return
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        stamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        dst = os.path.join(BACKUP_DIR, 'scores_%s.json' % stamp)
        if not os.path.exists(dst):
            shutil.copy2(DATA_FILE, dst)
        files = sorted(f for f in os.listdir(BACKUP_DIR)
                       if f.startswith('scores_') and f.endswith('.json'))
        for old in files[:-KEEP_BACKUPS]:
            os.remove(os.path.join(BACKUP_DIR, old))
    except Exception:
        # 备份失败不阻断主流程
        pass


def _read_state():
    if not os.path.exists(DATA_FILE):
        return None, 0
    try:
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return None, 0
        return data, int(data.get('rev') or 0)
    except Exception:
        return None, 0


# ===== 静态文件（需要密码，且只放行白名单）=====
@app.route('/')
@require_auth
def index():
    return send_from_directory(BASE_DIR, 'index.html')


@app.route('/<path:filename>')
@require_auth
def static_files(filename):
    if filename not in STATIC_ALLOW:
        return jsonify({'error': 'not found'}), 404
    return send_from_directory(BASE_DIR, filename)


# ===== API =====
@app.route('/load', methods=['GET'])
@require_auth
def load_data():
    data, rev = _read_state()
    if data is None:
        return jsonify(None)
    data['rev'] = rev
    return jsonify(data)


@app.route('/save', methods=['POST'])
@require_auth
def save_data():
    """保存数据。客户端需带上自己看到的 rev；落后于服务端则拒收。"""
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({'error': 'No data provided'}), 400
    if not isinstance(data, dict):
        return jsonify({'error': 'Bad payload'}), 400

    server_state, server_rev = _read_state()
    client_rev = int(data.get('rev') or 0)

    if client_rev < server_rev:
        return jsonify({
            'status': 'conflict',
            'rev': server_rev,
            'state': server_state,
            'server_time': _now(),
        }), 409

    data['rev'] = server_rev + 1
    data['updatedAt'] = datetime.datetime.now().isoformat(timespec='seconds')

    try:
        _backup_current()
        tmp = DATA_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, DATA_FILE)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    return jsonify({'status': 'ok', 'rev': data['rev'], 'server_time': _now()})


@app.route('/export', methods=['GET'])
@require_auth
def export_data():
    """下载当前记分数据（留档用）。"""
    if not os.path.exists(DATA_FILE):
        return jsonify({'error': 'no data'}), 404
    resp = make_response(send_from_directory(BASE_DIR, 'scores.json'))
    resp.headers['Content-Disposition'] = \
        'attachment; filename="scores_%s.json"' % datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    return resp


@app.route('/health', methods=['GET'])
@require_auth
def health():
    _, rev = _read_state()
    backups = 0
    if os.path.isdir(BACKUP_DIR):
        backups = len([f for f in os.listdir(BACKUP_DIR) if f.endswith('.json')])
    return jsonify({'ok': True, 'rev': rev, 'backups': backups,
                    'server_time': _now()})


# ===== 启动（本地开发用；PythonAnywhere 走 WSGI，不会执行这段）=====

# ===== 客户端强制刷新：静态资源禁缓存 + 代码指纹 =====
@app.after_request
def _no_store(resp):
    try:
        pth = (request.path or '/')
        if pth == '/' or pth.endswith(('.html', '.js', '.css', '.webmanifest')):
            resp.headers['Cache-Control'] = 'no-store, must-revalidate'
            resp.headers['Pragma'] = 'no-cache'
            resp.headers['Expires'] = '0'
    except Exception:
        pass
    return resp


@app.route('/version')
def _version():
    """返回当前代码指纹。换文件后指纹立刻变化，客户端据此自动刷新 UI。"""
    import hashlib
    base = os.path.dirname(os.path.abspath(__file__))
    h = hashlib.sha1()
    for f in ('index.html', 'app.js', 'style.css'):
        try:
            with open(os.path.join(base, f), 'rb') as fh:
                h.update(fh.read())
        except OSError:
            pass
    return jsonify({'build': h.hexdigest()[:10]})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, debug=False)

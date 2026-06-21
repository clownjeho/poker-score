#!/usr/bin/env python3
"""
扑克积分计算器服务端 - Flask 版本
支持 PythonAnywhere 部署
密码保护：gpdz@123
"""

import os
import json
from functools import wraps
from flask import Flask, request, send_from_directory, jsonify, make_response

app = Flask(__name__, static_folder='.')
DATA_FILE = os.path.join(os.path.dirname(__file__), 'scores.json')
APP_PASSWORD = 'gpdz@123'  # 网站访问密码

# ===== 密码验证装饰器 =====
def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.authorization
        if not auth or auth.password != APP_PASSWORD:
            response = make_response('Authentication required', 401)
            response.headers['WWW-Authenticate'] = 'Basic realm="Protected"'
            return response
        return f(*args, **kwargs)
    return decorated

# ===== 静态文件（需要密码）=====
@app.route('/')
@require_auth
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:filename>')
@require_auth
def static_files(filename):
    return send_from_directory('.', filename)

# ===== API 接口（需要密码）=====
@app.route('/save', methods=['POST'])
@require_auth
def save_data():
    """保存数据到文件"""
    data = request.get_json()
    if data is None:
        return jsonify({'error': 'No data provided'}), 400
    
    try:
        with open(DATA_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return jsonify({'status': 'ok'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/load', methods=['GET'])
@require_auth
def load_data():
    """从文件加载数据"""
    try:
        if os.path.exists(DATA_FILE):
            with open(DATA_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return jsonify(data)
        else:
            return jsonify(None)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ===== 启动 =====
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port, debug=True)
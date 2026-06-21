#!/usr/bin/env python3
"""扑克积分计算器服务端——支持多人共享数据"""

import json
import os
from http.server import HTTPServer, SimpleHTTPRequestHandler

DATA_FILE = os.path.join(os.path.dirname(__file__), 'scores.json')


class PokerHandler(SimpleHTTPRequestHandler):
    """扩展 HTTP 服务：GET /load 读取数据，POST /save 写入数据"""

    def do_GET(self):
        if self.path == '/load':
            self._send_cors_headers()
            if os.path.exists(DATA_FILE):
                with open(DATA_FILE, 'r', encoding='utf-8') as f:
                    data = f.read()
                self.wfile.write(data.encode('utf-8'))
            else:
                self.wfile.write(b'null')
            return
        # 其他请求按原样返回静态文件
        super().do_GET()

    def do_POST(self):
        if self.path == '/save':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            # 写入文件
            with open(DATA_FILE, 'w', encoding='utf-8') as f:
                f.write(body.decode('utf-8'))
            self._send_cors_headers()
            self.wfile.write(b'{"status":"ok"}')
            return
        self.send_response(404)
        self.end_headers()

    def do_OPTIONS(self):
        self._send_cors_headers()
        self.wfile.write(b'{"status":"ok"}')

    def _send_cors_headers(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    addr = ('0.0.0.0', port)
    server = HTTPServer(addr, PokerHandler)
    print(f'🎴 扑克积分服务已启动：http://0.0.0.0:{port}')
    print(f'   📄 本机访问： http://localhost:{port}')
    print(f'   🌐 局域网访问：http://你的IP:{port}')
    print(f'   💾 数据文件：{DATA_FILE}')
    print(f'   (Ctrl+C 停止服务)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n服务已停止')
        server.server_close()

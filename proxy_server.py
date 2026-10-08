#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
AI 请求本地代理（解决预览环境的 CSP 拦截）

背景：
  预览面板的页面由 WorkBuddy 自带服务下发，响应头带 Content-Security-Policy，
  connect-src 只允许 'self' 和 http://127.0.0.1:*，直连 api.deepseek.com /
  open.bigmodel.cn 会被浏览器拦掉（"Refused to connect ... violates CSP"）。
  CSP 多策略取交集，页面里的 <meta> 标签只能更严、不能更松，所以改不了。

做法：
  在本机 127.0.0.1 上起一个转发服务，页面请求同机的代理（命中 127.0.0.1:* 白名单），
  代理再转发到真实 API。既绕过 CSP，也顺带解决跨域（代理自己回 CORS 头）。

  浏览器 ──http://127.0.0.1:8787/deepseek/...──▶ 本代理 ──https://api.deepseek.com/...──▶ 真实 API

用法：
  python proxy_server.py            # 默认监听 127.0.0.1:8787
  python proxy_server.py 9000       # 指定端口

  GET  /health                      → {"ok": true}  供前端探测可用性
  POST /deepseek/chat/completions   → 转发 https://api.deepseek.com/chat/completions
  POST /zhipu/api/paas/v4/...       → 转发 https://open.bigmodel.cn/api/paas/v4/...

只监听 127.0.0.1，不对外暴露；API Key 仍由前端携带原样转发，本代理不存储任何密钥。
"""

import json
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 路径前缀 → 上游域名
UPSTREAM = {
    "/deepseek": "https://api.deepseek.com",
    "/zhipu": "https://open.bigmodel.cn",
}

DEFAULT_PORT = 8787
UPSTREAM_TIMEOUT = 180          # 上游超时（秒），要比前端的 120s 更宽松
FORWARD_HEADERS = ("authorization", "content-type", "accept")


def build_upstream_url(path):
    """把 /deepseek/xxx 映射成 https://api.deepseek.com/xxx"""
    for prefix, origin in UPSTREAM.items():
        if path == prefix or path.startswith(prefix + "/"):
            rest = path[len(prefix):]
            return origin + rest
    return None


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ---------- CORS ----------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _log(self, message):
        sys.stderr.write("[proxy] %s\n" % message)
        sys.stderr.flush()

    # ---------- 预检 ----------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------- 健康检查 ----------
    def do_GET(self):
        if self.path.rstrip("/") == "/health":
            self._json(200, {"ok": True, "upstream": sorted(UPSTREAM.keys())})
            return
        self._json(404, {"error": "not found"})

    # ---------- 转发 ----------
    def do_POST(self):
        target = build_upstream_url(self.path)
        if not target:
            self._json(404, {"error": "unknown route: %s" % self.path, "routes": sorted(UPSTREAM.keys())})
            return

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""

        headers = {}
        for key in FORWARD_HEADERS:
            value = self.headers.get(key)
            if value:
                headers[key] = value

        req = urllib.request.Request(target, data=body, headers=headers, method="POST")
        self._log("→ %s (%d bytes)" % (target, len(body)))

        try:
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as resp:
                payload = resp.read()
                status = resp.status
                content_type = resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            # 上游返回的错误也要原样带回，前端才能看到真实原因（如余额不足、模型不存在）
            payload = e.read()
            status = e.code
            content_type = e.headers.get("Content-Type", "application/json")
            self._log("← %d %s" % (status, payload[:200].decode("utf-8", "ignore")))
        except Exception as e:
            self._log("上游请求失败: %s" % e)
            self._json(502, {"error": "upstream error: %s" % e})
            return

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self._cors()
        self.end_headers()
        self.wfile.write(payload)
        self._log("← %d (%d bytes)" % (status, len(payload)))

    def log_message(self, fmt, *args):
        pass          # 静音默认访问日志，避免刷屏


def main():
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print("端口必须是数字，使用默认端口 %d" % DEFAULT_PORT)

    server = ThreadingHTTPServer(("127.0.0.1", port), ProxyHandler)
    print("AI 代理已启动: http://127.0.0.1:%d" % port)
    print("  健康检查: http://127.0.0.1:%d/health" % port)
    for prefix, origin in sorted(UPSTREAM.items()):
        print("  %s/* → %s" % (prefix, origin))
    print("按 Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

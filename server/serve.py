"""
本地服务器 —— 零第三方依赖，只用 Python 标准库。

为什么必须起HTTP 服务而不能直接双击 HTML：
WebGPU 规范要求「安全上下文」（HTTPS 或 http://localhost）。在 file:// 下浏览器会
直接隐藏 navigator.gpu，表现为「这台机器不支持 WebGPU」，极具误导性。
本服务器固定监听 127.0.0.1，保证 localhost 环境成立。

用法：
    python server/serve.py [--port 7788] [--no-browser]
"""

from __future__ import annotations

import argparse
import http.server
import os
import socket
import socketserver
import sys
import threading
import webbrowser
from functools import partial
from pathlib import Path

# 项目根目录（server/ 的上一级）
ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
SHADER_DIR = ROOT / "shaders"

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wgsl": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    """把 web/ 作为站点根，同时把 shaders/ 暴露到 /shaders/。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def guess_type(self, path):
        ext = Path(str(path)).suffix.lower()
        return MIME_TYPES.get(ext, super().guess_type(path))

    def do_GET(self):
        # /shaders/xx.wgsl → 映射到仓库根的 shaders/ 目录
        if self.path.startswith("/shaders/"):
            self.path = self.path  # translate 已在下方统一处理
        super().do_GET()

    def translate_path(self, path):
        """把 /shaders/... 映射到项目的 shaders/ 目录，其余交给父类。"""
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/shaders/"):
            rel = clean.lstrip("/")
            return str(SHADER_DIR.parent / rel)
        return super().translate_path(path)

    def end_headers(self):
        # 开发期禁用缓存，改完着色器刷新即生效
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 静默常规请求，只在出错时打印
        if args and str(args[1] if len(args) > 1 else "").startswith(("4", "5")):
            sys.stderr.write(f"  [http] {self.address_string()} {fmt % args}\n")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def find_free_port(preferred: int) -> int:
    """优先用指定端口；被占用则自动找一个空闲端口。"""
    for port in [preferred, *range(preferred + 1, preferred + 40)]:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def check_environment() -> list[str]:
    """启动前自检，把问题提前暴露而不是让用户对着白屏猜。"""
    warnings = []
    if sys.version_info < (3, 8):
        warnings.append(f"Python 版本 {sys.version.split()[0]} 过低，建议 3.8+")
    if not WEB_DIR.exists():
        warnings.append(f"缺少前端目录：{WEB_DIR}")
    if not (SHADER_DIR / "mandelbrot_fractal.wgsl").exists():
        warnings.append(f"缺少着色器：{SHADER_DIR / 'mandelbrot_fractal.wgsl'}")
    return warnings


def main() -> int:
    ap = argparse.ArgumentParser(description="Manim 可视化本地服务器")
    ap.add_argument("--port", type=int, default=7788, help="端口（默认 7788，被占用会自动顺延）")
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址（保持 127.0.0.1 以满足安全上下文）")
    args = ap.parse_args()

    print("=" * 58)
    print("  Manim 可视化 —— 本地服务")
    print("=" * 58)

    for w in check_environment():
        print(f"  [警告] {w}")

    port = find_free_port(args.port)
    url = f"http://127.0.0.1:{port}/"

    try:
        httpd = Server((args.host, port), Handler)
    except OSError as e:
        print(f"  [错误] 无法启动服务器：{e}")
        return 1

    print(f"  地址：{url}")
    print(f"  根目录：{WEB_DIR}")
    print("  提示：WebGPU 需要 localhost 环境，请勿用 file:// 直接打开 HTML")
    print("  关闭：在此窗口按 Ctrl+C")
    print("=" * 58)

    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

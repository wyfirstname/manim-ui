#!/usr/bin/env python3
"""把 manim-ui 打成 Windows 绿色版 zip。

用法（在仓库任意位置执行均可，脚本自己定位仓库根）：
    python tools/make_zip.py                     # 纯源码包（使用者需自备 Python 3.8+）
    python tools/make_zip.py --with-python       # 内置便携 Python，解压双击即用
    python tools/make_zip.py --out 我的包.zip     # 自定义输出文件名

打包口径与 .gitignore 一致：只装「能跑起来的那套」——
启动.bat / server / shaders / web / README / LICENSE / 文档与预览图。
.git、.workbuddy、博文、调试用的诊断页一概不进。

--with-python 会从 python.org 下载官方 embeddable 发行版（约 11 MB），
解压后作为 runtime/python/ 一起打包。启动.bat 会优先使用它，
所以拿到包的人**不需要安装任何东西**。
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 白名单：这些才进包（目录以 / 结尾表示整目录递归）
INCLUDE = [
    "启动.bat",
    "README.md",
    "LICENSE",
    "server/",
    "shaders/",
    "web/",
    "docs/技术方案.md",
    "docs/previews/",
]

# 即便在白名单目录里，这些名字也不要
SKIP_NAMES = {"__pycache__", ".DS_Store", "Thumbs.db", "__tmp_ui.png"}

EMBED_URL = "https://www.python.org/ftp/python/3.13.1/python-3.13.1-embed-amd64.zip"


def git_version() -> str:
    """取一个版本串：有 tag 用 tag，否则用 短哈希+日期。失败就退回日期。"""
    try:
        tag = subprocess.run(
            ["git", "describe", "--tags", "--abbrev=0"],
            cwd=ROOT, capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        if tag:
            return tag
        short = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=ROOT, capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        if short:
            return short
    except Exception:
        pass
    import datetime
    return datetime.date.today().strftime("%Y%m%d")


def download(url: str, dest: Path) -> None:
    """先直连再走系统代理：有的机器只有代理能出去，有的代理反而拦。"""
    openers = [
        urllib.request.build_opener(urllib.request.ProxyHandler({})),  # 直连
        urllib.request.build_opener(),                                  # 环境变量里的代理
    ]
    last: Exception | None = None
    for opener in openers:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "manim-ui-packager"})
            with opener.open(req, timeout=120) as resp, open(dest, "wb") as f:
                shutil.copyfileobj(resp, f, length=1 << 20)
            return
        except Exception as e:  # noqa: BLE001
            last = e
    raise RuntimeError(f"下载失败：{url}\n{last}")


def fetch_portable_python(workdir: Path) -> Path:
    """下载并解压 embeddable Python，返回解压目录（runtime/python/）。"""
    target = workdir / "runtime" / "python"
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)

    print(f"  下载便携 Python：{EMBED_URL}")
    emb = workdir / "python-embed.zip"
    download(EMBED_URL, emb)
    print(f"  已下载 {emb.stat().st_size / 1e6:.1f} MB，解压中…")
    with zipfile.ZipFile(emb) as zf:
        zf.extractall(target)
    emb.unlink()

    exe = target / "python.exe"
    if not exe.exists():
        raise RuntimeError("embeddable 包里没有 python.exe，发行版可能变了")
    return target


def collect_files() -> list[tuple[Path, str]]:
    """按白名单收集要打包的 (绝对路径, zip 内相对路径)。"""
    out: list[tuple[Path, str]] = []
    for item in INCLUDE:
        src = ROOT / item
        if src.is_file():
            out.append((src, item))
        elif src.is_dir():
            for p in sorted(src.rglob("*")):
                if not p.is_file():
                    continue
                if any(part in SKIP_NAMES for part in p.parts):
                    continue
                out.append((p, p.relative_to(ROOT).as_posix()))
        else:
            print(f"  [警告] 白名单项不存在，跳过：{item}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="打包 manim-ui 绿色版 zip")
    ap.add_argument("--with-python", action="store_true", help="内置便携 Python（多 ~12 MB）")
    ap.add_argument("--out", help="输出文件名（默认按版本自动命名）")
    args = ap.parse_args()

    version = git_version()
    default_name = "manim-ui-portable.zip" if args.with_python else "manim-ui.zip"
    out_name = args.out or default_name
    out_path = ROOT / out_name

    files = collect_files()
    total = sum(p.stat().st_size for p, _ in files)
    print("=" * 58)
    print(f"  manim-ui 绿色版打包  v{version}")
    print(f"  源文件：{len(files)} 个，共 {total / 1e6:.1f} MB")
    print(f"  便携 Python：{'内置' if args.with_python else '不内置'}")
    print("=" * 58)

    with tempfile.TemporaryDirectory() as td:
        workdir = Path(td)
        py_prefix = None
        if args.with_python:
            pydir = fetch_portable_python(workdir)
            py_prefix = pydir.relative_to(workdir).as_posix()

        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            for src, rel in files:
                zf.write(src, f"manim-ui/{rel}")
            if py_prefix:
                for p in sorted(pydir.rglob("*")):
                    if p.is_file():
                        zf.write(p, f"manim-ui/{p.relative_to(workdir).as_posix()}")

    size = out_path.stat().st_size
    print(f"\n  完成：{out_path}")
    print(f"  大小：{size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

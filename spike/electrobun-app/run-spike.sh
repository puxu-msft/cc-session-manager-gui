#!/usr/bin/env bash
# Task 7/8 起窗运行脚本 —— 在 WSL2 + WSLg 下启动 Electrobun build 产物并捕获日志。
#
# 关键发现(本环境特有):
#   Electrobun 的 libNativeWrapper.so(GTK 原生包装层)在 Linux 下硬依赖
#   system-tray 库 libayatana-appindicator3.so.1 及其依赖链
#   (libayatana-indicator3 / libayatana-ido3 / libdbusmenu-glib / libdbusmenu-gtk3)。
#   本机未预装这些库。无 root 时可用 `apt-get download <pkg>` + `dpkg-deb -x` 解包到
#   本地目录,再用 LD_LIBRARY_PATH 注入即可起窗,无需 sudo。
#   webkit2gtk-4.1 与 gtk-3 运行库本机已装齐。
#
# 用法:
#   APPIND_LIB_DIR=/path/to/extracted/libs bash run-spike.sh [timeout_seconds]
#   未设 APPIND_LIB_DIR 时默认 /tmp/appind/libpool(本次 spike 使用的解包目录)。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINDIR="$HERE/build/dev-linux-x64/spike-dev/bin"
APPIND_LIB_DIR="${APPIND_LIB_DIR:-/tmp/appind/libpool}"
TIMEOUT="${1:-16}"

if [ ! -x "$BINDIR/launcher" ]; then
  echo "未找到 build 产物,请先运行: bunx electrobun build" >&2
  exit 1
fi

# 注入 appindicator 依赖链 + Electrobun 自带 bin(含 libasar.so)
export LD_LIBRARY_PATH="$APPIND_LIB_DIR:$BINDIR:${LD_LIBRARY_PATH:-}"

echo "=== ldd 检查(应无 'not found') ==="
ldd "$BINDIR/libNativeWrapper.so" 2>/dev/null | grep -i 'not found' || echo "ALL DEPS RESOLVED"

echo "=== 起窗(timeout ${TIMEOUT}s,无目视;看 WebKit 子进程 + GTK 事件循环是否启动) ==="
timeout "$TIMEOUT" "$BINDIR/launcher" 2>&1 || true

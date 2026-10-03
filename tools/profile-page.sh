#!/usr/bin/env bash
# 用无头浏览器加载酒馆页面并采集 V8 函数级采样，输出可分析的日志。
#   bash tools/profile-page.sh [秒数] [输出目录]
# 需要酒馆已在 127.0.0.1:8000 运行。
set -euo pipefail

SECONDS_TO_RUN="${1:-60}"
OUT="${2:-/tmp/v8-profile-$$}"
BROWSER="${BROWSER:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$BROWSER" ] || BROWSER="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"

mkdir -p "$OUT"
echo "  浏览器: $(basename "$BROWSER")"
echo "  采样 ${SECONDS_TO_RUN} 秒 → $OUT"

"$BROWSER" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
    --user-data-dir="$OUT/userdata" \
    --js-flags="--prof" \
    --window-size=1424,874 \
    "http://127.0.0.1:8000/" >"$OUT/v8.log" 2>&1 &
PID=$!

# 等日志里出现足够多的采样
for _ in $(seq 1 "$SECONDS_TO_RUN"); do
    sleep 1
    if [ -f "$OUT/v8.log" ] && [ "$(grep -c '^tick' "$OUT/v8.log" 2>/dev/null || echo 0)" -gt 3000 ]; then break; fi
done
sleep 3
kill "$PID" 2>/dev/null || true
sleep 2
kill -9 "$PID" 2>/dev/null || true

TICKS=$(grep -c '^tick' "$OUT/v8.log" 2>/dev/null || echo 0)
echo "  采集完成：$TICKS 个采样"
echo "$OUT"

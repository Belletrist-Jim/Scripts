#!/usr/bin/env bash
# 上海文化广场抢票助手 —— 构建 / 本地安装服务
# 只用 node 和 python3，不需要 npm 安装任何依赖。
set -euo pipefail
cd "$(dirname "$0")"

cmd="${1:-help}"
[ $# -gt 0 ] && shift || true

case "$cmd" in
  build|all)
    node build.mjs "$@"
    ;;
  serve)
    port="${1:-8773}"
    echo "本地服务: http://127.0.0.1:${port}/   （Ctrl+C 停止；只用于安装/更新，抢票时不需要）"
    echo "  主脚本  http://127.0.0.1:${port}/shcs.user.js"
    echo "  记录器  http://127.0.0.1:${port}/probe.user.js"
    python3 -m http.server "$port" --bind 127.0.0.1
    ;;
  *)
    cat <<'EOF'
用法: ./build.sh [命令]

  build            按 config.yaml 生成 shcs.user.js（改完配置就跑这个）
  build --live     顺便联网核对某个演出的场次/余票（需在 config.yaml 填 programId）
  serve [端口]     起本地服务(默认 8773)，用来把脚本装进油猴 / 更新

安装到油猴：
  1) 先 ./build.sh build
  2) ./build.sh serve    然后浏览器打开 http://127.0.0.1:8773/shcs.user.js 安装
  3) 以后改完配置：./build.sh build，再到油猴里点「检查更新」

不想起服务：油猴面板「+ 新建脚本」，把 shcs.user.js 内容整段粘贴保存即可。
EOF
    ;;
esac

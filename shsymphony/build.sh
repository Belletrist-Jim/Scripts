#!/usr/bin/env bash
# ============================================================
# 上海交响乐团抢票工具 · 统一构建入口
# 从各自的 config.yaml 生成可安装到 Tampermonkey(油猴) 的用户脚本。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
用法: ./build.sh <命令> [选项]

命令:
  preorder          构建“预售套票(多场次)”脚本
                    读取 preorder/config.yaml  ->  preorder/preorder.user.js
  single-concert    构建“单场选座”脚本
                    读取 single-concert/config.yaml  ->  single-concert/single-concert.user.js
  all               构建以上全部
  serve [端口]      启动本地 http 服务(默认 8770)用于安装/更新油猴脚本
                    (Chrome 已禁止直接用 file:// 安装用户脚本，故走本地 http)
  help, --help, -h  显示本帮助

选项:
  --live            额外用 cookie 联网校验配置(场次/票价/区域是否存在)。
                    需要环境变量 SHS_COOKIE(或对应目录下 cookies.txt)。
                    single-concert 联网校验还需 scheduleId，及可选 SHS_PK / SHS_SK。

两种抢票模式(在各自 config.yaml 里):
  - 默认: 装好油猴脚本后，开票页一打开即出现悬浮面板；点按钮或快捷键
          (Alt+Shift+P 预演 / R 抢 / X 释放[preorder] 或 I 库存[single]) 立即执行。
  - autoRun: true  开票页一加载好就自动执行，全程零点击(会真实锁座，付款仍需手动)。

安装到油猴(装一次即可，之后改配置只需重新 build + 在油猴里“检查更新”):
  1) Chrome 装 Tampermonkey。
  2) 运行:  ./build.sh serve      (保持这个终端开着)
  3) 浏览器打开下面两个地址，Tampermonkey 会弹出安装页，点“安装”:
       http://127.0.0.1:8770/preorder/preorder.user.js
       http://127.0.0.1:8770/single-concert/single-concert.user.js
  4) 装好后即可关掉服务；抢票时不需要它。以后改配置 rebuild 后，
     重新 ./build.sh serve 再在油猴点“检查更新”即可(下载地址已指向本地服务)。

  备选(完全不用服务):在油猴“+新建脚本”，把生成的 *.user.js 内容整段粘贴进编辑器保存即可
  (油猴编辑器允许粘贴，不受网页 allow pasting 限制)。

示例:
  ./build.sh all
  ./build.sh serve
  ./build.sh serve 9000
  SHS_COOKIE="k=v; ..." ./build.sh preorder --live
EOF
}

ensure_deps() {
  if [ ! -d node_modules/js-yaml ]; then
    echo "[build] 未见依赖，正在 npm install ..."
    npm install --no-audit --no-fund
  fi
}

build_one() {
  local name="$1"; shift || true
  ensure_deps
  echo "=============================================="
  echo "[build] 构建 $name"
  ( cd "$name" && node build.mjs "$@" )
}

cmd="${1:-help}"
[ $# -gt 0 ] && shift || true

serve() {
  local port="${1:-8770}"
  echo "[serve] 本地服务已启动: http://127.0.0.1:${port}/"
  echo "[serve] 在浏览器打开下面地址安装/更新(Tampermonkey 会弹安装页):"
  echo "        http://127.0.0.1:${port}/preorder/preorder.user.js"
  echo "        http://127.0.0.1:${port}/single-concert/single-concert.user.js"
  echo "[serve] 装好后 Ctrl+C 停止；抢票时不需要它。"
  python3 -m http.server "$port" --bind 127.0.0.1
}

case "$cmd" in
  preorder)        build_one preorder "$@" ;;
  single-concert)  build_one single-concert "$@" ;;
  all)             build_one preorder "$@"; build_one single-concert "$@" ;;
  serve)           serve "$@" ;;
  help|--help|-h)  usage ;;
  *) echo "未知命令: $cmd"; echo; usage; exit 1 ;;
esac

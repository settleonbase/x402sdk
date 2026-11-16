#!/bin/sh
# 渲染告警 unit 模板（只替换 @OPS_DIR@、@UNIT@、@SERVICE_USER@）。输出目录由调用方给出。
# 用法：sh render-claim-alert-units.sh <ops 目录> <claim 单元名> <服务用户> <输出目录>
set -eu
if [ $# -ne 4 ]; then
	echo "usage: $0 <ops-dir> <claim-unit> <service-user> <out-dir>" >&2
	exit 2
fi
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$4"
for t in claim-alert-watch.service claim-alert-notify.service; do
	sed -e "s|@OPS_DIR@|$1|g" -e "s|@UNIT@|$2|g" -e "s|@SERVICE_USER@|$3|g" "$here/$t.in" > "$4/$t"
	if grep -q '@[A-Z_]*@' "$4/$t"; then
		echo "unrendered token left in $t" >&2
		exit 3
	fi
done
cp "$here/claim-alert-watch.timer" "$4/claim-alert-watch.timer"

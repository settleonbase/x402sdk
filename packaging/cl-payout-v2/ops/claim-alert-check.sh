#!/bin/sh
# claim-alert-watch.service 的 ExecStart。只读：读取一个 claim 单元最近窗口的 journal，交给 alert-watch.sh 判定，记录状态。
# 必需环境变量：CLAIM_ALERT_UNIT（被检查的单元名）、CLAIM_ALERT_SCRIPT（alert-watch.sh 的路径）；
# 状态目录取 CLAIM_ALERT_STATE 或 STATE_DIRECTORY（systemd StateDirectory= 提供）。
# 退出码：0 = 没有未解除告警；1 = 有未解除告警（服务失败，触发 OnFailure）；2 = 检查本身无法运行（同样触发 OnFailure）。
# 不签名、不发送、不改账本、不改任何服务。
set -eu
UNIT="${CLAIM_ALERT_UNIT:-}"
if [ -z "$UNIT" ]; then echo "ERROR CLAIM_ALERT_UNIT is required" >&2; exit 2; fi
SCRIPT="${CLAIM_ALERT_SCRIPT:-}"
if [ -z "$SCRIPT" ]; then echo "ERROR CLAIM_ALERT_SCRIPT is required" >&2; exit 2; fi
STATE="${CLAIM_ALERT_STATE:-${STATE_DIRECTORY:-}}"
if [ -z "$STATE" ]; then echo "ERROR CLAIM_ALERT_STATE or STATE_DIRECTORY is required" >&2; exit 2; fi
WINDOW="${CLAIM_ALERT_WINDOW:--24 hours}"
JOURNALCTL="${CLAIM_ALERT_JOURNALCTL:-/usr/bin/journalctl}"
umask 077
mkdir -p "$STATE"
feed="$STATE/feed.log"
result="$STATE/result.txt"
last="$STATE/last.txt"
trap 'rm -f "$feed"' EXIT

if ! "$JOURNALCTL" -u "$UNIT" --since "$WINDOW" --no-pager -o cat > "$feed" 2>/dev/null; then
	printf 'ERROR cannot read the journal of %s (window %s)\n' "$UNIT" "$WINDOW" > "$last"
	exit 2
fi

rc=0
sh "$SCRIPT" "$feed" > "$result" 2>&1 || rc=$?
case "$rc" in
0)
	line=$(grep -E '^OK ' "$result" | tail -n 1 || true)
	[ -n "$line" ] || line="OK no unresolved claim alert"
	printf '%s\n' "$line" > "$last"
	rm -f "$STATE/notified.txt"
	exit 0
	;;
1)
	line=$(grep -E '^claim-v2c alert:' "$result" | tail -n 1 || true)
	[ -n "$line" ] || line=$(head -n 1 "$result")
	printf '%s\n' "$line" > "$last"
	exit 1
	;;
*)
	printf 'ERROR alert-watch.sh failed with status %s\n' "$rc" > "$last"
	exit 2
	;;
esac

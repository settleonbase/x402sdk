#!/bin/sh
# cl-payout-v2 签发车道告警检查（只读，不改任何账本、不触发签名或重发）。
#
# 用法：
#   journalctl -u <claim-unit> -o cat | sh alert-watch.sh -     （现场接入时由运维填写单元名）
#   sh alert-watch.sh <日志文件>                                  （本地或离线检查）
#
# 判定：最后一条 "ALERT flush job unsettled" 之后若没有 "flush job settled after"，即为未解除，退出码 1。
#       没有 ALERT，或 ALERT 之后已有 settled 行，退出码 0。输入错误或用法错误为 2。
# 另外列出 "ACK-lost intent without txHash: hold" 的挂起键，仅作提示；本脚本不判定挂起是否已解除（需人工核查）。
#
# 可选：NOTIFY_CMD=<命令> 时，未解除告警的摘要作为最后一个参数传给该命令（占位符：现场通知方式由运维决定）。
set -eu

src="${1:-}"
if [ -z "$src" ]; then
	echo "usage: $0 <logfile | ->" >&2
	exit 2
fi

tmp=""
if [ "$src" = "-" ]; then
	tmp=$(mktemp "${TMPDIR:-/tmp}/alert-watch.XXXXXX")
	cat > "$tmp"
	src="$tmp"
fi
cleanup() {
	if [ -n "$tmp" ]; then rm -f "$tmp"; fi
}
trap cleanup EXIT

if [ ! -r "$src" ]; then
	echo "cannot read input: $src" >&2
	exit 2
fi

last_alert=$(grep -nF 'ALERT flush job unsettled' "$src" | tail -n 1 | cut -d: -f1 || true)
alert_count=$(grep -cF 'ALERT flush job unsettled' "$src" || true)
last_settled=$(grep -nF 'flush job settled after' "$src" | tail -n 1 | cut -d: -f1 || true)
hold_count=$(grep -cF 'ACK-lost intent without txHash: hold' "$src" || true)

if [ "$hold_count" -gt 0 ]; then
	echo "INFO held intents without txHash (manual check, not auto-resolved): $hold_count line(s); last: $(grep -F 'ACK-lost intent without txHash: hold' "$src" | tail -n 1 | cut -c1-200)"
fi

if [ -z "$last_alert" ]; then
	echo "OK no flush watchdog ALERT in input"
	exit 0
fi

if [ -n "$last_settled" ] && [ "$last_settled" -gt "$last_alert" ]; then
	echo "OK flush watchdog ALERT resolved: settled at line $last_settled after last ALERT at line $last_alert ($alert_count ALERT line(s))"
	exit 0
fi

summary="UNRESOLVED flush job ALERT: $alert_count ALERT line(s), last at line $last_alert; no 'flush job settled after' after it. Signing lane is busy; not released or re-signed by the watchdog. Manual check required."
echo "$summary"
if [ -n "${NOTIFY_CMD:-}" ]; then
	$NOTIFY_CMD "$summary"
fi
exit 1

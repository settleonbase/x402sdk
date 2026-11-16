#!/bin/sh
# claim-alert-notify.service（claim-alert-watch.service 的 OnFailure）。把当前状态写成一条 crit 记录（journald，tag claim-alert）。
# 同一状态只写一次：与上次写入相同则不重复写。外部通知通道未配置（待项目方指定）。
# 状态目录取 CLAIM_ALERT_STATE 或 STATE_DIRECTORY（systemd StateDirectory= 提供）。
set -eu
STATE="${CLAIM_ALERT_STATE:-${STATE_DIRECTORY:-}}"
if [ -z "$STATE" ]; then echo "ERROR CLAIM_ALERT_STATE or STATE_DIRECTORY is required" >&2; exit 2; fi
LOGGER="${CLAIM_ALERT_LOGGER:-/usr/bin/logger}"
mkdir -p "$STATE"
last="$STATE/last.txt"
notified="$STATE/notified.txt"
if [ -s "$last" ]; then
	msg=$(head -n 1 "$last")
else
	msg="claim-alert-watch failed and no state text was recorded"
fi
if [ -f "$notified" ] && cmp -s "$last" "$notified" 2>/dev/null; then
	exit 0
fi
"$LOGGER" -t claim-alert -p user.crit -- "$msg"
if [ -s "$last" ]; then cp "$last" "$notified"; else printf '%s\n' "$msg" > "$notified"; fi

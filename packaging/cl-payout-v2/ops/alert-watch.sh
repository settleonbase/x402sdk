#!/bin/sh
# cl-payout-v2 告警检查（只读，不改任何账本、不签名、不重发）。
#
# 用法：
#   journalctl -u <claim-unit> -o cat | sh alert-watch.sh -
#   sh alert-watch.sh <日志文件>
#
# 检查两类告警：
#   1) 签发车道看门狗："ALERT flush job unsettled"。最后一条之后没有 "flush job settled after" 即未解除。
#   2) 在途意图无回执："ALERT intent still without receipt"（每个 intent 一次，键为 idem= 后 24 字符）。
#      该 idem 之后出现 "recovered intent via txHash receipt" 或 "credited via on-chain consumed"，且晚于告警，即视为已解除；否则未解除。
# 退出码：0 = 两类都没有未解除告警；1 = 至少一类未解除（已调用 NOTIFY_CMD）；2 = 用法或输入错误。
# 另外列出 "ACK-lost intent without txHash: hold"，仅作提示；本脚本不判定挂起是否可以解除（需人工核查）。
#
# 可选：NOTIFY_CMD=<命令> 时，未解除告警的摘要作为最后一个参数传给该命令（只调用一次）。
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

# ---- 1) flush lane watchdog ----
last_alert=$(grep -nF 'ALERT flush job unsettled' "$src" | tail -n 1 | cut -d: -f1 || true)
alert_count=$(grep -cF 'ALERT flush job unsettled' "$src" || true)
last_settled=$(grep -nF 'flush job settled after' "$src" | tail -n 1 | cut -d: -f1 || true)
flush_open=0
flush_text=""
if [ -n "$last_alert" ]; then
	if [ -n "$last_settled" ] && [ "$last_settled" -gt "$last_alert" ]; then
		flush_text="flush ALERT resolved ($alert_count ALERT line(s); settled after the last ALERT)"
	else
		flush_open=1
		flush_text="UNRESOLVED flush job ALERT: $alert_count ALERT line(s); no 'flush job settled after' after it. Signing lane is busy; not released or re-signed by the watchdog."
	fi
fi

# ---- 2) intent without receipt ----
# Per idem: the ALERT line number, and the last resolving line number. Open = unresolved, or an ALERT after the last resolution.
intent_list=$(awk '
/ALERT intent still without receipt/ {
	i = index($0, "idem="); if (i == 0) next
	k = substr($0, i + 5, 24)
	if (!(k in first_alert)) { first_alert[k] = NR; order[++n] = k }
	last_alert[k] = NR
}
/recovered intent via txHash receipt|credited via on-chain consumed/ {
	i = index($0, "idem="); if (i == 0) next
	k = substr($0, i + 5, 24)
	resolved[k] = NR
}
END {
	for (j = 1; j <= n; j++) {
		k = order[j]
		if (!(k in resolved) || resolved[k] < last_alert[k]) print k
	}
}' "$src")
intent_open=0
if [ -n "$intent_list" ]; then
	intent_open=$(printf '%s\n' "$intent_list" | wc -l | tr -d ' ')
fi
intent_alerts=$(grep -cF 'ALERT intent still without receipt' "$src" || true)
intent_text=""
if [ "$intent_open" -gt 0 ]; then
	prefixes=$(printf '%s\n' "$intent_list" | awk '{printf "%s%s", (NR>1?", ":""), $1}')
	intent_text="UNRESOLVED intent without receipt: $intent_open intent(s) [$prefixes]; no receipt or on-chain credit after the ALERT. Manual check required (keys stay owned; nothing re-sent)."
fi

# ---- hold notice (information only) ----
hold_count=$(grep -cF 'ACK-lost intent without txHash: hold' "$src" || true)
if [ "$hold_count" -gt 0 ]; then
	echo "INFO held intents without txHash (manual check, not auto-resolved): $hold_count line(s); last: $(grep -F 'ACK-lost intent without txHash: hold' "$src" | tail -n 1 | cut -c1-200)"
fi

if [ "$flush_open" -eq 0 ] && [ "$intent_open" -eq 0 ]; then
	if [ -z "$last_alert" ] && [ "$intent_alerts" -eq 0 ]; then
		echo "OK no flush or intent ALERT in input"
	else
		[ -n "$flush_text" ] && echo "OK $flush_text"
		[ "$intent_alerts" -gt 0 ] && echo "OK intent ALERT(s) in input all resolved ($intent_alerts line(s))"
	fi
	exit 0
fi

summary="claim-v2c alert:"
[ "$flush_open" -eq 1 ] && summary="$summary $flush_text"
[ "$intent_open" -gt 0 ] && summary="$summary $intent_text"
echo "$summary"
if [ -n "${NOTIFY_CMD:-}" ]; then
	$NOTIFY_CMD "$summary"
fi
exit 1

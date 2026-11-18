#!/bin/sh
# 本地测试：claim-alert-check.sh -> alert-watch.sh，以及 OnFailure 时的 alert-notify.sh。
# 使用与代码输出格式一致的合成样本。journalctl 与 logger 用桩替代；不需要 systemd，不需要目标主机。
# 每个用例：检查退出码、状态文本、crit 写入次数（OnFailure 只在退出码非 0 时运行，并运行两次以验证去重）。
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
FIX="$HERE/fixtures"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/claim-alert-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
cat > "$TMP/bin/journalctl" <<'SH'
#!/bin/sh
[ "${JOURNAL_FIXTURE:-}" = "__FAIL__" ] && exit 1
cat "$JOURNAL_FIXTURE"
SH
cat > "$TMP/bin/logger" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$LOGGER_OUT"
SH
chmod +x "$TMP/bin/journalctl" "$TMP/bin/logger"
pass=0; fail=0
export CLAIM_ALERT_UNIT=claim-test-unit.service
run_case() {
	name=$1; fix=$2; want_rc=$3; want=$4
	st="$TMP/state-$name"; out="$TMP/logger-$name.out"; : > "$out"; rm -rf "$st"
	export CLAIM_ALERT_STATE="$st" CLAIM_ALERT_JOURNALCTL="$TMP/bin/journalctl" CLAIM_ALERT_SCRIPT="$HERE/alert-watch.sh"
	export CLAIM_ALERT_LOGGER="$TMP/bin/logger" LOGGER_OUT="$out"
	if [ "$fix" = "__FAIL__" ]; then export JOURNAL_FIXTURE=__FAIL__; else export JOURNAL_FIXTURE="$fix"; fi
	rc=0; sh "$HERE/claim-alert-check.sh" || rc=$?
	last=$(cat "$st/last.txt" 2>/dev/null || true)
	if [ "$rc" != 0 ]; then
		sh "$HERE/alert-notify.sh"
		sh "$HERE/alert-notify.sh"
	fi
	crit=$(wc -l < "$out" | tr -d ' ')
	feed_left=$(ls "$st/feed.txt" 2>/dev/null | wc -l | tr -d ' ')
	ok=1
	[ "$rc" = "$want_rc" ] || ok=0
	case "$last" in *"$want"*) ;; *) ok=0 ;; esac
	if [ "$rc" = 0 ]; then [ "$crit" = 0 ] || ok=0; else [ "$crit" = 1 ] || ok=0; fi
	[ "$feed_left" = 0 ] || ok=0
	if [ "$ok" = 1 ]; then
		pass=$((pass + 1)); echo "PASS $name: rc=$rc, crit records=$crit, state=[$last]"
	else
		fail=$((fail + 1)); echo "FAIL $name: rc=$rc (want $want_rc), crit records=$crit, feed left=$feed_left, state=[$last]"
	fi
	unset JOURNAL_FIXTURE
}
run_case unresolved-flush-alert "$FIX/synthetic-flush-unresolved.txt" 1 "UNRESOLVED flush job ALERT"
run_case settled-after-alert "$FIX/synthetic-flush-settled.txt" 0 "flush ALERT resolved"
run_case no-alert "$FIX/synthetic-no-alert.txt" 0 "OK no flush or intent ALERT"
run_case intent-waiting-timeout "$FIX/synthetic-b4-intent-timeout.txt" 1 "UNRESOLVED intent without receipt"
run_case intent-resolved-by-chain-credit "$FIX/synthetic-b4-intent-resolved.txt" 0 "all resolved"
run_case empty-log "$FIX/empty.txt" 0 "OK no flush or intent ALERT"
run_case missing-log-journal-error __FAIL__ 2 "ERROR cannot read the journal"
echo "SUMMARY pass=$pass fail=$fail"
[ "$fail" = 0 ]

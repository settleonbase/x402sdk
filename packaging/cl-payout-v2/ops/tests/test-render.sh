#!/bin/sh
# 本地测试：render-claim-alert-units.sh 渲染后不残留占位符，参数缺失返回 2。
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/render-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
sh "$HERE/render-claim-alert-units.sh" /example/ops example-unit.service example-user "$TMP/out"
for f in claim-alert-watch.service claim-alert-watch.timer claim-alert-notify.service; do test -s "$TMP/out/$f"; done
if grep -q '@[A-Z_]*@' "$TMP/out/claim-alert-watch.service" "$TMP/out/claim-alert-notify.service"; then echo "FAIL placeholder left"; exit 1; fi
grep -q 'ExecStart=/bin/sh /example/ops/claim-alert-check.sh' "$TMP/out/claim-alert-watch.service"
grep -q 'User=example-user' "$TMP/out/claim-alert-notify.service"
rc=0; sh "$HERE/render-claim-alert-units.sh" /x >/dev/null 2>&1 || rc=$?
[ "$rc" = 2 ] || { echo "FAIL usage exit $rc"; exit 1; }
echo "PASS render: no placeholders left, values substituted, usage exit 2"

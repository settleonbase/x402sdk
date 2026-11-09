#!/bin/bash
# Isolate-only test certificate switch. Not a real ACME order and not a production install.
set -euo pipefail
if [[ "$(hostname)" == "dle" ]] || ip -4 addr show | grep -q '70.35.205.77'; then
	echo 'REFUSING production signer host' >&2
	exit 2
fi
SRC="${1:-}"
if [[ -z "$SRC" || ! -f "$SRC/src/edge.mjs" ]]; then
	echo 'REFUSING missing source argument' >&2
	exit 2
fi
case "$SRC" in
	/etc/letsencrypt*|/var/lib/signer-node-edge*|/opt/wallet-signer*)
		echo 'REFUSING production certificate path' >&2
		exit 2
		;;
esac

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ROOT="/tmp/signer-dns01-publish-${RUN_ID}"
EDGE_PID=""
cleanup() {
	if [[ -n "$EDGE_PID" ]]; then
		kill "$EDGE_PID" >/dev/null 2>&1 || true
		wait "$EDGE_PID" >/dev/null 2>&1 || true
	fi
	rm -rf "$ROOT"
}
trap cleanup EXIT
mkdir -p "$ROOT/versions/a" "$ROOT/versions/bad" "$ROOT/versions/b" "$ROOT/lineage"
openssl req -x509 -newkey rsa:2048 -keyout "$ROOT/lineage/a-key.pem" -out "$ROOT/lineage/a-cert.pem" -days 1 -nodes -subj /CN=dns01-isolate-a >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -keyout "$ROOT/lineage/b-key.pem" -out "$ROOT/lineage/b-cert.pem" -days 1 -nodes -subj /CN=dns01-isolate-b >/dev/null 2>&1
cp "$ROOT/lineage/a-cert.pem" "$ROOT/versions/a/fullchain.pem"
cp "$ROOT/lineage/a-key.pem" "$ROOT/versions/a/privkey.pem"
cp "$ROOT/lineage/b-cert.pem" "$ROOT/versions/bad/fullchain.pem"
cp "$ROOT/lineage/a-key.pem" "$ROOT/versions/bad/privkey.pem"
cp "$ROOT/lineage/b-cert.pem" "$ROOT/versions/b/fullchain.pem"
cp "$ROOT/lineage/b-key.pem" "$ROOT/versions/b/privkey.pem"
ln -s versions/a "$ROOT/current"

PORT="$(node -e 'const n=require("net"); const s=n.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port); s.close()});')"
LOG="$ROOT/edge.log"
SIGNER_EDGE_HTTPS_PORT="$PORT" \
SIGNER_EDGE_BIND=127.0.0.1 \
SIGNER_EDGE_CERT="$ROOT/current/fullchain.pem" \
SIGNER_EDGE_KEY="$ROOT/current/privkey.pem" \
SIGNER_EDGE_WORKERS=2 \
SIGNER_EDGE_CERT_POLL_MS=200 \
	node "$SRC/src/edge.mjs" >"$LOG" 2>&1 &
EDGE_PID=$!

wait_log() {
	local needle="$1"
	local i
	for i in $(seq 1 50); do
		if grep -q "$needle" "$LOG"; then
			return 0
		fi
		sleep 0.1
	done
	echo "REFUSING missing log marker $needle" >&2
	cat "$LOG" >&2 || true
	exit 1
}
wait_log 'edge-workers ready='
before="$(awk -F= '/edge-workers ready=/{print $2}' "$LOG" | tail -n 1)"
ln -sfn versions/bad "$ROOT/current.next"
mv -Tf "$ROOT/current.next" "$ROOT/current"
wait_log 'edge-reload skipped reason=cert-key-mismatch'
kept="$(awk -F= '/edge-workers ready=/{print $2}' "$LOG" | tail -n 1)"
if [[ "$kept" != "$before" ]]; then
	echo 'REFUSING worker change after mismatched certificate' >&2
	exit 1
fi
if grep -q 'edge-reload before=' "$LOG"; then
	echo 'REFUSING reload after mismatched certificate' >&2
	exit 1
fi
ln -sfn versions/b "$ROOT/current.next"
mv -Tf "$ROOT/current.next" "$ROOT/current"
wait_log 'edge-reload before='
python3 - "$LOG" "$before" << 'PY'
import sys
log = open(sys.argv[1], encoding="utf-8").read().splitlines()
before = sys.argv[2].strip()
line = next(row for row in reversed(log) if row.startswith("edge-reload before="))
left, right = line.split(" before=", 1)[1].split(" after=", 1)
if left.strip() != before or right.strip() == before:
    raise SystemExit("reload did not replace workers")
PY
echo 'ISOLATE_PUBLISH_SWITCH_OK'
echo 'DNS01_STAGING_NOT_RUN'

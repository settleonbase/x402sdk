#!/bin/bash
# Local Cloudflare v4 stub. Not a real ACME order and not a production DNS change.
set -euo pipefail
if [[ "$(hostname)" == "dle" ]] || ip -4 addr show | grep -q '70.35.205.77'; then
	echo 'REFUSING production signer host' >&2
	exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then
	echo 'REFUSING non-root hook test' >&2
	exit 2
fi
SRC="${1:-}"
if [[ -z "$SRC" || ! -x "$SRC/deploy/certbot-dns-auth.sh" || ! -x "$SRC/deploy/certbot-dns-cleanup.sh" ]]; then
	echo 'REFUSING missing hook source' >&2
	exit 2
fi
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ROOT="/tmp/signer-dns01-cf-${RUN_ID}"
STUB_PID=""
cleanup() {
	if [[ -n "$STUB_PID" ]]; then
		kill "$STUB_PID" >/dev/null 2>&1 || true
		wait "$STUB_PID" >/dev/null 2>&1 || true
	fi
	rm -rf "$ROOT" /var/lib/signer-edge-dns
}
trap cleanup EXIT
mkdir -p "$ROOT/ns"
install -d -o root -g root -m 700 /var/lib/signer-edge-dns
umask 077
token="$(python3 -c 'import secrets; print(secrets.token_hex(16), end="")')"
zone="$(python3 -c 'import secrets; print(secrets.token_hex(8), end="")')"
printf 'CLOUDFLARE_API_TOKEN=%s\nCLOUDFLARE_ZONE_ID=%s\n' "$token" "$zone" > /var/lib/signer-edge-dns/cloudflare.env
chown root:root /var/lib/signer-edge-dns/cloudflare.env
chmod 600 /var/lib/signer-edge-dns/cloudflare.env
unset token zone
node "$SRC/test/dns01-cloudflare-stub.mjs" > "$ROOT/stub.port" &
STUB_PID=$!
port=""
for _ in $(seq 1 50); do
	port="$(awk -F: '/stub-listen/{print $2}' "$ROOT/stub.port" | tail -n 1 || true)"
	if [[ -n "$port" ]]; then
		break
	fi
	sleep 0.05
done
if [[ -z "$port" ]]; then
	echo 'REFUSING stub did not listen' >&2
	exit 1
fi
status() { curl -fsS "http://127.0.0.1:${port}/status"; }
export CERTBOT_DOMAIN="dle-dns01-staging.conet.network"
export CERTBOT_VALIDATION="v-origin"
export SIGNER_EDGE_DNS01_API_BASE="http://127.0.0.1:${port}/client/v4"
unset SIGNER_EDGE_DNS01_STUB
if "$SRC/deploy/certbot-dns-auth.sh" >/dev/null 2>&1; then
	echo 'REFUSING live mode accepted a loopback origin' >&2
	exit 1
fi
if SIGNER_EDGE_DNS01_API_BASE="https://not-cloudflare.example/client/v4" "$SRC/deploy/certbot-dns-auth.sh" >/dev/null 2>&1; then
	echo 'REFUSING live mode accepted a foreign origin' >&2
	exit 1
fi
python3 -c 'import json,sys; s=json.loads(sys.argv[1]); assert s["authSeen"]==0 and s["posts"]==0 and s["lists"]==0' "$(status)"
echo 'STUB_ORIGIN_REFUSED'
export SIGNER_EDGE_DNS01_STUB=1
export SIGNER_EDGE_DNS01_API_BASE="http://127.0.0.1:${port}/client/v4"
export SIGNER_EDGE_DNS01_NS_DIR="$ROOT/ns"
export SIGNER_EDGE_DNS01_NS_TRIES=2
export SIGNER_EDGE_DNS01_NS_WAIT=0
printf '%s\n' v-fail > "$ROOT/ns/matt.ns.cloudflare.com"
: > "$ROOT/ns/pola.ns.cloudflare.com"
export CERTBOT_VALIDATION="v-fail"
if "$SRC/deploy/certbot-dns-auth.sh" >/dev/null 2>&1; then
	echo 'REFUSING one nameserver was enough' >&2
	exit 1
fi
python3 -c 'import json,sys; s=json.loads(sys.argv[1]); assert s["posts"]==1 and s["deletes"]==1 and s["lists"]==0 and s["preexisting"] and s["remaining"]==1' "$(status)"
if compgen -G /var/lib/signer-edge-dns/challenge-* >/dev/null; then
	echo 'REFUSING failed challenge left a record id' >&2
	exit 1
fi
echo 'STUB_PROPAGATION_REFUSED'
printf '%s\n%s\n' v-a v-b > "$ROOT/ns/matt.ns.cloudflare.com"
cp "$ROOT/ns/matt.ns.cloudflare.com" "$ROOT/ns/pola.ns.cloudflare.com"
CERTBOT_VALIDATION="v-a" "$SRC/deploy/certbot-dns-auth.sh" > "$ROOT/out-a" &
pid_a=$!
CERTBOT_VALIDATION="v-b" "$SRC/deploy/certbot-dns-auth.sh" > "$ROOT/out-b" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
python3 - << 'PY'
import hashlib, json, os
state_dir = "/var/lib/signer-edge-dns"
names = os.listdir(state_dir)
assert "challenge-record.json" not in names
paths = [os.path.join(state_dir, name) for name in names if name.startswith("challenge-")]
assert len(paths) == 2
ids = []
for validation in ("v-a", "v-b"):
    digest = hashlib.sha256(validation.encode()).hexdigest()
    path = os.path.join(state_dir, "challenge-" + digest + ".json")
    body = json.load(open(path, encoding="utf-8"))
    assert body["type"] == "TXT"
    assert body["name"] == "_acme-challenge.dle-dns01-staging.conet.network"
    ids.append(body["id"])
assert len(set(ids)) == 2
PY
python3 -c 'import json,sys; s=json.loads(sys.argv[1]); assert s["posts"]==3 and s["deletes"]==1 and s["lists"]==0 and s["remaining"]==3 and s["preexisting"]' "$(status)"
echo 'STUB_CONCURRENT_IDS_KEPT'
export CERTBOT_VALIDATION="v-a"
export CERTBOT_AUTH_OUTPUT="id=other type=A name=_acme-challenge.dle-dns01-staging.conet.network"
if "$SRC/deploy/certbot-dns-cleanup.sh" >/dev/null 2>&1; then
	echo 'REFUSING cleanup accepted a non-TXT' >&2
	exit 1
fi
export CERTBOT_AUTH_OUTPUT="id=other type=TXT name=dle.conet.network"
if "$SRC/deploy/certbot-dns-cleanup.sh" >/dev/null 2>&1; then
	echo 'REFUSING cleanup accepted another name' >&2
	exit 1
fi
python3 -c 'import json,sys; s=json.loads(sys.argv[1]); assert s["deletes"]==1 and s["lists"]==0 and s["remaining"]==3' "$(status)"
CERTBOT_AUTH_OUTPUT="$(cat "$ROOT/out-a")" "$SRC/deploy/certbot-dns-cleanup.sh" >/dev/null
unset CERTBOT_AUTH_OUTPUT
export CERTBOT_VALIDATION="v-b"
"$SRC/deploy/certbot-dns-cleanup.sh" >/dev/null
python3 -c 'import json,sys; s=json.loads(sys.argv[1]); assert s["deletes"]==3 and s["lists"]==0 and s["preexisting"] and s["remaining"]==1' "$(status)"
if compgen -G /var/lib/signer-edge-dns/challenge-* >/dev/null; then
	echo 'REFUSING challenge state left after cleanup' >&2
	exit 1
fi
echo 'STUB_CLEANUP_BY_ID'
export CERTBOT_DOMAIN="dle.conet.network"
if "$SRC/deploy/certbot-dns-auth.sh" >/dev/null 2>&1; then
	echo 'REFUSING production name was accepted' >&2
	exit 1
fi
export CERTBOT_DOMAIN="_acme-challenge.dle.conet.network"
if "$SRC/deploy/certbot-dns-auth.sh" >/dev/null 2>&1; then
	echo 'REFUSING production challenge name was accepted' >&2
	exit 1
fi
export CERTBOT_DOMAIN="dle-dns01-staging.conet.network"
printf 'X_Auth_Key=do-not-use\nCLOUDFLARE_API_TOKEN=stub\nCLOUDFLARE_ZONE_ID=stub\n' > "$ROOT/global.env"
chown root:root "$ROOT/global.env"
chmod 600 "$ROOT/global.env"
if SIGNER_EDGE_DNS01_ENV="$ROOT/global.env" CERTBOT_VALIDATION="v-a" "$SRC/deploy/certbot-dns-auth.sh" >/dev/null 2>&1; then
	echo 'REFUSING global key file was accepted' >&2
	exit 1
fi
echo 'STUB_REJECTS_OK'
install -d -o root -g root -m 755 "$ROOT/store" "$ROOT/lineage"
printf 'cert\n' > "$ROOT/lineage/fullchain.pem"
printf 'key\n' > "$ROOT/lineage/privkey.pem"
SIGNER_EDGE_CERT_STORE="$ROOT/store" \
SIGNER_EDGE_RENEW_LINEAGE="$ROOT/lineage" \
RENEWED_LINEAGE="$ROOT/lineage" \
	"$SRC/deploy/certbot-deploy-refresh.sh" >/dev/null
link="$(readlink "$ROOT/store/current")"
case "$link" in
	versions/*) ;;
	*) echo 'REFUSING deploy hook did not switch current' >&2; exit 1 ;;
esac
if grep -q 'systemctl' "$SRC/deploy/certbot-deploy-refresh.sh"; then
	echo 'REFUSING deploy hook signals the service' >&2
	exit 1
fi
echo 'DEPLOY_HOOK_OK'
unset CERTBOT_VALIDATION CERTBOT_AUTH_OUTPUT
echo 'DNS01_STAGING_NOT_RUN'

#!/bin/bash
# Local profile checks. Not a certificate order and not a production DNS write.
set -euo pipefail
if [[ "$(hostname)" == "dle" ]] || ip -4 addr show | grep -q '70.35.205.77'; then
	echo 'REFUSING production signer host' >&2
	exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then
	echo 'REFUSING non-root profile test' >&2
	exit 2
fi
SRC="${1:-}"
if [[ -z "$SRC" || ! -x "$SRC/deploy/certbot-dns-auth.sh" ]]; then
	echo 'REFUSING missing hook source' >&2
	exit 2
fi
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ROOT="/tmp/signer-dns01-profiles-${RUN_ID}"
STUB_PID=""
cleanup() {
	if [[ -n "$STUB_PID" ]]; then
		kill "$STUB_PID" >/dev/null 2>&1 || true
		wait "$STUB_PID" >/dev/null 2>&1 || true
	fi
	rm -rf "$ROOT" /var/lib/signer-edge-dns
}
trap cleanup EXIT
mkdir -p "$ROOT/ns" "$ROOT/work"
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
	[[ -n "$port" ]] && break
	sleep 0.05
done
[[ -n "$port" ]]
status() { curl -fsS "http://127.0.0.1:${port}/status"; }
export SIGNER_EDGE_DNS01_ENV=/var/lib/signer-edge-dns/cloudflare.env
export SIGNER_EDGE_DNS01_STATE=/var/lib/signer-edge-dns
export SIGNER_EDGE_DNS01_NS_DIR="$ROOT/ns"
export SIGNER_EDGE_DNS01_NS_TRIES=1
export SIGNER_EDGE_DNS01_NS_WAIT=0
export SIGNER_EDGE_DNS01_API_BASE="http://127.0.0.1:${port}/client/v4"
unset SIGNER_EDGE_DNS01_STUB
unset SIGNER_EDGE_DNS01_PROFILE
export CERTBOT_DOMAIN="dle.conet.network"
export CERTBOT_VALIDATION="v-cross"
if "$SRC/deploy/certbot-dns-auth.sh" >/dev/null 2>&1; then
	echo 'REFUSING default profile accepted production name' >&2
	exit 1
fi
python3 -c 'import json,sys; s=json.loads(sys.argv[1]); assert s["authSeen"]==0 and s["posts"]==0' "$(status)"
echo 'DEFAULT_PROFILE_REFUSES_PRODUCTION'
export SIGNER_EDGE_DNS01_STUB=1
export SIGNER_EDGE_DNS01_DIRECTORY="https://acme-v02.api.letsencrypt.org/directory"
export CERTBOT_DOMAIN="dle-dns01-staging.conet.network"
if "$SRC/deploy/certbot-dns-auth.sh" >/dev/null 2>&1; then
	echo 'REFUSING staging profile accepted production directory' >&2
	exit 1
fi
echo 'DIRECTORY_MISMATCH_REFUSED'
printf '%s\n' v-stage > "$ROOT/ns/matt.ns.cloudflare.com"
cp "$ROOT/ns/matt.ns.cloudflare.com" "$ROOT/ns/pola.ns.cloudflare.com"
export SIGNER_EDGE_DNS01_DIRECTORY="https://acme-staging-v02.api.letsencrypt.org/directory"
export CERTBOT_VALIDATION="v-stage"
"$SRC/deploy/certbot-dns-auth.sh" > "$ROOT/out-stage"
python3 -c 'import json,sys; s=json.loads(sys.argv[1]); assert s["stagingPosts"]==1 and s["productionPosts"]==0 and s["lists"]==0 and s["preexisting"]' "$(status)"
CERTBOT_AUTH_OUTPUT="$(cat "$ROOT/out-stage")" "$SRC/deploy/certbot-dns-cleanup.sh" >/dev/null
unset CERTBOT_AUTH_OUTPUT
echo 'STAGING_STUB_ROUNDTRIP'
export SIGNER_EDGE_DNS01_PROFILE=production
export SIGNER_EDGE_DNS01_DIRECTORY="https://acme-staging-v02.api.letsencrypt.org/directory"
export CERTBOT_DOMAIN="dle.conet.network"
if "$SRC/deploy/certbot-dns-auth.sh" >/dev/null 2>&1; then
	echo 'REFUSING production profile accepted staging directory' >&2
	exit 1
fi
export SIGNER_EDGE_DNS01_DIRECTORY="https://acme-v02.api.letsencrypt.org/directory"
export CERTBOT_DOMAIN="dle-dns01-staging.conet.network"
if "$SRC/deploy/certbot-dns-auth.sh" >/dev/null 2>&1; then
	echo 'REFUSING production profile accepted staging name' >&2
	exit 1
fi
printf '%s\n' v-prod > "$ROOT/ns/matt.ns.cloudflare.com"
cp "$ROOT/ns/matt.ns.cloudflare.com" "$ROOT/ns/pola.ns.cloudflare.com"
export CERTBOT_DOMAIN="dle.conet.network"
export CERTBOT_VALIDATION="v-prod"
"$SRC/deploy/certbot-dns-auth.sh" > "$ROOT/out-prod"
python3 -c 'import json,sys; s=json.loads(sys.argv[1]); assert s["productionPosts"]==1 and s["lists"]==0 and s["preexisting"] and s["remaining"]==2' "$(status)"
if [[ -e /var/lib/signer-edge-dns/challenge-record.json ]]; then
	echo 'REFUSING shared record file' >&2
	exit 1
fi
CERTBOT_AUTH_OUTPUT="$(cat "$ROOT/out-prod")" "$SRC/deploy/certbot-dns-cleanup.sh" >/dev/null
unset CERTBOT_AUTH_OUTPUT
python3 -c 'import json,sys; s=json.loads(sys.argv[1]); assert s["deletes"]==2 and s["lists"]==0 and s["preexisting"] and s["remaining"]==1' "$(status)"
echo 'PRODUCTION_STUB_ROUNDTRIP'
echo 'LOCAL_STUB_ONLY'

make_pair() {
	local tag="$1" name="$2" issuer="$3" mode="$4"
	local ca="$ROOT/work/${tag}-ca"
	local out="$ROOT/work/${tag}"
	openssl req -x509 -newkey rsa:2048 -nodes -keyout "${ca}.key" -out "${ca}.pem" -days 2 -subj "/CN=${issuer}" >/dev/null 2>&1
	openssl req -new -newkey rsa:2048 -nodes -keyout "${out}.key" -subj "/CN=${name}" -addext "subjectAltName=DNS:${name}" -out "${out}.csr" >/dev/null 2>&1
	if [[ "$mode" == "expired" ]]; then
		openssl x509 -req -in "${out}.csr" -CA "${ca}.pem" -CAkey "${ca}.key" -CAcreateserial -copy_extensions copy \
			-not_before 20200101000000Z -not_after 20200102000000Z -out "${out}.pem" >/dev/null 2>&1
	else
		openssl x509 -req -in "${out}.csr" -CA "${ca}.pem" -CAkey "${ca}.key" -CAcreateserial -copy_extensions copy \
			-days 2 -out "${out}.pem" >/dev/null 2>&1
	fi
	chmod 644 "${out}.pem" "${ca}.pem"
	chmod 640 "${out}.key"
	chown root:signer-edge "${out}.key"
	printf '%s\n' "$ca"
}

publish_case() {
	local label="$1" profile="$2" cert="$3" key="$4" ca="$5" expect="$6"
	local lineage="$ROOT/work/${label}-lineage"
	local store="$ROOT/work/${label}-store"
	rm -rf "$lineage" "$store"
	install -d -o root -g root -m 755 "$lineage" "$store/versions/old"
	cp "$ROOT/work/old.pem" "$store/versions/old/fullchain.pem"
	cp "$ROOT/work/old.key" "$store/versions/old/privkey.pem"
	ln -s versions/old "$store/current"
	cat "$cert" "$ca" > "$lineage/fullchain.pem"
	cp "$key" "$lineage/privkey.pem"
	set +e
	RENEWED_LINEAGE="$lineage" \
	SIGNER_EDGE_CERT_STORE="$store" \
	SIGNER_EDGE_RENEW_LINEAGE="$lineage" \
	SIGNER_EDGE_DNS01_PROFILE="$profile" \
	SIGNER_EDGE_DEPLOY_CA="$ca" \
		"$SRC/deploy/certbot-deploy-refresh.sh" >/dev/null 2>"$ROOT/work/${label}.err"
	local rc=$?
	set -e
	local link
	link="$(readlink "$store/current")"
	if [[ "$expect" == "switch" ]]; then
		[[ "$rc" -eq 0 && "$link" == versions/* && "$link" != "versions/old" ]]
		[[ -f "$store/versions/old/fullchain.pem" ]]
	else
		[[ "$rc" -ne 0 && "$link" == "versions/old" ]]
		grep -q "publish-refused reason=${expect}" "$ROOT/work/${label}.err"
	fi
	echo "PUBLISH_${label}"
}

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$ROOT/work/old.key" -out "$ROOT/work/old.pem" -days 1 -subj "/CN=old-before-publish.isolate" >/dev/null 2>&1
stage_ca="$(make_pair stage dle-dns01-staging.conet.network "Profile Test CA" ok)"
prod_ca="$(make_pair prod dle.conet.network "Profile Test CA" ok)"
bad_issuer_ca="$(make_pair staged-issuer dle.conet.network "(STAGING) Profile Test" ok)"
expired_ca="$(make_pair expired dle-dns01-staging.conet.network "Profile Test CA" expired)"
publish_case staging_ok staging "$ROOT/work/stage.pem" "$ROOT/work/stage.key" "${stage_ca}.pem" switch
publish_case staging_issuer production "$ROOT/work/staged-issuer.pem" "$ROOT/work/staged-issuer.key" "${bad_issuer_ca}.pem" staging-issuer
publish_case wrong_name staging "$ROOT/work/prod.pem" "$ROOT/work/prod.key" "${prod_ca}.pem" name
publish_case expired staging "$ROOT/work/expired.pem" "$ROOT/work/expired.key" "${expired_ca}.pem" dates
publish_case bad_key staging "$ROOT/work/stage.pem" "$ROOT/work/old.key" "${stage_ca}.pem" key
echo 'PUBLISH_GUARDS_OK'
echo 'NO_REAL_ORDER'

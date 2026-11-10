#!/bin/bash
# Isolate acceptance for the renewal templates. Local test CA and local stubs only.
# This does not contact Let's Encrypt or the production signer.
set -euo pipefail
if [[ "$(hostname)" == "dle" ]] || ip -4 addr show | grep -q '70.35.205.77'; then
	echo 'REFUSING production signer host' >&2
	exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then
	echo 'REFUSING non-root acceptance' >&2
	exit 2
fi
SRC=${1:?source root}
ARCHIVE=${2:?previous artifact}
DEPLOY="$SRC/deploy"
ROOT=/var/lib/signer-edge-accept
UNIT=signer-edge-accept-$(date -u +%H%M%S).service
EDGE_UNIT=/run/systemd/system/signer-node-edge.service
created_edge=0
opt_backup=0
cleanup() {
	systemctl stop "$UNIT" >/dev/null 2>&1 || true
	systemctl reset-failed "$UNIT" >/dev/null 2>&1 || true
	rm -f "/run/systemd/system/$UNIT"
	rm -rf "/run/systemd/system/$UNIT.d"
	if [[ "$created_edge" -eq 1 ]]; then
		systemctl stop signer-node-edge.service >/dev/null 2>&1 || true
		systemctl reset-failed signer-node-edge.service >/dev/null 2>&1 || true
		rm -f "$EDGE_UNIT"
	fi
	systemctl daemon-reload >/dev/null 2>&1 || true
	if [[ "$opt_backup" -eq 1 && -d /opt/signer-node-edge.accept-backup ]]; then
		rm -rf /opt/signer-node-edge
		mv /opt/signer-node-edge.accept-backup /opt/signer-node-edge
	fi
	rm -rf "$ROOT" /var/lib/signer-edge-renew
}
trap cleanup EXIT
getent group signer-edge >/dev/null
install -d -m 700 "$ROOT/bin" "$ROOT/work" "$ROOT/prod-store/versions/old" "$ROOT/renew-store/versions/old"
chmod 755 "$DEPLOY"/*.sh
ln -s versions/old "$ROOT/prod-store/current"
ln -s versions/old "$ROOT/renew-store/current"
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$ROOT/ca.key" -out "$ROOT/ca.pem" -subj /CN=LocalTestCA -days 2 >/dev/null 2>&1
chmod 600 "$ROOT/ca.key"
issue() {
	local name=$1 dest=$2
	openssl req -newkey rsa:2048 -nodes -keyout "$dest/privkey.pem" -out "$dest/req.pem" -subj "/CN=$name" -addext "subjectAltName=DNS:$name" >/dev/null 2>&1
	openssl x509 -req -in "$dest/req.pem" -CA "$ROOT/ca.pem" -CAkey "$ROOT/ca.key" -CAcreateserial -out "$dest/leaf.pem" -days 2 -copy_extensions copy >/dev/null 2>&1
	cat "$dest/leaf.pem" "$ROOT/ca.pem" > "$dest/fullchain.pem"
	rm -f "$dest/req.pem" "$dest/leaf.pem"
	chmod 644 "$dest/fullchain.pem"
	chmod 600 "$dest/privkey.pem"
	chown root:root "$dest/fullchain.pem" "$dest/privkey.pem"
}
install -d -m 700 "$ROOT/work/prod-in" "$ROOT/work/stage-lineage" "$ROOT/work/bad-key"
issue dle.conet.network "$ROOT/work/prod-in"
issue dle-dns01-staging.conet.network "$ROOT/work/stage-lineage"
cp "$ROOT/work/prod-in/fullchain.pem" "$ROOT/work/bad-key/fullchain.pem"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$ROOT/work/bad-key/privkey.pem" >/dev/null 2>&1
chmod 600 "$ROOT/work/bad-key/privkey.pem"
if openssl x509 -in "$ROOT/work/prod-in/fullchain.pem" -noout -issuer | grep -q '(STAGING)'; then
	echo 'REFUSING staging issuer on local test CA' >&2
	exit 1
fi
echo 'LOCAL_TEST_CA=true'
echo 'NOT_PUBLIC_TRUST=true'
echo 'NOT_LETS_ENCRYPT=true'
before=$(readlink "$ROOT/prod-store/current")
set +e
SIGNER_EDGE_DNS01_PROFILE=production \
SIGNER_EDGE_DNS01_DIRECTORY=https://acme-v02.api.letsencrypt.org/directory \
SIGNER_EDGE_DEPLOY_CA="$ROOT/ca.pem" \
SIGNER_EDGE_CERT_STORE="$ROOT/prod-store" \
	"$DEPLOY/signer-edge-install-version.sh" "$ROOT/work/bad-key" >/tmp/signer-accept-bad.out 2>/tmp/signer-accept-bad.err
bad_rc=$?
set -e
[[ "$bad_rc" -ne 0 ]]
grep -q 'publish-refused reason=key' /tmp/signer-accept-bad.err
[[ "$(readlink "$ROOT/prod-store/current")" == "$before" ]]
echo 'BAD_KEY_KEEPS_CURRENT=true'
SIGNER_EDGE_DNS01_PROFILE=production \
SIGNER_EDGE_DNS01_DIRECTORY=https://acme-v02.api.letsencrypt.org/directory \
SIGNER_EDGE_DEPLOY_CA="$ROOT/ca.pem" \
SIGNER_EDGE_CERT_STORE="$ROOT/prod-store" \
	"$DEPLOY/signer-edge-install-version.sh" "$ROOT/work/prod-in" >/tmp/signer-accept-good.out 2>/tmp/signer-accept-good.err
after=$(readlink "$ROOT/prod-store/current")
[[ "$after" != "$before" ]]
[[ -d "$ROOT/prod-store/versions/old" ]]
key_mode=$(stat -c %a "$ROOT/prod-store/$after/privkey.pem")
key_owner=$(stat -c %U:%G "$ROOT/prod-store/$after/privkey.pem")
[[ "$key_mode" == 640 && "$key_owner" == root:signer-edge ]]
echo 'PRODUCTION_PUBLISH_OK=true'
cat > "$ROOT/bin/ssh" <<'EOF'
#!/bin/sh
printf '%s\n' invoked >> "${ACCEPT_SSH_LOG:?}"
if [[ "${ACCEPT_SSH_MODE:-allow}" != allow ]]; then
	exit 99
fi
mkdir -p "${ACCEPT_EXTRACT:?}"
tar -C "$ACCEPT_EXTRACT" -xf -
chmod 644 "$ACCEPT_EXTRACT/fullchain.pem"
chmod 600 "$ACCEPT_EXTRACT/privkey.pem"
chown root:root "$ACCEPT_EXTRACT/fullchain.pem" "$ACCEPT_EXTRACT/privkey.pem"
exit 0
EOF
chmod 755 "$ROOT/bin/ssh"
export ACCEPT_SSH_LOG=$ROOT/ssh.log
export ACCEPT_EXTRACT=$ROOT/extracted
: > "$ACCEPT_SSH_LOG"
export ACCEPT_SSH_MODE=deny
refuse_deliver() {
	set +e
	PATH="$ROOT/bin:$PATH" "$DEPLOY/signer-edge-deliver-version.sh" "$1" peter@127.0.0.1 >/tmp/signer-accept-deliver.out 2>/tmp/signer-accept-deliver.err
	local rc=$?
	set -e
	[[ "$rc" -ne 0 ]]
	[[ ! -s "$ACCEPT_SSH_LOG" ]]
	grep -q 'deliver-refused' /tmp/signer-accept-deliver.err
}
install -d -m 700 "$ROOT/work/ok-stamp"
cp "$ROOT/work/prod-in/fullchain.pem" "$ROOT/work/ok-stamp/fullchain.pem"
cp "$ROOT/work/prod-in/privkey.pem" "$ROOT/work/ok-stamp/privkey.pem"
chmod 600 "$ROOT/work/ok-stamp/privkey.pem"
install -d -m 700 "$ROOT/work/space dir/stamp"
cp -a "$ROOT/work/ok-stamp/." "$ROOT/work/space dir/stamp/"
install -d -m 700 "$ROOT/work/quote\"dir/stamp"
cp -a "$ROOT/work/ok-stamp/." "$ROOT/work/quote\"dir/stamp/"
install -d -m 700 "$ROOT/parent"
cp -a "$ROOT/work/ok-stamp/." "$ROOT/parent/escaped/"
ln -s "$ROOT/work/ok-stamp" "$ROOT/work/linked-stamp"
install -d -m 700 "$ROOT/work/linked-file"
cp "$ROOT/work/ok-stamp/fullchain.pem" "$ROOT/work/linked-file/fullchain.pem"
ln -s "$ROOT/work/ok-stamp/privkey.pem" "$ROOT/work/linked-file/privkey.pem"
refuse_deliver "$ROOT/work/space dir/stamp"
echo 'DENY_SPACE=true'
refuse_deliver "$ROOT/work/quote\"dir/stamp"
echo 'DENY_QUOTE=true'
refuse_deliver "$ROOT/parent/escaped/../../parent/escaped"
echo 'DENY_TRAVERSAL=true'
refuse_deliver "$ROOT/work/linked-stamp"
echo 'DENY_SYMLINK_DIR=true'
refuse_deliver "$ROOT/work/linked-file"
echo 'DENY_SYMLINK_FILE=true'
[[ "$(readlink "$ROOT/prod-store/current")" == "$after" ]]
echo 'NEGATIVES_KEEP_CURRENT=true'
export ACCEPT_SSH_MODE=allow
: > "$ACCEPT_SSH_LOG"
rm -rf "$ACCEPT_EXTRACT"
PATH="$ROOT/bin:$PATH" "$DEPLOY/signer-edge-deliver-version.sh" "$ROOT/work/ok-stamp" peter@127.0.0.1 >/tmp/signer-accept-deliver-ok.out 2>/tmp/signer-accept-deliver-ok.err
[[ -s "$ACCEPT_SSH_LOG" ]]
[[ -f "$ACCEPT_EXTRACT/fullchain.pem" && -f "$ACCEPT_EXTRACT/privkey.pem" ]]
[[ "$(find "$ACCEPT_EXTRACT" -mindepth 1 -maxdepth 1 | wc -l)" -eq 2 ]]
[[ "$(stat -c %a "$ACCEPT_EXTRACT/privkey.pem")" == 600 ]]
echo 'DELIVER_OK=true'
cat > "$ROOT/bin/certbot" <<EOF
#!/bin/sh
state=$ROOT/attempts
n=0
if [ -f "\$state" ]; then
	n=\$(cat "\$state")
fi
n=\$((n + 1))
printf '%s\n' "\$n" > "\$state"
if [ "\$n" -eq 1 ]; then
	readlink "$ROOT/renew-store/current" > "$ROOT/current-at-failure"
	exit 42
fi
deploy=
prev=
for arg in "\$@"; do
	if [ "\$prev" = "--deploy-hook" ]; then
		deploy=\$arg
	fi
	prev=\$arg
done
if [ -z "\$deploy" ]; then
	exit 1
fi
RENEWED_LINEAGE=\${SIGNER_EDGE_RENEW_LINEAGE:-} "\$deploy"
exit \$?
EOF
chmod 755 "$ROOT/bin/certbot"
sed \
	-e "s#/opt/signer-node-edge/deploy/signer-edge-renew.sh#$DEPLOY/signer-edge-renew.sh#" \
	-e 's#RestartSec=30#RestartSec=1#' \
	"$DEPLOY/signer-edge-renew.service" > "/run/systemd/system/$UNIT"
grep -q '^StartLimitBurst=2$' "/run/systemd/system/$UNIT"
grep -q '^Type=exec$' "/run/systemd/system/$UNIT"
printf '\n[Service]\nEnvironment=SIGNER_EDGE_RENEW_APPROVED=1\nEnvironment=SIGNER_EDGE_RENEW_LINEAGE=%s\nEnvironment=SIGNER_EDGE_CERT_STORE=%s\nEnvironment=SIGNER_EDGE_DEPLOY_CA=%s\nEnvironment=SIGNER_EDGE_CERTBOT=%s\n' \
	"$ROOT/work/stage-lineage" "$ROOT/renew-store" "$ROOT/ca.pem" "$ROOT/bin/certbot" >> "/run/systemd/system/$UNIT"
rm -rf "/run/systemd/system/$UNIT.d"
echo 'TIMER_UNIT_INSTALLED=true'
systemctl daemon-reload
systemctl reset-failed "$UNIT" >/dev/null 2>&1 || true
systemctl start "$UNIT" || true
result=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
	result=$(systemctl show "$UNIT" -p Result --value)
	if [[ "$result" == success ]] && journalctl -u "$UNIT" -o cat --no-pager | grep -q 'restart counter is at 1'; then
		break
	fi
	sleep 0.5
done
echo "TIMER_RESULT=$result"
[[ "$result" == success ]]
journalctl -u "$UNIT" -o cat --no-pager | grep -q 'restart counter is at 1'
[[ "$(cat "$ROOT/current-at-failure")" == versions/old ]]
[[ "$(readlink "$ROOT/renew-store/current")" != versions/old ]]
[[ ! -e /var/lib/signer-edge-renew/failed ]]
journalctl -u "$UNIT" -o cat --no-pager | grep -q 'renew-failed rc=42'
echo 'TIMER_TRIGGERED=true'
echo 'FAILURE_MARKER=true'
echo 'BOUNDED_RETRY=true'
echo 'CURRENT_UNCHANGED_ON_FAILURE=true'
systemctl stop "$UNIT" || true
systemctl reset-failed "$UNIT" || true
rm -f "/run/systemd/system/$UNIT"
rm -rf "/run/systemd/system/$UNIT.d"
systemctl daemon-reload
if systemctl list-unit-files "$UNIT" --no-legend | grep -q "$UNIT"; then
	echo 'REFUSING temporary unit still installed' >&2
	exit 1
fi
echo 'TEMP_UNIT_REMOVED=true'
if [[ ! -e /etc/systemd/system/signer-node-edge.service && ! -e /lib/systemd/system/signer-node-edge.service && ! -e /usr/lib/systemd/system/signer-node-edge.service ]]; then
	cat > "$EDGE_UNIT" <<'EOF'
[Service]
Type=simple
ExecStart=/bin/sleep infinity
EOF
	created_edge=1
	systemctl daemon-reload
	systemctl start signer-node-edge.service
fi
SIGNER_EDGE_ROLLBACK_APPROVED=1 "$DEPLOY/signer-edge-rollback.sh" stop
edge_state=$(systemctl is-active signer-node-edge.service || true)
[[ "$edge_state" == inactive || "$edge_state" == failed ]]
echo 'ROLLBACK_STOP_OK=true'
want=1a212978c573488f646725ff99b8b6e65fc123897df5673764e6d7a2497a01bb
got=$(sha256sum "$ARCHIVE" | awk '{print $1}')
[[ "$got" == "$want" ]]
if [[ -d /opt/signer-node-edge ]]; then
	mv /opt/signer-node-edge /opt/signer-node-edge.accept-backup
	opt_backup=1
fi
SIGNER_EDGE_ROLLBACK_APPROVED=1 "$DEPLOY/signer-edge-rollback.sh" previous-artifact "$ARCHIVE"
[[ -f /opt/signer-node-edge/src/edge.mjs ]]
if [[ -d /opt/nginx || -e /run/wallet-signer-rpc/rpc.sock ]]; then
	:
fi
echo 'ROLLBACK_ARTIFACT_OK=true'
echo 'ACCEPTANCE_OK=true'

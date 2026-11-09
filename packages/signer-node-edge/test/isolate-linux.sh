#!/bin/bash
# Publish-template equivalent sandbox. Not a production install.
# Read-only checks finish before the EXIT trap. Cleanup stops only this run's unit,
# removes only this run's unit file, and deletes only this run's directory.
set -euo pipefail

echo 'PUBLISH_TEMPLATE_EQUIVALENT'
echo "host=$(hostname)"

if [[ "$(hostname)" == "dle" ]] || ip -4 addr show | grep -q '70.35.205.77'; then
	echo 'REFUSING production signer host' >&2
	exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then
	echo 'REFUSING non-root isolate run' >&2
	exit 2
fi
command -v node >/dev/null
command -v systemctl >/dev/null
command -v openssl >/dev/null
command -v runuser >/dev/null
command -v ss >/dev/null
command -v python3 >/dev/null
if ! systemctl is-system-running --quiet; then
	echo 'REFUSING host whose systemd is not running' >&2
	exit 2
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ROOT="/var/lib/signer-edge-isolate-${RUN_ID}"
UNIT="signer-edge-isolate-${RUN_ID}.service"
UNIT_PATH="/run/systemd/system/${UNIT}"
SRC="${1:-}"
TEMPLATE="${SRC}/deploy/signer-node-edge.service"
HOOK="${SRC}/deploy/certbot-deploy-refresh.sh"
if [[ -z "$SRC" || ! -f "$SRC/src/edge.mjs" || ! -f "$TEMPLATE" || ! -f "$HOOK" ]]; then
	echo 'REFUSING missing source argument' >&2
	exit 2
fi
if [[ -e "$ROOT" || -e "$UNIT_PATH" ]]; then
	echo "REFUSING existing $ROOT or $UNIT_PATH" >&2
	exit 2
fi
if [[ "$(systemctl show "$UNIT" -p LoadState --value 2>/dev/null || true)" == "loaded" ]]; then
	echo "REFUSING already loaded $UNIT" >&2
	exit 2
fi

python3 - "$TEMPLATE" "$HOOK" << 'PY'
import sys
template, hook = sys.argv[1:]
text = open(template, encoding='utf-8').read()
hook_text = open(hook, encoding='utf-8').read()
forbidden = ('RuntimeDirectory=', 'SIGNER_EDGE_HTTP_PORT', 'SIGNER_EDGE_WEBROOT', '/var/www/dle', 'systemctl kill')
for needle in forbidden:
    if needle in text or needle in hook_text:
        raise SystemExit(f'REFUSING template contains {needle}')
if 'SIGNER_EDGE_HTTPS_PORT=443' not in text:
    raise SystemExit('REFUSING template is not 443-only')
line = next(row for row in text.splitlines() if row.startswith('InaccessiblePaths='))
tokens = line.split('=', 1)[1].split()
if not tokens or any(not token.startswith('-/') for token in tokens):
    raise SystemExit(f'REFUSING inaccessible paths are not optional: {tokens}')
if 'systemctl' in hook_text or 'nginx' in hook_text or 'mv -Tf' not in hook_text:
    raise SystemExit('REFUSING hook is not poll-only atomic publish')
print('TEMPLATE_GATE_OK')
PY

if id signer-edge >/dev/null 2>&1; then
	signer_groups=" $(id -nG signer-edge) "
	for forbidden in www-data wsadmin oracle-daemon walletsigner; do
		if [[ "$signer_groups" == *" ${forbidden} "* ]]; then
			echo "REFUSING signer-edge membership in ${forbidden}" >&2
			exit 2
		fi
	done
fi

for legacy in /opt/wallet-signer /etc/wallet-signer /run/wallet-signer /run/wallet-signer-rpc /run/wallet-signer-oracle /srv/secure/wallet-signer; do
	if [[ -e "$legacy" ]]; then
		echo "LEGACY_PRESENT $legacy"
	else
		echo "LEGACY_ABSENT $legacy"
	fi
done

cleanup() {
	if [[ -n "${HOLD_PID:-}" ]]; then
		kill "$HOLD_PID" >/dev/null 2>&1 || true
		wait "$HOLD_PID" >/dev/null 2>&1 || true
	fi
	systemctl stop "$UNIT" >/dev/null 2>&1 || true
	rm -f "$UNIT_PATH"
	systemctl daemon-reload >/dev/null 2>&1 || true
	if [[ "$ROOT" == /var/lib/signer-edge-isolate-* ]]; then
		rm -rf "$ROOT"
	fi
}
on_exit() {
	local code=$?
	if [[ "$code" -ne 0 ]]; then
		echo '=== journal on failure ===' >&2
		journalctl -u "$UNIT" --no-pager >&2 || true
	fi
	cleanup
	exit "$code"
}
trap on_exit EXIT

if ! id signer-edge >/dev/null 2>&1; then
	useradd --system --shell /usr/sbin/nologin --home-dir /nonexistent --no-create-home signer-edge
fi
signer_groups=" $(id -nG signer-edge) "
for forbidden in www-data wsadmin oracle-daemon walletsigner; do
	if [[ "$signer_groups" == *" ${forbidden} "* ]]; then
		echo "REFUSING signer-edge membership in ${forbidden}" >&2
		exit 2
	fi
done

install -d -o root -g root -m 755 "$ROOT" "$ROOT/app" "$ROOT/certstore" "$ROOT/certstore/versions" "$ROOT/certstore/versions/v1" "$ROOT/lineage" "$ROOT/standin" "$ROOT/standin/locked"
cp -a "$SRC/src" "$SRC/test" "$SRC/deploy" "$SRC/package.json" "$ROOT/app/"
chown -R root:root "$ROOT/app" "$ROOT/certstore"
chmod -R a-w "$ROOT/app"
chmod 755 "$ROOT" "$ROOT/app" "$ROOT/app/src" "$ROOT/app/test" "$ROOT/app/deploy"
chmod 755 "$HOOK" "$ROOT/app/deploy/certbot-deploy-refresh.sh"

openssl req -x509 -newkey rsa:2048 -keyout "$ROOT/lineage/a-key.pem" -out "$ROOT/lineage/a-cert.pem" -days 1 -nodes -subj /CN=edge-isolate-a >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -keyout "$ROOT/lineage/b-key.pem" -out "$ROOT/lineage/b-cert.pem" -days 1 -nodes -subj /CN=edge-isolate-b >/dev/null 2>&1
install -o root -g root -m 644 "$ROOT/lineage/a-cert.pem" "$ROOT/certstore/versions/v1/fullchain.pem"
install -o root -g signer-edge -m 640 "$ROOT/lineage/a-key.pem" "$ROOT/certstore/versions/v1/privkey.pem"
chmod 755 "$ROOT/certstore" "$ROOT/certstore/versions" "$ROOT/certstore/versions/v1"
chmod 644 "$ROOT/certstore/versions/v1/fullchain.pem"
chmod 640 "$ROOT/certstore/versions/v1/privkey.pem"
chown root:root "$ROOT/certstore" "$ROOT/certstore/versions" "$ROOT/certstore/versions/v1" "$ROOT/certstore/versions/v1/fullchain.pem"
chown root:signer-edge "$ROOT/certstore/versions/v1/privkey.pem"
ln -s versions/v1 "$ROOT/certstore/current.next"
mv -Tf "$ROOT/certstore/current.next" "$ROOT/certstore/current"
cp "$ROOT/lineage/b-cert.pem" "$ROOT/lineage/bad-cert.pem"

python3 - "$TEMPLATE" "$UNIT_PATH" "$ROOT" << 'PY'
import sys
template, dest, root = sys.argv[1:]
text = open(template, encoding='utf-8').read()
text = text.replace('/opt/signer-node-edge', f'{root}/app')
text = text.replace('/var/lib/signer-node-edge', f'{root}/certstore')
text = text.replace('SIGNER_EDGE_BIND=0.0.0.0', 'SIGNER_EDGE_BIND=127.0.0.1')
text = text.replace('SIGNER_EDGE_CERT_POLL_MS=5000', 'SIGNER_EDGE_CERT_POLL_MS=400')
open(dest, 'w', encoding='utf-8').write(text)
PY
chmod 644 "$UNIT_PATH"
systemctl daemon-reload

install -d -o root -g root -m 700 "$ROOT/standin/vault-dir"
printf 'ISOLATE_MARKER\n' > "$ROOT/standin/vault-dir/vault"
chown root:root "$ROOT/standin/vault-dir/vault"
chmod 600 "$ROOT/standin/vault-dir/vault"
cat > "$ROOT/hold.mjs" << 'EOF'
import net from 'node:net'
import fs from 'node:fs'
const dir = process.argv[2]
fs.mkdirSync(dir, { recursive: true, mode: 0o750 })
fs.chmodSync(dir, 0o750)
for (const name of ['admin.sock', 'rpc.sock', 'oracle.sock']) {
	const server = net.createServer()
	await new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(`${dir}/${name}`, resolve)
	})
	fs.chmodSync(`${dir}/${name}`, 0o660)
}
await new Promise(() => {})
EOF
node "$ROOT/hold.mjs" "$ROOT/standin/sock-dir" >/dev/null &
HOLD_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
	[[ -S "$ROOT/standin/sock-dir/oracle.sock" ]] && break
	sleep 0.1
done
echo '=== dac ==='
runuser -u signer-edge -- env \
	EDGE_DAC_VAULT="$ROOT/standin/vault-dir/vault" \
	EDGE_DAC_PROBE="$ROOT/standin/locked/probe" \
	EDGE_DAC_SOCKETS="$ROOT/standin/sock-dir/admin.sock,$ROOT/standin/sock-dir/rpc.sock,$ROOT/standin/sock-dir/oracle.sock" \
	node "$ROOT/app/test/negative-dac.mjs"

echo "=== start installed unit $UNIT ==="
systemctl start "$UNIT"
systemctl is-active "$UNIT"
EDGE_HTTPS_PORT=443 \
EDGE_BIND=127.0.0.1 \
EDGE_UNIT="$UNIT" \
EDGE_STORE="$ROOT/certstore" \
EDGE_TEMPLATE="$TEMPLATE" \
EDGE_INSTALLED_UNIT="$UNIT_PATH" \
EDGE_HOOK="$HOOK" \
EDGE_LINEAGE="$ROOT/lineage" \
	node "$ROOT/app/test/systemd-acceptance.mjs"
echo ISOLATE_SYSTEMD_OK

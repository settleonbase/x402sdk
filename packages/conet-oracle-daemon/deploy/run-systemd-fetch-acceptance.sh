#!/bin/sh
# Isolate-only systemd acceptance. Do not run on a production host.
# Do not start conetOracle.service. Do not enable the shipped timer.
set -eu

ROOT=${1:?package root}
LAB=/tmp/conet-oracle-fetch-lab
UNIT=conet-oracle-fetch-lab
if systemctl is-active --quiet conetOracle.service 2>/dev/null; then
	echo 'refusing: conetOracle.service is active' >&2
	exit 2
fi

cleanup() {
	sudo -n systemctl stop "$UNIT.timer" "$UNIT.service" 2>/dev/null || true
	sudo -n systemctl reset-failed "$UNIT.timer" "$UNIT.service" 2>/dev/null || true
	sudo -n rm -f "/etc/systemd/system/$UNIT.service" "/etc/systemd/system/$UNIT.timer"
	sudo -n systemctl daemon-reload || true
	if [ -n "${MOCK_PID:-}" ]; then
		kill "$MOCK_PID" 2>/dev/null || true
		wait "$MOCK_PID" 2>/dev/null || true
	fi
	if [ -n "${HOLD_PID:-}" ]; then
		kill "$HOLD_PID" 2>/dev/null || true
		wait "$HOLD_PID" 2>/dev/null || true
	fi
	rm -rf "$LAB"
}
trap cleanup EXIT

rm -rf "$LAB"
mkdir -p "$LAB"
openssl req -x509 -newkey rsa:2048 -keyout "$LAB/key.pem" -out "$LAB/cert.pem" -days 1 -nodes \
	-subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 >/dev/null 2>&1
printf 'retry\n' > "$LAB/mode"
: > "$LAB/events"
node "$ROOT/deploy/systemd-lab-mocks.mjs" "$LAB/cert.pem" "$LAB/key.pem" "$LAB/port" "$LAB/events" "$LAB/mode" "$LAB/signer.sock" \
	>"$LAB/mock.out" 2>&1 &
MOCK_PID=$!
i=0
while [ ! -s "$LAB/port" ]; do
	i=$((i + 1))
	if [ "$i" -gt 50 ]; then
		echo 'mock did not listen' >&2
		cat "$LAB/mock.out" >&2 || true
		exit 1
	fi
	sleep 0.1
done
PORT=$(cat "$LAB/port")

cat > "$LAB/$UNIT.service" << EOF
[Unit]
Description=Temporary CoNET oracle fetch acceptance
[Service]
Type=oneshot
User=$(id -un)
Restart=no
ExecStart=$(command -v node) $ROOT/dist/src/main.js --lock-file $LAB/lock --socket $LAB/signer.sock --fx-url https://127.0.0.1:$PORT/fx --eth-url https://127.0.0.1:$PORT/eth --ca-file $LAB/cert.pem
EOF

cat > "$LAB/$UNIT.timer" << EOF
[Unit]
Description=Temporary CoNET oracle fetch timer
[Timer]
OnActiveSec=1s
OnUnitInactiveSec=2s
AccuracySec=1s
Persistent=false
Unit=$UNIT.service
EOF

sudo -n cp "$LAB/$UNIT.service" "/etc/systemd/system/$UNIT.service"
sudo -n cp "$LAB/$UNIT.timer" "/etc/systemd/system/$UNIT.timer"
sudo -n systemctl daemon-reload
ENABLED=$(systemctl is-enabled "$UNIT.timer" 2>/dev/null || true)
if [ "$ENABLED" = "enabled" ]; then
	echo 'refusing: lab timer is enabled' >&2
	exit 1
fi

echo '--- phase retry ---'
if ! sudo -n systemctl start "$UNIT.service"; then
	journalctl -u "$UNIT.service" -o short-iso --no-pager || true
	exit 1
fi
systemctl show "$UNIT.service" -p Result -p ExecMainStatus -p NRestarts -p Restart --no-pager
echo '--- events after retry ---'
cat "$LAB/events"

printf 'locked-once\n' > "$LAB/mode"
echo '--- phase timer ---'
sudo -n systemctl start "$UNIT.timer"
i=0
while ! grep -q 'signer locked' "$LAB/events" || [ "$(grep -c 'signer ok' "$LAB/events" || true)" -lt 2 ]; do
	i=$((i + 1))
	if [ "$i" -gt 40 ]; then
		echo 'timer did not complete locked then next success' >&2
		systemctl status "$UNIT.timer" --no-pager || true
		journalctl -u "$UNIT.service" -o short-iso --no-pager || true
		exit 1
	fi
	sleep 0.5
done
sudo -n systemctl stop "$UNIT.timer" || true
RESTARTS=$(systemctl show "$UNIT.service" -p NRestarts --value)
if [ "$RESTARTS" != "0" ]; then
	echo "NRestarts=$RESTARTS" >&2
	exit 1
fi
echo '--- journal ---'
journalctl -u "$UNIT.service" -o short-iso --no-pager
echo '--- show after timer ---'
systemctl show "$UNIT.service" -p Result -p ExecMainStatus -p NRestarts -p Restart --no-pager
echo '--- enabled ---'
systemctl is-enabled "$UNIT.timer" || true
systemctl is-active conetOracle.service || true

echo '--- phase overlap ---'
BEFORE=$(grep -c 'signer ' "$LAB/events" || true)
sh -c "echo \$\$ > '$LAB/lock'; exec sleep 30" &
HOLD_PID=$!
sleep 0.2
sudo -n systemctl start "$UNIT.service"
AFTER=$(grep -c 'signer ' "$LAB/events" || true)
echo "signer_lines_before=$BEFORE signer_lines_after=$AFTER"
journalctl -u "$UNIT.service" -o short-iso --no-pager | tail -n 20
if [ "$BEFORE" != "$AFTER" ]; then
	echo 'overlap sent a signature' >&2
	exit 1
fi
node - "$LAB/events" << 'JS'
const fs = require('node:fs')
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').filter(Boolean).map((line) => {
	const cut = line.indexOf(' ')
	return { t: Number(line.slice(0, cut)), msg: line.slice(cut + 1) }
})
const fx503 = lines.filter((line) => line.msg.startsWith('fx 503')).length
const locked = lines.filter((line) => line.msg.startsWith('signer locked'))
const ok = lines.filter((line) => line.msg.startsWith('signer ok'))
if (fx503 !== 2) throw new Error(`expected 2 fx 503, got ${fx503}`)
if (locked.length !== 1) throw new Error(`expected 1 locked, got ${locked.length}`)
if (ok.length !== 2) throw new Error(`expected 2 signer ok, got ${ok.length}`)
if (ok[1].t - locked[0].t < 1000) throw new Error(`next round followed locked too quickly: ${ok[1].t - locked[0].t}ms`)
const chainOk = ok.every((line) => line.msg.includes('chain=224422') && line.msg.includes('value=0') && line.msg.includes('array=beamio_oracle_owner') && line.msg.includes('0x0936c703'))
if (!chainOk) throw new Error(ok.map((line) => line.msg).join('\n'))
if (!ok.every((line) => line.msg.includes('to=0x77CB8358c5a37aB7190b0A2C7EaA7fEeDCF11008'))) {
	throw new Error('signer target drifted')
}
console.log('acceptance assertions passed')
JS
echo ACCEPTANCE_OK

#!/bin/sh
# Renew the certificate for the selected DNS-01 profile.
# Runs on a future ops host, not on the signer. A failed run leaves the
# published certificate in place. Alerts stay in the journal and in
# /var/lib/signer-edge-renew/failed. This script opens no outbound alert endpoint.
# Do not execute a production renewal until a separate approval.
set -eu
if [ "$(hostname)" = dle ] || ip -4 addr show 2>/dev/null | grep -q '70.35.205.77'; then
	echo 'renew-refused reason=signer-host' >&2
	exit 1
fi
if [ "${SIGNER_EDGE_RENEW_APPROVED:-}" != 1 ]; then
	echo 'renew-refused reason=not-approved' >&2
	exit 1
fi
if systemctl is-active --quiet certbot.timer 2>/dev/null; then
	echo 'renew-refused reason=certbot-timer' >&2
	exit 1
fi
if [ -f /etc/cron.d/certbot ] && grep -E '^[^#].*certbot' /etc/cron.d/certbot | grep -v 'run/systemd/system' | grep -q certbot; then
	echo 'renew-refused reason=cron' >&2
	exit 1
fi
if crontab -l -u root 2>/dev/null | grep -E '^[^#].*certbot' | grep -q certbot; then
	echo 'renew-refused reason=cron' >&2
	exit 1
fi
dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
cert_name=$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); from dns01_profile import selected_profile, assert_profile_domain; _name, spec = selected_profile(); assert_profile_domain(spec["cert_name"]); print(spec["cert_name"])' "$dir")
marker_dir=/var/lib/signer-edge-renew
set +e
certbot_bin=${SIGNER_EDGE_CERTBOT:-certbot}
"$certbot_bin" renew --cert-name "$cert_name" --deploy-hook "$dir/certbot-deploy-refresh.sh" --quiet
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
	install -d -o root -g root -m 755 "$marker_dir"
	printf 'failed %s rc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rc" > "$marker_dir/failed"
	chmod 644 "$marker_dir/failed"
	echo "renew-failed rc=$rc" >&2
	exit "$rc"
fi
rm -f "$marker_dir/failed"
exit 0

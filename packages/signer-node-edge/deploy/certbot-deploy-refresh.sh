#!/bin/sh
# Publish a renewed certificate into one version directory, then switch current atomically.
# The edge polls that symlink. This hook does not signal the service cgroup and does not start a proxy.
# Defaults are the production lineage and store. A sandbox may set the two SIGNER_EDGE_* overrides.
set -eu
lineage=${RENEWED_LINEAGE:-}
store=${SIGNER_EDGE_CERT_STORE:-/var/lib/signer-node-edge}
expected=${SIGNER_EDGE_RENEW_LINEAGE:-/etc/letsencrypt/live/dle.conet.network}
if [ "$lineage" != "$expected" ]; then
	exit 0
fi
case "$store" in
	/opt/wallet-signer|/opt/wallet-signer/*|/srv/secure|/srv/secure/*|/etc/wallet-signer|/etc/wallet-signer/*|/run/wallet-signer|/run/wallet-signer/*|/run/wallet-signer-rpc|/run/wallet-signer-rpc/*|/run/wallet-signer-oracle|/run/wallet-signer-oracle/*)
		echo "refusing certificate store under a signer runtime path" >&2
		exit 1
		;;
esac
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
dest=$store/versions/$stamp
install -d -o root -g root -m 755 "$store" "$store/versions" "$dest"
install -o root -g root -m 644 "$lineage/fullchain.pem" "$dest/fullchain.pem"
install -o root -g signer-edge -m 640 "$lineage/privkey.pem" "$dest/privkey.pem"
chmod 755 "$store" "$store/versions" "$dest"
chmod 644 "$dest/fullchain.pem"
chmod 640 "$dest/privkey.pem"
chown root:root "$dest" "$dest/fullchain.pem" "$store" "$store/versions"
chown root:signer-edge "$dest/privkey.pem"
ln -s "versions/$stamp" "$store/current.next"
mv -Tf "$store/current.next" "$store/current"

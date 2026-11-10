#!/bin/sh
# Install one incoming version directory as root and switch current with mv -Tf.
# A profile mismatch, a staging issuer on the production profile, bad dates,
# a bad chain, or a key mismatch does not move current. Do not run this on
# the production signer until a separate approval.
set -eu
if [ "$(id -u)" -ne 0 ]; then
	echo 'install-refused reason=root' >&2
	exit 1
fi
incoming=${1:?incoming version directory}
dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
# shellcheck source=signer-edge-path.sh
. "$dir/signer-edge-path.sh"
signer_edge_refuse_unsafe install "$incoming"
store=${SIGNER_EDGE_CERT_STORE:-/var/lib/signer-node-edge}
signer_edge_refuse_unsafe install "$store"
case "$store" in
	/opt/wallet-signer|/opt/wallet-signer/*|/srv/secure|/srv/secure/*|/etc/wallet-signer|/etc/wallet-signer/*|/run/wallet-signer|/run/wallet-signer/*|/run/wallet-signer-rpc|/run/wallet-signer-rpc/*|/run/wallet-signer-oracle|/run/wallet-signer-oracle/*)
		echo 'install-refused reason=path' >&2
		exit 1
		;;
esac
if [ -L "$incoming/fullchain.pem" ] || [ -L "$incoming/privkey.pem" ]; then
	echo 'install-refused reason=symlink' >&2
	exit 1
fi
[ -f "$incoming/fullchain.pem" ] && [ -f "$incoming/privkey.pem" ] || {
	echo 'install-refused reason=missing' >&2
	exit 1
}
if [ -e "$incoming/cloudflare.env" ]; then
	echo 'install-refused reason=token' >&2
	exit 1
fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
dest=$store/versions/$stamp
install -d -o root -g root -m 755 "$store" "$store/versions" "$dest"
install -o root -g root -m 644 "$incoming/fullchain.pem" "$dest/fullchain.pem"
install -o root -g signer-edge -m 640 "$incoming/privkey.pem" "$dest/privkey.pem"
chown root:root "$dest" "$dest/fullchain.pem" "$store" "$store/versions"
chown root:signer-edge "$dest/privkey.pem"
SIGNER_EDGE_PUBLISH_CERT="$dest/fullchain.pem" \
SIGNER_EDGE_PUBLISH_KEY="$dest/privkey.pem" \
	python3 "$dir/dns01_publish.py"
ln -s "versions/$stamp" "$store/current.next"
mv -Tf "$store/current.next" "$store/current"

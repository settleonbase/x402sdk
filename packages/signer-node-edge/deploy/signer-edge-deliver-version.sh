#!/bin/sh
# Copy one version directory's certificate and private key. Nothing else.
# The token file is not part of this copy. Do not run this against the
# production signer until a separate approval.
set -eu
src=${1:?version directory}
dest_host=${2:?ssh host}
dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
# shellcheck source=signer-edge-path.sh
. "$dir/signer-edge-path.sh"
signer_edge_refuse_unsafe deliver "$src"
base=$(basename "$src")
if ! signer_edge_stamp_ok "$base"; then
	echo 'deliver-refused reason=name' >&2
	exit 1
fi
case "$dest_host" in
	*[!A-Za-z0-9._@:-]*) echo 'deliver-refused reason=host' >&2; exit 1 ;;
esac
if printf '%s' "$dest_host" | grep -q '70.35.205.77'; then
	if [ "${SIGNER_EDGE_DELIVER_APPROVED:-}" != 1 ]; then
		echo 'deliver-refused reason=not-approved' >&2
		exit 1
	fi
fi
if [ -L "$src/fullchain.pem" ] || [ -L "$src/privkey.pem" ]; then
	echo 'deliver-refused reason=symlink' >&2
	exit 1
fi
[ -f "$src/fullchain.pem" ] && [ -f "$src/privkey.pem" ] || {
	echo 'deliver-refused reason=missing' >&2
	exit 1
}
if [ -e "$src/cloudflare.env" ]; then
	echo 'deliver-refused reason=token' >&2
	exit 1
fi
extra=$(find "$src" -mindepth 1 -maxdepth 1 ! -name fullchain.pem ! -name privkey.pem -print)
if [ -n "$extra" ]; then
	echo 'deliver-refused reason=extra' >&2
	exit 1
fi
# The stamp allowlist is the quoting boundary. dash has no printf %q.
COPYFILE_DISABLE=1 tar -C "$src" -cf - fullchain.pem privkey.pem \
	| ssh -o BatchMode=yes -o LogLevel=ERROR "$dest_host" "sudo -n install -d -o root -g root -m 755 -- /var/lib/signer-node-edge/incoming/$base && sudo -n tar -C /var/lib/signer-node-edge/incoming/$base -xf - && sudo -n chown root:root -- /var/lib/signer-node-edge/incoming/$base/fullchain.pem && sudo -n chown root:signer-edge -- /var/lib/signer-node-edge/incoming/$base/privkey.pem && sudo -n chmod 644 -- /var/lib/signer-node-edge/incoming/$base/fullchain.pem && sudo -n chmod 600 -- /var/lib/signer-node-edge/incoming/$base/privkey.pem"

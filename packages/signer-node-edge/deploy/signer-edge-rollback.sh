#!/bin/sh
# Roll back the HTTPS entry only.
# stop: leave ports 80 and 443 without this edge.
# previous-artifact: replace /opt/signer-node-edge with the accepted archive
# signer-node-edge-2026-11-09.tar.gz, commit 47d964e1b249bc30794955b0387260bb1fefb58d,
# sha256 1a212978c573488f646725ff99b8b6e65fc123897df5673764e6d7a2497a01bb.
# Neither mode restores nginx or the old shared signing socket.
# Do not execute this on the production signer until a separate approval.
set -eu
mode=${1:?stop or previous-artifact}
case "$mode" in
	nginx|rpc.proxied|rpc.sock)
		echo 'rollback-refused reason=forbidden' >&2
		exit 1
		;;
esac
if [ "${SIGNER_EDGE_ROLLBACK_APPROVED:-}" != 1 ]; then
	echo 'rollback-refused reason=not-approved' >&2
	exit 1
fi
case "$mode" in
	stop)
		systemctl stop signer-node-edge.service
		systemctl stop signer-edge-renew.timer 2>/dev/null || true
		systemctl stop signer-edge-renew.service 2>/dev/null || true
		;;
	previous-artifact)
		archive=${2:?path to signer-node-edge-2026-11-09.tar.gz}
		want=1a212978c573488f646725ff99b8b6e65fc123897df5673764e6d7a2497a01bb
		got=$(sha256sum "$archive" | awk '{print $1}')
		if [ "$got" != "$want" ]; then
			echo 'rollback-refused reason=artifact' >&2
			exit 1
		fi
		if tar -tzf "$archive" | grep -E 'cloudflare.env|privkey|\.pem$' | grep -q .; then
			echo 'rollback-refused reason=contents' >&2
			exit 1
		fi
		systemctl stop signer-node-edge.service 2>/dev/null || true
		install -d -o root -g root -m 755 /opt/signer-node-edge.new
		tar -C /opt/signer-node-edge.new --strip-components=1 -xf "$archive"
		[ -f /opt/signer-node-edge.new/src/edge.mjs ]
		rm -rf /opt/signer-node-edge
		mv /opt/signer-node-edge.new /opt/signer-node-edge
		;;
	*)
		echo 'rollback-refused reason=mode' >&2
		exit 1
		;;
esac

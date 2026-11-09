#!/bin/bash
# Negative DNS-01 check. Fake credentials only. This is not a DNS-01 pass.
set -euo pipefail
if [[ "$(hostname)" == "dle" ]] || ip -4 addr show | grep -q '70.35.205.77'; then
	echo 'REFUSING production signer host' >&2
	exit 2
fi
SRC="${1:-}"
if [[ -z "$SRC" || ! -f "$SRC/src/dns01Staging.mjs" ]]; then
	echo 'REFUSING missing source argument' >&2
	exit 2
fi
node --test --test-concurrency=1 "$SRC/test/dns01-negative.mjs"
echo 'NEGATIVE_FAKE_CREDENTIAL_OK'
name='_acme-challenge.dle-dns01-staging.conet.network'
answer=$(dig +time=3 +tries=1 @matt.ns.cloudflare.com "$name" TXT +norecurse +noall +answer | awk 'NF && $1 !~ /^;/')
if [[ -n "$answer" ]]; then
	echo 'REFUSING existing challenge TXT; not overwritten' >&2
	printf '%s\n' "$answer" >&2
	exit 2
fi
echo 'CHALLENGE_TXT_ABSENT'
echo 'DNS01_STAGING_NOT_RUN'

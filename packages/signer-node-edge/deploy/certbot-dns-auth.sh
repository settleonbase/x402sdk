#!/bin/sh
# Certbot DNS-01 auth hook.
# SIGNER_EDGE_DNS01_PROFILE defaults to staging. production must also set
# SIGNER_EDGE_DNS01_DIRECTORY to the production ACME directory.
# Live calls use only https://api.cloudflare.com/client/v4. A loopback override
# is accepted only when SIGNER_EDGE_DNS01_STUB=1, and a bad origin exits before
# the bearer token is read or sent.
# The credential file is /var/lib/signer-edge-dns/cloudflare.env, mode 600 root:root.
# Allowed names: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID. Never pass the token on argv.
# Zone DNS Edit covers the whole zone. Keep the file on the ops host, not on dle.
# Stdout on success is the record id line Certbot stores as CERTBOT_AUTH_OUTPUT.
# A fallback state file is named with the SHA-256 of CERTBOT_VALIDATION.
set -eu
dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
exec python3 "$dir/dns01_auth.py"

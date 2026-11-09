#!/bin/sh
# Certbot DNS-01 cleanup hook. Deletes only the record id from CERTBOT_AUTH_OUTPUT
# for the selected profile. If that output is absent, it uses the state file named
# with the SHA-256 of CERTBOT_VALIDATION. It never lists records by name.
set -eu
dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
exec python3 "$dir/dns01_cleanup.py"

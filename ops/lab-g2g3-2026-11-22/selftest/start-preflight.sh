#!/usr/bin/env bash
# Isolated contract tests for swap-start approval and envcheck binding.
# All env files, deny data, pubkeys, logs and commands are synthetic and local.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
OPS=$(cd "$HERE/.." && pwd)
C="$OPS/lab-g3-cutover.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
FAILS=0
ok(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; FAILS=$((FAILS+1)); }

mkdir -p "$T/bin" "$T/state"
cat > "$T/bin/sudo" <<'FAKE'
#!/bin/sh
[ "$1" = -n ] && shift
exec "$@"
FAKE
chmod +x "$T/bin/sudo"
SUDO="$T/bin/sudo -n"

awk '/^COPY_APPROVAL_MSG=/{take=1} /^preflight_state_hash\(\)/{take=0} take {print}' "$C" > "$T/functions.sh"
. "$T/functions.sh"

COPY_APPROVAL_ID_EXPECTED=synthetic-approval-2026-11-22-a1b2
COPY_APPROVED=no; COPY_APPROVAL_ID=synthetic-approval-2026-11-22-a1b2
if copy_approval_preflight; then bad "missing COPY_APPROVED is rejected"; else [ "$COPY_APPROVAL_MSG" = "COPY_APPROVED must be yes" ] && ok "missing COPY_APPROVED is rejected" || bad "missing COPY_APPROVED diagnostic"; fi
COPY_APPROVED=yes; COPY_APPROVAL_ID=
if copy_approval_preflight; then bad "missing COPY_APPROVAL_ID is rejected"; else [ "$COPY_APPROVAL_MSG" = "COPY_APPROVAL_ID is required" ] && ok "missing COPY_APPROVAL_ID is rejected" || bad "missing COPY_APPROVAL_ID diagnostic"; fi
COPY_APPROVAL_ID=synthetic-approval-2026-11-22-a1b2; COPY_APPROVAL_ID_EXPECTED=
if copy_approval_preflight; then bad "missing site expected ID is rejected"; else [ "$COPY_APPROVAL_MSG" = "COPY_APPROVAL_ID_EXPECTED is missing from the private site configuration" ] && ok "missing site expected ID is rejected" || bad "missing expected ID diagnostic"; fi
COPY_APPROVAL_ID_EXPECTED=synthetic-approval-2026-11-22-a1b2; COPY_APPROVAL_ID=synthetic-approval-other
if copy_approval_preflight; then bad "mismatched approval ID is rejected"; else [ "$COPY_APPROVAL_MSG" = "COPY_APPROVAL_ID does not match the private site expectation" ] && ok "mismatched approval ID is rejected" || bad "mismatch diagnostic"; fi
COPY_APPROVAL_ID=synthetic-approval-2026-11-22-a1b2
if copy_approval_preflight; then ok "matching synthetic approval ID passes"; else bad "matching synthetic approval ID refused ($COPY_APPROVAL_MSG)"; fi

printf '%s\n' 'synthetic-pubkeys fixture' > "$T/pubkeys.json"
PINNED_PUBKEYS_SHA=$(sha256sum "$T/pubkeys.json" | awk '{print $1}')
PUBKEYS_FILE="$T/pubkeys.json"
ENV0="$T/env0"
D6ENV="$T/env1"
SD="$T/state/payout-state.v2"
LOG="$T/envcheck.log"
HELPER_DIR="$OPS/helpers"
mkdir -p "$SD"
printf '%s\n' '{"addresses":[],"sockets":[],"keyArrays":[]}' > "$T/deny one.json"
printf 'CONET_LAB_DENY_LIST_FILE=/synthetic/older-deny.json\n' > "$ENV0"
cat > "$D6ENV" <<EOF
export CONET_LAB_DENY_LIST_FILE="$T/deny one.json"
CONET_LAB_MINING_POOL_CL_PAYOUT=1
CONET_LAB_MINING_POOL_CL_PAYOUT_DRY_RUN=0
CONET_VALIDATOR_DRY_RUN=0
CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_SOCKET=/synthetic/signer.sock
CONET_LAB_MINING_POOL_CL_PAYOUT_KEY_ARRAY=lab_mining_pool_payout
CONET_LAB_MINING_POOL_CL_PAYOUT_SIGNER_ADDRESS=0xcfaf85e6c1765da01a4dc58c81b28cd572067135
CONET_LAB_MINING_POOL_CL_PAYOUT_STATE_FILE=$T/state/payout-state.json
CONET_LAB_MINING_POOL_PUBKEYS_FILE=$T/pubkeys.json
CONET_LAB_MINING_POOL_CL_PAYOUT_CONSUMED_KEYS_MAX=3000000
CONET_LAB_MINING_POOL_CL_PAYOUT_DEPLOY_BLOCK=2009200
CONET_LAB_MINING_POOL_CL_PAYOUT_MAX_GAS_PRICE_GWEI=0.03
CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_WAIT_FORCE_MS=300000
CONET_LAB_MINING_POOL_CL_PAYOUT_GAS_LIMIT=800000
CONET_RPC_URL=https://rpc.fixture.invalid
CONET_VALIDATOR_DEPOSIT_RPC_URL=https://vdr.fixture.invalid
CONET_VALIDATOR_BEACON_REST_URL=https://beacon.fixture.invalid
EOF

DENY_FILE=
if prepare_envcheck_inputs; then
  [ "$DENY_FILE" = "$T/deny one.json" ] && ok "deny path is extracted from merged synthetic env (later file wins)" || bad "merged deny path mismatch"
else bad "synthetic envcheck inputs rejected"; fi
if run_envcheck run; then ok "actual pinned envcheck accepts the fully synthetic run fixture"; else bad "synthetic envcheck positive failed"; fi
if grep -Fq "$T/deny one.json" "$LOG"; then bad "resolved private path leaked to envcheck log"; else ok "resolved deny path is not logged"; fi

cp "$ENV0" "$T/env0.no-deny"
cp "$D6ENV" "$T/env1.no-deny"
grep -v 'CONET_LAB_DENY_LIST_FILE=' "$ENV0" > "$T/env0.no-deny"
grep -v 'CONET_LAB_DENY_LIST_FILE=' "$D6ENV" > "$T/env1.no-deny"
ENV0="$T/env0.no-deny" D6ENV="$T/env1.no-deny"
if prepare_envcheck_inputs; then bad "missing merged deny path is rejected"; else ok "missing merged deny path is rejected"; fi
ENV0="$T/env0" D6ENV="$T/env1"

set +e
LAB_STATE_FILE="$T/state/payout-state.json" /usr/bin/python3 -I "$HELPER_DIR/envcheck.py" --env "$ENV0" --env "$D6ENV" --phase run --pubkeys-sha "$PINNED_PUBKEYS_SHA" > "$T/no-deny.out" 2>&1
NO_DENY_RC=$?
cp "$T/deny one.json" "$T/other-deny.json"
LAB_STATE_FILE="$T/state/payout-state.json" /usr/bin/python3 -I "$HELPER_DIR/envcheck.py" --env "$ENV0" --env "$D6ENV" --phase run --deny "$T/other-deny.json" --pubkeys-sha "$PINNED_PUBKEYS_SHA" > "$T/wrong-deny.out" 2>&1
WRONG_DENY_RC=$?
LAB_STATE_FILE="$T/state/payout-state.json" /usr/bin/python3 -I "$HELPER_DIR/envcheck.py" --env "$ENV0" --env "$D6ENV" --phase run --deny "$T/deny one.json" --pubkeys-sha "$(printf 0%.0s {1..64})" > "$T/wrong-sha.out" 2>&1
WRONG_SHA_RC=$?
set -e
[ "$NO_DENY_RC" -eq 2 ] && grep -q '^usage:' "$T/no-deny.out" && ok "envcheck missing --deny returns usage rc=2" || bad "envcheck missing --deny rc=$NO_DENY_RC"
[ "$WRONG_DENY_RC" -eq 1 ] && grep -q 'deny file path' "$T/wrong-deny.out" && ok "envcheck wrong --deny path fails closed" || bad "envcheck wrong --deny path rc=$WRONG_DENY_RC"
[ "$WRONG_SHA_RC" -eq 1 ] && grep -q 'PUBKEYS_FILE content sha256 == expected' "$T/wrong-sha.out" && ok "envcheck wrong --pubkeys-sha fails closed" || bad "envcheck wrong --pubkeys-sha rc=$WRONG_SHA_RC"

if grep -q '5dc390b0f91ab103\|d00a55f8928521521e5551a3cacc1c16484c0a2c278a124c5e400b62999cf84b' "$C" "$OPS/common.env.sh"; then
  bad "expired production approval ID appears in candidate"
else
  ok "candidate contains no expired production approval ID"
fi
grep -q -- '--deny "\$DENY_FILE" --pubkeys-sha "\$PINNED_PUBKEYS_SHA"' "$C" && ok "candidate binds both required envcheck arguments" || bad "candidate lacks a required envcheck argument"
awk '/^swap-start\)/,/^\*\)/' "$C" | awk '/copy_approval_preflight/{a=NR} /envcheck_preflight/{e=NR} /\$SUDO install .*conf.rendered/{m=NR} END{exit (a&&e&&m&&a<e&&e<m)?0:1}' && ok "approval and envcheck preflight precede drop-in mutation" || bad "preflight is not before the drop-in mutation"
awk '/^stop\)/,/^swap-start\)/' "$C" | awk '/copy_approval_preflight/{a=NR} /\$SUDO systemctl stop/{m=NR} END{exit (a&&m&&a<m)?0:1}' && ok "stop phase checks approval before systemctl stop" || bad "stop approval preflight order"

[ "$FAILS" -eq 0 ] && { echo START_PREFLIGHT_SELFTEST_OK; exit 0; }
echo START_PREFLIGHT_SELFTEST_FAILED=$FAILS
exit 1

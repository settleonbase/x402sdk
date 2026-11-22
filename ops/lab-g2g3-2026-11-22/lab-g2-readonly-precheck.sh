#!/bin/bash
# G2 pre-check, READ ONLY (v2, revised after review 61a82693; NOT EXECUTED): nothing is written except files under $W. Run on the host as the operator account before the window; prints PRECHECK_OK or the first failing item.
# It proves, before G2/G3: (a) the toolchain on the target host reproduces the df78e6b dist (189 files, manifest 52fe9a47...) - so a 216-file difference later is the candidate, not the toolchain; (b) the current Lab files and
# environment are what the page says; (c) the RPC and payment gates (publicrpc AND rpc1 both answer, >=3 flush cycles with a successful payment); (d) disk and memory for the chosen rollback heap tier.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); . "$HERE/common.env.sh"
fail(){ echo "PRECHECK_FAIL: $*"; exit 1; }
rpc(){ curl -s -m 15 -H 'content-type: application/json' -d "$2" "$1"; }
res(){ sed -E 's/.*"result": *"?([^",}]*)"?.*/\1/'; }
SV=$(site_verify) || fail "site configuration: $SV"
test "$(id -un)" = "$OPERATOR_USER" || fail "run as the operator account"
HV=$(helpers_verify) || fail "helper scripts are not the pinned reviewed ones (v4): $HV"
test "$(/usr/bin/node --version)" = v22.22.1 || fail "node version"
test "$(/usr/bin/npm --version)" = 9.2.0 || fail "npm version"
# (a) toolchain reproducibility: the RUNNING df78e6b dist, listed the way the page says, must be the reviewed 189 files / 52fe9a47...
(cd "$REL_OLD/dist" && $SUDO find . -type f | LC_ALL=C sort | $SUDO xargs sha256sum) > "$W/dist-df78e6b-running.sha256" || fail "cannot list the running dist"
test "$(wc -l < "$W/dist-df78e6b-running.sha256" | tr -d ' ')" -eq $OLD_DIST_FILES || fail "running dist file count is not $OLD_DIST_FILES"
test "$(sha256sum "$W/dist-df78e6b-running.sha256" | cut -d' ' -f1)" = "$OLD_DIST_SHA" || fail "running dist manifest is not $OLD_DIST_SHA (the toolchain or the running build differs from the reviewer's: find out why BEFORE G2)"
# (a2) GitHub reachability for the build step (anonymous HTTPS ls-remote of the candidate branch; npm registry answers)
git ls-remote "$REPO" refs/heads/lab/0160a08-merged 2>/dev/null | grep -q "^$REV" || fail "GitHub does not show $REV on lab/0160a08-merged (anonymous https ls-remote)"
[ "$(curl -s -o /dev/null -m 15 -w '%{http_code}' https://registry.npmjs.org/ethers)" = 200 ] || fail "npm registry does not answer 200"
# (b) current files and environment
test "$($SUDO sha256sum /etc/systemd/system/$DUNIT | cut -c1-64)" = "$UNIT_SHA" || fail "base unit hash"
test "$($SUDO sha256sum $OLD_DROP | cut -c1-64)" = "$OLD_DROP_SHA" || fail "current 90 drop-in hash"
test "$($SUDO sha256sum $DROPDIR/$DROPIN_A_NAME | cut -c1-64)" = "$D91_SHA" || fail "91"
test "$($SUDO sha256sum $DROPDIR/$DROPIN_B_NAME | cut -c1-64)" = "$D92_SHA" || fail "92"
test "$($SUDO sha256sum $DROPDIR/$DROPIN_C_NAME | cut -c1-64)" = "$D93_SHA" || fail "93"
test "$($SUDO sha256sum $D6ENV | cut -c1-64)" = "$ENV_SHA" || fail "Lab env file hash"
test ! -e $DROPDIR/94-lab-0160a085-wal.conf || fail "the new 94 drop-in already exists"
$SUDO sh -c "[ ! -e '$SD/wal' ]" || fail "a wal directory already exists: this is not the first WAL start (B3: tested through sudo, the directory is 0700)"
P=$(systemctl show $DUNIT -p MainPID --value); ENVNAMES=$($SUDO sh -c "tr '\0' '\n' </proc/$P/environ" | sed 's/=.*//')
echo "$ENVNAMES" | grep -E '^(NODE_OPTIONS|CONET_LAB_MINING_POOL_CL_PAYOUT_(WAL|DECOUPLED|POOLS_FILE|TICK_MODE))$' && fail "the running process already has one of NODE_OPTIONS/WAL/DECOUPLED/POOLS_FILE/TICK_MODE"
systemctl show $DUNIT -p NeedDaemonReload --value | grep -q '^no$' || fail "NeedDaemonReload"
gate_run precheck || fail "gate-value-ro: not exactly GATE_OK with INFLIGHT=no (B1: see $W/gate-precheck.txt)"
$SUDO /usr/bin/python3 -I "$HELPER_DIR/verify-state-digests-ro.py" $SD 2>&1 | grep -qx 'RESULT ALL_DIGESTS_OK' || fail "verify-state-digests-ro is not RESULT ALL_DIGESTS_OK"
MJ=$(manifest_json) || fail "manifest fields unreadable (B2): $MJ"
[ "$(mf "$MJ" version)" = 2 ] || fail "manifest is not version 2"
echo "manifest now: $MJ"
$SUDO node -e 'process.exit(0)' || fail "sudo node does not work for the operator account (B3)"
# the OLD reader reads the current state (the baseline for the L2 conversion and its rollback)
readv2_ro > "$W/readv2-before.json" || fail "readv2 (old reader, through sudo: B3) does not read the current state"
grep -q '"ok":true' "$W/readv2-before.json" || fail "readv2 not ok"
# (c) RPC and payment gates (ADDENDUM-1 s5): publicrpc AND rpc1 answer, heads within 2 blocks, twice 30 s apart; >=3 flush cycles in a row with a successful payment
for round in 1 2; do
  A=$(printf '%d' $(rpc $PUB '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | res)) || fail "publicrpc"
  B=$(printf '%d' $(rpc $PUB2 '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | res)) || fail "rpc1"
  [ "$(rpc $PUB '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | res)" = 0x36ca6 ] || fail "publicrpc chainId"
  [ "$(rpc $PUB2 '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | res)" = 0x36ca6 ] || fail "rpc1 chainId"
  D=$((A-B)); [ ${D#-} -le 2 ] || fail "publicrpc/rpc1 heads differ by $D"
  echo "rpc round $round: publicrpc=$A rpc1=$B"; [ $round -eq 1 ] && sleep 30
done
FS=$($SUDO journalctl -u $DUNIT --since "-40min" --utc --no-pager -o cat | grep -c 'flush-summary')
OKS=$($SUDO journalctl -u $DUNIT --since "-40min" --utc --no-pager -o cat | grep 'flush-summary' | tail -3 | grep -cE 'settledEntries=[1-9]|settled=[1-9]|paidBatches=[1-9]')
echo "flush-summary lines in the last 40 min: $FS; of the last 3 with a payment: $OKS"
[ "$FS" -ge 3 ] && [ "$OKS" -eq 3 ] || fail "the last 3 flush cycles do not all have a successful payment (read the journal by hand if the field names differ)"
$SUDO journalctl -u $DUNIT --since "-40min" --utc --no-pager -o cat | grep -E 'ALERT|HALT|tick error' | tail -3 | grep -q . && fail "ALERT/HALT/tick error in the last 40 min"
# (d) disk and memory
test "$(df -Pk /opt | awk 'NR==2 {print $4}')" -ge 4194304 || fail "/opt free < 4 GiB"
test "$(df -Pk /var/tmp | awk 'NR==2 {print $4}')" -ge 2097152 || fail "/var/tmp free < 2 GiB"
GEN=$(mf "$MJ" generation)
GENKB=$($SUDO du -sk "$SD/$GEN" | cut -f1); echo "current generation $GEN = ${GENKB} KB"
test "$(df -Pk /var/tmp | awk 'NR==2 {print $4}')" -ge $((GENKB*4)) || fail "/var/tmp free < 4x the current generation (the pre-WAL copy of this + the previous generation, with headroom)"
AVAIL=$(awk '/MemAvailable/ {print $2}' /proc/meminfo); echo "MemAvailable ${AVAIL} KB"
NEED=$(( ${HEAP_TIER_MB:-2048} * 13 / 10 * 1024 + 600*1024 )); echo "rollback heap tier ${HEAP_TIER_MB:-2048} MB -> need MemAvailable >= ${NEED} KB"
[ "$AVAIL" -ge "$NEED" ] || fail "MemAvailable below 1.3x the rollback heap tier (+ runtime)"
echo "PRECHECK_OK $(date -u +%FT%TZ) rev-target=$REV"

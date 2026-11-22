#!/bin/bash
# G3 CUTOVER v4 (EXECUTION on the target host; revised after reviews 61a82693, 98e19b2b and e9d2305c and the PM rulings; NOT EXECUTED; needs the project owner's G3 approval and the PM's written RELEASE).
# ONE restart of the Lab payout unit, df78e6b -> 0160a085 with NODE_OPTIONS=--max-old-space-size=1536 and WAL=1 (the first WAL start converts the version 2 state to version 3, one way). Only the Lab unit is
# stopped and started. Signer, Claim, Geth, Beacon, oracle, RPC routing, env files and policy are not touched.
# Two phases, because a human check sits between them:
#   lab-g3-cutover.sh stop         static checks, read-only pre-check, dry run of the old reader, wait for an oracle-safe flush window, graceful stop, post-stop gate, S1 data.   Lab is DOWN afterwards.
#   (manual)                       the field checks the S1 identity and the last payments, then writes $W/S1-OK in the STRICT one-line format
#                                  `S1-OK by=<name> at=<UTC ISO8601> result=OK consumed_delta=<n> settled_delta=<n> payments=<n>`; swap-start accepts nothing else and compares the three numbers with S1-DATA.env (written by `stop`).
#                                  `stop` deletes an old S1-OK first, so a record of an earlier round can never be reused.
#   lab-g3-cutover.sh swap-start   drop-in swap, read-backs, re-judge the oracle gate (wait if needed), start, conversion checks.
#   lab-g3-cutover.sh resume-check read-only: after a `stop` that ended in place only because a post-stop read was transiently not green: repeats ALL the post-stop checks and, only if every one is green, writes the post-stop record
#                                  ($W/m_stop.json, S1-DATA.*); it changes nothing else (no start, no stop, no swap).
#   lab-g3-cutover.sh status       read-only: unit, manifest fields, gate.
# DEVIATIONS from the reviewed stop SOP (s6), accepted by the PM (NOTE-pm-lab-g3-scripts-review-rulings-2026-11-22): there is NO stop_switch (the switch is not flipped, the Lab env file is not changed: one less production edit
# and one less thing to forget to flip back; the unit has Restart=no); if wanted, stop_switch can be done by hand BEFORE `stop`. Everything else of s6 is kept: the unit's own graceful stop is awaited (no second stop,
# no kill -9), then nonce + last transactions + manifest are read.
# FAILURE RULE (B4): after the stop, ANY failure STOPS IN PLACE and reports (unresolved in-flight, unclean stop, unreadable state, a gate that is not exactly GATE_OK ...). Nothing restarts df78e6b by itself in those
# cases: the signer is checked first and nothing is resent. The ONLY automatic path back is `rollback_plain`: the state is proven to still be a plain version 2 state (manifest version 2, no wal directory, gate exactly
# GATE_OK with INFLIGHT=no, old reader reads it) and the failure happened before the WAL start converted anything. A version 3 state is never rolled back by this script (graceful downgrade / offline tool need the
# PM's written approval number).
# COPY: the read-only pre-WAL copy runs only with COPY_APPROVED=yes AND a non-empty COPY_APPROVAL_ID (logged); it is not a rollback path.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); . "$HERE/common.env.sh"
SV=$(site_verify) || { echo "site configuration: $SV" >&2; exit 1; }
CMD=${1:-}; LOG=$W/g3-cutover.log
log(){ echo "$(date -u +%T.%N | cut -c1-12) $*" | tee -a "$LOG"; }
seg(){ log "SEGMENT $1 took $(( $(date +%s) - $2 )) s"; echo "$1 $(( $(date +%s) - $2 ))" >> "$W/timings.txt"; }
rpc(){ curl -s -m 15 -H 'content-type: application/json' -d "$2" "$1"; }
REPORTED=0
in_place(){ REPORTED=1; log "STOPPED IN PLACE: $*"; log "STATE: unit=$(systemctl is-active $DUNIT) NRestarts=$(systemctl show $DUNIT -p NRestarts --value) manifest=$(manifest_json 2>&1 | tail -1)"; log "Nothing was restarted, nothing resent. Check the signer first (nonce, last transactions), then report to the PM. Offline rollback needs the PM's written approval."; exit 2; }
on_exit(){ rc=$?; if [ $rc -ne 0 ] && [ $REPORTED -eq 0 ]; then log "ABNORMAL EXIT rc=$rc (interrupt or unexpected error): unit=$(systemctl is-active $DUNIT 2>&1); if the unit is stopped it STAYS stopped; state: $(manifest_json 2>&1 | tail -1)"; fi; }
trap on_exit EXIT; trap 'REPORTED=0; exit 130' INT TERM HUP
die_pre(){ REPORTED=1; log "ABORT (nothing changed): $*"; log "STATE: unit=$(systemctl is-active $DUNIT)"; exit 1; }
plain_v2_ok(){ # proof that the state is still a plain version 2 state AND clean: used by rollback_plain only
  local mj; mj=$(manifest_json) || return 1
  [ "$(mf "$mj" version)" = 2 ] || return 1
  [ "$(mf "$mj" wal)" = False ] || return 1
  gate_run rollback || return 1
  readv2_ro > "$W/readv2-rollback.json" || return 1
  grep -q '"ok":true' "$W/readv2-rollback.json"
}
rollback_plain(){ # df78e6b again; ONLY when plain_v2_ok. Never for a version 3 state.
  log "ROLLBACK_PLAIN requested: $*"
  plain_v2_ok || in_place "rollback_plain refused: the state is not provably a clean plain version 2 state ($*)"
  $SUDO rm -f $NEW_DROP $NEW_ENV_DROP
  [ -f $OLD_DROP ] || $SUDO install -m 0644 -o root -g root "$W/90-lab-df78e6b-release.conf.rollback" $OLD_DROP
  [ "$($SUDO sha256sum $OLD_DROP | cut -c1-64)" = "$OLD_DROP_SHA" ] || in_place "rollback_plain: old drop-in hash"
  $SUDO systemctl daemon-reload; $SUDO systemctl start $DUNIT
  for i in $(seq 1 30); do sleep 2; systemctl is-active $DUNIT | grep -q '^active$' && break; done
  local p cw; p=$(systemctl show $DUNIT -p MainPID --value); cw=$($SUDO readlink /proc/$p/cwd 2>/dev/null)
  log "ROLLBACK_PLAIN STATE: active=$(systemctl is-active $DUNIT) cwd=$cw manifest=$(manifest_json 2>&1 | tail -1)"
  [ "$cw" = "$REL_OLD" ] && systemctl is-active $DUNIT | grep -q '^active$' || in_place "rollback_plain not confirmed"
  REPORTED=1; log "ROLLED BACK to df78e6b (plain version 2 state); report to the PM"; exit 3
}
# ---- failure router after the stop: before anything was converted AND provably plain => rollback_plain; everything else => in place
fail_after_stop(){ if [ "${CONVERT_STARTED:-0}" -eq 0 ]; then rollback_plain "$*"; fi
  # the WAL start was issued: decide by the ACTUAL state, never by a flag
  local mj; mj=$(manifest_json 2>&1 | tail -1)
  if { [ "$(systemctl is-active $DUNIT)" = inactive ] || [ "$(systemctl is-active $DUNIT)" = failed ]; } && [ "$(mf "$mj" version 2>/dev/null)" = 2 ] && [ "$(mf "$mj" wal 2>/dev/null)" = False ]; then rollback_plain "start failed before any conversion: $*"; fi
  in_place "$*"; }

static_checks(){
  HV=$(helpers_verify) || die_pre "helper scripts are not the pinned reviewed ones: $HV"
  [ "$($SUDO sha256sum /etc/systemd/system/$DUNIT | cut -c1-64)" = "$UNIT_SHA" ] || die_pre "base unit hash"
  [ "$($SUDO sha256sum $OLD_DROP | cut -c1-64)" = "$OLD_DROP_SHA" ] || die_pre "df78e6b drop-in hash"
  [ "$($SUDO sha256sum $D6ENV | cut -c1-64)" = "$ENV_SHA" ] || die_pre "Lab env file hash"
  [ "$($SUDO git -c safe.directory='*' -C $REL_NEW rev-parse HEAD)" = "$REV" ] || die_pre "new release HEAD"
  [ "$($SUDO sha256sum $REL_NEW/dist.sha256 | cut -c1-64)" = "$DIST_SHA" ] || die_pre "new release dist manifest hash"
  # the dist must be EXACTLY the 216 reviewed files: regenerate the list from the directory (extra files are found too) and compare with the expected manifest
  ( cd $REL_NEW/dist && $SUDO find . -type f | LC_ALL=C sort | $SUDO xargs sha256sum ) > "$W/dist-new-actual.sha256" 2>/dev/null
  [ "$(wc -l < "$W/dist-new-actual.sha256" | tr -d ' ')" -eq $DIST_FILES ] || die_pre "new release dist has $(wc -l < "$W/dist-new-actual.sha256" | tr -d ' ') files, not $DIST_FILES"
  [ "$(sha256sum "$W/dist-new-actual.sha256" | cut -c1-64)" = "$DIST_SHA" ] || die_pre "new release dist listing is not the reviewed manifest (extra, missing or changed file)"
  RD=$(render_dropins "$W") || die_pre "drop-ins: $RD"   # the 90 drop-in is rendered from the repo template for THIS host and must equal the reviewed hash; 94 must equal its reviewed hash
  [ "$(systemctl show $DUNIT -p WorkingDirectory --value)" = "$REL_OLD" ] || die_pre "running WorkingDirectory is not the df78e6b release"
  systemctl show $DUNIT -p NeedDaemonReload --value | grep -q '^no$' || die_pre "NeedDaemonReload not no"
  $SUDO sh -c "[ ! -e $SD/wal ]" || die_pre "wal directory exists"
}
poststop_checks() { # $1 = failure handler: in_place (the stop phase) or die_resume (resume-check: report and change nothing)
  FAIL=$1
  M_PRE=$(cat "$W/m_pre.json"); T_STOP_ISO=$(cat "$W/t_stop.txt")
  # s6 after the stop: nonce == confirmed batch count, no in-flight (B1: exactly GATE_OK), manifest, state identity, old reader (B3: through sudo)
  gate_run poststop || $FAIL "gate after the stop is not exactly GATE_OK with INFLIGHT=no: unresolved in-flight or nonce != count: $(printf '%s\n' "$GATE_OUT" | tail -3 | tr '\n' ' ')"; printf '%s\n' "$GATE_OUT" | tail -3 | tee -a "$LOG"
  M_STOP=$(manifest_json) || $FAIL "manifest unreadable after the stop: $M_STOP"; log "manifest after stop: $M_STOP"
  $SUDO /usr/bin/python3 -I "$HELPER_DIR/verify-state-digests-ro.py" $SD > "$W/digests-poststop.txt" 2>&1; grep -qx 'RESULT ALL_DIGESTS_OK' "$W/digests-poststop.txt" || $FAIL "state digests after the stop are not ALL_DIGESTS_OK"
  readv2_ro > "$W/readv2-stopped.json" || $FAIL "the old reader cannot read the state after the stop"; grep -q '"ok":true' "$W/readv2-stopped.json" || $FAIL "readv2 not ok after the stop"
  [ "$(mf "$M_STOP" version)" = 2 ] && [ "$(mf "$M_STOP" wal)" = False ] || $FAIL "the state after the stop is not a plain version 2 state"
  NPAY=$($SUDO journalctl -u $DUNIT --since "$T_STOP_ISO" --utc --no-pager -o cat | grep -c 'withdrawNative ok')
  {
    echo "S1 DATA (manual check, ruling 2: S1 identity is a human check; mismatch = stay stopped and report)"
    echo "manifest pre : $(cat "$W/m_pre.json")"; echo "manifest stop: $M_STOP"
    echo "consumed.lines delta (stop - pre): $(( $(mf "$M_STOP" consumed) - $(mf "$M_PRE" consumed) ))   settledBatchCount delta: $(( $(mf "$M_STOP" settled) - $(mf "$M_PRE" settled) ))"
    echo "withdrawNative ok lines since t_stop ($T_STOP_ISO): $NPAY"
    echo "next: check the payments of the drain window with lab-pool-beneficiary-check.py, check S1 (consumed.lines delta of F keys = 100 x batches + T delta), then write $W/S1-OK (who, when, result) and run: swap-start"
  } | tee "$W/S1-DATA.txt" | tee -a "$LOG"
  printf 'consumed_delta=%s\nsettled_delta=%s\npayments=%s\n' "$(( $(mf "$M_STOP" consumed) - $(mf "$M_PRE" consumed) ))" "$(( $(mf "$M_STOP" settled) - $(mf "$M_PRE" settled) ))" "$NPAY" > "$W/S1-DATA.env"
  echo "$M_STOP" > "$W/m_stop.json"   # written LAST: only a fully green post-stop check leaves a record that swap-start can use
}
die_resume(){ REPORTED=1; log "RESUME-CHECK NOT GREEN (nothing changed, nothing recorded): $*"; exit 1; }
lastsum(){ $SUDO journalctl -u $DUNIT --since "-15min" --utc --no-pager -o short-iso | grep 'flush-summary' | tail -1 | cut -c1-25; }

case "$CMD" in
resume-check)
  HV=$(helpers_verify) || die_resume "helper scripts are not the pinned reviewed ones (R2): $HV"
  [ -s "$W/m_pre.json" ] && [ -s "$W/t_stop.txt" ] || die_resume "no m_pre.json / t_stop.txt: no stop of this round to resume"
  [ ! -s "$W/S1-OK" ] || die_resume "S1-OK already exists"
  [ "$(systemctl is-active $DUNIT)" = inactive ] || die_resume "the unit is $(systemctl is-active $DUNIT), not inactive"
  stop_record_ok "$W/stop-fingerprint.txt" || die_resume "$STOPREC_MSG"
  poststop_checks die_resume
  REPORTED=1; log "RESUME-CHECK GREEN: the post-stop record is written ($W/m_stop.json, S1-DATA.*). Now the manual S1 check, then S1-OK, then swap-start."; exit 0;;
status)
  echo "unit=$(systemctl is-active $DUNIT) NRestarts=$(systemctl show $DUNIT -p NRestarts --value)"; manifest_json; gate_run status; echo "$GATE_OUT" | tail -4; exit 0;;
stop)
  : > "$LOG"; : > "$W/timings.txt"; T_ALL=$(date +%s)
  rm -f "$W/S1-OK" "$W/S1-DATA.txt" "$W/S1-DATA.env" "$W/m_stop.json" "$W/m_pre.json" "$W/t_stop.txt" "$W/stop-fingerprint.txt"   # C1: nothing of an earlier round survives into this one
  log "START g3 cutover phase STOP rev=$REV"
  T0=$(date +%s); static_checks; seg static-checks $T0
  # the read-only pre-check must be green right now (RPC stability, >=3 flush cycles with payments, disk, memory; it also dry-runs the old reader through sudo: B3)
  T0=$(date +%s); bash "$HERE/lab-g2-readonly-precheck.sh" 2>&1 | tee -a "$LOG" | tail -3 | grep -q '^PRECHECK_OK' || die_pre "the read-only pre-check is not green"; seg precheck $T0
  # B3: dry run of the old reader BEFORE the stop: if it cannot read the state (permissions), nothing is stopped
  readv2_ro > "$W/readv2-dryrun.json" || die_pre "dry run: the old reader (through sudo) cannot read the state: $(cut -c1-200 "$W/readv2-dryrun.json")"; grep -q '"ok":true' "$W/readv2-dryrun.json" || die_pre "dry run: old reader not ok"
  M_PRE=$(manifest_json) || die_pre "manifest fields unreadable before the stop: $M_PRE"; echo "$M_PRE" > "$W/m_pre.json"; log "manifest pre: $M_PRE"
  # wait for a flush-summary in an oracle-safe window
  T0=$(date +%s); S0=$(lastsum); log "last flush-summary at start: $S0"; TRIES=0; SECONDS=0
  while :; do
    S1=$(lastsum)
    if [ -n "$S1" ] && [ "$S1" != "$S0" ]; then
      log "new flush-summary at $S1"
      if oracle_gate_ok; then log "$ORACLE_LINE"; break; else log "$ORACLE_LINE: too close, wait for the next cycle"; S0=$S1; TRIES=$((TRIES+1)); [ $TRIES -ge 4 ] && die_pre "no oracle-safe window in 4 cycles"; fi
    fi
    sleep 2; [ $SECONDS -lt 1500 ] || die_pre "waited 25 min for an oracle-safe flush-summary window"
  done; seg wait-window $T0
  log "PRE-FLIGHT"
  gate_run preflight || die_pre "gate before the stop is not exactly GATE_OK with INFLIGHT=no (see $W/gate-preflight.txt): $(printf '%s\n' "$GATE_OUT" | tail -2 | tr '\n' ' ')"; printf '%s\n' "$GATE_OUT" | tail -3 | tee -a "$LOG"
  { systemctl show $SIGNER_UNIT -p MainPID,InvocationID,NRestarts --no-pager | tr '\n' ' '; echo; } > "$W/signer-pre.txt"; { systemctl show $CLAIM_UNIT -p MainPID,InvocationID,NRestarts --no-pager | tr '\n' ' '; echo; } > "$W/claim-pre.txt"
  log "signer pre: $(cat "$W/signer-pre.txt")"; log "claim pre: $(cat "$W/claim-pre.txt")"
  $SUDO cp -p $OLD_DROP "$W/90-lab-df78e6b-release.conf.rollback"; [ "$($SUDO sha256sum "$W/90-lab-df78e6b-release.conf.rollback" | cut -c1-64)" = "$OLD_DROP_SHA" ] || die_pre "rollback copy hash"
  # graceful stop: the unit's own stop is awaited; no second stop, no kill -9
  T0=$(date +%s); T_STOP_ISO=$(date -u +%FT%TZ); echo "$T_STOP_ISO" > "$W/t_stop.txt"; log "STOP unit (graceful, draining; no stop_switch: accepted deviation)"
  $SUDO systemctl stop $DUNIT; RC=$?; seg graceful-stop $T0
  log "stop rc=$RC Result=$(systemctl show $DUNIT -p Result --value) active=$(systemctl is-active $DUNIT)"
  [ "$(systemctl show $DUNIT -p Result --value)" = success ] && [ "$(systemctl is-active $DUNIT)" != active ] && [ $RC -eq 0 ] || in_place "the stop was not clean (rc=$RC, Result not success): nothing was stopped twice, nothing restarted"
  unit_fingerprint > "$W/stop-fingerprint.txt"; log "stop record: $(cat "$W/stop-fingerprint.txt")"   # R1: only a CLEAN stop leaves this file; resume-check and swap-start refuse without it
  poststop_checks in_place
  seg phase-stop-total $T_ALL; REPORTED=1
  log "PHASE STOP DONE: Lab is STOPPED. Lab pays nothing until swap-start (or a decision to restart df78e6b by hand after the signer check)."; exit 0;;
swap-start)
  T_ALL=$(date +%s); log "START g3 cutover phase SWAP-START"
  HV=$(helpers_verify) || die_pre "helper scripts are not the pinned reviewed ones (R2): $HV"
  [ -s "$W/S1-OK" ] && [ -s "$W/S1-DATA.env" ] || die_pre "no $W/S1-OK or no S1-DATA.env: the manual S1 check is not recorded (ruling 2)"
  # C1: strict format, one line, result=OK, and the three numbers equal the ones `stop` measured; anything else (e.g. 'MISMATCH ... do not proceed') never converts
  s1_ok_check "$W/S1-OK" "$W/S1-DATA.env" || die_pre "$S1_MSG; nothing was converted"
  S1OK=$(head -1 "$W/S1-OK")
  log "S1-OK accepted: $S1OK"
  [ "$(systemctl is-active $DUNIT)" != active ] || die_pre "the unit is active: run stop first"
  stop_record_ok "$W/stop-fingerprint.txt" || die_pre "$STOPREC_MSG"
  # the state must be exactly what it was after the stop
  M_NOW=$(manifest_json) || in_place "manifest unreadable before the swap: $M_NOW"; [ "$M_NOW" = "$(cat "$W/m_stop.json")" ] || in_place "the state changed since the stop (stop: $(cat "$W/m_stop.json") now: $M_NOW)"
  gate_run preswap || in_place "gate before the swap is not exactly GATE_OK with INFLIGHT=no: $(printf '%s\n' "$GATE_OUT" | tail -2 | tr '\n' ' ')"
  M_STOP=$M_NOW; NP=$(mf "$M_STOP" pending); NC=$(mf "$M_STOP" consumed)
  CONVERT_STARTED=0
  # optional read-only copy of the current state (second insurance, NOT a rollback path)
  if [ "${COPY_APPROVED:-no}" = yes ]; then
    [ -n "${COPY_APPROVAL_ID:-}" ] || in_place "COPY_APPROVED=yes without COPY_APPROVAL_ID"
    T0=$(date +%s); CP=/var/tmp/lab-v2-pre-wal-$(date -u +%Y%m%dT%H%M%SZ); log "pre-WAL copy approved by: $COPY_APPROVAL_ID -> $CP"
    GEN=$(mf "$M_STOP" generation); PREV=$(mf "$M_STOP" previousGeneration)
    $SUDO install -d -m 0700 -o "$OPERATOR_USER" -g "$OPERATOR_USER" $CP
    $SUDO cp -a $SD/manifest.json $CP/ && $SUDO cp -a $SD/$GEN $CP/ && { [ -z "$PREV" ] || $SUDO cp -a $SD/$PREV $CP/; } || fail_after_stop "pre-WAL copy failed"
    $SUDO chown -R "$OPERATOR_USER:$OPERATOR_USER" $CP; chmod -R go-rwx $CP; chmod -R a-w $CP
    (cd $CP && find . -type f | LC_ALL=C sort | xargs sha256sum | sed 's#  \./#  #') > "$W/pre-wal-copy.sha256"
    (cd $SD && $SUDO sh -c "sha256sum manifest.json $GEN/* ${PREV:+$PREV/*}") | LC_ALL=C sort -k2 > "$W/pre-wal-source.sha256"
    LC_ALL=C sort -k2 "$W/pre-wal-copy.sha256" | diff - "$W/pre-wal-source.sha256" > "$W/pre-wal-diff.txt" || fail_after_stop "pre-WAL copy differs from the source (see pre-wal-diff.txt)"
    $SUDO /usr/bin/python3 -I "$HELPER_DIR/verify-state-digests-ro.py" $CP > "$W/digests-copy.txt" 2>&1; grep -qx 'RESULT ALL_DIGESTS_OK' "$W/digests-copy.txt" || fail_after_stop "verify-state-digests-ro on the copy is not ALL_DIGESTS_OK"
    log "pre-WAL copy done: files=$(wc -l < "$W/pre-wal-copy.sha256") bytes=$(du -sb $CP | cut -f1)"; seg copy $T0
  else log "pre-WAL copy SKIPPED (COPY_APPROVED not set to yes): rollback relies on the graceful downgrade and the offline tool only"; fi
  # drop-in swap and read-backs (the state is still plain version 2 here: a failure may roll back, B4 rule)
  T0=$(date +%s); log "DROP-IN SWAP (90 -> new release, 94 -> NODE_OPTIONS + WAL=1)"
  RD=$(render_dropins "$W") || fail_after_stop "drop-ins (rendered again right before the install): $RD"
  $SUDO install -m 0644 -o root -g root "$W/90-lab-0160a085-release.conf.rendered" $NEW_DROP && $SUDO install -m 0644 -o root -g root "$W/94-lab-0160a085-wal.conf" $NEW_ENV_DROP || fail_after_stop "install of the new drop-ins"
  $SUDO mv $OLD_DROP "$W/90-lab-df78e6b-release.conf.removed-$$" || fail_after_stop "could not move the old drop-in out"
  $SUDO systemd-analyze verify /etc/systemd/system/$DUNIT >> "$LOG" 2>&1 || fail_after_stop "systemd-analyze verify"
  $SUDO systemctl daemon-reload
  systemctl show $DUNIT -p WorkingDirectory,MemoryMax,MemorySwapMax,OOMScoreAdjust,Environment,NeedDaemonReload --no-pager | tee -a "$LOG"
  [ "$(systemctl show $DUNIT -p WorkingDirectory --value)" = "$REL_NEW" ] || fail_after_stop "WorkingDirectory readback"
  [ "$(systemctl show $DUNIT -p MemoryMax --value)" = 3221225472 ] && [ "$(systemctl show $DUNIT -p MemorySwapMax --value)" = 0 ] && [ "$(systemctl show $DUNIT -p OOMScoreAdjust --value)" = 500 ] || fail_after_stop "memory settings readback"
  systemctl show $DUNIT -p Environment --value | tr ' ' '\n' | grep -qx 'NODE_OPTIONS=--max-old-space-size=1536' || fail_after_stop "NODE_OPTIONS readback"
  systemctl show $DUNIT -p Environment --value | tr ' ' '\n' | grep -qx 'CONET_LAB_MINING_POOL_CL_PAYOUT_WAL=1' || fail_after_stop "WAL readback"
  [ "$($SUDO sha256sum $D6ENV | cut -c1-64)" = "$ENV_SHA" ] || fail_after_stop "Lab env file changed"
  $SUDO env LAB_STATE_FILE="$(dirname "$SD")/payout-state.json" /usr/bin/python3 -I "$HELPER_DIR/envcheck.py" --env "$ENV0" --env "$D6ENV" --phase run 2>&1 | tail -2 | tee -a "$LOG" | grep -q ENVCHECK_OK || fail_after_stop "envcheck run"
  LAB_SIGNER_UNIT="$SIGNER_UNIT" LAB_CLAIM_UNIT="$CLAIM_UNIT" /usr/bin/python3 -I "$HELPER_DIR/gatecheck.py" --mem-floor-kb 3072000 --signer-restarts 0 --claim-restarts 0 2>&1 | tail -2 | tee -a "$LOG" | grep -q LABRUN_OK || fail_after_stop "gatecheck"
  /usr/bin/python3 -I "$HELPER_DIR/beaconhealth.py" --beacon "$BEACON_URL" 2>&1 | tail -1 | tee -a "$LOG" | grep -q BEACON_OK || fail_after_stop "beaconhealth"
  seg dropin-swap-and-readbacks $T0
  # ruling 3: re-judge the oracle gate right before the start; if the next oracle run is closer than 120 s (or one is running / just ran), wait for it to finish and pass its margin; Lab pays nothing meanwhile
  T0=$(date +%s); WAITS=0
  while ! oracle_gate_ok; do log "$ORACLE_LINE: not safe to start, waiting (Lab stays stopped)"; sleep 5; WAITS=$((WAITS+1)); [ $WAITS -le 360 ] || { log "ALERT: waited 30 min for an oracle-safe start moment (the oracle runs every 10 minutes: this is abnormal)"; in_place "no oracle-safe start moment in 30 min: staying stopped, NOT restarting df78e6b; the field decides"; }; done
  log "$ORACLE_LINE: safe to start"; seg oracle-gate-wait $T0
  # last look before the start: the helpers are still the pinned ones (R2), the state is still exactly the stopped one and the gate is exactly GATE_OK
  HV=$(helpers_verify) || fail_after_stop "helper scripts changed since the checks started (R2): $HV"
  [ "$(manifest_json)" = "$M_STOP" ] || fail_after_stop "the state changed between the stop and the start"
  gate_run prestart --expect-count "$(mf "$M_STOP" settled)" || fail_after_stop "gate before the start is not exactly GATE_OK with INFLIGHT=no"
  T_START=$(date -u +%FT%TZ); echo "$T_START" > "$W/t_start.txt"; T0=$(date +%s); log "START unit at $T_START"
  CONVERT_STARTED=1; $SUDO systemctl start $DUNIT; log "start rc=$?"
  # B-poll instead of a fixed sleep: wait up to 120 s for the conversion line while the process is alive
  CONVLINE=""; for i in $(seq 1 60); do
    sleep 2
    systemctl is-active $DUNIT | grep -q '^active$' || break
    CONVLINE=$($SUDO journalctl -u $DUNIT --since "$T_START" --utc --no-pager -o short-iso | grep 'the version 2 snapshot was converted to a version 3 snapshot before the first event' | head -1)
    [ -n "$CONVLINE" ] && break
  done
  seg start-to-conversion $T0
  systemctl show $DUNIT -p ActiveState,SubState,MainPID,InvocationID,NRestarts --no-pager | tr '\n' ' ' | tee -a "$LOG"; echo | tee -a "$LOG"
  systemctl is-active $DUNIT | grep -q '^active$' || fail_after_stop "the unit is not active after the start (it exited): $($SUDO journalctl -u $DUNIT --since "$T_START" --utc --no-pager -o cat | grep -E 'refused|ALERT|Error' | tail -2 | cut -c1-200)"
  [ -n "$CONVLINE" ] || fail_after_stop "conversion line did not appear within 120 s (the process is still alive: NOT stopped, state may be converting)"
  P=$(systemctl show $DUNIT -p MainPID --value); CW=$($SUDO readlink /proc/$P/cwd); log "process cwd: $CW"; [ "$CW" = "$REL_NEW" ] || fail_after_stop "process cwd is not the new release"
  echo "$CONVLINE" | awk '{print $1}' > "$W/t_conv.txt"; log "T_CONV line: $(echo "$CONVLINE" | cut -c1-200)"
  JL=$($SUDO journalctl -u $DUNIT --since "$T_START" --utc --no-pager -o short-iso)
  WALLINE=$(echo "$JL" | grep 'WAL mode: snapshotSeq=0 replayed=0 pending=' | head -1); log "WAL line: $(echo "$WALLINE" | cut -c1-260)"
  echo "$WALLINE" | grep -q "pending=$NP consumed=$NC " || fail_after_stop "WAL pending/consumed ($NP/$NC from the manifest after the stop: pending.count / consumed.lines) differ from the converted state"
  echo "$WALLINE" | grep -q 'consumedCap=3000000' || fail_after_stop "consumedCap is not 3000000"
  STARTLINE=$(echo "$JL" | grep 'starting dual-cursor' | head -1 | cut -c1-320); log "start line: $STARTLINE"
  echo "$STARTLINE" | grep -q 'tickMode=fixed idleBackoffMs=60000' || fail_after_stop "start line lacks tickMode=fixed idleBackoffMs=60000"
  if echo "$JL" | grep -E 'ALERT|WAL start refused' | head -3 | grep -q .; then fail_after_stop "ALERT or WAL start refused after the start"; fi
  M_POST=$(manifest_json) || fail_after_stop "manifest unreadable after the start: $M_POST"; [ "$(mf "$M_POST" version)" = 3 ] || fail_after_stop "manifest version is not 3"; [ "$(mf "$M_POST" wal)" = True ] || fail_after_stop "no wal directory"
  ENVN=$($SUDO sh -c "tr '\0' '\n' </proc/$P/environ")
  echo "$ENVN" | grep -qx 'NODE_OPTIONS=--max-old-space-size=1536' || fail_after_stop "process NODE_OPTIONS"
  if echo "$ENVN" | grep -qE '^CONET_LAB_MINING_POOL_CL_PAYOUT_(DECOUPLED|POOLS_FILE|TICK_MODE)='; then fail_after_stop "forbidden env present (DECOUPLED/POOLS_FILE/TICK_MODE are not part of this step)"; fi
  log "manifest post-start: $M_POST (version 3: the old build now refuses this directory)"
  { systemctl show $SIGNER_UNIT -p MainPID,InvocationID,NRestarts --no-pager | tr '\n' ' '; echo; } > "$W/signer-post.txt"; { systemctl show $CLAIM_UNIT -p MainPID,InvocationID,NRestarts --no-pager | tr '\n' ' '; echo; } > "$W/claim-post.txt"
  cmp -s "$W/signer-pre.txt" "$W/signer-post.txt" && cmp -s "$W/claim-pre.txt" "$W/claim-post.txt" || fail_after_stop "signer or Claim changed"
  seg phase-swap-start-total $T_ALL; REPORTED=1
  log "DONE g3 (t_start=$T_START t_conv=$(cat "$W/t_conv.txt")); run lab-g3-post.sh at +2/+10/+30/+60 min. Segment times: $W/timings.txt";;
*) echo "usage: lab-g3-cutover.sh stop | resume-check | swap-start | status" >&2; exit 1;;
esac

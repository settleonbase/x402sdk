# Shared constants of the Lab 0160a085 G2/G3 scripts (DRAFTS, NOT EXECUTED; sourced by the scripts below). Values come from the reviewed page PAGE-lab-independent-deploy-review-2026-11-22.md (+ADDENDUM-1/2),
# the field's r4 window files and the field readings 0735Z. Anything marked HELPER is a file of the field's reviewed window directory $W that must be landed by hash before the window.
# ---- SITE CONFIGURATION (v8): nothing about the host lives in this repository. Host paths, unit names, accounts, ports, the names of the unit's existing drop-ins and the hashes of the host's own private files come from a private
# site file on the host (NOT in git; template: site.env.example), given as SITE_ENV=<file>. Because these values drive commands that run through sudo, the file is read THROUGH sudo and must be owned by root with mode 0600
# (the operator account cannot edit it). It is NOT sourced: only lines NAME=value for the names in SITE_REQUIRED are accepted (no code, no other name); a line that names anything else - in particular any fixed constant below -
# refuses the whole file. The fixed constants are defined AFTER the file is read, so nothing in it can override them.
SUDO="${SUDO:-sudo -n}"
SITE_ENV="${SITE_ENV:-}"
SITE_REQUIRED="DROPIN_A_NAME DROPIN_B_NAME DROPIN_C_NAME REL_BASE DUNIT DROPDIR D6ENV ENV0 SD LOC SVC_UID SVC_GID OPERATOR_USER W SIGNER_UNIT CLAIM_UNIT ORACLE_TIMER ORACLE_SERVICE BEACON_URL DROPIN90_SHA UNIT_SHA OLD_DROP_SHA D91_SHA D92_SHA D93_SHA ENV_SHA"
SITE_MSG=""
site_load() {
  local st body line name val
  SITE_MSG=""
  [ -n "$SITE_ENV" ] || { SITE_MSG="SITE_ENV is not set (see site.env.example)"; return 1; }
  st=$($SUDO stat -c '%U %a' "$SITE_ENV" 2>/dev/null) || { SITE_MSG="the site file cannot be examined"; return 1; }
  [ "$st" = "root 600" ] || { SITE_MSG="the site file must be owned by root with mode 0600 (is: $st)"; return 1; }
  body=$($SUDO cat "$SITE_ENV" 2>/dev/null) || { SITE_MSG="the site file cannot be read"; return 1; }
  while IFS= read -r line; do
    case "$line" in ""|"#"*) continue;; esac
    if [[ "$line" =~ ^([A-Z0-9_]+)=\"([^\"\$\`\\]*)\"$ ]] || [[ "$line" =~ ^([A-Z0-9_]+)=([^\ \"\'\$\`\\;\&\|\<\>\(\)]*)$ ]]; then
      name=${BASH_REMATCH[1]}; val=${BASH_REMATCH[2]}
    else
      SITE_MSG="a line of the site file is not NAME=value (no code is accepted)"; return 1
    fi
    case " $SITE_REQUIRED " in *" $name "*) ;; *) SITE_MSG="the site file names $name, which is not a site value (fixed constants cannot be set from the site file)"; return 1;; esac
    printf -v "$name" '%s' "$val"
  done <<< "$body"
  return 0
}
if [ -n "$SITE_ENV" ]; then site_load >/dev/null 2>&1 || true; fi
site_verify() {
  local v val bad=0
  site_load || { echo "$SITE_MSG"; return 1; }
  for v in $SITE_REQUIRED; do
    val=$(eval "printf '%s' \"\${$v:-}\"")
    case "$val" in ""|*"<"*|*">"*) echo "site value $v is missing or still a placeholder"; bad=1;; esac
  done
  return $bad
}
REV=0160a08544013483ae992c77ee60e9aeb73ca811
TREE=04bd1710944bc6b8d2d9a2b032b23299932cba2b
LOCK=c70278b221f8505efe2453321ab284ac2dfdff0828a4f5e8371c4b1f704da003
DIST_FILES=216
DIST_SHA=45ff2874a9f1117f6b8c0a6ad3f8daf38800a027bbb174c6bcb11de4127e0f68
ENTRY_SHA=ba39d5101d4c77d37067c12f5dcff98ed311d58b334a6cb698843d35c75a4bf8
REPORTER_SHA=1641bab3ca4f28833a1805e4a579493aab52de47be106719de2d533a5710226d
OLD_REV=df78e6b0c487a5c69620d37c369da301849bbb79
OLD_DIST_FILES=189
OLD_DIST_SHA=52fe9a47b4c09cf733d41c159f8f58f6742b41f4411cd60c6e4768588b06f758
REPO=https://github.com/settleonbase/x402sdk.git
LAB=0xcFAF85E6C1765DA01a4Dc58C81b28Cd572067135
POOL=0x32bE583C8e778FFfC5107BF34820c2B225336201
VDR=0xc71e246DD78B37C2fABc905D340932F28F503433
PUB=https://publicrpc.conet.network
PUB2=https://rpc1.conet.network
# (the window directory W comes from the site file; helpers HELPER: gate-value-ro.py verify-state-digests-ro.py envcheck.py envcheck-extra-n.py gatecheck.py beaconhealth.py readv2.js)

# ---- v2 additions (revision after the independent review 61a82693; the first drafts are superseded by these files) ----
REL_NEW=${REL_BASE:-}/$REV
REL_OLD=${REL_BASE:-}/$OLD_REV
OLD_DROP=${DROPDIR:-}/90-lab-df78e6b-release.conf
NEW_DROP=${DROPDIR:-}/90-lab-0160a085-release.conf
NEW_ENV_DROP=${DROPDIR:-}/94-lab-0160a085-wal.conf
DROPIN94_SHA=725b8cc879465bf889bd5d94e229090b7c2690aca15afa62af5c67a0bfb86dde
# the 90 drop-in is a TEMPLATE in the repo (@REL_NEW@ = the new release directory of this host); the rendered file must equal the reviewed one (DROPIN90_SHA, a site value)
render_dropins() {
  local out=$1
  sed "s#@REL_NEW@#$REL_NEW#" "$OPS_DIR/90-lab-0160a085-release.conf.template" > "$out/90-lab-0160a085-release.conf.rendered" || return 1
  cp "$OPS_DIR/94-lab-0160a085-wal.conf.proposed" "$out/94-lab-0160a085-wal.conf" || return 1
  [ "$(sha256sum "$out/90-lab-0160a085-release.conf.rendered" | cut -c1-64)" = "$DROPIN90_SHA" ] || { echo "rendered 90 drop-in does not match the reviewed hash"; return 1; }
  [ "$(sha256sum "$out/94-lab-0160a085-wal.conf" | cut -c1-64)" = "$DROPIN94_SHA" ] || { echo "94 drop-in does not match the reviewed hash"; return 1; }
}
# v4: the helper scripts come from THIS checkout (GitHub), not from hand-landed copies; every one is checked against its pinned SHA-256 before anything runs (helpers_verify).
HELPER_DIR="${HELPER_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers}"
# v7: envcheck.py and gatecheck.py are the reviewed files (1046c1b3... / 6668e2bd...) with ONLY the host-specific constants replaced by environment values (diff in the hand-over); the other helpers are byte-identical to the reviewed originals.
HELPER_PINS="961e51da1b63cef1d02a6a3e22b123a97ddc96ce1c8fe57d7073f9556988cf3c gate-value-ro.py
59005666587f0b7ccb43084367d867b0fdb4dc1a53ae5fd1205fe69ed5607826 verify-state-digests-ro.py
55e3079a23e47d2b0e5860cc6153d24a80cbe4a0aa8351a0a5cb0874b5d72311 envcheck.py
fcaa2e21cc6bfc1f9f541e7472c4d86cda25c44714aa247eb3d6e1a03f88a15b gatecheck.py
d17129dc1b110cab2a9418866ff3ae653420affb636032b81786b18cb0968a5b beaconhealth.py
53536a0dd5bd9ce78303799d4a3d9bd3cf23c5fbbcd21cffb8fc6d4c12af7833 readv2.js"
# prints each mismatch; returns 0 only if every pinned helper exists and matches. (lab-pool-beneficiary-check.py is the field's local tool, not used by these scripts.) readv2.js (53536a0d...) is reviewed: REVIEW-readv2-js-53536a0d-readonly-2026-11-22 (475d80eb...) + ERRATUM (a6b5eb7b...), verdict pass.
helpers_verify() {
  local h f got bad=0
  while read -r h f; do
    [ -f "$HELPER_DIR/$f" ] || { echo "helper missing: $HELPER_DIR/$f"; bad=1; continue; }
    got=$(sha256sum "$HELPER_DIR/$f" 2>/dev/null | cut -c1-64); [ -n "$got" ] || got=$(shasum -a 256 "$HELPER_DIR/$f" | cut -c1-64)
    [ "$got" = "$h" ] || { echo "helper hash mismatch: $f got=$got want=$h"; bad=1; }
  done <<< "$HELPER_PINS"
  return $bad
}
ALT=https://mainnet.conet.network/api/eth-rpc
OPS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# B1: the gate is true ONLY if the helper exits 0, its LAST line is exactly GATE_OK and it reports INFLIGHT=no. (The first drafts used `grep -q G`: GATE_STOP also contains a G, so the gate never stopped anything.)
# usage: gate_run <label> [extra gate-value-ro.py args]; the helper output is kept in $W/gate-<label>.txt and in GATE_OUT.
gate_run() {
  local label=$1; shift
  GATE_OUT=$($SUDO /usr/bin/python3 -I "$HELPER_DIR/gate-value-ro.py" "$SD" --lab "$LAB" --rpc "$PUB" --rpc "$PUB2" --rpc "$ALT" "$@" 2>&1); GATE_RC=$?
  printf '%s\n' "$GATE_OUT" > "$W/gate-$label.txt"
  [ "$GATE_RC" -eq 0 ] && [ "$(printf '%s\n' "$GATE_OUT" | tail -1)" = GATE_OK ] && printf '%s\n' "$GATE_OUT" | grep -qx 'INFLIGHT=no'
}
# B2: the manifest fields come from the REAL keys (version, generation, previousGeneration, pending.count, consumed.lines, scalars.*); a missing or non-integer value fails on the spot (no null ever reaches a comparison).
manifest_json() { $SUDO /usr/bin/python3 -I "$OPS_DIR/manifest-fields.py" "${1:-$SD}"; }
mf() { printf '%s' "$1" | /usr/bin/python3 -I -c 'import json,sys;d=json.load(sys.stdin);v=d[sys.argv[1]];print("" if v is None else v)' "$2"; }
# B3: the state directory is 0700 and owned by the service user: every read of it goes through sudo, including the old build's own reader.
# The old reader is df78e6b's OWN state-store module (second argument), pinned by hash: reviewed readv2.js (53536a0d..., review 475d80eb + erratum) run as `sudo -n node readv2.js <df78e6b labClPayoutStateStore.js> <state dir>`; read-only.
OLD_STORE_SHA=0785bfb6a71418dacfea37e1e75f4ecc6fc46ad848e1a103529f8eb32678b5e6
readv2_ro() {
  local store="$REL_OLD/dist/endpoint/labClPayoutStateStore.js" got
  got=$($SUDO sha256sum "$store" 2>/dev/null | cut -c1-64)
  [ "$got" = "$OLD_STORE_SHA" ] || { echo "{\"ok\":false,\"error\":\"old state-store module is not the pinned df78e6b file (got ${got:-none})\"}"; return 1; }
  $SUDO node "$HELPER_DIR/readv2.js" "$store" "$SD"
}
# the oracle gate: true only when the last trigger and the next trigger are both more than 120 s away and the oracle service is not running. Prints the numbers.
oracle_gate_ok() {
  local now last next act
  now=$(date -u +%s)
  last=$(date -u -d "$(TZ=UTC systemctl show $ORACLE_TIMER -p LastTriggerUSec --value)" +%s 2>/dev/null)
  next=$(date -u -d "$(TZ=UTC systemctl list-timers $ORACLE_TIMER --no-pager | awk 'NR==2 {print $1" "$2" "$3}')" +%s 2>/dev/null)
  act=$(systemctl is-active $ORACLE_SERVICE)
  ORACLE_LINE="oracle gate: since_last=$([ -n "$last" ] && echo $((now-last)) || echo ?)s until_next=$([ -n "$next" ] && echo $((next-now)) || echo ?)s service=$act"
  [ -n "$last" ] && [ -n "$next" ] && [ $((now-last)) -gt 120 ] && [ $((next-now)) -gt 120 ] && [ "$act" != activating ] && [ "$act" != active ]
}

# C1: the manual S1 record. Strict: ONE line `S1-OK by=<name> at=<UTC ISO8601> result=OK consumed_delta=<n> settled_delta=<n> payments=<n>` and the three numbers equal those `stop` measured (S1-DATA.env).
# usage: s1_ok_check <S1-OK file> <S1-DATA.env file>; returns 0 only if valid; the reason is in S1_MSG.
s1_ok_check() {
  local ok=$1 data=$2 line k a b
  S1_MSG=""
  [ -s "$ok" ] && [ -s "$data" ] || { S1_MSG="S1-OK or S1-DATA.env missing or empty"; return 1; }
  [ "$(awk 'END{print NR}' "$ok")" = 1 ] || { S1_MSG="S1-OK must be exactly one line"; return 1; }
  line=$(head -1 "$ok")
  printf '%s\n' "$line" | grep -Eq '^S1-OK by=[A-Za-z0-9._@-]+ at=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z result=OK consumed_delta=[0-9]+ settled_delta=[0-9]+ payments=[0-9]+$' || { S1_MSG="S1-OK is not in the strict format (got: $(printf '%s' "$line" | head -c 160))"; return 1; }
  for k in consumed_delta settled_delta payments; do
    a=$(printf '%s\n' "$line" | sed -E "s/.* $k=([0-9]+).*/\1/"); b=$(sed -n "s/^$k=//p" "$data")
    [ -n "$a" ] && [ "$a" = "$b" ] || { S1_MSG="S1-OK $k=$a differs from the measured $k=$b"; return 1; }
  done
  return 0
}

# R1: the stop must have been CLEAN and nobody may have started and stopped the unit since. fingerprint = Result|InvocationID|ExecMainExitTimestamp of the unit as systemd reports it.
unit_fingerprint() { printf '%s|%s|%s' "$(systemctl show $DUNIT -p Result --value)" "$(systemctl show $DUNIT -p InvocationID --value)" "$(systemctl show $DUNIT -p ExecMainExitTimestamp --value)"; }
# usage: stop_record_ok <fingerprint file written by `stop` after a clean stop>; true only if the file exists, says Result=success, and the unit's fingerprint is unchanged since.
stop_record_ok() {
  local f=$1 rec cur
  [ -s "$f" ] || { STOPREC_MSG="no stop record: the stop of this round was not clean (or never happened)"; return 1; }
  rec=$(cat "$f"); cur=$(unit_fingerprint)
  [ "${rec%%|*}" = success ] || { STOPREC_MSG="the recorded stop was not Result=success ($rec)"; return 1; }
  [ "${cur%%|*}" = success ] || { STOPREC_MSG="the unit's Result is now not success ($cur)"; return 1; }
  [ "$rec" = "$cur" ] || { STOPREC_MSG="the unit was started/stopped again since the stop (recorded $rec, now $cur)"; return 1; }
  return 0
}

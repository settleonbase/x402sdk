#!/bin/bash
# Self-test of the G3 script fixes B1-B4 + rulings, with NO production access: fake sudo / systemctl / journalctl / helpers in a temp PATH. Each case prints PASS/FAIL; exit 1 if any FAIL.
# B1 gate exactness | B2 real manifest keys | B3 old reader through sudo (dry run before the stop) | B4 stop in place after the stop, never an automatic restart; rollback_plain only for a proven plain v2 state.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); OPS=$(cd "$HERE/.." && pwd); FAILS=0
ok(){ echo "PASS $1"; }; bad(){ echo "FAIL $1"; FAILS=$((FAILS+1)); }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
# ---- B2: manifest-fields.py on real-structure fixtures
for v in 2 3; do
  mkdir -p "$T/s$v"; cp "$HERE/fixtures/manifest-v$v.json" "$T/s$v/manifest.json"
  out=$(/usr/bin/python3 -I "$OPS/manifest-fields.py" "$T/s$v"); rc=$?
  [ $rc -eq 0 ] && printf '%s' "$out" | /usr/bin/python3 -I -c 'import json,sys;d=json.load(sys.stdin);assert d["pending"]==1720000 and d["consumed"]==270000 and d["settled"]==2054 and d["version"]=='$v' and d["previousGeneration"].startswith("gen-")' && ok "B2 manifest v$v: pending.count/consumed.lines/settled read" || bad "B2 manifest v$v ($out)"
done
mkdir -p "$T/old"; cp "$HERE/fixtures/manifest-first-draft-keys.json" "$T/old/manifest.json"
out=$(/usr/bin/python3 -I "$OPS/manifest-fields.py" "$T/old"); rc=$?; [ $rc -eq 3 ] && echo "$out" | grep -q 'MANIFEST_FIELDS_ERROR' && ok "B2 a manifest with only the first-draft keys fails loudly (no null)" || bad "B2 first-draft keys ($rc $out)"
# ---- B1: gate_run with fake helper outputs
mkdir -p "$T/bin" "$T/W"
cat > "$T/bin/sudo" <<'FAKE'
#!/bin/bash
[ "$1" = "-n" ] && shift
echo "sudo $*" >> "${FAKE_LOG:-/dev/null}"
exec "$@"
FAKE
chmod +x "$T/bin/sudo"
export FAKE_LOG="$T/calls.log"; : > "$FAKE_LOG"
gate_case(){ # $1 = helper body (heredoc text), $2 = expected (0/1)
  printf '%s\n' "$1" > "$T/W/gate-value-ro.py"; chmod +x "$T/W/gate-value-ro.py"
  ( export PATH="$T/bin:$PATH" W="$T/W"; export SD="$T/s2"; . "$OPS/common.env.sh"; W="$T/W"; SD="$T/s2"; HELPER_DIR="$T/W"; gate_run t; echo $? )
}
mkgate(){ printf 'import sys\nfor l in [%s]: print(l)\nsys.exit(%s)\n' "$(printf '%s' "$1" | sed "s/' '/', '/g")" "$2"; }
r=$(gate_case "$(mkgate "'COUNT=5' 'INFLIGHT=no' 'GATE_OK'" 0)" | tail -1); [ "$r" = 0 ] && ok "B1 GATE_OK + INFLIGHT=no => true" || bad "B1 ok case ($r)"
r=$(gate_case "$(mkgate "'COUNT=5' 'INFLIGHT=no' 'GATE_STOP:nonce mismatch'" 3)" | tail -1); [ "$r" != 0 ] && ok "B1 GATE_STOP => false (first drafts' grep -q G would have passed it)" || bad "B1 stop case"
r=$(gate_case "$(mkgate "'COUNT=5' 'INFLIGHT=yes' 'GATE_OK'" 0)" | tail -1); [ "$r" != 0 ] && ok "B1 INFLIGHT=yes => false even with GATE_OK" || bad "B1 inflight case"
r=$(gate_case "$(mkgate "'COUNT=5' 'INFLIGHT=no' 'GATE_OK' 'trailing'" 0)" | tail -1); [ "$r" != 0 ] && ok "B1 GATE_OK not the last line => false" || bad "B1 last-line case"
r=$(gate_case "$(mkgate "'COUNT=5' 'INFLIGHT=no' 'GATE_OK'" 3)" | tail -1); [ "$r" != 0 ] && ok "B1 exit code 3 with GATE_OK text => false" || bad "B1 rc case"
printf '%s' 'GATE_STOP:x' | tail -1 | grep -q G && ok "B1 control: the first drafts' test really passed GATE_STOP (grep -q G)" || bad "B1 control"
# ---- B3 + B4: the whole cutover `stop` phase against fakes. The fakes read their behaviour from files in $T/F
mkdir -p "$T/F" "$T/state/payout-state.v2"; cp "$HERE/fixtures/manifest-v2.json" "$T/state/payout-state.v2/manifest.json"
cat > "$T/bin/systemctl" <<'FAKE'
#!/bin/bash
echo "systemctl $*" >> "$FAKE_LOG"
F="$FAKE_DIR"
case "$1" in
  stop) echo inactive > "$F/active"; [ -f "$F/stop-fail" ] && { echo failed > "$F/result"; exit 1; }; echo success > "$F/result"; exit 0;;
  start) echo active > "$F/active"; exit 0;;
  is-active) cat "$F/active" 2>/dev/null || echo active;;
  show) shift; args="$*";
    case "$args" in *--value*) case "$args" in *Result*) cat "$F/result" 2>/dev/null || echo success;; *NeedDaemonReload*) echo no;; *WorkingDirectory*) echo "$REL_OLD_FAKE";; *NRestarts*) echo 0;; *MainPID*) echo 4242;; *) echo x;; esac;; *) echo "MainPID=4242 InvocationID=abc NRestarts=0";; esac;;
  daemon-reload) ;; *) ;;
esac
FAKE
chmod +x "$T/bin/systemctl"
cat > "$T/bin/journalctl" <<'FAKE'
#!/bin/bash
if [ -n "${FAKE_JOURNAL:-}" ] && [ -f "$FAKE_JOURNAL" ]; then cat "$FAKE_JOURNAL"; fi
FAKE
chmod +x "$T/bin/journalctl"
# ---- B3/B4 static assertions on the script text (the dynamic failure branches are run by the independent reviewer in a fake-systemctl sandbox, and by the field's rehearsal)
C="$OPS/lab-g3-cutover.sh"
HASHFN=$(sed -n '/^state_tree_hashes()/,/^}/p' "$C")
[ -n "$HASHFN" ] && eval "$HASHFN" && ok "G3 hash function is present for isolated acceptance cases" || bad "G3 hash function is missing"
HT="$T/state hash fixture"; mkdir -p "$HT/source/gen-current/sub" "$HT/copy/gen-current/sub"
printf '%s\n' '{"version":2}' > "$HT/source/manifest.json"
printf '%s\n' 'first payload' > "$HT/source/gen-current/sub/a.json"
printf '%s\n' 'second payload' > "$HT/source/gen-current/sub/b.json"
cp -a "$HT/source/." "$HT/copy/"
SUDO="$T/bin/sudo -n"
if state_tree_hashes sudo "$HT/source" gen-current "" > "$HT/source.sha256" 2> "$HT/source.err" && state_tree_hashes user "$HT/copy" gen-current "" > "$HT/copy.sha256" 2> "$HT/copy.err" && [ -s "$HT/source.sha256" ] && [ "$(wc -l < "$HT/source.sha256" | tr -d ' ')" = 3 ] && cmp -s "$HT/source.sha256" "$HT/copy.sha256"; then
  ok "G3 canonical hashes pass with a space-containing root path and identical relative paths"
else
  bad "G3 canonical source/copy hashes ($?)"
fi
rm "$HT/copy/gen-current/sub/b.json"
state_tree_hashes user "$HT/copy" gen-current "" > "$HT/missing.sha256" 2> "$HT/missing.err"; missing_rc=$?
diff -u "$HT/source.sha256" "$HT/missing.sha256" > "$HT/missing.diff"; missing_diff_rc=$?
if [ "$missing_rc" -eq 0 ] && [ "$missing_diff_rc" -eq 1 ] && [ -s "$HT/missing.diff" ]; then ok "G3 missing copied file produces a nonempty diff (generator rc=0, compare rc=1)"; else bad "G3 missing-file copy case (generator rc=$missing_rc, diff rc=$missing_diff_rc)"; fi
cp "$HT/source/gen-current/sub/b.json" "$HT/copy/gen-current/sub/b.json"
printf '%s\n' 'modified payload' > "$HT/copy/gen-current/sub/b.json"
state_tree_hashes user "$HT/copy" gen-current "" > "$HT/mismatch.sha256" 2> "$HT/mismatch.err"; mismatch_rc=$?
diff -u "$HT/source.sha256" "$HT/mismatch.sha256" > "$HT/mismatch.diff"; mismatch_diff_rc=$?
if [ "$mismatch_rc" -eq 0 ] && [ "$mismatch_diff_rc" -eq 1 ] && [ -s "$HT/mismatch.diff" ]; then ok "G3 copied-content mismatch produces a nonempty diff (generator rc=0, compare rc=1)"; else bad "G3 content-mismatch case (generator rc=$mismatch_rc, diff rc=$mismatch_diff_rc)"; fi
mkdir -p "$HT/empty/gen-empty"
printf '%s\n' '{}' > "$HT/empty/manifest.json"
state_tree_hashes user "$HT/empty" gen-empty "" > "$HT/empty.sha256" 2> "$HT/empty.err"; empty_rc=$?
if [ "$empty_rc" -ne 0 ] && grep -q 'generation directory has no regular files' "$HT/empty.err"; then ok "G3 incomplete empty generation fails explicitly"; else bad "G3 empty generation case (rc=$empty_rc)"; fi
if [ "$(id -u)" -ne 0 ]; then
  chmod 000 "$HT/source"
  state_tree_hashes user "$HT/source" gen-current "" > "$HT/denied.sha256" 2> "$HT/denied.err"; denied_rc=$?
  chmod 700 "$HT/source"
  if [ "$denied_rc" -ne 0 ] && grep -q 'cannot enter state directory' "$HT/denied.err"; then ok "G3 genuine operator EACCES is nonzero and explicit"; else bad "G3 permission-denied case (rc=$denied_rc)"; fi
else
  bad "G3 permission-denied case cannot run as uid 0; run acceptance as the operation account"
fi
n=$(grep -c 'systemctl start' "$C"); [ "$n" = 2 ] && ok "B4 exactly two 'systemctl start' in cutover (rollback_plain and swap-start)" || bad "B4 systemctl start count ($n)"
awk '/^static_checks\(\)/,/^}/' "$C" | grep -q 'preflight_state_hash' && ok "G3 operation-account source hash probe is inside static checks before any stop" || bad "G3 pre-stop source hash probe is missing"
for step in 'install -d -m 0700' 'chown -R' 'chmod -R go-rwx' 'chmod -R a-w'; do
  grep -F "$step" "$C" | grep -q '|| fail_after_stop' && ok "G3 pre-WAL copy $step failure stops the phase" || bad "G3 pre-WAL copy $step failure is unchecked"
done
grep -q 'pre-WAL copy hash/list is empty' "$C" && grep -q 'pre-WAL source hash/list is empty' "$C" && ok "G3 empty source or copy hash list is refused" || bad "G3 empty hash list could pass"
awk '/^rollback_plain\(\)/,/^}/' "$C" | grep -q 'systemctl start' && ok "B4 one of them is inside rollback_plain" || bad "B4 rollback_plain start"
awk '/^rollback_plain\(\)/,/^}/' "$C" | grep -q 'plain_v2_ok || in_place' && ok "B4 rollback_plain refuses unless plain_v2_ok" || bad "B4 plain_v2_ok guard"
STOPBLK=$(sed -n '/^stop)/,/^swap-start)/p' "$C"); [ "$(printf '%s\n' "$STOPBLK" | wc -l)" -gt 20 ] && printf '%s\n' "$STOPBLK" | grep -q 'in_place' && ok "B4 control: the stop block was extracted ($(printf '%s\n' "$STOPBLK" | wc -l) lines, in_place present)" || bad "B4 stop block empty (the checks below would be vacuous)"
PSFN=$(sed -n '/^poststop_checks()/,/^}/p' "$C"); [ "$(printf '%s\n' "$PSFN" | wc -l)" -gt 10 ] && printf '%s\n' "$PSFN" | grep -qE 'rollback_plain|fail_after_stop|systemctl (start|stop)' && bad "B4 poststop_checks must have no automatic path" || ok "B4 the post-stop checks (one function, used by stop and resume-check) have no automatic path"
printf '%s\n' "$STOPBLK" | grep -qE 'rollback_plain|fail_after_stop' && bad "B4 the stop phase must never call rollback_plain/fail_after_stop" || ok "B4 the stop phase has no automatic rollback path"
printf '%s\n' "$STOPBLK" | grep -vE '^[[:space:]]*#' | grep -o 'systemctl stop' | wc -l | grep -qx '[[:space:]]*1' && ok "B4 the stop phase issues exactly one systemctl stop (no second stop)" || bad "B4 stop count"
! grep -nE 'node +"?\$W/readv2|^[^#]*[^o_]readv2\.js' "$C" "$OPS/lab-g2-readonly-precheck.sh" | grep -v readv2_ro >/dev/null && ok "B3 no bare readv2.js call: every read of the 0700 state goes through readv2_ro (sudo)" || bad "B3 bare readv2 call"
grep -q 'readv2_ro > "$W/readv2-dryrun.json"' "$C" && ok "B3 dry run of the old reader before the stop" || bad "B3 dry run"
grep -hvE '^[[:space:]]*#' "$C" "$OPS/lab-g2-readonly-precheck.sh" "$OPS/common.env.sh" | sed 's/[[:space:]]#.*$//' | grep -qE 'grep -q G( |$)' && bad "B1 a 'grep -q G' is still in the scripts" || ok "B1 no 'grep -q G' left in the scripts"
# ---- C1: the strict S1 record (function s1_ok_check, exercised with real files)
s1case(){ # $1 = content of S1-OK ('' = file absent), $2 = expect 0/1, $3 = label
  d=$(mktemp -d); printf 'consumed_delta=300\nsettled_delta=3\npayments=3\n' > "$d/S1-DATA.env"; [ -n "$1" ] && printf '%b' "$1" > "$d/S1-OK"
  r=$( . "$OPS/common.env.sh"; s1_ok_check "$d/S1-OK" "$d/S1-DATA.env" >/dev/null 2>&1; echo $? ); rm -rf "$d"
  if [ "$2" = 0 ]; then [ "$r" = 0 ] && ok "C1 $3" || bad "C1 $3 (rc $r)"; else [ "$r" != 0 ] && ok "C1 $3" || bad "C1 $3 (accepted!)"; fi
}
s1case 'S1-OK by=field.1ef833dd at=2026-11-22T09:00:00Z result=OK consumed_delta=300 settled_delta=3 payments=3\n' 0 "valid record accepted"
s1case 'MISMATCH consumed.lines delta does not match: do not proceed\n' 1 "'MISMATCH ... do not proceed' is refused (the reviewer's case that used to convert)"
s1case 'S1-OK by=f at=2026-11-22T09:00:00Z result=OK consumed_delta=301 settled_delta=3 payments=3\n' 1 "a number that differs from the measured one is refused"
s1case 'S1-OK by=f at=2026-11-22T09:00:00Z result=MISMATCH consumed_delta=300 settled_delta=3 payments=3\n' 1 "result=MISMATCH is refused"
s1case 'S1-OK by=f at=2026-11-22T09:00:00Z result=OK consumed_delta=300 settled_delta=3 payments=3\nextra line\n' 1 "a second line is refused"
s1case 'just some text\n' 1 "free text is refused"
s1case '' 1 "no S1-OK file is refused"
# ---- C1/C2/resume static assertions
grep -q 'rm -f "$W/S1-OK"' "$C" && ok "C1 stop deletes an old S1-OK first" || bad "C1 stop must delete the old S1-OK"
grep -q 's1_ok_check "$W/S1-OK" "$W/S1-DATA.env" || die_pre' "$C" && ok "C1 swap-start uses the strict check" || bad "C1 swap-start strict check"
grep -q 'in_place "no oracle-safe start moment in 30 min' "$C" && ok "C2 the 30-minute oracle wait ends in place (no automatic restart)" || bad "C2 oracle wait timeout"
grep -q 'fail_after_stop "waited 30 min' "$C" && bad "C2 old fail_after_stop on the oracle wait is still there" || ok "C2 the old automatic path is gone"
grep -q '^resume-check)' "$C" && grep -q 'poststop_checks die_resume' "$C" && ok "resume-check exists and repeats the post-stop checks read-only" || bad "resume-check"
awk '/^resume-check\)/,/^status\)/' "$C" | grep -qE 'systemctl (start|stop)|install |rm -f' && bad "resume-check must change nothing" || ok "resume-check has no start, stop, install or delete"
grep -n 'm_stop.json' "$C" | grep -q 'LAST' && ok "m_stop.json is written last" || bad "m_stop.json must be written last"
# ---- v4: the S1 record is ONE line even without a trailing newline; helper pins; the clean-stop record (R1)
s1case 'S1-OK by=f at=2026-11-22T09:00:00Z result=OK consumed_delta=300 settled_delta=3 payments=3\nMISMATCH do not proceed' 1 "a valid line + garbage WITHOUT a trailing newline is refused (awk NR, not wc -l)"
( . "$OPS/common.env.sh"; HELPER_DIR="$OPS/helpers"; helpers_verify >/dev/null 2>&1 ) && ok "v4 helpers_verify: the committed helpers match their pins" || bad "v4 helpers_verify on the committed helpers"
t=$(mktemp -d); cp "$OPS/helpers/"* "$t/"; echo '# tampered' >> "$t/gate-value-ro.py"
( . "$OPS/common.env.sh"; HELPER_DIR="$t"; helpers_verify >/dev/null 2>&1 ) && bad "v4 a tampered helper was accepted" || ok "v4 a tampered helper is refused"
rm "$t/gatecheck.py"; ( . "$OPS/common.env.sh"; HELPER_DIR="$t"; helpers_verify 2>&1 | grep -q 'helper missing' ) && ok "v4 a missing helper is reported" || bad "v4 missing helper"; rm -rf "$t"
fp=$(mktemp -d); mkdir -p "$fp/bin"
cat > "$fp/bin/systemctl" <<'FAKE'
#!/bin/bash
# fake: `systemctl show <unit> -p <Prop> --value` reads $FPDIR/<Prop>
for a in "$@"; do case $a in Result|InvocationID|ExecMainExitTimestamp) P=$a;; esac; done
cat "$FPDIR/$P" 2>/dev/null
FAKE
chmod +x "$fp/bin/systemctl"
fpset(){ printf '%s' "$1" > "$fp/Result"; printf '%s' "$2" > "$fp/InvocationID"; printf '%s' "$3" > "$fp/ExecMainExitTimestamp"; }
fpcase(){ # $1 record content ('' = no file), $2 current Result, $3 current Invocation, $4 expect 0/1, $5 label
  fpset "$2" "$3" "Sun 2026-11-22 09:00:01 UTC"; rm -f "$fp/rec"; [ -n "$1" ] && printf '%s' "$1" > "$fp/rec"
  r=$( export FPDIR="$fp" PATH="$fp/bin:$PATH"; . "$OPS/common.env.sh"; DUNIT=u.service; stop_record_ok "$fp/rec" >/dev/null 2>&1; echo $? )
  if [ "$4" = 0 ]; then [ "$r" = 0 ] && ok "R1 $5" || bad "R1 $5 (rc $r)"; else [ "$r" != 0 ] && ok "R1 $5" || bad "R1 $5 (accepted!)"; fi
}
REC='success|inv-A|Sun 2026-11-22 09:00:01 UTC'
fpcase "$REC" success inv-A 0 "a clean stop whose unit is unchanged is accepted"
fpcase "success|inv-A|Sun 2026-11-22 09:00:01 UTC" timeout inv-A 1 "the unit's Result is now timeout: refused"
fpcase "timeout|inv-A|Sun 2026-11-22 09:00:01 UTC" timeout inv-A 1 "a recorded Result=timeout (the reviewer's case: an unclean stop washed into a record) is refused"
fpcase "$REC" success inv-B 1 "started and stopped again since (new InvocationID): refused"
fpcase "" success inv-A 1 "no stop record: refused"
rm -rf "$fp"
grep -q 'stop_record_ok "$W/stop-fingerprint.txt" || die_resume' "$C" && grep -q 'stop_record_ok "$W/stop-fingerprint.txt" || die_pre' "$C" && ok "R1 resume-check and swap-start both require the clean-stop record" || bad "R1 static"
printf '%s\n' "$STOPBLK" | grep -q 'unit_fingerprint > "$W/stop-fingerprint.txt"' && ok "R1 the stop phase writes the stop record after a clean stop" || bad "R1 the stop phase must write the stop record"
printf '%s\n' "$STOPBLK" | awk '/Result not success/{c=1} /unit_fingerprint >/{if(c)f=1} END{exit f?0:1}' && ok "R1 the record is written only after the clean-stop check" || bad "R1 record order"
grep -E '\$W/(gate-value-ro|verify-state-digests-ro|readv2\.js|envcheck|gatecheck|beaconhealth)' "$C" "$OPS/lab-g2-readonly-precheck.sh" "$OPS/common.env.sh" | grep -v '^[^:]*:[[:space:]]*#' | grep -q . && bad "v4 a helper is still called from the hand-landed \$W" || ok "v4 helpers are used from the checkout (HELPER_DIR), never from \$W"
# ---- v5: the old reader's second argument is df78e6b's state-store module, pinned by hash
grep -q "0785bfb6a71418dacfea37e1e75f4ecc6fc46ad848e1a103529f8eb32678b5e6  ./endpoint/labClPayoutStateStore.js" "$OPS/dist-df78e6b.expected.sha256" && grep -q '^OLD_STORE_SHA=0785bfb6a71418dacfea37e1e75f4ecc6fc46ad848e1a103529f8eb32678b5e6$' "$OPS/common.env.sh" && ok "v5 the pinned old-store hash equals the df78e6b entry of the reviewed 189-file list" || bad "v5 old-store pin"
rs=$(mktemp -d); mkdir -p "$rs/dist/endpoint"; echo 'not the real module' > "$rs/dist/endpoint/labClPayoutStateStore.js"; : > "$rs/calls"
r=$( export PATH="$T/bin:$PATH"; . "$OPS/common.env.sh"; REL_OLD="$rs"; HELPER_DIR="$OPS/helpers"; SD="$T/s2"; out=$(readv2_ro 2>&1); echo "$? $out" )
[ "${r%% *}" = 1 ] && printf '%s' "$r" | grep -q 'not the pinned df78e6b file' && ok "v5 readv2_ro refuses a state-store module that is not the pinned one (node is never run)" || bad "v5 readv2_ro pin refusal ($r)"
rm -rf "$rs"
grep -q 'sudo -n node\|\$SUDO node "\$HELPER_DIR/readv2.js" "\$store" "\$SD"' "$OPS/common.env.sh" && ok "v5 readv2 runs through sudo with the module as 2nd and the state dir as 3rd argument" || bad "v5 readv2 call shape"
# ---- R2: the helper pins are checked at the START of resume-check and swap-start, and once more right before the start
RCBLK=$(sed -n '/^resume-check)/,/^status)/p' "$C"); SSBLK=$(sed -n '/^swap-start)/,/^\*) echo "usage/p' "$C")
printf '%s\n' "$RCBLK" | head -3 | grep -q 'helpers_verify' && ok "R2 resume-check verifies the helpers first" || bad "R2 resume-check helpers_verify"
printf '%s\n' "$SSBLK" | head -4 | grep -q 'helpers_verify' && ok "R2 swap-start verifies the helpers first" || bad "R2 swap-start helpers_verify"
printf '%s\n' "$SSBLK" | awk '/last look before the start/{f=1} f&&/helpers_verify/{c=1} /systemctl start/{if(f&&c){ok=1}} END{exit ok?0:1}' && ok "R2 the helpers are verified again right before the start" || bad "R2 helpers_verify before the start"
# ---- v7: nothing about the host in the repository; the host comes from a private site file
SITEOK=$(mktemp)
for v in DROPIN_A_NAME DROPIN_B_NAME DROPIN_C_NAME REL_BASE DUNIT DROPDIR D6ENV ENV0 SD LOC SVC_UID SVC_GID OPERATOR_USER W SIGNER_UNIT CLAIM_UNIT ORACLE_TIMER ORACLE_SERVICE BEACON_URL; do echo "$v=/dummy/$v" >> "$SITEOK"; done
for v in DROPIN90_SHA UNIT_SHA OLD_DROP_SHA D91_SHA D92_SHA D93_SHA ENV_SHA; do echo "$v=$(printf x | shasum -a 256 | cut -c1-64)" >> "$SITEOK"; done
# the site file is read through sudo and must be root:600: a fake `stat` (answers $FAKE_STAT, default "root 600") and the fake sudo from above stand in for them on this machine
cat > "$T/bin/stat" <<'FAKE'
#!/bin/bash
echo "${FAKE_STAT:-root 600}"
FAKE
chmod +x "$T/bin/stat"
sv(){ ( export PATH="$T/bin:$PATH" SITE_ENV="$1"; . "$OPS/common.env.sh"; site_verify >/dev/null 2>&1; echo $? ); }
svm(){ ( export PATH="$T/bin:$PATH" SITE_ENV="$1"; . "$OPS/common.env.sh"; site_verify 2>&1 | head -1 ); }
[ "$(sv "$SITEOK")" = 0 ] && ok "v8 site_verify accepts a complete site file (root:600)" || bad "v8 site_verify complete"
[ "$(sv /nonexistent)" != 0 ] && ok "v8 site_verify refuses a missing site file" || bad "v8 site_verify missing file"
[ "$(sv "$OPS/site.env.example")" != 0 ] && ok "v8 site_verify refuses the placeholder template" || bad "v8 site_verify template"
grep -v '^SD=' "$SITEOK" > "$SITEOK.2"; [ "$(sv "$SITEOK.2")" != 0 ] && ok "v8 site_verify refuses a file with a value missing" || bad "v8 site_verify missing value"
grep -v '^UNIT_SHA=' "$SITEOK" > "$SITEOK.3"; [ "$(sv "$SITEOK.3")" != 0 ] && ok "v8 the host-private file hashes are site values: a missing one is refused" || bad "v8 UNIT_SHA missing"
( export PATH="$T/bin:$PATH"; unset SITE_ENV; . "$OPS/common.env.sh"; site_verify >/dev/null 2>&1 ) && bad "v8 site_verify without SITE_ENV" || ok "v8 site_verify refuses to run without SITE_ENV"
r=$( export FAKE_STAT="operator 600"; sv "$SITEOK" ); [ "$r" != 0 ] && ok "v8 a site file not owned by root is refused" || bad "v8 site owner"
r=$( export FAKE_STAT="root 644"; sv "$SITEOK" ); [ "$r" != 0 ] && ok "v8 a site file with mode 644 is refused" || bad "v8 site mode"
# fixed constants cannot be set from the site file, nor any other name, nor code
for bad_line in 'REV=deadbeef' 'DIST_SHA=00' 'HELPER_PINS=x' 'PUB=https://evil.example' 'SUDO=env' 'SOMETHING_ELSE=1' 'X=$(touch /tmp/pwned)' 'X=`id`' 'DUNIT=a; id'; do
  { cat "$SITEOK"; echo "$bad_line"; } > "$SITEOK.4"; r=$(sv "$SITEOK.4"); [ "$r" != 0 ] && ok "v8 the site file line '$bad_line' refuses the file" || bad "v8 site line accepted: $bad_line"
done
{ cat "$SITEOK"; echo "REV=deadbeef"; } > "$SITEOK.4"; m=$(svm "$SITEOK.4"); echo "$m" | grep -q 'fixed constants cannot be set' && ok "v8 the refusal names the reason (fixed constant)" || bad "v8 refusal text ($m)"
# the constants stay what the repo says even if the file tries: REV after loading is the fixed one (the file was refused, so nothing was assigned)
r=$( export PATH="$T/bin:$PATH" SITE_ENV="$SITEOK.4"; . "$OPS/common.env.sh"; echo "$REV" ); [ "$r" = 0160a08544013483ae992c77ee60e9aeb73ca811 ] && ok "v8 REV is still the fixed constant after a site file that tried to set it" || bad "v8 REV overridden ($r)"
rd=$(mktemp -d); HASH=$( ( export PATH="$T/bin:$PATH" SITE_ENV="$SITEOK"; . "$OPS/common.env.sh"; REL_NEW=/dummy/rel; sed "s#@REL_NEW@#$REL_NEW#" "$OPS/90-lab-0160a085-release.conf.template" | shasum -a 256 | cut -c1-64 ) )
r=$( export PATH="$T/bin:$PATH" SITE_ENV="$SITEOK"; . "$OPS/common.env.sh"; REL_NEW=/dummy/rel; DROPIN90_SHA=$HASH; render_dropins "$rd" >/dev/null 2>&1; echo $? ); [ "$r" = 0 ] && grep -q '^WorkingDirectory=/dummy/rel$' "$rd/90-lab-0160a085-release.conf.rendered" && ok "v7 render_dropins renders the template for this host and accepts the reviewed hash" || bad "v7 render_dropins ($r)"
r=$( export PATH="$T/bin:$PATH" SITE_ENV="$SITEOK"; . "$OPS/common.env.sh"; REL_NEW=/dummy/other; DROPIN90_SHA=$HASH; render_dropins "$rd" >/dev/null 2>&1; echo $? ); [ "$r" != 0 ] && ok "v7 a rendering that differs from the reviewed hash is refused" || bad "v7 render_dropins mismatch accepted"
rm -rf "$rd" "$SITEOK" "$SITEOK.2" "$SITEOK.3" "$SITEOK.4"
# swap-start renders and verifies the drop-ins again right before it installs them
printf '%s\n' "$SSBLK" | awk '/render_dropins/{r=NR} /\$SUDO install .*conf.rendered/{i=NR} END{exit (r&&i&&r<i)?0:1}' && ok "v8 swap-start renders the drop-ins again right before the install" || bad "v8 render before install"
# the repo must not name the host: tokens are assembled from fragments so that this file does not contain them either
T1="conet-lab""-mining"; T2="/opt/""conet"; T3="/etc/""conet"; T4="/var/lib/""conet"; T5="conet-vdr""-claim"; T6="conet-oracle""-quote"; T7="wallet-signer"".service"; T8="127.0.0.""1:"; T9="uid ""992"; T10="gid ""979"; T11="\\bpe""ter\\b"; T12="lab-d6"".env"; T13="\\.7""7\\b"
if grep -rnE "$T1|$T2|$T3|$T4|$T5|$T6|$T7|$T8|$T9|$T10|$T11|$T12|$T13" "$OPS" --include='*.sh' --include='*.py' --include='*.js' --include='*.md' --include='*.template' --include='*.proposed' --include='*.example' --include='*.json' | grep -v 'dist-' | grep -q .; then bad "v7 host-specific names are still in the repository files:"; grep -rnE "$T1|$T2|$T3|$T4|$T5|$T6|$T7|$T8|$T9|$T10|$T11|$T12|$T13" "$OPS" --include='*.sh' --include='*.py' --include='*.js' --include='*.md' --include='*.template' --include='*.proposed' --include='*.example' --include='*.json' | grep -v 'dist-' | cut -c1-160; else ok "v7 no host-specific unit names, paths, accounts, ports or env-file names in the repository files"; fi
for f in lab-g2-readonly-precheck.sh lab-g2-build.sh lab-g3-cutover.sh lab-g3-post.sh; do grep -q 'site_verify' "$OPS/$f" && ok "v7 $f checks the site configuration first" || bad "v7 $f has no site_verify"; done
# ---- v9/v10/v11: the memory gate: need = max(1.3 x RSS, RSS + 1.0 GiB); expected after the Lab stop = MemAvailable + min(Lab RssAnon, 750,000 kB)
mg(){ ( . "$OPS/common.env.sh"; memgate_eval "$1" "$2" "$3" >/dev/null 2>&1; echo $? ); }
mgm(){ ( . "$OPS/common.env.sh"; memgate_eval "$1" "$2" "$3" 2>&1 | tail -1 ); }
# needs in kB: 1536 -> max(2,317,352 ; 2,831,155) = 2,831,155   2048 -> max(2,726,297 ; 3,145,728) = 3,145,728   3072 -> max(4,266,655 ; 4,330,619) = 4,330,619
[ "$(mg 2048 2550000 1400000)" = 0 ] && ok "v9 Lab running with a LOW reading (2.55 GB) but enough after the stop (credit 750,000 -> 3.30 GB): passes" || bad "v9 low reading, enough after stop"
[ $(( 2048 * 13 / 10 * 1024 + 600 * 1024 )) -gt 2550000 ] && ok "v9 control: the first drafts' threshold (3,340,288 kB) is above that reading, i.e. the old gate refused this case" || bad "v9 control (old formula)"
[ "$(mg 2048 1000000 500000)" != 0 ] && echo "$(mgm 2048 1000000 500000)" | grep -q 'MEMGATE_FAIL' && ok "v9 not enough even after the stop (1.0 GB + 0.5 GB): refused with MEMGATE_FAIL" || bad "v9 insufficient after stop accepted"
[ "$(mg 1536 2081155 750000)" = 0 ] && [ "$(mg 1536 2081154 750000)" != 0 ] && ok "v10 tier 1536 boundary: need = RSS + 1.0 GiB = 2,831,155 kB (2,081,155 + the 750,000 credit passes, one kB less is refused)" || bad "v10 boundary 1536"
[ "$(mg 1536 1750000 750000)" != 0 ] && [ $(( 1782579 * 13 / 10 )) -le 2500000 ] && ok "v10 the case the plain 1.3x let through: expected 2,500,000 kB >= 1.3 x RSS (2,317,352) but < RSS + 1.0 GiB (2,831,155): refused" || bad "v10 1.3x passes but +1GiB does not"
[ "$(mg 2048 2395728 750000)" = 0 ] && [ "$(mg 2048 2395727 750000)" != 0 ] && ok "v10 tier 2048 boundary: need 3,145,728 kB (the +1 GiB floor is above 1.3x: 2,726,297)" || bad "v10 boundary 2048"
[ "$(mg 3072 3580619 750000)" = 0 ] && [ "$(mg 3072 3580618 750000)" != 0 ] && ok "v10 tier 3072 boundary: need 4,330,619 kB (floor above 1.3x: 4,266,655)" || bad "v10 boundary 3072"
# v11: the credit is capped at 750,000 kB
[ "$(mg 2048 2000000 1500000)" != 0 ] && [ "$(mg 2048 2000000 750000)" != 0 ] && ok "v11 RssAnon above the cap is credited at the cap: 2,000,000 + 1,500,000 is treated as 2,750,000 (< 3,145,728) and refused, although the uncapped sum 3,500,000 would pass" || bad "v11 cap applied"
[ $(( 2000000 + 1500000 )) -ge 3145728 ] && ok "v11 control: without the cap the same reading (3,500,000) would have passed" || bad "v11 control"
( . "$OPS/common.env.sh"; memgate_eval 2048 2000000 1500000 2>&1 | head -1 ) | grep -q 'Lab RssAnon 1500000 kB (credited 750000 kB)' && ok "v11 the output shows both the reading and the credited value" || bad "v11 output"
[ "$(mg 2048 2395728 750000)" = 0 ] && [ "$(mg 2048 2395728 2000000)" = 0 ] && [ "$(mg 2048 2395727 2000000)" != 0 ] && ok "v11 a reading above the cap gives exactly the cap, not more (boundary the same as with 750,000)" || bad "v11 cap boundary"
[ "$(mg 2048 2995728 150000)" = 0 ] && [ "$(mg 2048 2995727 150000)" != 0 ] && ok "v11 a reading below the cap is credited as it is (150,000)" || bad "v11 below cap"
[ "$(mg 2048 3200000 0)" = 0 ] && [ "$(mg 2048 3100000 0)" != 0 ] && ok "v9 an unreadable Lab RSS counts as 0 (nothing assumed to come back): the gate is then the plain reading" || bad "v9 lab rss zero"
[ "$(mg 4096 9000000 1000000)" != 0 ] && ok "v9 a tier that is not in the table fails closed" || bad "v9 unknown tier"
[ "$(mg 2048 abc 1000000)" != 0 ] && [ "$(mg 2048 3000000 '')" != 0 ] && ok "v9 a reading that is not a number fails closed" || bad "v9 non-number"
grep -q 'memgate_eval' "$OPS/lab-g2-readonly-precheck.sh" && grep -q 'RssAnon' "$OPS/lab-g2-readonly-precheck.sh" && ! grep -q '600\*1024' "$OPS/lab-g2-readonly-precheck.sh" && ok "v9 the pre-check uses memgate_eval with the Lab's RssAnon and no longer the heap-limit + 600 MB formula" || bad "v9 precheck wiring"
! grep -vE '^[[:space:]]*#' "$OPS/common.env.sh" | grep -q '600 *\* *1024' && ok "v10 the old '+600 MB' form is not kept in common.env.sh (no alternative branch)" || bad "v10 old form still present"
grep -q "the engineering seat's F1 streaming-rollback receipt" "$OPS/common.env.sh" && grep -q 'NOT on the target host' "$OPS/common.env.sh" && ! grep -q "independent reviewer's measurements" "$OPS/common.env.sh" && ok "v11 the table header attributes the RSS numbers accurately (engineering F1 receipt, local machine, not the target host)" || bad "v11 attribution comment"
echo "(B3/B4 dynamic cases are not run by this file; need the real helper set and a GNU userland; they run in the reviewer's sandbox and on the field's rehearsal. Function-level cases above ran here.)"
[ $FAILS -eq 0 ] && { echo "SELFTEST_OK"; exit 0; } || { echo "SELFTEST_FAILED $FAILS"; exit 1; }

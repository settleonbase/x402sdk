#!/bin/bash
# G2 BUILD PHASE ONLY (retry 3). A standalone tool; NOT one of the bound ops scripts and it changes none of their bytes. It reuses the release directory in which `npm ci`
# already finished from the lock file and runs only the build phase, then the verification part of the bound lab-g2-build.sh (lines 28-46), which is EXTRACTED AT RUN TIME from the bound checkout after the
# sha256 of that file and of the extracted text were checked (nothing is re-implemented here). It never runs `npm ci`, never deletes the npm cache (line 47 of the bound file is not run), never retries: any failure
# stops it and leaves everything in place.
# The ops checkout OPS_DIR must be the OLD bound one (commit ce956a78..., the ops/lab-g2g3-2026-11-22 directory); the files of the v11 checkout are NOT used (its common.env.sh differs).
# Start it INSIDE the limited scope, e.g.  sudo -n systemd-run --scope --quiet --unit=<name> -p MemoryMax=1200M -p MemorySwapMax=0 -p CPUWeight=10 -p IOWeight=10 --uid=<operator> --gid=<operator> \
#   --setenv=SITE_ENV=<site file> --setenv=OPS_DIR=<ops/lab-g2g3-2026-11-22 of the ce956a78 checkout> \
#   --setenv=HOME=<home> --setenv=NODE_OPTIONS=--max-old-space-size=1024 nice -n 19 ionice -c3 bash <this file>
# verify-npm-tree-readonly.js is taken from the directory of this file (hash pinned below). All steps before the build are read-only; the start gate right before the build exits without having changed anything if it is not met.
# 1200M = 1200 MiB = 1,258,291,200 bytes (systemd's M is MiB); the heap parameter below must equal the value in NODE_OPTIONS.
set -euo pipefail
umask 0027
HEAP_MB=1024
MEMORY_MAX_BYTES=1258291200
SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TREECHECK_JS=$SELF_DIR/verify-npm-tree-readonly.js
trap 'rc=$?; [ $rc -eq 0 ] || echo "G2_BUILD_PHASE_STOPPED rc=$rc (nothing was retried, nothing was cleaned up)" >&2' EXIT
HERE=${OPS_DIR:?OPS_DIR is required}
# the two bound files of the old checkout, by hash, before anything is read from them
test "$(sha256sum "$HERE/common.env.sh" | cut -d' ' -f1)" = 2ede81c8b74960ff6efd93e6f175d4b76eee0e7b0fb2d66cf6c8d6c1739b03a0
test "$(sha256sum "$HERE/lab-g2-build.sh" | cut -d' ' -f1)" = 2b8e1942700754fc2f17ec95b71363ba102dab182fe9f76959fe872d7dddc7e3
. "$HERE/common.env.sh"
site_verify
HV=$(helpers_verify) || { echo "$HV" >&2; exit 1; }
# the ops checkout is the bound one (ce956a78..., tree of the whole commit) and has no local changes
test "$(git -C "$HERE" rev-parse 'HEAD^{tree}')" = a9274a9af0c735071004209672bd1ea8d40b9239
test -z "$(GIT_OPTIONAL_LOCKS=0 git -C "$HERE" status --porcelain -- "$HERE")"
# the limits it must run under (read back from its own cgroup)
test "${NODE_OPTIONS:-}" = "--max-old-space-size=$HEAP_MB"
cg=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)
test "$(cat "$cg/memory.max")" = "$MEMORY_MAX_BYTES"
test "$(cat "$cg/memory.swap.max")" = 0
d=$REL_NEW
test "$(id -un)" = "$OPERATOR_USER" && test "$(id -u)" -ne 0
test -d "$d"
test -d "$REL_OLD/dist"
test "$(/usr/bin/node --version)" = v22.22.1 && test "$(/usr/bin/npm --version)" = 9.2.0
svc_group=$(getent group "$SVC_GID" | cut -d: -f1); test -n "$svc_group"
# the release directory is exactly what `npm ci` left: the pinned commit, no dist yet, nothing modified (build.log and npm-ci.log may exist)
test "$(GIT_OPTIONAL_LOCKS=0 git -C "$d" rev-parse HEAD)" = "$REV"
test "$(GIT_OPTIONAL_LOCKS=0 git -C "$d" rev-parse 'HEAD^{tree}')" = "$TREE"
test ! -e "$d/dist"
test -z "$(GIT_OPTIONAL_LOCKS=0 git -C "$d" status --porcelain | grep -vE '^\?\? (build|npm-ci)\.log$' || true)"
cd "$d"
printf '%s  %s\n' "$LOCK" package-lock.json | sha256sum -c -
# the installed dependencies match the lock: the read-only check verify-npm-tree-readonly.js (hash pinned here; the reviewer's nm-vs-lock-readonly.py is only a cross-check and is not used)
test "$(sha256sum "$TREECHECK_JS" | cut -d' ' -f1)" = 0621ec947514fb0cf38cccd2d6e60f7ccdddd7e1a47479bd2f9c22513346e8bf
test "$(/usr/bin/node "$TREECHECK_JS" "$d" "$LOCK" | tail -1)" = NPMTREE_OK
# the compiler itself must run (the tree check looks at package.json and the .bin link, not at the files inside the package)
test "$(/usr/bin/node node_modules/typescript/lib/tsc.js --version)" = "Version 5.8.3"
# START GATE (read-only; nothing has been changed when it refuses). Three samples 5 s apart, each one must hold:
#   MemAvailable - scope cap - (2,097,000 kB - RSS of the other service) >= 1,000,000 kB   and   that RSS <= 700,000 kB   (all kB; scope cap = MemoryMax in kB = 1,228,800)
# and the clock must be outside the window of +-120 s around second 157 (xx:x2:37) of every 10-minute cycle, where the periodic oracle job runs (checked before the samples and again right after them).
GATE_FLOOR_KB=1000000; SCOPE_CAP_KB=$((MEMORY_MAX_BYTES / 1024)); OTHER_LIMIT_KB=2097000; OTHER_MAX_KB=700000
clock_ok() { local s dd; s=$(( 10#$(date -u +%M) % 10 * 60 + 10#$(date -u +%S) )); dd=$(( s > 157 ? s - 157 : 157 - s )); [ "$dd" -gt 300 ] && dd=$((600 - dd)); [ "$dd" -gt 120 ]; }
isnum() { [[ "$1" =~ ^[0-9]+$ ]]; }
clock_ok || { echo "start gate: too close to the oracle job; start later" >&2; exit 1; }
opid=$(systemctl show "$CLAIM_UNIT" -p MainPID --value); isnum "$opid" && [ "$opid" -gt 0 ] || { echo "start gate: main pid of the other service unknown" >&2; exit 1; }
for i in 1 2 3; do
	[ "$i" -eq 1 ] || sleep 5
	avail=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo); rss=$(awk '/^VmRSS:/ {print $2}' "/proc/$opid/status")
	isnum "$avail" && isnum "$rss" || { echo "start gate: unreadable memory values" >&2; exit 1; }
	test "$(systemctl show "$CLAIM_UNIT" -p MainPID --value)" = "$opid" || { echo "start gate: the other service restarted" >&2; exit 1; }
	left=$(( avail - SCOPE_CAP_KB - (OTHER_LIMIT_KB - rss) ))
	echo "start gate sample $i: MemAvailable ${avail} kB, other RSS ${rss} kB, left ${left} kB"
	[ "$rss" -le "$OTHER_MAX_KB" ] && [ "$left" -ge "$GATE_FLOOR_KB" ] || { echo "start gate NOT met; nothing was changed" >&2; exit 1; }
done
clock_ok || { echo "start gate: too close to the oracle job after the samples; start later" >&2; exit 1; }
# the build phase only (the old build.log of the failed attempt must have been copied away by the operator before: it is overwritten here)
timeout 600s /usr/bin/npm run build >"$d/build.log" 2>&1
# the verification part: lines 28-46 of the bound lab-g2-build.sh, extracted once, hashed, then run in this shell (it needs $d, $HERE, $svc_group and the site constants set above)
VERIFY_PART=$(sed -n '28,46p' "$HERE/lab-g2-build.sh")
test "$(printf '%s\n' "$VERIFY_PART" | wc -l | tr -d ' ')" -eq 19
test "$(printf '%s\n' "$VERIFY_PART" | sha256sum | cut -d' ' -f1)" = 0e0903dc749c7706ecec38be34badba17a1b59306c1bce601d5ad38399bf3dd7
eval "$VERIFY_PART"
printf 'G2_BUILD_OK rev %s tree %s files %s manifest %s\n' "$REV" "$TREE" "$DIST_FILES" "$DIST_SHA"

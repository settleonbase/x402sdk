#!/bin/bash
# G2 BUILD (EXECUTION on the target host, draft, NOT EXECUTED; needs the owner's G2 approval): fetches the pushed commit from GitHub into a NEW release directory and builds it with the lock file. Writes ONLY
# the new release directory (and /var/tmp cache). Does not touch the running Lab, the state dir, the unit files, env files, signer or Claim. Any mismatch stops it; it never repairs, copies or uploads anything.
# Step 0 (root, once, by hand): install -d -o <operator account> -g <service group> -m 2750 <release base>/<REV>   (stop if the directory already exists and is not empty; the names come from the site file)
set -euo pipefail
umask 0027
HERE=$(cd "$(dirname "$0")" && pwd); . "$HERE/common.env.sh"
site_verify
d=$REL_NEW
test "$(id -un)" = "$OPERATOR_USER" && test "$(id -u)" -ne 0
test -d "$d" && test -z "$(ls -A "$d")"
test -d "$REL_OLD/dist"
test "$(/usr/bin/node --version)" = v22.22.1 && test "$(/usr/bin/npm --version)" = 9.2.0
svc_group=$(getent group "$SVC_GID" | cut -d: -f1); test -n "$svc_group"
cache=$(mktemp -d /var/tmp/lab-0160a085-cache.XXXXXXXX)
test "$(df -Pk /var/tmp | awk 'NR==2 {print $4}')" -ge 2097152
test "$(df -Pk "$REL_BASE" | awk 'NR==2 {print $4}')" -ge 4194304
git -C "$d" init -q; git -C "$d" remote add origin "$REPO"
GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= timeout 180s git -C "$d" fetch --depth 1 origin "$REV"
git -C "$d" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
test "$(git -C "$d" rev-parse HEAD)" = "$REV"
test "$(git -C "$d" rev-parse 'HEAD^{tree}')" = "$TREE"
test -z "$(git -C "$d" status --porcelain)"
cd "$d"
printf '%s  %s\n' "$LOCK" package-lock.json | sha256sum -c -
timeout 600s /usr/bin/npm ci --no-audit --no-fund --cache "$cache" >"$d/npm-ci.log" 2>&1
timeout 600s /usr/bin/npm run build >"$d/build.log" 2>&1
# the 216-file comparison, file by file (path + content sha256 only)
(cd dist && find . -type f | LC_ALL=C sort | xargs sha256sum) >"$d/dist.sha256"
test "$(wc -l <"$d/dist.sha256" | tr -d ' ')" -eq "$DIST_FILES"
test "$(sha256sum "$d/dist.sha256" | cut -d' ' -f1)" = "$DIST_SHA"
diff "$d/dist.sha256" "$HERE/dist-0160a085.expected.sha256"          # no output = every one of the 216 files equals the reviewer's build
test "$(sha256sum dist/endpoint/labMiningPoolClPayoutDaemon.js | cut -d' ' -f1)" = "$ENTRY_SHA"
test "$(sha256sum dist/endpoint/validatorLabMiningPoolClPayoutReporter.js | cut -d' ' -f1)" = "$REPORTER_SHA"
# against the RUNNING df78e6b dist: exactly the expected set of added / changed / (no) removed files
(cd "$REL_OLD/dist" && find . -type f | LC_ALL=C sort | xargs sha256sum) >"$d/dist-old-running.sha256"
diff <(sed 's/  / /' "$d/dist-old-running.sha256" | sort -k2) <(sed 's/  / /' "$d/dist.sha256" | sort -k2) | awk '/^[<>]/ {print $1, $3}' | sort -k2 >"$d/dist-change-list.txt" || true
diff "$d/dist-change-list.txt" "$HERE/dist-change-list.expected.txt"  # no output = the same 9 files left/changed and 36 appeared as in the review
# ownership and permissions: the service user reads, never writes
chgrp -R "$svc_group" "$d" 2>/dev/null || sudo -n chgrp -R "$svc_group" "$d"
test -z "$(find "$d" ! -group "$svc_group" -print -quit)"
test -z "$(find "$d" -perm /022 ! -type l -print -quit)"
entry=$d/dist/endpoint/labMiningPoolClPayoutDaemon.js
sudo -n -u "#$SVC_UID" test -r "$entry"
if sudo -n -u "#$SVC_UID" test -w "$entry"; then echo "service user can write the entry; refuse" >&2; exit 1; fi
node --check "$entry"
rm -rf -- "$cache"
printf 'G2_BUILD_OK rev %s tree %s files %s manifest %s\n' "$REV" "$TREE" "$DIST_FILES" "$DIST_SHA"
